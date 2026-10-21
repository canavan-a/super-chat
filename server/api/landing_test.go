package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"main/config"
)

func TestAppleAppSiteAssociation(t *testing.T) {
	get := func(ids []string) *httptest.ResponseRecorder {
		a := &API{cfg: config.Config{AppleAppIDs: ids}}
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodGet, "/.well-known/apple-app-site-association", nil)
		a.appleAppSiteAssociation(c)
		return w
	}

	if w := get(nil); w.Code != http.StatusNotFound {
		t.Fatalf("unset: got %d, want 404", w.Code)
	}

	w := get([]string{"4W9H62B6C2.com.superchatapp"})
	if w.Code != http.StatusOK {
		t.Fatalf("set: got %d, want 200", w.Code)
	}
	var got struct {
		Applinks struct {
			Details []struct {
				AppIDs     []string            `json:"appIDs"`
				Components []map[string]string `json:"components"`
			} `json:"details"`
		} `json:"applinks"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	d := got.Applinks.Details
	if len(d) != 1 || len(d[0].AppIDs) != 1 || d[0].AppIDs[0] != "4W9H62B6C2.com.superchatapp" {
		t.Fatalf("appIDs: %+v", d)
	}
	if len(d[0].Components) != 1 || d[0].Components[0]["/"] != "/i/*" {
		t.Fatalf("components: %+v", d[0].Components)
	}
}
