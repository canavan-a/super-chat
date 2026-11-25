// radio is an example bot: the stock bot, plus music. It joins the voice of
// every chat it's in and plays an Ogg Opus file there on a loop.
//
//	SUPERCHAT_RADIO_FILE=song.opus radio run --data ./bot-data
//
// Make the file with ffmpeg, at what the app asks for (mono, 32 kbps CBR):
//
//	ffmpeg -i song.flac -c:a libopus -b:a 32k -vbr off -ac 1 -frame_duration 20 song.opus
//
// An admin's "voice leave" takes it out of that chat's voice until it
// restarts; a call that drops for any other reason is joined again.
package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"time"

	"github.com/canavan-a/super-chat/shared/bot"
	"github.com/canavan-a/super-chat/shared/bot/audio"
	"github.com/canavan-a/super-chat/shared/bot/cli"
	"github.com/canavan-a/super-chat/shared/bot/core"
)

func main() {
	file := os.Getenv("SUPERCHAT_RADIO_FILE")
	cli.Main(func(b *bot.Bot) {
		core.Register(b)
		if file == "" {
			slog.Warn("no SUPERCHAT_RADIO_FILE: running without music")
			return
		}
		_, closeFn, err := audio.OggFile(file)
		if err != nil {
			slog.Error("can't play the radio file", "file", file, "err", err)
			os.Exit(1)
		}
		closeFn()
		b.OnStart(func(ctx context.Context) {
			for _, r := range b.Rooms() {
				go radio(ctx, b, r.ID, file)
			}
		})
		b.OnJoin(func(_ context.Context, r bot.Room) {
			go radio(context.Background(), b, r.ID, file)
		})
	})
}

// radio keeps the bot in a room's voice, playing file over and over.
func radio(ctx context.Context, b *bot.Bot, roomID, file string) {
	for ctx.Err() == nil {
		call, err := b.Voice.Join(ctx, roomID)
		if err != nil {
			if errors.Is(err, bot.ErrVoiceFull) {
				slog.Info("voice is full; trying again in a minute", "room", roomID)
			} else {
				slog.Warn("couldn't join voice", "room", roomID, "err", err)
			}
			if !sleep(ctx, time.Minute) {
				return
			}
			continue
		}
		slog.Info("radio on", "room", roomID, "file", file)
		for playing := true; playing; {
			src, closeFn, err := audio.OggFile(file)
			if err != nil {
				slog.Error("can't open the radio file", "err", err)
				return
			}
			pb := call.Play(src)
			select {
			case <-pb.Done():
				playing = pb.Err() == nil // played to the end: again
			case <-call.Done():
				playing = false
			}
			closeFn()
		}
		<-call.Done()
		switch call.Why() {
		case "left", "removed from the room", "the bot stopped":
			slog.Info("radio off", "room", roomID, "why", call.Why())
			return // an admin took it out, or it's gone: stay out
		}
		if !sleep(ctx, 5*time.Second) {
			return
		}
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-time.After(d):
		return true
	case <-ctx.Done():
		return false
	}
}
