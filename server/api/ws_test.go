package api

import (
	"crypto/ed25519"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"main/proto"
)

type wsClient struct {
	t    *testing.T
	conn *websocket.Conn
	// A read that times out breaks a gorilla conn, so one goroutine reads
	// and tests wait on this channel.
	in chan map[string]any
}

// dial opens /v1/ws and subscribes u to the given rooms.
func (e *env) dial(u *user, rooms ...string) *wsClient {
	e.t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(e.srv.URL, "http")+"/v1/ws", nil)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { conn.Close() })
	c := &wsClient{t: e.t, conn: conn, in: make(chan map[string]any, 1024)}
	go func() {
		defer close(c.in)
		for {
			var m map[string]any
			if err := conn.ReadJSON(&m); err != nil {
				return
			}
			c.in <- m
		}
	}()
	ch := c.read()
	nonce, _ := ch["nonce"].(string)
	var subs []wsSub
	for _, r := range rooms {
		sig := ed25519.Sign(u.priv, append([]byte("SC1-WS\n"), nonce+"\n"+r...))
		subs = append(subs, wsSub{Room: r, Member: u.id, Sig: proto.B64.EncodeToString(sig)})
	}
	c.send(map[string]any{"type": "sub", "subs": subs})
	if got := c.read(); got["type"] != "subscribed" {
		e.t.Fatalf("want subscribed, got %v", got)
	}
	return c
}

func (c *wsClient) send(m map[string]any) {
	c.t.Helper()
	if err := c.conn.WriteJSON(m); err != nil {
		c.t.Fatal(err)
	}
}

func (c *wsClient) read() map[string]any {
	c.t.Helper()
	m, ok := c.tryRead(2 * time.Second)
	if !ok {
		c.t.Fatal("timed out waiting for a message")
	}
	return m
}

// tryRead returns the next message, or false after d.
func (c *wsClient) tryRead(d time.Duration) (map[string]any, bool) {
	select {
	case m, ok := <-c.in:
		return m, ok
	case <-time.After(d):
		return nil, false
	}
}

func (c *wsClient) none() {
	c.t.Helper()
	if m, ok := c.tryRead(200 * time.Millisecond); ok {
		c.t.Fatalf("want nothing, got %v", m)
	}
}

func threeMembers(t *testing.T) (*env, *room, *user, *user, *user) {
	e := newEnv(t)
	a, b, c := e.user(), e.user(), e.user()
	r := e.createRoom(a)
	iv, code, body := r.invite(a, 5, 0)
	want(t, "invite", code, 200, body)
	code, body = r.join(b, iv, []string{a.id})
	want(t, "join b", code, 200, body)
	code, body = r.join(c, iv, []string{a.id, b.id})
	want(t, "join c", code, 200, body)
	return e, r, a, b, c
}

func TestRTCRelay(t *testing.T) {
	e, r, a, b, c := threeMembers(t)
	wa, wb, wc := e.dial(a, r.id), e.dial(b, r.id), e.dial(c, r.id)
	wb2 := e.dial(b, r.id) // b's second device

	// Directed: only b's sockets, with from stamped by the server.
	wa.send(map[string]any{"type": "rtc", "room": r.id, "to": b.id, "box": "sealed", "from": c.id})
	for _, w := range []*wsClient{wb, wb2} {
		got := w.read()
		if got["type"] != "rtc" || got["from"] != a.id || got["box"] != "sealed" || got["room"] != r.id || got["to"] != b.id {
			t.Fatalf("directed: got %v", got)
		}
	}
	wc.none()
	wa.none()

	// Broadcast: everyone but the sender.
	wa.send(map[string]any{"type": "rtc", "room": r.id, "box": "hello"})
	for _, w := range []*wsClient{wb, wb2, wc} {
		if got := w.read(); got["from"] != a.id || got["box"] != "hello" {
			t.Fatalf("broadcast: got %v", got)
		}
	}
	wa.none()

	// Oversized and empty boxes are dropped.
	wa.send(map[string]any{"type": "rtc", "room": r.id, "box": strings.Repeat("x", wsMaxRTCBox+1)})
	wa.send(map[string]any{"type": "rtc", "room": r.id, "box": ""})
	wb.none()
}

func TestRTCRequiresSubscription(t *testing.T) {
	e, r, a, b, _ := threeMembers(t)
	other := e.createRoom(a)
	wa := e.dial(a, other.id) // a is subscribed, but not to r
	wb := e.dial(b, r.id)
	wa.send(map[string]any{"type": "rtc", "room": r.id, "box": "x"})
	wa.send(map[string]any{"type": "rtc", "room": r.id, "to": b.id, "box": "x"})
	wb.none()
}

func TestRTCRateLimit(t *testing.T) {
	e, r, a, b, _ := threeMembers(t)
	wa, wb := e.dial(a, r.id), e.dial(b, r.id)
	for i := 0; i < 610; i++ {
		wa.send(map[string]any{"type": "rtc", "room": r.id, "to": b.id, "box": strconv.Itoa(i)})
	}
	n := 0
	for {
		if _, ok := wb.tryRead(300 * time.Millisecond); !ok {
			break
		}
		n++
	}
	// The socket's send buffer (128) may also drop some; the point is the
	// limiter caps a burst at 600.
	if n == 0 || n > 600 {
		t.Fatalf("delivered %d", n)
	}
}
