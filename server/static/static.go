// Package static serves the app's built web client (`npm run build:web`, a
// Vite/react-native-web static bundle with nothing secret in it) on its own
// HTTP port, separate from the API. Keys never leave the browser, so these
// are just static assets. Exposing the port (tunnel, proxy) is up to the
// operator.
package static

import (
	"net/http"
	"os"
	"path/filepath"
)

// Serve starts a blocking HTTP server on addr, serving dir as static files
// with SPA fallback: a request for a path that doesn't exist on disk is
// served dir/index.html instead of 404ing, so react-native-web's client-side
// routing survives a refresh or deep link.
func Serve(addr, dir string) error {
	fileServer := http.FileServer(http.Dir(dir))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean(r.URL.Path))
		if info, err := os.Stat(p); err != nil || info.IsDir() {
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		fileServer.ServeHTTP(w, r)
	})
	return http.ListenAndServe(addr, handler)
}
