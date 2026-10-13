package main

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/joho/godotenv"

	"main/api"
	"main/config"
	"main/database"
	"main/rooms"
	"main/static"
	"main/sweeper"
)

func main() {
	// .env is optional: local dev only; systemd sets the real environment.
	_ = godotenv.Load()
	cfg := config.Load()

	if err := os.MkdirAll(cfg.BlobDir, 0o750); err != nil {
		log.Fatalf("blob dir: %v", err)
	}
	db, err := database.Connect(cfg.DBPath)
	if err != nil {
		log.Fatalf("connect db: %v", err)
	}

	svc := rooms.NewService(db, cfg.BlobDir)
	a := api.New(db, cfg, svc)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sweeper.Run(ctx, svc, time.Hour)

	if cfg.StaticDir != "" {
		go func() {
			log.Printf("serving web client on %s from %s", cfg.StaticListenAddr, cfg.StaticDir)
			if err := static.Serve(cfg.StaticListenAddr, cfg.StaticDir); err != nil {
				log.Fatalf("static server error: %v", err)
			}
		}()
	}

	log.Printf("superchat listening on %s", cfg.ListenAddr)
	if err := a.Router().Run(cfg.ListenAddr); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
