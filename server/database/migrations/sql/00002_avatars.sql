-- +goose Up
--
-- A member's profile picture: an ordinary (encrypted) blob, marked as their
-- avatar instead of being attached to a message. Every member of the room may
-- read it; the key to open it is in the member's encrypted profile event, so
-- the server only knows which blob is someone's avatar, never the picture.
-- A member has at most one; setting a new one replaces the old.
ALTER TABLE blobs ADD COLUMN avatar INTEGER NOT NULL DEFAULT 0;
CREATE INDEX blobs_avatar ON blobs(room_id, uploader) WHERE avatar = 1;

-- +goose Down
DROP INDEX blobs_avatar;
ALTER TABLE blobs DROP COLUMN avatar;
