package crypto

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/canavan-a/super-chat/shared/proto"
	"github.com/canavan-a/super-chat/shared/wire"
)

// NewEvent is an event to sign on top of a room's log.
type NewEvent struct {
	Kind string
	Pub  any // nil is {}
	// Enc is encrypted under EncKey, the key of epoch EncEpoch.
	Enc      any
	EncEpoch int64
	EncKey   []byte
}

// EncAD is the associated data an event's enc payload is sealed with.
func EncAD(room string, epoch int64, author, kind string) []byte {
	return []byte("sc-evt|" + room + "|" + strconv.FormatInt(epoch, 10) + "|" + author + "|" + kind)
}

// BuildEvents signs a run of events on top of s, applying each to a copy of
// s so the batch is checked locally before the server sees it. It returns the
// signed events and the state after them; s itself is left alone.
func BuildEvents(me Signer, s *proto.State, evs []NewEvent, now int64) ([]proto.SignedEvent, *proto.State, error) {
	st := s.Clone()
	signed := make([]proto.SignedEvent, 0, len(evs))
	for _, ne := range evs {
		var enc string
		var epoch int64
		if ne.Enc != nil {
			if ne.EncKey == nil || ne.EncEpoch == 0 {
				return nil, nil, errors.New("enc needs a key")
			}
			plain, err := marshal(ne.Enc)
			if err != nil {
				return nil, nil, err
			}
			epoch = ne.EncEpoch
			enc = B64.EncodeToString(AEADSeal(ne.EncKey, plain, EncAD(st.Room, epoch, me.MemberID(), ne.Kind)))
		}
		pub := json.RawMessage("{}")
		if ne.Pub != nil {
			raw, err := marshal(ne.Pub)
			if err != nil {
				return nil, nil, err
			}
			pub = raw
		}
		raw, err := marshal(proto.EventBody{
			V: 1, Room: st.Room, Seq: st.NextSeq, Prev: st.Head, Author: me.MemberID(),
			Ts: now, Kind: ne.Kind, Pub: pub, Epoch: epoch, Enc: enc,
		})
		if err != nil {
			return nil, nil, err
		}
		se := proto.SignedEvent{
			Body: B64.EncodeToString(raw),
			Sig:  B64.EncodeToString(Sign(me.PrivateKey(), "sc-evt", raw)),
		}
		e, err := proto.ParseEvent(se)
		if err != nil {
			return nil, nil, err
		}
		if err := st.Apply(e, now); err != nil {
			return nil, nil, fmt.Errorf("%s: %w", ne.Kind, err)
		}
		signed = append(signed, se)
	}
	return signed, st, nil
}

// OpenEnc decrypts an event's enc payload into v with the key of its epoch.
func OpenEnc(e *proto.Event, key []byte, v any) error {
	if e.Enc == "" {
		return errors.New("event has no enc")
	}
	sealed, err := B64.DecodeString(e.Enc)
	if err != nil {
		return err
	}
	plain, err := AEADOpen(key, sealed, EncAD(e.Room, e.Epoch, e.Author, e.Kind))
	if err != nil {
		return err
	}
	return json.Unmarshal(plain, v)
}

// ---- epochs ----

func envAD(room string, epoch int64, member string) []byte {
	return []byte("sc-env|" + room + "|" + strconv.FormatInt(epoch, 10) + "|" + member)
}

// Epoch is a new room key: the event announcing it and the key sealed to
// every member.
type Epoch struct {
	Event     NewEvent
	Envelopes map[string]string
	Key       []byte
	N         int64
}

// NewEpoch makes the next epoch for s, sealed to each member's X25519 key as
// the log published it. snapshot, if not nil, goes in the event's enc (room
// name, color, picture and everyone's display names) so later joiners see it.
func NewEpoch(s *proto.State, snapshot any) (*Epoch, error) {
	n := s.Epoch + 1
	key := RandomBytes(32)
	recipients := s.SortedMembers()
	envelopes := make(map[string]string, len(recipients))
	for _, id := range recipients {
		xPub, err := B64.DecodeString(s.Keys[id])
		if err != nil || len(xPub) != 32 {
			return nil, fmt.Errorf("no key for member %s", id)
		}
		sealed, err := Seal(xPub, key, envAD(s.Room, n, id))
		if err != nil {
			return nil, err
		}
		envelopes[id] = B64.EncodeToString(sealed)
	}
	ne := NewEvent{
		Kind: "epoch",
		Pub:  proto.EpochPub{Epoch: n, Recipients: recipients, Commit: proto.EpochCommit(s.Room, n, key)},
	}
	if snapshot != nil {
		ne.Enc, ne.EncEpoch, ne.EncKey = snapshot, n, key
	}
	return &Epoch{Event: ne, Envelopes: envelopes, Key: key, N: n}, nil
}

// OpenEnvelope opens our envelope for an epoch and checks the key against the
// commit in the signed epoch event.
func OpenEnvelope(me *Member, room string, epoch int64, sealed, commit string) ([]byte, error) {
	raw, err := B64.DecodeString(sealed)
	if err != nil {
		return nil, err
	}
	key, err := Unseal(me.XPriv, me.XPub, raw, envAD(room, epoch, me.ID))
	if err != nil {
		return nil, err
	}
	if proto.EpochCommit(room, epoch, key) != commit {
		return nil, errors.New("epoch key does not match its commitment")
	}
	return key, nil
}

// ---- rooms ----

// RoomMeta is a room's name and color, as the meta event and snapshots carry them.
type RoomMeta struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

// Snapshot is what a rotator that knows the room puts in an epoch's enc.
type Snapshot struct {
	Name     string            `json:"name,omitempty"`
	Color    string            `json:"color,omitempty"`
	Picture  json.RawMessage   `json:"picture,omitempty"`
	Profiles map[string]string `json:"profiles,omitempty"`
}

// Profile is a profile event's enc. Avatar is raw because it's three-way:
// absent leaves the picture alone, null removes it, an AvatarRef sets it.
type Profile struct {
	DisplayName string          `json:"displayName,omitempty"`
	Avatar      json.RawMessage `json:"avatar,omitempty"`
}

// AvatarRef is a profile or group picture: a sealed blob and its key.
type AvatarRef struct {
	Blob string `json:"blob"`
	Key  string `json:"key"`
	At   int64  `json:"at"`
}

// CreateRoom builds POST /v1/rooms: create, the first epoch, meta and our profile.
func CreateRoom(e Entropy, meta RoomMeta, displayName string, retentionDays int, now int64) (room string, b *wire.Batch, key []byte, me *Member, err error) {
	room = proto.NewID()
	me = MemberIdentity(e, room)
	first, s1, err := BuildEvents(me, proto.NewState(room), []NewEvent{
		{Kind: "create", Pub: proto.CreatePub{RetentionDays: retentionDays, X25519: B64.EncodeToString(me.XPub)}},
	}, now)
	if err != nil {
		return
	}
	ep, err := NewEpoch(s1, Snapshot{Name: meta.Name, Color: meta.Color, Profiles: map[string]string{me.ID: displayName}})
	if err != nil {
		return
	}
	rest, _, err := BuildEvents(me, s1, []NewEvent{
		ep.Event,
		{Kind: "meta", Enc: meta, EncEpoch: ep.N, EncKey: ep.Key},
		{Kind: "profile", Enc: Profile{DisplayName: displayName}, EncEpoch: ep.N, EncKey: ep.Key},
	}, now)
	if err != nil {
		return
	}
	return room, &wire.Batch{Events: append(first, rest...), Envelopes: ep.Envelopes}, ep.Key, me, nil
}
