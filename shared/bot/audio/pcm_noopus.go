//go:build !opus

package audio

import (
	"errors"
	"io"
)

// PCM needs libopus: build with -tags opus (and nolibopusfile unless
// libopusfile is installed). Without it this always fails, so the default
// build stays pure Go. Ogg Opus files (Ogg, OggFile) need no codec at all.
func PCM(r io.Reader, sampleRate, channels int) (Source, error) {
	return nil, errors.New("PCM audio needs a build with -tags opus (and libopus)")
}
