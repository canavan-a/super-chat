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

// ---- the Add / Edit server form ----

export type IceKind = 'stun' | 'turn';
export type TurnTransport = 'auto' | 'udp' | 'tcp';

/** What the form edits: a server split into the parts people actually choose. */
export interface IceForm {
  kind: IceKind;
  /** host or host:port */
  address: string;
  /** stuns: / turns: (over TLS, RFC 7064/7065) instead of stun: / turn:. */
  tls: boolean;
  /**
   * TURN only (RFC 7065 ?transport=). Over TLS, tcp is TLS and udp is DTLS;
   * STUN URIs take no transport.
   */
  transport: TurnTransport;
  username: string;
  password: string;
}

export const EMPTY_ICE_FORM: IceForm = {
  kind: 'turn',
  address: '',
  tls: false,
  transport: 'auto',
  username: '',
  password: '',
};

/** A saved server, back into form parts (the password is left blank). */
export function iceFormFrom(e: IceServerEntry): IceForm {
  const m = /^(stuns?|turns?):([^?]*)(?:\?transport=(udp|tcp))?$/.exec(
    e.urls.trim(),
  );
  const scheme = m?.[1] ?? 'turn';
  return {
    kind: scheme.startsWith('stun') ? 'stun' : 'turn',
    address: m?.[2] ?? e.urls,
    tls: scheme === 'turns' || scheme === 'stuns',
    transport:
      scheme.startsWith('turn') && m?.[3] ? (m[3] as TurnTransport) : 'auto',
    username: e.username ?? '',
    password: '',
  };
}

/**
 * The server a form describes, or why it isn't one yet. When editing, a
 * blank password keeps `keepCredential` (the saved one).
 */
export function entryFromForm(
  f: IceForm,
  keepCredential?: string,
): {entry: IceServerEntry} | {error: string} {
  let address = f.address.trim();
  let kind = f.kind;
  let tls = f.tls;
  let transportSel = f.transport;
  // A whole URL pasted into the address box: take it as it is.
  const pasted = /^(stuns?|turns?):(.*)$/.exec(address);
  if (pasted) {
    kind = pasted[1].startsWith('stun') ? 'stun' : 'turn';
    if (kind !== f.kind)
      return {
        error: `That's a ${kind.toUpperCase()} address; choose ${kind.toUpperCase()} above`,
      };
    tls = pasted[1].endsWith('s');
    transportSel =
      (/\?transport=(udp|tcp)$/.exec(pasted[2])?.[1] as TurnTransport) ??
      'auto';
    address = pasted[2].replace(/\?.*$/, '');
  }
  if (!address) return {error: 'Enter the server address'};
  const scheme = kind + (tls ? 's' : '');
  const transport =
    kind === 'turn' && transportSel !== 'auto'
      ? `?transport=${transportSel}`
      : '';
  const urls = `${scheme}:${address}${transport}`;
  const bad = validateIceUrl(urls);
  if (bad)
    return {
      error: bad.replace(
        /^Expected e\.g\..*/,
        'Expected a host name or IP, optionally with :port',
      ),
    };
  if (kind === 'stun') return {entry: {urls}};
  const username = f.username.trim();
  const credential = f.password || keepCredential || '';
  if (!username) return {error: 'TURN needs a username'};
  if (!credential) return {error: 'TURN needs a password'};
  return {entry: {urls, username, credential}};
}

/** Identifies an entry exactly, credentials included, so a test result only counts for what was tested. */
export const entryKey = (e: IceServerEntry) =>
  JSON.stringify([e.urls, e.username ?? '', e.credential ?? '']);

/** The standard port for a scheme (RFC 7064/7065): 3478, or 5349 over TLS. */
export const defaultIcePort = (tls: boolean) => (tls ? 5349 : 3478);
