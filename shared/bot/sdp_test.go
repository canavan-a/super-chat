package bot

import (
	"strings"
	"testing"
)

func TestTuneSDP(t *testing.T) {
	in := strings.Join([]string{
		"v=0",
		"m=audio 9 UDP/TLS/RTP/SAVPF 111 0",
		"a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
		"a=extmap:2/sendrecv urn:ietf:params:rtp-hdrext:ssrc-audio-level",
		"a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
		"a=rtpmap:111 opus/48000/2",
		"a=fmtp:111 minptime=10;useinbandfec=0;stereo=1",
		"a=rtpmap:0 PCMU/8000",
		"",
	}, "\r\n")
	out := tuneSDP(in)
	if strings.Contains(out, "ssrc-audio-level") {
		t.Fatal("the audio-level extension is still there")
	}
	if !strings.Contains(out, "transport-wide-cc") {
		t.Fatal("dropped an extension it shouldn't have")
	}
	want := "a=fmtp:111 minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;cbr=1;maxaveragebitrate=32000"
	if !strings.Contains(out, want+"\r\n") {
		t.Fatalf("fmtp:\n%s", out)
	}
	// No fmtp line at all: one is added after the rtpmap.
	out = tuneSDP("a=rtpmap:109 opus/48000/2\na=sendonly")
	if out != "a=rtpmap:109 opus/48000/2\na=fmtp:109 stereo=0;sprop-stereo=0;cbr=1;maxaveragebitrate=32000;useinbandfec=1\na=sendonly" {
		t.Fatalf("added fmtp:\n%s", out)
	}
}
