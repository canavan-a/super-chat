// Package sweeper enforces each room's retention and cleans up what nobody
// can use any more: orphaned blobs, empty rooms, and keys for epochs that no
// longer have any messages.
package sweeper

import (
	"context"
	"log"
	"time"

	"main/database"
	"main/rooms"
)

const orphanBlobAge = time.Hour

// Run sweeps once immediately and then every interval until ctx ends.
func Run(ctx context.Context, svc *rooms.Service, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if n, err := Sweep(svc); err != nil {
			log.Printf("sweep: %v", err)
		} else if n > 0 {
			log.Printf("sweep: removed %d messages", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Sweep does one pass and returns how many messages it deleted.
func Sweep(svc *rooms.Service) (int64, error) {
	db := svc.DB
	now := svc.Now()
	var total int64

	var rs []database.Room
	if err := db.Where("retention_days > 0").Find(&rs).Error; err != nil {
		return 0, err
	}
	for _, r := range rs {
		cutoff := now.Add(-time.Duration(r.RetentionDays) * 24 * time.Hour).UnixMilli()
		var blobIDs []string
		db.Raw(`SELECT b.id FROM blobs b JOIN messages m ON m.id = b.message_id
		        WHERE m.room_id = ? AND m.created_at < ?`, r.ID, cutoff).Scan(&blobIDs)
		if len(blobIDs) > 0 {
			if err := db.Where("id IN ?", blobIDs).Delete(&database.Blob{}).Error; err != nil {
				return total, err
			}
			svc.RemoveBlobFiles(blobIDs)
		}
		res := db.Where("room_id = ? AND created_at < ?", r.ID, cutoff).Delete(&database.Message{})
		if res.Error != nil {
			return total, res.Error
		}
		total += res.RowsAffected
	}

	// Blobs uploaded but never attached to a message or made an avatar, and
	// avatars of people who have left the room.
	var orphans []string
	db.Model(&database.Blob{}).Where("message_id IS NULL AND avatar = 0 AND created_at < ?", now.Add(-orphanBlobAge).UnixMilli()).Pluck("id", &orphans)
	var gone []string
	db.Raw(`SELECT b.id FROM blobs b WHERE b.avatar = 1
		AND NOT EXISTS (SELECT 1 FROM members m WHERE m.room_id = b.room_id AND m.member_id = b.uploader)`).Scan(&gone)
	orphans = append(orphans, gone...)
	if len(orphans) > 0 {
		if err := db.Where("id IN ?", orphans).Delete(&database.Blob{}).Error; err != nil {
			return total, err
		}
		svc.RemoveBlobFiles(orphans)
	}

	// Keys for past epochs with nothing left to decrypt. Without them a key
	// stolen later unlocks nothing that was deleted. The previous epoch is
	// kept so a snapshot of names and profiles is always readable.
	if err := db.Exec(`
		DELETE FROM envelopes WHERE epoch < (SELECT epoch FROM rooms WHERE rooms.id = envelopes.room_id) - 1
		AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.room_id = envelopes.room_id AND m.epoch = envelopes.epoch)`).Error; err != nil {
		return total, err
	}

	// Rooms everyone has left.
	var empty []string
	db.Raw(`SELECT id FROM rooms r WHERE NOT EXISTS (SELECT 1 FROM members m WHERE m.room_id = r.id)`).Scan(&empty)
	for _, id := range empty {
		if err := svc.DeleteRoom(id); err != nil {
			return total, err
		}
	}
	return total, nil
}
