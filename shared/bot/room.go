package bot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/canavan-a/super-chat/shared/bot/internal/api"
	"github.com/canavan-a/super-chat/shared/crypto"
	"github.com/canavan-a/super-chat/shared/proto"
	"github.com/canavan-a/super-chat/shared/wire"
)

// rotateEvery is how old a room key may get before an admin replaces it,
// as in the app: a key stolen today stops working soon.
const rotateEveryMs = 7 * 86400_000

// errGone means the bot is no longer in the room.
var errGone = errors.New("no longer in this room")

// room is one room the bot is in. A worker goroutine runs its tasks one at a
// time, in order; mu serializes everything that touches the log and keys, so
// a handler's reply (on the worker or any other goroutine) sees a consistent
// room.
type room struct {
	b   *Bot
	srv *server
	id  string
	me  *crypto.Member
	log *slog.Logger

	ctx    context.Context
	cancel context.CancelFunc
	tasks  chan func()

	mu      sync.Mutex
	rep     *crypto.Replay
	keys    map[int64][]byte
	view    *crypto.RoomView
	lastPos int64
	gone    bool

	limMu sync.Mutex // the send limiter
	lim   limiter

	roomVoice
	goneFlag atomic.Bool // removed from the room (readable without r.mu)
}

func (r *room) worker() {
	for {
		select {
		case t := <-r.tasks:
			t()
		case <-r.ctx.Done():
			return
		}
	}
}

// enqueue queues a task for the worker. Never call it from the worker itself.
func (r *room) enqueue(t func()) {
	select {
	case r.tasks <- t:
	case <-r.ctx.Done():
	}
}

// do runs fn on the worker and waits for it.
func (r *room) do(ctx context.Context, fn func() error) error {
	done := make(chan error, 1)
	r.enqueue(func() { done <- fn() })
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-r.ctx.Done():
		return errGone
	}
}

func (r *room) api() *api.Client { return r.srv.api }

// ---- the log and keys ----

// syncLog brings the log, keys and view up to date. Callers hold r.mu.
func (r *room) syncLog(ctx context.Context) error {
	if r.gone {
		return errGone
	}
	since := r.rep.State.NextSeq
	st, err := r.api().State(ctx, r.id, r.me, since)
	if api.IsStatus(err, http.StatusNotFound) {
		// The server's answer for "not yours": we were removed.
		r.removeLocked(ctx, "the server says the bot isn't a member any more")
		return errGone
	}
	if err != nil {
		return err
	}
	next, err := r.rep.Extend(api.Signed(st.Events))
	if err != nil {
		// Doesn't follow on from what we hold: start over from the whole log.
		full, ferr := r.api().State(ctx, r.id, r.me, 0)
		if ferr != nil {
			return ferr
		}
		if next, err = crypto.ReplayLog(r.id, api.Signed(full.Events)); err != nil {
			// The server is handing out a log that breaks the rules: keep
			// what we had, and don't act on anything it says.
			return fmt.Errorf("the room's log doesn't verify: %w", err)
		}
		if err := r.b.st.ReplaceEvents(r.id, next.Events); err != nil {
			return err
		}
	} else if added := next.Events[len(r.rep.Events):]; len(added) > 0 {
		if err := r.b.st.AddEvents(r.id, added); err != nil {
			return err
		}
	}
	r.rep = next
	if !next.State.IsMember(r.me.ID) {
		r.removeLocked(ctx, "removed from the room")
		return errGone
	}
	r.pruneAdmins()
	if err := r.loadKeys(ctx); err != nil {
		return err
	}
	r.view = r.rep.View(r.keys)
	r.viewSnap.Store(r.view)
	r.publishKeys()
	return nil
}

// loadKeys opens any envelopes for epochs we don't hold a key for yet.
func (r *room) loadKeys(ctx context.Context) error {
	if _, ok := r.keys[r.rep.State.Epoch]; ok {
		return nil
	}
	ks, err := r.api().Keys(ctx, r.id, r.me)
	if err != nil {
		return err
	}
	for _, env := range ks.Envelopes {
		if _, ok := r.keys[env.Epoch]; ok {
			continue
		}
		commit, ok := r.rep.Commits[env.Epoch]
		if !ok {
			continue
		}
		key, err := crypto.OpenEnvelope(r.me, r.id, env.Epoch, env.Sealed, commit)
		if err != nil {
			r.log.Warn("an epoch key didn't open", "epoch", env.Epoch, "err", err)
			continue
		}
		r.keys[env.Epoch] = key
		if err := r.b.st.PutKey(r.id, env.Epoch, key); err != nil {
			return err
		}
	}
	return nil
}

// sync is syncLog plus the duties of a member: rotate the key when someone
// left (or, as an admin, when it's a week old), and publish our profile
// under the current key so people who joined since can see our name.
func (r *room) sync(ctx context.Context) error {
	if err := r.syncLog(ctx); err != nil {
		return err
	}
	s := r.rep.State
	if s.PendingRotation && r.everyoneHasKeys() {
		if err := r.append(ctx, nil, rotatePending); err != nil {
			return fmt.Errorf("rotate the key: %w", err)
		}
	} else if s.Members[r.me.ID] == proto.RoleAdmin && r.b.now().UnixMilli()-r.lastEpochAt() > rotateEveryMs {
		if err := r.append(ctx, nil, rotateForce); err != nil {
			return fmt.Errorf("rotate the key: %w", err)
		}
	}
	return r.ensureProfile(ctx)
}

func (r *room) everyoneHasKeys() bool {
	for id := range r.rep.State.Members {
		if r.rep.State.Keys[id] == "" {
			return false
		}
	}
	return true
}

func (r *room) lastEpochAt() int64 {
	for i := len(r.rep.Events) - 1; i >= 0; i-- {
		if r.rep.Events[i].Kind == "epoch" {
			return r.rep.Events[i].Ts
		}
	}
	return 0
}

type rotation int

const (
	rotateNone    rotation = iota
	rotatePending          // only if a join, leave or kick left the key due
	rotateForce            // always
)

// append signs events on top of the latest log, optionally followed by a
// new key, and retries when someone else appended first. Callers hold r.mu.
func (r *room) append(ctx context.Context, build func(s *proto.State) []crypto.NewEvent, rot rotation) error {
	for attempt := 0; ; attempt++ {
		if attempt > 0 {
			if err := r.syncLog(ctx); err != nil {
				return err
			}
		}
		var evs []crypto.NewEvent
		if build != nil {
			if evs = build(r.rep.State); evs == nil {
				return nil // nothing to do any more
			}
		}
		now := r.b.now().UnixMilli()
		signed, s1, err := crypto.BuildEvents(r.me, r.rep.State, evs, now)
		if err != nil {
			return err
		}
		batch := &wire.Batch{Events: signed}
		var ep *crypto.Epoch
		if rot == rotateForce || (rot == rotatePending && s1.PendingRotation) {
			if !s1.IsMember(r.me.ID) {
				return nil
			}
			if ep, err = crypto.NewEpoch(s1, r.snapshot()); err != nil {
				return err
			}
			more, _, err := crypto.BuildEvents(r.me, s1, []crypto.NewEvent{ep.Event}, now)
			if err != nil {
				return err
			}
			batch.Events, batch.Envelopes = append(batch.Events, more...), ep.Envelopes
		}
		if len(batch.Events) == 0 {
			return nil
		}
		_, err = r.api().Append(ctx, r.id, r.me, batch)
		if api.IsStatus(err, http.StatusConflict) && attempt < 2 {
			continue
		}
		if err != nil {
			return err
		}
		if ep != nil {
			r.keys[ep.N] = ep.Key
			r.publishKeys()
			if err := r.b.st.PutKey(r.id, ep.N, ep.Key); err != nil {
				return err
			}
		}
		return r.syncLog(ctx)
	}
}

// snapshot is what a new key's epoch event carries for people who join
// later: the room's name, color and picture, and everyone's display names.
func (r *room) snapshot() crypto.Snapshot {
	s := crypto.Snapshot{Profiles: map[string]string{}}
	if v := r.view; v != nil {
		s.Name, s.Color = v.Name, v.Color
		for id, n := range v.Names {
			if r.rep.State.IsMember(id) {
				s.Profiles[id] = n
			}
		}
		if v.Picture != nil {
			s.Picture, _ = json.Marshal(v.Picture)
		}
	}
	s.Profiles[r.me.ID] = r.b.Name()
	return s
}

// ---- messages ----

// catchUp handles every message after the last one handled, in order.
// Pushes over the WebSocket only trigger this: the server drops pushes
// when a socket falls behind, so fetching is what guarantees nothing is
// skipped. Runs on the worker.
func (r *room) catchUp(ctx context.Context) error {
	for {
		r.mu.Lock()
		if r.gone {
			r.mu.Unlock()
			return errGone
		}
		after := r.lastPos
		msgs, err := r.api().Messages(ctx, r.id, r.me, after, api.MaxPage)
		if api.IsStatus(err, http.StatusNotFound) {
			r.removeLocked(ctx, "the server says the bot isn't a member any more")
			r.mu.Unlock()
			return errGone
		}
		r.mu.Unlock()
		if err != nil {
			return err
		}
		for i := range msgs {
			if err := r.handle(ctx, &msgs[i]); err != nil {
				return err
			}
		}
		if len(msgs) < api.MaxPage {
			return nil
		}
	}
}

// handle decrypts one message and hands it to the bot's handlers, then
// records it as handled: at least once, so a crash mid-handler means it's
// handled again on restart rather than lost.
func (r *room) handle(ctx context.Context, m *wire.Message) error {
	r.mu.Lock()
	if r.gone {
		r.mu.Unlock()
		return errGone
	}
	if m.Pos <= r.lastPos {
		r.mu.Unlock()
		return nil
	}
	var in *incoming
	if m.Sender != r.me.ID {
		in = r.open(ctx, m)
	}
	r.mu.Unlock()

	if in != nil {
		r.b.dispatch(ctx, in)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if m.Pos > r.lastPos {
		r.lastPos = m.Pos
		if err := r.b.st.SetLastPos(r.id, m.Pos); err != nil {
			return err
		}
	}
	return nil
}

// open decrypts a message; nil if it can't be read (logged). Holds r.mu.
func (r *room) open(ctx context.Context, m *wire.Message) *incoming {
	key, ok := r.keys[m.Epoch]
	if !ok || r.view.Member(m.Sender) == nil {
		// A key or member we haven't seen yet: the log moved on.
		if err := r.syncLog(ctx); err != nil {
			r.log.Warn("couldn't catch up the room's log", "err", err)
			return nil
		}
		key, ok = r.keys[m.Epoch]
	}
	if !ok {
		r.log.Warn("a message under a key the bot doesn't hold", "epoch", m.Epoch)
		return nil
	}
	d, err := crypto.DecryptMessage(m, key)
	if err != nil {
		r.log.Warn("a message didn't open", "id", m.ID, "err", err)
		return nil
	}
	return &incoming{room: r, msg: m, content: d, info: r.infoLocked()}
}

// send encrypts and posts a message under the current key, picking up a new
// key and trying again if the room was re-keyed meanwhile.
func (r *room) send(ctx context.Context, c crypto.Content, blobs []string) (string, error) {
	if err := r.wait(ctx); err != nil {
		return "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	id := proto.NewID()
	for attempt := 0; ; attempt++ {
		if r.gone {
			return "", errGone
		}
		epoch := r.rep.State.Epoch
		key, ok := r.keys[epoch]
		if !ok {
			if err := r.syncLog(ctx); err != nil {
				return "", err
			}
			if key, ok = r.keys[r.rep.State.Epoch]; !ok {
				return "", errors.New("the bot doesn't hold the room's current key yet")
			}
			epoch = r.rep.State.Epoch
		}
		ct, kind, err := crypto.EncryptMessage(r.me, r.id, epoch, key, c, id, r.b.now().UnixMilli())
		if err != nil {
			return "", err
		}
		_, err = r.api().PostMessage(ctx, r.id, r.me, &wire.PostMessage{ID: id, Epoch: epoch, Kind: kind, Ct: ct, Blobs: blobs})
		if api.IsStatus(err, http.StatusConflict) && attempt < 2 {
			// Stale epoch: the room was re-keyed.
			if err := r.syncLog(ctx); err != nil {
				return "", err
			}
			continue
		}
		if api.IsStatus(err, http.StatusNotFound) {
			r.removeLocked(ctx, "the server says the bot isn't a member any more")
			return "", errGone
		}
		return id, err
	}
}

// ---- leaving ----

// removeLocked forgets the room: the bot was kicked, left, or the server says
// it isn't a member. It never rejoins on its own. Holds r.mu.
func (r *room) removeLocked(ctx context.Context, why string) {
	if r.gone {
		return
	}
	r.gone = true
	r.goneFlag.Store(true)
	r.log.Info("left the room", "why", why)
	if err := r.b.st.DeleteRoom(r.id); err != nil {
		r.log.Error("couldn't forget the room", "err", err)
	}
	r.b.forget(r)
	r.cancel()
	go r.b.fireRemoved(context.WithoutCancel(ctx), r.id)
}

// ---- what handlers see ----

func (r *room) infoLocked() Room {
	info := Room{ID: r.id, Server: r.srv.api.Server}
	if v := r.view; v != nil {
		info.Name = v.Name
		for _, m := range v.Members {
			info.Members = append(info.Members, Member{ID: m.ID, Name: m.Name, Role: m.Role})
		}
	}
	return info
}

func (r *room) info() Room {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.infoLocked()
}
