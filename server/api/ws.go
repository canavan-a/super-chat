package api

import (
	"crypto/rand"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"main/proto"
)

type wsMsg map[string]any

// Hub tracks which sockets are subscribed to which rooms, and as which
// member. There are no accounts: a socket proves membership room by room
// with that room's member key, and nothing about subscriptions is stored.
type Hub struct {
	mu    sync.Mutex
	rooms map[string]map[*wsConn]string // room → socket → member
}

type wsConn struct {
	send chan []byte
	subs map[string]string // room → member
}

func NewHub() *Hub { return &Hub{rooms: map[string]map[*wsConn]string{}} }

func (h *Hub) subscribe(c *wsConn, room, member string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.rooms[room]
	if !ok {
		set = map[*wsConn]string{}
		h.rooms[room] = set
	}
	set[c] = member
	c.subs[room] = member
}

func (h *Hub) unsubscribeLocked(c *wsConn, room string) {
	if set, ok := h.rooms[room]; ok {
		delete(set, c)
		if len(set) == 0 {
			delete(h.rooms, room)
		}
	}
	delete(c.subs, room)
}

func (h *Hub) remove(c *wsConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for room := range c.subs {
		h.unsubscribeLocked(c, room)
	}
}

func deliver(c *wsConn, raw []byte) {
	select {
	case c.send <- raw:
	default:
		// Buffer full: skip; the client resyncs over REST on reconnect.
	}
}

// SendRoom delivers m to every socket subscribed to room, except those
// subscribed as `except`.
func (h *Hub) SendRoom(room string, m wsMsg, except string) {
	raw, err := json.Marshal(m)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c, member := range h.rooms[room] {
		if member != except {
			deliver(c, raw)
		}
	}
}

// Removed tells a member's sockets they're out of the room and stops
// sending them its events.
func (h *Hub) Removed(room, member string) {
	raw, _ := json.Marshal(wsMsg{"type": "removed", "room": room})
	h.mu.Lock()
	defer h.mu.Unlock()
	for c, m := range h.rooms[room] {
		if m == member {
			deliver(c, raw)
			h.unsubscribeLocked(c, room)
		}
	}
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// Auth is by signature, not cookies, so a cross-origin page gains
	// nothing by opening a socket.
	CheckOrigin: func(r *http.Request) bool { return true },
}

const (
	wsPing      = 30 * time.Second
	wsReadLimit = 256 << 10
	wsMaxSubs   = 1000
)

type wsSub struct {
	Room   string `json:"room"`
	Member string `json:"member"`
	Sig    string `json:"sig"`
}

// ws sends a challenge, then accepts any number of room subscriptions, each
// signed by that room's member key over the challenge. Afterwards the only
// other thing a client sends is typing.
func (a *API) ws(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(wsReadLimit)

	nonceBytes := make([]byte, 24)
	_, _ = rand.Read(nonceBytes)
	nonce := proto.B64.EncodeToString(nonceBytes)
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := conn.WriteJSON(wsMsg{"type": "challenge", "nonce": nonce}); err != nil {
		return
	}

	wc := &wsConn{send: make(chan []byte, 128), subs: map[string]string{}}
	defer a.hub.remove(wc)

	done := make(chan struct{})
	go func() {
		defer close(done)
		typing := newLimiter(30, time.Minute)
		for {
			_ = conn.SetReadDeadline(time.Now().Add(2 * wsPing))
			var in struct {
				Type string  `json:"type"`
				Room string  `json:"room"`
				Subs []wsSub `json:"subs"`
			}
			if err := conn.ReadJSON(&in); err != nil {
				return
			}
			switch in.Type {
			case "sub":
				var ok, rejected []string
				for _, s := range in.Subs {
					if a.checkSub(nonce, s) && len(wc.subs) < wsMaxSubs {
						a.hub.subscribe(wc, s.Room, s.Member)
						ok = append(ok, s.Room)
					} else {
						rejected = append(rejected, s.Room)
					}
				}
				raw, _ := json.Marshal(wsMsg{"type": "subscribed", "rooms": ok, "rejected": rejected})
				deliver(wc, raw)
			case "typing":
				a.hub.mu.Lock()
				member, subscribed := wc.subs[in.Room]
				a.hub.mu.Unlock()
				if subscribed && typing.allow(in.Room, time.Now()) {
					a.hub.SendRoom(in.Room, wsMsg{"type": "typing", "room": in.Room, "member": member}, member)
				}
			}
		}
	}()
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(2 * wsPing))
	})

	ping := time.NewTicker(wsPing)
	defer ping.Stop()
	for {
		select {
		case <-done:
			return
		case raw := <-wc.send:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.TextMessage, raw); err != nil {
				return
			}
		case <-ping.C:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// checkSub verifies one subscription: a signature by the member key over
// the challenge and room, from a current member of that room.
func (a *API) checkSub(nonce string, s wsSub) bool {
	sig, err := proto.B64.DecodeString(s.Sig)
	if err != nil || !proto.Verify(s.Member, "SC1-WS\n", []byte(nonce+"\n"+s.Room), sig) {
		return false
	}
	st, err := a.rooms.State(s.Room)
	return err == nil && st != nil && st.IsMember(s.Member)
}
