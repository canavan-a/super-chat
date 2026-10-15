package api

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"main/database"
)

// putPicture makes one of the caller's uploaded blobs the room's group
// picture, replacing (and deleting) any previous one. {"blob": ""} clears it.
// Admins only, like the room name; the key travels in the encrypted meta
// event.
func (a *API) putPicture(c *gin.Context) {
	st, _, ok := a.member(c)
	if !ok {
		return
	}
	me := caller(c)
	if !st.IsAdmin(me) {
		abort(c, http.StatusForbidden, "admins only")
		return
	}
	var req struct {
		Blob string `json:"blob"`
	}
	if !bindBody(c, &req) {
		return
	}
	var old []string
	err := a.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&database.Blob{}).
			Where("room_id = ? AND picture = 1 AND id <> ?", st.Room, req.Blob).
			Pluck("id", &old).Error; err != nil {
			return err
		}
		if len(old) > 0 {
			if err := tx.Where("id IN ?", old).Delete(&database.Blob{}).Error; err != nil {
				return err
			}
		}
		if req.Blob == "" {
			return nil
		}
		res := tx.Model(&database.Blob{}).
			Where("id = ? AND room_id = ? AND uploader = ? AND message_id IS NULL AND avatar = 0", req.Blob, st.Room, me).
			Update("picture", true)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return errBadBlobs
		}
		return nil
	})
	if errors.Is(err, errBadBlobs) {
		abort(c, http.StatusBadRequest, "unknown or already used blob")
		return
	}
	if err != nil {
		abort(c, http.StatusInternalServerError, "db error")
		return
	}
	a.rooms.RemoveBlobFiles(old)
	c.Status(http.StatusNoContent)
}
