// The room log, client side: building and signing events, and replaying a
// log the server hands back while checking every rule ourselves. This is the
// TypeScript twin of server/proto/room.go; the two must agree. The client
// never trusts the server's word for who is in a room or who is an admin.
import {b64, concat, isId, pubFromMemberId, unb64, unutf8, utf8} from './encoding';
import {aeadOpen, aeadSeal, sha256, sign, verify} from './primitives';
import type {Signer} from './identity';

export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type Role = 'admin' | 'member';

export interface SignedEvent {
  body: string;
  sig: string;
}

export interface EventBody {
  v: 1;
  room: string;
  seq: number;
  prev: string;
  author: string;
  ts: number;
  kind: string;
  pub: Record<string, any>;
  epoch: number;
  enc: string;
}

export interface ParsedEvent extends EventBody {
  raw: Uint8Array;
  sigBytes: Uint8Array;
  hash: string;
  signed: SignedEvent;
}

export interface Invite {
  key: string;
  expiresAt: number;
  maxUses: number;
  uses: number;
  revoked: boolean;
  creator: string;
  createdAt: number;
}

export interface LogState {
  room: string;
  nextSeq: number;
  head: string;
  members: Record<string, Role>;
  /** Each member's room-scoped X25519 key (b64), from their create/join event. */
  keys: Record<string, string>;
  epoch: number;
  pendingRotation: boolean;
  invites: Record<string, Invite>;
  retentionDays: number;
}

export function newState(room: string): LogState {
  return {room, nextSeq: 0, head: '', members: {}, keys: {}, epoch: 0, pendingRotation: false, invites: {}, retentionDays: 0};
}

export function cloneState(s: LogState): LogState {
  const invites: Record<string, Invite> = {};
  for (const [k, v] of Object.entries(s.invites)) invites[k] = {...v};
  return {...s, members: {...s.members}, keys: {...s.keys}, invites};
}

export const sortedMembers = (s: LogState): string[] => Object.keys(s.members).sort();

export function parseEvent(se: SignedEvent): ParsedEvent {
  const raw = unb64(se.body);
  const sigBytes = unb64(se.sig);
  const body = JSON.parse(unutf8(raw)) as EventBody;
  if (body.v !== 1) throw new Error('unsupported event version');
  if (!verify(pubFromMemberId(body.author), 'sc-evt', raw, sigBytes)) throw new Error('bad event signature');
  return {
    ...body,
    pub: body.pub ?? {},
    epoch: body.epoch ?? 0,
    enc: body.enc ?? '',
    raw,
    sigBytes,
    hash: b64(sha256(concat(raw, sigBytes))),
    signed: se,
  };
}

export function joinProofMessage(room: string, invite: string, account: string): Uint8Array {
  return utf8(`sc-join|${room}|${invite}|${account}`);
}

export function epochCommit(room: string, n: number, key: Uint8Array): string {
  return b64(sha256(concat(utf8(`sc-commit|${room}|${n}|`), key)));
}

function validKey(k: unknown): boolean {
  try {
    return typeof k === 'string' && unb64(k).length === 32;
  } catch {
    return false;
  }
}

const validRetention = (d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 3650;

function arraysEqual(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Checks e against s and applies it in place, throwing if it's not allowed.
 * `now` is a clock in ms for appending; pass 0 when replaying.
 */
export function applyEvent(s: LogState, e: ParsedEvent, now = 0): void {
  if (e.room !== s.room) throw new Error('event is for another room');
  if (e.seq !== s.nextSeq || e.prev !== s.head) throw new Error('conflict');
  if (now !== 0 && Math.abs(e.ts - now) > MAX_CLOCK_SKEW_MS) throw new Error('event ts too far from clock');
  if (e.enc !== '' && (e.epoch < 1 || e.epoch > s.epoch + 1)) throw new Error('enc under unknown epoch');
  if (e.seq === 0 && e.kind !== 'create') throw new Error('first event must be create');

  const a = e.author;
  const isMember = (id: string) => id in s.members;
  const isAdmin = (id: string) => s.members[id] === 'admin';
  const p = e.pub;

  switch (e.kind) {
    case 'create':
      if (e.seq !== 0 || !validRetention(p.retentionDays ?? 0) || !validKey(p.x25519)) throw new Error('bad create');
      s.members[a] = 'admin';
      s.keys[a] = p.x25519;
      s.retentionDays = p.retentionDays ?? 0;
      break;
    case 'epoch': {
      if (!isMember(a) || !(isAdmin(a) || s.pendingRotation)) throw new Error('not allowed to rotate');
      if (p.epoch !== s.epoch + 1) throw new Error('epoch out of order');
      if (!arraysEqual(p.recipients, sortedMembers(s))) throw new Error('epoch recipients must be exactly the members');
      if (typeof p.commit !== 'string' || unb64(p.commit).length !== 32) throw new Error('bad epoch commit');
      if (e.enc !== '' && e.epoch !== p.epoch) throw new Error('epoch snapshot must use the new key');
      s.epoch = p.epoch;
      s.pendingRotation = false;
      break;
    }
    case 'meta':
      if (!isAdmin(a)) throw new Error('only admins can change the room');
      break;
    case 'profile':
      if (!isMember(a)) throw new Error('not a member');
      break;
    case 'settings':
      if (!isAdmin(a)) throw new Error('only admins can change settings');
      if (!validRetention(p.retentionDays ?? 0)) throw new Error('bad settings');
      s.retentionDays = p.retentionDays ?? 0;
      break;
    case 'invite': {
      if (!isAdmin(a)) throw new Error('only admins can invite');
      const maxUses = p.maxUses ?? 0;
      const expiresAt = p.expiresAt ?? 0;
      if (!isId(p.id) || maxUses < 0 || expiresAt < 0) throw new Error('bad invite');
      if (typeof p.key !== 'string' || unb64(p.key).length !== 32) throw new Error('bad invite key');
      if (s.invites[p.id]) throw new Error('invite exists');
      s.invites[p.id] = {key: p.key, expiresAt, maxUses, uses: 0, revoked: false, creator: a, createdAt: e.ts};
      break;
    }
    case 'revoke': {
      if (!isAdmin(a)) throw new Error('only admins can revoke');
      const iv = s.invites[p.id];
      if (!iv) throw new Error('no such invite');
      iv.revoked = true;
      break;
    }
    case 'join': {
      if (isMember(a)) throw new Error('already a member');
      if (!validKey(p.x25519)) throw new Error('bad join');
      const iv = s.invites[p.invite];
      if (!iv || iv.revoked) throw new Error('invite is not valid');
      if (iv.expiresAt !== 0 && e.ts > iv.expiresAt) throw new Error('invite expired');
      if (iv.maxUses !== 0 && iv.uses >= iv.maxUses) throw new Error('invite used up');
      let ok = false;
      try {
        ok = verify(unb64(iv.key), '', joinProofMessage(s.room, p.invite, a), unb64(p.proof));
      } catch {
        ok = false;
      }
      if (!ok) throw new Error('bad invite proof');
      iv.uses++;
      s.members[a] = 'member';
      s.keys[a] = p.x25519;
      s.pendingRotation = true;
      break;
    }
    case 'promote':
    case 'demote':
    case 'kick':
      if (!isAdmin(a)) throw new Error('only admins can manage members');
      if (!isMember(p.target)) throw new Error('target is not a member');
      if (e.kind === 'promote') s.members[p.target] = 'admin';
      if (e.kind === 'demote') s.members[p.target] = 'member';
      if (e.kind === 'kick') {
        if (p.target === a) throw new Error('leave instead of kicking yourself');
        delete s.members[p.target];
        delete s.keys[p.target];
        s.pendingRotation = true;
      }
      break;
    case 'leave':
      if (!isMember(a)) throw new Error('not a member');
      delete s.members[a];
      delete s.keys[a];
      s.pendingRotation = true;
      break;
    case 'delete':
      if (!isMember(a)) throw new Error('not a member');
      if (!isId(p.msg)) throw new Error('bad delete');
      if (p.sender !== a && !isAdmin(a)) throw new Error('only the sender or an admin can delete');
      break;
    default:
      throw new Error(`unknown event kind ${e.kind}`);
  }
  s.nextSeq++;
  s.head = e.hash;
}

// ---- building events ----

export function encAd(room: string, epoch: number, author: string, kind: string): Uint8Array {
  return utf8(`sc-evt|${room}|${epoch}|${author}|${kind}`);
}

export interface NewEvent {
  kind: string;
  pub?: Record<string, any>;
  /** Encrypted under `encKey` (the key of epoch `encEpoch`). */
  enc?: Record<string, any>;
  encEpoch?: number;
  encKey?: Uint8Array;
}

/**
 * Signs a run of events on top of `s`, applying each to a copy of it so the
 * batch is checked locally before the server sees it. Returns the signed
 * events and the state after them.
 */
export function buildEvents(me: Signer, s: LogState, evs: NewEvent[], now = Date.now()): {signed: SignedEvent[]; state: LogState} {
  const st = cloneState(s);
  const signed: SignedEvent[] = [];
  for (const ne of evs) {
    let enc = '';
    let epoch = 0;
    if (ne.enc) {
      if (!ne.encKey || !ne.encEpoch) throw new Error('enc needs a key');
      epoch = ne.encEpoch;
      enc = b64(aeadSeal(ne.encKey, utf8(JSON.stringify(ne.enc)), encAd(st.room, epoch, me.id, ne.kind)));
    }
    const body: EventBody = {
      v: 1,
      room: st.room,
      seq: st.nextSeq,
      prev: st.head,
      author: me.id,
      ts: now,
      kind: ne.kind,
      pub: ne.pub ?? {},
      epoch,
      enc,
    };
    const raw = utf8(JSON.stringify(body));
    const se = {body: b64(raw), sig: b64(sign(me.edSeed, 'sc-evt', raw))};
    applyEvent(st, parseEvent(se), now);
    signed.push(se);
  }
  return {signed, state: st};
}

/** Decrypts an event's enc payload, or returns null if we lack the key. */
export function openEnc<T = any>(e: ParsedEvent, keys: Record<number, Uint8Array>): T | null {
  if (!e.enc) return null;
  const key = keys[e.epoch];
  if (!key) return null;
  try {
    return JSON.parse(unutf8(aeadOpen(key, unb64(e.enc), encAd(e.room, e.epoch, e.author, e.kind))));
  } catch {
    return null;
  }
}
