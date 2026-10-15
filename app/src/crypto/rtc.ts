// Voice-room signaling (docs/protocol.md, "Voice rooms"). The server relays
// these boxes without storing them; sealing them under the room's epoch key
// and signing the inside keeps it from reading or forging SDP, which is what
// would let it sit in the middle of a call (the DTLS fingerprints are in it).
import {b64, pubFromMemberId, unb64, unutf8, utf8} from './encoding';
import {aeadOpen, aeadSeal, sign, verify} from './primitives';
import type {Member} from './identity';

export type SignalKind =
  | 'probe'
  | 'join'
  | 'here'
  | 'full'
  | 'offer'
  | 'answer'
  | 'ice'
  | 'leave'
  | 'beat';

export interface Signal {
  sid: string;
  to_sid?: string;
  k: SignalKind;
  sdp?: string;
  cand?: unknown;
  muted?: boolean;
  deaf?: boolean;
}

export type OpenedSignal = Signal & {ts: number};

/** How far a signal's ts may be from our clock before it's dropped as a replay. */
export const SIGNAL_MAX_SKEW_MS = 60_000;

const rtcAd = (room: string, epoch: number, from: string, to: string) =>
  utf8(`sc-rtc|${room}|${epoch}|${from}|${to}`);
const rtcSigMsg = (room: string, to: string, inner: Uint8Array) => {
  const prefix = utf8(`sc-rtc|${room}|${to}|`);
  const out = new Uint8Array(prefix.length + inner.length);
  out.set(prefix);
  out.set(inner, prefix.length);
  return out;
};

/** `to` is a member ID, or '' to broadcast. Returns the box: "<epoch>.<b64>". */
export function sealSignal(
  me: Member,
  room: string,
  epoch: number,
  key: Uint8Array,
  to: string,
  signal: Signal,
  now = Date.now(),
): string {
  const inner = utf8(JSON.stringify({v: 1, ...signal, ts: now}));
  const sig = sign(me.edSeed, '', rtcSigMsg(room, to, inner));
  const outer = utf8(JSON.stringify({c: b64(inner), s: b64(sig)}));
  return `${epoch}.${b64(aeadSeal(key, outer, rtcAd(room, epoch, me.id, to)))}`;
}

/** The epoch a box claims, so the caller can pick the key. */
export function signalEpoch(box: string): number {
  const epoch = Number(box.slice(0, box.indexOf('.')));
  if (!Number.isSafeInteger(epoch) || epoch < 0)
    throw new Error('bad signal box');
  return epoch;
}

/**
 * Opens a box the server says `from` sent to us (`to` is our member ID for a
 * directed signal, '' for a broadcast). Throws unless the AEAD, the sender's
 * signature and the timestamp all check out.
 */
export function openSignal(
  room: string,
  from: string,
  to: string,
  box: string,
  key: Uint8Array,
  now = Date.now(),
): OpenedSignal {
  const epoch = signalEpoch(box);
  const outer = JSON.parse(
    unutf8(
      aeadOpen(
        key,
        unb64(box.slice(box.indexOf('.') + 1)),
        rtcAd(room, epoch, from, to),
      ),
    ),
  );
  const inner = unb64(outer.c);
  if (
    !verify(
      pubFromMemberId(from),
      '',
      rtcSigMsg(room, to, inner),
      unb64(outer.s),
    )
  ) {
    throw new Error('bad signal signature');
  }
  const s = JSON.parse(unutf8(inner));
  if (s.v !== 1) throw new Error('unsupported signal version');
  if (typeof s.ts !== 'number' || Math.abs(now - s.ts) > SIGNAL_MAX_SKEW_MS)
    throw new Error('stale signal');
  if (typeof s.sid !== 'string' || typeof s.k !== 'string')
    throw new Error('bad signal');
  delete s.v;
  return s;
}
