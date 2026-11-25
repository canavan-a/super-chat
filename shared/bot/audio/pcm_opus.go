//go:build opus

package audio

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"time"

	"gopkg.in/hraban/opus.v2"
)

// PCM encodes raw audio to Opus as it plays: 16-bit little-endian signed
// samples, interleaved when there are two channels, at sampleRate (8000,
// 12000, 16000, 24000 or 48000). Pipe ffmpeg into it for anything else:
//
//	ffmpeg -i song.mp3 -f s16le -ar 48000 -ac 2 -
//
// It's built only with -tags opus (it needs libopus); add nolibopusfile
// too unless libopusfile is installed.
func PCM(r io.Reader, sampleRate, channels int) (Source, error) {
	if channels != 1 && channels != 2 {
		return nil, errors.New("PCM takes 1 or 2 channels")
	}
	enc, err := opus.NewEncoder(sampleRate, channels, opus.AppAudio)
	if err != nil {
		return nil, fmt.Errorf("opus encoder: %w", err)
	}
	// What the app asks peers for (call/sdp.ts): 32 kbps, with in-band FEC.
	_ = enc.SetBitrate(32000)
	_ = enc.SetInBandFEC(true)
	_ = enc.SetPacketLossPerc(5)
	frame := sampleRate / 50 // 20 ms
	return &pcm{
		r:      r,
		enc:    enc,
		raw:    make([]byte, frame*channels*2),
		pcm:    make([]int16, frame*channels),
		packet: make([]byte, 4000),
	}, nil
}

type pcm struct {
	r      io.Reader
	enc    *opus.Encoder
	raw    []byte
	pcm    []int16
	packet []byte
	done   bool
}

func (p *pcm) Next() ([]byte, time.Duration, error) {
	if p.done {
		return nil, 0, io.EOF
	}
	n, err := io.ReadFull(p.r, p.raw)
	switch {
	case errors.Is(err, io.EOF):
		p.done = true
		return nil, 0, io.EOF
	case errors.Is(err, io.ErrUnexpectedEOF):
		// The last, short frame: pad it with silence.
		clear(p.raw[n:])
		p.done = true
	case err != nil:
		return nil, 0, err
	}
	for i := range p.pcm {
		p.pcm[i] = int16(binary.LittleEndian.Uint16(p.raw[2*i:]))
	}
	m, err := p.enc.Encode(p.pcm, p.packet)
	if err != nil {
		return nil, 0, err
	}
	return append([]byte(nil), p.packet[:m]...), 20 * time.Millisecond, nil
}
