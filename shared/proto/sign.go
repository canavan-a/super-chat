package proto

import (
	"crypto/ed25519"
	"encoding/json"
)

// The helpers below build signed objects the way a client does. The server
// itself never signs anything; they exist for tests and tooling.

// SignEvent marshals b and signs it with priv.
func SignEvent(priv ed25519.PrivateKey, b EventBody) SignedEvent {
	b.V = 1
	if b.Pub == nil {
		b.Pub = json.RawMessage("{}")
	}
	raw, err := json.Marshal(b)
	if err != nil {
		panic(err)
	}
	sig := ed25519.Sign(priv, append([]byte("sc-evt"), raw...))
	return SignedEvent{Body: B64.EncodeToString(raw), Sig: B64.EncodeToString(sig)}
}

// MustPub marshals a pub payload.
func MustPub(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return raw
}
