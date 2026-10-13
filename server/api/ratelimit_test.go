package api

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/gin-gonic/gin"

	"main/config"
	"main/proto"
	"main/rooms"
)

func TestClientIP(t *testing.T) {
	cases := []struct {
		name   string
		trust  bool
		remote string
		xff    []string
		want   string
	}{
		{"direct, no proxy", false, "203.0.113.7:5000", []string{"1.2.3.4"}, "203.0.113.7"},
		{"tunnel: rightmost entry is the proxy's", true, "127.0.0.1:5000", []string{"6.6.6.6, 198.51.100.9"}, "198.51.100.9"},
		{"tunnel: across several headers", true, "127.0.0.1:5000", []string{"6.6.6.6", "198.51.100.9"}, "198.51.100.9"},
		{"tunnel: garbage is not trusted", true, "127.0.0.1:5000", []string{"1.1.1.1, not-an-ip"}, "127.0.0.1"},
		{"trusted, but not from the tunnel", true, "203.0.113.7:5000", []string{"1.2.3.4"}, "203.0.113.7"},
		{"tunnel, no header", true, "[::1]:5000", nil, "::1"},
	}
	for _, tc := range cases {
		a := &API{cfg: config.Config{TrustProxy: tc.trust}}
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("GET", "/", nil)
		c.Request.RemoteAddr = tc.remote
		for _, v := range tc.xff {
			c.Request.Header.Add("X-Forwarded-For", v)
		}
		c.Request.Header.Set("CF-Connecting-IP", "9.9.9.9") // never believed
		if got := a.clientIP(c); got != tc.want {
			t.Errorf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
}

// Behind the tunnel, a client that makes up a new X-Forwarded-For on every
// request still lands in one bucket: the proxy's own entry is what counts.
func TestSpoofedForwardedForDoesNotResetLimits(t *testing.T) {
	e := newEnv(t)
	e.api.cfg.TrustProxy = true
	created := 0
	for i := 0; i < 25; i++ {
		pub, priv, _ := ed25519.GenerateKey(rand.Reader)
		u := &user{id: proto.MemberID(pub), priv: priv, e: e}
		r := &room{id: proto.NewID(), e: e}
		create := r.ev(u, "create", proto.CreatePub{RetentionDays: 1, X25519: xKey()})
		ep, env := r.epoch(u, []string{u.id})
		body, _ := json.Marshal(rooms.Batch{Events: []proto.SignedEvent{create, ep}, Envelopes: env})

		ts := strconv.FormatInt(e.now.UnixMilli(), 10)
		nonce := proto.NewID()
		sig := ed25519.Sign(priv, proto.RequestSigningString("POST", "/v1/rooms", ts, nonce, body))
		req, _ := http.NewRequest("POST", e.srv.URL+"/v1/rooms", bytesReader(body))
		req.Header.Set("X-SC-Member", u.id)
		req.Header.Set("X-SC-Ts", ts)
		req.Header.Set("X-SC-Nonce", nonce)
		req.Header.Set("X-SC-Sig", proto.B64.EncodeToString(sig))
		// What a client forges, then what the proxy appends.
		req.Header.Set("X-Forwarded-For", "10.0.0."+strconv.Itoa(i)+", 198.51.100.9")
		req.Header.Set("CF-Connecting-IP", "10.1.0."+strconv.Itoa(i))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusCreated {
			created++
		} else if resp.StatusCode != http.StatusTooManyRequests {
			t.Fatalf("unexpected %d", resp.StatusCode)
		}
	}
	if created != 20 {
		t.Fatalf("spoofed headers let %d rooms through, want the limit of 20", created)
	}
}

func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }
