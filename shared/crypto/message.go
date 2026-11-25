package crypto

import (
	"encoding/json"
	"errors"
	"strconv"

	"github.com/canavan-a/super-chat/shared/proto"
	"github.com/canavan-a/super-chat/shared/wire"
)

// Content is a message's content: one of the types below, chosen by T.
// Fields that don't belong to T are left empty.
type Content struct {
	T string `json:"t"`

	// text, file, edit
	Body    string    `json:"body,omitempty"`
	ReplyTo string    `json:"replyTo,omitempty"`
	Files   []FileRef `json:"files,omitempty"`

	// reaction, edit
	Target string `json:"target,omitempty"`
	Emoji  string `json:"emoji,omitempty"`
	Remove bool   `json:"remove,omitempty"`

	// receipt
	UpTo string `json:"upTo,omitempty"`

	// ice: a STUN/TURN server someone shared for voice
	Server *ICEServer `json:"server,omitempty"`

	// call: someone joined or left the room's voice
	Action string `json:"action,omitempty"`
}

// Content types.
const (
	TypeText     = "text"
	TypeFile     = "file"
	TypeReaction = "reaction"
	TypeReceipt  = "receipt"
	TypeEdit     = "edit"
	TypeICE      = "ice"
	TypeCall     = "call"
)

// FileRef is an attachment: a sealed blob and the key to open it.
type FileRef struct {
	Blob string `json:"blob"`
	Key  string `json:"key"`
	Name string `json:"name"`
	Mime string `json:"mime"`
	Size int64  `json:"size"`
	W    int    `json:"w,omitempty"`
	H    int    `json:"h,omitempty"`
	// A video or voice message's length, in seconds.
	Dur float64 `json:"dur,omitempty"`
	// A voice message's loudness over time, as bars 0–15.
	Wave []int `json:"wave,omitempty"`
	// A video's poster frame: a small JPEG in its own blob.
	Thumb *FileRef `json:"thumb,omitempty"`
}

// ICEServer is a STUN/TURN server as an ice message shares it.
type ICEServer struct {
	URLs       string `json:"urls"`
	Username   string `json:"username,omitempty"`
	Credential string `json:"credential,omitempty"`
}

// ServerKind is the plaintext kind the server files a message under.
func ServerKind(c *Content) string {
	switch c.T {
	case TypeReaction:
		return wire.KindReaction
	case TypeReceipt:
		return wire.KindReceipt
	case TypeCall:
		return wire.KindCall
	case TypeEdit:
		return wire.KindEdit
	}
	return wire.KindMsg
}

func msgAD(room string, epoch int64, id, sender string) []byte {
	return []byte("sc-msg|" + room + "|" + strconv.FormatInt(epoch, 10) + "|" + id + "|" + sender)
}

func msgSigMsg(room, id string, inner []byte) []byte {
	return concat([]byte("sc-msg|"+room+"|"+id+"|"), inner)
}

type sealedOuter struct {
	C string `json:"c"`
	S string `json:"s"`
}

// innerMsg is {"v":1, ...content, "ts"}, as the app writes it.
type innerMsg struct {
	V int `json:"v"`
	Content
	Ts int64 `json:"ts"`
}

// EncryptMessage seals content for POST /v1/rooms/:id/messages. id is a new
// message ID (proto.NewID), or the ID being replaced on a retry.
func EncryptMessage(me *Member, room string, epoch int64, key []byte, c Content, id string, now int64) (ct, kind string, err error) {
	inner, err := marshal(innerMsg{V: 1, Content: c, Ts: now})
	if err != nil {
		return "", "", err
	}
	outer, err := marshal(sealedOuter{
		C: B64.EncodeToString(inner),
		S: B64.EncodeToString(Sign(me.EdKey, "", msgSigMsg(room, id, inner))),
	})
	if err != nil {
		return "", "", err
	}
	return B64.EncodeToString(AEADSeal(key, outer, msgAD(room, epoch, id, me.ID))), ServerKind(&c), nil
}

// Decrypted is a message opened and checked.
type Decrypted struct {
	Content
	Ts int64
	// Raw is the whole inner JSON, for content types this package doesn't know.
	Raw json.RawMessage
}

// DecryptMessage opens a message and checks it: the AEAD proves it came from
// someone with the room key, the inner signature proves which member sent it,
// and the kind must match what the server filed it under.
func DecryptMessage(m *wire.Message, key []byte) (*Decrypted, error) {
	ct, err := B64.DecodeString(m.Ct)
	if err != nil {
		return nil, err
	}
	plain, err := AEADOpen(key, ct, msgAD(m.Room, m.Epoch, m.ID, m.Sender))
	if err != nil {
		return nil, err
	}
	var outer sealedOuter
	if err := json.Unmarshal(plain, &outer); err != nil {
		return nil, err
	}
	inner, err1 := B64.DecodeString(outer.C)
	sig, err2 := B64.DecodeString(outer.S)
	if err1 != nil || err2 != nil || !proto.Verify(m.Sender, "", msgSigMsg(m.Room, m.ID, inner), sig) {
		return nil, errors.New("bad message signature")
	}
	var in innerMsg
	if err := json.Unmarshal(inner, &in); err != nil {
		return nil, err
	}
	if in.V != 1 {
		return nil, errors.New("unsupported message version")
	}
	if ServerKind(&in.Content) != m.Kind {
		return nil, errors.New("message kind mismatch")
	}
	return &Decrypted{Content: in.Content, Ts: in.Ts, Raw: inner}, nil
}

// ---- blobs ----

var blobAD = []byte("sc-blob")

// EncryptBlob seals a file (or a picture) under a new key, for PUT /blobs.
func EncryptBlob(data []byte) (key, sealed []byte) {
	key = RandomBytes(32)
	return key, AEADSeal(key, data, blobAD)
}

// DecryptBlob opens a blob with the key its FileRef or AvatarRef carries.
func DecryptBlob(key, sealed []byte) ([]byte, error) {
	return AEADOpen(key, sealed, blobAD)
}
