package bot

import (
	"regexp"
	"strings"
)

// tuneSDP is app/src/call/sdp.ts in Go, applied to every SDP the bot sends.
// Opus fmtp parameters say what the receiver wants, so putting them in what
// we hand over asks for mono, constant bitrate speech at up to 32 kbps; CBR
// also keeps packet sizes from following the shape of speech, which a relay
// could otherwise read. The audio-level header extension is dropped too: it
// rides unencrypted on every packet and would tell a relay who is talking.
func tuneSDP(sdp string) string {
	eol := "\n"
	if strings.Contains(sdp, "\r\n") {
		eol = "\r\n"
	}
	var lines []string
	for _, l := range strings.Split(sdp, eol) {
		if !audioLevelExt.MatchString(l) {
			lines = append(lines, l)
		}
	}
	opus := map[string]bool{}
	hasFmtp := map[string]bool{}
	for _, l := range lines {
		if m := opusRtpmap.FindStringSubmatch(l); m != nil {
			opus[m[1]] = true
		}
		if m := fmtpLine.FindStringSubmatch(l); m != nil {
			hasFmtp[m[1]] = true
		}
	}
	out := make([]string, 0, len(lines)+1)
	for _, l := range lines {
		if m := fmtpLine.FindStringSubmatch(l); m != nil && opus[m[1]] {
			out = append(out, "a=fmtp:"+m[1]+" "+mergeOpusParams(m[2]))
			continue
		}
		out = append(out, l)
		// An Opus codec with no fmtp line at all: add one right after rtpmap.
		if m := opusRtpmap.FindStringSubmatch(l); m != nil && !hasFmtp[m[1]] {
			out = append(out, "a=fmtp:"+m[1]+" "+mergeOpusParams(""))
		}
	}
	return strings.Join(out, eol)
}

var (
	audioLevelExt = regexp.MustCompile(`^a=extmap:\d+(/\w+)?\s+urn:ietf:params:rtp-hdrext:ssrc-audio-level`)
	opusRtpmap    = regexp.MustCompile(`(?i)^a=rtpmap:(\d+) opus/48000`)
	fmtpLine      = regexp.MustCompile(`^a=fmtp:(\d+) (.*)$`)
)

// opusParams is OPUS_PARAMS in sdp.ts, in the same order.
var opusParams = [][2]string{
	{"stereo", "0"},
	{"sprop-stereo", "0"},
	{"cbr", "1"},
	{"maxaveragebitrate", "32000"},
	{"useinbandfec", "1"},
}

func mergeOpusParams(existing string) string {
	var keys []string
	vals := map[string]string{}
	set := func(k, v string) {
		if _, ok := vals[k]; !ok {
			keys = append(keys, k)
		}
		vals[k] = v
	}
	for _, kv := range strings.Split(existing, ";") {
		k, v, _ := strings.Cut(strings.TrimSpace(kv), "=")
		if k != "" {
			set(k, v)
		}
	}
	for _, p := range opusParams {
		set(p[0], p[1])
	}
	parts := make([]string, len(keys))
	for i, k := range keys {
		if vals[k] == "" {
			parts[i] = k
		} else {
			parts[i] = k + "=" + vals[k]
		}
	}
	return strings.Join(parts, ";")
}

// sendOnly marks an answer send-only. pion turns a send-only transceiver
// into send-and-receive when the offer is send-and-receive (as a phone's is:
// it has a microphone), and has no way to set it back. The direction the
// other side acts on is the one in the answer it gets, though (JSEP: an
// offer of sendrecv answered sendonly leaves the offerer receive-only), so
// marking what we send is enough for the phone never to upload its
// microphone to the bot. pion then only waits for packets that never come.
func sendOnly(sdp string) string {
	eol := "\n"
	if strings.Contains(sdp, "\r\n") {
		eol = "\r\n"
	}
	lines := strings.Split(sdp, eol)
	for i, l := range lines {
		switch l {
		case "a=sendrecv":
			lines[i] = "a=sendonly"
		case "a=recvonly":
			lines[i] = "a=inactive"
		}
	}
	return strings.Join(lines, eol)
}
