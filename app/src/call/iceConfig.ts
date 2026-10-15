// Which STUN/TURN servers voice uses: the ones configured on this device
// (Settings → Voice), plus the chat server's own relay when it offers one
// and that's switched on. Each side of a call uses its own list; a relay
// candidate from your TURN server works for any peer.

export interface IceServerEntry {
  urls: string;
  username?: string;
  credential?: string;
}

export interface VoiceIceSettings {
  iceServers: IceServerEntry[];
  useServerRelay: boolean;
  relayOnlyVoice: boolean;
}

/** What GET /v1/rooms/:id/turn returns. */
export interface ServerTurn {
  urls: string[];
  username?: string;
  credential?: string;
  ttl?: number;
}

export type IceCoverage = 'none' | 'stun-only' | 'turn';

export const DEFAULT_STUN = 'stun:stun.l.google.com:19302';
export const DEFAULT_ICE_SERVERS: IceServerEntry[] = [{urls: DEFAULT_STUN}];

const URL_RE =
  /^(stun|stuns|turn|turns):(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?(\?transport=(udp|tcp))?$/;

/** Null when url is a valid STUN/TURN URL, otherwise what's wrong with it. */
export function validateIceUrl(url: string): string | null {
  const u = url.trim();
  if (!u) return 'Enter a URL';
  if (!/^(stun|stuns|turn|turns):/.test(u))
    return 'Must start with stun:, turn: or turns:';
  if (!URL_RE.test(u))
    return 'Expected e.g. turn:host:3478 or turns:host:443?transport=tcp';
  const port = /:(\d+)(\?|$)/.exec(u.replace(/^\w+:/, ''))?.[1];
  if (port && (Number(port) < 1 || Number(port) > 65535))
    return 'Port must be 1–65535';
  if (/^stuns?:/.test(u) && u.includes('?transport='))
    return 'STUN URLs take no transport';
  return null;
}

export const isTurnUrl = (url: string) => /^turns?:/.test(url.trim());

export function buildIceConfig(
  s: VoiceIceSettings,
  serverTurn: ServerTurn | null,
): RTCConfiguration {
  const servers: RTCIceServer[] = [];
  const seen = new Set<string>();
  const add = (urls: string, username?: string, credential?: string) => {
    const u = urls.trim();
    const key = `${u}|${username ?? ''}`;
    if (!u || seen.has(key)) return;
    seen.add(key);
    servers.push(
      username !== undefined || credential !== undefined
        ? {urls: u, username, credential}
        : {urls: u},
    );
  };
  for (const e of s.iceServers)
    add(
      e.urls,
      isTurnUrl(e.urls) ? e.username : undefined,
      isTurnUrl(e.urls) ? e.credential : undefined,
    );
  if (s.useServerRelay && serverTurn) {
    for (const u of serverTurn.urls) {
      add(
        u,
        isTurnUrl(u) ? serverTurn.username : undefined,
        isTurnUrl(u) ? serverTurn.credential : undefined,
      );
    }
  }
  const cfg: RTCConfiguration = {
    iceServers: servers,
    iceCandidatePoolSize: 0,
    bundlePolicy: 'max-bundle',
  };
  // Relay-only with nothing to relay through would never connect.
  cfg.iceTransportPolicy =
    s.relayOnlyVoice && iceCoverage(cfg) === 'turn' ? 'relay' : 'all';
  return cfg;
}

export function iceCoverage(cfg: RTCConfiguration): IceCoverage {
  const urls = (cfg.iceServers ?? []).flatMap(s =>
    Array.isArray(s.urls) ? s.urls : [s.urls],
  );
  if (urls.some(u => isTurnUrl(u))) return 'turn';
  if (urls.length) return 'stun-only';
  return 'none';
}

/** The same summary for Settings, before any server relay is fetched. */
export function settingsCoverage(s: VoiceIceSettings): IceCoverage {
  if (s.iceServers.some(e => isTurnUrl(e.urls))) return 'turn';
  if (s.iceServers.length) return 'stun-only';
  return 'none';
}
