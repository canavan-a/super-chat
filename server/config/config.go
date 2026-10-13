package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
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
	// TrustProxy makes rate limiting key on CF-Connecting-IP /
	// X-Forwarded-For (set it behind cloudflared or nginx).
	TrustProxy bool
	// StaticDir, when set, serves the built web client on StaticListenAddr.
	StaticDir        string
	StaticListenAddr string
}

func Load() Config {
	dataDir := getEnv("SUPERCHAT_DATA_DIR", ".data")
	maxMB, _ := strconv.Atoi(getEnv("SUPERCHAT_MAX_BLOB_MB", "25"))
	var certs []string
	for _, c := range strings.Split(os.Getenv("SUPERCHAT_ANDROID_CERT_SHA256"), ",") {
		if c = strings.TrimSpace(c); c != "" {
			certs = append(certs, c)
		}
	}
	return Config{
		ListenAddr:        getEnv("SUPERCHAT_LISTEN_ADDR", ":8080"),
		DataDir:           dataDir,
		DBPath:            getEnv("SUPERCHAT_DB_PATH", filepath.Join(dataDir, "superchat.db")),
		BlobDir:           filepath.Join(dataDir, "blobs"),
		PublicOrigin:      strings.TrimRight(os.Getenv("SUPERCHAT_PUBLIC_ORIGIN"), "/"),
		AndroidCertSHA256: certs,
		MaxBlobBytes:      int64(maxMB) << 20,
		TrustProxy:        os.Getenv("SUPERCHAT_TRUST_PROXY") == "1",
		StaticDir:         os.Getenv("SUPERCHAT_STATIC_DIR"),
		StaticListenAddr:  getEnv("SUPERCHAT_STATIC_LISTEN_ADDR", ":8081"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
