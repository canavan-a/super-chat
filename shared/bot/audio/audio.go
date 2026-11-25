// Package audio is what a bot plays into a voice room: a Source of Opus
// packets, from an Ogg Opus file (no codec library needed) or, built with
// -tags opus, from raw PCM (that needs libopus).
package audio

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"time"
)

// Source yields Opus packets in order, each with how long it plays. It
// returns io.EOF after the last one.
type Source interface {
	Next() (packet []byte, dur time.Duration, err error)
}

// Silence is a 20 ms Opus frame of silence (CELT, fullband, mono). Sent
// while nothing plays, so listeners keep receiving packets and their apps
// don't show the bot as stalled.
var Silence = []byte{0xF8, 0xFF, 0xFE}

// SilenceDuration is how long Silence plays.
const SilenceDuration = 20 * time.Millisecond

// ---- Ogg Opus ----

// OggFile opens an Ogg Opus file (.opus, or .ogg holding Opus). Close it
// with the returned func once played.
func OggFile(path string) (Source, func() error, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	src, err := Ogg(f)
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return src, f.Close, nil
}

// Ogg reads Ogg Opus from r. It checks the OpusHead up front, so a file
// that isn't Ogg Opus fails here rather than mid-play.
func Ogg(r io.Reader) (Source, error) {
	o := &ogg{r: bufio.NewReader(r)}
	head, err := o.packet()
	if err != nil {
		return nil, fmt.Errorf("not an Ogg file: %w", err)
	}
	if len(head) < 19 || !bytes.Equal(head[:8], []byte("OpusHead")) {
		return nil, errors.New("not Ogg Opus (no OpusHead)")
	}
	tags, err := o.packet()
	if err != nil || len(tags) < 8 || !bytes.Equal(tags[:8], []byte("OpusTags")) {
		return nil, errors.New("not Ogg Opus (no OpusTags)")
	}
	return o, nil
}

// ogg splits an Ogg stream into packets: a page's segment table says where
// each packet ends (a segment shorter than 255 bytes ends one), and a packet
// can run on over several pages.
type ogg struct {
	r       *bufio.Reader
	lacing  []byte // what's left of the current page's segment table
	partial []byte // a packet carried over from the previous page
}

func (o *ogg) Next() ([]byte, time.Duration, error) {
	for {
		p, err := o.packet()
		if err != nil {
			return nil, 0, err
		}
		if len(p) == 0 {
			continue
		}
		d, err := PacketDuration(p)
		if err != nil {
			return nil, 0, err
		}
		return p, d, nil
	}
}

func (o *ogg) packet() ([]byte, error) {
	for {
		for len(o.lacing) > 0 {
			n := int(o.lacing[0])
			o.lacing = o.lacing[1:]
			seg := make([]byte, n)
			if _, err := io.ReadFull(o.r, seg); err != nil {
				return nil, unexpected(err)
			}
			o.partial = append(o.partial, seg...)
			if n < 255 {
				p := o.partial
				o.partial = nil
				return p, nil
			}
		}
		if err := o.page(); err != nil {
			return nil, err
		}
	}
}

// page reads the next page header and its segment table.
func (o *ogg) page() error {
	var h [27]byte
	if _, err := io.ReadFull(o.r, h[:]); err != nil {
		if errors.Is(err, io.EOF) && len(o.partial) == 0 {
			return io.EOF
		}
		return unexpected(err)
	}
	if !bytes.Equal(h[:4], []byte("OggS")) || h[4] != 0 {
		return errors.New("bad Ogg page")
	}
	lacing := make([]byte, h[26])
	if _, err := io.ReadFull(o.r, lacing); err != nil {
		return unexpected(err)
	}
	o.lacing = lacing
	return nil
}

func unexpected(err error) error {
	if errors.Is(err, io.EOF) {
		return io.ErrUnexpectedEOF
	}
	return err
}

// PacketDuration is how long an Opus packet plays, from its TOC byte
// (RFC 6716 §3.1): the frame size its configuration gives, times the
// number of frames it holds.
func PacketDuration(p []byte) (time.Duration, error) {
	if len(p) == 0 {
		return 0, errors.New("empty Opus packet")
	}
	config := p[0] >> 3
	var frame time.Duration
	switch {
	case config < 12: // SILK: 10, 20, 40, 60 ms
		frame = [...]time.Duration{10, 20, 40, 60}[config%4] * time.Millisecond
	case config < 16: // hybrid: 10, 20 ms
		frame = [...]time.Duration{10, 20}[config%2] * time.Millisecond
	default: // CELT: 2.5, 5, 10, 20 ms
		frame = [...]time.Duration{2500, 5000, 10000, 20000}[config%4] * time.Microsecond
	}
	frames := 1
	switch p[0] & 3 {
	case 1, 2:
		frames = 2
	case 3:
		if len(p) < 2 {
			return 0, errors.New("truncated Opus packet")
		}
		frames = int(p[1] & 0x3F)
		if frames == 0 {
			return 0, errors.New("Opus packet with no frames")
		}
	}
	d := frame * time.Duration(frames)
	if d > 120*time.Millisecond {
		return 0, errors.New("Opus packet longer than 120 ms")
	}
	return d, nil
}

// Packets is a Source over packets already in memory (each with its own
// duration from its TOC byte).
func Packets(packets [][]byte) Source { return &list{packets: packets} }

type list struct {
	packets [][]byte
	i       int
}

func (l *list) Next() ([]byte, time.Duration, error) {
	if l.i >= len(l.packets) {
		return nil, 0, io.EOF
	}
	p := l.packets[l.i]
	l.i++
	d, err := PacketDuration(p)
	return p, d, err
}
