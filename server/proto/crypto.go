// Package proto is the server's copy of docs/protocol.md: identifiers,
// signature checks and the room-log state machine. app/src/crypto is the
// client's copy; the two must agree byte for byte.
package proto

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

var (
	B64 = base64.RawURLEncoding
	b32 = base32.StdEncoding.WithPadding(base32.NoPadding)
)

// MemberID encodes an Ed25519 public key as a member ID. A member ID is a
// room-scoped pseudonym: each person has a different one in every room, all
// derived on their device from a key the server never sees.
func MemberID(pub ed25519.PublicKey) string {
	return strings.ToLower(b32.EncodeToString(pub))
}

// ParseMemberID returns the public key a member ID encodes.
func ParseMemberID(id string) (ed25519.PublicKey, error) {
	if len(id) != 52 || id != strings.ToLower(id) {
		return nil, errors.New("bad member id")
	}
	b, err := b32.DecodeString(strings.ToUpper(id))
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("bad member id")
	}
	return ed25519.PublicKey(b), nil
}

// Verify checks sig over domain‖msg by the member id.
func Verify(id string, domain string, msg []byte, sig []byte) bool {
	pub, err := ParseMemberID(id)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(pub, append([]byte(domain), msg...), sig)
}

// VerifyKey is Verify for a raw b64 public key (invite keys).
func VerifyKey(pubB64 string, msg []byte, sig []byte) bool {
	pub, err := B64.DecodeString(pubB64)
	if err != nil || len(pub) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(pub), msg, sig)
}

// RequestSigningString is what X-SC-Sig signs.
func RequestSigningString(method, pathQuery, ts, nonce string, body []byte) []byte {
	sum := sha256.Sum256(body)
	return []byte("SC1\n" + method + "\n" + pathQuery + "\n" + ts + "\n" + nonce + "\n" + hex.EncodeToString(sum[:]))
}

// IsID reports whether s is a 16-byte b64 identifier.
func IsID(s string) bool {
	b, err := B64.DecodeString(s)
	return err == nil && len(b) == 16
}

// NewID returns a fresh random 16-byte b64 identifier.
func NewID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return B64.EncodeToString(b)
}

// VaultID is the ID of the vault a key may write: 16 bytes of
// sha256("sc-vault" ‖ pub), in b64.
func VaultID(pub ed25519.PublicKey) string {
	h := sha256.Sum256(append([]byte("sc-vault"), pub...))
	return B64.EncodeToString(h[:16])
}
