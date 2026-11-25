package proto

import (
	"encoding/json"
	"os"
	"testing"
)

// testdata/ts-log.json is written by the app's crypto tests
// (app/__tests__/crypto.test.ts): a room created, invited to and joined
// entirely by the TypeScript client. Replaying it here proves the server
// accepts exactly what the client builds.
func TestReplayClientLog(t *testing.T) {
	raw, err := os.ReadFile("testdata/ts-log.json")
	if err != nil {
		t.Skip("run the app's jest suite first to write testdata/ts-log.json")
	}
	var fx struct {
		Room   string        `json:"room"`
		Events []SignedEvent `json:"events"`
		Expect struct {
			NextSeq int64             `json:"nextSeq"`
			Head    string            `json:"head"`
			Epoch   int64             `json:"epoch"`
			Members map[string]string `json:"members"`
		} `json:"expect"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	st := NewState(fx.Room)
	for i, se := range fx.Events {
		e, err := ParseEvent(se)
		if err != nil {
			t.Fatalf("event %d: %v", i, err)
		}
		if err := st.Apply(e, 0); err != nil {
			t.Fatalf("event %d (%s): %v", i, e.Kind, err)
		}
	}
	if st.NextSeq != fx.Expect.NextSeq || st.Head != fx.Expect.Head || st.Epoch != fx.Expect.Epoch {
		t.Fatalf("state mismatch: got seq=%d head=%s epoch=%d", st.NextSeq, st.Head, st.Epoch)
	}
	if len(st.Members) != len(fx.Expect.Members) {
		t.Fatalf("members: got %v want %v", st.Members, fx.Expect.Members)
	}
	for id, role := range fx.Expect.Members {
		if st.Members[id] != role {
			t.Fatalf("member %s: got %q want %q", id, st.Members[id], role)
		}
	}
	for id := range st.Members {
		if !validKey(st.Keys[id]) {
			t.Fatalf("member %s has no encryption key in the log", id)
		}
	}
}
