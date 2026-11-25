package bot

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"time"
)

// The control socket: how the CLI on the bot's machine reaches the running
// bot (superchat-bot join <link>). A unix socket in the data directory,
// readable only by the bot's user; one JSON request and answer per line.

// ControlSocket is the socket's file name in the data directory.
const ControlSocket = "control.sock"

type controlRequest struct {
	Op   string `json:"op"` // "join" or "rooms"
	Link string `json:"link,omitempty"`
}

type controlResponse struct {
	Error string `json:"error,omitempty"`
	Room  *Room  `json:"room,omitempty"`
	Rooms []Room `json:"rooms,omitempty"`
}

func (b *Bot) serveControl(ctx context.Context) (stop func(), err error) {
	path := filepath.Join(b.cfg.DataDir, ControlSocket)
	// A socket left by a bot that didn't exit cleanly; a live one answers.
	if c, err := net.DialTimeout("unix", path, time.Second); err == nil {
		c.Close()
		return nil, errors.New("another bot is already running on " + b.cfg.DataDir)
	}
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(path, 0o600)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go b.handleControl(ctx, c)
		}
	}()
	return func() { ln.Close(); _ = os.Remove(path) }, nil
}

func (b *Bot) handleControl(ctx context.Context, c net.Conn) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Minute))
	var req controlRequest
	if err := json.NewDecoder(bufio.NewReader(c)).Decode(&req); err != nil {
		return
	}
	var resp controlResponse
	switch req.Op {
	case "join":
		r, err := b.Join(ctx, req.Link)
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Room = &r
		}
	case "rooms":
		resp.Rooms = b.Rooms()
	default:
		resp.Error = "unknown request " + req.Op
	}
	_ = json.NewEncoder(c).Encode(resp)
}

// ControlJoin asks the bot running on dataDir to join a room.
func ControlJoin(dataDir, link string) (Room, error) {
	resp, err := control(dataDir, controlRequest{Op: "join", Link: link})
	if err != nil {
		return Room{}, err
	}
	return *resp.Room, nil
}

// ControlRooms asks the bot running on dataDir which rooms it's in.
func ControlRooms(dataDir string) ([]Room, error) {
	resp, err := control(dataDir, controlRequest{Op: "rooms"})
	if err != nil {
		return nil, err
	}
	return resp.Rooms, nil
}

func control(dataDir string, req controlRequest) (*controlResponse, error) {
	c, err := net.DialTimeout("unix", filepath.Join(dataDir, ControlSocket), 2*time.Second)
	if err != nil {
		return nil, errors.New("the bot isn't running on " + dataDir + " (start it with run)")
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Minute))
	if err := json.NewEncoder(c).Encode(req); err != nil {
		return nil, err
	}
	var resp controlResponse
	if err := json.NewDecoder(c).Decode(&resp); err != nil {
		return nil, err
	}
	if resp.Error != "" {
		return nil, errors.New(resp.Error)
	}
	return &resp, nil
}
