package crypto

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"unicode/utf16"

	"github.com/canavan-a/super-chat/shared/proto"
)

// The Go twin of app/src/crypto/view.ts: a verified log plus whatever epoch
// keys we hold, turned into what a client shows (the room's name, color and
// picture, members with roles and display names, invites, activity).

// Replay is a log parsed and checked event by event from the start.
type Replay struct {
	State  *proto.State
	Events []*proto.Event
	// Commits is each epoch's key commitment, from the signed epoch events.
	Commits map[int64]string
}

// ReplayLog parses and replays a full log, failing at the first invalid event.
func ReplayLog(room string, events []proto.SignedEvent) (*Replay, error) {
	r := &Replay{State: proto.NewState(room), Commits: map[int64]string{}}
	return r.Extend(events)
}

// Extend replays events on top of r, checking each one exactly as ReplayLog
// does, without re-checking what r already holds. Events r already has are
// skipped. r itself is left alone, even on error.
func (r *Replay) Extend(events []proto.SignedEvent) (*Replay, error) {
	out := &Replay{
		State:   r.State.Clone(),
		Events:  append([]*proto.Event(nil), r.Events...),
		Commits: make(map[int64]string, len(r.Commits)+1),
	}
	for k, v := range r.Commits {
		out.Commits[k] = v
	}
	for _, se := range events {
		e, err := proto.ParseEvent(se)
		if err != nil {
			return nil, err
		}
		if e.Seq < out.State.NextSeq {
			continue
		}
		if err := out.State.Apply(e, 0); err != nil {
			return nil, fmt.Errorf("event %d (%s): %w", e.Seq, e.Kind, err)
		}
		if e.Kind == "epoch" {
			var p proto.EpochPub
			if err := json.Unmarshal(e.Pub, &p); err == nil {
				out.Commits[p.Epoch] = p.Commit
			}
		}
		out.Events = append(out.Events, e)
	}
	return out, nil
}

// MemberView is one current member.
type MemberView struct {
	ID   string
	Role string
	Name string // "" until we've read their profile (or a snapshot naming them)
}

// InviteView is one invite and who joined through it.
type InviteView struct {
	ID string
	proto.Invite
	Joined []string
}

// Activity is a join, leave or removal: a notice in the chat.
type Activity struct {
	ID     string `json:"id"` // unique within the room: "a" + the event's seq
	Kind   string `json:"kind"`
	Member string `json:"member"`
	At     int64  `json:"at"`
}

// Activity kinds.
const (
	ActivityJoin    = "join"
	ActivityLeave   = "leave"
	ActivityRemoved = "removed"
)

// Wiped is the latest "wipe chat history".
type Wiped struct {
	By string `json:"by"`
	At int64  `json:"at"`
}

// RoomView is what a client shows for a room.
type RoomView struct {
	ID    string
	Name  string // "" for none
	Color string // "" for none
	// Picture is the group picture, or nil.
	Picture *AvatarRef
	// Members are admins first, then by ID. (The app keeps the log's order
	// within each role; Go maps have none, so this sorts.)
	Members       []MemberView
	Invites       []InviteView // newest first
	RetentionDays int
	Epoch         int64
	// Names are the display names of everyone seen in the log, past members too.
	Names map[string]string
	// Avatars are profile pictures, by member.
	Avatars  map[string]AvatarRef
	Wiped    *Wiped
	Activity []Activity // oldest first
}

// View builds the room view from r with the epoch keys we hold. Payloads
// under keys we don't have are skipped, exactly as the app skips them.
func (r *Replay) View(keys map[int64][]byte) *RoomView {
	var (
		name, snapName   string
		nameSet          bool // a meta event has said something about the name
		color, snapColor string
		picture          *AvatarRef
		pictureSet       bool
		snapPicture      *AvatarRef
		names            = map[string]string{}
		snapNames        = map[string]string{}
		avatars          = map[string]AvatarRef{}
		joined           = map[string][]string{}
		activity         = []Activity{}
		wiped            *Wiped
	)
	for _, e := range r.Events {
		switch e.Kind {
		case "meta":
			m := openFields(e, keys)
			if s, ok := jsonString(m["name"]); ok {
				name, nameSet = truncUTF16(s, 80), true
			}
			if s, ok := jsonString(m["color"]); ok && s != "" {
				color = s
			}
			// Present: the current picture; null: removed; absent: unchanged.
			if raw, ok := m["picture"]; ok {
				picture, pictureSet = asAvatarRef(raw), true
			}
		case "epoch":
			snap := openFields(e, keys)
			if s, ok := jsonString(snap["name"]); ok {
				snapName = truncUTF16(s, 80)
			}
			if s, ok := jsonString(snap["color"]); ok && s != "" {
				snapColor = s
			}
			if raw, ok := snap["picture"]; ok {
				snapPicture = asAvatarRef(raw)
			}
			var profiles map[string]json.RawMessage
			if raw, ok := snap["profiles"]; ok && json.Unmarshal(raw, &profiles) == nil {
				for id, n := range profiles {
					if s, ok := jsonString(n); ok {
						snapNames[id] = truncUTF16(s, 40)
					}
				}
			}
		case "profile":
			p := openFields(e, keys)
			if s, ok := jsonString(p["displayName"]); ok && s != "" {
				names[e.Author] = truncUTF16(s, 40)
			}
			// Present: the current picture; null: removed; absent: unchanged.
			if raw, ok := p["avatar"]; ok {
				if a := asAvatarRef(raw); a != nil {
					avatars[e.Author] = *a
				} else {
					delete(avatars, e.Author)
				}
			}
		case "join":
			var p proto.JoinPub
			_ = json.Unmarshal(e.Pub, &p)
			joined[p.Invite] = append(joined[p.Invite], e.Author)
			activity = append(activity, Activity{ID: "a" + strconv.FormatInt(e.Seq, 10), Kind: ActivityJoin, Member: e.Author, At: e.Ts})
		case "leave":
			activity = append(activity, Activity{ID: "a" + strconv.FormatInt(e.Seq, 10), Kind: ActivityLeave, Member: e.Author, At: e.Ts})
		case "kick":
			var p proto.TargetPub
			_ = json.Unmarshal(e.Pub, &p)
			activity = append(activity, Activity{ID: "a" + strconv.FormatInt(e.Seq, 10), Kind: ActivityRemoved, Member: p.Target, At: e.Ts})
		case "wipe":
			wiped = &Wiped{By: e.Author, At: e.Ts}
		}
	}

	// A member's own signed profile beats what someone else's snapshot says.
	all := make(map[string]string, len(snapNames)+len(names))
	for id, n := range snapNames {
		all[id] = n
	}
	for id, n := range names {
		all[id] = n
	}
	s := r.State
	v := &RoomView{
		ID:            s.Room,
		Color:         color,
		RetentionDays: s.RetentionDays,
		Epoch:         s.Epoch,
		Names:         all,
		Avatars:       avatars,
		Wiped:         wiped,
		Activity:      activity,
	}
	// Only admins author meta; a snapshot is the fallback for members who
	// joined after the last meta event.
	if nameSet {
		v.Name = name
	} else {
		v.Name = snapName
	}
	if v.Color == "" {
		v.Color = snapColor
	}
	if pictureSet {
		v.Picture = picture
	} else {
		v.Picture = snapPicture
	}
	for _, id := range s.SortedMembers() {
		v.Members = append(v.Members, MemberView{ID: id, Role: s.Members[id], Name: all[id]})
	}
	sort.SliceStable(v.Members, func(i, j int) bool {
		return v.Members[i].Role == proto.RoleAdmin && v.Members[j].Role != proto.RoleAdmin
	})
	for id, iv := range s.Invites {
		v.Invites = append(v.Invites, InviteView{ID: id, Invite: *iv, Joined: joined[id]})
	}
	sort.Slice(v.Invites, func(i, j int) bool {
		if v.Invites[i].CreatedAt != v.Invites[j].CreatedAt {
			return v.Invites[i].CreatedAt > v.Invites[j].CreatedAt
		}
		return v.Invites[i].ID < v.Invites[j].ID
	})
	return v
}

// Member is one member of the view, or nil.
func (v *RoomView) Member(id string) *MemberView {
	for i := range v.Members {
		if v.Members[i].ID == id {
			return &v.Members[i]
		}
	}
	return nil
}

// openFields opens an event's enc into its top-level fields, so a field
// that's present (even as null) can be told from one that's absent. It's nil
// when there's no enc or no key for it, like the app's openEnc returning null.
func openFields(e *proto.Event, keys map[int64][]byte) map[string]json.RawMessage {
	key, ok := keys[e.Epoch]
	if e.Enc == "" || !ok {
		return nil
	}
	var m map[string]json.RawMessage
	if OpenEnc(e, key, &m) != nil {
		return nil
	}
	return m
}

func jsonString(raw json.RawMessage) (string, bool) {
	var s string
	if raw == nil || json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

// asAvatarRef reads a picture reference, or nil for null or anything malformed.
func asAvatarRef(raw json.RawMessage) *AvatarRef {
	var a struct {
		Blob *string `json:"blob"`
		Key  *string `json:"key"`
		At   any     `json:"at"`
	}
	if json.Unmarshal(raw, &a) != nil || a.Blob == nil || a.Key == nil {
		return nil
	}
	// The app's Number(at) || 0.
	var at float64
	switch t := a.At.(type) {
	case float64:
		at = t
	case string:
		at, _ = strconv.ParseFloat(t, 64)
	}
	if math.IsNaN(at) || math.IsInf(at, 0) {
		at = 0
	}
	return &AvatarRef{Blob: *a.Blob, Key: *a.Key, At: int64(at)}
}

// truncUTF16 is JavaScript's s.slice(0, n): n UTF-16 code units, so a name
// is cut at the same place as in the app. A surrogate pair the cut would
// split is dropped whole (JavaScript would keep half of it).
func truncUTF16(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	u = u[:n]
	if utf16.IsSurrogate(rune(u[n-1])) && u[n-1] < 0xdc00 {
		u = u[:n-1]
	}
	return string(utf16.Decode(u))
}
