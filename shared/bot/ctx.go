package bot

import (
	"context"
	"regexp"
	"strings"

	"github.com/canavan-a/super-chat/shared/crypto"
	"github.com/canavan-a/super-chat/shared/wire"
)

// Room is a room as handlers see it.
type Room struct {
	ID     string
	Server string
	// Name is the room's name, "" if it has none (the app then shows the
	// members' names).
	Name    string
	Members []Member
}

// Member is someone in a room. IDs are per room: the same person has a
// different ID in every room.
type Member struct {
	ID   string
	Name string // "" until their profile has been read
	Role string // the room role: "admin" or "member" (not the bot's admin)
}

// Message is a message someone sent.
type Message struct {
	ID      string
	Pos     int64
	Ts      int64 // when the sender says they sent it (ms)
	Content crypto.Content
	// Raw is the whole decrypted content, for types Content doesn't cover.
	Raw []byte
}

// Text is the message's text: a text message's body or a file's caption.
func (m *Message) Text() string { return m.Content.Body }

var mentionRE = regexp.MustCompile(`<@([a-z2-7]{52})>`)

// Mentions is the member IDs tagged in the message, in order.
func (m *Message) Mentions() []string {
	var out []string
	for _, sm := range mentionRE.FindAllStringSubmatch(m.Text(), -1) {
		out = append(out, sm[1])
	}
	return out
}

// Mention is the token that tags a member in a message's text.
func Mention(memberID string) string { return "<@" + memberID + ">" }

// Ctx is one message being handled.
type Ctx struct {
	context.Context
	Bot     *Bot
	Room    Room
	Sender  Member
	Message *Message
	// Command and Args are set when the message tagged the bot: the first
	// word after the mention (lowercased), and the words after it.
	Command string
	Args    []string

	r *room
}

// Me is the bot's own member ID in this room.
func (c *Ctx) Me() string { return c.r.me.ID }

// IsAdmin reports whether the sender has logged in as an admin of the bot
// in this room.
func (c *Ctx) IsAdmin() bool {
	ok, err := c.Bot.st.IsAdmin(c.Room.ID, c.Sender.ID)
	return err == nil && ok
}

// Reply answers the message, as a reply to it.
func (c *Ctx) Reply(text string) error {
	_, err := c.r.send(c, crypto.Content{T: crypto.TypeText, Body: text, ReplyTo: c.Message.ID}, nil)
	return err
}

// Send posts a message in the room.
func (c *Ctx) Send(text string) error {
	_, err := c.r.send(c, crypto.Content{T: crypto.TypeText, Body: text}, nil)
	return err
}

// React puts an emoji on the message.
func (c *Ctx) React(emoji string) error {
	_, err := c.r.send(c, crypto.Content{T: crypto.TypeReaction, Target: c.Message.ID, Emoji: emoji}, nil)
	return err
}

// Get reads a value this bot stored for the room (nil if none).
func (c *Ctx) Get(key string) ([]byte, error) {
	v, _, err := c.Bot.st.KVGet(c.Room.ID, key)
	return v, err
}

// Set stores a value for the room; nil deletes it. It's forgotten with the room.
func (c *Ctx) Set(key string, value []byte) error {
	return c.Bot.st.KVSet(c.Room.ID, key, value)
}

// ---- dispatch ----

type incoming struct {
	room    *room
	msg     *wire.Message
	content *crypto.Decrypted
	info    Room
}

// parseCommand finds the bot's mention in text and returns the first word
// after it (lowercased) and the rest. ok is false when the bot isn't tagged.
func parseCommand(text, me string) (cmd string, args []string, ok bool) {
	tag := Mention(me)
	i := strings.Index(text, tag)
	if i < 0 {
		return "", nil, false
	}
	words := strings.Fields(strings.ReplaceAll(text[i+len(tag):], tag, " "))
	if len(words) == 0 {
		return "", nil, true
	}
	return strings.ToLower(words[0]), words[1:], true
}

func (b *Bot) dispatch(ctx context.Context, in *incoming) {
	sender := Member{ID: in.msg.Sender}
	for _, m := range in.info.Members {
		if m.ID == in.msg.Sender {
			sender = m
		}
	}
	c := &Ctx{
		Context: ctx,
		Bot:     b,
		Room:    in.info,
		Sender:  sender,
		Message: &Message{ID: in.msg.ID, Pos: in.msg.Pos, Ts: in.content.Ts, Content: in.content.Content, Raw: in.content.Raw},
		r:       in.room,
	}

	b.hmu.RLock()
	all := append([]func(*Ctx) error{}, b.onMessage...)
	b.hmu.RUnlock()
	for _, h := range all {
		b.safely("OnMessage", func() error { return h(c) })
	}

	// Only new text (or a file's caption) runs commands: an edit or a
	// reaction never does, so editing a message doesn't run it again.
	t := in.content.T
	if t != crypto.TypeText && t != crypto.TypeFile {
		return
	}
	cmd, args, ok := parseCommand(c.Message.Text(), in.room.me.ID)
	if !ok {
		return
	}
	c.Command, c.Args = cmd, args

	b.hmu.RLock()
	h := b.commands[cmd]
	unknown := b.unknown
	b.hmu.RUnlock()
	switch {
	case h == nil && unknown != nil:
		b.safely("Unknown", func() error { return unknown(c) })
	case h == nil:
		b.safely("Unknown", func() error {
			if cmd == "" {
				return c.Reply("Hi! Tag me with a command, like " + b.Name() + " help.")
			}
			return c.Reply("I don't know \"" + cmd + "\". Try tagging me with help.")
		})
	case h.who == Admin && !c.IsAdmin():
		b.safely(cmd, func() error {
			return c.Reply("Only the bot's admins can do that. Log in first: tag me with login and the admin password.")
		})
	default:
		b.safely(cmd, func() error { return h.fn(c) })
	}
}

// ---- attachments ----

// Attachments is the files on the message (none for plain text).
func (c *Ctx) Attachments() []crypto.FileRef { return c.Message.Content.Files }

// Download fetches and opens one of the message's attachments.
func (c *Ctx) Download(f crypto.FileRef) ([]byte, error) { return c.r.download(c, f) }

// SendFile posts a file in the room, with an optional caption. The app shows
// image/* as a picture, video/* and audio/* as players, anything else as a
// file to save.
func (c *Ctx) SendFile(name, mime string, data []byte, caption string) error {
	f, err := c.r.upload(c, name, mime, data)
	if err != nil {
		return err
	}
	_, err = c.r.send(c, crypto.Content{T: crypto.TypeFile, Files: []crypto.FileRef{f}, Body: caption}, []string{f.Blob})
	return err
}

// Delete deletes the message for everyone. The room only lets the bot do
// that when it's a room admin; otherwise it's ErrNotAllowed.
func (c *Ctx) Delete() error { return c.r.deleteMessage(c, c.Message.ID, c.Sender.ID) }
