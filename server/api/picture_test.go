package api

import (
	"encoding/json"
	"testing"
	"time"

	"main/sweeper"
)

func TestGroupPicture(t *testing.T) {
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

	// Only admins set it, like the room name.
	code, body := bob.do("PUT", "/v1/rooms/"+r.id+"/picture", map[string]any{"blob": upload(bob)})
	want(t, "member sets picture", code, 403, body)

	first := upload(alice)
	code, body = alice.do("PUT", "/v1/rooms/"+r.id+"/picture", map[string]any{"blob": first})
	want(t, "set picture", code, 204, body)
	code, _ = bob.raw("GET", "/v1/rooms/"+r.id+"/blobs/"+first, nil)
	want(t, "member reads picture", code, 200, "")
	code, _ = eve.raw("GET", "/v1/rooms/"+r.id+"/blobs/"+first, nil)
	want(t, "outsider reads picture", code, 404, "")

	// The group picture can't also be an avatar.
	code, body = alice.do("PUT", "/v1/rooms/"+r.id+"/avatar", map[string]any{"blob": first})
	want(t, "picture as avatar", code, 400, body)

	e.now = e.now.Add(2 * time.Hour)
	if _, err := sweeper.Sweep(e.svc); err != nil {
		t.Fatal(err)
	}
	code, _ = bob.raw("GET", "/v1/rooms/"+r.id+"/blobs/"+first, nil)
	want(t, "picture survives sweep", code, 200, "")

	second := upload(alice)
	code, body = alice.do("PUT", "/v1/rooms/"+r.id+"/picture", map[string]any{"blob": second})
	want(t, "replace picture", code, 204, body)
	code, _ = bob.raw("GET", "/v1/rooms/"+r.id+"/blobs/"+first, nil)
	want(t, "old picture gone", code, 404, "")

	code, body = alice.do("PUT", "/v1/rooms/"+r.id+"/picture", map[string]any{"blob": ""})
	want(t, "clear picture", code, 204, body)
	code, _ = bob.raw("GET", "/v1/rooms/"+r.id+"/blobs/"+second, nil)
	want(t, "cleared picture", code, 404, "")
}
