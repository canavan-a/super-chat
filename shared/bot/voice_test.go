package bot_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"

	"github.com/canavan-a/super-chat/shared/bot"
	"github.com/canavan-a/super-chat/shared/bot/audio"
	"github.com/canavan-a/super-chat/shared/bot/core"
	"github.com/canavan-a/super-chat/shared/bot/internal/api"
	"github.com/canavan-a/super-chat/shared/crypto"
	"github.com/canavan-a/super-chat/shared/wire"
)

// phone is a person's device in a voice room, speaking the app's protocol
// (app/src/call/engine.ts) with pion in place of the browser's WebRTC.
type phone struct {
	t    *testing.T
	p    *person
	conn *api.Conn
	sid  string
	in   bool // in voice

	mu       sync.Mutex
	peers    map[string]*webrtc.PeerConnection
	pending  map[string][]webrtc.ICECandidateInit
	remote   map[string]bool
	sdps     map[string][]string // SDP each member sent us
	beats    map[string]crypto.Signal
	left     map[string]bool
	payloads chan rx
}

func newPhone(t *testing.T, p *person) *phone {
	t.Helper()
	conn, err := p.c.Dial(context.Background())
	p.must(err)
	p.must(conn.Subscribe([]api.Subscription{{Room: p.room, Signer: p.me}}))
	ph := &phone{
		t: t, p: p, conn: conn, sid: crypto.B64.EncodeToString(crypto.RandomBytes(9)),
		peers: map[string]*webrtc.PeerConnection{}, pending: map[string][]webrtc.ICECandidateInit{},
		remote: map[string]bool{}, sdps: map[string][]string{}, beats: map[string]crypto.Signal{}, left: map[string]bool{},
		payloads: make(chan rx, 4096),
	}
	go ph.read()
	t.Cleanup(func() { conn.Close(); ph.closeAll() })
	return ph
}

func (ph *phone) closeAll() {
	ph.mu.Lock()
	defer ph.mu.Unlock()
	for _, pc := range ph.peers {
		pc.Close()
	}
}

func (ph *phone) send(to string, s crypto.Signal) {
	s.Sid = ph.sid
	epoch, key := ph.p.currentKey()
	box, err := crypto.SealSignal(ph.p.me, ph.p.room, epoch, key, to, s, time.Now().UnixMilli())
	ph.p.must(err)
	ph.p.must(ph.conn.SendRTC(ph.p.room, to, box))
}

func (ph *phone) join() {
	ph.in = true
	ph.send("", crypto.Signal{K: crypto.SigJoin})
}

func (ph *phone) leave() {
	ph.in = false
	ph.send("", crypto.Signal{K: crypto.SigLeave})
	ph.closeAll()
}

func (ph *phone) read() {
	for {
		m, err := ph.conn.Read()
		if err != nil {
			return
		}
		if m.Type != wire.WSRTC {
			continue
		}
		ph.onRTC(m)
	}
}

func (ph *phone) onRTC(m *wire.ServerWS) {
	epoch, err := crypto.SignalEpoch(m.Box)
	if err != nil {
		return
	}
	key := ph.p.keyFor(epoch)
	if key == nil {
		return
	}
	s, _, err := crypto.OpenSignal(ph.p.room, m.From, m.To, m.Box, key, time.Now().UnixMilli())
	if err != nil {
		return
	}
	if s.ToSid != "" && s.ToSid != ph.sid {
		return
	}
	id := m.From + ":" + s.Sid
	switch s.K {
	case crypto.SigBeat, crypto.SigHere, crypto.SigJoin: // the app's presence takes all three
		ph.mu.Lock()
		ph.beats[m.From] = *s
		ph.mu.Unlock()
	case crypto.SigLeave:
		ph.mu.Lock()
		ph.left[m.From] = true
		ph.mu.Unlock()
	}
	switch s.K {
	case crypto.SigProbe:
		if ph.in {
			ph.send(m.From, crypto.Signal{K: crypto.SigBeat, ToSid: s.Sid})
		}
	case crypto.SigJoin:
		// Already in voice: say so, and make the offer (sendrecv, as a
		// phone with a microphone would).
		if ph.in {
			ph.send(m.From, crypto.Signal{K: crypto.SigHere, ToSid: s.Sid})
			pc := ph.newPC(m.From, s.Sid)
			offer, err := pc.CreateOffer(nil)
			ph.p.must(err)
			ph.p.must(pc.SetLocalDescription(offer))
			ph.send(m.From, crypto.Signal{K: crypto.SigOffer, ToSid: s.Sid, SDP: offer.SDP})
		}
	case crypto.SigOffer:
		ph.mu.Lock()
		ph.sdps[m.From] = append(ph.sdps[m.From], s.SDP)
		ph.mu.Unlock()
		pc := ph.pc(id)
		if pc == nil {
			pc = ph.newPC(m.From, s.Sid)
		}
		ph.p.must(pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: s.SDP}))
		ph.flush(id, pc)
		ans, err := pc.CreateAnswer(nil)
		ph.p.must(err)
		ph.p.must(pc.SetLocalDescription(ans))
		ph.send(m.From, crypto.Signal{K: crypto.SigAnswer, ToSid: s.Sid, SDP: ans.SDP})
	case crypto.SigAnswer:
		ph.mu.Lock()
		ph.sdps[m.From] = append(ph.sdps[m.From], s.SDP)
		ph.mu.Unlock()
		if pc := ph.pc(id); pc != nil {
			ph.p.must(pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: s.SDP}))
			ph.flush(id, pc)
		}
	case crypto.SigICE:
		var c webrtc.ICECandidateInit
		if json.Unmarshal(s.Cand, &c) != nil {
			return
		}
		ph.mu.Lock()
		pc := ph.peers[id]
		if pc == nil || !ph.remote[id] {
			ph.pending[id] = append(ph.pending[id], c)
			ph.mu.Unlock()
			return
		}
		ph.mu.Unlock()
		_ = pc.AddICECandidate(c)
	}
}

func (ph *phone) pc(id string) *webrtc.PeerConnection {
	ph.mu.Lock()
	defer ph.mu.Unlock()
	return ph.peers[id]
}

func (ph *phone) flush(id string, pc *webrtc.PeerConnection) {
	ph.mu.Lock()
	ph.remote[id] = true
	queued := ph.pending[id]
	ph.pending[id] = nil
	ph.mu.Unlock()
	for _, c := range queued {
		_ = pc.AddICECandidate(c)
	}
}

func (ph *phone) newPC(member, sid string) *webrtc.PeerConnection {
	m := &webrtc.MediaEngine{}
	ph.p.must(m.RegisterDefaultCodecs())
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(m)).NewPeerConnection(webrtc.Configuration{})
	ph.p.must(err)
	mic, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", "mic")
	ph.p.must(err)
	_, err = pc.AddTrack(mic)
	ph.p.must(err)
	pc.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			pkt, _, err := tr.ReadRTP()
			if err != nil {
				return
			}
			select {
			case ph.payloads <- rx{append([]byte(nil), pkt.Payload...), time.Now()}:
			default:
			}
		}
	})
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		raw, _ := json.Marshal(c.ToJSON())
		ph.send(member, crypto.Signal{K: crypto.SigICE, ToSid: sid, Cand: raw})
	})
	ph.mu.Lock()
	ph.peers[member+":"+sid] = pc
	ph.mu.Unlock()
	return pc
}

// rx is a packet the phone received, and when.
type rx struct {
	p  []byte
	at time.Time
}

// receiveTimed collects packets with their arrival times for d.
func (ph *phone) receiveTimed(d time.Duration) []rx {
	var out []rx
	end := time.After(d)
	for {
		select {
		case p := <-ph.payloads:
			out = append(out, p)
		case <-end:
			return out
		}
	}
}

// drain empties what's been received so far.
func (ph *phone) drain() {
	for {
		select {
		case <-ph.payloads:
		default:
			return
		}
	}
}

// receive collects payloads for d.
func (ph *phone) receive(d time.Duration) [][]byte {
	var out [][]byte
	end := time.After(d)
	for {
		select {
		case p := <-ph.payloads:
			out = append(out, p.p)
		case <-end:
			return out
		}
	}
}

func (ph *phone) lastSDP(from string) string {
	ph.mu.Lock()
	defer ph.mu.Unlock()
	l := ph.sdps[from]
	if len(l) == 0 {
		return ""
	}
	return l[len(l)-1]
}

func (ph *phone) beatFrom(member string) (crypto.Signal, bool) {
	ph.mu.Lock()
	defer ph.mu.Unlock()
	s, ok := ph.beats[member]
	return s, ok
}

// ---- the bot, for voice ----

type voiceEvents struct {
	mu  sync.Mutex
	log []string
}

func (v *voiceEvents) add(s string) {
	v.mu.Lock()
	v.log = append(v.log, s)
	v.mu.Unlock()
}

func (v *voiceEvents) has(s string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	for _, x := range v.log {
		if x == s {
			return true
		}
	}
	return false
}

func startVoiceBot(t *testing.T, dir string) (*bot.Bot, *voiceEvents) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if testing.Verbose() {
		log = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	// No STUN: everyone here is on one machine.
	b, err := bot.New(bot.Config{DataDir: dir, Logger: log, ICEServers: []webrtc.ICEServer{}})
	if err != nil {
		t.Fatal(err)
	}
	ev := &voiceEvents{}
	b.OnVoicePresence(func(_ context.Context, _ string, _, after []bot.VoiceSession) {
		ev.add(fmt.Sprint("presence ", len(after)))
	})
	b.OnVoiceJoined(func(context.Context, *bot.Call) { ev.add("joined") })
	b.OnVoiceLeft(func(_ context.Context, _, why string) { ev.add("left: " + why) })
	b.OnVoicePeerJoined(func(_ context.Context, _ *bot.Call, s bot.VoiceSession) { ev.add("peer joined " + s.Name) })
	b.OnVoicePeerLeft(func(_ context.Context, _ *bot.Call, s bot.VoiceSession) { ev.add("peer left " + s.Name) })
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- b.Run(ctx) }()
	t.Cleanup(func() { stop(); <-done; b.Close() })
	eventually(t, "the bot to start", func() bool { _, err := bot.ControlRooms(dir); return err == nil })
	return b, ev
}

func oggOf(t *testing.T, packets [][]byte) []byte {
	var buf bytes.Buffer
	w, err := oggwriter.NewWith(&nopWriteCloser{&buf}, 48000, 2)
	if err != nil {
		t.Fatal(err)
	}
	for i, p := range packets {
		if err := w.WriteRTP(&rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(i), Timestamp: uint32(i * 960)}, Payload: p}); err != nil {
			t.Fatal(err)
		}
	}
	w.Close()
	return buf.Bytes()
}

type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }

func isSilence(p []byte) bool { return bytes.Equal(p, audio.Silence) }

// ---- the test ----

func TestVoice(t *testing.T) {
	srv := startServer(t)
	alice := newPerson(t, srv, "Alice")
	alice.createRoom("Den")
	dir := initBot(t, "Emma")
	b, ev := startVoiceBot(t, dir)
	room, err := b.Join(context.Background(), alice.invite())
	if err != nil {
		t.Fatal(err)
	}
	me := botID(t, room, alice.me.ID)

	// Presence, without the bot joining.
	ap := newPhone(t, alice)
	if got := b.Voice.Presence(room.ID); len(got) != 0 {
		t.Fatalf("presence before anyone joined: %+v", got)
	}
	ap.join()
	eventually(t, "the bot to see alice in voice", func() bool {
		ps := b.Voice.Presence(room.ID)
		return len(ps) == 1 && ps[0].Member == alice.me.ID && ps[0].Name == "Alice"
	})
	eventually(t, "the presence hook", func() bool { return ev.has("presence 1") })

	// The bot joins a call alice is already in: alice offers (sendrecv), the
	// bot answers send-only, tuned like the app's.
	call, err := b.Voice.Join(context.Background(), room.ID)
	if err != nil {
		t.Fatal(err)
	}
	if again, _ := b.Voice.Join(context.Background(), room.ID); again != call {
		t.Fatal("joining again made a second call")
	}
	eventually(t, "the bot's answer", func() bool { return ap.lastSDP(me) != "" })
	sdp := ap.lastSDP(me)
	if !strings.Contains(sdp, "a=sendonly") || strings.Contains(sdp, "a=sendrecv") {
		t.Fatalf("the bot's answer isn't send-only:\n%s", sdp)
	}
	if !strings.Contains(sdp, "cbr=1") || !strings.Contains(sdp, "maxaveragebitrate=32000") || strings.Contains(sdp, "ssrc-audio-level") {
		t.Fatalf("the bot's answer isn't tuned:\n%s", sdp)
	}
	eventually(t, "the peer-joined hook", func() bool { return ev.has("peer joined Alice") })
	if ps := call.Peers(); len(ps) != 1 || ps[0].Member != alice.me.ID {
		t.Fatalf("call peers: %+v", ps)
	}
	// It tells the room it's here, can't hear, and isn't muted.
	eventually(t, "the bot's beat", func() bool { s, ok := ap.beatFrom(me); return ok && s.Deaf && !s.Muted })

	// Idle: a steady 50 packets a second of silence, so the app never shows
	// the bot as stalled.
	ap.drain()
	idle := ap.receive(time.Second)
	if len(idle) < 40 {
		t.Fatalf("only %d packets in a second of silence", len(idle))
	}
	for _, p := range idle {
		if !isSilence(p) {
			t.Fatalf("a non-silent packet while idle: % x", p)
		}
	}

	// Playing an Ogg file: its packets arrive in order, then silence again.
	var want [][]byte
	for i := 0; i < 25; i++ {
		want = append(want, []byte{0xFC, 'A', byte(i)})
	}
	src, err := audio.Ogg(bytes.NewReader(oggOf(t, want)))
	if err != nil {
		t.Fatal(err)
	}
	ap.drain()
	start := time.Now()
	pb := call.Play(src)
	select {
	case <-pb.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the clip never finished")
	}
	if err := pb.Err(); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d < 400*time.Millisecond {
		t.Fatalf("25 × 20 ms played in %s: not paced", d)
	}
	got := ap.receive(300 * time.Millisecond)
	var clip [][]byte
	for _, p := range got {
		if !isSilence(p) {
			clip = append(clip, p)
		}
	}
	if len(clip) != len(want) {
		t.Fatalf("received %d of the clip's %d packets", len(clip), len(want))
	}
	for i := range want {
		if !bytes.Equal(clip[i], want[i]) {
			t.Fatalf("packet %d: % x, want % x", i, clip[i], want[i])
		}
	}
	if !isSilence(got[len(got)-1]) {
		t.Fatal("not back to silence after the clip")
	}

	// Muted: the room is told, and only silence goes out while a clip plays.
	call.SetMuted(true)
	eventually(t, "the muted beat", func() bool { s, _ := ap.beatFrom(me); return s.Muted })
	src2, _ := audio.Ogg(bytes.NewReader(oggOf(t, want)))
	ap.drain()
	pb2 := call.Play(src2)
	<-pb2.Done()
	for _, p := range ap.receive(200 * time.Millisecond) {
		if !isSilence(p) {
			t.Fatal("sound went out while muted")
		}
	}
	call.SetMuted(false)

	// Someone joins the bot's call: the bot is the one already in voice, so
	// it says "here" and makes the offer, send-only.
	bob := newPerson(t, srv, "Bob")
	bob.join(alice.invite())
	bp := newPhone(t, bob)
	bp.join()
	eventually(t, "the bot's offer to bob", func() bool { return bp.lastSDP(me) != "" })
	if sdp := bp.lastSDP(me); !strings.Contains(sdp, "a=sendonly") {
		t.Fatalf("the bot's offer isn't send-only:\n%s", sdp)
	}
	eventually(t, "bob to connect", func() bool { return ev.has("peer joined Bob") })
	bp.drain()
	if n := len(bp.receive(500 * time.Millisecond)); n < 15 {
		t.Fatalf("bob got %d packets in half a second", n)
	}

	// Alice leaves the call; then the bot leaves.
	ap.leave()
	eventually(t, "alice to leave the call", func() bool { return ev.has("peer left Alice") && len(call.Peers()) == 1 })
	if err := call.Leave(context.Background()); err != nil {
		t.Fatal(err)
	}
	if call.Why() != "left" || b.Voice.Call(room.ID) != nil {
		t.Fatalf("after Leave: why=%q call=%v", call.Why(), b.Voice.Call(room.ID))
	}
	eventually(t, "bob to hear the bot leave", func() bool { bp.mu.Lock(); defer bp.mu.Unlock(); return bp.left[me] })
	eventually(t, "the left hook", func() bool { return ev.has("left: left") })
	// The chat shows the bot joining and leaving the call, as for a person.
	eventually(t, "the call notices", func() bool {
		var acts []string
		for _, m := range alice.messages() {
			if m.sender == me && m.c.T == crypto.TypeCall {
				acts = append(acts, m.c.Action)
			}
		}
		return strings.Join(acts, ",") == "join,leave"
	})

	// Kicked from the room while in voice: the call ends with it.
	call, err = b.Voice.Join(context.Background(), room.ID)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "bob to reconnect to the bot", func() bool { return len(call.Peers()) == 1 })
	alice.kick(me)
	select {
	case <-call.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("the call outlived the kick")
	}
	if call.Why() != "removed from the room" {
		t.Fatalf("why: %q", call.Why())
	}
}

func TestVoiceFull(t *testing.T) {
	srv := startServer(t)
	alice := newPerson(t, srv, "Alice")
	alice.createRoom("Den")
	dir := initBot(t, "Emma")
	b, _ := startVoiceBot(t, dir)
	room, err := b.Join(context.Background(), alice.invite())
	if err != nil {
		t.Fatal(err)
	}
	// Eight sessions already in voice (one person on eight devices).
	var phones []*phone
	for i := 0; i < 8; i++ {
		ph := newPhone(t, alice)
		ph.join()
		phones = append(phones, ph)
	}
	eventually(t, "the bot to count eight", func() bool { return len(b.Voice.Presence(room.ID)) == 8 })
	if _, err := b.Voice.Join(context.Background(), room.ID); err != bot.ErrVoiceFull {
		t.Fatalf("joining a full voice room: %v", err)
	}
	_ = phones
}

func TestVoiceCommands(t *testing.T) {
	srv := startServer(t)
	alice := newPerson(t, srv, "Alice")
	alice.createRoom("Den")
	dir := initBot(t, "Emma")
	b, _ := startVoiceBot(t, dir)
	core.Register(b)
	room, err := b.Join(context.Background(), alice.invite())
	if err != nil {
		t.Fatal(err)
	}
	me := botID(t, room, alice.me.ID)

	expectHas(t, alice.ask(me, "voice who"), "Nobody's in voice")
	ap := newPhone(t, alice)
	ap.join()
	eventually(t, "presence", func() bool { return len(b.Voice.Presence(room.ID)) == 1 })
	expectHas(t, alice.ask(me, "voice who"), "In voice (1)")
	expectHas(t, alice.ask(me, "voice join"), "Only the bot's admins")
	expectHas(t, alice.ask(me, "login hunter2"), "You're my admin")
	expectHas(t, alice.ask(me, "voice join"), "I'm in voice")
	eventually(t, "alice to connect to the bot", func() bool {
		c := b.Voice.Call(room.ID)
		return c != nil && len(c.Peers()) == 1
	})
	expectHas(t, alice.ask(me, "voice who"), "Emma (me)")
	expectHas(t, alice.ask(me, "voice leave"), "Left voice")
	if b.Voice.Call(room.ID) != nil {
		t.Fatal("still in voice")
	}
}

// stallingSource hands over some packets, stalls, then hands over the rest:
// a live stream falling behind.
type stallingSource struct {
	before, after [][]byte
	stall         time.Duration
	i             int
}

func (s *stallingSource) Next() ([]byte, time.Duration, error) {
	all := append(append([][]byte{}, s.before...), s.after...)
	if s.i == len(s.before) {
		time.Sleep(s.stall)
	}
	if s.i >= len(all) {
		return nil, 0, io.EOF
	}
	p := all[s.i]
	s.i++
	return p, 20 * time.Millisecond, nil
}

// A source that stalls never stops the packets: the frames it misses go out
// as silence, so the app never shows the bot as buffering.
func TestPlaybackStall(t *testing.T) {
	srv := startServer(t)
	alice := newPerson(t, srv, "Alice")
	alice.createRoom("Den")
	b, _ := startVoiceBot(t, initBot(t, "Emma"))
	room, err := b.Join(context.Background(), alice.invite())
	if err != nil {
		t.Fatal(err)
	}
	ap := newPhone(t, alice)
	ap.join()
	eventually(t, "presence", func() bool { return len(b.Voice.Presence(room.ID)) == 1 })
	call, err := b.Voice.Join(context.Background(), room.ID)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "alice to connect", func() bool { return len(call.Peers()) == 1 })
	ap.drain()

	var before, after [][]byte
	for i := 0; i < 5; i++ {
		before = append(before, []byte{0xFC, 'B', byte(i)})
		after = append(after, []byte{0xFC, 'A', byte(i)})
	}
	pb := call.Play(&stallingSource{before: before, after: after, stall: 2500 * time.Millisecond})
	got := ap.receiveTimed(3500 * time.Millisecond)
	select {
	case <-pb.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the stalled clip never finished")
	}
	if len(got) < 150 {
		t.Fatalf("only %d packets in 3.5 s", len(got))
	}
	var worst time.Duration
	for i := 1; i < len(got); i++ {
		worst = max(worst, got[i].at.Sub(got[i-1].at))
	}
	if worst > 200*time.Millisecond {
		t.Fatalf("a %s gap with no packets while the source stalled", worst)
	}
	var clip [][]byte
	for _, r := range got {
		if !isSilence(r.p) {
			clip = append(clip, r.p)
		}
	}
	want := append(append([][]byte{}, before...), after...)
	if len(clip) != len(want) {
		t.Fatalf("got %d of the clip's %d packets", len(clip), len(want))
	}
	for i := range want {
		if !bytes.Equal(clip[i], want[i]) {
			t.Fatalf("packet %d: % x, want % x", i, clip[i], want[i])
		}
	}
}

// Paused: only silence goes out, nothing of the clip is lost, and Resume
// carries on where it stopped.
func TestPlaybackPause(t *testing.T) {
	srv := startServer(t)
	alice := newPerson(t, srv, "Alice")
	alice.createRoom("Den")
	b, _ := startVoiceBot(t, initBot(t, "Emma"))
	room, err := b.Join(context.Background(), alice.invite())
	if err != nil {
		t.Fatal(err)
	}
	ap := newPhone(t, alice)
	ap.join()
	eventually(t, "presence", func() bool { return len(b.Voice.Presence(room.ID)) == 1 })
	call, err := b.Voice.Join(context.Background(), room.ID)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "alice to connect", func() bool { return len(call.Peers()) == 1 })
	var want [][]byte
	for i := 0; i < 40; i++ {
		want = append(want, []byte{0xFC, 'P', byte(i)})
	}
	ap.drain()
	pb := call.Play(audio.Packets(want))
	time.Sleep(200 * time.Millisecond)
	pb.Pause()
	if !pb.Paused() {
		t.Fatal("not paused")
	}
	time.Sleep(100 * time.Millisecond) // what was already in flight
	ap.drain()
	for _, p := range ap.receive(700 * time.Millisecond) {
		if !isSilence(p) {
			t.Fatalf("clip audio while paused: % x", p)
		}
	}
	select {
	case <-pb.Done():
		t.Fatal("a paused playback ended")
	default:
	}
	pb.Resume()
	<-pb.Done()
	if pb.Err() != nil {
		t.Fatal(pb.Err())
	}
}
