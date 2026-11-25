package crypto

import (
	"net/http"
	"strconv"

	"github.com/canavan-a/super-chat/shared/proto"
)

// SignRequest sets the X-SC-* headers that authenticate a request: there are
// no logins, so each request is signed by the member key for the room it's
// about (or the vault key). pathQuery is the path with its query string, as
// the server sees it (URL.RequestURI()).
func SignRequest(h http.Header, s Signer, method, pathQuery string, body []byte, now int64) {
	ts := strconv.FormatInt(now, 10)
	nonce := B64.EncodeToString(RandomBytes(16))
	msg := proto.RequestSigningString(method, pathQuery, ts, nonce, body)
	h.Set("X-SC-Member", s.MemberID())
	h.Set("X-SC-Ts", ts)
	h.Set("X-SC-Nonce", nonce)
	h.Set("X-SC-Sig", B64.EncodeToString(Sign(s.PrivateKey(), "", msg)))
}

// SubscribeSig is a WebSocket subscription's sig: the member key's signature
// over the server's challenge nonce and the room.
func SubscribeSig(s Signer, nonce, room string) string {
	return B64.EncodeToString(Sign(s.PrivateKey(), "SC1-WS\n", []byte(nonce+"\n"+room)))
}
