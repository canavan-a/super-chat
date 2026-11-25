package crypto

import (
	"strings"
	"testing"

	"github.com/canavan-a/super-chat/shared/proto"
	"github.com/canavan-a/super-chat/shared/wire"
)

func TestPhraseErrors(t *testing.T) {
	e := NewEntropy()
	words := e.Phrase()
	if _, err := EntropyFromPhrase("not a phrase"); err == nil || !strings.Contains(err.Error(), "24 words") {
		t.Fatalf("short phrase: %v", err)
	}
	bad := append([]string{}, words...)
	bad[5] = "notaword"
	if _, err := EntropyFromPhrase(strings.Join(bad, " ")); err == nil || !strings.Contains(err.Error(), "notaword") {
		t.Fatalf("unknown word: %v", err)
	}
	swapped := append([]string{}, words...)
	if swapped[3] == "abandon" {
		swapped[3] = "ability"
	} else {
		swapped[3] = "abandon"
	}
	if _, err := EntropyFromPhrase(strings.Join(swapped, " ")); err == nil {
		t.Fatal("a phrase with a bad checksum was accepted")
	}
	back, err := EntropyFromPhrase("  " + strings.Join(words, "   \n") + " ")
	if err != nil || back != e {
		t.Fatalf("spacing should not matter: %v", err)
	}
}

func TestParseInviteLink(t *testing.T) {
	l := InviteLink{Server: "https://x.example", Invite: proto.NewID(), Secret: RandomBytes(32)}
	got, err := ParseInviteLink("  " + l.String() + "\n")
	if err != nil || got.String() != l.String() {
		t.Fatalf("https form: %v %v", got, err)
	}
	app := "superchat://join?s=" + "https%3A%2F%2Fx.example" + "&i=" + l.Invite + "&k=" + B64.EncodeToString(l.Secret)
	got, err = ParseInviteLink(app)
	if err != nil || got.String() != l.String() {
		t.Fatalf("app form: %v %v", got, err)
	}
	for _, s := range []string{"", "https://evil.example/i/x", "https://x.example/i/" + l.Invite, "superchat://join?s=ftp://x&i=" + l.Invite + "&k=x"} {
		if _, err := ParseInviteLink(s); err == nil {
			t.Fatalf("accepted %q", s)
		}
	}
}

func TestMessageRejections(t *testing.T) {
	room := proto.NewID()
	alice := MemberIdentity(NewEntropy(), room)
	mallory := MemberIdentity(NewEntropy(), room)
	key := RandomBytes(32)
	id := proto.NewID()
	ct, kind, err := EncryptMessage(alice, room, 3, key, Content{T: TypeText, Body: "hello"}, id, 1)
	if err != nil || kind != wire.KindMsg {
		t.Fatal(kind, err)
	}
	good := wire.Message{ID: id, Room: room, Epoch: 3, Sender: alice.ID, Kind: kind, Ct: ct}
	if d, err := DecryptMessage(&good, key); err != nil || d.Body != "hello" || d.Ts != 1 {
		t.Fatalf("good message: %+v %v", d, err)
	}
	cases := map[string]func(m *wire.Message) []byte{
		"wrong key":      func(m *wire.Message) []byte { return RandomBytes(32) },
		"other sender":   func(m *wire.Message) []byte { m.Sender = mallory.ID; return key },
		"other epoch":    func(m *wire.Message) []byte { m.Epoch = 4; return key },
		"other id":       func(m *wire.Message) []byte { m.ID = proto.NewID(); return key },
		"kind mismatch":  func(m *wire.Message) []byte { m.Kind = wire.KindReaction; return key },
		"tampered bytes": func(m *wire.Message) []byte { m.Ct = m.Ct[:len(m.Ct)-4] + "AAAA"; return key },
	}
	for name, mutate := range cases {
		m := good
		k := mutate(&m)
		if _, err := DecryptMessage(&m, k); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
	// Mallory has the room key but can't speak as Alice: the AD names the
	// sender, so re-labelling fails, and a fresh message is signed by Mallory.
	ct2, _, _ := EncryptMessage(mallory, room, 3, key, Content{T: TypeText, Body: "it's alice, honest"}, id, 1)
	forged := good
	forged.Ct = ct2
	if _, err := DecryptMessage(&forged, key); err == nil {
		t.Fatal("a message sealed by mallory was accepted as alice's")
	}
}

func TestSignalRejections(t *testing.T) {
	room := proto.NewID()
	alice := MemberIdentity(NewEntropy(), room)
	bob := MemberIdentity(NewEntropy(), room)
	key := RandomBytes(32)
	box, err := SealSignal(alice, room, 2, key, "", Signal{Sid: "a", K: SigBeat}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if s, _, err := OpenSignal(room, alice.ID, "", box, key, 1000); err != nil || s.K != SigBeat {
		t.Fatalf("broadcast: %+v %v", s, err)
	}
	if _, _, err := OpenSignal(room, alice.ID, bob.ID, box, key, 1000); err == nil {
		t.Fatal("a broadcast opened as a directed signal")
	}
	if _, _, err := OpenSignal(room, bob.ID, "", box, key, 1000); err == nil {
		t.Fatal("a signal opened as from someone else")
	}
	if n, err := SignalEpoch(box); err != nil || n != 2 {
		t.Fatalf("epoch: %d %v", n, err)
	}
	if _, err := SignalEpoch("x.y"); err == nil {
		t.Fatal("bad box epoch accepted")
	}
}

func TestReplayExtend(t *testing.T) {
	e := NewEntropy()
	room, b, _, me, err := CreateRoom(e, RoomMeta{Name: "r"}, "me", 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	r, err := ReplayLog(room, b.Events[:2])
	if err != nil {
		t.Fatal(err)
	}
	// Events it already has are skipped; the rest are applied.
	r2, err := r.Extend(b.Events)
	if err != nil || r2.State.NextSeq != int64(len(b.Events)) || len(r2.Events) != len(b.Events) {
		t.Fatalf("extend: %v seq=%d", err, r2.State.NextSeq)
	}
	// A bad event fails the extend and leaves the replay it started from alone.
	next, _, err := BuildEvents(me, r2.State, []NewEvent{{Kind: "profile"}, {Kind: "profile"}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	sig, _ := B64.DecodeString(next[1].Sig)
	sig[0] ^= 1
	next[1].Sig = B64.EncodeToString(sig)
	if _, err := r2.Extend(next); err == nil {
		t.Fatal("a bad event was accepted")
	}
	if r2.State.NextSeq != int64(len(b.Events)) || len(r2.Events) != len(b.Events) {
		t.Fatal("a failed extend changed the replay it started from")
	}
	if v := r2.View(nil); v.Name != "" || len(v.Members) != 1 || v.Members[0].Role != proto.RoleAdmin {
		t.Fatalf("without keys the view has no names: %+v", v)
	}
}

func TestTruncUTF16(t *testing.T) {
	cases := []struct {
		in   string
		n    int
		want string
	}{
		{"short", 80, "short"},
		{"abcdef", 3, "abc"},
		{"a😀b", 3, "a😀"}, // the emoji is two units, so it fits whole
		{"a😀b", 2, "a"},  // the cut would split the pair: drop it whole
		{"日本語", 2, "日本"},
	}
	for _, c := range cases {
		if got := truncUTF16(c.in, c.n); got != c.want {
			t.Fatalf("truncUTF16(%q, %d) = %q, want %q", c.in, c.n, got, c.want)
		}
	}
}

func TestEnvelopeCommitMismatch(t *testing.T) {
	e := NewEntropy()
	room, b, _, me, err := CreateRoom(e, RoomMeta{Name: "r"}, "me", 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenEnvelope(me, room, 1, b.Envelopes[me.ID], proto.EpochCommit(room, 1, RandomBytes(32))); err == nil {
		t.Fatal("an envelope was accepted against the wrong commit")
	}
}
