-- +goose Up
--
-- A group's picture: an ordinary (encrypted) blob, marked as the room's
-- picture instead of being attached to a message. Every member may read it;
-- the key is in the room's encrypted meta event, so the server knows which
-- blob is the picture but never sees it. A room has at most one.
ALTER TABLE blobs ADD COLUMN picture INTEGER NOT NULL DEFAULT 0;
CREATE INDEX blobs_picture ON blobs(room_id) WHERE picture = 1;

-- +goose Down
DROP INDEX blobs_picture;
ALTER TABLE blobs DROP COLUMN picture;
