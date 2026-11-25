package bot

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/jpeg"

	// Decoders for what people send as pictures.
	_ "image/gif"
	_ "image/png"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// AvatarSize is the side of a profile picture, as the app makes them.
const AvatarSize = 512

// maxAvatarPixels guards against a small file that decodes to a huge image.
const maxAvatarPixels = 50_000_000

// PrepareAvatar turns any JPEG, PNG, GIF or WebP into a profile picture the
// way the app does: the centered square, scaled to AvatarSize, as a JPEG.
func PrepareAvatar(data []byte) ([]byte, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("that isn't a picture I can read (JPEG, PNG, GIF or WebP)")
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > maxAvatarPixels {
		return nil, fmt.Errorf("that picture is too big (%d×%d)", cfg.Width, cfg.Height)
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("that picture didn't decode")
	}
	b := src.Bounds()
	side := min(b.Dx(), b.Dy())
	crop := image.Rect(0, 0, side, side).Add(image.Pt(b.Min.X+(b.Dx()-side)/2, b.Min.Y+(b.Dy()-side)/2))
	dst := image.NewRGBA(image.Rect(0, 0, AvatarSize, AvatarSize))
	// White under any transparency: JPEG has none, and black would show.
	draw.Draw(dst, dst.Bounds(), image.White, image.Point{}, draw.Src)
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, crop, draw.Over, nil)
	var out bytes.Buffer
	if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: 85}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
