// SDP edits applied to what we send a peer (never to our own local
// description). Opus fmtp parameters describe what the receiver wants, so
// putting them in the SDP we hand over asks the peer's encoder for mono,
// constant-bitrate speech at up to 32 kbps. CBR also keeps packet sizes from
// following the shape of speech, which a relay could otherwise read.
//
// The audio-level header extension is dropped too: it rides unencrypted on
// every packet and would tell a relay who is talking. Speaking indicators
// come from getStats() instead (call/quality.ts).

const OPUS_PARAMS: Record<string, string> = {
  stereo: '0',
  'sprop-stereo': '0',
  cbr: '1',
  maxaveragebitrate: '32000',
  useinbandfec: '1',
};

export function tuneSdp(sdp: string): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp
    .split(eol)
    .filter(
      l =>
        !/^a=extmap:\d+(\/\w+)?\s+urn:ietf:params:rtp-hdrext:ssrc-audio-level/.test(
          l,
        ),
    );
  const opusPts = new Set<string>();
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(l);
    if (m) opusPts.add(m[1]);
  }
  const out: string[] = [];
  for (const l of lines) {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (m && opusPts.has(m[1])) {
      out.push(`a=fmtp:${m[1]} ${mergeParams(m[2])}`);
      continue;
    }
    out.push(l);
    const r = /^a=rtpmap:(\d+) opus\/48000/i.exec(l);
    // An opus codec with no fmtp line at all: add one right after rtpmap.
    if (r && !lines.some(x => x.startsWith(`a=fmtp:${r[1]} `))) {
      out.push(`a=fmtp:${r[1]} ${mergeParams('')}`);
    }
  }
  return out.join(eol);
}

function mergeParams(existing: string): string {
  const params = new Map<string, string>();
  for (const kv of existing.split(';')) {
    const [k, ...v] = kv.trim().split('=');
    if (k) params.set(k, v.join('='));
  }
  for (const [k, v] of Object.entries(OPUS_PARAMS)) params.set(k, v);
  return [...params].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
}
