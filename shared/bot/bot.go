// Package bot is the Super Chat bot SDK. A bot is a process with its own
// Super Chat account: it joins rooms through invite links, reads every
// message, and answers the ones that tag it ("@Emma roll 2d6").
//
//	b, err := bot.New(bot.Config{DataDir: "/var/lib/mybot"})
//	b.Command("roll", bot.Anyone, "roll dice: roll 2d6", func(c *bot.Ctx) error {
//		return c.Reply("4")
//	})
//	err = b.Run(ctx)
//
// The account is made once with Init (or the stock CLI's init). Everything
// the protocol asks of a room member is handled here: verifying the room's
// log, opening keys, rotating them when someone leaves, keeping the bot's
// profile readable for people who join later, and catching up on whatever
// was said while the bot was down.
package bot

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/canavan-a/super-chat/shared/bot/internal/api"
	"github.com/canavan-a/super-chat/shared/bot/internal/store"
	"github.com/canavan-a/super-chat/shared/crypto"
)

// Config sets up a Bot.
type Config struct {
	// DataDir holds the bot's account and state (made with Init).
	DataDir string
	// EntropyFile, if set, is where the account secret is read from instead
	// of DataDir (for secrets managers).
	EntropyFile string
	// Logger defaults to slog.Default().
	Logger *slog.Logger
	// Now is the clock; for tests.
	Now func() time.Time
	// SendBurst and SendsPerSecond limit what the bot posts in one room, so a
	// handler stuck in a loop can't flood a chat: a burst of SendBurst, then
	// SendsPerSecond. Sends past the limit wait. Defaults: 10, then 1 a second.
	SendBurst      int
	SendsPerSecond float64
}

// Access says who may run a command.
type Access int

const (
	// Anyone in the room.
	Anyone Access = iota
	// Admin: only members who logged in with the bot's admin password (in
	// this room: member IDs are per room).
	Admin
)

type command struct {
	name  string
	who   Access
	usage string
	fn    func(*Ctx) error
}

// Bot is one bot account.
type Bot struct {
	cfg     Config
	log     *slog.Logger
	st      *store.Store
	entropy crypto.Entropy
	now     func() time.Time

	hmu       sync.RWMutex // the handlers below
	commands  map[string]*command
	onMessage []func(*Ctx) error
	onJoin    []func(context.Context, Room)
	onRemoved []func(context.Context, string)
	unknown   func(*Ctx) error

	mu        sync.Mutex
	name      string
	picture   []byte // the profile picture (JPEG); empty when removed
	pictureAt int64  // when it was set (ms); 0 if never
	rooms     map[string]*room
	servers   map[string]*server
	runCtx    context.Context // set while Run runs
}

// New opens the bot in cfg.DataDir.
func New(cfg Config) (*Bot, error) {
	if cfg.DataDir == "" {
		return nil, errors.New("bot: Config.DataDir is required")
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.SendBurst <= 0 {
		cfg.SendBurst = 10
	}
	if cfg.SendsPerSecond <= 0 {
		cfg.SendsPerSecond = 1
	}
	st, err := store.Open(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	e, err := st.LoadEntropy(cfg.EntropyFile)
	if err != nil {
		st.Close()
		return nil, err
	}
	name, _, err := st.Meta(metaName)
	if err != nil {
		st.Close()
		return nil, err
	}
	picture, _, err := st.Meta(metaPicture)
	if err != nil {
		st.Close()
		return nil, err
	}
	at, _, err := st.Meta(metaPictureAt)
	if err != nil {
		st.Close()
		return nil, err
	}
	pictureAt, _ := strconv.ParseInt(string(at), 10, 64)
	return &Bot{
		cfg:       cfg,
		log:       cfg.Logger,
		st:        st,
		entropy:   e,
		now:       cfg.Now,
		name:      string(name),
		picture:   picture,
		pictureAt: pictureAt,
		commands:  map[string]*command{},
		rooms:     map[string]*room{},
		servers:   map[string]*server{},
	}, nil
}

// Name is the bot's display name.
func (b *Bot) Name() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.name
}

// ---- handlers ----

// Command registers a command: the first word after the bot's mention. usage
// is shown by help. Registering a name again replaces it.
func (b *Bot) Command(name string, who Access, usage string, fn func(*Ctx) error) {
	b.hmu.Lock()
	defer b.hmu.Unlock()
	b.commands[strings.ToLower(name)] = &command{name: strings.ToLower(name), who: who, usage: usage, fn: fn}
}

// OnMessage runs fn for every message from someone else, tagged or not:
// text, files, edits and reactions alike (see Ctx.Message.Content.T).
func (b *Bot) OnMessage(fn func(*Ctx) error) {
	b.hmu.Lock()
	defer b.hmu.Unlock()
	b.onMessage = append(b.onMessage, fn)
}

// Unknown handles a mention whose first word isn't a command. By default
// the bot says it doesn't know it and points at help.
func (b *Bot) Unknown(fn func(*Ctx) error) {
	b.hmu.Lock()
	defer b.hmu.Unlock()
	b.unknown = fn
}

// OnJoin runs after the bot joins a room.
func (b *Bot) OnJoin(fn func(context.Context, Room)) {
	b.hmu.Lock()
	defer b.hmu.Unlock()
	b.onJoin = append(b.onJoin, fn)
}

// OnRemoved runs after the bot leaves a room or is removed from it, once
// it has forgotten the room. It's never rejoined on its own.
func (b *Bot) OnRemoved(fn func(ctx context.Context, roomID string)) {
	b.hmu.Lock()
	defer b.hmu.Unlock()
	b.onRemoved = append(b.onRemoved, fn)
}

// CommandInfo describes a registered command.
type CommandInfo struct {
	Name  string
	Who   Access
	Usage string
}

// Commands lists the registered commands, by name.
func (b *Bot) Commands() []CommandInfo {
	b.hmu.RLock()
	defer b.hmu.RUnlock()
	out := make([]CommandInfo, 0, len(b.commands))
	for _, c := range b.commands {
		out = append(out, CommandInfo{Name: c.name, Who: c.who, Usage: c.usage})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// ---- running ----

// Run connects to every room's server and handles messages until ctx ends.
func (b *Bot) Run(ctx context.Context) error {
	b.mu.Lock()
	if b.runCtx != nil {
		b.mu.Unlock()
		return errors.New("bot: already running")
	}
	b.runCtx = ctx
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		b.runCtx = nil
		b.mu.Unlock()
	}()

	rows, err := b.st.Rooms()
	if err != nil {
		return err
	}
	for _, row := range rows {
		if _, err := b.openRoom(ctx, row); err != nil {
			b.log.Error("couldn't load a room; skipping it", "room", row.ID, "err", err)
		}
	}
	stopControl, err := b.serveControl(ctx)
	if err != nil {
		return err
	}
	defer stopControl()
	b.log.Info("bot running", "name", b.Name(), "rooms", len(rows))
	<-ctx.Done()
	return nil
}

// Close releases the data directory. Call it after Run returns.
func (b *Bot) Close() error { return b.st.Close() }

// server is the connection to one server, made on first use.
func (b *Bot) serverFor(ctx context.Context, origin string) *server {
	b.mu.Lock()
	defer b.mu.Unlock()
	if s, ok := b.servers[origin]; ok {
		return s
	}
	s := &server{b: b, api: api.New(origin), log: b.log.With("server", origin)}
	b.servers[origin] = s
	go s.run(ctx)
	return s
}

// openRoom starts a room the store knows about: its log is replayed from
// disk and then brought up to date (and caught up) on its worker.
func (b *Bot) openRoom(ctx context.Context, row store.Room) (*room, error) {
	evs, err := b.st.Events(row.ID)
	if err != nil {
		return nil, err
	}
	rep, err := crypto.ReplayLog(row.ID, evs)
	if err != nil {
		// What's on disk doesn't verify any more: fetch it all again.
		b.log.Warn("the stored log doesn't verify; reloading it", "room", row.ID, "err", err)
		rep, _ = crypto.ReplayLog(row.ID, nil)
	}
	keys, err := b.st.Keys(row.ID)
	if err != nil {
		return nil, err
	}
	rctx, cancel := context.WithCancel(ctx)
	r := &room{
		b:       b,
		srv:     b.serverFor(ctx, row.Server),
		id:      row.ID,
		me:      crypto.MemberIdentity(b.entropy, row.ID),
		log:     b.log.With("room", row.ID),
		ctx:     rctx,
		cancel:  cancel,
		tasks:   make(chan func(), 64),
		rep:     rep,
		keys:    keys,
		lastPos: row.LastPos,
	}
	r.view = rep.View(keys)
	b.mu.Lock()
	b.rooms[r.id] = r
	b.mu.Unlock()
	go r.worker()
	r.srv.subscribe(r)
	return r, nil
}

func (b *Bot) forget(r *room) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.rooms[r.id] == r {
		delete(b.rooms, r.id)
	}
}

func (b *Bot) roomsOn(s *server) []*room {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []*room
	for _, r := range b.rooms {
		if r.srv == s {
			out = append(out, r)
		}
	}
	return out
}

func (b *Bot) room(id string) *room {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.rooms[id]
}

// Rooms is every room the bot is in.
func (b *Bot) Rooms() []Room {
	b.mu.Lock()
	rs := make([]*room, 0, len(b.rooms))
	for _, r := range b.rooms {
		rs = append(rs, r)
	}
	b.mu.Unlock()
	out := make([]Room, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.info())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// ---- joining ----

// Join joins a room through an invite link: the https form or the app's
// superchat:// form. Joining a room the bot is already in just returns it.
// The bot must be running.
func (b *Bot) Join(ctx context.Context, link string) (Room, error) {
	b.mu.Lock()
	runCtx := b.runCtx
	b.mu.Unlock()
	if runCtx == nil {
		return Room{}, errors.New("bot: not running")
	}
	l, err := crypto.ParseInviteLink(link)
	if err != nil {
		return Room{}, err
	}
	srv := b.serverFor(runCtx, strings.TrimRight(l.Server, "/"))
	var roomID string
	for attempt := 0; ; attempt++ {
		inv, err := srv.api.Invite(ctx, l.Invite)
		if api.IsStatus(err, 404) {
			return Room{}, errors.New("that invite doesn't exist, or was revoked")
		}
		if err != nil {
			return Room{}, err
		}
		roomID = inv.Room
		if r := b.room(roomID); r != nil {
			return r.info(), nil
		}
		rep, err := crypto.ReplayLog(inv.Room, api.Signed(inv.Events))
		if err != nil {
			return Room{}, fmt.Errorf("the room's log doesn't verify: %w", err)
		}
		me := crypto.MemberIdentity(b.entropy, inv.Room)
		if rep.State.IsMember(me.ID) {
			break // already in it (say, from another copy of this account)
		}
		preview, _ := crypto.OpenPreview(l.Secret, inv.Preview)
		batch, ep, err := crypto.Join(me, rep.State, l, preview, b.Name(), b.now().UnixMilli())
		if err != nil {
			return Room{}, err
		}
		_, err = srv.api.Join(ctx, l.Invite, me, batch)
		if api.IsStatus(err, 409) && attempt < 2 {
			continue // someone appended first: build on the new log
		}
		if err != nil {
			return Room{}, err
		}
		if err := b.st.PutKey(inv.Room, ep.N, ep.Key); err != nil {
			return Room{}, err
		}
		break
	}
	if err := b.st.AddRoom(roomID, srv.api.Server, b.now().UnixMilli()); err != nil {
		return Room{}, err
	}
	r, err := b.openRoom(runCtx, store.Room{ID: roomID, Server: srv.api.Server})
	if err != nil {
		return Room{}, err
	}
	if err := r.call(ctx, func() error {
		r.mu.Lock()
		defer r.mu.Unlock()
		return r.sync(r.ctx)
	}); err != nil {
		return Room{}, err
	}
	info := r.info()
	b.log.Info("joined a room", "room", roomID, "name", info.Name)
	b.fireJoin(context.WithoutCancel(ctx), info)
	return info, nil
}

// ---- running handlers ----

func (b *Bot) fireJoin(ctx context.Context, info Room) {
	b.hmu.RLock()
	hs := append([]func(context.Context, Room){}, b.onJoin...)
	b.hmu.RUnlock()
	for _, h := range hs {
		b.safely("OnJoin", func() error { h(ctx, info); return nil })
	}
}

func (b *Bot) fireRemoved(ctx context.Context, roomID string) {
	b.hmu.RLock()
	hs := append([]func(context.Context, string){}, b.onRemoved...)
	b.hmu.RUnlock()
	for _, h := range hs {
		b.safely("OnRemoved", func() error { h(ctx, roomID); return nil })
	}
}

// safely runs a handler, logging its error or panic instead of letting it
// take the bot down.
func (b *Bot) safely(what string, fn func() error) {
	defer func() {
		if p := recover(); p != nil {
			b.log.Error("a handler panicked", "handler", what, "panic", p, "stack", string(debug.Stack()))
		}
	}()
	if err := fn(); err != nil {
		b.log.Warn("a handler failed", "handler", what, "err", err)
	}
}
