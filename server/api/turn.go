package api

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"main/proto"
)

// turnCreds hands a room member the ICE servers this server offers for
// voice. With a coturn shared secret configured (use-auth-secret), it also
// mints credentials that coturn accepts until they expire:
//
//	username   = "<unix expiry>:<random label>"
//	credential = base64(HMAC-SHA1(secret, username))
//
// The label is random rather than the member ID, since coturn logs usernames.
func (a *API) turnCreds(c *gin.Context) {
	if _, _, ok := a.member(c); !ok {
		return
	}
	urls := a.cfg.TURNURLs
	if urls == nil {
		urls = []string{}
	}
	if len(a.cfg.TURNSecret) == 0 {
		c.JSON(http.StatusOK, gin.H{"urls": urls})
		return
	}
	label := make([]byte, 8)
	_, _ = rand.Read(label)
	user := strconv.FormatInt(a.now().Add(a.cfg.TURNTTL).Unix(), 10) + ":" + proto.B64.EncodeToString(label)
	mac := hmac.New(sha1.New, a.cfg.TURNSecret)
	mac.Write([]byte(user))
	c.JSON(http.StatusOK, gin.H{
		"urls":       urls,
		"username":   user,
		"credential": base64.StdEncoding.EncodeToString(mac.Sum(nil)),
		"ttl":        int(a.cfg.TURNTTL.Seconds()),
	})
}
