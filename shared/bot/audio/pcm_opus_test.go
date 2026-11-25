//go:build opus

package audio

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"testing"
	"time"

	"gopkg.in/hraban/opus.v2"
)

func TestPCM(t *testing.T) {
	// One second of a 440 Hz tone, mono, plus a third of a frame.
	const rate = 48000
	var raw bytes.Buffer
	for i := 0; i < rate+320; i++ {
		v := int16(8000 * math.Sin(2*math.Pi*440*float64(i)/rate))
		_ = binary.Write(&raw, binary.LittleEndian, v)
	}
	src, err := PCM(&raw, rate, 1)
	if err != nil {
		t.Fatal(err)
	}
	dec, err := opus.NewDecoder(rate, 1)
	if err != nil {
		t.Fatal(err)
	}
	var packets int
	var total time.Duration
	var energy float64
	out := make([]int16, 5760)
	for {
		p, d, err := src.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if got, err := PacketDuration(p); err != nil || got != d {
			t.Fatalf("packet says %v (%v), source says %v", got, err, d)
		}
		n, err := dec.Decode(p, out)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range out[:n] {
			energy += float64(s) * float64(s)
		}
		packets++
		total += d
	}
	if packets != 51 || total != 1020*time.Millisecond {
		t.Fatalf("%d packets, %v", packets, total)
	}
	if energy == 0 {
		t.Fatal("the decoded audio is silent")
	}
}
