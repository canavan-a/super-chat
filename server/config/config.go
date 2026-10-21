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
	// AppleAppIDs lists the iOS app IDs (TeamID.bundleID) served in
	// /.well-known/apple-app-site-association so iOS opens invite links in
	// the app.
	AppleAppIDs  []string
	MaxBlobBytes int64
	// TrustProxy keys rate limits on the rightmost X-Forwarded-For entry of
	// requests arriving over loopback (Pangolin/newt, cloudflared). See
	// api.clientIP.
	TrustProxy bool
	// StaticDir, when set, serves the built web client on StaticListenAddr.
	StaticDir        string
	StaticListenAddr string
	// FCMCredentialsFile is a Firebase service account key. When set, new
	// messages wake the Google Play build's devices through FCM (package push).
	FCMCredentialsFile string
}

func Load() Config {
	dataDir := getEnv("SUPERCHAT_DATA_DIR", ".data")
	maxMB, _ := strconv.Atoi(getEnv("SUPERCHAT_MAX_BLOB_MB", "25"))
	return Config{
		ListenAddr:         getEnv("SUPERCHAT_LISTEN_ADDR", ":8080"),
		DataDir:            dataDir,
		DBPath:             getEnv("SUPERCHAT_DB_PATH", filepath.Join(dataDir, "superchat.db")),
		BlobDir:            filepath.Join(dataDir, "blobs"),
		PublicOrigin:       strings.TrimRight(os.Getenv("SUPERCHAT_PUBLIC_ORIGIN"), "/"),
		AndroidCertSHA256:  splitList(os.Getenv("SUPERCHAT_ANDROID_CERT_SHA256")),
		AppleAppIDs:        splitList(os.Getenv("SUPERCHAT_APPLE_APP_IDS")),
		MaxBlobBytes:       int64(maxMB) << 20,
		TrustProxy:         os.Getenv("SUPERCHAT_TRUST_PROXY") == "1",
		StaticDir:          os.Getenv("SUPERCHAT_STATIC_DIR"),
		StaticListenAddr:   getEnv("SUPERCHAT_STATIC_LISTEN_ADDR", ":8081"),
		FCMCredentialsFile: os.Getenv("SUPERCHAT_FCM_CREDENTIALS_FILE"),
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
