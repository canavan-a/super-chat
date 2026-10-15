// Sharing a STUN/TURN server through a chat (a `t: 'ice'` message): what the
// card shows, and checking what arrives before anyone can add it.
import {
  entryKey,
  iceFormFrom,
  isTurnUrl,
  validateIceUrl,
  type IceServerEntry,
} from './iceConfig';

export interface IceDescription {
  kind: 'STUN' | 'TURN';
  host: string;
  /** "UDP", "TCP", or "" when the URL leaves it to the client. */
  transport: string;
  tls: boolean;
}

export function describeIce(e: IceServerEntry): IceDescription {
  const f = iceFormFrom(e);
  return {
    kind: f.kind === 'stun' ? 'STUN' : 'TURN',
    host: f.address,
    transport:
      f.kind === 'turn' && f.transport !== 'auto'
        ? f.transport.toUpperCase()
        : '',
    tls: f.tls,
  };
}

/**
 * A shared server as an entry this device could use, or null if it isn't a
 * valid one (it came from another member; never trust its shape).
 */
export function sharedEntry(server: unknown): IceServerEntry | null {
  if (!server || typeof server !== 'object') return null;
  const s = server as Record<string, unknown>;
  if (typeof s.urls !== 'string' || validateIceUrl(s.urls)) return null;
  if (!isTurnUrl(s.urls)) return {urls: s.urls.trim()};
  if (
    typeof s.username !== 'string' ||
    typeof s.credential !== 'string' ||
    !s.username ||
    !s.credential
  )
    return null;
  if (s.username.length > 512 || s.credential.length > 512) return null;
  return {urls: s.urls.trim(), username: s.username, credential: s.credential};
}

/** Is exactly this server (credentials included) already on this device? */
export function alreadyAdded(
  e: IceServerEntry,
  list: IceServerEntry[],
): boolean {
  const k = entryKey(e);
  return list.some(x => entryKey(x) === k);
}
