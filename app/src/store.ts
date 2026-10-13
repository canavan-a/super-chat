// The app's live model of every room: the verified log, the epoch keys we
// hold, and decrypted messages, kept in step with each server over one
// WebSocket per server. Screens read it through useStore(); every mutation
// (sending, kicking, inviting…) goes through the actions at the bottom.
//
// No server knows who we are. In each room we're a different member key
// (memberIdentity), and which rooms we're in is known only to this device and
// to our encrypted vault on each server (see saveVaultSoon).
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useEffect, useReducer, useRef} from 'react';

import {api, ApiError, downloadBlob, uploadBlob} from './api';
import {
  applyEvent,
  b64,
  buildEvents,
  cloneState,
  createInvite,
  createRoomBatch,
  decryptBlob,
  decryptMessage,
  DecryptedMessage,
  encryptBlob,
  encryptMessage,
  FileRef,
  Identity,
  InviteLink,
  joinBatch,
  Member,
  memberIdentity,
  MessageContent,
  newEpoch,
  NewEvent,
  openEnvelope,
  openPreview,
  openVault,
  parseEvent,
  replay,
  ReplayResult,
  roomView,
  RoomView,
  sealVault,
  ServerMessage,
  sign,
  sortedMembers,
  unb64,
  utf8,
  vaultKeys,
} from './crypto';
import {session} from './session';
import {normalizeServer, settingsStore} from './settings';

export const ROOM_COLORS = ['#4C8BF5', '#34C759', '#FF9500', '#FF3B30', '#AF52DE', '#8E8E93'];

export interface ChatMessage {
  id: string;
  pos: number;
  sender: string;
  createdAt: number;
  epoch: number;
  content: DecryptedMessage | null;
  /** Set when the message couldn't be decrypted or verified. */
  error?: string;
  /** Local-only: still being sent. */
  pending?: boolean;
}

export interface Room {
  key: string;
  server: string;
  id: string;
  /** Who we are in this room. */
  me: Member;
  log: ReplayResult | null;
  view: RoomView | null;
  keys: Record<number, Uint8Array>;
  messages: ChatMessage[];
  /** target message id → emoji → senders */
  reactions: Record<string, Record<string, string[]>>;
  /** sender → id of the newest message they've read */
  receipts: Record<string, string>;
  typing: Record<string, number>;
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  lastAt: number;
  lastPos: number;
  error: string | null;
}

export const roomKey = (server: string, id: string) => `${server}|${id}`;

// ---- state + subscription ----

const rooms = new Map<string, Room>();
const listeners = new Set<() => void>();
let version = 0;
let lastRead: Record<string, number> = {};
let roomsLoaded = false;
const LAST_READ_KEY = 'superchat.lastRead.v1';

function emit() {
  version++;
  listeners.forEach(l => l());
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Re-renders when the store changes and returns selector(store) each time. */
export function useStore<T>(selector: () => T): T {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const sel = useRef(selector);
  sel.current = selector;
  useEffect(() => subscribe(force), []);
  return sel.current();
}

export const getRoom = (key: string): Room | undefined => rooms.get(key);
export const storeVersion = () => version;
export const roomsReady = () => roomsLoaded;

export interface RoomListItem {
  key: string;
  server: string;
  id: string;
  name: string;
  color: string;
  unread: boolean;
  lastAt: number;
}

export function roomList(): RoomListItem[] {
  return [...rooms.values()]
    .map(r => ({
      key: r.key,
      server: r.server,
      id: r.id,
      name: r.view?.name ?? 'Encrypted room',
      color: r.view?.color ?? ROOM_COLORS[5],
      unread: r.lastPos > (lastRead[r.key] ?? 0) && r.lastPos > 0,
      lastAt: r.lastAt,
    }))
    .sort((a, b) => b.lastAt - a.lastAt);
}

function blankRoom(server: string, id: string): Room {
  return {
    key: roomKey(server, id),
    server,
    id,
    me: memberIdentity(account().entropy, id),
    log: null,
    view: null,
    keys: {},
    messages: [],
    reactions: {},
    receipts: {},
    typing: {},
    hasMore: true,
    loaded: false,
    loading: false,
    lastAt: 0,
    lastPos: 0,
    error: null,
  };
}

function ensureRoom(server: string, id: string): Room {
  const k = roomKey(server, id);
  let r = rooms.get(k);
  if (!r) {
    r = blankRoom(server, id);
    rooms.set(k, r);
  }
  return r;
}

const account = (): Identity => session.require();

// ---- the room list (this device + vault) ----

const ROOMS_KEY = 'superchat.rooms.v1';

function roomIdsOn(server: string): string[] {
  return [...rooms.values()].filter(r => r.server === server).map(r => r.id).sort();
}

async function saveLocalList() {
  const byServer: Record<string, string[]> = {};
  for (const r of rooms.values()) (byServer[r.server] ??= []).push(r.id);
  await AsyncStorage.setItem(ROOMS_KEY, JSON.stringify(byServer)).catch(() => {});
}

async function loadLocalList(): Promise<Record<string, string[]>> {
  try {
    return JSON.parse((await AsyncStorage.getItem(ROOMS_KEY)) ?? '{}');
  } catch {
    return {};
  }
}

// The vault (crypto/vault.ts) is what lets a fresh install restored from the
// phrase find its rooms. Writes are delayed by a random 30 s to 5 min so the
// server can't match a vault update to the room that was just joined or made
// at that moment.
const vaultTimers = new Map<string, ReturnType<typeof setTimeout>>();
const vaultSaved = new Map<string, string>(); // server → JSON of the room list last written

const vaultDue = new Map<string, number>();

export function saveVaultSoon(server: string, delayMs = 30_000 + Math.random() * 270_000) {
  const due = Date.now() + delayMs;
  // A write already queued for sooner covers this one; a later one is replaced.
  if (vaultTimers.has(server) && (vaultDue.get(server) ?? 0) <= due) return;
  clearTimeout(vaultTimers.get(server));
  vaultDue.set(server, due);
  vaultTimers.set(
    server,
    setTimeout(() => {
      vaultTimers.delete(server);
      vaultDue.delete(server);
      saveVault(server).catch(() => saveVaultSoon(server));
    }, delayMs),
  );
}

async function saveVault(server: string) {
  const ids = roomIdsOn(server);
  const json = JSON.stringify(ids);
  if (vaultSaved.get(server) === json || !session.get()) return;
  const k = vaultKeys(account().entropy, server);
  await api.putVault(server, k, sealVault(k, {v: 1, rooms: ids}));
  vaultSaved.set(server, json);
}

async function readVault(server: string): Promise<string[] | null> {
  const k = vaultKeys(account().entropy, server);
  const blob = await api.getVault(server, k);
  if (!blob) return [];
  try {
    return openVault(k, blob).rooms;
  } catch {
    return null; // not ours, or corrupt: ignore rather than trust it
  }
}

function forgetRoom(key: string) {
  const r = rooms.get(key);
  if (!r) return;
  rooms.delete(key);
  saveLocalList();
  saveVaultSoon(r.server);
}

// ---- loading ----

/** Fetches and verifies a room's log and our keys for it. */
async function loadState(r: Room): Promise<void> {
  const {events, lastPos, lastAt} = await api.state(r.server, r.id, r.me);
  // Throws if the server sends anything that breaks the rules.
  r.log = replay(r.id, events);
  r.lastPos = Math.max(r.lastPos, lastPos);
  r.lastAt = Math.max(r.lastAt, lastAt);
  await loadKeys(r);
  r.view = roomView(r.log, r.keys);
  r.error = null;
}

async function loadKeys(r: Room): Promise<void> {
  if (!r.log) return;
  const envelopes = await api.keys(r.server, r.id, r.me);
  for (const env of envelopes) {
    if (r.keys[env.epoch]) continue;
    const commit = r.log.commits[env.epoch];
    if (!commit) continue;
    try {
      r.keys[env.epoch] = openEnvelope(r.me, r.id, env.epoch, env.sealed, commit);
    } catch {
      // A bad envelope: leave that epoch unreadable rather than trust it.
    }
  }
}

/**
 * Loads every room this device knows about, plus any in our vault on each
 * known server (a fresh install restored from the phrase starts with just
 * the vaults). A room that no longer accepts our member key (we left or were
 * removed) is dropped.
 */
export async function refreshRooms(): Promise<void> {
  const {servers} = await settingsStore.load();
  try {
    lastRead = JSON.parse((await AsyncStorage.getItem(LAST_READ_KEY)) ?? '{}');
  } catch {
    lastRead = {};
  }
  const local = await loadLocalList();
  await Promise.all(
    [...new Set([...servers, ...Object.keys(local)])].map(async server => {
      const fromVault = await readVault(server).catch(() => null);
      if (fromVault) vaultSaved.set(server, JSON.stringify([...fromVault].sort()));
      const ids = new Set([...(local[server] ?? []), ...(fromVault ?? [])]);
      await Promise.all(
        [...ids].map(async id => {
          const r = ensureRoom(server, id);
          try {
            await loadState(r);
            await maybeRotate(r);
          } catch (e) {
            if (e instanceof ApiError && e.status === 404) rooms.delete(r.key);
            else r.error = String((e as Error).message ?? e);
          }
        }),
      );
      // Keep the vault in step with what's really there.
      if (fromVault && JSON.stringify(roomIdsOn(server)) !== vaultSaved.get(server)) saveVaultSoon(server);
      if (roomIdsOn(server).length) connect(server);
    }),
  );
  await saveLocalList();
  roomsLoaded = true;
  emit();
}

function retentionCutoff(r: Room): number {
  const days = r.view?.retentionDays ?? 0;
  return days > 0 ? Date.now() - days * 86400_000 : 0;
}

function decrypt(r: Room, m: ServerMessage): ChatMessage {
  const base = {id: m.id, pos: m.pos, sender: m.sender, createdAt: m.createdAt, epoch: m.epoch};
  const key = r.keys[m.epoch];
  if (!key) return {...base, content: null, error: 'No key for this message'};
  try {
    return {...base, content: decryptMessage(m, key)};
  } catch (e) {
    return {...base, content: null, error: 'Could not verify this message'};
  }
}

/**
 * Files a decrypted message into the room: chat line, reaction or receipt.
 * Always replaces the arrays/objects it changes rather than mutating them:
 * the chat list and message rows are pure components and only re-render on a
 * new reference.
 */
function ingest(r: Room, msg: ChatMessage) {
  const c = msg.content;
  if (c?.t === 'reaction') {
    const byEmoji = {...(r.reactions[c.target] ?? {})};
    const senders = (byEmoji[c.emoji] ?? []).filter(s => s !== msg.sender);
    if (!c.remove) senders.push(msg.sender);
    if (senders.length) byEmoji[c.emoji] = senders;
    else delete byEmoji[c.emoji];
    r.reactions = {...r.reactions, [c.target]: byEmoji};
    return;
  }
  if (c?.t === 'receipt') {
    r.receipts = {...r.receipts, [msg.sender]: c.upTo};
    return;
  }
  r.messages = [...r.messages.filter(x => x.id !== msg.id), msg].sort((a, b) => a.pos - b.pos);
  if (msg.pos > 0 && !msg.pending) {
    r.lastPos = Math.max(r.lastPos, msg.pos);
    r.lastAt = Math.max(r.lastAt, msg.createdAt);
  }
}

function pruneExpired(r: Room) {
  const cutoff = retentionCutoff(r);
  if (cutoff) r.messages = r.messages.filter(m => m.pending || m.createdAt >= cutoff);
}

/** Loads the newest page of a room (first open) or catches up after a gap. */
export async function openRoom(key: string): Promise<void> {
  const r = rooms.get(key);
  if (!r || r.loading) return;
  r.loading = true;
  emit();
  try {
    if (!r.log) await loadState(r);
    const newest = r.messages.filter(m => !m.pending).slice(-1)[0];
    const page = newest
      ? await api.messages(r.server, r.id, r.me, {after: newest.pos, limit: 200})
      : await api.messages(r.server, r.id, r.me, {limit: 50});
    if (!newest) r.hasMore = page.length === 50;
    for (const m of page) ingest(r, decrypt(r, m));
    pruneExpired(r);
    r.loaded = true;
    r.error = null;
  } catch (e) {
    r.error = String((e as Error).message ?? e);
  } finally {
    r.loading = false;
    emit();
  }
}

export async function loadOlder(key: string): Promise<void> {
  const r = rooms.get(key);
  if (!r || r.loading || !r.hasMore) return;
  const oldest = r.messages.find(m => !m.pending);
  if (!oldest) return;
  r.loading = true;
  emit();
  try {
    const page = await api.messages(r.server, r.id, r.me, {before: oldest.pos, limit: 50});
    r.hasMore = page.length === 50;
    for (const m of page) ingest(r, decrypt(r, m));
  } catch (e) {
    r.error = String((e as Error).message ?? e);
  } finally {
    r.loading = false;
    emit();
  }
}

export async function markRead(key: string): Promise<void> {
  const r = rooms.get(key);
  if (!r) return;
  if ((lastRead[key] ?? 0) >= r.lastPos) return;
  lastRead[key] = r.lastPos;
  AsyncStorage.setItem(LAST_READ_KEY, JSON.stringify(lastRead)).catch(() => {});
  emit();
  // Tell the room, unless the newest line is our own.
  const newest = r.messages.filter(m => !m.pending && m.content && m.sender !== r.me.id).slice(-1)[0];
  if (newest && r.receipts[r.me.id] !== newest.id) {
    send(key, {t: 'receipt', upTo: newest.id}).catch(() => {});
  }
}

// ---- WebSocket ----
//
// One socket per server, but no login: after the server's challenge we
// subscribe room by room, each signed by that room's member key.

interface Conn {
  ws: WebSocket | null;
  nonce: string | null;
  backoff: number;
  timer: ReturnType<typeof setTimeout> | null;
  ready: boolean;
  closed: boolean;
}
const conns = new Map<string, Conn>();
const serverStatus = new Map<string, boolean>();
export const isServerOnline = (server: string) => serverStatus.get(server) ?? true;

type IncomingListener = (room: Room, msg: ChatMessage) => void;
const incomingListeners = new Set<IncomingListener>();
/** Called for each new chat line from someone else (for notifications). */
export function onIncoming(l: IncomingListener): () => void {
  incomingListeners.add(l);
  return () => incomingListeners.delete(l);
}

export function connect(server: string) {
  let c = conns.get(server);
  if (c && (c.ws || c.timer)) return;
  if (!c) {
    c = {ws: null, nonce: null, backoff: 1000, timer: null, ready: false, closed: false};
    conns.set(server, c);
  }
  c.closed = false;
  open(server, c);
}

export function disconnectAll() {
  for (const c of conns.values()) {
    c.closed = true;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    c.ws?.close();
    c.ws = null;
  }
  conns.clear();
}

function wsSubscribe(server: string, list: Room[]) {
  const c = conns.get(server);
  if (!c?.ws || !c.nonce || !list.length) return;
  const nonce = c.nonce;
  c.ws.send(
    JSON.stringify({
      type: 'sub',
      subs: list.map(r => ({room: r.id, member: r.me.id, sig: b64(sign(r.me.edSeed, 'SC1-WS\n', utf8(`${nonce}\n${r.id}`)))})),
    }),
  );
}

function open(server: string, c: Conn) {
  const ws = new WebSocket(server.replace(/^http/, 'ws') + '/v1/ws');
  c.ws = ws;
  c.ready = false;
  c.nonce = null;
  ws.onmessage = ev => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === 'challenge') {
      c.nonce = msg.nonce;
      wsSubscribe(server, [...rooms.values()].filter(r => r.server === server));
      return;
    }
    if (msg.type === 'subscribed') {
      const first = !c.ready;
      c.ready = true;
      c.backoff = 1000;
      serverStatus.set(server, true);
      // Catch up on anything missed while disconnected.
      if (first) resync(server).catch(() => {});
      return;
    }
    handlePush(server, msg).catch(() => {});
  };
  ws.onclose = () => {
    c.ws = null;
    c.ready = false;
    if (c.closed) return;
    serverStatus.set(server, false);
    emit();
    c.timer = setTimeout(() => {
      c.timer = null;
      if (!c.closed) open(server, c);
    }, c.backoff);
    c.backoff = Math.min(c.backoff * 2, 60_000);
  };
  ws.onerror = () => {
    // onclose follows and schedules the retry.
  };
}

async function resync(server: string) {
  for (const r of [...rooms.values()].filter(x => x.server === server)) {
    try {
      await loadState(r);
      if (r.loaded) {
        r.loading = false;
        await openRoom(r.key);
      }
      await maybeRotate(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) forgetRoom(r.key);
      else r.error = String((e as Error).message ?? e);
    }
  }
  emit();
}

export function sendTyping(key: string) {
  const r = rooms.get(key);
  const c = r && conns.get(r.server);
  if (c?.ready && c.ws) c.ws.send(JSON.stringify({type: 'typing', room: r!.id}));
}

async function handlePush(server: string, msg: any) {
  const r = msg.room ? rooms.get(roomKey(server, msg.room)) : undefined;
  if (!r) return;
  switch (msg.type) {
    case 'event': {
      if (!r.log) return;
      const ev = msg.event;
      if (ev.seq !== r.log.state.nextSeq) {
        await loadState(r);
      } else {
        const st = cloneState(r.log.state);
        const parsed = parseEvent(ev);
        applyEvent(st, parsed);
        r.log = {
          state: st,
          events: [...r.log.events, parsed],
          commits: parsed.kind === 'epoch' ? {...r.log.commits, [parsed.pub.epoch]: parsed.pub.commit} : r.log.commits,
        };
        if (parsed.kind === 'epoch' || parsed.kind === 'join') await loadState(r);
        if (parsed.kind === 'epoch' && parsed.author !== r.me.id) republishProfile(r).catch(() => {});
        if (parsed.kind === 'delete') {
          r.messages = r.messages.filter(m => m.id !== parsed.pub.msg);
        }
        r.view = roomView(r.log, r.keys);
      }
      pruneExpired(r);
      await maybeRotate(r);
      emit();
      return;
    }
    case 'message': {
      const m = msg.message as ServerMessage;
      if (!r.keys[m.epoch]) await loadKeys(r);
      const dm = decrypt(r, m);
      const isLine = dm.content?.t === 'text' || dm.content?.t === 'file' || !dm.content;
      if (isLine && r.typing[m.sender]) {
        const {[m.sender]: _gone, ...rest} = r.typing;
        r.typing = rest;
      }
      ingest(r, dm);
      emit();
      if (isLine && m.sender !== r.me.id) incomingListeners.forEach(l => l(r, dm));
      return;
    }
    case 'deleted': {
      const ids = new Set<string>(msg.ids);
      r.messages = r.messages.filter(m => !ids.has(m.id));
      emit();
      return;
    }
    case 'typing': {
      if (msg.member === r.me.id) return;
      r.typing = {...r.typing, [msg.member]: Date.now() + 6000};
      emit();
      setTimeout(emit, 6100);
      return;
    }
    case 'removed': {
      forgetRoom(r.key);
      emit();
      return;
    }
  }
}

// ---- actions ----

function myName(r: Room): string {
  return r.view?.names[r.me.id] ?? settingsStore.get().displayName ?? '';
}

function snapshot(r: Room): Record<string, any> {
  const v = r.view;
  return {name: v?.name ?? undefined, color: v?.color ?? undefined, profiles: v?.names ?? {}};
}

/**
 * Appends events (optionally followed by a key rotation) built against the
 * latest state, retrying once on a conflict with someone else's append.
 */
async function append(
  r: Room,
  build: (s: ReplayResult) => {events: NewEvent[]; rotate?: boolean | 'force'} | null,
  preview?: string,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!r.log || attempt > 0) await loadState(r);
    const log = r.log!;
    const built = build(log);
    if (!built) return; // nothing to do any more (someone else got there first)
    const {events, rotate} = built;
    const {state: s1, signed} = buildEvents(r.me, log.state, events);
    let all = signed;
    let envelopes: Record<string, string> | undefined;
    if (rotate && (s1.pendingRotation || rotate === 'force') && r.me.id in s1.members) {
      const ep = newEpoch(s1, snapshot(r));
      all = [...signed, ...buildEvents(r.me, s1, [ep.event]).signed];
      envelopes = ep.envelopes;
    }
    try {
      await api.append(r.server, r.id, r.me, {events: all, envelopes, preview});
      if (r.me.id in s1.members) await loadState(r);
      emit();
      return;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && attempt === 0) continue;
      throw e;
    }
  }
}

const ROTATE_EVERY_MS = 7 * 86400_000;

function lastEpochAt(log: ReplayResult): number {
  for (let i = log.events.length - 1; i >= 0; i--) if (log.events[i].kind === 'epoch') return log.events[i].ts;
  return 0;
}

/**
 * Keeps the room key fresh. Member keys never change; it's the room's
 * message key (the epoch) that's replaced. If a member left, nobody may keep
 * using the old one, so any remaining member rotates it (joins and kicks
 * rotate in the same request; see the server). And any admin rotates a key
 * older than a week, so a key stolen today stops working soon.
 */
async function maybeRotate(r: Room) {
  const s = r.log?.state;
  if (!s || !(r.me.id in s.members)) return;
  if (sortedMembers(s).some(id => !s.keys[id])) return;
  if (s.pendingRotation) {
    await append(r, log => (log.state.pendingRotation ? {events: [], rotate: true} : null)).catch(() => {});
  } else if (s.members[r.me.id] === 'admin' && Date.now() - lastEpochAt(r.log!) > ROTATE_EVERY_MS) {
    await append(r, log =>
      Date.now() - lastEpochAt(log) > ROTATE_EVERY_MS ? {events: [], rotate: 'force'} : null,
    ).catch(() => {});
  }
}

async function republishProfile(r: Room) {
  const name = myName(r);
  const s = r.log?.state;
  if (!name || !s || !r.keys[s.epoch]) return;
  await append(r, log => ({
    events: [{kind: 'profile', enc: {displayName: name}, encEpoch: log.state.epoch, encKey: r.keys[log.state.epoch]}],
  }));
}

function addRoom(server: string, id: string): Room {
  const r = ensureRoom(server, id);
  r.lastAt = Date.now();
  saveLocalList();
  saveVaultSoon(server);
  if (conns.get(server)?.ws) wsSubscribe(server, [r]);
  else connect(server);
  return r;
}

export async function createRoom(server: string, name: string, color: string, retentionDays: number, displayName: string) {
  server = normalizeServer(server);
  await addServer(server);
  const {room, batch, me} = createRoomBatch(account(), {name, color}, displayName, retentionDays);
  await api.createRoom(server, me, batch);
  const r = addRoom(server, room);
  await loadState(r);
  emit();
  return r.key;
}

export async function addServer(server: string) {
  const s = settingsStore.get();
  if (!s.servers.includes(server)) await settingsStore.update({servers: [...s.servers, server]});
}

export async function send(key: string, content: MessageContent, blobs: string[] = []): Promise<void> {
  const r = rooms.get(key);
  const s = r?.log?.state;
  if (!r || !s) throw new Error('room not loaded');
  const epoch = s.epoch;
  if (!r.keys[epoch]) await loadKeys(r);
  const k = r.keys[epoch];
  if (!k) throw new Error("You don't have this room's key yet.");
  const enc = encryptMessage(r.me, r.id, epoch, k, content);
  const isLine = content.t === 'text' || content.t === 'file';
  const local: ChatMessage = {
    id: enc.id,
    pos: Number.MAX_SAFE_INTEGER,
    sender: r.me.id,
    createdAt: Date.now(),
    epoch,
    content: {...content, ts: Date.now()} as DecryptedMessage,
    pending: true,
  };
  if (isLine) {
    ingest(r, local);
    emit();
  }
  try {
    const res = await api.post(r.server, r.id, r.me, {id: enc.id, epoch, kind: enc.kind, ct: enc.ct, blobs});
    ingest(r, {...local, pos: res.pos, createdAt: res.createdAt, pending: false});
    if (isLine) lastRead[key] = Math.max(lastRead[key] ?? 0, res.pos);
    emit();
  } catch (e) {
    if (isLine) {
      r.messages = r.messages.filter(m => m.id !== enc.id);
      emit();
    }
    if (e instanceof ApiError && e.status === 409) {
      // The room key rotated under us: pick up the new one and try again.
      await loadState(r);
      if (r.log!.state.epoch !== epoch) return send(key, content, blobs);
    }
    throw e;
  }
}

export interface Attachment {
  name: string;
  mime: string;
  data: Uint8Array;
  w?: number;
  h?: number;
}

/** onStatus gets a short line to show while it works ("Uploading x.jpg… 40%"). */
export async function sendFiles(
  key: string,
  files: Attachment[],
  body: string,
  replyTo?: string,
  onStatus?: (status: string) => void,
) {
  const r = rooms.get(key);
  if (!r) throw new Error('room not loaded');
  const refs: FileRef[] = [];
  for (const [i, f] of files.entries()) {
    const which = files.length > 1 ? ` (${i + 1}/${files.length})` : '';
    onStatus?.(`Encrypting ${f.name}${which}…`);
    // Let that paint before encrypting, which holds the JS thread briefly.
    await new Promise(res => setTimeout(res, 0));
    const {key: fk, sealed} = encryptBlob(f.data);
    onStatus?.(`Uploading ${f.name}${which}…`);
    const blob = await uploadBlob(r.server, r.id, r.me, sealed, frac =>
      onStatus?.(`Uploading ${f.name}${which}… ${Math.round(frac * 100)}%`),
    );
    refs.push({blob, key: b64(fk), name: f.name, mime: f.mime, size: f.data.length, w: f.w, h: f.h});
  }
  await send(key, {t: 'file', files: refs, body: body || undefined, replyTo}, refs.map(x => x.blob));
}

const blobCache = new Map<string, Uint8Array>();
export async function fetchFile(key: string, ref: FileRef): Promise<Uint8Array> {
  const cached = blobCache.get(ref.blob);
  if (cached) return cached;
  const r = rooms.get(key);
  if (!r) throw new Error('room not loaded');
  const data = decryptBlob(unb64(ref.key), await downloadBlob(r.server, r.id, r.me, ref.blob));
  // Keep a few recent images decrypted in memory only; never on disk.
  if (blobCache.size > 24) blobCache.delete(blobCache.keys().next().value!);
  blobCache.set(ref.blob, data);
  return data;
}

export function react(key: string, target: string, emoji: string) {
  const r = rooms.get(key)!;
  const mine = r.reactions[target]?.[emoji]?.includes(r.me.id);
  return send(key, {t: 'reaction', target, emoji, remove: mine || undefined});
}

export async function deleteMessage(key: string, msg: ChatMessage) {
  const r = rooms.get(key)!;
  await append(r, () => ({events: [{kind: 'delete', pub: {msg: msg.id, sender: msg.sender}}]}));
  r.messages = r.messages.filter(m => m.id !== msg.id);
  emit();
}

export const kick = (key: string, target: string) =>
  append(rooms.get(key)!, () => ({events: [{kind: 'kick', pub: {target}}], rotate: true}));

export const setRole = (key: string, target: string, role: 'admin' | 'member') =>
  append(rooms.get(key)!, () => ({events: [{kind: role === 'admin' ? 'promote' : 'demote', pub: {target}}]}));

export async function leave(key: string) {
  await append(rooms.get(key)!, () => ({events: [{kind: 'leave'}]}));
  forgetRoom(key);
  emit();
}

export const setRetention = (key: string, retentionDays: number) =>
  append(rooms.get(key)!, () => ({events: [{kind: 'settings', pub: {retentionDays}}]}));

export const setMeta = (key: string, name: string, color: string) =>
  append(rooms.get(key)!, log => ({
    events: [{kind: 'meta', enc: {name, color}, encEpoch: log.state.epoch, encKey: rooms.get(key)!.keys[log.state.epoch]}],
  }));

export const setDisplayName = (key: string, displayName: string) =>
  append(rooms.get(key)!, log => ({
    events: [{kind: 'profile', enc: {displayName}, encEpoch: log.state.epoch, encKey: rooms.get(key)!.keys[log.state.epoch]}],
  }));

/** Admins only (the log enforces it). Returns the shareable link. */
export async function makeInvite(key: string, opts: {expiresAt: number; maxUses: number}): Promise<string> {
  const r = rooms.get(key)!;
  for (let attempt = 0; attempt < 2; attempt++) {
    await loadState(r);
    const v = r.view!;
    const inv = createInvite(r.me, r.log!.state, r.server, {name: v.name ?? '', color: v.color ?? '', inviter: myName(r)}, opts);
    try {
      await api.append(r.server, r.id, r.me, inv.batch);
      await loadState(r);
      emit();
      return inv.link;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && attempt === 0) continue;
      throw e;
    }
  }
  throw new Error('unreachable');
}

export const revokeInvite = (key: string, id: string) =>
  append(rooms.get(key)!, () => ({events: [{kind: 'revoke', pub: {id}}]}));

export const inviteUses = (key: string) => {
  const r = rooms.get(key)!;
  return api.inviteUses(r.server, r.id, r.me);
};

// ---- joining ----

export interface JoinPreview {
  link: InviteLink;
  room: string;
  name: string;
  color: string;
  inviter: string;
  members: number;
  alreadyMember: boolean;
}

export async function previewInvite(link: InviteLink): Promise<JoinPreview> {
  const res = await api.getInvite(link.server, link.invite);
  const log = replay(res.room, res.events); // verify what we'd be joining
  const p = openPreview(link.secret, res.preview);
  if (!p) throw new Error("This link's key doesn't match the invite. Check you copied all of it.");
  const me = memberIdentity(account().entropy, res.room);
  return {
    link,
    room: res.room,
    name: p.name,
    color: p.color,
    inviter: p.inviter,
    members: Object.keys(log.state.members).length,
    alreadyMember: me.id in log.state.members,
  };
}

export async function join(link: InviteLink, displayName: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await api.getInvite(link.server, link.invite);
    const me = memberIdentity(account().entropy, res.room);
    const log = replay(res.room, res.events);
    await addServer(link.server);
    if (me.id in log.state.members) {
      const r = addRoom(link.server, res.room);
      await loadState(r);
      emit();
      return r.key;
    }
    const preview = openPreview(link.secret, res.preview);
    const {batch} = joinBatch(me, log.state, link, preview, displayName);
    try {
      await api.join(link.server, link.invite, me, batch);
      const r = addRoom(link.server, res.room);
      await loadState(r);
      emit();
      return r.key;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.message === 'conflict' && attempt === 0) continue;
      throw e;
    }
  }
  throw new Error('unreachable');
}

/** Wipes everything held in memory (on forgetting the account). */
export function resetStore() {
  disconnectAll();
  for (const t of vaultTimers.values()) clearTimeout(t);
  vaultTimers.clear();
  vaultSaved.clear();
  rooms.clear();
  blobCache.clear();
  roomsLoaded = false;
  AsyncStorage.removeItem(ROOMS_KEY).catch(() => {});
  emit();
}
