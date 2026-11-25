package bot

import (
	"context"
	"errors"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/canavan-a/super-chat/shared/crypto"
	"github.com/canavan-a/super-chat/shared/wire"
)

// Voice: every room has a voice room, a WebRTC mesh of up to 8 people that
// the server knows nothing about beyond relaying sealed signaling boxes
// (docs/protocol.md, "Voice rooms"). The bot can see who's in one without
// joining, and join to push its own audio. It never receives anyone's
// audio: its connections are send-only, and it tells the room it can't hear.

// The app's timings (app/src/call/engine.ts).
const (
	maxVoicePeers = 7 // so at most 8 people
	beatEvery     = 15 * time.Second
	presenceFor   = 40 * time.Second
)

// DefaultICEServers is the app's default: a public STUN server.
var DefaultICEServers = []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}}

// ErrVoiceFull means the voice room already has 8 people.
var ErrVoiceFull = errors.New("the voice room is full (8/8)")

// VoiceSession is one person (one device) in a room's voice.
type VoiceSession struct {
	Member string
	Sid    string // per voice session: one person on two devices is two sessions
	Name   string
	Muted  bool
	Deaf   bool // sound off
}

// Voice is the bot's voice side: b.Voice.
type Voice struct {
	b *Bot
}

// Presence is who's in a room's voice, other than the bot. It works without
// joining: the bot asks when it connects, and everyone in voice says so
// every 15 s. Someone not heard from for 40 s has gone.
func (v *Voice) Presence(roomID string) []VoiceSession {
	r := v.b.room(roomID)
	if r == nil {
		return nil
	}
	return r.presenceNow()
}

// Join joins a room's voice. Joining one the bot is already in returns that
// call. A bot can be in the voice of many rooms at once (a phone can't).
func (v *Voice) Join(ctx context.Context, roomID string) (*Call, error) {
	r := v.b.room(roomID)
	if r == nil {
		return nil, errors.New("the bot isn't in that room")
	}
	return r.joinVoice(ctx)
}

// Call is the bot's call in a room, or nil when it isn't in its voice.
func (v *Voice) Call(roomID string) *Call {
	r := v.b.room(roomID)
	if r == nil {
		return nil
	}
	r.vmu.Lock()
	defer r.vmu.Unlock()
	return r.call
}

// ---- hooks ----

// VoiceHooks are the voice lifecycle callbacks.
type voiceHooks struct {
	presence   []func(ctx context.Context, roomID string, before, after []VoiceSession)
	joined     []func(ctx context.Context, c *Call)
	left       []func(ctx context.Context, roomID, why string)
	peerJoined []func(ctx context.Context, c *Call, s VoiceSession)
	peerLeft   []func(ctx context.Context, c *Call, s VoiceSession)
}

// OnVoicePresence runs when someone joins or leaves a room's voice, times
// out, or changes mute or sound off (whether or not the bot is in it).
func (b *Bot) OnVoicePresence(fn func(ctx context.Context, roomID string, before, after []VoiceSession)) {
	b.hmu.Lock()
	defer b.hmu.Unlock()
	b.voiceHooks.presence = append(b.voiceHooks.presence, fn)
}

// OnVoiceJoined runs when the bot has joined a room's voice.
func (b *Bot) OnVoiceJoined(fn func(ctx context.Context, c *Call)) {
	b.hmu.Lock()
	defer b.hmu.Unlock()
	b.voiceHooks.joined = append(b.voiceHooks.joined, fn)
}

// OnVoiceLeft runs when the bot's call ends: it left, it was removed from
// the room, or the bot is shutting down.
func (b *Bot) OnVoiceLeft(fn func(ctx context.Context, roomID, why string)) {
	b.hmu.Lock()
	defer b.hmu.Unlock()
	b.voiceHooks.left = append(b.voiceHooks.left, fn)
}

// OnVoicePeerJoined runs when someone's connection to the bot comes up.
func (b *Bot) OnVoicePeerJoined(fn func(ctx context.Context, c *Call, s VoiceSession)) {
	b.hmu.Lock()
	defer b.hmu.Unlock()
	b.voiceHooks.peerJoined = append(b.voiceHooks.peerJoined, fn)
}

// OnVoicePeerLeft runs when someone the bot was connected to leaves or drops.
func (b *Bot) OnVoicePeerLeft(fn func(ctx context.Context, c *Call, s VoiceSession)) {
	b.hmu.Lock()
	defer b.hmu.Unlock()
	b.voiceHooks.peerLeft = append(b.voiceHooks.peerLeft, fn)
}

func (b *Bot) hooks() voiceHooks {
	b.hmu.RLock()
	defer b.hmu.RUnlock()
	h := b.voiceHooks
	h.presence = append(h.presence[:0:0], h.presence...)
	h.joined = append(h.joined[:0:0], h.joined...)
	h.left = append(h.left[:0:0], h.left...)
	h.peerJoined = append(h.peerJoined[:0:0], h.peerJoined...)
	h.peerLeft = append(h.peerLeft[:0:0], h.peerLeft...)
	return h
}

// ---- keys for signaling ----

// voiceKeys is a snapshot of the room's epoch keys, so signaling never waits
// behind a sync holding r.mu over the network.
type voiceKeys struct {
	epoch int64
	keys  map[int64][]byte
}

// publishKeys refreshes the snapshot. Holds r.mu.
func (r *room) publishKeys() {
	ks := make(map[int64][]byte, len(r.keys))
	for n, k := range r.keys {
		ks[n] = k
	}
	r.vkeys.Store(&voiceKeys{epoch: r.rep.State.Epoch, keys: ks})
}

// sendSignal seals a signal under the room's current key and relays it
// (to "" broadcasts). Dropped while disconnected: the app re-sends what
// matters, and so do we (beats, restarts).
func (r *room) sendSignal(to string, s crypto.Signal) {
	vk := r.vkeys.Load()
	if vk == nil {
		return
	}
	key, ok := vk.keys[vk.epoch]
	if !ok {
		return
	}
	box, err := crypto.SealSignal(r.me, r.id, vk.epoch, key, to, s, r.b.now().UnixMilli())
	if err != nil {
		return
	}
	_ = r.srv.sendRTC(r.id, to, box)
}

// ---- presence ----

type presenceEntry struct {
	VoiceSession
	expires time.Time
}

// onRTC opens a signaling box and hands it to presence and the call. Runs
// on the WebSocket's goroutine: quick, and never waits on r.mu.
func (r *room) onRTC(m *wire.ServerWS) {
	if m.From == "" || m.Box == "" || m.From == r.me.ID {
		return
	}
	if m.To != "" && m.To != r.me.ID {
		return
	}
	epoch, err := crypto.SignalEpoch(m.Box)
	if err != nil {
		return
	}
	vk := r.vkeys.Load()
	if vk == nil || vk.keys[epoch] == nil {
		// A key we don't hold yet: the room was re-keyed. Catch up; the
		// sender's next beat or restart gets through.
		go r.enqueue(r.refresh)
		return
	}
	s, _, err := crypto.OpenSignal(r.id, m.From, m.To, m.Box, vk.keys[epoch], r.b.now().UnixMilli())
	if err != nil {
		return // forged, stale, or not for us
	}
	r.updatePresence(m.From, s)
	r.vmu.Lock()
	c := r.call
	r.vmu.Unlock()
	if c != nil {
		c.post(event{kind: evSignal, from: m.From, sig: s})
	}
}

func (r *room) updatePresence(from string, s *crypto.Signal) {
	id := from + ":" + s.Sid
	r.vmu.Lock()
	before := r.presenceLocked()
	switch s.K {
	case crypto.SigBeat, crypto.SigJoin, crypto.SigHere:
		if r.presence == nil {
			r.presence = map[string]*presenceEntry{}
		}
		r.presence[id] = &presenceEntry{
			VoiceSession: VoiceSession{Member: from, Sid: s.Sid, Muted: s.Muted, Deaf: s.Deaf},
			expires:      r.b.now().Add(presenceFor),
		}
	case crypto.SigLeave:
		delete(r.presence, id)
	default:
		r.vmu.Unlock()
		return
	}
	after := r.presenceLocked()
	r.vmu.Unlock()
	r.firePresence(before, after)
}

// expirePresence drops whoever hasn't been heard from for 40 s.
func (r *room) expirePresence() {
	r.vmu.Lock()
	before := r.presenceLocked()
	now := r.b.now()
	for id, p := range r.presence {
		if now.After(p.expires) {
			delete(r.presence, id)
		}
	}
	after := r.presenceLocked()
	r.vmu.Unlock()
	r.firePresence(before, after)
}

// presenceLocked is who's in voice now, sorted. Holds r.vmu.
func (r *room) presenceLocked() []VoiceSession {
	now := r.b.now()
	out := make([]VoiceSession, 0, len(r.presence))
	for _, p := range r.presence {
		if now.Before(p.expires) {
			s := p.VoiceSession
			s.Name = r.nameOf(s.Member)
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Member != out[j].Member {
			return out[i].Member < out[j].Member
		}
		return out[i].Sid < out[j].Sid
	})
	return out
}

func (r *room) presenceNow() []VoiceSession {
	r.vmu.Lock()
	defer r.vmu.Unlock()
	return r.presenceLocked()
}

func (r *room) firePresence(before, after []VoiceSession) {
	if samePresence(before, after) {
		return
	}
	for _, h := range r.b.hooks().presence {
		r.b.safely("OnVoicePresence", func() error { h(r.ctx, r.id, before, after); return nil })
	}
}

func samePresence(a, b []VoiceSession) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Member != b[i].Member || a[i].Sid != b[i].Sid || a[i].Muted != b[i].Muted || a[i].Deaf != b[i].Deaf {
			return false
		}
	}
	return true
}

// nameOf reads a display name without waiting on r.mu (the view pointer is
// swapped whole, never edited in place).
func (r *room) nameOf(member string) string {
	if v := r.viewSnap.Load(); v != nil {
		return v.Names[member]
	}
	return ""
}

// probe asks who's in voice: each answers with a beat straight to us.
func (r *room) probe() {
	r.sendSignal("", crypto.Signal{Sid: r.b.voiceSid, K: crypto.SigProbe})
}

// voiceTicker expires presence every few seconds, for every room.
func (b *Bot) voiceTicker(ctx context.Context) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			b.mu.Lock()
			rooms := make([]*room, 0, len(b.rooms))
			for _, r := range b.rooms {
				rooms = append(rooms, r)
			}
			b.mu.Unlock()
			for _, r := range rooms {
				r.expirePresence()
			}
		}
	}
}

// sendRTC relays a box over the server's WebSocket, if it's connected.
func (s *server) sendRTC(roomID, to, box string) error {
	s.mu.Lock()
	c := s.conn
	s.mu.Unlock()
	if c == nil {
		return errors.New("not connected")
	}
	return c.SendRTC(roomID, to, box)
}

// roomVoice is the voice state a room carries.
type roomVoice struct {
	vmu      sync.Mutex // presence and call
	presence map[string]*presenceEntry
	call     *Call
	vkeys    atomic.Pointer[voiceKeys]
	viewSnap atomic.Pointer[crypto.RoomView]
}
