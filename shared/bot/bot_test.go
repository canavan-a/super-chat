package bot_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/canavan-a/super-chat/shared/bot"
	"github.com/canavan-a/super-chat/shared/bot/core"
	"github.com/canavan-a/super-chat/shared/bot/internal/api"
	"github.com/canavan-a/super-chat/shared/crypto"
	"github.com/canavan-a/super-chat/shared/proto"
	"github.com/canavan-a/super-chat/shared/wire"
)

// These tests run the bot against a real superchat-server, built from this
// repo, with people played by the same crypto the app uses.

var (
	serverOnce sync.Once
	serverURL  string
	serverErr  error
	serverStop func()
)

func TestMain(m *testing.M) {
	code := m.Run()
	if serverStop != nil {
		serverStop()
	}
	os.Exit(code)
}

func startServer(t *testing.T) string {
	t.Helper()
	serverOnce.Do(func() {
		dir, err := os.MkdirTemp("", "superchat-bot-test-")
		if err != nil {
			serverErr = err
			return
		}
		bin := filepath.Join(dir, "superchat-server")
		build := exec.Command("go", "build", "-o", bin, "./cmd/superchat-server")
		build.Dir = filepath.Join("..", "..", "server")
		build.Env = append(os.Environ(), "CGO_ENABLED=0")
		if out, err := build.CombinedOutput(); err != nil {
			serverErr = fmt.Errorf("build the server: %v\n%s", err, out)
			return
		}
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			serverErr = err
			return
		}
		addr := ln.Addr().String()
		ln.Close()
		cmd := exec.Command(bin)
		cmd.Env = append(os.Environ(), "SUPERCHAT_LISTEN_ADDR="+addr, "SUPERCHAT_DATA_DIR="+dir, "SUPERCHAT_STATIC_LISTEN_ADDR=127.0.0.1:0")
		if err := cmd.Start(); err != nil {
			serverErr = err
			return
		}
		serverStop = func() { _ = cmd.Process.Kill(); _ = cmd.Wait(); _ = os.RemoveAll(dir) }
		serverURL = "http://" + addr
		for i := 0; i < 100; i++ {
			if resp, err := http.Get(serverURL + "/health"); err == nil {
				resp.Body.Close()
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		serverErr = errors.New("the server didn't start")
	})
	if serverErr != nil {
		t.Fatal(serverErr)
	}
	return serverURL
}

// ---- a person, as the app would be ----

type person struct {
	t        *testing.T
	c        *api.Client
	e        crypto.Entropy
	name     string
	room     string
	roomName string
	me       *crypto.Member
	rep      *crypto.Replay
	keys     map[int64][]byte
}

func newPerson(t *testing.T, server, name string) *person {
	return &person{t: t, c: api.New(server), e: crypto.NewEntropy(), name: name, keys: map[int64][]byte{}}
}

func now() int64 { return time.Now().UnixMilli() }

func (p *person) must(err error) {
	p.t.Helper()
	if err != nil {
		p.t.Fatalf("%s: %v", p.name, err)
	}
}

func (p *person) createRoom(name string) {
	room, b, key, me, err := crypto.CreateRoom(p.e, crypto.RoomMeta{Name: name, Color: "#4C8BF5"}, p.name, 0, now())
	p.must(err)
	_, err = p.c.CreateRoom(context.Background(), me, b)
	p.must(err)
	p.room, p.me, p.keys[1], p.roomName = room, me, key, name
	p.refresh()
}

func (p *person) refresh() {
	p.t.Helper()
	st, err := p.c.State(context.Background(), p.room, p.me, 0)
	p.must(err)
	p.rep, err = crypto.ReplayLog(p.room, api.Signed(st.Events))
	p.must(err)
	ks, err := p.c.Keys(context.Background(), p.room, p.me)
	p.must(err)
	for _, env := range ks.Envelopes {
		if _, ok := p.keys[env.Epoch]; ok {
			continue
		}
		k, err := crypto.OpenEnvelope(p.me, p.room, env.Epoch, env.Sealed, p.rep.Commits[env.Epoch])
		p.must(err)
		p.keys[env.Epoch] = k
	}
}

func (p *person) invite() string {
	p.refresh()
	link, b, err := crypto.CreateInvite(p.me, p.rep.State, p.c.Server, crypto.InvitePreview{Name: p.roomName, Color: "#4C8BF5", Inviter: p.name}, 0, 0, now())
	p.must(err)
	_, err = p.c.Append(context.Background(), p.room, p.me, b)
	p.must(err)
	return link.String()
}

func (p *person) join(link string) {
	l, err := crypto.ParseInviteLink(link)
	p.must(err)
	inv, err := p.c.Invite(context.Background(), l.Invite)
	p.must(err)
	rep, err := crypto.ReplayLog(inv.Room, api.Signed(inv.Events))
	p.must(err)
	p.room, p.me = inv.Room, crypto.MemberIdentity(p.e, inv.Room)
	b, ep, err := crypto.Join(p.me, rep.State, l, nil, p.name, now())
	p.must(err)
	_, err = p.c.Join(context.Background(), l.Invite, p.me, b)
	p.must(err)
	p.keys[ep.N] = ep.Key
	p.refresh()
}

func (p *person) send(c crypto.Content) string {
	p.t.Helper()
	p.refresh()
	epoch := p.rep.State.Epoch
	id := proto.NewID()
	ct, kind, err := crypto.EncryptMessage(p.me, p.room, epoch, p.keys[epoch], c, id, now())
	p.must(err)
	_, err = p.c.PostMessage(context.Background(), p.room, p.me, &wire.PostMessage{ID: id, Epoch: epoch, Kind: kind, Ct: ct})
	p.must(err)
	return id
}

func (p *person) say(text string) string {
	return p.send(crypto.Content{T: crypto.TypeText, Body: text})
}

type seen struct {
	id, sender string
	c          crypto.Content
}

func (p *person) messages() []seen {
	p.t.Helper()
	p.refresh()
	msgs, err := p.c.Messages(context.Background(), p.room, p.me, 0, 200)
	p.must(err)
	var out []seen
	for i := range msgs {
		d, err := crypto.DecryptMessage(&msgs[i], p.keys[msgs[i].Epoch])
		p.must(err)
		out = append(out, seen{msgs[i].ID, msgs[i].Sender, d.Content})
	}
	return out
}

// repliesTo is the bot's replies to message id.
func (p *person) repliesTo(botID, id string) []seen {
	var out []seen
	for _, m := range p.messages() {
		if m.sender == botID && m.c.ReplyTo == id {
			out = append(out, m)
		}
	}
	return out
}

func (p *person) kick(target string) {
	p.refresh()
	signed, s1, err := crypto.BuildEvents(p.me, p.rep.State, []crypto.NewEvent{{Kind: "kick", Pub: proto.TargetPub{Target: target}}}, now())
	p.must(err)
	ep, err := crypto.NewEpoch(s1, nil)
	p.must(err)
	more, _, err := crypto.BuildEvents(p.me, s1, []crypto.NewEvent{ep.Event}, now())
	p.must(err)
	_, err = p.c.Append(context.Background(), p.room, p.me, &wire.Batch{Events: append(signed, more...), Envelopes: ep.Envelopes})
	p.must(err)
}

func (p *person) nameOf(id string) string {
	p.refresh()
	return p.rep.View(p.keys).Names[id]
}

func eventually(t *testing.T, what string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !fn() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// ---- the bot ----

type running struct {
	b      *bot.Bot
	stop   context.CancelFunc
	done   chan error
	events chan string
}

func initBot(t *testing.T, name string) string {
	dir, err := os.MkdirTemp("", "bot")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	if _, err := bot.Init(dir, bot.InitOptions{Name: name, Password: "hunter2"}); err != nil {
		t.Fatal(err)
	}
	return dir
}

func startBot(t *testing.T, dir string) *running {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if testing.Verbose() {
		log = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}
	b, err := bot.New(bot.Config{DataDir: dir, Logger: log})
	if err != nil {
		t.Fatal(err)
	}
	core.Register(b)
	r := &running{b: b, done: make(chan error, 1), events: make(chan string, 16)}
	b.OnJoin(func(_ context.Context, room bot.Room) { r.events <- "joined " + room.ID })
	b.OnRemoved(func(_ context.Context, id string) { r.events <- "removed " + id })
	ctx, stop := context.WithCancel(context.Background())
	r.stop = stop
	go func() { r.done <- b.Run(ctx) }()
	// Run is up once the control socket answers.
	eventually(t, "the bot to start", func() bool {
		_, err := bot.ControlRooms(dir)
		return err == nil
	})
	t.Cleanup(r.shutdown)
	return r
}

func (r *running) shutdown() {
	if r.stop == nil {
		return
	}
	r.stop()
	<-r.done
	r.b.Close()
	r.stop = nil
}

func (r *running) expect(t *testing.T, event string) {
	t.Helper()
	select {
	case got := <-r.events:
		if got != event {
			t.Fatalf("got event %q, want %q", got, event)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for %q", event)
	}
}

func botID(t *testing.T, room bot.Room, notID string) string {
	for _, m := range room.Members {
		if m.ID != notID {
			return m.ID
		}
	}
	t.Fatal("the bot isn't in the room")
	return ""
}

// ---- tests ----

func TestJoinReplyRestartKick(t *testing.T) {
	srv := startServer(t)
	alice := newPerson(t, srv, "Alice")
	alice.createRoom("Den")
	link := alice.invite()

	dir := initBot(t, "Emma")
	r := startBot(t, dir)

	// Join through the control socket, as `superchat-bot join <link>` does.
	room, err := bot.ControlJoin(dir, link)
	if err != nil {
		t.Fatal(err)
	}
	r.expect(t, "joined "+room.ID)
	if room.Name != "Den" || len(room.Members) != 2 {
		t.Fatalf("joined %+v", room)
	}
	me := botID(t, room, alice.me.ID)
	if got := alice.nameOf(me); got != "Emma" {
		t.Fatalf("alice sees the bot as %q", got)
	}
	// Joining again is a no-op.
	if again, err := bot.ControlJoin(dir, link); err != nil || again.ID != room.ID {
		t.Fatalf("join again: %+v %v", again, err)
	}

	// Tagged: a reply. Not tagged: nothing.
	q := alice.say("hey " + bot.Mention(me) + " help")
	alice.say("just chatting")
	eventually(t, "a reply to help", func() bool { return len(alice.repliesTo(me, q)) == 1 })
	if body := alice.repliesTo(me, q)[0].c.Body; !strings.Contains(body, "help: what I can do") {
		t.Fatalf("help said %q", body)
	}

	// An unknown command gets pointed at help; an edit of a tagged message
	// doesn't run anything again.
	u := alice.say(bot.Mention(me) + " dance")
	eventually(t, "a reply to an unknown command", func() bool { return len(alice.repliesTo(me, u)) == 1 })
	alice.send(crypto.Content{T: crypto.TypeEdit, Target: q, Body: "hey " + bot.Mention(me) + " help please"})

	// Down for a while: what was said meanwhile is answered once it's back,
	// exactly once, and not again after another restart.
	r.shutdown()
	missed := alice.say(bot.Mention(me) + " help")
	r = startBot(t, dir)
	eventually(t, "a reply to what was missed", func() bool { return len(alice.repliesTo(me, missed)) == 1 })
	r.shutdown()
	r = startBot(t, dir)
	time.Sleep(time.Second)
	if n := len(alice.repliesTo(me, missed)); n != 1 {
		t.Fatalf("%d replies to the missed message after a second restart", n)
	}
	if n := len(alice.repliesTo(me, q)); n != 1 {
		t.Fatalf("the edit ran help again: %d replies", n)
	}

	// Someone joins later: the bot re-publishes its profile under the new
	// key, so they can see its name.
	carol := newPerson(t, srv, "Carol")
	carol.join(alice.invite())
	eventually(t, "carol to see the bot's name", func() bool { return carol.nameOf(me) == "Emma" })

	// Kicked: forgotten, and gone after a restart too.
	alice.kick(me)
	r.expect(t, "removed "+room.ID)
	if rooms := r.b.Rooms(); len(rooms) != 0 {
		t.Fatalf("still in %v", rooms)
	}
	r.shutdown()
	r = startBot(t, dir)
	if rooms := r.b.Rooms(); len(rooms) != 0 {
		t.Fatalf("back in %v after a restart", rooms)
	}
}

func TestKickedWhileDown(t *testing.T) {
	srv := startServer(t)
	alice := newPerson(t, srv, "Alice")
	alice.createRoom("Den")
	dir := initBot(t, "")
	r := startBot(t, dir)
	room, err := r.b.Join(context.Background(), alice.invite())
	if err != nil {
		t.Fatal(err)
	}
	r.expect(t, "joined "+room.ID)
	me := botID(t, room, alice.me.ID)
	if n := alice.nameOf(me); n == "" || !contains(bot.DefaultNames, n) {
		t.Fatalf("a bot made without a name is called %q", n)
	}
	r.shutdown()
	alice.kick(me)
	r = startBot(t, dir)
	r.expect(t, "removed "+room.ID)
	if rooms := r.b.Rooms(); len(rooms) != 0 {
		t.Fatalf("still in %v", rooms)
	}
}

func TestInitRules(t *testing.T) {
	dir := t.TempDir()
	if _, err := bot.Init(dir, bot.InitOptions{}); err == nil {
		t.Fatal("init without a password worked")
	}
	if _, err := bot.Init(dir, bot.InitOptions{Password: "x", Name: strings.Repeat("a", 41)}); err == nil {
		t.Fatal("a 41-character name was accepted")
	}
	acct, err := bot.Init(dir, bot.InitOptions{Password: "x"})
	if err != nil || len(acct.Phrase) != 24 {
		t.Fatalf("init: %+v %v", acct, err)
	}
	if _, err := bot.Init(dir, bot.InitOptions{Password: "x"}); err == nil {
		t.Fatal("init replaced an account")
	}
	// The phrase brings the same account back elsewhere.
	other := t.TempDir()
	if _, err := bot.Init(other, bot.InitOptions{Password: "y", Phrase: strings.Join(acct.Phrase, " ")}); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(filepath.Join(dir, "account.key"))
	b, _ := os.ReadFile(filepath.Join(other, "account.key"))
	if string(a) != string(b) {
		t.Fatal("the phrase didn't restore the same account")
	}
	if fi, _ := os.Stat(filepath.Join(dir, "account.key")); fi.Mode().Perm() != 0o600 {
		t.Fatalf("account.key is %v", fi.Mode().Perm())
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// The stock binary, driven like a person at a shell on the bot's machine.
func TestCLI(t *testing.T) {
	srv := startServer(t)
	alice := newPerson(t, srv, "Alice")
	alice.createRoom("Den")

	bin := filepath.Join(t.TempDir(), "superchat-bot")
	if out, err := exec.Command("go", "build", "-o", bin, "./cmd/superchat-bot").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	dir := filepath.Join(t.TempDir(), "data")
	env := append(os.Environ(), "SUPERCHAT_BOT_PASSWORD=hunter2", "SUPERCHAT_BOT_DATA="+dir)
	shell := func(args ...string) string {
		t.Helper()
		cmd := exec.Command(bin, args...)
		cmd.Env = env
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("superchat-bot %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return string(out)
	}

	out := shell("init", "--name", "Robo")
	if !strings.Contains(out, "Its name is Robo") || len(strings.Fields(strings.Split(out, "\n\n")[2])) != 24 {
		t.Fatalf("init said:\n%s", out)
	}
	if _, err := exec.Command(bin, "join", alice.invite()).CombinedOutput(); err == nil {
		t.Fatal("join worked with no bot running")
	}

	run := exec.Command(bin, "run")
	run.Env = env
	if err := run.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = run.Process.Signal(os.Interrupt); _ = run.Wait() })
	eventually(t, "the bot to start", func() bool {
		return exec.Command(bin, "rooms", "--data", dir).Run() == nil
	})

	if out := shell("join", alice.invite()); !strings.Contains(out, "Joined Den (2 members)") {
		t.Fatalf("join said %q", out)
	}
	if out := shell("rooms"); !strings.Contains(out, alice.room) || !strings.Contains(out, "Den") {
		t.Fatalf("rooms said %q", out)
	}
	alice.refresh()
	var me string
	for id := range alice.rep.State.Members {
		if id != alice.me.ID {
			me = id
		}
	}
	q := alice.say(bot.Mention(me) + " help")
	eventually(t, "the binary to answer", func() bool { return len(alice.repliesTo(me, q)) == 1 })

	// A second copy on the same data directory refuses to start.
	second := exec.Command(bin, "run")
	second.Env = env
	if out, err := second.CombinedOutput(); err == nil || !strings.Contains(string(out), "already running") {
		t.Fatalf("a second bot on the same data: %v %s", err, out)
	}

	// Ctrl-C stops it cleanly.
	_ = run.Process.Signal(os.Interrupt)
	if err := run.Wait(); err != nil {
		t.Fatalf("the bot exited with %v", err)
	}
}

// ---- phase 3: the core commands ----

func (p *person) sendFile(name, mime string, data []byte, caption string) string {
	p.t.Helper()
	p.refresh()
	key, sealed := crypto.EncryptBlob(data)
	blob, err := p.c.PutBlob(context.Background(), p.room, p.me, sealed)
	p.must(err)
	f := crypto.FileRef{Blob: blob, Key: crypto.B64.EncodeToString(key), Name: name, Mime: mime, Size: int64(len(data))}
	epoch := p.rep.State.Epoch
	id := proto.NewID()
	ct, kind, err := crypto.EncryptMessage(p.me, p.room, epoch, p.keys[epoch], crypto.Content{T: crypto.TypeFile, Files: []crypto.FileRef{f}, Body: caption}, id, now())
	p.must(err)
	_, err = p.c.PostMessage(context.Background(), p.room, p.me, &wire.PostMessage{ID: id, Epoch: epoch, Kind: kind, Ct: ct, Blobs: []string{blob}})
	p.must(err)
	return id
}

func (p *person) promote(target string) {
	p.refresh()
	signed, _, err := crypto.BuildEvents(p.me, p.rep.State, []crypto.NewEvent{{Kind: "promote", Pub: proto.TargetPub{Target: target}}}, now())
	p.must(err)
	_, err = p.c.Append(context.Background(), p.room, p.me, &wire.Batch{Events: signed})
	p.must(err)
}

func (p *person) leaveRoom() {
	p.refresh()
	signed, s1, err := crypto.BuildEvents(p.me, p.rep.State, []crypto.NewEvent{{Kind: "leave"}}, now())
	p.must(err)
	_ = s1
	_, err = p.c.Append(context.Background(), p.room, p.me, &wire.Batch{Events: signed})
	p.must(err)
}

// ask tags the bot and waits for its one reply.
func (p *person) ask(botID, text string) string {
	p.t.Helper()
	q := p.say(bot.Mention(botID) + " " + text)
	var got []seen
	eventually(p.t, "a reply to "+text, func() bool { got = p.repliesTo(botID, q); return len(got) == 1 })
	return got[0].c.Body
}

func expectHas(t *testing.T, got, want string) {
	t.Helper()
	if !strings.Contains(got, want) {
		t.Fatalf("got %q, want it to contain %q", got, want)
	}
}

func pngImage(t *testing.T, w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 200, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestCoreCommands(t *testing.T) {
	srv := startServer(t)
	alice := newPerson(t, srv, "Alice")
	alice.createRoom("Den")
	bob := newPerson(t, srv, "Bob")
	bob.createRoom("Den 2")
	dir := initBot(t, "Emma")
	r := startBot(t, dir)
	room, err := bot.ControlJoin(dir, alice.invite())
	if err != nil {
		t.Fatal(err)
	}
	r.expect(t, "joined "+room.ID)
	me := botID(t, room, alice.me.ID)

	// Not an admin: the bot won't change, and won't join anything.
	expectHas(t, alice.ask(me, "name Robo"), "Only the bot's admins")
	expectHas(t, alice.ask(me, "join "+bob.invite()), "Only the bot's admins")
	if len(r.b.Rooms()) != 1 {
		t.Fatal("a non-admin made the bot join a room")
	}
	expectHas(t, alice.ask(me, "help"), "for my admins: log in first")

	// Wrong passwords back off; the bot isn't a room admin, so it says to
	// delete the message rather than deleting it.
	wrong := alice.ask(me, "login nope")
	expectHas(t, wrong, "That's not the password")
	expectHas(t, wrong, "Delete your message")
	expectHas(t, alice.ask(me, "login hunter2"), "Too many wrong passwords")
	time.Sleep(1100 * time.Millisecond)
	expectHas(t, alice.ask(me, "login hunter2"), "You're my admin")
	expectHas(t, alice.ask(me, "help"), "join <invite link>")

	// A room admin, the bot deletes the message holding the password.
	alice.ask(me, "logout")
	alice.promote(me)
	q := alice.say(bot.Mention(me) + " login hunter2")
	eventually(t, "the login reply", func() bool { return len(alice.repliesTo(me, q)) == 1 })
	expectHas(t, alice.repliesTo(me, q)[0].c.Body, "I deleted your message")
	for _, m := range alice.messages() {
		if m.id == q {
			t.Fatal("the message with the password is still there")
		}
	}

	// join, from chat, now that alice is an admin.
	expectHas(t, alice.ask(me, "join "+bob.invite()), "Joined Den 2")
	room2 := bob.room
	meIn2 := ""
	bob.refresh()
	for id := range bob.rep.State.Members {
		if id != bob.me.ID {
			meIn2 = id
		}
	}
	r.expect(t, "joined "+room2)

	// name, in every room.
	expectHas(t, alice.ask(me, "name Robo"), "I'm Robo now")
	if alice.nameOf(me) != "Robo" || bob.nameOf(meIn2) != "Robo" {
		t.Fatalf("names: %q in Den, %q in Den 2", alice.nameOf(me), bob.nameOf(meIn2))
	}
	expectHas(t, alice.ask(me, "name "+strings.Repeat("x", 41)), "at most 40")

	// picture, in every room: a 512 px JPEG.
	pq := alice.sendFile("me.png", "image/png", pngImage(t, 300, 200), bot.Mention(me)+" picture")
	eventually(t, "the picture reply", func() bool { return len(alice.repliesTo(me, pq)) == 1 })
	expectHas(t, alice.repliesTo(me, pq)[0].c.Body, "New picture set")
	for _, p := range []*person{alice, bob} {
		id := me
		if p == bob {
			id = meIn2
		}
		p.refresh()
		a, ok := p.rep.View(p.keys).Avatars[id]
		if !ok {
			t.Fatalf("%s doesn't see the bot's picture", p.name)
		}
		sealed, err := p.c.GetBlob(context.Background(), p.room, p.me, a.Blob)
		p.must(err)
		key, _ := crypto.B64.DecodeString(a.Key)
		jpg, err := crypto.DecryptBlob(key, sealed)
		p.must(err)
		cfg, format, err := image.DecodeConfig(bytes.NewReader(jpg))
		if err != nil || format != "jpeg" || cfg.Width != 512 || cfg.Height != 512 {
			t.Fatalf("%s's copy of the picture: %s %dx%d %v", p.name, format, cfg.Width, cfg.Height, err)
		}
	}
	expectHas(t, alice.ask(me, "picture"), "Attach an image")
	expectHas(t, alice.ask(me, "picture remove"), "Took my picture off")
	if _, ok := bob.rep.View(bob.keys).Avatars[meIn2]; ok {
		bob.refresh()
		if _, ok := bob.rep.View(bob.keys).Avatars[meIn2]; ok {
			t.Fatal("the picture is still on in Den 2")
		}
	}

	// leave, from chat (bob logs in there first: admin is per room).
	expectHas(t, bob.ask(meIn2, "leave"), "Only the bot's admins")
	expectHas(t, bob.ask(meIn2, "login hunter2"), "You're my admin")
	expectHas(t, bob.ask(meIn2, "leave"), "Bye")
	r.expect(t, "removed "+room2)
	bob.refresh()
	if bob.rep.State.IsMember(meIn2) {
		t.Fatal("the bot is still in Den 2")
	}

	// Someone who leaves the room stops being an admin there.
	carol := newPerson(t, srv, "Carol")
	carol.join(alice.invite())
	expectHas(t, carol.ask(me, "login hunter2"), "You're my admin")
	carolID := carol.me.ID
	carol.leaveRoom()
	eventually(t, "carol's admin to go", func() bool {
		ok, _ := botIsAdmin(r.b, room.ID, carolID)
		return !ok
	})
}

// botIsAdmin asks the bot (through a handler) whether a member is an admin.
func botIsAdmin(b *bot.Bot, roomID, member string) (bool, error) {
	return bot.IsAdminForTest(b, roomID, member)
}

func TestTwoBotsInOneChat(t *testing.T) {
	srv := startServer(t)
	alice := newPerson(t, srv, "Alice")
	alice.createRoom("Den")
	a := startBot(t, initBot(t, "Ann"))
	b := startBot(t, initBot(t, "Ben"))
	ra, err := a.b.Join(context.Background(), alice.invite())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.b.Join(context.Background(), alice.invite()); err != nil {
		t.Fatal(err)
	}
	annID := botID(t, ra, alice.me.ID)
	alice.refresh()
	var benID string
	for id := range alice.rep.State.Members {
		if id != alice.me.ID && id != annID {
			benID = id
		}
	}
	q := alice.say(bot.Mention(annID) + " help")
	eventually(t, "ann's reply", func() bool { return len(alice.repliesTo(annID, q)) == 1 })
	time.Sleep(500 * time.Millisecond)
	if n := len(alice.repliesTo(benID, q)); n != 0 {
		t.Fatalf("ben answered ann's mention (%d)", n)
	}
	q2 := alice.say(bot.Mention(benID) + " help")
	eventually(t, "ben's reply", func() bool { return len(alice.repliesTo(benID, q2)) == 1 })
	if n := len(alice.repliesTo(annID, q2)); n != 0 {
		t.Fatalf("ann answered ben's mention (%d)", n)
	}
}

func TestSendRateLimit(t *testing.T) {
	srv := startServer(t)
	alice := newPerson(t, srv, "Alice")
	alice.createRoom("Den")
	dir := initBot(t, "Emma")
	b, err := bot.New(bot.Config{DataDir: dir, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), SendBurst: 2, SendsPerSecond: 5})
	if err != nil {
		t.Fatal(err)
	}
	took := make(chan time.Duration, 1)
	b.Command("spam", bot.Anyone, "spam", func(c *bot.Ctx) error {
		start := time.Now()
		for i := 0; i < 6; i++ {
			if err := c.Send(fmt.Sprint("spam ", i)); err != nil {
				return err
			}
		}
		took <- time.Since(start)
		return nil
	})
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- b.Run(ctx) }()
	t.Cleanup(func() { stop(); <-done; b.Close() })
	eventually(t, "the bot to start", func() bool { _, err := bot.ControlRooms(dir); return err == nil })
	room, err := b.Join(context.Background(), alice.invite())
	if err != nil {
		t.Fatal(err)
	}
	alice.say(bot.Mention(botID(t, room, alice.me.ID)) + " spam")
	select {
	case d := <-took:
		// A burst of 2, then 5 a second: 4 more sends take at least 0.8 s.
		if d < 700*time.Millisecond {
			t.Fatalf("6 sends took %s: not limited", d)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the spam command never finished")
	}
}
