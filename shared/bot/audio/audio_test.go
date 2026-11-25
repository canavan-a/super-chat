package audio

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

func TestPacketDuration(t *testing.T) {
	cases := []struct {
		p    []byte
		want time.Duration
	}{
		{[]byte{0xF8, 0xFF, 0xFE}, 20 * time.Millisecond}, // CELT 20 ms (the silence frame)
		{[]byte{0xFC}, 20 * time.Millisecond},             // CELT 20 ms, stereo
		{[]byte{0x08}, 20 * time.Millisecond},             // SILK NB 20 ms
		{[]byte{0x18}, 60 * time.Millisecond},             // SILK NB 60 ms
		{[]byte{0x60}, 10 * time.Millisecond},             // hybrid 10 ms
		{[]byte{0x80}, 2500 * time.Microsecond},           // CELT 2.5 ms
		{[]byte{0xF9}, 40 * time.Millisecond},             // two 20 ms frames
		{[]byte{0xFB, 0x03}, 60 * time.Millisecond},       // code 3: three frames
	}
	for _, c := range cases {
		got, err := PacketDuration(c.p)
		if err != nil || got != c.want {
			t.Fatalf("PacketDuration(% x) = %v, %v; want %v", c.p, got, err, c.want)
		}
	}
	for _, bad := range [][]byte{nil, {0xFB}, {0xFB, 0x00}, {0x1B, 0x03}} {
		if _, err := PacketDuration(bad); err == nil {
			t.Fatalf("PacketDuration(% x) accepted", bad)
		}
	}
}

// A file written by pion's own Ogg writer (one packet per page), read back.
func TestOggFromPionWriter(t *testing.T) {
	var buf bytes.Buffer
	w, err := oggwriter.NewWith(&nopCloser{&buf}, 48000, 2)
	if err != nil {
		t.Fatal(err)
	}
	var want [][]byte
	for i := 0; i < 30; i++ {
		p := []byte{0xFC, 'A', byte(i)}
		want = append(want, p)
		if err := w.WriteRTP(&rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(i), Timestamp: uint32(i * 960)}, Payload: p}); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	src, err := Ogg(&buf)
	if err != nil {
		t.Fatal(err)
	}
	for i, w := range want {
		p, d, err := src.Next()
		if err != nil || !bytes.Equal(p, w) || d != 20*time.Millisecond {
			t.Fatalf("packet %d: % x %v %v, want % x", i, p, d, err, w)
		}
	}
	if _, _, err := src.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("after the last packet: %v", err)
	}
}

// Several packets on one page, and one packet running over two pages.
func TestOggPacking(t *testing.T) {
	big := append([]byte{0xFC}, bytes.Repeat([]byte{7}, 600)...) // 601 bytes: lacing 255,255,91
	var f bytes.Buffer
	page(&f, []byte("OpusHead\x01\x02\x00\x00\x80\xbb\x00\x00\x00\x00\x00"))
	page(&f, []byte("OpusTags\x00\x00\x00\x00\x00\x00\x00\x00"))
	page(&f, []byte{0xFC, 1}, []byte{0xFC, 2}, []byte{0xFC, 3})
	// big split across two pages: the first ends on a 255 segment (continued).
	pageRaw(&f, []byte{255, 255}, big[:510])
	pageRaw(&f, []byte{91}, big[510:])
	src, err := Ogg(&f)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range [][]byte{{0xFC, 1}, {0xFC, 2}, {0xFC, 3}, big} {
		p, _, err := src.Next()
		if err != nil || !bytes.Equal(p, want) {
			t.Fatalf("got %d bytes (%v), want %d", len(p), err, len(want))
		}
	}
	if _, _, err := src.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("after the last packet: %v", err)
	}
	if _, err := Ogg(bytes.NewReader([]byte("not ogg at all, not even close......"))); err == nil {
		t.Fatal("accepted something that isn't Ogg")
	}
}

func page(w *bytes.Buffer, packets ...[]byte) {
	var lacing, body []byte
	for _, p := range packets {
		n := len(p)
		for n >= 255 {
			lacing = append(lacing, 255)
			n -= 255
		}
		lacing = append(lacing, byte(n))
		body = append(body, p...)
	}
	pageRaw(w, lacing, body)
}

// pageRaw writes an Ogg page (the reader doesn't check CRCs).
func pageRaw(w *bytes.Buffer, lacing, body []byte) {
	h := make([]byte, 27)
	copy(h, "OggS")
	binary.LittleEndian.PutUint32(h[14:], 1)
	h[26] = byte(len(lacing))
	w.Write(h)
	w.Write(lacing)
	w.Write(body)
}

type nopCloser struct{ io.Writer }

func (nopCloser) Close() error { return nil }
