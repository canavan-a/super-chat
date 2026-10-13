// Package rooms owns each room's log: it replays it into a proto.State,
// validates and appends new events, and keeps the derived tables (members,
// envelopes, invites) in step, all in one transaction per batch.
package rooms

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"main/database"
	"main/proto"
)

// Service serializes writes per room and caches each room's replayed state.
type Service struct {
	DB      *gorm.DB
	BlobDir string
	Now     func() time.Time

	mu     sync.Mutex
	states map[string]*proto.State
	locks  map[string]*sync.Mutex
	// OnEvent is called after a batch commits, once per event, so the
	// WebSocket hub can fan it out.
	OnEvent func(room string, ev database.Event, st *proto.State)
	// OnRemoved is called for each member who left or was removed.
	OnRemoved func(room, member string)
	// OnDeleted is called with the IDs of messages a delete event removed.
	OnDeleted func(room string, ids []string)
}

func NewService(db *gorm.DB, blobDir string) *Service {
	return &Service{DB: db, BlobDir: blobDir, Now: time.Now, states: map[string]*proto.State{}, locks: map[string]*sync.Mutex{}}
}

func (s *Service) nowMs() int64 { return s.Now().UnixMilli() }

func (s *Service) lock(room string) func() {
	s.mu.Lock()
	l, ok := s.locks[room]
	if !ok {
		l = &sync.Mutex{}
		s.locks[room] = l
	}
	s.mu.Unlock()
	l.Lock()
	return l.Unlock
}

// State returns the room's current state, or nil if the room doesn't exist.
func (s *Service) State(room string) (*proto.State, error) {
	s.mu.Lock()
	st, ok := s.states[room]
	s.mu.Unlock()
	if ok {
		return st.Clone(), nil
	}
	var evs []database.Event
	if err := s.DB.Where("room_id = ?", room).Order("seq").Find(&evs).Error; err != nil {
		return nil, err
	}
	if len(evs) == 0 {
		return nil, nil
	}
	st = proto.NewState(room)
	for _, row := range evs {
		e, err := proto.ParseEvent(proto.SignedEvent{Body: row.Body, Sig: row.Sig})
		if err != nil {
			return nil, fmt.Errorf("room %s seq %d: %w", room, row.Seq, err)
		}
		if err := st.Apply(e, 0); err != nil {
			return nil, fmt.Errorf("room %s seq %d: %w", room, row.Seq, err)
		}
	}
	s.mu.Lock()
	s.states[room] = st
	s.mu.Unlock()
	return st.Clone(), nil
}

// Forget drops a room's cached state (after it's deleted).
func (s *Service) Forget(room string) {
	s.mu.Lock()
	delete(s.states, room)
	s.mu.Unlock()
}

// Batch is a set of events appended together.
type Batch struct {
	Events    []proto.SignedEvent `json:"events"`
	Envelopes map[string]string   `json:"envelopes"`
	// Preview is the encrypted invite preview, required when the batch
	// creates an invite (at most one per batch).
	Preview string `json:"preview"`
}

// Error is a validation failure the caller should see. Status is the HTTP
// status to answer with.
type Error struct {
	Status int
	Msg    string
	Head   *Head
}

type Head struct {
	Seq  int64  `json:"seq"`
	Hash string `json:"hash"`
}

func (e *Error) Error() string { return e.Msg }

func bad(msg string) *Error { return &Error{Status: 400, Msg: msg} }

// Rules a caller adds on top of the log's own.
type Rules struct {
	// Creating requires the first event to be create (POST /v1/rooms).
	Creating bool
	// Joining requires the first event to be a join by the caller.
	Joining bool
	// Caller is the member who signed the request; every event must be by it.
	Caller string
}

// Append validates b against the room's state and commits it.
func (s *Service) Append(room string, b Batch, r Rules) (*proto.State, error) {
	if len(b.Events) == 0 || len(b.Events) > 8 {
		return nil, bad("a batch has 1 to 8 events")
	}
	if !proto.IsID(room) {
		return nil, bad("bad room id")
	}
	unlock := s.lock(room)
	defer unlock()

	st, err := s.State(room)
	if err != nil {
		return nil, err
	}
	if r.Creating && st != nil {
		return nil, &Error{Status: 409, Msg: "room exists"}
	}
	if !r.Creating && st == nil {
		return nil, &Error{Status: 404, Msg: "no such room"}
	}
	if st == nil {
		st = proto.NewState(room)
	}
	before := st.Clone()
	now := s.nowMs()

	var evs []*proto.Event
	var epochEv *proto.EpochPub
	var invite *proto.InvitePub
	var joinInvite string
	var deletes []proto.DeletePub
	wipe := false
	for i, se := range b.Events {
		e, err := proto.ParseEvent(se)
		if err != nil {
			return nil, bad(err.Error())
		}
		if e.Author != r.Caller {
			return nil, &Error{Status: 403, Msg: "events must be signed by the caller"}
		}
		if i == 0 && r.Creating && e.Kind != "create" {
			return nil, bad("first event must be create")
		}
		if i == 0 && r.Joining && e.Kind != "join" {
			return nil, bad("first event must be join")
		}
		if i == 0 && !r.Joining && !st.IsMember(r.Caller) && !r.Creating {
			return nil, &Error{Status: 403, Msg: "not a member"}
		}
		if err := st.Apply(e, now); err != nil {
			if errors.Is(err, proto.ErrConflict) {
				return nil, &Error{Status: 409, Msg: "conflict", Head: &Head{Seq: before.NextSeq, Hash: before.Head}}
			}
			return nil, &Error{Status: 403, Msg: err.Error()}
		}
		switch e.Kind {
		case "epoch":
			if epochEv != nil {
				return nil, bad("one epoch per batch")
			}
			var p proto.EpochPub
			_ = json.Unmarshal(e.Pub, &p)
			epochEv = &p
		case "invite":
			if invite != nil {
				return nil, bad("one invite per batch")
			}
			var p proto.InvitePub
			_ = json.Unmarshal(e.Pub, &p)
			invite = &p
		case "join":
			var p proto.JoinPub
			_ = json.Unmarshal(e.Pub, &p)
			joinInvite = p.Invite
		case "delete":
			var p proto.DeletePub
			_ = json.Unmarshal(e.Pub, &p)
			deletes = append(deletes, p)
		case "wipe":
			wipe = true
		}
		evs = append(evs, e)
	}

	if epochEv != nil {
		if len(b.Envelopes) != len(epochEv.Recipients) {
			return nil, bad("one envelope per recipient")
		}
		for _, id := range epochEv.Recipients {
			if v, ok := b.Envelopes[id]; !ok || len(v) == 0 || len(v) > 512 {
				return nil, bad("missing envelope for " + id)
			}
		}
	} else if len(b.Envelopes) > 0 {
		return nil, bad("envelopes without an epoch")
	}
	if invite != nil && (b.Preview == "" || len(b.Preview) > 4096) {
		return nil, bad("an invite needs a preview")
	}
	// Whoever causes a membership change and is still in the room rotates
	// the key in the same batch, so nobody waits on another member to come
	// online. (Someone who leaves can't, so the remaining members do.)
	if st.PendingRotation && !before.PendingRotation && st.IsMember(r.Caller) {
		return nil, bad("rotate the epoch in the same batch")
	}
	if r.Creating && st.Epoch == 0 {
		return nil, bad("a new room needs its first epoch")
	}

	var deletedIDs []string
	var deletedBlobs []string
	err = s.DB.Transaction(func(tx *gorm.DB) error {
		if r.Creating {
			if err := tx.Create(&database.Room{ID: room, CreatedAt: now}).Error; err != nil {
				return err
			}
		}
		rows := make([]database.Event, len(evs))
		for i, e := range evs {
			se := e.Signed()
			rows[i] = database.Event{RoomID: room, Seq: e.Seq, Hash: e.Hash, Body: se.Body, Sig: se.Sig}
		}
		if err := tx.Create(&rows).Error; err != nil {
			return err
		}
		if err := tx.Model(&database.Room{}).Where("id = ?", room).
			Updates(map[string]any{"retention_days": st.RetentionDays, "epoch": st.Epoch}).Error; err != nil {
			return err
		}
		if err := syncMembers(tx, room, before, st, now); err != nil {
			return err
		}
		if epochEv != nil {
			envs := make([]database.Envelope, 0, len(b.Envelopes))
			for id, sealed := range b.Envelopes {
				envs = append(envs, database.Envelope{RoomID: room, Epoch: epochEv.Epoch, MemberID: id, Sealed: sealed})
			}
			if err := tx.Create(&envs).Error; err != nil {
				return err
			}
			if err := tx.Model(&database.Member{}).Where("room_id = ? AND first_epoch = 0", room).
				Update("first_epoch", epochEv.Epoch).Error; err != nil {
				return err
			}
		}
		if invite != nil {
			if err := tx.Create(&database.Invite{ID: invite.ID, RoomID: room, Preview: b.Preview, CreatedAt: now}).Error; err != nil {
				return err
			}
		}
		if joinInvite != "" {
			if err := tx.Create(&database.InviteUse{InviteID: joinInvite, RoomID: room, MemberID: r.Caller, UsedAt: now}).Error; err != nil {
				return err
			}
		}
		if wipe {
			// Every message so far, and its attachments; avatars aren't
			// attached to messages and stay.
			var ids []string
			if err := tx.Model(&database.Message{}).Where("room_id = ?", room).Pluck("id", &ids).Error; err != nil {
				return err
			}
			var blobs []string
			if err := tx.Model(&database.Blob{}).Where("room_id = ? AND message_id IS NOT NULL", room).Pluck("id", &blobs).Error; err != nil {
				return err
			}
			if err := tx.Where("room_id = ? AND message_id IS NOT NULL", room).Delete(&database.Blob{}).Error; err != nil {
				return err
			}
			if err := tx.Where("room_id = ?", room).Delete(&database.Message{}).Error; err != nil {
				return err
			}
			deletedIDs = append(deletedIDs, ids...)
			deletedBlobs = append(deletedBlobs, blobs...)
		}
		for _, d := range deletes {
			res := tx.Where("room_id = ? AND id = ? AND sender = ?", room, d.Msg, d.Sender).Delete(&database.Message{})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected > 0 {
				deletedIDs = append(deletedIDs, d.Msg)
				var ids []string
				if err := tx.Model(&database.Blob{}).Where("message_id = ?", d.Msg).Pluck("id", &ids).Error; err != nil {
					return err
				}
				if err := tx.Where("message_id = ?", d.Msg).Delete(&database.Blob{}).Error; err != nil {
					return err
				}
				deletedBlobs = append(deletedBlobs, ids...)
			}
		}
		return nil
	})
	if err != nil {
		s.Forget(room)
		return nil, err
	}
	s.mu.Lock()
	s.states[room] = st.Clone()
	s.mu.Unlock()
	s.RemoveBlobFiles(deletedBlobs)

	for i, e := range evs {
		if s.OnEvent != nil {
			se := e.Signed()
			s.OnEvent(room, database.Event{RoomID: room, Seq: evs[i].Seq, Hash: e.Hash, Body: se.Body, Sig: se.Sig}, st)
		}
	}
	if s.OnRemoved != nil {
		for id := range before.Members {
			if !st.IsMember(id) {
				s.OnRemoved(room, id)
			}
		}
	}
	if len(deletedIDs) > 0 && s.OnDeleted != nil {
		s.OnDeleted(room, deletedIDs)
	}
	return st.Clone(), nil
}

func syncMembers(tx *gorm.DB, room string, before, after *proto.State, now int64) error {
	for id := range before.Members {
		if !after.IsMember(id) {
			if err := tx.Where("room_id = ? AND member_id = ?", room, id).Delete(&database.Member{}).Error; err != nil {
				return err
			}
		}
	}
	for id, role := range after.Members {
		if _, was := before.Members[id]; !was {
			m := database.Member{RoomID: room, MemberID: id, Role: role}
			if err := tx.Clauses(clause.OnConflict{UpdateAll: true}).Create(&m).Error; err != nil {
				return err
			}
		} else if before.Members[id] != role {
			if err := tx.Model(&database.Member{}).Where("room_id = ? AND member_id = ?", room, id).Update("role", role).Error; err != nil {
				return err
			}
		}
	}
	return nil
}

// BlobPath is where a blob's bytes live on disk.
func (s *Service) BlobPath(id string) string { return filepath.Join(s.BlobDir, id) }

// RemoveBlobFiles deletes blob files, ignoring ones already gone.
func (s *Service) RemoveBlobFiles(ids []string) {
	for _, id := range ids {
		_ = os.Remove(s.BlobPath(id))
	}
}

// DeleteRoom removes a room and everything in it.
func (s *Service) DeleteRoom(room string) error {
	unlock := s.lock(room)
	defer unlock()
	var blobIDs []string
	if err := s.DB.Model(&database.Blob{}).Where("room_id = ?", room).Pluck("id", &blobIDs).Error; err != nil {
		return err
	}
	if err := s.DB.Where("id = ?", room).Delete(&database.Room{}).Error; err != nil {
		return err
	}
	s.RemoveBlobFiles(blobIDs)
	s.Forget(room)
	return nil
}
