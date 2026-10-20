// Package api is superchat's HTTP + WebSocket surface (see
// docs/protocol.md). The server only ever sees ciphertext and room-scoped
// pseudonyms; what it enforces is which member keys may append to a room's
// log, read its messages, and fetch its keys.
package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"main/config"
	"main/database"
	"main/proto"
	"main/push"
	"main/rooms"
)

type API struct {
	db    *gorm.DB
	cfg   config.Config
	rooms *rooms.Service
	hub   *Hub
	// push wakes Play-build devices on new messages; nil sends nothing.
	push   *push.FCM
	nonces *nonces
	now    func() time.Time

	roomsPerIP   *limiter
	vaultsPerIP  *limiter
	joinsPerIP   *limiter
	msgsPerAcct  *limiter
	msgsPerIP    *limiter
	blobsPerAcct *limiter
	blobsPerIP   *limiter
	readsPerAcct *limiter
}

func New(db *gorm.DB, cfg config.Config, svc *rooms.Service) *API {
	a := &API{
		db: db, cfg: cfg, rooms: svc, hub: NewHub(), nonces: newNonces(), now: time.Now,
		roomsPerIP:   newLimiter(20, time.Hour),
		vaultsPerIP:  newLimiter(120, time.Hour),
		joinsPerIP:   newLimiter(30, time.Hour),
		msgsPerAcct:  newLimiter(240, time.Minute),
		msgsPerIP:    newLimiter(600, time.Minute),
		blobsPerAcct: newLimiter(60, time.Hour),
		// Member keys are free (make a room, get a key), so per-member limits
		// alone don't cap one client; these per-IP ones do.
		blobsPerIP:   newLimiter(40, time.Hour),
		readsPerAcct: newLimiter(1200, time.Minute),
	}
	svc.OnEvent = a.onEvent
	svc.OnRemoved = a.onRemoved
	svc.OnDeleted = a.onDeleted
	return a
}

// SetPush turns on FCM wake-ups for new messages.
func (a *API) SetPush(f *push.FCM) { a.push = f }

// SetClock replaces the API's clock (tests).
func (a *API) SetClock(now func() time.Time) { a.now = now; a.rooms.Now = now }

func (a *API) Router() *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	// clientIP reads forwarding headers itself, only from the local tunnel.
	_ = r.SetTrustedProxies(nil)
	// gin.Logger is left out on purpose: request lines would record who
	// talked to which room and when.
	r.Use(gin.Recovery())

	// Any origin: the web client is served from another port/origin, and
	// every request is authenticated by signature, not cookies.
	corsConfig := cors.DefaultConfig()
	corsConfig.AllowAllOrigins = true
	corsConfig.AllowHeaders = []string{"Content-Type", "X-SC-Member", "X-SC-Ts", "X-SC-Nonce", "X-SC-Sig"}
	corsConfig.AllowMethods = []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"}
	r.Use(cors.New(corsConfig))

	r.GET("/health", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true, "app": "superchat"}) })
	r.GET("/i/:id", a.landing)
	r.GET("/.well-known/assetlinks.json", a.assetLinks)
	r.GET("/v1/ws", a.ws)

	byAcct := func(c *gin.Context) string { return caller(c) }
	byIP := func(c *gin.Context) string { return a.clientIP(c) }

	v1 := r.Group("/v1")
	// Unsigned: the invite ID (128 random bits) is the capability, and the
	// vault ID is derived from its owner's recovery phrase.
	v1.GET("/invites/:id", a.rateLimit(a.joinsPerIP, byIP), a.getInvite)
	v1.GET("/vault/:id", a.rateLimit(a.vaultsPerIP, byIP), a.getVault)

	signed := v1.Group("", a.requireSignature(maxJSONBody))
	signed.PUT("/vault/:id", a.rateLimit(a.vaultsPerIP, byIP), a.putVault)
	signed.POST("/rooms", a.rateLimit(a.roomsPerIP, byIP), a.createRoom)
	signed.GET("/rooms/:id/state", a.rateLimit(a.readsPerAcct, byAcct), a.roomState)
	signed.POST("/rooms/:id/events", a.rateLimit(a.msgsPerIP, byIP), a.rateLimit(a.msgsPerAcct, byAcct), a.appendEvents)
	signed.GET("/rooms/:id/keys", a.rateLimit(a.readsPerAcct, byAcct), a.roomKeys)
	signed.GET("/rooms/:id/messages", a.rateLimit(a.readsPerAcct, byAcct), a.listMessages)
	signed.POST("/rooms/:id/messages", a.rateLimit(a.msgsPerIP, byIP), a.rateLimit(a.msgsPerAcct, byAcct), a.postMessage)
	signed.GET("/rooms/:id/unread", a.rateLimit(a.readsPerAcct, byAcct), a.unread)
	signed.GET("/rooms/:id/invites/uses", a.rateLimit(a.readsPerAcct, byAcct), a.inviteUses)
	signed.GET("/rooms/:id/blobs/:blob", a.rateLimit(a.readsPerAcct, byAcct), a.getBlob)
	signed.PUT("/rooms/:id/avatar", a.rateLimit(a.blobsPerAcct, byAcct), a.putAvatar)
	signed.PUT("/rooms/:id/picture", a.rateLimit(a.blobsPerAcct, byAcct), a.putPicture)
	signed.POST("/invites/:id/join", a.rateLimit(a.joinsPerIP, byIP), a.joinInvite)

	blobs := v1.Group("", a.requireSignature(a.cfg.MaxBlobBytes))
	blobs.PUT("/rooms/:id/blobs", a.rateLimit(a.blobsPerIP, byIP), a.rateLimit(a.blobsPerAcct, byAcct), a.putBlob)

	return r
}

func (a *API) fail(c *gin.Context, err error) {
	var re *rooms.Error
	if errors.As(err, &re) {
		body := gin.H{"error": re.Msg}
		if re.Head != nil {
			body["head"] = re.Head
		}
		c.AbortWithStatusJSON(re.Status, body)
		return
	}
	abort(c, http.StatusInternalServerError, "server error")
}

func bindBody(c *gin.Context, v any) bool {
	body, _ := c.Get("body")
	if err := json.Unmarshal(body.([]byte), v); err != nil {
		abort(c, http.StatusBadRequest, "bad json")
		return false
	}
	return true
}

// ---- rooms ----

func (a *API) createRoom(c *gin.Context) {
	var b rooms.Batch
	if !bindBody(c, &b) {
		return
	}
	if len(b.Events) == 0 {
		abort(c, http.StatusBadRequest, "no events")
		return
	}
	first, err := proto.ParseEvent(b.Events[0])
	if err != nil {
		abort(c, http.StatusBadRequest, err.Error())
		return
	}
	st, err := a.rooms.Append(first.Room, b, rooms.Rules{Creating: true, Caller: caller(c)})
	if err != nil {
		a.fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": first.Room, "head": rooms.Head{Seq: st.NextSeq - 1, Hash: st.Head}})
}

// member loads the room and checks the caller belongs to it.
func (a *API) member(c *gin.Context) (*proto.State, *database.Member, bool) {
	room := c.Param("id")
	st, err := a.rooms.State(room)
	if err != nil {
		abort(c, http.StatusInternalServerError, "server error")
		return nil, nil, false
	}
	if st == nil || !st.IsMember(caller(c)) {
		// Same answer for "no such room" and "not yours".
		abort(c, http.StatusNotFound, "no such room")
		return nil, nil, false
	}
	m, err := database.First[database.Member](a.db.Where("room_id = ? AND member_id = ?", room, caller(c)))
	if err != nil || m == nil {
		abort(c, http.StatusInternalServerError, "server error")
		return nil, nil, false
	}
	return st, m, true
}

func (a *API) roomState(c *gin.Context) {
	st, _, ok := a.member(c)
	if !ok {
		return
	}
	since, _ := strconv.ParseInt(c.Query("since"), 10, 64)
	var evs []database.Event
	if err := a.db.Where("room_id = ? AND seq >= ?", st.Room, since).Order("seq").Find(&evs).Error; err != nil {
		abort(c, http.StatusInternalServerError, "db error")
		return
	}
	if evs == nil {
		evs = []database.Event{}
	}
	var last struct{ Pos, At int64 }
	a.db.Raw("SELECT COALESCE(MAX(pos), 0) AS pos, COALESCE(MAX(created_at), 0) AS at FROM messages WHERE room_id = ? AND kind = 'msg'", st.Room).Scan(&last)
	// Members' encryption keys are in the log itself (create/join events),
	// so there's nothing else to send.
	c.JSON(http.StatusOK, gin.H{"events": evs, "lastPos": last.Pos, "lastAt": last.At})
}

func (a *API) appendEvents(c *gin.Context) {
	var b rooms.Batch
	if !bindBody(c, &b) {
		return
	}
	st, err := a.rooms.Append(c.Param("id"), b, rooms.Rules{Caller: caller(c)})
	if err != nil {
		a.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"head": rooms.Head{Seq: st.NextSeq - 1, Hash: st.Head}})
}

func (a *API) roomKeys(c *gin.Context) {
	st, _, ok := a.member(c)
	if !ok {
		return
	}
	var envs []database.Envelope
	if err := a.db.Where("room_id = ? AND member_id = ?", st.Room, caller(c)).Order("epoch").Find(&envs).Error; err != nil {
		abort(c, http.StatusInternalServerError, "db error")
		return
	}
	if envs == nil {
		envs = []database.Envelope{}
	}
	c.JSON(http.StatusOK, gin.H{"envelopes": envs})
}

// ---- messages ----

const maxCt = 64 << 10

func (a *API) listMessages(c *gin.Context) {
	st, m, ok := a.member(c)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	if limit < 1 || limit > 200 {
		limit = 50
	}
	q := a.db.Where("room_id = ? AND epoch >= ? AND ? > 0", st.Room, m.FirstEpoch, m.FirstEpoch)
	if before, err := strconv.ParseInt(c.Query("before"), 10, 64); err == nil && before > 0 {
		q = q.Where("pos < ?", before).Order("pos DESC")
	} else if after, err := strconv.ParseInt(c.Query("after"), 10, 64); err == nil {
		q = q.Where("pos > ?", after).Order("pos ASC")
	} else {
		q = q.Order("pos DESC")
	}
	var msgs []database.Message
	if err := q.Limit(limit).Find(&msgs).Error; err != nil {
		abort(c, http.StatusInternalServerError, "db error")
		return
	}
	// Always oldest first.
	if len(msgs) > 1 && msgs[0].Pos > msgs[len(msgs)-1].Pos {
		for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
			msgs[i], msgs[j] = msgs[j], msgs[i]
		}
	}
	if msgs == nil {
		msgs = []database.Message{}
	}
	c.JSON(http.StatusOK, gin.H{"messages": msgs})
}

// unread says how far the caller has read and how many messages from others
// came after. The read position is the furthest of what the device says
// (after), the caller's latest receipt and their latest message: receipts and
// member ids are the same on every device, so this is the read position
// across devices. Kind and sender are plaintext, so the count is exact.
func (a *API) unread(c *gin.Context) {
	st, m, ok := a.member(c)
	if !ok {
		return
	}
	after, _ := strconv.ParseInt(c.Query("after"), 10, 64)
	me := caller(c)
	var own struct{ Pos int64 }
	a.db.Raw("SELECT COALESCE(MAX(pos), 0) AS pos FROM messages WHERE room_id = ? AND sender = ? AND kind IN ('msg', 'receipt')", st.Room, me).Scan(&own)
	readPos := max(after, own.Pos)
	var count int64
	if err := a.db.Model(&database.Message{}).
		Where("room_id = ? AND epoch >= ? AND ? > 0 AND pos > ? AND kind = 'msg' AND sender != ?", st.Room, m.FirstEpoch, m.FirstEpoch, readPos, me).
		Count(&count).Error; err != nil {
		abort(c, http.StatusInternalServerError, "db error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"readPos": readPos, "count": count})
}

func (a *API) postMessage(c *gin.Context) {
	st, m, ok := a.member(c)
	if !ok {
		return
	}
	var req struct {
		ID    string   `json:"id"`
		Epoch int64    `json:"epoch"`
		Kind  string   `json:"kind"`
		Ct    string   `json:"ct"`
		Blobs []string `json:"blobs"`
	}
	if !bindBody(c, &req) {
		return
	}
	if !proto.IsID(req.ID) || len(req.Ct) == 0 || len(req.Ct) > maxCt || len(req.Blobs) > 10 {
		abort(c, http.StatusBadRequest, "bad message")
		return
	}
	if req.Kind != "msg" && req.Kind != "reaction" && req.Kind != "receipt" && req.Kind != "call" {
		abort(c, http.StatusBadRequest, "bad kind")
		return
	}
	if m.FirstEpoch == 0 || req.Epoch != st.Epoch {
		abort(c, http.StatusConflict, "stale epoch")
		return
	}
	me := caller(c)
	msg := database.Message{ID: req.ID, RoomID: st.Room, Epoch: req.Epoch, Sender: me, Kind: req.Kind, Ct: req.Ct, CreatedAt: a.now().UnixMilli()}
	err := a.db.Transaction(func(tx *gorm.DB) error {
		if req.Kind == "receipt" {
			if err := tx.Where("room_id = ? AND sender = ? AND kind = 'receipt'", st.Room, me).Delete(&database.Message{}).Error; err != nil {
				return err
			}
		}
		if err := tx.Create(&msg).Error; err != nil {
			return err
		}
		if len(req.Blobs) > 0 {
			res := tx.Model(&database.Blob{}).
				Where("id IN ? AND room_id = ? AND uploader = ? AND message_id IS NULL", req.Blobs, st.Room, me).
				Update("message_id", req.ID)
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected != int64(len(req.Blobs)) {
				return errBadBlobs
			}
		}
		return nil
	})
	if errors.Is(err, errBadBlobs) {
		abort(c, http.StatusBadRequest, "unknown or already used blob")
		return
	}
	if err != nil {
		abort(c, http.StatusConflict, "duplicate message id")
		return
	}
	a.hub.SendRoom(st.Room, wsMsg{"type": "message", "room": st.Room, "message": msg}, "")
	// Devices that aren't connected right now (Google Play build) are woken
	// to fetch it. Reactions, receipts and call notices don't notify, so don't wake.
	if req.Kind == "msg" {
		a.push.Wake(st.Room)
	}
	c.JSON(http.StatusCreated, gin.H{"pos": msg.Pos, "createdAt": msg.CreatedAt})
}

var errBadBlobs = errors.New("bad blobs")

// ---- blobs ----

func (a *API) putBlob(c *gin.Context) {
	st, m, ok := a.member(c)
	if !ok {
		return
	}
	if m.FirstEpoch == 0 {
		abort(c, http.StatusConflict, "no key yet")
		return
	}
	body, _ := c.Get("body")
	data := body.([]byte)
	if len(data) == 0 {
		abort(c, http.StatusBadRequest, "empty blob")
		return
	}
	id := proto.NewID()
	if err := os.MkdirAll(a.cfg.BlobDir, 0o750); err != nil {
		abort(c, http.StatusInternalServerError, "storage error")
		return
	}
	if err := os.WriteFile(a.rooms.BlobPath(id), data, 0o640); err != nil {
		abort(c, http.StatusInternalServerError, "storage error")
		return
	}
	blob := database.Blob{ID: id, RoomID: st.Room, Uploader: caller(c), Size: int64(len(data)), CreatedAt: a.now().UnixMilli()}
	if err := a.db.Create(&blob).Error; err != nil {
		_ = os.Remove(a.rooms.BlobPath(id))
		abort(c, http.StatusInternalServerError, "db error")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

func (a *API) getBlob(c *gin.Context) {
	st, m, ok := a.member(c)
	if !ok {
		return
	}
	// Only blobs attached to a message the caller may read, members'
	// avatars, the group picture, or the caller's own upload in flight.
	var n int64
	a.db.Raw(`
		SELECT COUNT(*) FROM blobs b LEFT JOIN messages msg ON msg.id = b.message_id
		WHERE b.id = ? AND b.room_id = ?
		  AND ((msg.id IS NOT NULL AND msg.epoch >= ?) OR b.avatar = 1 OR b.picture = 1 OR (b.message_id IS NULL AND b.uploader = ?))`,
		c.Param("blob"), st.Room, m.FirstEpoch, caller(c)).Scan(&n)
	if n == 0 || m.FirstEpoch == 0 {
		abort(c, http.StatusNotFound, "no such blob")
		return
	}
	f, err := os.Open(a.rooms.BlobPath(c.Param("blob")))
	if err != nil {
		abort(c, http.StatusNotFound, "no such blob")
		return
	}
	defer f.Close()
	c.Header("Cache-Control", "private, no-store")
	c.Status(http.StatusOK)
	c.Header("Content-Type", "application/octet-stream")
	_, _ = io.Copy(c.Writer, f)
}

// putAvatar makes one of the caller's uploaded blobs their profile picture in
// this room, replacing (and deleting) any previous one. {"blob": ""} clears
// it. The key to the picture travels in the caller's encrypted profile event.
func (a *API) putAvatar(c *gin.Context) {
	st, _, ok := a.member(c)
	if !ok {
		return
	}
	var req struct {
		Blob string `json:"blob"`
	}
	if !bindBody(c, &req) {
		return
	}
	me := caller(c)
	var old []string
	err := a.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&database.Blob{}).
			Where("room_id = ? AND uploader = ? AND avatar = 1 AND id <> ?", st.Room, me, req.Blob).
			Pluck("id", &old).Error; err != nil {
			return err
		}
		if len(old) > 0 {
			if err := tx.Where("id IN ?", old).Delete(&database.Blob{}).Error; err != nil {
				return err
			}
		}
		if req.Blob == "" {
			return nil
		}
		res := tx.Model(&database.Blob{}).
			Where("id = ? AND room_id = ? AND uploader = ? AND message_id IS NULL AND picture = 0", req.Blob, st.Room, me).
			Update("avatar", true)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return errBadBlobs
		}
		return nil
	})
	if errors.Is(err, errBadBlobs) {
		abort(c, http.StatusBadRequest, "unknown or already used blob")
		return
	}
	if err != nil {
		abort(c, http.StatusInternalServerError, "db error")
		return
	}
	a.rooms.RemoveBlobFiles(old)
	c.Status(http.StatusNoContent)
}

// ---- invites ----

func (a *API) inviteUses(c *gin.Context) {
	st, _, ok := a.member(c)
	if !ok {
		return
	}
	if !st.IsAdmin(caller(c)) {
		abort(c, http.StatusForbidden, "admins only")
		return
	}
	var uses []database.InviteUse
	if err := a.db.Where("room_id = ?", st.Room).Order("used_at").Find(&uses).Error; err != nil {
		abort(c, http.StatusInternalServerError, "db error")
		return
	}
	if uses == nil {
		uses = []database.InviteUse{}
	}
	c.JSON(http.StatusOK, gin.H{"uses": uses})
}

func (a *API) loadInvite(c *gin.Context) (*database.Invite, *proto.State, bool) {
	inv, err := database.First[database.Invite](a.db.Where("id = ?", c.Param("id")))
	if err != nil {
		abort(c, http.StatusInternalServerError, "db error")
		return nil, nil, false
	}
	var st *proto.State
	if inv != nil {
		st, err = a.rooms.State(inv.RoomID)
		if err != nil {
			abort(c, http.StatusInternalServerError, "server error")
			return nil, nil, false
		}
	}
	if inv == nil || st == nil {
		abort(c, http.StatusNotFound, "invite not found")
		return nil, nil, false
	}
	iv := st.Invites[inv.ID]
	if iv == nil || iv.Revoked || (iv.ExpiresAt != 0 && a.now().UnixMilli() > iv.ExpiresAt) || (iv.MaxUses != 0 && iv.Uses >= iv.MaxUses) {
		// Revoked, expired and used-up invites all look the same.
		abort(c, http.StatusGone, "this invite is no longer valid")
		return nil, nil, false
	}
	return inv, st, true
}

func (a *API) getInvite(c *gin.Context) {
	inv, st, ok := a.loadInvite(c)
	if !ok {
		return
	}
	var evs []database.Event
	if err := a.db.Where("room_id = ?", st.Room).Order("seq").Find(&evs).Error; err != nil {
		abort(c, http.StatusInternalServerError, "db error")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"room":    st.Room,
		"preview": inv.Preview,
		// The joiner replays the log to learn who to seal the new epoch to
		// (and their keys), without trusting this server's word for it.
		"events": evs,
	})
}

func (a *API) joinInvite(c *gin.Context) {
	inv, st, ok := a.loadInvite(c)
	if !ok {
		return
	}
	if st.IsMember(caller(c)) {
		abort(c, http.StatusConflict, "already a member")
		return
	}
	var b rooms.Batch
	if !bindBody(c, &b) {
		return
	}
	newSt, err := a.rooms.Append(inv.RoomID, b, rooms.Rules{Joining: true, Caller: caller(c)})
	if err != nil {
		a.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"room": inv.RoomID, "head": rooms.Head{Seq: newSt.NextSeq - 1, Hash: newSt.Head}})
}

// ---- vaults ----

// A vault is its owner's encrypted room list (docs/protocol.md, "Finding
// your rooms again"). Its ID is a hash of the key that may write it, so the
// first write needs no registration and nobody else can overwrite it.

const maxVault = 64 << 10

func (a *API) getVault(c *gin.Context) {
	v, err := database.First[database.Vault](a.db.Where("id = ?", c.Param("id")))
	if err != nil {
		abort(c, http.StatusInternalServerError, "db error")
		return
	}
	if v == nil {
		abort(c, http.StatusNotFound, "no vault")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"blob": v.Blob})
}

func (a *API) putVault(c *gin.Context) {
	id := c.Param("id")
	pub, err := proto.ParseMemberID(caller(c))
	if err != nil || id != proto.VaultID(pub) {
		abort(c, http.StatusForbidden, "this key can't write that vault")
		return
	}
	var req struct {
		Blob string `json:"blob"`
	}
	if !bindBody(c, &req) {
		return
	}
	if req.Blob == "" || len(req.Blob) > maxVault {
		abort(c, http.StatusBadRequest, "bad vault")
		return
	}
	v := database.Vault{ID: id, Pub: caller(c), Blob: req.Blob}
	if err := a.db.Save(&v).Error; err != nil {
		abort(c, http.StatusInternalServerError, "db error")
		return
	}
	c.Status(http.StatusNoContent)
}

// ---- hub callbacks ----

func (a *API) onEvent(room string, ev database.Event, st *proto.State) {
	a.hub.SendRoom(room, wsMsg{"type": "event", "room": room, "event": ev}, "")
}

func (a *API) onRemoved(room, member string) {
	a.hub.Removed(room, member)
}

func (a *API) onDeleted(room string, ids []string) {
	a.hub.SendRoom(room, wsMsg{"type": "deleted", "room": room, "ids": ids}, "")
}
