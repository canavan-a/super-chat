package crypto

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/canavan-a/super-chat/shared/proto"
	"github.com/canavan-a/super-chat/shared/wire"
)

// One vector format, both ways (see "Go interop vectors" in
// app/__tests__/crypto.test.ts). testdata/ts-vectors.json is written by the
// TypeScript client and checked here; testdata/go-vectors.json is written
// here and checked there. Each side reproduces what's deterministic (member
// IDs, the phrase, the invite key and join proof, the vault ID) and opens
// everything else. go-vectors.json is rewritten only when missing or with
// WRITE_FIXTURE=1.

type vectors struct {
	Entropy     string              `json:"entropy"`
	BobEntropy  string              `json:"bobEntropy"`
	Phrase      string              `json:"phrase"`
	Fingerprint string              `json:"fingerprint"`
	Room        string              `json:"room"`
	Server      string              `json:"server"`
	AliceID     string              `json:"aliceId"`
	BobID       string              `json:"bobId"`
	Events      []proto.SignedEvent `json:"events"`
	Expect      struct {
		NextSeq int64             `json:"nextSeq"`
		Head    string            `json:"head"`
		Epoch   int64             `json:"epoch"`
		Members map[string]string `json:"members"`
	} `json:"expect"`
	Envelopes []struct {
		Epoch  int64  `json:"epoch"`
		Member string `json:"member"`
		Sealed string `json:"sealed"`
	} `json:"envelopes"`
	Keys map[string]string `json:"keys"`
	Enc  []struct {
		Seq    int64 `json:"seq"`
		Expect any   `json:"expect"`
	} `json:"enc"`
	Invite struct {
		Link         string `json:"link"`
		Preview      string `json:"preview"`
		PreviewPlain any    `json:"previewPlain"`
	} `json:"invite"`
	Messages []vecMessage `json:"messages"`
	RTC      struct {
		From   string `json:"from"`
		To     string `json:"to"`
		Box    string `json:"box"`
		Now    int64  `json:"now"`
		Expect any    `json:"expect"`
	} `json:"rtc"`
	Blob struct {
		Key    string `json:"key"`
		Sealed string `json:"sealed"`
		Plain  string `json:"plain"`
	} `json:"blob"`
	Vault struct {
		Server string   `json:"server"`
		ID     string   `json:"id"`
		Blob   string   `json:"blob"`
		Rooms  []string `json:"rooms"`
	} `json:"vault"`
	View any `json:"view"`
}

// normView is the room view as both languages build it (see normView in the
// app test): members sorted by ID, "" for no name or color.
type normView struct {
	Name          string               `json:"name"`
	Color         string               `json:"color"`
	Picture       *AvatarRef           `json:"picture"`
	RetentionDays int                  `json:"retentionDays"`
	Epoch         int64                `json:"epoch"`
	Names         map[string]string    `json:"names"`
	Avatars       map[string]AvatarRef `json:"avatars"`
	Members       []normMember         `json:"members"`
	Activity      []Activity           `json:"activity"`
	Wiped         *Wiped               `json:"wiped"`
}

type normMember struct {
	ID   string `json:"id"`
	Role string `json:"role"`
	Name string `json:"name"`
}

func normalize(v *RoomView) normView {
	n := normView{Name: v.Name, Color: v.Color, Picture: v.Picture, RetentionDays: v.RetentionDays, Epoch: v.Epoch,
		Names: v.Names, Avatars: v.Avatars, Activity: v.Activity, Wiped: v.Wiped, Members: []normMember{}}
	for _, m := range v.Members {
		n.Members = append(n.Members, normMember{m.ID, m.Role, m.Name})
	}
	sort.Slice(n.Members, func(i, j int) bool { return n.Members[i].ID < n.Members[j].ID })
	return n
}

type vecMessage struct {
	Message wire.Message `json:"message"`
	Expect  any          `json:"expect"`
	Ts      int64        `json:"ts"`
}

func TestTSVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/ts-vectors.json")
	if err != nil {
		t.Skip("run the app's jest suite first to write testdata/ts-vectors.json")
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	checkVectors(t, &v)
}

func TestGoVectors(t *testing.T) {
	v := buildVectors(t)
	checkVectors(t, roundTrip(t, v))
	file := filepath.Join("testdata", "go-vectors.json")
	_, statErr := os.Stat(file)
	rewrite := os.Getenv("WRITE_FIXTURE") == "1" || os.IsNotExist(statErr)
	// The committed file must still check out, unless it's being replaced.
	if !rewrite {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var old vectors
		if err := json.Unmarshal(raw, &old); err != nil {
			t.Fatal(err)
		}
		checkVectors(t, &old)
	}
	if rewrite {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(v); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// roundTrip passes v through JSON, so the check sees exactly what the file holds.
func roundTrip(t *testing.T, v *vectors) *vectors {
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out vectors
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return &out
}

func fixedEntropy(f func(i int) byte) Entropy {
	var e Entropy
	for i := range e {
		e[i] = f(i)
	}
	return e
}

func buildVectors(t *testing.T) *vectors {
	t.Helper()
	const now = int64(1_700_000_000_000)
	alicE := fixedEntropy(func(i int) byte { return byte(i + 1) })
	bobE := fixedEntropy(func(i int) byte { return byte(200 - i) })
	server := "https://chat.example"
	room, created, key1, alice, err := CreateRoom(alicE, RoomMeta{Name: "Den", Color: "#4C8BF5"}, "Alice", 30, now)
	must(t, err)
	bob := MemberIdentity(bobE, room)
	s1, _ := replay(t, room, created.Events)
	preview := InvitePreview{Name: "Den", Color: "#4C8BF5", Inviter: "Alice"}
	link, inv, err := CreateInvite(alice, s1, server, preview, 0, 0, now)
	must(t, err)
	s2, _ := replay(t, room, append(append([]proto.SignedEvent{}, created.Events...), inv.Events...))
	parsed, err := ParseInviteLink(link.String())
	must(t, err)
	joined, ep, err := Join(bob, s2, parsed, &preview, "Bob", now)
	must(t, err)
	events := append(append(append([]proto.SignedEvent{}, created.Events...), inv.Events...), joined.Events...)
	s3, _ := replay(t, room, events)
	// A profile picture, and a meta with a group picture and a name long enough
	// to be cut at 80 UTF-16 units (the emoji counts as two).
	extra, _, err := BuildEvents(alice, s3, []NewEvent{
		{Kind: "profile", Enc: map[string]any{"displayName": "Alice", "avatar": AvatarRef{Blob: proto.NewID(), Key: B64.EncodeToString(RandomBytes(32)), At: 1_700_000_000_000}}, EncEpoch: 2, EncKey: ep.Key},
		{Kind: "meta", Enc: map[string]any{"name": "😀 " + strings.Repeat("x", 100), "picture": AvatarRef{Blob: proto.NewID(), Key: B64.EncodeToString(RandomBytes(32)), At: 1_700_000_000_123}}, EncEpoch: 2, EncKey: ep.Key},
	}, now)
	must(t, err)
	events = append(events, extra...)
	st, evs := replay(t, room, events)
	keys := map[int64][]byte{1: key1, 2: ep.Key}

	v := &vectors{
		Entropy:     B64.EncodeToString(alicE[:]),
		BobEntropy:  B64.EncodeToString(bobE[:]),
		Phrase:      strings.Join(alicE.Phrase(), " "),
		Fingerprint: alicE.Fingerprint(),
		Room:        room,
		Server:      server,
		AliceID:     alice.ID,
		BobID:       bob.ID,
		Events:      events,
		Keys:        map[string]string{"1": B64.EncodeToString(key1), "2": B64.EncodeToString(ep.Key)},
	}
	v.Expect.NextSeq, v.Expect.Head, v.Expect.Epoch, v.Expect.Members = st.NextSeq, st.Head, st.Epoch, st.Members
	v.Envelopes = append(v.Envelopes,
		struct {
			Epoch  int64  `json:"epoch"`
			Member string `json:"member"`
			Sealed string `json:"sealed"`
		}{1, alice.ID, created.Envelopes[alice.ID]},
		struct {
			Epoch  int64  `json:"epoch"`
			Member string `json:"member"`
			Sealed string `json:"sealed"`
		}{2, alice.ID, joined.Envelopes[alice.ID]},
		struct {
			Epoch  int64  `json:"epoch"`
			Member string `json:"member"`
			Sealed string `json:"sealed"`
		}{2, bob.ID, joined.Envelopes[bob.ID]},
	)
	for _, e := range evs {
		if e.Enc == "" {
			continue
		}
		var x any
		must(t, OpenEnc(e, keys[e.Epoch], &x))
		v.Enc = append(v.Enc, struct {
			Seq    int64 `json:"seq"`
			Expect any   `json:"expect"`
		}{e.Seq, x})
	}
	v.Invite.Link, v.Invite.Preview, v.Invite.PreviewPlain = link.String(), inv.Preview, preview

	msg := func(from *Member, c Content, pos int64) vecMessage {
		id := proto.NewID()
		ct, kind, err := EncryptMessage(from, room, 2, ep.Key, c, id, now+pos)
		must(t, err)
		m := wire.Message{Pos: pos, ID: id, Room: room, Epoch: 2, Sender: from.ID, Kind: kind, Ct: ct}
		d, err := DecryptMessage(&m, ep.Key)
		must(t, err)
		return vecMessage{Message: m, Expect: stripRaw(t, d.Raw), Ts: d.Ts}
	}
	first := msg(alice, Content{T: TypeText, Body: "hi <@" + bob.ID + "> 😀 & \"quotes\"   end", ReplyTo: proto.NewID()}, 1)
	v.Messages = []vecMessage{
		first,
		msg(alice, Content{T: TypeFile, Body: "caption", Files: []FileRef{{
			Blob: proto.NewID(), Key: B64.EncodeToString(RandomBytes(32)), Name: "a.jpg", Mime: "image/jpeg", Size: 1234, W: 10, H: 20,
		}}}, 2),
		msg(alice, Content{T: TypeEdit, Target: first.Message.ID, Body: "hi again"}, 3),
		msg(bob, Content{T: TypeReaction, Target: first.Message.ID, Emoji: "👍"}, 4),
	}

	sig := Signal{Sid: "alice-sid", ToSid: "bob-sid", K: SigOffer, SDP: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n", Muted: true}
	box, err := SealSignal(alice, room, 2, ep.Key, bob.ID, sig, now)
	must(t, err)
	v.RTC.From, v.RTC.To, v.RTC.Box, v.RTC.Now, v.RTC.Expect = alice.ID, bob.ID, box, now, toAny(t, sig)

	plain := []byte("a picture, say")
	bk, sealed := EncryptBlob(plain)
	v.Blob.Key, v.Blob.Sealed, v.Blob.Plain = B64.EncodeToString(bk), B64.EncodeToString(sealed), B64.EncodeToString(plain)

	vk := VaultKeys(alicE, server)
	vb, err := vk.Seal(VaultData{Rooms: []string{room}})
	must(t, err)
	v.Vault.Server, v.Vault.ID, v.Vault.Blob, v.Vault.Rooms = server, vk.ID, vb, []string{room}
	r, err := ReplayLog(room, events)
	must(t, err)
	v.View = toAny(t, normalize(r.View(keys)))
	return v
}

func checkVectors(t *testing.T, v *vectors) {
	t.Helper()
	ent, err := B64.DecodeString(v.Entropy)
	must(t, err)
	var e Entropy
	copy(e[:], ent)
	if got := strings.Join(e.Phrase(), " "); got != v.Phrase {
		t.Fatalf("phrase: got %q want %q", got, v.Phrase)
	}
	back, err := EntropyFromPhrase(strings.ToUpper(v.Phrase))
	must(t, err)
	if back != e {
		t.Fatal("phrase doesn't round-trip to the entropy")
	}
	if e.Fingerprint() != v.Fingerprint {
		t.Fatalf("fingerprint: got %s want %s", e.Fingerprint(), v.Fingerprint)
	}
	bobRaw, err := B64.DecodeString(v.BobEntropy)
	must(t, err)
	var be Entropy
	copy(be[:], bobRaw)
	alice, bob := MemberIdentity(e, v.Room), MemberIdentity(be, v.Room)
	if alice.ID != v.AliceID || bob.ID != v.BobID {
		t.Fatalf("member ids: got %s %s want %s %s", alice.ID, bob.ID, v.AliceID, v.BobID)
	}

	st, evs := replay(t, v.Room, v.Events)
	if st.NextSeq != v.Expect.NextSeq || st.Head != v.Expect.Head || st.Epoch != v.Expect.Epoch || !reflect.DeepEqual(st.Members, v.Expect.Members) {
		t.Fatalf("state: got seq=%d head=%s epoch=%d members=%v", st.NextSeq, st.Head, st.Epoch, st.Members)
	}
	commits := map[int64]string{}
	var invitePub proto.InvitePub
	var joinPub proto.JoinPub
	for _, ev := range evs {
		switch ev.Kind {
		case "epoch":
			var p proto.EpochPub
			must(t, json.Unmarshal(ev.Pub, &p))
			commits[p.Epoch] = p.Commit
		case "invite":
			must(t, json.Unmarshal(ev.Pub, &invitePub))
		case "join":
			must(t, json.Unmarshal(ev.Pub, &joinPub))
		}
	}

	link, err := ParseInviteLink(v.Invite.Link)
	must(t, err)
	if link.String() != v.Invite.Link {
		t.Fatalf("invite link doesn't round-trip: %s", link.String())
	}
	if got := B64.EncodeToString(inviteKey(link.Secret).Public().(ed25519.PublicKey)); got != invitePub.Key {
		t.Fatalf("invite key: got %s want %s", got, invitePub.Key)
	}
	if got := B64.EncodeToString(JoinProof(link.Secret, v.Room, link.Invite, bob.ID)); got != joinPub.Proof {
		t.Fatalf("join proof: got %s want %s", got, joinPub.Proof)
	}
	pv, err := OpenPreview(link.Secret, v.Invite.Preview)
	must(t, err)
	if !reflect.DeepEqual(toAny(t, pv), v.Invite.PreviewPlain) {
		t.Fatalf("preview: got %+v want %v", pv, v.Invite.PreviewPlain)
	}

	keys := map[int64][]byte{}
	for _, env := range v.Envelopes {
		me := bob
		if env.Member == alice.ID {
			me = alice
		}
		k, err := OpenEnvelope(me, v.Room, env.Epoch, env.Sealed, commits[env.Epoch])
		must(t, err)
		if B64.EncodeToString(k) != v.Keys[strconv.FormatInt(env.Epoch, 10)] {
			t.Fatalf("epoch %d key mismatch", env.Epoch)
		}
		keys[env.Epoch] = k
	}
	if len(v.Enc) < 4 {
		t.Fatalf("only %d enc payloads", len(v.Enc))
	}
	for _, x := range v.Enc {
		var got any
		ev := evs[x.Seq]
		must(t, OpenEnc(ev, keys[ev.Epoch], &got))
		if !reflect.DeepEqual(got, x.Expect) {
			t.Fatalf("enc of event %d (%s): got %v want %v", x.Seq, ev.Kind, got, x.Expect)
		}
	}

	if len(v.Messages) < 4 {
		t.Fatalf("only %d messages", len(v.Messages))
	}
	for i, m := range v.Messages {
		d, err := DecryptMessage(&m.Message, keys[m.Message.Epoch])
		must(t, err)
		if got := stripRaw(t, d.Raw); !reflect.DeepEqual(got, m.Expect) {
			t.Fatalf("message %d: got %v want %v", i, got, m.Expect)
		}
		if d.Ts != m.Ts {
			t.Fatalf("message %d ts: got %d want %d", i, d.Ts, m.Ts)
		}
		// The typed fields come through too, not just the raw JSON.
		if !reflect.DeepEqual(stripRaw(t, mustMarshal(t, d.Content)), m.Expect) {
			t.Fatalf("message %d: typed content lost something: %+v", i, d.Content)
		}
	}
	if !strings.Contains(v.Messages[0].Expect.(map[string]any)["body"].(string), "<@"+bob.ID+">") {
		t.Fatal("first message should carry a mention")
	}

	sig, _, err := OpenSignal(v.Room, v.RTC.From, v.RTC.To, v.RTC.Box, keys[2], v.RTC.Now)
	must(t, err)
	if got := toAny(t, sig); !reflect.DeepEqual(got, v.RTC.Expect) {
		t.Fatalf("signal: got %v want %v", got, v.RTC.Expect)
	}
	if _, _, err := OpenSignal(v.Room, v.RTC.From, v.RTC.To, v.RTC.Box, keys[2], v.RTC.Now+SignalMaxSkewMs+1); err == nil {
		t.Fatal("a stale signal was accepted")
	}

	bk, _ := B64.DecodeString(v.Blob.Key)
	bs, _ := B64.DecodeString(v.Blob.Sealed)
	plain, err := DecryptBlob(bk, bs)
	must(t, err)
	if B64.EncodeToString(plain) != v.Blob.Plain {
		t.Fatal("blob mismatch")
	}

	vk := VaultKeys(e, v.Vault.Server)
	if vk.ID != v.Vault.ID {
		t.Fatalf("vault id: got %s want %s", vk.ID, v.Vault.ID)
	}
	vd, err := vk.Open(v.Vault.Blob)
	must(t, err)
	if !reflect.DeepEqual(vd.Rooms, v.Vault.Rooms) {
		t.Fatalf("vault rooms: got %v want %v", vd.Rooms, v.Vault.Rooms)
	}

	r, err := ReplayLog(v.Room, v.Events)
	must(t, err)
	if got := toAny(t, normalize(r.View(keys))); !reflect.DeepEqual(got, v.View) {
		t.Fatalf("room view:\n got %v\nwant %v", got, v.View)
	}
}

func replay(t *testing.T, room string, events []proto.SignedEvent) (*proto.State, []*proto.Event) {
	t.Helper()
	st := proto.NewState(room)
	var evs []*proto.Event
	for i, se := range events {
		e, err := proto.ParseEvent(se)
		if err != nil {
			t.Fatalf("event %d: %v", i, err)
		}
		if err := st.Apply(e, 0); err != nil {
			t.Fatalf("event %d (%s): %v", i, e.Kind, err)
		}
		evs = append(evs, e)
	}
	return st, evs
}

// stripRaw is a message's inner JSON without v and ts, as a generic value.
func stripRaw(t *testing.T, raw []byte) any {
	t.Helper()
	var m map[string]any
	must(t, json.Unmarshal(raw, &m))
	delete(m, "v")
	delete(m, "ts")
	return m
}

func toAny(t *testing.T, v any) any {
	t.Helper()
	var out any
	must(t, json.Unmarshal(mustMarshal(t, v), &out))
	return out
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := marshal(v)
	must(t, err)
	return raw
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
