package api

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"

	"main/config"
	"main/database"
	"main/proto"
	"main/rooms"
	"main/sweeper"
)

// ---- harness ----

type env struct {
	t   *testing.T
	srv *httptest.Server
	api *API
	svc *rooms.Service
	now time.Time
}

func newEnv(t *testing.T) *env {
	t.Helper()
	dir := t.TempDir()
	db, err := database.Connect(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{BlobDir: filepath.Join(dir, "blobs"), MaxBlobBytes: 1 << 20}
	svc := rooms.NewService(db, cfg.BlobDir)
	a := New(db, cfg, svc)
	e := &env{t: t, api: a, svc: svc, now: time.Now()}
	a.SetClock(func() time.Time { return e.now })
	e.srv = httptest.NewServer(a.Router())
	t.Cleanup(e.srv.Close)
	return e
}

type user struct {
	id   string
	priv ed25519.PrivateKey
	e    *env
}

// user is one member key. (Real clients derive a different one per room;
// for the server that's indistinguishable from different people.)
func (e *env) user() *user {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	return &user{id: proto.MemberID(pub), priv: priv, e: e}
}

func xKey() string {
	k := make([]byte, 32)
	_, _ = rand.Read(k)
	return proto.B64.EncodeToString(k)
}

func (u *user) raw(method, path string, body []byte) (int, []byte) {
	ts := strconv.FormatInt(u.e.now.UnixMilli(), 10)
	nonce := proto.NewID()
	sig := ed25519.Sign(u.priv, proto.RequestSigningString(method, path, ts, nonce, body))
	req, _ := http.NewRequest(method, u.e.srv.URL+path, bytes.NewReader(body))
	req.Header.Set("X-SC-Member", u.id)
	req.Header.Set("X-SC-Ts", ts)
	req.Header.Set("X-SC-Nonce", nonce)
	req.Header.Set("X-SC-Sig", proto.B64.EncodeToString(sig))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		u.e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	return resp.StatusCode, buf.Bytes()
}

func (u *user) do(method, path string, v any) (int, string) {
	var body []byte
	if v != nil {
		body, _ = json.Marshal(v)
	}
	code, out := u.raw(method, path, body)
	return code, string(out)
}

// room tracks a room's head from one user's point of view.
type room struct {
	id   string
	e    *env
	seq  int64
	head string
	ep   int64
}

func (r *room) sync() {
	st, err := r.e.svc.State(r.id)
	if err != nil || st == nil {
		r.e.t.Fatalf("state: %v", err)
	}
	r.seq, r.head, r.ep = st.NextSeq, st.Head, st.Epoch
}

func (r *room) ev(u *user, kind string, pub any) proto.SignedEvent {
	se := proto.SignEvent(u.priv, proto.EventBody{
		Room: r.id, Seq: r.seq, Prev: r.head, Author: u.id, Ts: r.e.now.UnixMilli(), Kind: kind, Pub: proto.MustPub(pub),
	})
	e, _ := proto.ParseEvent(se)
	r.seq++
	r.head = e.Hash
	return se
}

func (r *room) epoch(u *user, members []string) (proto.SignedEvent, map[string]string) {
	sort.Strings(members)
	r.ep++
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	env := map[string]string{}
	for _, m := range members {
		env[m] = "sealed-for-" + m
	}
	return r.ev(u, "epoch", proto.EpochPub{Epoch: r.ep, Recipients: members, Commit: proto.EpochCommit(r.id, r.ep, key)}), env
}

func (e *env) createRoom(admin *user) *room {
	r := &room{id: proto.NewID(), e: e}
	create := r.ev(admin, "create", proto.CreatePub{RetentionDays: 30, X25519: xKey()})
	ep, env := r.epoch(admin, []string{admin.id})
	code, body := admin.do("POST", "/v1/rooms", rooms.Batch{Events: []proto.SignedEvent{create, ep}, Envelopes: env})
	if code != 201 {
		e.t.Fatalf("create room: %d %s", code, body)
	}
	return r
}

type invite struct {
	id   string
	priv ed25519.PrivateKey
}

func (r *room) invite(admin *user, maxUses int, expires int64) (*invite, int, string) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	iv := &invite{id: proto.NewID(), priv: priv}
	ev := r.ev(admin, "invite", proto.InvitePub{ID: iv.id, Key: proto.B64.EncodeToString(pub), ExpiresAt: expires, MaxUses: maxUses})
	code, body := admin.do("POST", "/v1/rooms/"+r.id+"/events", rooms.Batch{Events: []proto.SignedEvent{ev}, Preview: "preview"})
	if code != 200 {
		r.sync()
	}
	return iv, code, body
}

func (r *room) join(u *user, iv *invite, members []string) (int, string) {
	r.sync()
	proof := ed25519.Sign(iv.priv, proto.JoinProofMessage(r.id, iv.id, u.id))
	join := r.ev(u, "join", proto.JoinPub{Invite: iv.id, Proof: proto.B64.EncodeToString(proof), X25519: xKey()})
	ep, env := r.epoch(u, append(members, u.id))
	code, body := u.do("POST", "/v1/invites/"+iv.id+"/join", rooms.Batch{Events: []proto.SignedEvent{join, ep}, Envelopes: env})
	r.sync()
	return code, body
}

func (r *room) post(u *user, b rooms.Batch) (int, string) {
	r.sync()
	code, body := u.do("POST", "/v1/rooms/"+r.id+"/events", b)
	r.sync()
	return code, body
}

func (r *room) send(u *user, kind string) (string, int, string) {
	r.sync()
	id := proto.NewID()
	code, body := u.do("POST", "/v1/rooms/"+r.id+"/messages", map[string]any{"id": id, "epoch": r.ep, "kind": kind, "ct": "ciphertext"})
	return id, code, body
}

func (r *room) messages(u *user) (int, []database.Message) {
	code, body := u.raw("GET", "/v1/rooms/"+r.id+"/messages", nil)
	var out struct{ Messages []database.Message }
	_ = json.Unmarshal(body, &out)
	return code, out.Messages
}

func want(t *testing.T, what string, got, wantCode int, body string) {
	t.Helper()
	if got != wantCode {
		t.Fatalf("%s: got %d want %d (%s)", what, got, wantCode, body)
	}
}

// ---- tests ----

func TestSignedRequests(t *testing.T) {
	e := newEnv(t)
	u := e.user()
	r := e.createRoom(u)
	path := "/v1/rooms/" + r.id + "/state"

	signed := func(signPath, sendPath, ts, nonce string) int {
		sig := ed25519.Sign(u.priv, proto.RequestSigningString("GET", signPath, ts, nonce, nil))
		req, _ := http.NewRequest("GET", e.srv.URL+sendPath, nil)
		req.Header.Set("X-SC-Member", u.id)
		req.Header.Set("X-SC-Ts", ts)
		req.Header.Set("X-SC-Nonce", nonce)
		req.Header.Set("X-SC-Sig", proto.B64.EncodeToString(sig))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	now := strconv.FormatInt(e.now.UnixMilli(), 10)

	resp, _ := http.Get(e.srv.URL + path)
	want(t, "unsigned", resp.StatusCode, 401, "")
	want(t, "signed for another path", signed("/v1/rooms/x/state", path, now, "n0"), 401, "")
	want(t, "first use", signed(path, path, now, "n1"), 200, "")
	want(t, "replay", signed(path, path, now, "n1"), 401, "")
	stale := strconv.FormatInt(e.now.Add(-2*time.Minute).UnixMilli(), 10)
	want(t, "skewed clock", signed(path, path, stale, "n2"), 401, "")

	// A valid signature from a key that isn't in the room gets nothing.
	code, _ := e.user().do("GET", path, nil)
	want(t, "non-member", code, 404, "")
}

func TestVault(t *testing.T) {
	e := newEnv(t)
	owner, other := e.user(), e.user()
	pub, _ := proto.ParseMemberID(owner.id)
	id := proto.VaultID(pub)

	resp, _ := http.Get(e.srv.URL + "/v1/vault/" + id)
	want(t, "empty vault", resp.StatusCode, 404, "")
	code, body := owner.do("PUT", "/v1/vault/"+id, map[string]string{"blob": "sealed-v1"})
	want(t, "owner writes", code, 204, body)
	code, body = other.do("PUT", "/v1/vault/"+id, map[string]string{"blob": "clobbered"})
	want(t, "someone else writes", code, 403, body)
	code, body = owner.do("PUT", "/v1/vault/"+id, map[string]string{"blob": "sealed-v2"})
	want(t, "owner updates", code, 204, body)

	resp, _ = http.Get(e.srv.URL + "/v1/vault/" + id)
	var out struct{ Blob string }
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if out.Blob != "sealed-v2" {
		t.Fatalf("vault: got %q", out.Blob)
	}
}

func TestRoomLifecycle(t *testing.T) {
	e := newEnv(t)
	alice, bob, carol, mallory := e.user(), e.user(), e.user(), e.user()
	r := e.createRoom(alice)

	// Only members can see the room.
	code, _ := r.messages(mallory)
	want(t, "outsider reads", code, 404, "")

	// Non-admin can't invite; admin can.
	iv, code, body := r.invite(alice, 0, 0)
	want(t, "admin invites", code, 200, body)

	// A join with a forged proof fails.
	r.sync()
	_, forged, _ := ed25519.GenerateKey(rand.Reader)
	bad := &invite{id: iv.id, priv: forged}
	code, body = r.join(mallory, bad, []string{alice.id})
	want(t, "forged proof", code, 403, body)

	// A join that doesn't rotate the key is refused.
	r.sync()
	proof := ed25519.Sign(iv.priv, proto.JoinProofMessage(r.id, iv.id, bob.id))
	code, body = bob.do("POST", "/v1/invites/"+iv.id+"/join", rooms.Batch{Events: []proto.SignedEvent{
		r.ev(bob, "join", proto.JoinPub{Invite: iv.id, Proof: proto.B64.EncodeToString(proof), X25519: xKey()}),
	}})
	want(t, "join without rotation", code, 400, body)

	// Alice posts before bob joins.
	early, code, body := r.send(alice, "msg")
	want(t, "alice posts", code, 201, body)

	code, body = r.join(bob, iv, []string{alice.id})
	want(t, "bob joins", code, 200, body)

	// Bob can't see what was sent before he joined.
	code, msgs := r.messages(bob)
	want(t, "bob reads", code, 200, "")
	for _, m := range msgs {
		if m.ID == early {
			t.Fatal("bob can read a message from before he joined")
		}
	}

	// Bob (member) can't invite, promote, or change settings.
	_, code, body = r.invite(bob, 0, 0)
	want(t, "member invites", code, 403, body)
	code, body = r.post(bob, rooms.Batch{Events: []proto.SignedEvent{r.ev(bob, "promote", proto.TargetPub{Target: bob.id})}})
	want(t, "member promotes self", code, 403, body)
	code, body = r.post(bob, rooms.Batch{Events: []proto.SignedEvent{r.ev(bob, "settings", proto.SettingsPub{RetentionDays: 1})}})
	want(t, "member changes settings", code, 403, body)

	// Alice promotes bob; now he can invite.
	code, body = r.post(alice, rooms.Batch{Events: []proto.SignedEvent{r.ev(alice, "promote", proto.TargetPub{Target: bob.id})}})
	want(t, "promote", code, 200, body)
	iv2, code, body := r.invite(bob, 1, 0)
	want(t, "new admin invites", code, 200, body)

	// Messages using a stale epoch are refused.
	r.sync()
	code, body = carol.do("POST", "/v1/rooms/"+r.id+"/messages", map[string]any{"id": proto.NewID(), "epoch": 1, "kind": "msg", "ct": "x"})
	want(t, "outsider posts", code, 404, body)

	// Carol joins via a single-use invite; mallory can't reuse it.
	code, body = r.join(carol, iv2, []string{alice.id, bob.id})
	want(t, "carol joins", code, 200, body)
	code, body = r.join(mallory, iv2, []string{alice.id, bob.id, carol.id})
	want(t, "used-up invite", code, 410, body)

	// Revoked invites stop working.
	code, body = r.post(alice, rooms.Batch{Events: []proto.SignedEvent{r.ev(alice, "revoke", proto.RevokePub{ID: iv.id})}})
	want(t, "revoke", code, 200, body)
	code, body = r.join(mallory, iv, []string{alice.id, bob.id, carol.id})
	want(t, "revoked invite", code, 410, body)

	// Admin sees who used which invite.
	code, body = alice.do("GET", "/v1/rooms/"+r.id+"/invites/uses", nil)
	want(t, "uses", code, 200, body)
	var uses struct{ Uses []database.InviteUse }
	_ = json.Unmarshal([]byte(body), &uses)
	if len(uses.Uses) != 2 {
		t.Fatalf("want 2 uses, got %v", uses.Uses)
	}
	code, _ = carol.do("GET", "/v1/rooms/"+r.id+"/invites/uses", nil)
	want(t, "member sees uses", code, 403, "")

	// Kicking carol must rotate, and the new epoch excludes her.
	r.sync()
	kick := r.ev(alice, "kick", proto.TargetPub{Target: carol.id})
	code, body = alice.do("POST", "/v1/rooms/"+r.id+"/events", rooms.Batch{Events: []proto.SignedEvent{kick}})
	want(t, "kick without rotation", code, 400, body)
	r.sync()
	kick = r.ev(alice, "kick", proto.TargetPub{Target: carol.id})
	ep, env := r.epoch(alice, []string{alice.id, bob.id})
	code, body = alice.do("POST", "/v1/rooms/"+r.id+"/events", rooms.Batch{Events: []proto.SignedEvent{kick, ep}, Envelopes: env})
	want(t, "kick", code, 200, body)
	code, _ = r.messages(carol)
	want(t, "kicked reads", code, 404, "")
	code, body = carol.do("GET", "/v1/rooms/"+r.id+"/keys", nil)
	want(t, "kicked keys", code, 404, body)

	// Epoch recipients must be exactly the members: sealing to an outsider fails.
	r.sync()
	ep, env = r.epoch(alice, []string{alice.id, bob.id, mallory.id})
	code, body = alice.do("POST", "/v1/rooms/"+r.id+"/events", rooms.Batch{Events: []proto.SignedEvent{ep}, Envelopes: env})
	want(t, "smuggled recipient", code, 403, body)
}

func TestDeletes(t *testing.T) {
	e := newEnv(t)
	alice, bob, carol := e.user(), e.user(), e.user()
	r := e.createRoom(alice)
	iv, _, _ := r.invite(alice, 0, 0)
	r.join(bob, iv, []string{alice.id})
	r.join(carol, iv, []string{alice.id, bob.id})

	bobMsg, _, _ := r.send(bob, "msg")
	aliceMsg, _, _ := r.send(alice, "msg")

	// Carol (member) can't delete bob's message.
	code, body := r.post(carol, rooms.Batch{Events: []proto.SignedEvent{r.ev(carol, "delete", proto.DeletePub{Msg: bobMsg, Sender: carol.id})}})
	want(t, "carol's delete event", code, 200, body) // allowed as an event, but names the wrong sender…
	if _, msgs := r.messages(alice); len(msgs) != 2 {
		t.Fatalf("…so nothing was deleted: %v", msgs)
	}
	code, body = r.post(carol, rooms.Batch{Events: []proto.SignedEvent{r.ev(carol, "delete", proto.DeletePub{Msg: bobMsg, Sender: bob.id})}})
	want(t, "member deletes another's message", code, 403, body)

	// Bob deletes his own; alice (admin) deletes hers... and anyone's.
	code, body = r.post(bob, rooms.Batch{Events: []proto.SignedEvent{r.ev(bob, "delete", proto.DeletePub{Msg: bobMsg, Sender: bob.id})}})
	want(t, "sender deletes", code, 200, body)
	carolMsg, _, _ := r.send(carol, "msg")
	code, body = r.post(alice, rooms.Batch{Events: []proto.SignedEvent{r.ev(alice, "delete", proto.DeletePub{Msg: carolMsg, Sender: carol.id})}})
	want(t, "admin deletes", code, 200, body)

	_, msgs := r.messages(alice)
	if len(msgs) != 1 || msgs[0].ID != aliceMsg {
		t.Fatalf("want only alice's message left, got %v", msgs)
	}
}

func TestRetentionAndBlobs(t *testing.T) {
	e := newEnv(t)
	alice := e.user()
	r := e.createRoom(alice)
	code, body := r.post(alice, rooms.Batch{Events: []proto.SignedEvent{r.ev(alice, "settings", proto.SettingsPub{RetentionDays: 1})}})
	want(t, "settings", code, 200, body)

	// A blob attached to an old message.
	code, out := alice.raw("PUT", "/v1/rooms/"+r.id+"/blobs", []byte("encrypted-bytes"))
	want(t, "upload", code, 201, string(out))
	var blob struct{ ID string }
	_ = json.Unmarshal(out, &blob)
	r.sync()
	old := proto.NewID()
	code, body = alice.do("POST", "/v1/rooms/"+r.id+"/messages", map[string]any{"id": old, "epoch": r.ep, "kind": "msg", "ct": "x", "blobs": []string{blob.ID}})
	want(t, "post with blob", code, 201, body)
	// The same blob can't be attached twice.
	code, body = alice.do("POST", "/v1/rooms/"+r.id+"/messages", map[string]any{"id": proto.NewID(), "epoch": r.ep, "kind": "msg", "ct": "x", "blobs": []string{blob.ID}})
	want(t, "reuse blob", code, 400, body)

	e.now = e.now.Add(25 * time.Hour)
	fresh, _, _ := r.send(alice, "msg")
	if _, err := sweeper.Sweep(e.svc); err != nil {
		t.Fatal(err)
	}
	_, msgs := r.messages(alice)
	if len(msgs) != 1 || msgs[0].ID != fresh {
		t.Fatalf("retention: want only the fresh message, got %v", msgs)
	}
	code, _ = alice.raw("GET", "/v1/rooms/"+r.id+"/blobs/"+blob.ID, nil)
	want(t, "expired blob", code, 404, "")
}

func TestReceiptsKeepOnlyLatest(t *testing.T) {
	e := newEnv(t)
	alice := e.user()
	r := e.createRoom(alice)
	r.send(alice, "receipt")
	r.send(alice, "receipt")
	_, msgs := r.messages(alice)
	if len(msgs) != 1 {
		t.Fatalf("want one receipt, got %d", len(msgs))
	}
}

func TestUnreadCount(t *testing.T) {
	e := newEnv(t)
	alice, bob := e.user(), e.user()
	r := e.createRoom(alice)
	iv, _, _ := r.invite(alice, 0, 0)
	r.join(bob, iv, []string{alice.id})
	unread := func(u *user, after int64) (readPos, count int64) {
		code, body := u.raw("GET", "/v1/rooms/"+r.id+"/unread?after="+strconv.FormatInt(after, 10), nil)
		want(t, "unread", code, 200, string(body))
		var out struct{ ReadPos, Count int64 }
		_ = json.Unmarshal(body, &out)
		return out.ReadPos, out.Count
	}

	// Only messages from others count: not reactions, receipts, call notices
	// or your own.
	r.send(alice, "msg")
	r.send(alice, "msg")
	r.send(alice, "reaction")
	r.send(alice, "receipt")
	r.send(bob, "reaction")
	_, code, body := r.send(alice, "call")
	want(t, "call notice", code, 201, body)
	if rp, n := unread(bob, 0); rp != 0 || n != 2 {
		t.Fatalf("bob: readPos %d count %d, want 0 2", rp, n)
	}
	_, msgs := r.messages(bob)
	first := msgs[0].Pos
	if _, n := unread(bob, first); n != 1 {
		t.Fatalf("after first: count %d, want 1", n)
	}

	// A receipt (from any of bob's devices) moves the read position.
	r.send(bob, "receipt")
	rp, n := unread(bob, 0)
	if rp <= first || n != 0 {
		t.Fatalf("after receipt: readPos %d count %d", rp, n)
	}
	// So does sending: you've read what you replied to.
	r.send(alice, "msg")
	r.send(bob, "msg")
	if rp2, n := unread(bob, 0); rp2 <= rp || n != 0 {
		t.Fatalf("after own message: readPos %d count %d", rp2, n)
	}
	// A device further ahead than the server knows wins.
	if rp, _ := unread(bob, 1<<40); rp != 1<<40 {
		t.Fatalf("after: readPos %d", rp)
	}

	// Nothing from before you joined.
	carol := e.user()
	r.join(carol, iv, []string{alice.id, bob.id})
	if _, n := unread(carol, 0); n != 0 {
		t.Fatalf("carol: count %d, want 0", n)
	}
	r.send(alice, "msg")
	if _, n := unread(carol, 0); n != 1 {
		t.Fatalf("carol after alice: count %d, want 1", n)
	}
}

func TestLeaveThenRotate(t *testing.T) {
	e := newEnv(t)
	alice, bob, carol := e.user(), e.user(), e.user()
	r := e.createRoom(alice)
	iv, _, _ := r.invite(alice, 0, 0)
	r.join(bob, iv, []string{alice.id})
	r.join(carol, iv, []string{alice.id, bob.id})

	code, body := r.post(carol, rooms.Batch{Events: []proto.SignedEvent{r.ev(carol, "leave", nil)}})
	want(t, "leave", code, 200, body)
	// Bob isn't an admin, but the leave lets any member rotate.
	r.sync()
	ep, env := r.epoch(bob, []string{alice.id, bob.id})
	code, body = bob.do("POST", "/v1/rooms/"+r.id+"/events", rooms.Batch{Events: []proto.SignedEvent{ep}, Envelopes: env})
	want(t, "member rotates after leave", code, 200, body)
	// ...but not again.
	r.sync()
	ep, env = r.epoch(bob, []string{alice.id, bob.id})
	code, body = bob.do("POST", "/v1/rooms/"+r.id+"/events", rooms.Batch{Events: []proto.SignedEvent{ep}, Envelopes: env})
	want(t, "member rotates again", code, 403, body)
}

func TestAvatars(t *testing.T) {
	e := newEnv(t)
	alice, bob, eve := e.user(), e.user(), e.user()
	r := e.createRoom(alice)
	iv, _, _ := r.invite(alice, 0, 0)
	r.join(bob, iv, []string{alice.id})
	r.sync()

	upload := func(u *user) string {
		code, out := u.raw("PUT", "/v1/rooms/"+r.id+"/blobs", []byte("sealed-picture"))
		want(t, "upload", code, 201, string(out))
		var b struct{ ID string }
		_ = json.Unmarshal(out, &b)
		return b.ID
	}
	first := upload(alice)
	code, body := alice.do("PUT", "/v1/rooms/"+r.id+"/avatar", map[string]any{"blob": first})
	want(t, "set avatar", code, 204, body)

	// Other members can read it (no message needed); outsiders can't.
	code, _ = bob.raw("GET", "/v1/rooms/"+r.id+"/blobs/"+first, nil)
	want(t, "member reads avatar", code, 200, "")
	code, _ = eve.raw("GET", "/v1/rooms/"+r.id+"/blobs/"+first, nil)
	want(t, "outsider reads avatar", code, 404, "")

	// Someone else's upload can't become your avatar.
	theirs := upload(bob)
	code, body = alice.do("PUT", "/v1/rooms/"+r.id+"/avatar", map[string]any{"blob": theirs})
	want(t, "steal blob", code, 400, body)

	// The sweeper keeps avatars past the orphan window.
	e.now = e.now.Add(2 * time.Hour)
	if _, err := sweeper.Sweep(e.svc); err != nil {
		t.Fatal(err)
	}
	code, _ = bob.raw("GET", "/v1/rooms/"+r.id+"/blobs/"+first, nil)
	want(t, "avatar survives sweep", code, 200, "")

	// A new avatar replaces (deletes) the old one.
	second := upload(alice)
	code, body = alice.do("PUT", "/v1/rooms/"+r.id+"/avatar", map[string]any{"blob": second})
	want(t, "replace avatar", code, 204, body)
	code, _ = bob.raw("GET", "/v1/rooms/"+r.id+"/blobs/"+first, nil)
	want(t, "old avatar gone", code, 404, "")
	code, _ = bob.raw("GET", "/v1/rooms/"+r.id+"/blobs/"+second, nil)
	want(t, "new avatar", code, 200, "")

	// Clearing it removes it.
	code, body = alice.do("PUT", "/v1/rooms/"+r.id+"/avatar", map[string]any{"blob": ""})
	want(t, "clear avatar", code, 204, body)
	code, _ = bob.raw("GET", "/v1/rooms/"+r.id+"/blobs/"+second, nil)
	want(t, "cleared avatar", code, 404, "")
}

func TestWipe(t *testing.T) {
	e := newEnv(t)
	alice, bob := e.user(), e.user()
	r := e.createRoom(alice)
	iv, _, _ := r.invite(alice, 0, 0)
	r.join(bob, iv, []string{alice.id})
	r.sync()

	code, out := bob.raw("PUT", "/v1/rooms/"+r.id+"/blobs", []byte("sealed-file"))
	want(t, "upload", code, 201, string(out))
	var blob struct{ ID string }
	_ = json.Unmarshal(out, &blob)
	code, body := bob.do("POST", "/v1/rooms/"+r.id+"/messages", map[string]any{"id": proto.NewID(), "epoch": r.ep, "kind": "msg", "ct": "x", "blobs": []string{blob.ID}})
	want(t, "post with blob", code, 201, body)
	r.send(alice, "msg")

	// Only admins can wipe.
	code, body = r.post(bob, rooms.Batch{Events: []proto.SignedEvent{r.ev(bob, "wipe", nil)}})
	want(t, "member wipes", code, 403, body)
	r.sync()
	code, body = r.post(alice, rooms.Batch{Events: []proto.SignedEvent{r.ev(alice, "wipe", nil)}})
	want(t, "admin wipes", code, 200, body)

	if _, msgs := r.messages(alice); len(msgs) != 0 {
		t.Fatalf("want no messages after wipe, got %d", len(msgs))
	}
	code, _ = bob.raw("GET", "/v1/rooms/"+r.id+"/blobs/"+blob.ID, nil)
	want(t, "attachment after wipe", code, 404, "")

	// The room carries on.
	r.sync()
	r.send(bob, "msg")
	if _, msgs := r.messages(alice); len(msgs) != 1 {
		t.Fatalf("want the new message after wipe, got %d", len(msgs))
	}
}
