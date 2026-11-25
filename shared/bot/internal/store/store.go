// Package store is a bot's state on disk: one SQLite file (pure Go, no cgo)
// in the bot's data directory, plus the account secret in a file of its own.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"

	"github.com/canavan-a/super-chat/shared/crypto"
	"github.com/canavan-a/super-chat/shared/proto"
)

const schema = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (
	id TEXT PRIMARY KEY,
	server TEXT NOT NULL,
	last_pos INTEGER NOT NULL DEFAULT 0,
	joined_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
	room TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, sig TEXT NOT NULL,
	PRIMARY KEY (room, seq)
);
CREATE TABLE IF NOT EXISTS epoch_keys (
	room TEXT NOT NULL, epoch INTEGER NOT NULL, key BLOB NOT NULL,
	PRIMARY KEY (room, epoch)
);
CREATE TABLE IF NOT EXISTS admins (
	room TEXT NOT NULL, member TEXT NOT NULL,
	PRIMARY KEY (room, member)
);
CREATE TABLE IF NOT EXISTS kv (
	room TEXT NOT NULL, k TEXT NOT NULL, v BLOB NOT NULL,
	PRIMARY KEY (room, k)
);
`

// EntropyFile is the account secret's file name inside the data directory.
const EntropyFile = "account.key"

// ErrNoAccount means the data directory has no account yet (run init).
var ErrNoAccount = errors.New("no bot account here yet: run init first")

// Store is an open data directory.
type Store struct {
	Dir string
	db  *sql.DB
}

// Open opens (creating if needed) the database in dir.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "bot.db")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	// One writer at a time; SQLite serializes anyway, and this keeps
	// "database is locked" out of the picture.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("init database: %w", err)
	}
	_ = os.Chmod(path, 0o600)
	return &Store{Dir: dir, db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// ---- the account ----

// LoadEntropy reads the account secret: from envFile if set (for secrets
// managers), else from the data directory.
func (s *Store) LoadEntropy(envFile string) (crypto.Entropy, error) {
	path := envFile
	if path == "" {
		path = filepath.Join(s.Dir, EntropyFile)
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return crypto.Entropy{}, ErrNoAccount
	}
	if err != nil {
		return crypto.Entropy{}, err
	}
	b, err := crypto.B64.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(b) != 32 {
		return crypto.Entropy{}, fmt.Errorf("%s doesn't hold a bot account", path)
	}
	var e crypto.Entropy
	copy(e[:], b)
	return e, nil
}

// SaveEntropy writes the account secret, refusing to replace one.
func (s *Store) SaveEntropy(e crypto.Entropy) error {
	path := filepath.Join(s.Dir, EntropyFile)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return fmt.Errorf("%s already holds an account", path)
	}
	if err != nil {
		return err
	}
	if _, err := f.WriteString(crypto.B64.EncodeToString(e[:]) + "\n"); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// Meta reads a value from the meta table; ok is false when it's absent.
func (s *Store) Meta(k string) (v []byte, ok bool, err error) {
	err = s.db.QueryRow(`SELECT v FROM meta WHERE k = ?`, k).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	return v, err == nil, err
}

func (s *Store) SetMeta(k string, v []byte) error {
	_, err := s.db.Exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, k, v)
	return err
}

// ---- rooms ----

// Room is a room the bot is in.
type Room struct {
	ID       string
	Server   string
	LastPos  int64
	JoinedAt int64
}

func (s *Store) Rooms() ([]Room, error) {
	rows, err := s.db.Query(`SELECT id, server, last_pos, joined_at FROM rooms ORDER BY joined_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Room
	for rows.Next() {
		var r Room
		if err := rows.Scan(&r.ID, &r.Server, &r.LastPos, &r.JoinedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) AddRoom(id, server string, now int64) error {
	_, err := s.db.Exec(`INSERT INTO rooms (id, server, joined_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING`, id, server, now)
	return err
}

// DeleteRoom forgets a room: its log, keys, admins and plugin data.
func (s *Store) DeleteRoom(id string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{
		`DELETE FROM events WHERE room = ?`,
		`DELETE FROM epoch_keys WHERE room = ?`,
		`DELETE FROM admins WHERE room = ?`,
		`DELETE FROM kv WHERE room = ?`,
		`DELETE FROM rooms WHERE id = ?`,
	} {
		if _, err := tx.Exec(q, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SetLastPos records the last message position handled in a room.
func (s *Store) SetLastPos(room string, pos int64) error {
	_, err := s.db.Exec(`UPDATE rooms SET last_pos = ? WHERE id = ? AND last_pos < ?`, pos, room, pos)
	return err
}

// ---- the log and keys ----

// Events is a room's log as stored, in order.
func (s *Store) Events(room string) ([]proto.SignedEvent, error) {
	rows, err := s.db.Query(`SELECT body, sig FROM events WHERE room = ? ORDER BY seq`, room)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []proto.SignedEvent
	for rows.Next() {
		var e proto.SignedEvent
		if err := rows.Scan(&e.Body, &e.Sig); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ReplaceEvents stores a room's whole verified log (after a full reload).
func (s *Store) ReplaceEvents(room string, evs []*proto.Event) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM events WHERE room = ?`, room); err != nil {
		return err
	}
	if err := putEvents(tx, room, evs); err != nil {
		return err
	}
	return tx.Commit()
}

// AddEvents stores events that follow on from what's stored.
func (s *Store) AddEvents(room string, evs []*proto.Event) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := putEvents(tx, room, evs); err != nil {
		return err
	}
	return tx.Commit()
}

func putEvents(tx *sql.Tx, room string, evs []*proto.Event) error {
	for _, e := range evs {
		se := e.Signed()
		if _, err := tx.Exec(`INSERT INTO events (room, seq, body, sig) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`, room, e.Seq, se.Body, se.Sig); err != nil {
			return err
		}
	}
	return nil
}

// Keys is a room's epoch keys.
func (s *Store) Keys(room string) (map[int64][]byte, error) {
	rows, err := s.db.Query(`SELECT epoch, key FROM epoch_keys WHERE room = ?`, room)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]byte{}
	for rows.Next() {
		var n int64
		var k []byte
		if err := rows.Scan(&n, &k); err != nil {
			return nil, err
		}
		out[n] = k
	}
	return out, rows.Err()
}

func (s *Store) PutKey(room string, epoch int64, key []byte) error {
	_, err := s.db.Exec(`INSERT INTO epoch_keys (room, epoch, key) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, room, epoch, key)
	return err
}

// ---- admins (members who logged in with the admin password, per room) ----

func (s *Store) IsAdmin(room, member string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM admins WHERE room = ? AND member = ?`, room, member).Scan(&n)
	return n > 0, err
}

func (s *Store) SetAdmin(room, member string, admin bool) error {
	var err error
	if admin {
		_, err = s.db.Exec(`INSERT INTO admins (room, member) VALUES (?, ?) ON CONFLICT DO NOTHING`, room, member)
	} else {
		_, err = s.db.Exec(`DELETE FROM admins WHERE room = ? AND member = ?`, room, member)
	}
	return err
}

// ---- plugin key-value data, per room ----

func (s *Store) KVGet(room, k string) ([]byte, bool, error) {
	var v []byte
	err := s.db.QueryRow(`SELECT v FROM kv WHERE room = ? AND k = ?`, room, k).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	return v, err == nil, err
}

func (s *Store) KVSet(room, k string, v []byte) error {
	if v == nil {
		_, err := s.db.Exec(`DELETE FROM kv WHERE room = ? AND k = ?`, room, k)
		return err
	}
	_, err := s.db.Exec(`INSERT INTO kv (room, k, v) VALUES (?, ?, ?) ON CONFLICT (room, k) DO UPDATE SET v = excluded.v`, room, k, v)
	return err
}

// Admins is the members logged in as admins in a room.
func (s *Store) Admins(room string) ([]string, error) {
	rows, err := s.db.Query(`SELECT member FROM admins WHERE room = ?`, room)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
