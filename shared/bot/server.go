package bot

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/canavan-a/super-chat/shared/bot/internal/api"
	"github.com/canavan-a/super-chat/shared/wire"
)

// recheckEvery is a safety net under the pushes: every room is synced and
// caught up this often even if nothing arrived.
const recheckEvery = 5 * time.Minute

// server is the bot's WebSocket to one server, reconnecting with backoff.
type server struct {
	b   *Bot
	api *api.Client
	log *slog.Logger

	mu   sync.Mutex
	conn *api.Conn // nil while disconnected
}

func (s *server) run(ctx context.Context) {
	go s.recheck(ctx)
	backoff := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := s.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		s.log.Warn("disconnected; reconnecting", "err", err, "in", backoff)
		// Jitter, so many bots on one server don't all come back at once.
		wait := backoff/2 + time.Duration(rand.Int64N(int64(backoff)))
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return
		}
		backoff = min(backoff*2, time.Minute)
	}
}

// session is one connection: subscribe to every room on this server, catch
// each up, then follow pushes until the connection drops.
func (s *server) session(ctx context.Context) error {
	conn, err := s.api.Dial(ctx)
	if err != nil {
		return err
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
		case <-done:
		}
		conn.Close()
	}()

	s.mu.Lock()
	s.conn = conn
	rooms := s.b.roomsOn(s)
	subs := make([]api.Subscription, len(rooms))
	for i, r := range rooms {
		subs[i] = api.Subscription{Room: r.id, Signer: r.me}
	}
	err = conn.Subscribe(subs)
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.conn == conn {
			s.conn = nil
		}
		s.mu.Unlock()
	}()
	if err != nil {
		return err
	}
	// Queued before any push is read, so a push can never get ahead of
	// what was missed while disconnected.
	for _, r := range rooms {
		r.enqueue(r.refresh)
	}
	// A call that outlived the connection says it's here again, so anyone who
	// joined meanwhile connects (as the app re-sends its join).
	for _, r := range rooms {
		r.vmu.Lock()
		c := r.call
		r.vmu.Unlock()
		if c != nil {
			c.post(event{kind: evRejoin})
		}
	}
	s.log.Info("connected", "rooms", len(rooms))

	for {
		m, err := conn.Read()
		if err != nil {
			return err
		}
		s.dispatch(m)
	}
}

func (s *server) dispatch(m *wire.ServerWS) {
	if m.Type == wire.WSSubscribed {
		// A room the server won't subscribe us to: find out why (a sync
		// notices if we're no longer a member).
		for _, id := range m.Rejected {
			if r := s.b.room(id); r != nil {
				r.enqueue(r.refresh)
			}
		}
		return
	}
	r := s.b.room(m.Room)
	if r == nil {
		return
	}
	switch m.Type {
	case wire.WSRTC:
		r.onRTC(m)
	case wire.WSEvent:
		r.enqueue(func() { r.locked(r.sync) })
	case wire.WSMessage:
		// Only a hint: fetch everything after the last message handled.
		r.enqueue(func() {
			r.mu.Lock()
			behind := m.Message != nil && m.Message.Pos > r.lastPos
			r.mu.Unlock()
			if behind {
				if err := r.catchUp(r.ctx); err != nil && err != errGone {
					r.log.Warn("couldn't catch up", "err", err)
				}
			}
		})
	case wire.WSRemoved:
		r.enqueue(func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.removeLocked(r.ctx, "removed from the room")
		})
	}
}

// subscribe asks for a room's pushes, if connected, and catches it up. When
// disconnected, the next session does both.
func (s *server) subscribe(r *room) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil {
		return
	}
	if err := s.conn.Subscribe([]api.Subscription{{Room: r.id, Signer: r.me}}); err != nil {
		s.log.Warn("couldn't subscribe to a room", "room", r.id, "err", err)
		return
	}
	go r.enqueue(r.refresh)
}

func (s *server) recheck(ctx context.Context) {
	t := time.NewTicker(recheckEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, r := range s.b.roomsOn(s) {
				r.enqueue(r.refresh)
			}
		}
	}
}

// refresh syncs the room (log, keys, member duties) and catches up its
// messages. Runs on the worker.
func (r *room) refresh() {
	r.locked(r.sync)
	if err := r.catchUp(r.ctx); err != nil && err != errGone {
		r.log.Warn("couldn't catch up", "err", err)
	}
	// Ask who's in voice, rather than waiting up to 15 s for their beats.
	if !r.goneFlag.Load() {
		r.probe()
	}
}

// locked runs fn holding r.mu, logging its error.
func (r *room) locked(fn func(context.Context) error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := fn(r.ctx); err != nil && err != errGone {
		r.log.Warn("couldn't sync the room", "err", err)
	}
}
