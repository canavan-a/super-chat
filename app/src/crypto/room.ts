// Room-level operations built on the log: epoch keys and their envelopes,
// message encryption, invites, and the batches the server expects.
import {b64, isId, newId, pubFromMemberId, randomBytes, unb64, unutf8, utf8} from './encoding';
import {aeadOpen, aeadSeal, edPublicKey, hkdf, seal, sign, unseal, verify} from './primitives';
import {Identity, Member, memberIdentity} from './identity';
import {
  buildEvents,
  epochCommit,
  joinProofMessage,
  LogState,
  newState,
  NewEvent,
  ParsedEvent,
  SignedEvent,
  sortedMembers,
} from './log';

export interface Batch {
  events: SignedEvent[];
  envelopes?: Record<string, string>;
  preview?: string;
}

// ---- epochs ----

const envAd = (room: string, epoch: number, account: string) => utf8(`sc-env|${room}|${epoch}|${account}`);

/**
 * A new epoch event plus one sealed envelope per member, each sealed to the
 * member's room-scoped key as published in the log.
 */
export function newEpoch(
  s: LogState,
  snapshot?: Record<string, any>,
): {event: NewEvent; envelopes: Record<string, string>; key: Uint8Array; epoch: number} {
  const epoch = s.epoch + 1;
  const key = randomBytes(32);
  const recipients = sortedMembers(s);
  const envelopes: Record<string, string> = {};
  for (const id of recipients) {
    const xPub = s.keys[id];
    if (!xPub) throw new Error(`no key for member ${id}`);
    envelopes[id] = b64(seal(unb64(xPub), key, envAd(s.room, epoch, id)));
  }
  return {
    event: {
      kind: 'epoch',
      pub: {epoch, recipients, commit: epochCommit(s.room, epoch, key)},
      ...(snapshot ? {enc: snapshot, encEpoch: epoch, encKey: key} : {}),
    },
    envelopes,
    key,
    epoch,
  };
}

/** Opens our envelope for an epoch and checks it against the signed commit. */
export function openEnvelope(me: Member, room: string, epoch: number, sealed: string, commit: string): Uint8Array {
  const key = unseal(me.xPriv, unb64(sealed), envAd(room, epoch, me.id));
  if (epochCommit(room, epoch, key) !== commit) throw new Error('epoch key does not match its commitment');
  return key;
}

// ---- messages ----

export type MessageContent =
  | {t: 'text'; body: string; replyTo?: string}
  | {t: 'file'; files: FileRef[]; body?: string; replyTo?: string}
  | {t: 'reaction'; target: string; emoji: string; remove?: boolean}
  | {t: 'receipt'; upTo: string}
  // A STUN/TURN server someone shared for voice (Settings → Voice → Share).
  // Its credentials are only readable by the room's members, like any message.
  | {t: 'ice'; server: {urls: string; username?: string; credential?: string}}
  // Someone joined or left the room's voice: a line in the chat's history.
  | {t: 'call'; action: 'join' | 'leave'};

export interface FileRef {
  blob: string;
  key: string;
  name: string;
  mime: string;
  size: number;
  w?: number;
  h?: number;
}

export type ServerKind = 'msg' | 'reaction' | 'receipt' | 'call';

export function serverKind(c: MessageContent): ServerKind {
  return c.t === 'reaction' ? 'reaction' : c.t === 'receipt' ? 'receipt' : c.t === 'call' ? 'call' : 'msg';
}

const msgAd = (room: string, epoch: number, id: string, sender: string) => utf8(`sc-msg|${room}|${epoch}|${id}|${sender}`);
const msgSigMsg = (room: string, id: string, inner: Uint8Array) => {
  const prefix = utf8(`sc-msg|${room}|${id}|`);
  const out = new Uint8Array(prefix.length + inner.length);
  out.set(prefix);
  out.set(inner, prefix.length);
  return out;
};

export function encryptMessage(
  me: Member,
  room: string,
  epoch: number,
  key: Uint8Array,
  content: MessageContent,
  id = newId(),
): {id: string; ct: string; kind: ServerKind} {
  const inner = utf8(JSON.stringify({v: 1, ...content, ts: Date.now()}));
  const sig = sign(me.edSeed, '', msgSigMsg(room, id, inner));
  const outer = utf8(JSON.stringify({c: b64(inner), s: b64(sig)}));
  return {id, ct: b64(aeadSeal(key, outer, msgAd(room, epoch, id, me.id))), kind: serverKind(content)};
}

export interface ServerMessage {
  pos: number;
  id: string;
  room: string;
  epoch: number;
  sender: string;
  kind: ServerKind;
  ct: string;
  createdAt: number;
}

export type DecryptedMessage = MessageContent & {ts: number};

/**
 * Decrypts and checks a message: the AEAD proves it came from a key holder,
 * the inner signature proves which member sent it.
 */
export function decryptMessage(m: ServerMessage, key: Uint8Array): DecryptedMessage {
  const outer = JSON.parse(unutf8(aeadOpen(key, unb64(m.ct), msgAd(m.room, m.epoch, m.id, m.sender))));
  const inner = unb64(outer.c);
  if (!verify(pubFromMemberId(m.sender), '', msgSigMsg(m.room, m.id, inner), unb64(outer.s))) {
    throw new Error('bad message signature');
  }
  const content = JSON.parse(unutf8(inner));
  if (content.v !== 1) throw new Error('unsupported message version');
  if (serverKind(content) !== m.kind) throw new Error('message kind mismatch');
  return content;
}

// ---- blobs ----

const BLOB_AD = utf8('sc-blob');

export function encryptBlob(data: Uint8Array): {key: Uint8Array; sealed: Uint8Array} {
  const key = randomBytes(32);
  return {key, sealed: aeadSeal(key, data, BLOB_AD)};
}

export const decryptBlob = (key: Uint8Array, sealed: Uint8Array): Uint8Array => aeadOpen(key, sealed, BLOB_AD);

// ---- rooms ----

export interface RoomMeta {
  name: string;
  color: string;
}

export function createRoomBatch(
  account: Identity,
  meta: RoomMeta,
  displayName: string,
  retentionDays: number,
): {room: string; batch: Batch; key: Uint8Array; me: Member} {
  const room = newId();
  const me = memberIdentity(account.entropy, room);
  const s0 = newState(room);
  const {state: s1, signed: first} = buildEvents(me, s0, [{kind: 'create', pub: {retentionDays, x25519: b64(me.xPub)}}]);
  const ep = newEpoch(s1, {...meta, profiles: {[me.id]: displayName}});
  const {signed: rest} = buildEvents(me, s1, [
    ep.event,
    {kind: 'meta', enc: meta, encEpoch: ep.epoch, encKey: ep.key},
    {kind: 'profile', enc: {displayName}, encEpoch: ep.epoch, encKey: ep.key},
  ]);
  return {room, batch: {events: [...first, ...rest], envelopes: ep.envelopes}, key: ep.key, me};
}

// ---- invites ----

export interface InviteLink {
  server: string;
  invite: string;
  secret: Uint8Array;
}

const inviteSeed = (secret: Uint8Array) => hkdf(secret, 'invite-sign');
const previewKey = (secret: Uint8Array) => hkdf(secret, 'invite-preview');

export function formatInviteLink(l: InviteLink): string {
  return `${l.server.replace(/\/+$/, '')}/i/${l.invite}#${b64(l.secret)}`;
}

/**
 * Accepts https://server/i/<id>#<secret> and the app's own
 * superchat://join?s=…&i=…&k=… form. Returns null for anything else.
 */
export function parseInviteLink(text: string): InviteLink | null {
  const s = text.trim();
  try {
    const m = s.match(/^(https?:\/\/[^/\s]+)\/i\/([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})$/);
    if (m) return {server: m[1], invite: m[2], secret: unb64(m[3])};
    const q = s.match(/^superchat:\/\/join\?(.+)$/);
    if (q) {
      const params: Record<string, string> = {};
      for (const kv of q[1].split('&')) {
        const [k, v] = kv.split('=');
        params[k] = decodeURIComponent(v ?? '');
      }
      if (/^https?:\/\/[^/\s]+$/.test(params.s) && isId(params.i) && params.k) {
        const secret = unb64(params.k);
        if (secret.length === 32) return {server: params.s, invite: params.i, secret};
      }
    }
  } catch {
    // fall through
  }
  return null;
}

export interface InvitePreview {
  name: string;
  color: string;
  inviter: string;
}

export function createInvite(
  me: Member,
  s: LogState,
  server: string,
  preview: InvitePreview,
  opts: {expiresAt: number; maxUses: number},
): {link: string; id: string; batch: Batch} {
  const secret = randomBytes(32);
  const id = newId();
  const keyPub = edPublicKey(inviteSeed(secret));
  const {signed} = buildEvents(me, s, [
    {kind: 'invite', pub: {id, key: b64(keyPub), expiresAt: opts.expiresAt, maxUses: opts.maxUses}},
  ]);
  const sealedPreview = b64(aeadSeal(previewKey(secret), utf8(JSON.stringify(preview)), utf8('sc-preview')));
  return {link: formatInviteLink({server, invite: id, secret}), id, batch: {events: signed, preview: sealedPreview}};
}

export function openPreview(secret: Uint8Array, sealed: string): InvitePreview | null {
  try {
    return JSON.parse(unutf8(aeadOpen(previewKey(secret), unb64(sealed), utf8('sc-preview'))));
  } catch {
    return null;
  }
}

/**
 * The join batch: our signed join (with the invite's proof), then a new
 * epoch sealed to every verified member plus us, then our profile.
 */
export function joinBatch(
  me: Member,
  s: LogState,
  link: InviteLink,
  preview: InvitePreview | null,
  displayName: string,
): {batch: Batch; key: Uint8Array; epoch: number} {
  const proof = sign(inviteSeed(link.secret), '', joinProofMessage(s.room, link.invite, me.id));
  const {state: s1, signed: joined} = buildEvents(me, s, [
    {kind: 'join', pub: {invite: link.invite, proof: b64(proof), x25519: b64(me.xPub)}},
  ]);
  const snapshot: Record<string, any> = {profiles: {[me.id]: displayName}};
  if (preview) {
    snapshot.name = preview.name;
    snapshot.color = preview.color;
  }
  const ep = newEpoch(s1, snapshot);
  const {signed: rest} = buildEvents(me, s1, [
    ep.event,
    {kind: 'profile', enc: {displayName}, encEpoch: ep.epoch, encKey: ep.key},
  ]);
  return {batch: {events: [...joined, ...rest], envelopes: ep.envelopes}, key: ep.key, epoch: ep.epoch};
}

export type {ParsedEvent};
