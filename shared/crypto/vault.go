package crypto

import (
	"crypto/ed25519"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/canavan-a/super-chat/shared/proto"
)

// The vault: an account's room list, kept encrypted on each server so a
// device restored from the phrase can find its rooms again. Its ID, write key
// and encryption key all come from the entropy, per server, so the server
// sees an opaque padded blob it can't connect to any room.

// VaultData is what a vault holds.
type VaultData struct {
	V     int      `json:"v"`
	Rooms []string `json:"rooms"`
}

// Vault is one server's vault keys.
type Vault struct {
	ID     string
	Signer *KeySigner
	Key    []byte
}

// KeySigner is a Signer for a key that isn't a room member (the vault key).
type KeySigner struct {
	ID  string
	Key ed25519.PrivateKey
}

func (k *KeySigner) MemberID() string               { return k.ID }
func (k *KeySigner) PrivateKey() ed25519.PrivateKey { return k.Key }

// VaultKeys derives the vault for one server.
func VaultKeys(e Entropy, server string) *Vault {
	ed := ed25519.NewKeyFromSeed(HKDF(e[:], "vault-sign|"+server))
	pub := ed.Public().(ed25519.PublicKey)
	return &Vault{
		ID:     proto.VaultID(pub),
		Signer: &KeySigner{ID: proto.MemberID(pub), Key: ed},
		Key:    HKDF(e[:], "vault-enc|"+server),
	}
}

// vaultBucket: blobs are padded to a multiple of this, so the size says
// little about how many rooms are in one.
const vaultBucket = 4096

// Seal makes the blob for PUT /v1/vault/:id.
func (v *Vault) Seal(d VaultData) (string, error) {
	d.V = 1
	if d.Rooms == nil {
		d.Rooms = []string{}
	}
	js, err := marshal(d)
	if err != nil {
		return "", err
	}
	padded := make([]byte, (len(js)+4+vaultBucket-1)/vaultBucket*vaultBucket)
	binary.BigEndian.PutUint32(padded, uint32(len(js)))
	copy(padded[4:], js)
	return B64.EncodeToString(AEADSeal(v.Key, padded, []byte("sc-vault|"+v.ID))), nil
}

// Open reads a blob from GET /v1/vault/:id.
func (v *Vault) Open(blob string) (*VaultData, error) {
	sealed, err := B64.DecodeString(blob)
	if err != nil {
		return nil, err
	}
	padded, err := AEADOpen(v.Key, sealed, []byte("sc-vault|"+v.ID))
	if err != nil {
		return nil, err
	}
	if len(padded) < 4 {
		return nil, errors.New("bad vault")
	}
	n := binary.BigEndian.Uint32(padded)
	if int64(n) > int64(len(padded)-4) {
		return nil, errors.New("bad vault length " + strconv.Itoa(int(n)))
	}
	var d VaultData
	if err := json.Unmarshal(padded[4:4+n], &d); err != nil {
		return nil, err
	}
	if d.V != 1 || d.Rooms == nil {
		return nil, errors.New("bad vault")
	}
	return &d, nil
}
