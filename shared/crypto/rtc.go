package crypto

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/canavan-a/super-chat/shared/proto"
)

// Voice-room signaling (docs/protocol.md, "Voice rooms"). The server relays
// these boxes without storing them; sealing them under the epoch key and
// signing the inside keeps it from reading or forging SDP, which is what
// would let it sit in the middle of a call.

// Signal kinds.
const (
	SigProbe  = "probe"
	SigJoin   = "join"
	SigHere   = "here"
	SigFull   = "full"
	SigOffer  = "offer"
	SigAnswer = "answer"
	SigICE    = "ice"
	SigLeave  = "leave"
	SigBeat   = "beat"
)

// SignalMaxSkewMs is how far a signal's ts may be from our clock before it's
// dropped as a replay.
const SignalMaxSkewMs = 60_000

// Signal is one voice signaling message.
type Signal struct {
	Sid   string          `json:"sid"`
	ToSid string          `json:"to_sid,omitempty"`
	K     string          `json:"k"`
	SDP   string          `json:"sdp,omitempty"`
	Cand  json.RawMessage `json:"cand,omitempty"`
	Muted bool            `json:"muted"`
	Deaf  bool            `json:"deaf"`
}

type innerSignal struct {
	V int `json:"v"`
	Signal
	Ts int64 `json:"ts"`
}

func rtcAD(room string, epoch int64, from, to string) []byte {
	return []byte("sc-rtc|" + room + "|" + strconv.FormatInt(epoch, 10) + "|" + from + "|" + to)
}

func rtcSigMsg(room, to string, inner []byte) []byte {
	return concat([]byte("sc-rtc|"+room+"|"+to+"|"), inner)
}

// SealSignal makes a box for {"type":"rtc"}: "<epoch>.<b64>". to is a member
// ID, or "" to broadcast.
func SealSignal(me *Member, room string, epoch int64, key []byte, to string, s Signal, now int64) (string, error) {
	inner, err := marshal(innerSignal{V: 1, Signal: s, Ts: now})
	if err != nil {
		return "", err
	}
	outer, err := marshal(sealedOuter{
		C: B64.EncodeToString(inner),
		S: B64.EncodeToString(Sign(me.EdKey, "", rtcSigMsg(room, to, inner))),
	})
	if err != nil {
		return "", err
	}
	return strconv.FormatInt(epoch, 10) + "." + B64.EncodeToString(AEADSeal(key, outer, rtcAD(room, epoch, me.ID, to))), nil
}

// SignalEpoch is the epoch a box claims, so the caller can pick the key.
func SignalEpoch(box string) (int64, error) {
	head, _, ok := strings.Cut(box, ".")
	n, err := strconv.ParseInt(head, 10, 64)
	if !ok || err != nil || n < 0 {
		return 0, errors.New("bad signal box")
	}
	return n, nil
}

// OpenSignal opens a box the server says from sent (to is our member ID for a
// directed signal, "" for a broadcast). It fails unless the AEAD, the
// sender's signature and the timestamp all check out, and returns the
// signal with its ts.
func OpenSignal(room, from, to, box string, key []byte, now int64) (*Signal, int64, error) {
	epoch, err := SignalEpoch(box)
	if err != nil {
		return nil, 0, err
	}
	_, body, _ := strings.Cut(box, ".")
	sealed, err := B64.DecodeString(body)
	if err != nil {
		return nil, 0, err
	}
	plain, err := AEADOpen(key, sealed, rtcAD(room, epoch, from, to))
	if err != nil {
		return nil, 0, err
	}
	var outer sealedOuter
	if err := json.Unmarshal(plain, &outer); err != nil {
		return nil, 0, err
	}
	inner, err1 := B64.DecodeString(outer.C)
	sig, err2 := B64.DecodeString(outer.S)
	if err1 != nil || err2 != nil || !proto.Verify(from, "", rtcSigMsg(room, to, inner), sig) {
		return nil, 0, errors.New("bad signal signature")
	}
	var in innerSignal
	if err := json.Unmarshal(inner, &in); err != nil {
		return nil, 0, err
	}
	if in.V != 1 {
		return nil, 0, errors.New("unsupported signal version")
	}
	if d := now - in.Ts; d > SignalMaxSkewMs || d < -SignalMaxSkewMs {
		return nil, 0, errors.New("stale signal")
	}
	if in.Sid == "" || in.K == "" {
		return nil, 0, errors.New("bad signal")
	}
	return &in.Signal, in.Ts, nil
}
