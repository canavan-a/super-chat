package bot

import (
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	"golang.org/x/crypto/scrypt"

	"github.com/canavan-a/super-chat/shared/bot/internal/store"
	"github.com/canavan-a/super-chat/shared/crypto"
)

// Meta keys.
const (
	metaName      = "name"
	metaPassword  = "password"
	metaPicture   = "picture"
	metaPictureAt = "picture_at"
)

// MaxNameLen is how long a display name can be: the app cuts names at 40
// (UTF-16 units), so the bot's own names never go past that.
const MaxNameLen = 40

// InitOptions sets up a new bot account.
type InitOptions struct {
	// Phrase restores an existing account from its 24-word recovery phrase;
	// empty makes a new one.
	Phrase string
	// Name is the display name; empty picks a random one from DefaultNames.
	Name string
	// Password is the admin password, given in chat to `login`. Required.
	Password string
}

// Account is what Init made.
type Account struct {
	Name string
	// Phrase is the recovery phrase: shown once, so it can be written down.
	// The same phrase also opens the bot's account in the app.
	Phrase []string
}

// Init creates a bot account in dataDir. It refuses to replace one.
func Init(dataDir string, opt InitOptions) (*Account, error) {
	if opt.Password == "" {
		return nil, errors.New("an admin password is required")
	}
	name, err := cleanName(opt.Name)
	if err != nil {
		return nil, err
	}
	if name == "" {
		name = RandomName()
	}
	var e crypto.Entropy
	if strings.TrimSpace(opt.Phrase) != "" {
		if e, err = crypto.EntropyFromPhrase(opt.Phrase); err != nil {
			return nil, err
		}
	} else {
		e = crypto.NewEntropy()
	}
	st, err := store.Open(dataDir)
	if err != nil {
		return nil, err
	}
	defer st.Close()
	if _, err := st.LoadEntropy(""); err == nil {
		return nil, fmt.Errorf("%s already has a bot account", dataDir)
	}
	hash, err := hashPassword(opt.Password)
	if err != nil {
		return nil, err
	}
	if err := st.SetMeta(metaPassword, []byte(hash)); err != nil {
		return nil, err
	}
	if err := st.SetMeta(metaName, []byte(name)); err != nil {
		return nil, err
	}
	if err := st.SaveEntropy(e); err != nil {
		return nil, err
	}
	return &Account{Name: name, Phrase: e.Phrase()}, nil
}

// SetPassword changes the admin password of the account in dataDir. Members
// already logged in stay logged in.
func SetPassword(dataDir, password string) error {
	if password == "" {
		return errors.New("the admin password can't be empty")
	}
	st, err := store.Open(dataDir)
	if err != nil {
		return err
	}
	defer st.Close()
	if _, err := st.LoadEntropy(""); err != nil {
		return err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	return st.SetMeta(metaPassword, []byte(hash))
}

func cleanName(name string) (string, error) {
	name = strings.Join(strings.Fields(name), " ")
	if utf16Len(name) > MaxNameLen {
		return "", fmt.Errorf("a name can be at most %d characters", MaxNameLen)
	}
	return name, nil
}

// utf16Len is a string's length as JavaScript counts it, which is how the
// app measures (and cuts) names.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// ---- the admin password ----

// scrypt at the same cost as the app's key file: well under a second here,
// and a guessing attacker pays it per guess.
const scryptN, scryptR, scryptP = 1 << 15, 8, 1

func hashPassword(pw string) (string, error) {
	salt := crypto.RandomBytes(16)
	h, err := scrypt.Key([]byte(pw), salt, scryptN, scryptR, scryptP, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("scrypt$%d$%d$%d$%s$%s", scryptN, scryptR, scryptP, crypto.B64.EncodeToString(salt), crypto.B64.EncodeToString(h)), nil
}

func checkPassword(stored, pw string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 6 || parts[0] != "scrypt" {
		return false
	}
	n, err1 := strconv.Atoi(parts[1])
	r, err2 := strconv.Atoi(parts[2])
	p, err3 := strconv.Atoi(parts[3])
	salt, err4 := crypto.B64.DecodeString(parts[4])
	want, err5 := crypto.B64.DecodeString(parts[5])
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil || err5 != nil {
		return false
	}
	got, err := scrypt.Key([]byte(pw), salt, n, r, p, len(want))
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}

// ---- default names ----

// DefaultNames is where a new bot's name comes from when none is given.
var DefaultNames = []string{
	"James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda",
	"William", "Elizabeth", "David", "Barbara", "Richard", "Susan", "Joseph", "Jessica",
	"Thomas", "Sarah", "Charles", "Karen", "Daniel", "Nancy", "Matthew", "Lisa",
	"Anthony", "Betty", "Mark", "Margaret", "Steven", "Sandra", "Paul", "Ashley",
	"Andrew", "Emily", "Joshua", "Donna", "Kevin", "Michelle", "Brian", "Carol",
	"George", "Amanda", "Edward", "Melissa", "Ryan", "Deborah", "Jacob", "Rebecca",
	"Gary", "Laura",
}

// RandomName picks one of DefaultNames.
func RandomName() string {
	i, err := rand.Int(rand.Reader, big.NewInt(int64(len(DefaultNames))))
	if err != nil {
		return DefaultNames[0]
	}
	return DefaultNames[i.Int64()]
}
