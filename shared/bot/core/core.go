// Package core holds the bot's built-in commands. The stock bot registers
// them all; a custom bot can register them too (core.Register) and add its
// own alongside.
//
// Everything that changes the bot (its name and picture, which rooms it's
// in) is for admins: members who told the bot its admin password, in that
// room, with login. Anyone else is told to log in first.
package core

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/canavan-a/super-chat/shared/bot"
)

// Register adds the core commands to b.
func Register(b *bot.Bot) {
	l := &logins{fails: map[string]*attempts{}}
	b.Command("help", bot.Anyone, "help: what I can do", help)
	b.Command("login", bot.Anyone, "login <password>: become my admin in this room", l.login)
	b.Command("logout", bot.Anyone, "logout: stop being my admin in this room", logout)
	b.Command("name", bot.Admin, "name <new name>: rename me, in every room", name)
	b.Command("picture", bot.Admin, "picture (with an image attached): set my picture, in every room; picture remove: take it off", picture)
	b.Command("join", bot.Admin, "join <invite link>: join another chat", join)
	b.Command("leave", bot.Admin, "leave: leave this chat", leave)
	b.Command("voice", bot.Anyone, "voice who: who's in this chat's voice; voice join / voice leave (admins): bring me in or out", voice)
}

// help lists the commands the sender can use.
func help(c *bot.Ctx) error {
	admin := c.IsAdmin()
	var lines []string
	hidden := false
	for _, cmd := range c.Bot.Commands() {
		if cmd.Who == bot.Admin && !admin {
			hidden = true
			continue
		}
		lines = append(lines, "• "+cmd.Usage)
	}
	text := "Tag me with one of these:\n" + strings.Join(lines, "\n")
	if hidden {
		text += "\n\nMore commands are for my admins: log in first with login <password>."
	}
	return c.Reply(text)
}

// ---- login ----

// logins backs off wrong passwords per member: 1 s after the first, then 2,
// 4, 8… up to 5 minutes. Member IDs are per room, so this is per room too.
type logins struct {
	mu    sync.Mutex
	fails map[string]*attempts
}

type attempts struct {
	n     int
	until time.Time
}

const maxBackoff = 5 * time.Minute

func (l *logins) login(c *bot.Ctx) error {
	pw := strings.Join(c.Args, " ")
	if pw == "" {
		return c.Reply("Tag me with login and the admin password.")
	}
	// The password is in the chat for everyone to read: take it out if the
	// room lets the bot (it has to be a room admin), right or wrong.
	deleted := c.Delete() == nil
	cleanup := " Delete your message: everyone in this chat can read the password."
	if deleted {
		cleanup = " (I deleted your message, so the password isn't left in the chat.)"
	}
	if c.IsAdmin() {
		return c.Reply("You're already my admin here." + cleanup)
	}

	key := c.Room.ID + "|" + c.Sender.ID
	l.mu.Lock()
	a := l.fails[key]
	if a != nil && time.Now().Before(a.until) {
		wait := time.Until(a.until).Round(time.Second)
		l.mu.Unlock()
		return c.Reply(fmt.Sprintf("Too many wrong passwords. Try again in %s.%s", max(wait, time.Second), cleanup))
	}
	l.mu.Unlock()

	if !c.Bot.CheckPassword(pw) {
		l.mu.Lock()
		if a = l.fails[key]; a == nil {
			a = &attempts{}
			l.fails[key] = a
		}
		a.n++
		a.until = time.Now().Add(min(time.Second<<(a.n-1), maxBackoff))
		l.mu.Unlock()
		return c.Reply("That's not the password." + cleanup)
	}
	l.mu.Lock()
	delete(l.fails, key)
	l.mu.Unlock()
	if err := c.Bot.SetAdmin(c.Room.ID, c.Sender.ID, true); err != nil {
		return err
	}
	return c.Reply("You're my admin in this chat now. Tag me with help to see everything I can do." + cleanup)
}

func logout(c *bot.Ctx) error {
	if !c.IsAdmin() {
		return c.Reply("You weren't logged in.")
	}
	if err := c.Bot.SetAdmin(c.Room.ID, c.Sender.ID, false); err != nil {
		return err
	}
	return c.Reply("Logged out. You're not my admin in this chat any more.")
}

// ---- the bot's name and picture ----

func name(c *bot.Ctx) error {
	n := strings.Join(c.Args, " ")
	if n == "" {
		return c.Reply("I'm " + c.Bot.Name() + ". To rename me, tag me with name and the new name.")
	}
	if err := c.Bot.SetName(c, n); err != nil {
		return c.Reply("Couldn't rename me: " + err.Error())
	}
	return c.Reply("I'm " + c.Bot.Name() + " now, in every chat.")
}

func picture(c *bot.Ctx) error {
	if len(c.Args) > 0 && strings.EqualFold(c.Args[0], "remove") {
		if err := c.Bot.SetPicture(c, nil); err != nil {
			return c.Reply("Couldn't take my picture off everywhere: " + err.Error())
		}
		return c.Reply("Took my picture off, in every chat.")
	}
	for _, f := range c.Attachments() {
		if !strings.HasPrefix(f.Mime, "image/") {
			continue
		}
		data, err := c.Download(f)
		if err != nil {
			return c.Reply("Couldn't fetch that picture: " + err.Error())
		}
		if err := c.Bot.SetPicture(c, data); err != nil {
			return c.Reply("Couldn't set my picture: " + err.Error())
		}
		return c.Reply("New picture set, in every chat.")
	}
	return c.Reply("Attach an image to the message that tags me with picture (or say picture remove).")
}

// ---- rooms ----

func join(c *bot.Ctx) error {
	if len(c.Args) == 0 {
		return c.Reply("Tag me with join and an invite link.")
	}
	r, err := c.Bot.Join(c, c.Args[0])
	if err != nil {
		return c.Reply("Couldn't join: " + err.Error())
	}
	if r.ID == c.Room.ID {
		return c.Reply("I'm already here.")
	}
	return c.Reply("Joined " + title(r) + ".")
}

func leave(c *bot.Ctx) error {
	if err := c.Reply("Bye! 👋"); err != nil && !errors.Is(err, bot.ErrNotAllowed) {
		return err
	}
	return c.Bot.Leave(c, c.Room.ID)
}

func title(r bot.Room) string {
	if r.Name != "" {
		return r.Name
	}
	var names []string
	for _, m := range r.Members {
		if m.Name != "" {
			names = append(names, m.Name)
		}
	}
	if len(names) > 0 {
		return strings.Join(names, ", ")
	}
	return "the chat"
}

// ---- voice ----

func voice(c *bot.Ctx) error {
	sub := ""
	if len(c.Args) > 0 {
		sub = strings.ToLower(c.Args[0])
	}
	switch sub {
	case "who":
		people := c.Bot.Voice.Presence(c.Room.ID)
		call := c.Bot.Voice.Call(c.Room.ID)
		if len(people) == 0 && call == nil {
			return c.Reply("Nobody's in voice.")
		}
		var names []string
		for _, p := range people {
			n := p.Name
			if n == "" {
				n = "someone"
			}
			if p.Muted {
				n += " (muted)"
			}
			names = append(names, n)
		}
		if call != nil {
			names = append(names, c.Bot.Name()+" (me)")
		}
		return c.Reply(fmt.Sprintf("In voice (%d): %s", len(names), strings.Join(names, ", ")))
	case "join", "leave":
		if !c.IsAdmin() {
			return c.Reply("Only the bot's admins can do that. Log in first: tag me with login and the admin password.")
		}
		if sub == "join" {
			if _, err := c.Bot.Voice.Join(c, c.Room.ID); err != nil {
				return c.Reply("Couldn't join voice: " + err.Error())
			}
			return c.Reply("I'm in voice.")
		}
		call := c.Bot.Voice.Call(c.Room.ID)
		if call == nil {
			return c.Reply("I'm not in voice.")
		}
		if err := call.Leave(c); err != nil {
			return err
		}
		return c.Reply("Left voice.")
	}
	return c.Reply("voice who, voice join or voice leave.")
}
