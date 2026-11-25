// Package crypto is the client half of docs/protocol.md in Go: identity,
// sealing, the room log as a client builds it, messages, invites, blobs,
// voice signaling and the vault. It's the Go twin of app/src/crypto; the two
// must agree byte for byte (see interop_test.go). shared/proto holds the
// parts the server also needs (IDs, signature checks, the log's rules).
package crypto

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"

	"github.com/canavan-a/super-chat/shared/proto"
)

// B64 is unpadded base64url, the encoding of everything on the wire.
var B64 = proto.B64

// Salt is the HKDF salt for everything derived from an account or a secret.
var Salt = []byte("superchat/v1")

// HKDF is HKDF-SHA256 with the protocol's salt and a 32-byte output.
func HKDF(ikm []byte, info string) []byte {
	return hkdfSalt(ikm, Salt, info)
}

func hkdfSalt(ikm, salt []byte, info string) []byte {
	out := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, ikm, salt, []byte(info)), out); err != nil {
		panic(err)
	}
	return out
}

// RandomBytes returns n bytes from the system's CSPRNG.
func RandomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// AEADSeal is nonce(24) ‖ XChaCha20-Poly1305(key, nonce, plaintext, ad).
func AEADSeal(key, plaintext, ad []byte) []byte {
	a, err := chacha20poly1305.NewX(key)
	if err != nil {
		panic(err) // keys are always 32 bytes here
	}
	nonce := RandomBytes(chacha20poly1305.NonceSizeX)
	return a.Seal(nonce, nonce, plaintext, ad)
}

// AEADOpen fails if the ciphertext or its associated data was tampered with.
func AEADOpen(key, sealed, ad []byte) ([]byte, error) {
	if len(key) != chacha20poly1305.KeySize {
		return nil, errors.New("bad key")
	}
	if len(sealed) < chacha20poly1305.NonceSizeX+chacha20poly1305.Overhead {
		return nil, errors.New("ciphertext too short")
	}
	a, _ := chacha20poly1305.NewX(key)
	return a.Open(nil, sealed[:chacha20poly1305.NonceSizeX], sealed[chacha20poly1305.NonceSizeX:], ad)
}

// XPublic is the X25519 public key of priv.
func XPublic(priv []byte) []byte {
	pub, err := curve25519.X25519(priv, curve25519.Basepoint)
	if err != nil {
		panic(err)
	}
	return pub
}

// Seal encrypts msg to an X25519 public key with a one-off ephemeral key:
// eph.pub ‖ aead(HKDF(X25519(eph, recipient), salt=eph.pub‖recipient, "sc-seal-v1"), msg, ad).
func Seal(recipientXPub, msg, ad []byte) ([]byte, error) {
	eph := RandomBytes(32)
	ephPub := XPublic(eph)
	shared, err := curve25519.X25519(eph, recipientXPub)
	if err != nil {
		return nil, err
	}
	key := hkdfSalt(shared, concat(ephPub, recipientXPub), "sc-seal-v1")
	return concat(ephPub, AEADSeal(key, msg, ad)), nil
}

// Unseal opens what Seal made for the holder of xPriv (whose public key is xPub).
func Unseal(xPriv, xPub, sealed, ad []byte) ([]byte, error) {
	if len(sealed) < 32 {
		return nil, errors.New("sealed box too short")
	}
	ephPub := sealed[:32]
	shared, err := curve25519.X25519(xPriv, ephPub)
	if err != nil {
		return nil, err
	}
	key := hkdfSalt(shared, concat(ephPub, xPub), "sc-seal-v1")
	return AEADOpen(key, sealed[32:], ad)
}

// Sign is Ed25519 over domain ‖ msg.
func Sign(priv ed25519.PrivateKey, domain string, msg []byte) []byte {
	return ed25519.Sign(priv, concat([]byte(domain), msg))
}

func concat(parts ...[]byte) []byte {
	return bytes.Join(parts, nil)
}

// marshal is json.Marshal without HTML escaping, so text like "<@id>"
// (a mention) goes out as the app writes it, not as <@id>.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}
