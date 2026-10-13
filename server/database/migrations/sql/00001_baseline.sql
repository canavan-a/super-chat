-- +goose Up
--
-- There is deliberately no accounts table. Every "member" below is a
-- room-scoped pseudonym: a person's devices derive a different key for each
-- room from a secret the server never sees, so nothing in this database links
-- a member of one room to a member of another.

CREATE TABLE rooms (
    id             TEXT PRIMARY KEY,
    retention_days INTEGER NOT NULL DEFAULT 0,
    epoch          INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
);

-- Current membership, derived from the log. first_epoch is the first epoch
-- the member holds a key for (0 until the rotation that follows their join).
CREATE TABLE members (
    room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    member_id   TEXT NOT NULL,
    role        TEXT NOT NULL,
    first_epoch INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (room_id, member_id)
);

CREATE TABLE events (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    seq     INTEGER NOT NULL,
    hash    TEXT NOT NULL,
    body    TEXT NOT NULL,
    sig     TEXT NOT NULL,
    PRIMARY KEY (room_id, seq)
);

CREATE TABLE envelopes (
    room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    epoch      INTEGER NOT NULL,
    member_id  TEXT NOT NULL,
    sealed     TEXT NOT NULL,
    PRIMARY KEY (room_id, epoch, member_id)
);

-- Server-side invite record: what the server needs to show a preview and to
-- track uses. Validity itself comes from the log.
CREATE TABLE invites (
    id         TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    preview    TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE invite_uses (
    invite_id  TEXT NOT NULL,
    room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    member_id  TEXT NOT NULL,
    used_at    INTEGER NOT NULL
);

CREATE TABLE messages (
    pos        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT NOT NULL UNIQUE,
    room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    epoch      INTEGER NOT NULL,
    sender     TEXT NOT NULL,
    kind       TEXT NOT NULL,
    ct         TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX messages_room ON messages(room_id, pos);
CREATE INDEX messages_age ON messages(created_at);

CREATE TABLE blobs (
    id         TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    uploader   TEXT NOT NULL,
    message_id TEXT,
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX blobs_message ON blobs(message_id);

-- A person's encrypted list of their rooms, so a new device restored from the
-- recovery phrase can find them again. The id and key are derived from that
-- phrase; the server can't open it or tell whose it is. No timestamps, and the
-- blob is padded to a fixed size bucket.
CREATE TABLE vaults (
    id   TEXT PRIMARY KEY,
    pub  TEXT NOT NULL,
    blob TEXT NOT NULL
);

-- +goose Down
DROP TABLE vaults;
DROP TABLE blobs;
DROP TABLE messages;
DROP TABLE invite_uses;
DROP TABLE invites;
DROP TABLE envelopes;
DROP TABLE events;
DROP TABLE members;
DROP TABLE rooms;
