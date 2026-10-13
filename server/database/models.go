package database

import (
	"errors"

	"gorm.io/gorm"
)

type Room struct {
	ID            string `gorm:"primaryKey"`
	RetentionDays int
	Epoch         int64
	CreatedAt     int64 `gorm:"autoCreateTime:false"`
}

type Member struct {
	RoomID     string `gorm:"primaryKey"`
	MemberID   string `gorm:"primaryKey"`
	Role       string
	FirstEpoch int64
}

type Event struct {
	RoomID string `gorm:"primaryKey" json:"-"`
	Seq    int64  `gorm:"primaryKey" json:"seq"`
	Hash   string `json:"hash"`
	Body   string `json:"body"`
	Sig    string `json:"sig"`
}

type Envelope struct {
	RoomID   string `gorm:"primaryKey" json:"-"`
	Epoch    int64  `gorm:"primaryKey" json:"epoch"`
	MemberID string `gorm:"primaryKey" json:"-"`
	Sealed   string `json:"sealed"`
}

type Invite struct {
	ID        string `gorm:"primaryKey"`
	RoomID    string
	Preview   string
	CreatedAt int64 `gorm:"autoCreateTime:false"`
}

type InviteUse struct {
	InviteID string `json:"invite"`
	RoomID   string `json:"-"`
	MemberID string `json:"member"`
	UsedAt   int64  `json:"usedAt"`
}

type Message struct {
	Pos       int64  `gorm:"primaryKey;autoIncrement" json:"pos"`
	ID        string `json:"id"`
	RoomID    string `json:"room"`
	Epoch     int64  `json:"epoch"`
	Sender    string `json:"sender"`
	Kind      string `json:"kind"`
	Ct        string `json:"ct"`
	CreatedAt int64  `gorm:"autoCreateTime:false" json:"createdAt"`
}

type Blob struct {
	ID        string `gorm:"primaryKey"`
	RoomID    string
	Uploader  string
	MessageID *string
	Size      int64
	CreatedAt int64 `gorm:"autoCreateTime:false"`
}

type Vault struct {
	ID   string `gorm:"primaryKey"`
	Pub  string
	Blob string
}

// First returns the first row matching the query, or nil if there's none.
func First[T any](q *gorm.DB) (*T, error) {
	var v T
	err := q.First(&v).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}
