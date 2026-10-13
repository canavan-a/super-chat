package api

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"main/proto"
)

const (
	maxSkew     = 60 * time.Second
	nonceWindow = 5 * time.Minute
	// Bodies of signed requests are read in full to hash them; blobs have
	// their own, larger limit.
	maxJSONBody = 1 << 20
)

// nonces remembers recently used request nonces so a captured request
// can't be replayed inside the clock-skew window.
type nonces struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

func newNonces() *nonces { return &nonces{seen: map[string]time.Time{}} }

// use records nonce and reports whether it was fresh.
func (n *nonces) use(nonce string, now time.Time) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	if len(n.seen) > 4096 {
		for k, t := range n.seen {
			if now.Sub(t) > nonceWindow {
				delete(n.seen, k)
			}
		}
	}
	if _, ok := n.seen[nonce]; ok {
		return false
	}
	n.seen[nonce] = now
	return true
}

// requireSignature authenticates a request by its X-SC-* headers (see
// docs/protocol.md). There are no accounts: the signer is a room-scoped
// member key (or a vault key), and handlers check that it's allowed to touch
// the room in the URL. Nothing is looked up or recorded about who it is. The
// body is read here to hash it and put back for the handler.
func (a *API) requireSignature(maxBody int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		member := c.GetHeader("X-SC-Member")
		ts := c.GetHeader("X-SC-Ts")
		nonce := c.GetHeader("X-SC-Nonce")
		sig, err := proto.B64.DecodeString(c.GetHeader("X-SC-Sig"))
		if member == "" || ts == "" || nonce == "" || err != nil {
			abort(c, http.StatusUnauthorized, "unsigned request")
			return
		}
		tsMs, err := strconv.ParseInt(ts, 10, 64)
		now := a.now()
		if err != nil || absDur(now.Sub(time.UnixMilli(tsMs))) > maxSkew {
			abort(c, http.StatusUnauthorized, "request timestamp out of range; check the device clock")
			return
		}
		if len(nonce) > 64 {
			abort(c, http.StatusUnauthorized, "bad nonce")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, maxBody))
		if err != nil {
			abort(c, http.StatusRequestEntityTooLarge, "body too large")
			return
		}
		c.Request.Body = io.NopCloser(bytes.NewReader(body))
		msg := proto.RequestSigningString(c.Request.Method, c.Request.URL.RequestURI(), ts, nonce, body)
		if !proto.Verify(member, "", msg, sig) {
			abort(c, http.StatusUnauthorized, "bad signature")
			return
		}
		if !a.nonces.use(member+nonce, now) {
			abort(c, http.StatusUnauthorized, "replayed request")
			return
		}
		c.Set("member", member)
		c.Set("body", body)
		c.Next()
	}
}

func absDur(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

func abort(c *gin.Context, status int, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"error": msg})
}

func caller(c *gin.Context) string { return c.GetString("member") }

// limiter is a fixed-window rate limiter keyed by anything.
type limiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string]*window
}

type window struct {
	start time.Time
	n     int
}

func newLimiter(limit int, per time.Duration) *limiter {
	return &limiter{limit: limit, window: per, hits: map[string]*window{}}
}

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.hits) > 10000 {
		for k, w := range l.hits {
			if now.Sub(w.start) > l.window {
				delete(l.hits, k)
			}
		}
	}
	w, ok := l.hits[key]
	if !ok || now.Sub(w.start) > l.window {
		l.hits[key] = &window{start: now, n: 1}
		return true
	}
	w.n++
	return w.n <= l.limit
}

// clientIP is the rate-limit key for a request. It's never logged or stored.
//
// Behind Pangolin (newt) or cloudflared, every request reaches the server
// from the local tunnel end, so the real client is in X-Forwarded-For. Only
// the rightmost entry can be trusted: it's the one the proxy appended, and
// anything a client sends in that header itself ends up to its left. The
// header is only believed on loopback connections (the tunnel); a direct
// connection is keyed by its own address. CF-Connecting-IP and gin's
// ClientIP are deliberately not used, since a client can set those freely.
func (a *API) clientIP(c *gin.Context) string {
	remote := c.RemoteIP()
	if a.cfg.TrustProxy && isLoopback(remote) {
		if ip := lastForwardedFor(c.Request.Header.Values("X-Forwarded-For")); ip != "" {
			return ip
		}
	}
	return remote
}

func isLoopback(ip string) bool {
	p := net.ParseIP(ip)
	return p != nil && p.IsLoopback()
}

// lastForwardedFor returns the rightmost address across every
// X-Forwarded-For header, or "" if it isn't an IP.
func lastForwardedFor(values []string) string {
	all := strings.Split(strings.Join(values, ","), ",")
	for i := len(all) - 1; i >= 0; i-- {
		if s := strings.TrimSpace(all[i]); s != "" {
			if p := net.ParseIP(s); p != nil {
				return p.String()
			}
			return ""
		}
	}
	return ""
}

// rateLimit rejects a request once key(c) has gone over the limiter.
func (a *API) rateLimit(l *limiter, key func(c *gin.Context) string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !l.allow(key(c), a.now()) {
			abort(c, http.StatusTooManyRequests, "slow down")
			return
		}
		c.Next()
	}
}
