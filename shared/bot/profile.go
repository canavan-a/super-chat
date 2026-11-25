package bot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/canavan-a/super-chat/shared/crypto"
	"github.com/canavan-a/super-chat/shared/proto"
)

// ---- the bot's name and picture, in every room ----

// SetName renames the bot in every room. A room that can't be reached now
// catches up on its own the next time it syncs; the error names how many.
func (b *Bot) SetName(ctx context.Context, name string) error {
	name, err := cleanName(name)
	if err != nil {
		return err
	}
	if name == "" {
		return errors.New("the name can't be empty")
	}
	if err := b.st.SetMeta(metaName, []byte(name)); err != nil {
		return err
	}
	b.mu.Lock()
	b.name = name
	b.mu.Unlock()
	return b.updateProfiles(ctx)
}

// SetPicture sets the bot's profile picture in every room: any JPEG, PNG,
// GIF or WebP, cropped and scaled like the app's (PrepareAvatar). nil
// removes it.
func (b *Bot) SetPicture(ctx context.Context, image []byte) error {
	var jpeg []byte
	if image != nil {
		var err error
		if jpeg, err = PrepareAvatar(image); err != nil {
			return err
		}
	}
	at := b.now().UnixMilli()
	b.mu.Lock()
	if at <= b.pictureAt {
		at = b.pictureAt + 1 // always newer than what's out there
	}
	b.mu.Unlock()
	// An empty value (not NULL) for "removed".
	if err := b.st.SetMeta(metaPicture, append([]byte{}, jpeg...)); err != nil {
		return err
	}
	if err := b.st.SetMeta(metaPictureAt, []byte(strconv.FormatInt(at, 10))); err != nil {
		return err
	}
	b.mu.Lock()
	b.picture, b.pictureAt = jpeg, at
	b.mu.Unlock()
	return b.updateProfiles(ctx)
}

// Picture is the bot's profile picture (a JPEG), or nil.
func (b *Bot) Picture() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.picture) == 0 {
		return nil
	}
	return append([]byte(nil), b.picture...)
}

func (b *Bot) pictureState() ([]byte, int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.picture, b.pictureAt
}

// updateProfiles brings every room's copy of the profile up to date.
func (b *Bot) updateProfiles(ctx context.Context) error {
	b.mu.Lock()
	rooms := make([]*room, 0, len(b.rooms))
	for _, r := range b.rooms {
		rooms = append(rooms, r)
	}
	b.mu.Unlock()
	failed := 0
	for _, r := range rooms {
		// Under the room's lock, not on its worker: this may be running on a
		// worker (a handler renaming the bot), and waiting on its own worker
		// would never finish.
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		r.mu.Lock()
		err := r.ensureProfile(cctx)
		r.mu.Unlock()
		cancel()
		if err != nil && !errors.Is(err, errGone) {
			r.log.Warn("couldn't update the bot's profile", "err", err)
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("couldn't update %d of %d rooms yet; they'll catch up on their own", failed, len(rooms))
	}
	return nil
}

// ensureProfile publishes our profile when this room's copy is behind: the
// room was re-keyed since we last published (someone who joins can only read
// profiles under keys from after they joined), our name changed, or our
// picture did (only a newer picture wins, as in the app). Holds r.mu.
func (r *room) ensureProfile(ctx context.Context) error {
	s := r.rep.State
	if _, ok := r.keys[s.Epoch]; !ok {
		return nil
	}
	name := r.b.Name()
	mine := int64(-1)
	for _, e := range r.rep.Events {
		if e.Kind == "profile" && e.Author == r.me.ID && e.Epoch > mine {
			mine = e.Epoch
		}
	}
	publish := mine < s.Epoch || r.view.Names[r.me.ID] != name

	var avatar json.RawMessage // nil: carry the current one along
	pic, at := r.b.pictureState()
	cur, has := r.view.Avatars[r.me.ID]
	switch {
	case at == 0, has && cur.At >= at, !has && len(pic) == 0:
		// Never set, already current, or already none.
	case len(pic) == 0:
		if err := r.api().PutAvatar(ctx, r.id, r.me, ""); err != nil {
			return err
		}
		avatar, publish = json.RawMessage("null"), true
	default:
		key, sealed := crypto.EncryptBlob(pic)
		blob, err := r.api().PutBlob(ctx, r.id, r.me, sealed)
		if err != nil {
			return err
		}
		if err := r.api().PutAvatar(ctx, r.id, r.me, blob); err != nil {
			return err
		}
		avatar, _ = json.Marshal(crypto.AvatarRef{Blob: blob, Key: crypto.B64.EncodeToString(key), At: at})
		publish = true
	}
	if !publish {
		return nil
	}
	return r.append(ctx, func(s *proto.State) []crypto.NewEvent {
		p := crypto.Profile{DisplayName: name, Avatar: avatar}
		if p.Avatar == nil {
			if a, ok := r.view.Avatars[r.me.ID]; ok {
				p.Avatar, _ = json.Marshal(a)
			}
		}
		return []crypto.NewEvent{{Kind: "profile", Enc: p, EncEpoch: s.Epoch, EncKey: r.keys[s.Epoch]}}
	}, rotateNone)
}

// ---- admins ----

// CheckPassword reports whether pw is the bot's admin password.
func (b *Bot) CheckPassword(pw string) bool {
	stored, ok, err := b.st.Meta(metaPassword)
	return err == nil && ok && checkPassword(string(stored), pw)
}

// SetAdmin makes a member an admin of the bot in a room (or not). Member IDs
// are per room, so it's only ever for that room.
func (b *Bot) SetAdmin(roomID, member string, admin bool) error {
	return b.st.SetAdmin(roomID, member, admin)
}

// pruneAdmins drops admins who aren't in the room any more. Holds r.mu.
func (r *room) pruneAdmins() {
	admins, err := r.b.st.Admins(r.id)
	if err != nil {
		return
	}
	for _, m := range admins {
		if !r.rep.State.IsMember(m) {
			_ = r.b.st.SetAdmin(r.id, m, false)
		}
	}
}

// ---- leaving, deleting ----

// Leave has the bot leave a room. The rest of the room re-keys without it.
func (b *Bot) Leave(ctx context.Context, roomID string) error {
	r := b.room(roomID)
	if r == nil {
		return errors.New("the bot isn't in that room")
	}
	return r.leave(ctx)
}

func (r *room) leave(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.gone {
		return nil
	}
	err := r.append(ctx, func(s *proto.State) []crypto.NewEvent {
		if !s.IsMember(r.me.ID) {
			return nil
		}
		return []crypto.NewEvent{{Kind: "leave"}}
	}, rotateNone)
	if errors.Is(err, errGone) {
		return nil
	}
	if err != nil {
		return err
	}
	// The append's sync already noticed we're out; this is for the case
	// where we weren't a member to begin with.
	r.removeLocked(ctx, "left the room")
	return nil
}

// ErrNotAllowed means the bot may not do that in this room.
var ErrNotAllowed = errors.New("the bot isn't allowed to do that here")

// deleteMessage deletes a message for everyone. The room allows it for the
// message's sender and for room admins.
func (r *room) deleteMessage(ctx context.Context, id, sender string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if sender != r.me.ID && r.rep.State.Members[r.me.ID] != proto.RoleAdmin {
		return ErrNotAllowed
	}
	return r.append(ctx, func(*proto.State) []crypto.NewEvent {
		return []crypto.NewEvent{{Kind: "delete", Pub: proto.DeletePub{Msg: id, Sender: sender}}}
	}, rotateNone)
}

// ---- files ----

// download fetches and opens an attachment.
func (r *room) download(ctx context.Context, f crypto.FileRef) ([]byte, error) {
	key, err := crypto.B64.DecodeString(f.Key)
	if err != nil {
		return nil, err
	}
	sealed, err := r.api().GetBlob(ctx, r.id, r.me, f.Blob)
	if err != nil {
		return nil, err
	}
	return crypto.DecryptBlob(key, sealed)
}

// upload seals a file and uploads it, for a file message.
func (r *room) upload(ctx context.Context, name, mime string, data []byte) (crypto.FileRef, error) {
	key, sealed := crypto.EncryptBlob(data)
	blob, err := r.api().PutBlob(ctx, r.id, r.me, sealed)
	if err != nil {
		return crypto.FileRef{}, err
	}
	if mime == "" {
		mime = "application/octet-stream"
	}
	return crypto.FileRef{Blob: blob, Key: crypto.B64.EncodeToString(key), Name: name, Mime: strings.ToLower(mime), Size: int64(len(data))}, nil
}

// ---- sending at a sane rate ----

// limiter is a token bucket: a burst, then a steady rate.
type limiter struct {
	tokens float64
	last   time.Time
}

// wait blocks until a send is allowed (or ctx ends).
func (r *room) wait(ctx context.Context) error {
	for {
		r.limMu.Lock()
		now := r.b.now()
		burst, rate := float64(r.b.cfg.SendBurst), r.b.cfg.SendsPerSecond
		if r.lim.last.IsZero() {
			r.lim.tokens = burst
		} else {
			r.lim.tokens = min(burst, r.lim.tokens+now.Sub(r.lim.last).Seconds()*rate)
		}
		r.lim.last = now
		if r.lim.tokens >= 1 {
			r.lim.tokens--
			r.limMu.Unlock()
			return nil
		}
		need := time.Duration((1 - r.lim.tokens) / rate * float64(time.Second))
		r.limMu.Unlock()
		select {
		case <-time.After(need):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
