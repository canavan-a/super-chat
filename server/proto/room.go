package proto

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strconv"
)

// Roles.
const (
	RoleAdmin  = "admin"
	RoleMember = "member"
)

// MaxClockSkewMs is how far an event's ts may be from the server's clock.
const MaxClockSkewMs = 5 * 60 * 1000

// SignedEvent is an event as it travels: the exact body bytes plus the
// author's signature over them.
type SignedEvent struct {
	Body string `json:"body"`
	Sig  string `json:"sig"`
}

// EventBody is the decoded body. Pub is kept raw and decoded per kind.
type EventBody struct {
	V      int             `json:"v"`
	Room   string          `json:"room"`
	Seq    int64           `json:"seq"`
	Prev   string          `json:"prev"`
	Author string          `json:"author"`
	Ts     int64           `json:"ts"`
	Kind   string          `json:"kind"`
	Pub    json.RawMessage `json:"pub"`
	Epoch  int64           `json:"epoch"`
	Enc    string          `json:"enc"`
}

// Event is a parsed, signature-checked event.
type Event struct {
	EventBody
	Raw  []byte
	Sig  []byte
	Hash string
}

// ParseEvent decodes se and checks the author's signature. It doesn't check
// the event against any room state; State.Apply does that.
func ParseEvent(se SignedEvent) (*Event, error) {
	raw, err := B64.DecodeString(se.Body)
	if err != nil {
		return nil, errors.New("event body is not b64")
	}
	sig, err := B64.DecodeString(se.Sig)
	if err != nil {
		return nil, errors.New("event sig is not b64")
	}
	var b EventBody
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, fmt.Errorf("event body: %w", err)
	}
	if b.V != 1 {
		return nil, errors.New("unsupported event version")
	}
	if !Verify(b.Author, "sc-evt", raw, sig) {
		return nil, errors.New("bad event signature")
	}
	h := sha256.Sum256(append(append([]byte{}, raw...), sig...))
	return &Event{EventBody: b, Raw: raw, Sig: sig, Hash: B64.EncodeToString(h[:])}, nil
}

// Signed returns the event in its wire form.
func (e *Event) Signed() SignedEvent {
	return SignedEvent{Body: B64.EncodeToString(e.Raw), Sig: B64.EncodeToString(e.Sig)}
}

// Pub payloads, one per kind.
type (
	// X25519 is the member's room-scoped encryption key, published with
	// the event that adds them, so the log alone says how to seal to them.
	CreatePub struct {
		RetentionDays int    `json:"retentionDays"`
		X25519        string `json:"x25519"`
	}
	SettingsPub struct {
		RetentionDays int `json:"retentionDays"`
	}
	EpochPub struct {
		Epoch      int64    `json:"epoch"`
		Recipients []string `json:"recipients"`
		Commit     string   `json:"commit"`
	}
	InvitePub struct {
		ID        string `json:"id"`
		Key       string `json:"key"`
		ExpiresAt int64  `json:"expiresAt"`
		MaxUses   int    `json:"maxUses"`
	}
	RevokePub struct {
		ID string `json:"id"`
	}
	JoinPub struct {
		Invite string `json:"invite"`
		Proof  string `json:"proof"`
		X25519 string `json:"x25519"`
	}
	TargetPub struct {
		Target string `json:"target"`
	}
	DeletePub struct {
		Msg    string `json:"msg"`
		Sender string `json:"sender"`
	}
)

// Invite is an invite as the log describes it.
type Invite struct {
	Key       string `json:"key"`
	ExpiresAt int64  `json:"expiresAt"`
	MaxUses   int    `json:"maxUses"`
	Uses      int    `json:"uses"`
	Revoked   bool   `json:"revoked"`
	Creator   string `json:"creator"`
}

// State is what replaying a room's log yields.
type State struct {
	Room    string
	NextSeq int64
	Head    string
	Members map[string]string
	// Keys is each current member's X25519 key, from their create/join event.
	Keys            map[string]string
	Epoch           int64
	PendingRotation bool
	Invites         map[string]*Invite
	RetentionDays   int
}

func NewState(room string) *State {
	return &State{Room: room, Members: map[string]string{}, Keys: map[string]string{}, Invites: map[string]*Invite{}}
}

func (s *State) Clone() *State {
	c := *s
	c.Members = make(map[string]string, len(s.Members))
	for k, v := range s.Members {
		c.Members[k] = v
	}
	c.Keys = make(map[string]string, len(s.Keys))
	for k, v := range s.Keys {
		c.Keys[k] = v
	}
	c.Invites = make(map[string]*Invite, len(s.Invites))
	for k, v := range s.Invites {
		iv := *v
		c.Invites[k] = &iv
	}
	return &c
}

// SortedMembers returns the member IDs in order.
func (s *State) SortedMembers() []string {
	ids := make([]string, 0, len(s.Members))
	for id := range s.Members {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (s *State) isAdmin(id string) bool { return s.Members[id] == RoleAdmin }
func (s *State) isMember(id string) bool {
	_, ok := s.Members[id]
	return ok
}

// JoinProofMessage is what an invite key signs to admit an account.
func JoinProofMessage(room, invite, member string) []byte {
	return []byte("sc-join|" + room + "|" + invite + "|" + member)
}

func validRetention(d int) bool { return d >= 0 && d <= 3650 }

func validKey(b64 string) bool {
	k, err := B64.DecodeString(b64)
	return err == nil && len(k) == 32
}

// Apply checks e against the state and, if it's allowed, applies it.
// now is the server's clock in ms; pass 0 to skip clock checks when
// replaying an already-accepted log.
func (s *State) Apply(e *Event, now int64) error {
	if e.Room != s.Room {
		return errors.New("event is for another room")
	}
	if e.Seq != s.NextSeq || e.Prev != s.Head {
		return ErrConflict
	}
	if now != 0 && (e.Ts < now-MaxClockSkewMs || e.Ts > now+MaxClockSkewMs) {
		return errors.New("event ts too far from server clock")
	}
	if e.Enc != "" && (e.Epoch < 1 || e.Epoch > s.Epoch+1) {
		return errors.New("enc under unknown epoch")
	}
	if e.Seq == 0 && e.Kind != "create" {
		return errors.New("first event must be create")
	}

	author := e.Author
	switch e.Kind {
	case "create":
		if e.Seq != 0 {
			return errors.New("create must be first")
		}
		var p CreatePub
		if err := decode(e.Pub, &p); err != nil || !validRetention(p.RetentionDays) || !validKey(p.X25519) {
			return errors.New("bad create")
		}
		s.Members[author] = RoleAdmin
		s.Keys[author] = p.X25519
		s.RetentionDays = p.RetentionDays

	case "epoch":
		if !s.isMember(author) || !(s.isAdmin(author) || s.PendingRotation) {
			return errors.New("not allowed to rotate")
		}
		var p EpochPub
		if err := decode(e.Pub, &p); err != nil {
			return errors.New("bad epoch")
		}
		if p.Epoch != s.Epoch+1 {
			return errors.New("epoch out of order")
		}
		if !slices.Equal(p.Recipients, s.SortedMembers()) {
			return errors.New("epoch recipients must be exactly the members")
		}
		if c, err := B64.DecodeString(p.Commit); err != nil || len(c) != 32 {
			return errors.New("bad epoch commit")
		}
		if e.Enc != "" && e.Epoch != p.Epoch {
			return errors.New("epoch snapshot must use the new key")
		}
		s.Epoch = p.Epoch
		s.PendingRotation = false

	case "meta":
		if !s.isAdmin(author) {
			return errors.New("only admins can change the room")
		}

	case "profile":
		if !s.isMember(author) {
			return errors.New("not a member")
		}

	case "settings":
		if !s.isAdmin(author) {
			return errors.New("only admins can change settings")
		}
		var p SettingsPub
		if err := decode(e.Pub, &p); err != nil || !validRetention(p.RetentionDays) {
			return errors.New("bad settings")
		}
		s.RetentionDays = p.RetentionDays

	case "invite":
		if !s.isAdmin(author) {
			return errors.New("only admins can invite")
		}
		var p InvitePub
		if err := decode(e.Pub, &p); err != nil || !IsID(p.ID) || p.MaxUses < 0 || p.ExpiresAt < 0 {
			return errors.New("bad invite")
		}
		if k, err := B64.DecodeString(p.Key); err != nil || len(k) != 32 {
			return errors.New("bad invite key")
		}
		if _, ok := s.Invites[p.ID]; ok {
			return errors.New("invite exists")
		}
		s.Invites[p.ID] = &Invite{Key: p.Key, ExpiresAt: p.ExpiresAt, MaxUses: p.MaxUses, Creator: author}

	case "revoke":
		if !s.isAdmin(author) {
			return errors.New("only admins can revoke")
		}
		var p RevokePub
		if err := decode(e.Pub, &p); err != nil {
			return errors.New("bad revoke")
		}
		iv, ok := s.Invites[p.ID]
		if !ok {
			return errors.New("no such invite")
		}
		iv.Revoked = true

	case "join":
		if s.isMember(author) {
			return errors.New("already a member")
		}
		var p JoinPub
		if err := decode(e.Pub, &p); err != nil || !validKey(p.X25519) {
			return errors.New("bad join")
		}
		iv, ok := s.Invites[p.Invite]
		if !ok || iv.Revoked {
			return errors.New("invite is not valid")
		}
		if iv.ExpiresAt != 0 && e.Ts > iv.ExpiresAt {
			return errors.New("invite expired")
		}
		if iv.MaxUses != 0 && iv.Uses >= iv.MaxUses {
			return errors.New("invite used up")
		}
		proof, err := B64.DecodeString(p.Proof)
		if err != nil || !VerifyKey(iv.Key, JoinProofMessage(s.Room, p.Invite, author), proof) {
			return errors.New("bad invite proof")
		}
		iv.Uses++
		s.Members[author] = RoleMember
		s.Keys[author] = p.X25519
		s.PendingRotation = true

	case "promote", "demote", "kick":
		if !s.isAdmin(author) {
			return errors.New("only admins can manage members")
		}
		var p TargetPub
		if err := decode(e.Pub, &p); err != nil || !s.isMember(p.Target) {
			return errors.New("target is not a member")
		}
		switch e.Kind {
		case "promote":
			s.Members[p.Target] = RoleAdmin
		case "demote":
			s.Members[p.Target] = RoleMember
		case "kick":
			if p.Target == author {
				return errors.New("leave instead of kicking yourself")
			}
			delete(s.Members, p.Target)
			delete(s.Keys, p.Target)
			s.PendingRotation = true
		}

	case "leave":
		if !s.isMember(author) {
			return errors.New("not a member")
		}
		delete(s.Members, author)
		delete(s.Keys, author)
		s.PendingRotation = true

	case "delete":
		if !s.isMember(author) {
			return errors.New("not a member")
		}
		var p DeletePub
		if err := decode(e.Pub, &p); err != nil || !IsID(p.Msg) {
			return errors.New("bad delete")
		}
		if p.Sender != author && !s.isAdmin(author) {
			return errors.New("only the sender or an admin can delete")
		}

	case "wipe":
		// Deletes every message so far, for everyone. The event itself stays
		// in the log, so the room shows who wiped it and when.
		if !s.isAdmin(author) {
			return errors.New("only admins can wipe the chat")
		}

	default:
		return fmt.Errorf("unknown event kind %q", e.Kind)
	}

	s.NextSeq++
	s.Head = e.Hash
	return nil
}

// ErrConflict means the event doesn't extend the current head.
var ErrConflict = errors.New("conflict")

func decode(raw json.RawMessage, v any) error {
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	return json.Unmarshal(raw, v)
}

// EpochCommit is sha256("sc-commit|room|n|" ‖ key).
func EpochCommit(room string, n int64, key []byte) string {
	h := sha256.Sum256(append([]byte("sc-commit|"+room+"|"+strconv.FormatInt(n, 10)+"|"), key...))
	return B64.EncodeToString(h[:])
}

// IsMember reports whether id is currently in the room.
func (s *State) IsMember(id string) bool { return s.isMember(id) }

// IsAdmin reports whether id is currently an admin.
func (s *State) IsAdmin(id string) bool { return s.isAdmin(id) }
