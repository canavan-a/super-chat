package api

import (
	"html/template"
	"net/http"

	"github.com/gin-gonic/gin"

	"main/proto"
)

// landing is what an invite link opens when the app isn't installed or the
// link wasn't routed to it. The secret after '#' never reaches this server;
// the page's own script reads it and hands it to the app.
func (a *API) landing(c *gin.Context) {
	id := c.Param("id")
	if !proto.IsID(id) {
		c.String(http.StatusNotFound, "not found")
		return
	}
	c.Header("Content-Type", "text/html; charset=utf-8")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
	_ = landingTmpl.Execute(c.Writer, gin.H{"ID": id})
}

var landingTmpl = template.Must(template.New("landing").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Super Chat invite</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0d1117; color:#e6edf3; font:15px/1.5 system-ui, sans-serif; }
  main { max-width:420px; padding:24px; text-align:center; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:#8b949e; margin:0 0 20px; }
  a.btn, button { display:block; width:100%; box-sizing:border-box; padding:12px; border-radius:10px;
         border:1px solid #30363d; background:#2f81f7; color:#fff; font:600 15px system-ui;
         text-decoration:none; margin-bottom:10px; cursor:pointer; }
  button { background:#161b22; color:#e6edf3; }
  #err { color:#f85149; }
</style></head>
<body><main>
  <h1>You're invited to a Super Chat room</h1>
  <p id="hint">Open this link in the Super Chat app to join. The room's key is in this link; this server never sees it.</p>
  <a class="btn" id="open" href="#">Open in Super Chat</a>
  <button id="copy" type="button">Copy invite link</button>
  <p id="err"></p>
</main>
<script>
(function () {
  var id = {{.ID}};
  var secret = location.hash.slice(1);
  if (!secret) {
    document.getElementById('err').textContent = 'This link is incomplete: the part after # is missing.';
    return;
  }
  var q = 's=' + encodeURIComponent(location.origin) + '&i=' + encodeURIComponent(id) + '&k=' + encodeURIComponent(secret);
  var isAndroid = /Android/i.test(navigator.userAgent);
  document.getElementById('open').href = isAndroid
    ? 'intent://join?' + q + '#Intent;scheme=superchat;package=com.superchatapp;end'
    : 'superchat://join?' + q;
  document.getElementById('copy').onclick = function () {
    navigator.clipboard.writeText(location.href).then(function () {
      document.getElementById('copy').textContent = 'Copied';
    });
  };
})();
</script>
</body></html>`))

func (a *API) assetLinks(c *gin.Context) {
	if len(a.cfg.AndroidCertSHA256) == 0 {
		c.JSON(http.StatusOK, []any{})
		return
	}
	c.JSON(http.StatusOK, []gin.H{{
		"relation": []string{"delegate_permission/common.handle_all_urls"},
		"target": gin.H{
			"namespace":                "android_app",
			"package_name":             "com.superchatapp",
			"sha256_cert_fingerprints": a.cfg.AndroidCertSHA256,
		},
	}})
}
