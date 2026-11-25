// Package wire holds the shapes that travel between the server and its
// clients (docs/protocol.md): request and response bodies, and WebSocket
// messages. The server and the bot SDK both compile against them, so the two
// can't disagree about a field. (The TypeScript app has its own copies.)
package wire

import "github.com/canavan-a/super-chat/shared/proto"

// Batch is a set of events appended together: POST /v1/rooms,
// /v1/rooms/:id/events and /v1/invites/:id/join.
type Batch struct {
	Events []proto.SignedEvent `json:"events"`
	// Envelopes is the new epoch key sealed to each member, when the batch
	// holds an epoch event (at most one per batch).
	Envelopes map[string]string `json:"envelopes,omitempty"`
	// Preview is the encrypted invite preview, required when the batch
	// creates an invite (at most one per batch).
	Preview string `json:"preview,omitempty"`
}

// Message is a stored message as the server returns it.
type Message struct {
	Pos       int64  `json:"pos"`
	ID        string `json:"id"`
	Room      string `json:"room"`
	Epoch     int64  `json:"epoch"`
	Sender    string `json:"sender"`
	Kind      string `json:"kind"`
	Ct        string `json:"ct"`
	CreatedAt int64  `json:"createdAt"`
}

// Message kinds, as the server sees them (plaintext, so it can count unread
// messages without decrypting anything).
const (
	KindMsg      = "msg"
	KindReaction = "reaction"
	KindReceipt  = "receipt"
	KindCall     = "call"
	KindEdit     = "edit"
)

// Head is the latest event in a room's log.
type Head struct {
	Seq  int64  `json:"seq"`
	Hash string `json:"hash"`
}

// StoredEvent is a log event as the server returns it: the signed event plus
// its place in the log and hash.
type StoredEvent struct {
	Seq  int64  `json:"seq"`
	Hash string `json:"hash"`
	Body string `json:"body"`
	Sig  string `json:"sig"`
}

// Signed is the event in the form proto.ParseEvent takes.
func (e StoredEvent) Signed() proto.SignedEvent {
	return proto.SignedEvent{Body: e.Body, Sig: e.Sig}
}

// StoredEnvelope is one epoch's key sealed to the caller.
type StoredEnvelope struct {
	Epoch  int64  `json:"epoch"`
	Sealed string `json:"sealed"`
}

// Error is every non-2xx body. Head is set on a 409 conflict, so the client
// can refetch from there and retry.
type Error struct {
	Error string `json:"error"`
	Head  *Head  `json:"head,omitempty"`
}

// ---- requests and responses ----

// CreateRoomResponse answers POST /v1/rooms.
type CreateRoomResponse struct {
	ID   string `json:"id"`
	Head Head   `json:"head"`
}

// HeadResponse answers POST /v1/rooms/:id/events.
type HeadResponse struct {
	Head Head `json:"head"`
}

// RoomState answers GET /v1/rooms/:id/state?since=<seq>. LastPos and LastAt
// are the position and time of the room's latest msg.
type RoomState struct {
	Events  []StoredEvent `json:"events"`
	LastPos int64         `json:"lastPos"`
	LastAt  int64         `json:"lastAt"`
}

// Keys answers GET /v1/rooms/:id/keys: the caller's envelopes, by epoch.
type Keys struct {
	Envelopes []StoredEnvelope `json:"envelopes"`
}

// Messages answers GET /v1/rooms/:id/messages, always oldest first.
type Messages struct {
	Messages []Message `json:"messages"`
}

// PostMessage is the body of POST /v1/rooms/:id/messages.
type PostMessage struct {
	ID    string   `json:"id"`
	Epoch int64    `json:"epoch"`
	Kind  string   `json:"kind"`
	Ct    string   `json:"ct"`
	Blobs []string `json:"blobs"`
}

// PostMessageResponse answers it.
type PostMessageResponse struct {
	Pos       int64 `json:"pos"`
	CreatedAt int64 `json:"createdAt"`
}

// Unread answers GET /v1/rooms/:id/unread?after=<pos>.
type Unread struct {
	ReadPos int64 `json:"readPos"`
	Count   int64 `json:"count"`
}

// BlobID answers PUT /v1/rooms/:id/blobs.
type BlobID struct {
	ID string `json:"id"`
}

// BlobRef is the body of PUT /v1/rooms/:id/avatar and /picture ("" clears
// it), and of PUT /v1/vault/:id and its answer to GET.
type BlobRef struct {
	Blob string `json:"blob"`
}

// Invite answers GET /v1/invites/:id (unsigned): the room, the sealed
// preview, and the whole log, which the joiner replays to learn who to seal
// the new epoch to without trusting the server's word for it.
type Invite struct {
	Room    string        `json:"room"`
	Preview string        `json:"preview"`
	Events  []StoredEvent `json:"events"`
}

// JoinResponse answers POST /v1/invites/:id/join.
type JoinResponse struct {
	Room string `json:"room"`
	Head Head   `json:"head"`
}

// ---- WebSocket (/v1/ws) ----

// WebSocket message types.
const (
	WSChallenge  = "challenge"
	WSSub        = "sub"
	WSSubscribed = "subscribed"
	WSEvent      = "event"
	WSMessage    = "message"
	WSDeleted    = "deleted"
	WSTyping     = "typing"
	WSRemoved    = "removed"
	WSRTC        = "rtc"
)

// ClientWS is everything a client sends: {"type":"sub","subs":[…]},
// {"type":"typing","room"} or {"type":"rtc","room","to"?,"box"}.
type ClientWS struct {
	Type string `json:"type"`
	Room string `json:"room,omitempty"`
	Subs []Sub  `json:"subs,omitempty"`
	To   string `json:"to,omitempty"`
	Box  string `json:"box,omitempty"`
}

// Sub subscribes a socket to one room, signed by that room's member key over
// the challenge nonce (crypto.SubscribeSig).
type Sub struct {
	Room   string `json:"room"`
	Member string `json:"member"`
	Sig    string `json:"sig"`
}

// ServerWS is any server → client message, for clients to decode; Type
// says which fields are set.
type ServerWS struct {
	Type     string       `json:"type"`
	Room     string       `json:"room"`
	Nonce    string       `json:"nonce"`    // challenge
	Rooms    []string     `json:"rooms"`    // subscribed
	Rejected []string     `json:"rejected"` // subscribed
	Event    *StoredEvent `json:"event"`    // event
	Message  *Message     `json:"message"`  // message
	IDs      []string     `json:"ids"`      // deleted
	Member   string       `json:"member"`   // typing
	From     string       `json:"from"`     // rtc
	To       string       `json:"to"`       // rtc, when sent to us alone
	Box      string       `json:"box"`      // rtc
}

// The server's side: one type per message, so each carries exactly its fields.
type (
	Challenge struct {
		Type  string `json:"type"`
		Nonce string `json:"nonce"`
	}
	Subscribed struct {
		Type     string   `json:"type"`
		Rooms    []string `json:"rooms"`
		Rejected []string `json:"rejected"`
	}
	EventPush struct {
		Type  string      `json:"type"`
		Room  string      `json:"room"`
		Event StoredEvent `json:"event"`
	}
	MessagePush struct {
		Type    string  `json:"type"`
		Room    string  `json:"room"`
		Message Message `json:"message"`
	}
	Deleted struct {
		Type string   `json:"type"`
		Room string   `json:"room"`
		IDs  []string `json:"ids"`
	}
	Typing struct {
		Type   string `json:"type"`
		Room   string `json:"room"`
		Member string `json:"member"`
	}
	Removed struct {
		Type string `json:"type"`
		Room string `json:"room"`
	}
	RTC struct {
		Type string `json:"type"`
		Room string `json:"room"`
		From string `json:"from"`
		To   string `json:"to,omitempty"`
		Box  string `json:"box"`
	}
)
