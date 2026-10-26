package proto

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"
)

// signRaw signs body bytes exactly as given, the way a hand-built client could.
func signRaw(t *testing.T, priv ed25519.PrivateKey, body string) SignedEvent {
	t.Helper()
	sig := ed25519.Sign(priv, append([]byte("sc-evt"), body...))
	return SignedEvent{Body: B64.EncodeToString([]byte(body)), Sig: B64.EncodeToString(sig)}
}

// Clients (JS) read keys case-sensitively; the server must refuse anything
// they'd read differently, or a member could get an event in that no client
// can replay.
func TestParseEventRejectsAmbiguousKeys(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	me, them := MemberID(pub), MemberID(other)
	room := NewID()
	head := `"v":1,"room":"` + room + `","seq":1,"prev":"x","ts":1,"pub":{},"epoch":0,"enc":""`

	ok := `{` + head + `,"author":"` + me + `","kind":"profile"}`
	if _, err := ParseEvent(signRaw(t, priv, ok)); err != nil {
		t.Fatalf("plain event rejected: %v", err)
	}
	for name, body := range map[string]string{
		"case-variant kind":   `{` + head + `,"author":"` + me + `","kind":"promote","Kind":"profile"}`,
		"case-variant author": `{` + head + `,"author":"` + them + `","AUTHOR":"` + me + `","kind":"profile"}`,
		"duplicate kind":      `{` + head + `,"author":"` + me + `","kind":"promote","kind":"profile"}`,
	} {
		if _, err := ParseEvent(signRaw(t, priv, body)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestDecodeRejectsAmbiguousPubKeys(t *testing.T) {
	var p TargetPub
	if err := decode([]byte(`{"target":"a","extra":1}`), &p); err != nil || p.Target != "a" {
		t.Fatalf("plain pub: %v %q", err, p.Target)
	}
	for _, raw := range []string{`{"target":"a","TARGET":"b"}`, `{"target":"a","target":"b"}`} {
		if err := decode([]byte(raw), &p); err == nil || !strings.Contains(err.Error(), "key") {
			t.Errorf("%s: got %v", raw, err)
		}
	}
}
