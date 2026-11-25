package bot

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/canavan-a/super-chat/shared/bot/audio"
	"github.com/canavan-a/super-chat/shared/crypto"
)

// The app's reconnect timings (app/src/call/engine.ts).
var restartDelays = []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second}

const (
	disconnectGrace  = 5 * time.Second
	answererGiveUp   = 30 * time.Second
	playbackLagReset = 200 * time.Millisecond
)

// Call is the bot in a room's voice. It sends one audio track to everyone
// in the mesh and receives nothing.
type Call struct {
	r     *room
	sid   string
	api   *webrtc.API
	cfg   webrtc.Configuration
	track *webrtc.TrackLocalStaticSample

	ctx    context.Context
	cancel context.CancelFunc
	events chan event
	done   chan struct{}
	why    string // why it ended, once done

	peers map[string]*peer // owned by the loop goroutine

	smu     sync.Mutex // the snapshot below
	snap    []VoiceSession
	muted   atomic.Bool
	playing atomic.Pointer[Playback]
}

type peer struct {
	id, member, sid string
	pc              *webrtc.PeerConnection
	offerer         bool // we made the offer, so ICE restarts are ours
	remoteSet       bool
	pending         []webrtc.ICECandidateInit
	muted, deaf     bool
	state           webrtc.PeerConnectionState
	everConnected   bool
	lastHeard       time.Time
	downSince       time.Time // zero while connected
	restarts        int
	nextRestart     time.Time
}

type evKind int

const (
	evSignal evKind = iota
	evConn
	evRejoin
	evLeave
)

type event struct {
	kind  evKind
	from  string
	sig   *crypto.Signal
	peer  *peer
	state webrtc.PeerConnectionState
	why   string
}

// joinVoice puts the bot in the room's voice.
func (r *room) joinVoice(ctx context.Context) (*Call, error) {
	r.vmu.Lock()
	if r.call != nil {
		c := r.call
		r.vmu.Unlock()
		return c, nil
	}
	if len(r.presenceLocked()) > maxVoicePeers {
		r.vmu.Unlock()
		return nil, ErrVoiceFull
	}
	c, err := r.newCall()
	if err != nil {
		r.vmu.Unlock()
		return nil, err
	}
	r.call = c
	r.vmu.Unlock()

	go c.loop()
	go c.audioLoop()
	c.sendJoin()
	r.log.Info("joined voice")
	// The "… joined the call" line in the chat, as the app posts it.
	go func() {
		if _, err := r.send(c.ctx, crypto.Content{T: crypto.TypeCall, Action: "join"}, nil); err != nil {
			r.log.Warn("couldn't post the call notice", "err", err)
		}
	}()
	for _, h := range r.b.hooks().joined {
		go r.b.safely("OnVoiceJoined", func() error { h(context.WithoutCancel(ctx), c); return nil })
	}
	return c, nil
}

func (r *room) newCall() (*Call, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"},
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	reg := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, reg); err != nil {
		return nil, err
	}
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", "superchat-bot")
	if err != nil {
		return nil, err
	}
	ice := r.b.cfg.ICEServers
	if ice == nil {
		ice = DefaultICEServers
	}
	ctx, cancel := context.WithCancel(r.ctx)
	return &Call{
		r:      r,
		sid:    crypto.B64.EncodeToString(crypto.RandomBytes(9)),
		api:    webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(reg)),
		cfg:    webrtc.Configuration{ICEServers: ice},
		track:  track,
		ctx:    ctx,
		cancel: cancel,
		events: make(chan event, 256),
		done:   make(chan struct{}),
		peers:  map[string]*peer{},
	}, nil
}

// ---- the public side ----

// RoomID is the room this call is in.
func (c *Call) RoomID() string { return c.r.id }

// Peers is who the bot is connected to (or connecting to) in the call.
func (c *Call) Peers() []VoiceSession {
	c.smu.Lock()
	defer c.smu.Unlock()
	return append([]VoiceSession(nil), c.snap...)
}

// SetMuted mutes the bot (it sends silence, and the room shows it muted).
func (c *Call) SetMuted(muted bool) {
	if c.muted.Swap(muted) != muted {
		c.beat("", "")
	}
}

// Muted reports whether the bot is muted.
func (c *Call) Muted() bool { return c.muted.Load() }

// Play plays a source to everyone in the call, replacing whatever was
// playing. Between sources the bot sends silence.
//
// The source is read ahead on a goroutine of its own, into a buffer of about
// a second. A source that falls behind (a live stream stalling) never holds
// up what's sent: those frames go out as silence and listeners hear a gap,
// but packets keep flowing, so no app shows the bot as buffering. (A Next
// that blocks for ever can only be ended by its source: close the reader.)
func (c *Call) Play(src audio.Source) *Playback {
	pb := &Playback{
		src: src, c: c, done: make(chan struct{}),
		packets: make(chan frame, playAhead), stop: make(chan struct{}),
	}
	if c.ctx.Err() != nil {
		pb.finish(ErrCallEnded)
		return pb
	}
	go pb.read()
	if old := c.playing.Swap(pb); old != nil {
		old.finish(ErrReplaced)
	}
	return pb
}

// playAhead is how many packets a Playback reads ahead (~1 s of 20 ms frames).
const playAhead = 50

type frame struct {
	packet []byte
	dur    time.Duration
}

// read fills the buffer from the source until it ends, or the playback does.
func (p *Playback) read() {
	defer close(p.packets)
	for {
		pkt, dur, err := p.src.Next()
		if err != nil {
			p.srcErr = err // seen by the audio loop after the close
			return
		}
		select {
		case p.packets <- frame{pkt, dur}:
		case <-p.stop:
			return
		}
	}
}

// Leave leaves the call.
func (c *Call) Leave(ctx context.Context) error {
	c.post(event{kind: evLeave, why: "left"})
	select {
	case <-c.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Done is closed when the call has ended; Why says why.
func (c *Call) Done() <-chan struct{} { return c.done }

// Why is why the call ended ("left", "removed from the room", "the bot
// stopped", or "the voice room is full"), once Done is closed.
func (c *Call) Why() string {
	<-c.done
	return c.why
}

// ErrReplaced and ErrCallEnded end a Playback early.
var (
	ErrReplaced  = errors.New("replaced by another Play")
	ErrCallEnded = errors.New("the call ended")
)

// Playback is one source playing.
type Playback struct {
	src     audio.Source
	c       *Call
	packets chan frame    // read ahead; closed when the source ends
	srcErr  error         // the source's last error, set before packets closes
	stop    chan struct{} // closed when the playback ends, to stop the reader
	done    chan struct{}
	once    sync.Once
	err     error
}

// Done is closed once the source has played to its end, was stopped or
// replaced, or the call ended.
func (p *Playback) Done() <-chan struct{} { return p.done }

// Err is why it ended (after Done): nil when it played to the end or was
// stopped, ErrReplaced, ErrCallEnded, or the source's own error.
func (p *Playback) Err() error {
	<-p.done
	return p.err
}

// Stop stops it; the bot goes back to silence.
func (p *Playback) Stop() {
	p.c.playing.CompareAndSwap(p, nil)
	p.finish(nil)
}

func (p *Playback) finish(err error) {
	p.once.Do(func() {
		if errors.Is(err, io.EOF) {
			err = nil
		}
		p.err = err
		close(p.stop)
		close(p.done)
	})
}

// ---- audio ----

// audioLoop sends a packet every frame for as long as the call lasts: what's
// playing, or silence. It never waits on a source: a frame that isn't read
// yet goes out as silence. Packets never stop, so listeners' apps never show
// the bot as stalled (they do after 2 s without any).
func (c *Call) audioLoop() {
	defer func() {
		if pb := c.playing.Swap(nil); pb != nil {
			pb.finish(ErrCallEnded)
		}
	}()
	t := time.NewTimer(0)
	defer t.Stop()
	next := time.Now()
	for {
		pkt, dur := audio.Silence, audio.SilenceDuration
		if pb := c.playing.Load(); pb != nil {
			select {
			case f, ok := <-pb.packets:
				if !ok {
					// The source ended (or failed): back to silence.
					c.playing.CompareAndSwap(pb, nil)
					pb.finish(pb.srcErr)
					break
				}
				dur = f.dur
				if !c.muted.Load() {
					pkt = f.packet
				}
			default:
				// Not read yet (the source is behind): silence this frame.
			}
		}
		_ = c.track.WriteSample(media.Sample{Data: pkt, Duration: dur})
		next = next.Add(dur)
		wait := time.Until(next)
		if wait < -playbackLagReset {
			next = time.Now() // fell well behind (a stall): don't rush to catch up
			wait = 0
		}
		t.Reset(max(wait, 0))
		select {
		case <-t.C:
		case <-c.ctx.Done():
			return
		}
	}
}

// ---- signaling ----

func (c *Call) post(e event) {
	select {
	case c.events <- e:
	case <-c.ctx.Done():
	}
}

func (c *Call) signal(to string, s crypto.Signal) {
	s.Sid = c.sid
	c.r.sendSignal(to, s)
}

func (c *Call) sendJoin() {
	c.signal("", crypto.Signal{K: crypto.SigJoin, Muted: c.muted.Load(), Deaf: true})
}

// beat says the bot is here: broadcast, or straight to one session. Always
// "sound off": the bot can't hear anyone.
func (c *Call) beat(to, toSid string) {
	c.signal(to, crypto.Signal{K: crypto.SigBeat, ToSid: toSid, Muted: c.muted.Load(), Deaf: true})
}

func (c *Call) loop() {
	beat := time.NewTicker(beatEvery)
	check := time.NewTicker(time.Second)
	defer beat.Stop()
	defer check.Stop()
	for {
		select {
		case e := <-c.events:
			switch e.kind {
			case evSignal:
				c.onSignal(e.from, e.sig)
			case evConn:
				c.onConn(e.peer, e.state)
			case evRejoin:
				c.sendJoin()
			case evLeave:
				c.end(e.why, true)
				return
			}
		case <-beat.C:
			c.beat("", "")
		case <-check.C:
			c.check()
		case <-c.r.ctx.Done():
			if c.r.goneFlag.Load() {
				c.end("removed from the room", false)
			} else {
				c.end("the bot stopped", true)
			}
			return
		}
	}
}

// onSignal follows the app's engine: whoever is already in voice answers a
// join with "here" and makes the offer; the joiner answers.
func (c *Call) onSignal(from string, s *crypto.Signal) {
	if s.K == crypto.SigProbe {
		c.beat(from, s.Sid)
		return
	}
	if s.ToSid != "" && s.ToSid != c.sid {
		return
	}
	if s.Sid == c.sid {
		return
	}
	id := from + ":" + s.Sid
	p := c.peers[id]
	if p != nil {
		p.lastHeard = time.Now()
	}
	switch s.K {
	case crypto.SigJoin:
		if p != nil {
			// They reconnected to the server with the same session.
			if p.offerer && p.state != webrtc.PeerConnectionStateConnected {
				c.restart(p)
			}
			c.beat(from, s.Sid)
			return
		}
		if len(c.peers) >= maxVoicePeers {
			c.signal(from, crypto.Signal{K: crypto.SigFull, ToSid: s.Sid})
			return
		}
		c.signal(from, crypto.Signal{K: crypto.SigHere, ToSid: s.Sid, Muted: c.muted.Load(), Deaf: true})
		if p = c.addPeer(from, s.Sid, true, s); p != nil {
			c.offer(p, false)
		}
	case crypto.SigHere:
		if p == nil && len(c.peers) < maxVoicePeers {
			c.addPeer(from, s.Sid, false, s)
		}
	case crypto.SigFull:
		if len(c.peers) == 0 {
			c.end(ErrVoiceFull.Error(), true)
		}
	case crypto.SigOffer:
		if p == nil {
			if len(c.peers) >= maxVoicePeers {
				c.signal(from, crypto.Signal{K: crypto.SigFull, ToSid: s.Sid})
				return
			}
			if p = c.addPeer(from, s.Sid, false, s); p == nil {
				return
			}
		}
		c.answer(p, s.SDP)
	case crypto.SigAnswer:
		if p != nil && p.offerer && s.SDP != "" {
			if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: s.SDP}); err != nil {
				c.r.log.Warn("a voice answer didn't apply", "err", err)
				return
			}
			p.remoteSet = true
			c.flushICE(p)
		}
	case crypto.SigICE:
		if p == nil || len(s.Cand) == 0 {
			return
		}
		var cand webrtc.ICECandidateInit
		if json.Unmarshal(s.Cand, &cand) != nil || cand.Candidate == "" {
			return
		}
		if p.remoteSet {
			_ = p.pc.AddICECandidate(cand)
		} else {
			p.pending = append(p.pending, cand)
		}
	case crypto.SigBeat:
		if p != nil {
			p.muted, p.deaf = s.Muted, s.Deaf
			c.publish()
		}
	case crypto.SigLeave:
		if p != nil {
			c.drop(p, "left")
		}
	}
}

// addPeer makes a connection that only sends: the transceiver is send-only
// before any remote offer is applied, so the answer says so and the other
// side never uploads its microphone to the bot.
func (c *Call) addPeer(member, sid string, offerer bool, s *crypto.Signal) *peer {
	pc, err := c.api.NewPeerConnection(c.cfg)
	if err != nil {
		c.r.log.Warn("couldn't make a voice connection", "err", err)
		return nil
	}
	tr, err := pc.AddTransceiverFromTrack(c.track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		_ = pc.Close()
		c.r.log.Warn("couldn't add the bot's audio", "err", err)
		return nil
	}
	// Read RTCP (receiver reports, NACKs) so the interceptors keep working.
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := tr.Sender().Read(buf); err != nil {
				return
			}
		}
	}()
	p := &peer{
		id: member + ":" + sid, member: member, sid: sid, pc: pc, offerer: offerer,
		muted: s.Muted, deaf: s.Deaf, lastHeard: time.Now(), downSince: time.Now(),
	}
	pc.OnICECandidate(func(cand *webrtc.ICECandidate) {
		if cand == nil {
			return
		}
		raw, err := json.Marshal(cand.ToJSON())
		if err != nil {
			return
		}
		c.signal(member, crypto.Signal{K: crypto.SigICE, ToSid: sid, Cand: raw})
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		c.post(event{kind: evConn, peer: p, state: st})
	})
	c.peers[p.id] = p
	c.publish()
	return p
}

func (c *Call) offer(p *peer, iceRestart bool) {
	o, err := p.pc.CreateOffer(&webrtc.OfferOptions{ICERestart: iceRestart})
	if err == nil {
		err = p.pc.SetLocalDescription(o)
	}
	if err != nil {
		c.r.log.Warn("couldn't make a voice offer", "err", err)
		return
	}
	c.signal(p.member, crypto.Signal{K: crypto.SigOffer, ToSid: p.sid, SDP: tuneSDP(o.SDP)})
}

func (c *Call) answer(p *peer, sdp string) {
	err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp})
	if err != nil {
		c.r.log.Warn("a voice offer didn't apply", "err", err)
		return
	}
	p.remoteSet = true
	c.flushICE(p)
	a, err := p.pc.CreateAnswer(nil)
	if err == nil {
		err = p.pc.SetLocalDescription(a)
	}
	if err != nil {
		c.r.log.Warn("couldn't answer a voice offer", "err", err)
		return
	}
	c.signal(p.member, crypto.Signal{K: crypto.SigAnswer, ToSid: p.sid, SDP: sendOnly(tuneSDP(a.SDP))})
}

func (c *Call) flushICE(p *peer) {
	for _, cand := range p.pending {
		_ = p.pc.AddICECandidate(cand)
	}
	p.pending = nil
}

func (c *Call) onConn(p *peer, st webrtc.PeerConnectionState) {
	if c.peers[p.id] != p {
		return // already dropped
	}
	p.state = st
	switch st {
	case webrtc.PeerConnectionStateConnected:
		first := !p.everConnected
		p.everConnected, p.downSince, p.restarts = true, time.Time{}, 0
		c.publish()
		if first {
			c.firePeer(true, p)
		}
	case webrtc.PeerConnectionStateDisconnected, webrtc.PeerConnectionStateFailed:
		if p.downSince.IsZero() {
			p.downSince = time.Now()
		}
		if p.offerer && p.nextRestart.IsZero() {
			grace := time.Duration(0)
			if st == webrtc.PeerConnectionStateDisconnected {
				grace = disconnectGrace // often recovers on its own
			}
			p.nextRestart = time.Now().Add(grace + restartDelays[0])
		}
	}
}

// check drops whoever went quiet and restarts ICE for connections that are
// down, as the app does: only the offerer restarts; the answerer waits.
func (c *Call) check() {
	now := time.Now()
	for _, p := range c.peers {
		if now.Sub(p.lastHeard) > presenceFor {
			c.drop(p, "timed out")
			continue
		}
		down := p.state == webrtc.PeerConnectionStateDisconnected || p.state == webrtc.PeerConnectionStateFailed
		if !down {
			continue
		}
		if !p.offerer {
			if now.Sub(p.downSince) > answererGiveUp {
				c.drop(p, "couldn't reconnect")
			}
			continue
		}
		if !p.nextRestart.IsZero() && now.After(p.nextRestart) {
			if p.restarts >= len(restartDelays) {
				c.drop(p, "couldn't reconnect")
				continue
			}
			d := restartDelays[p.restarts]
			p.restarts++
			c.offer(p, true)
			// If this attempt doesn't connect either, try again (or give up).
			p.nextRestart = now.Add(d*2 + disconnectGrace)
		}
	}
}

// restart restarts ICE right away (they just came back), resetting the attempts.
func (c *Call) restart(p *peer) {
	p.restarts = 0
	p.nextRestart = time.Time{}
	c.offer(p, true)
}

func (c *Call) drop(p *peer, why string) {
	delete(c.peers, p.id)
	go p.pc.Close() // its callbacks post here: never close from inside the loop's turn
	c.publish()
	c.r.log.Info("a voice peer went", "member", p.member, "why", why)
	if p.everConnected {
		c.firePeer(false, p)
	}
}

// end closes the call. announce sends the leave signal and the "left the
// call" line (not when the bot was removed from the room: it can't).
func (c *Call) end(why string, announce bool) {
	c.why = why
	if announce {
		c.signal("", crypto.Signal{K: crypto.SigLeave})
	}
	for _, p := range c.peers {
		go p.pc.Close()
	}
	c.peers = map[string]*peer{}
	c.publish()
	c.r.vmu.Lock()
	if c.r.call == c {
		c.r.call = nil
	}
	c.r.vmu.Unlock()
	c.cancel()
	close(c.done)
	c.r.log.Info("left voice", "why", why)
	if announce && !c.r.goneFlag.Load() {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_, _ = c.r.send(ctx, crypto.Content{T: crypto.TypeCall, Action: "leave"}, nil)
		}()
	}
	for _, h := range c.r.b.hooks().left {
		go c.r.b.safely("OnVoiceLeft", func() error { h(context.Background(), c.r.id, why); return nil })
	}
}

// publish refreshes what Peers returns.
func (c *Call) publish() {
	snap := make([]VoiceSession, 0, len(c.peers))
	for _, p := range c.peers {
		snap = append(snap, c.session(p))
	}
	sort.Slice(snap, func(i, j int) bool { return snap[i].Member+snap[i].Sid < snap[j].Member+snap[j].Sid })
	c.smu.Lock()
	c.snap = snap
	c.smu.Unlock()
}

func (c *Call) session(p *peer) VoiceSession {
	return VoiceSession{Member: p.member, Sid: p.sid, Name: c.r.nameOf(p.member), Muted: p.muted, Deaf: p.deaf}
}

func (c *Call) firePeer(joined bool, p *peer) {
	s := c.session(p)
	h := c.r.b.hooks()
	hs := h.peerLeft
	what := "OnVoicePeerLeft"
	if joined {
		hs, what = h.peerJoined, "OnVoicePeerJoined"
	}
	for _, fn := range hs {
		go c.r.b.safely(what, func() error { fn(context.Background(), c, s); return nil })
	}
}
