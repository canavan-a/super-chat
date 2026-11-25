package crypto

import (
	"crypto/ed25519"
	"crypto/sha256"
	_ "embed"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/canavan-a/super-chat/shared/proto"
)

// Entropy is an account: 32 random bytes and nothing else. The recovery
// phrase is these bytes as 24 BIP-39 words. In each room the account appears
// as a different member (MemberIdentity), so no server can link its rooms.
type Entropy [32]byte

// NewEntropy makes a new account.
func NewEntropy() Entropy {
	var e Entropy
	copy(e[:], RandomBytes(32))
	return e
}

// Fingerprint tells accounts apart on one device. It's never sent anywhere.
func (e Entropy) Fingerprint() string {
	return proto.MemberID(ed25519.NewKeyFromSeed(HKDF(e[:], "fingerprint")).Public().(ed25519.PublicKey))
}

// Member is what an account is inside one room: a signing key and an
// encryption key, both derived from the entropy and the room ID.
type Member struct {
	ID    string // the member ID: the Ed25519 public key in base32
	EdKey ed25519.PrivateKey
	XPriv []byte
	XPub  []byte
}

// Signer is anything that signs events and requests.
type Signer interface {
	MemberID() string
	PrivateKey() ed25519.PrivateKey
}

func (m *Member) MemberID() string               { return m.ID }
func (m *Member) PrivateKey() ed25519.PrivateKey { return m.EdKey }

// MemberIdentity is the account's key pair in one room. It's deterministic,
// so every device with the phrase is the same member, and independent per
// room, so nobody without the phrase can tell two members are one person.
func MemberIdentity(e Entropy, room string) *Member {
	ed := ed25519.NewKeyFromSeed(HKDF(e[:], "room-ed25519|"+room))
	xPriv := HKDF(e[:], "room-x25519|"+room)
	return &Member{
		ID:    proto.MemberID(ed.Public().(ed25519.PublicKey)),
		EdKey: ed,
		XPriv: xPriv,
		XPub:  XPublic(xPriv),
	}
}

// ---- recovery phrase (BIP-39, English, 24 words) ----

//go:embed english.txt
var englishTxt string

var (
	wordlist  = strings.Fields(englishTxt)
	wordIndex = func() map[string]int {
		m := make(map[string]int, len(wordlist))
		for i, w := range wordlist {
			m[w] = i
		}
		return m
	}()
)

// Phrase is the entropy as 24 words: 256 bits plus an 8-bit checksum (the
// first byte of its SHA-256), 11 bits per word.
func (e Entropy) Phrase() []string {
	sum := sha256.Sum256(e[:])
	n := new(big.Int).SetBytes(append(e[:], sum[0]))
	words := make([]string, 24)
	mask := big.NewInt(2047)
	for i := 23; i >= 0; i-- {
		words[i] = wordlist[new(big.Int).And(n, mask).Int64()]
		n.Rsh(n, 11)
	}
	return words
}

// EntropyFromPhrase accepts any spacing and case, and errors with a message
// a person can act on, like the app's.
func EntropyFromPhrase(phrase string) (Entropy, error) {
	var e Entropy
	words := strings.Fields(strings.ToLower(phrase))
	if len(words) != 24 {
		return e, errors.New("a recovery phrase is 24 words")
	}
	var unknown []string
	n := new(big.Int)
	for _, w := range words {
		i, ok := wordIndex[w]
		if !ok {
			unknown = append(unknown, w)
			continue
		}
		n.Lsh(n, 11).Or(n, big.NewInt(int64(i)))
	}
	if len(unknown) > 0 {
		return e, fmt.Errorf("not in the word list: %s", strings.Join(unknown, ", "))
	}
	var raw [33]byte
	n.FillBytes(raw[:])
	copy(e[:], raw[:32])
	if sum := sha256.Sum256(e[:]); sum[0] != raw[32] {
		return Entropy{}, errors.New("those words don't check out; look for a typo or a swapped word")
	}
	return e, nil
}
