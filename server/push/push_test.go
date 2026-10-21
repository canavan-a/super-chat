package push

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// The app computes the same topic (app/__tests__/push.test.ts checks this
// exact value).
func TestTopic(t *testing.T) {
	if got := Topic("AAAAAAAAAAAAAAAAAAAAAA"); got != topicVector {
		t.Fatalf("Topic = %q", got)
	}
}

const topicVector = "sc-tPhg4JHeTEob8sBpQDmd0A"

func TestWakeSendsDataOnlyAndCoalesces(t *testing.T) {
	var mu sync.Mutex
	var got []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		mu.Lock()
		got = append(got, m)
		mu.Unlock()
	}))
	defer srv.Close()
	f := newFCM("p", srv.Client())
	f.endpoint = srv.URL

	count := func() int {
		mu.Lock()
		defer mu.Unlock()
		return len(got)
	}
	f.Wake("room1")
	for i := 0; i < 5; i++ {
		f.Wake("room1") // within the window: one trailing wake-up
	}
	time.Sleep(200 * time.Millisecond)
	if count() != 1 {
		t.Fatalf("immediate sends = %d", count())
	}
	msg := got[0]["message"].(map[string]any)
	if msg["topic"] != Topic("room1") {
		t.Fatalf("topic %v", msg["topic"])
	}
	if _, ok := msg["notification"]; ok {
		t.Fatal("a wake-up must not carry a notification")
	}
	if d := msg["data"].(map[string]any); len(d) != 1 || d["w"] != "1" {
		t.Fatalf("data %v", d)
	}
	// iPhones get a fixed alert, the same for every room, and the topic.
	apns := msg["apns"].(map[string]any)
	payload := apns["payload"].(map[string]any)
	if payload["t"] != Topic("room1") {
		t.Fatalf("apns topic %v", payload["t"])
	}
	alert := payload["aps"].(map[string]any)["alert"].(map[string]any)
	if alert["title"] != "Super Chat" || alert["body"] != "New message" {
		t.Fatalf("apns alert %v", alert)
	}
	if h := apns["headers"].(map[string]any); h["apns-collapse-id"] != Topic("room1") || h["apns-push-type"] != "alert" {
		t.Fatalf("apns headers %v", h)
	}
	time.Sleep(Window + 300*time.Millisecond)
	if count() != 2 {
		t.Fatalf("after the window: %d sends, want 2 (one trailing)", count())
	}
}

func TestNilFCMIsANoOp(t *testing.T) {
	var f *FCM
	f.Wake("room") // must not panic
}
