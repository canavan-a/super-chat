package config

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddr string
	DataDir    string
	DBPath     string
	BlobDir    string
	// PublicOrigin is the https origin invite links point at, e.g.
	// https://chat.superbadger.io. Used by the /i/:id landing page.
	PublicOrigin string
	// AndroidCertSHA256 lists the release-key fingerprints served in
	// /.well-known/assetlinks.json so Android opens invite links in the app.
	AndroidCertSHA256 []string
	MaxBlobBytes      int64
	// TrustProxy keys rate limits on the rightmost X-Forwarded-For entry of
	// requests arriving over loopback (Pangolin/newt, cloudflared). See
	// api.clientIP.
	TrustProxy bool
	// StaticDir, when set, serves the built web client on StaticListenAddr.
	StaticDir        string
	StaticListenAddr string
	// TURNURLs are the STUN/TURN URLs offered to voice clients by
	// /v1/rooms/:id/turn. With TURNSecret set (coturn's static-auth-secret),
	// the endpoint also hands out credentials that expire after TURNTTL.
	TURNURLs   []string
	TURNSecret []byte
	TURNTTL    time.Duration
}

func Load() Config {
	dataDir := getEnv("SUPERCHAT_DATA_DIR", ".data")
	maxMB, _ := strconv.Atoi(getEnv("SUPERCHAT_MAX_BLOB_MB", "25"))
	var turnSecret []byte
	if f := os.Getenv("SUPERCHAT_TURN_SECRET_FILE"); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			log.Fatalf("reading SUPERCHAT_TURN_SECRET_FILE: %v", err)
		}
		turnSecret = bytes.TrimSpace(b)
	}
	turnTTL, err := time.ParseDuration(getEnv("SUPERCHAT_TURN_TTL", "12h"))
	if err != nil || turnTTL <= 0 {
		log.Fatalf("bad SUPERCHAT_TURN_TTL: %q", os.Getenv("SUPERCHAT_TURN_TTL"))
	}
	return Config{
		ListenAddr:        getEnv("SUPERCHAT_LISTEN_ADDR", ":8080"),
		DataDir:           dataDir,
		DBPath:            getEnv("SUPERCHAT_DB_PATH", filepath.Join(dataDir, "superchat.db")),
		BlobDir:           filepath.Join(dataDir, "blobs"),
		PublicOrigin:      strings.TrimRight(os.Getenv("SUPERCHAT_PUBLIC_ORIGIN"), "/"),
		AndroidCertSHA256: splitList(os.Getenv("SUPERCHAT_ANDROID_CERT_SHA256")),
		MaxBlobBytes:      int64(maxMB) << 20,
		TrustProxy:        os.Getenv("SUPERCHAT_TRUST_PROXY") == "1",
		StaticDir:         os.Getenv("SUPERCHAT_STATIC_DIR"),
		StaticListenAddr:  getEnv("SUPERCHAT_STATIC_LISTEN_ADDR", ":8081"),
		TURNURLs:          splitList(os.Getenv("SUPERCHAT_TURN_URLS")),
		TURNSecret:        turnSecret,
		TURNTTL:           turnTTL,
	}
}

// splitList splits a comma-separated env value, dropping blanks.
func splitList(s string) []string {
	var out []string
	for _, v := range strings.Split(s, ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
