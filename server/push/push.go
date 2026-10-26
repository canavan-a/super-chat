// Package push wakes devices through Firebase Cloud Messaging (the Google
// Play build of the app; see app/src/push.ts). It never learns which devices
// those are: each room has an FCM topic that members' devices subscribe to
// themselves, and the server only ever sends to the topic.
//
// A wake-up carries nothing but the topic. The woken app fetches the new
// messages from this server and decrypts them itself, so Google sees that a
// device was woken and when, never anything about the message.
package push

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

// Topic is a room's FCM topic. Members' devices compute the same name
// (app/src/push.ts); it's derived from the room ID, which only members and
// this server know.
func Topic(room string) string {
	sum := sha256.Sum256([]byte("superchat-topic|" + room))
	return "sc-" + base64.RawURLEncoding.EncodeToString(sum[:16])
}

// Expiry is how long FCM and APNs keep trying to deliver a wake-up to a
// device that's off or out of signal. Long enough to cover a restart or a
// commute; the collapse keys mean only the newest per room is kept anyway.
const Expiry = time.Hour

var ttl = strconv.Itoa(int(Expiry.Seconds())) + "s"

// sendTries is how many times a send is tried before it's given up.
const sendTries = 3

// Window is the shortest gap between two wake-ups for one room. Messages in
// between are covered by one trailing wake-up at the window's end: a woken
// device fetches everything new anyway.
const Window = 3 * time.Second

// FCM sends wake-ups. A nil *FCM is valid and sends nothing.
type FCM struct {
	project string
	client  *http.Client
	// endpoint is FCM's send URL; tests point it elsewhere.
	endpoint string
	// retryWait is the wait before the first retry (doubling after); tests shorten it.
	retryWait time.Duration

	mu      sync.Mutex
	last    map[string]time.Time
	pending map[string]bool
	now     func() time.Time
}

// New reads a Firebase service account key (Project settings → Service
// accounts → Generate new private key).
func New(credentialsJSON []byte) (*FCM, error) {
	creds, err := google.CredentialsFromJSON(context.Background(), credentialsJSON,
		"https://www.googleapis.com/auth/firebase.messaging")
	if err != nil {
		return nil, fmt.Errorf("FCM credentials: %w", err)
	}
	if creds.ProjectID == "" {
		return nil, fmt.Errorf("FCM credentials: no project_id")
	}
	f := newFCM(creds.ProjectID, oauth2.NewClient(context.Background(), creds.TokenSource))
	return f, nil
}

func newFCM(project string, client *http.Client) *FCM {
	client.Timeout = 10 * time.Second
	return &FCM{
		project:   project,
		client:    client,
		endpoint:  "https://fcm.googleapis.com/v1/projects/" + project + "/messages:send",
		retryWait: time.Second,
		last:      map[string]time.Time{},
		pending:   map[string]bool{},
		now:       time.Now,
	}
}

// Wake tells the room's members' devices there's something new. It never
// blocks: sends happen in the background, at most one per room per Window.
func (f *FCM) Wake(room string) {
	if f == nil {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.pending[room] {
		return // a trailing wake-up is already scheduled
	}
	wait := Window - f.now().Sub(f.last[room])
	if wait <= 0 {
		f.last[room] = f.now()
		go f.send(room)
		return
	}
	f.pending[room] = true
	time.AfterFunc(wait, func() {
		f.mu.Lock()
		delete(f.pending, room)
		f.last[room] = f.now()
		f.mu.Unlock()
		f.send(room)
	})
}

func (f *FCM) send(room string) {
	topic := Topic(room)
	body, _ := json.Marshal(map[string]any{
		"message": map[string]any{
			"topic": topic,
			// Data only, nothing readable: the app shows the notification.
			"data": map[string]string{"w": "1"},
			"android": map[string]any{
				"priority": "HIGH",
				// One wake-up per room waiting at a time is enough.
				"collapse_key": topic,
				"ttl":          ttl,
			},
			// iPhones: iOS won't reliably wake a closed app to fetch and
			// decrypt, so APNs shows a plain alert itself, the same for
			// every room. "t" lets the open app catch up on that room
			// instead (app/ios/SuperchatApp/PushModule.m).
			"apns": map[string]any{
				"headers": map[string]string{
					"apns-priority":    "10",
					"apns-push-type":   "alert",
					"apns-collapse-id": topic,
					"apns-expiration":  strconv.FormatInt(f.now().Add(Expiry).Unix(), 10),
				},
				"payload": map[string]any{
					"aps": map[string]any{
						"alert":     map[string]string{"title": "Super Chat", "body": "New message"},
						"sound":     "default",
						"thread-id": "sc-wake",
					},
					"t": topic,
				},
			},
		},
	})
	wait := f.retryWait
	for try := 1; ; try++ {
		retry, after := f.post(body)
		if !retry || try == sendTries {
			return
		}
		if after > 0 {
			wait = after
		}
		time.Sleep(wait)
		wait *= 2
	}
}

// post sends once. It says whether it's worth trying again (no answer, too
// many requests, or a server error) and how long FCM asked to wait, if it did.
func (f *FCM) post(body []byte) (retry bool, after time.Duration) {
	resp, err := f.client.Post(f.endpoint, "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("push: %v", err)
		return true, 0
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return false, 0
	}
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	log.Printf("push: FCM %d: %s", resp.StatusCode, bytes.TrimSpace(msg))
	if resp.StatusCode != http.StatusTooManyRequests && resp.StatusCode < 500 {
		return false, 0
	}
	if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && s > 0 {
		after = min(time.Duration(s)*time.Second, time.Minute)
	}
	return true, after
}

// NewWithEndpoint sends to endpoint instead of FCM (tests).
func NewWithEndpoint(endpoint string, client *http.Client) *FCM {
	f := newFCM("test", client)
	f.endpoint = endpoint
	return f
}
