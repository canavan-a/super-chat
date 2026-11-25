// Package api talks to one Super Chat server: signed HTTP requests (there are
// no logins; each request is signed by the member key for its room) and the
// WebSocket that pushes events, messages and voice signaling.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/canavan-a/super-chat/shared/crypto"
	"github.com/canavan-a/super-chat/shared/proto"
	"github.com/canavan-a/super-chat/shared/wire"
)

// Client is one server.
type Client struct {
	Server string // origin, e.g. https://chat.superbadger.io
	HTTP   *http.Client
	Now    func() time.Time
}

func New(server string) *Client {
	return &Client{
		Server: strings.TrimRight(server, "/"),
		HTTP:   &http.Client{Timeout: 60 * time.Second},
		Now:    time.Now,
	}
}

// Error is a non-2xx answer.
type Error struct {
	Status int
	Msg    string
	Head   *wire.Head
}

func (e *Error) Error() string { return fmt.Sprintf("%d %s", e.Status, e.Msg) }

// IsStatus reports whether err is an API error with that status.
func IsStatus(err error, status int) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == status
}

// do sends a request, signed by s unless s is nil. body is JSON-encoded,
// or sent as is when it's []byte. out, if not nil, receives the JSON answer.
func (c *Client) do(ctx context.Context, method, pathQuery string, s crypto.Signer, body, out any) error {
	var raw []byte
	contentType := "application/json"
	switch b := body.(type) {
	case nil:
	case []byte:
		raw, contentType = b, "application/octet-stream"
	default:
		var err error
		if raw, err = json.Marshal(b); err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Server+pathQuery, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	if s != nil {
		crypto.SignRequest(req.Header, s, method, pathQuery, raw, c.Now().UnixMilli())
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		var we wire.Error
		_ = json.Unmarshal(data, &we)
		if we.Error == "" {
			we.Error = http.StatusText(resp.StatusCode)
		}
		return &Error{Status: resp.StatusCode, Msg: we.Error, Head: we.Head}
	}
	if out == nil {
		return nil
	}
	if b, ok := out.(*[]byte); ok {
		*b = data
		return nil
	}
	return json.Unmarshal(data, out)
}

func room(id string) string { return "/v1/rooms/" + url.PathEscape(id) }

// ---- invites ----

// Invite is GET /v1/invites/:id (unsigned).
func (c *Client) Invite(ctx context.Context, id string) (*wire.Invite, error) {
	var out wire.Invite
	return &out, c.do(ctx, "GET", "/v1/invites/"+url.PathEscape(id), nil, nil, &out)
}

// Join is POST /v1/invites/:id/join.
func (c *Client) Join(ctx context.Context, id string, s crypto.Signer, b *wire.Batch) (*wire.JoinResponse, error) {
	var out wire.JoinResponse
	return &out, c.do(ctx, "POST", "/v1/invites/"+url.PathEscape(id)+"/join", s, b, &out)
}

// ---- rooms ----

// State is the room's log from seq on.
func (c *Client) State(ctx context.Context, roomID string, s crypto.Signer, since int64) (*wire.RoomState, error) {
	var out wire.RoomState
	return &out, c.do(ctx, "GET", room(roomID)+"/state?since="+strconv.FormatInt(since, 10), s, nil, &out)
}

// Append adds events (and an epoch's envelopes) to the log.
func (c *Client) Append(ctx context.Context, roomID string, s crypto.Signer, b *wire.Batch) (*wire.HeadResponse, error) {
	var out wire.HeadResponse
	return &out, c.do(ctx, "POST", room(roomID)+"/events", s, b, &out)
}

// Keys is every epoch key sealed to the caller.
func (c *Client) Keys(ctx context.Context, roomID string, s crypto.Signer) (*wire.Keys, error) {
	var out wire.Keys
	return &out, c.do(ctx, "GET", room(roomID)+"/keys", s, nil, &out)
}

// MaxPage is the most messages one Messages call returns.
const MaxPage = 200

// Messages is up to limit messages after pos, oldest first.
func (c *Client) Messages(ctx context.Context, roomID string, s crypto.Signer, after int64, limit int) ([]wire.Message, error) {
	var out wire.Messages
	q := "?after=" + strconv.FormatInt(after, 10) + "&limit=" + strconv.Itoa(limit)
	return out.Messages, c.do(ctx, "GET", room(roomID)+"/messages"+q, s, nil, &out)
}

// PostMessage sends a message.
func (c *Client) PostMessage(ctx context.Context, roomID string, s crypto.Signer, m *wire.PostMessage) (*wire.PostMessageResponse, error) {
	if m.Blobs == nil {
		m.Blobs = []string{}
	}
	var out wire.PostMessageResponse
	return &out, c.do(ctx, "POST", room(roomID)+"/messages", s, m, &out)
}

// PutBlob uploads a sealed blob and returns its id.
func (c *Client) PutBlob(ctx context.Context, roomID string, s crypto.Signer, sealed []byte) (string, error) {
	var out wire.BlobID
	return out.ID, c.do(ctx, "PUT", room(roomID)+"/blobs", s, sealed, &out)
}

// GetBlob downloads a sealed blob.
func (c *Client) GetBlob(ctx context.Context, roomID string, s crypto.Signer, blob string) ([]byte, error) {
	var out []byte
	return out, c.do(ctx, "GET", room(roomID)+"/blobs/"+url.PathEscape(blob), s, nil, &out)
}

// PutAvatar marks one of the caller's blobs as their profile picture.
func (c *Client) PutAvatar(ctx context.Context, roomID string, s crypto.Signer, blob string) error {
	return c.do(ctx, "PUT", room(roomID)+"/avatar", s, wire.BlobRef{Blob: blob}, nil)
}

// ---- WebSocket ----

// Conn is an open WebSocket, past the challenge.
type Conn struct {
	ws    *websocket.Conn
	Nonce string
	mu    sync.Mutex // one writer at a time (gorilla/websocket allows no more)
}

// Dial opens the WebSocket and reads the server's challenge.
func (c *Client) Dial(ctx context.Context) (*Conn, error) {
	u := "ws" + strings.TrimPrefix(c.Server, "http") + "/v1/ws"
	ws, _, err := websocket.DefaultDialer.DialContext(ctx, u, nil)
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(1 << 20)
	_ = ws.SetReadDeadline(time.Now().Add(30 * time.Second))
	var first wire.ServerWS
	if err := ws.ReadJSON(&first); err != nil || first.Type != wire.WSChallenge || first.Nonce == "" {
		ws.Close()
		if err == nil {
			err = errors.New("no challenge from the server")
		}
		return nil, err
	}
	// The server pings every 30 s; each ping (or anything else) pushes the
	// deadline on, so a dead connection is noticed within a minute or so.
	ws.SetPingHandler(func(data string) error {
		_ = ws.SetReadDeadline(time.Now().Add(75 * time.Second))
		return ws.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(10*time.Second))
	})
	return &Conn{ws: ws, Nonce: first.Nonce}, nil
}

// Subscription is one room to subscribe to, as the member who's in it.
type Subscription struct {
	Room   string
	Signer crypto.Signer
}

// Subscribe asks for rooms' pushes; the answer comes as a "subscribed" message.
func (c *Conn) Subscribe(subs []Subscription) error {
	if len(subs) == 0 {
		return nil
	}
	msg := wire.ClientWS{Type: wire.WSSub}
	for _, s := range subs {
		msg.Subs = append(msg.Subs, wire.Sub{Room: s.Room, Member: s.Signer.MemberID(), Sig: crypto.SubscribeSig(s.Signer, c.Nonce, s.Room)})
	}
	return c.write(msg)
}

// SendRTC relays a sealed voice signaling box (to "" broadcasts).
func (c *Conn) SendRTC(roomID, to, box string) error {
	return c.write(wire.ClientWS{Type: wire.WSRTC, Room: roomID, To: to, Box: box})
}

func (c *Conn) write(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.ws.WriteJSON(v)
}

// Read waits for the next server message.
func (c *Conn) Read() (*wire.ServerWS, error) {
	_ = c.ws.SetReadDeadline(time.Now().Add(75 * time.Second))
	var m wire.ServerWS
	if err := c.ws.ReadJSON(&m); err != nil {
		return nil, err
	}
	return &m, nil
}

func (c *Conn) Close() error { return c.ws.Close() }

// Signed turns the server's events into what proto.ParseEvent takes.
func Signed(evs []wire.StoredEvent) []proto.SignedEvent {
	out := make([]proto.SignedEvent, len(evs))
	for i, e := range evs {
		out[i] = e.Signed()
	}
	return out
}

// CreateRoom is POST /v1/rooms.
func (c *Client) CreateRoom(ctx context.Context, s crypto.Signer, b *wire.Batch) (*wire.CreateRoomResponse, error) {
	var out wire.CreateRoomResponse
	return &out, c.do(ctx, "POST", "/v1/rooms", s, b, &out)
}
