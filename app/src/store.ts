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
import {AppState, NativeModules, Platform} from 'react-native';
import {base64} from '@scure/base';

import {api, ApiError, blobRequest, downloadBlob, uploadBlob} from './api';
import {clearSealed, getSealed, noteCached, putSealed, removeSealed} from './blobDisk';
import {dataUri} from './files';
import {
  aeadOpen,
  aeadSeal,
  applyEvent,
  AvatarRef,
  b64,
  buildEvents,
  cloneState,
  createInvite,
  createRoomBatch,
  decryptBlob,
  extendReplay,
  decryptMessage,
  DecryptedMessage,
  encryptBlob,
  encryptMessage,
  FileRef,
  fingerprint,
  hkdf,
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
  openSignal,
  OpenedSignal,
  randomBytes,
  openVault,
  parseEvent,
  replay,
  ReplayResult,
  roomView,
  RoomView,
  sealVault,
  ServerMessage,
  sealSignal,
  Signal,
  signalEpoch,
  sign,
  sortedMembers,
  unb64,
  unutf8,
  utf8,
  vaultKeys,
} from './crypto';
import {session} from './session';
import {normalizeServer, settingsStore} from './settings';

// Room colors to pick from (any color in the log still shows). Grey is the
// fallback for a room whose color hasn't loaded.
export const ROOM_COLORS = [
  '#4C8BF5', // blue
  '#0A84FF', // azure
  '#5AC8FA', // sky
  '#30B0C7', // teal
  '#00C7BE', // mint
  '#34C759', // green
  '#8BC34A', // lime
  '#FFCC00', // yellow
  '#FF9500', // orange
  '#FF6B35', // tangerine
  '#FF3B30', // red
  '#FF2D55', // pink
  '#E040FB', // magenta
  '#AF52DE', // purple
  '#5856D6', // indigo
  '#A2845E', // brown
  '#8E8E93', // grey
];
export const FALLBACK_ROOM_COLOR = '#8E8E93';

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
  /** Local-only, on a file message being sent: each file's upload progress (0–1), and why it failed if it did. */
  upload?: {progress: number[]; failed?: string};
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
  /** Who is in this room's voice room, by `member:sid` (not us; see call/engine.ts). */
  voice: Record<string, VoicePresence>;
  hasMore: boolean;
  /**
   * The messages held are a window that stops short of the newest (after a
   * jump to the read position): new lines aren't added until it pages down
   * to them. See jumpToRead.
   */
  hasNewer: boolean;
  /** Where reading stopped when the room was last opened, for the "N new" bubble and divider. */
  readMark: number;
  /** Messages from others after readMark, as the server counted them on open. */
  newSinceRead: number;
  /** The newest line known, held or not (a window may not hold it). */
  latest?: ChatMessage;
  /** The newest line from someone else, for read receipts. */
  latestOther?: ChatMessage;
  loaded: boolean;
  /** The wipe (its time) this device last handled; see dropWiped. */
  wipeSeen?: number;
  loading: boolean;
  /** The openRoom under way, if any (one at a time). */
  opening?: Promise<void>;
  /** When loadState last ran: a reconnect right after it needn't reload the log. */
  syncedAt?: number;
  /** Its messages are last launch's (loadMessageCaches), shown until the first open replaces them. */
  fromCache?: boolean;
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
  saveListCacheSoon();
}

// ---- the room list, remembered between launches ----
//
// What the list showed last time (names, colors, previews, times), so on
// launch it draws at once, before any network, and live data replaces it as
// it arrives. Names and previews are decrypted content, so the cache is
// sealed with a key derived from the account: unreadable until unlock, which
// is exactly when the list is drawn.

const LIST_CACHE_KEY = 'superchat.listCache.v1';
const LIST_CACHE_AD = utf8('sc-list-cache');
interface CachedRow {
  name: string;
  color: string;
  picture?: AvatarRef | null;
  preview: string | null;
  lastAt: number;
  unreadCount: number;
}
let listCache: Record<string, CachedRow> = {};
const listCacheKey = () => hkdf(account().entropy, 'superchat/list-cache');

async function loadListCache(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(LIST_CACHE_KEY);
    listCache = raw ? JSON.parse(unutf8(aeadOpen(listCacheKey(), unb64(raw), LIST_CACHE_AD))) : {};
  } catch {
    listCache = {}; // another account's, or damaged: start fresh
  }
}

let listCacheTimer: ReturnType<typeof setTimeout> | null = null;
function saveListCacheSoon() {
  if (listCacheTimer || !session.get() || !roomsLoaded) return;
  listCacheTimer = setTimeout(() => {
    listCacheTimer = null;
    if (!session.get()) return;
    const rows: Record<string, CachedRow> = {};
    for (const item of roomList()) {
      rows[item.key] = {name: item.name, color: item.color, picture: item.picture, preview: item.preview, lastAt: item.lastAt, unreadCount: item.unreadCount};
    }
    listCache = rows;
    const sealed = b64(aeadSeal(listCacheKey(), utf8(JSON.stringify(rows)), LIST_CACHE_AD));
    AsyncStorage.setItem(LIST_CACHE_KEY, sealed).catch(() => {});
    saveMessageCaches();
  }, 3000);
}

// ---- each room's newest messages, remembered between launches ----
//
// So a room opens straight onto what it showed last time, before any network
// (sealed like the list cache). It's only for show: the first open replaces
// it with the newest page from the server, which also drops anything deleted
// meanwhile.

const MSG_CACHE_PREFIX = 'superchat.msgCache.v1.';
const MSG_CACHE_AD = utf8('sc-msg-cache');
const MSG_CACHE_SIZE = 50;
interface CachedMessages {
  wipeSeen?: number;
  messages: ChatMessage[];
}
const msgCacheKey = () => hkdf(account().entropy, 'superchat/msg-cache');
const msgCacheName = (r: Room) => MSG_CACHE_PREFIX + r.key;
/** The messages array last saved per room, to skip rooms that haven't changed. */
const msgCacheSaved = new Map<string, ChatMessage[]>();

async function loadMessageCaches(list: Room[]): Promise<void> {
  const empty = list.filter(r => !r.messages.length);
  if (!empty.length) return;
  const got = await AsyncStorage.multiGet(empty.map(msgCacheName)).catch(() => []);
  const key = msgCacheKey();
  for (const [i, [, raw]] of got.entries()) {
    const r = empty[i];
    if (!raw || r.messages.length) continue;
    try {
      const c: CachedMessages = JSON.parse(unutf8(aeadOpen(key, unb64(raw), MSG_CACHE_AD)));
      if (r.wipeSeen === undefined) r.wipeSeen = c.wipeSeen;
      for (const m of c.messages) ingest(r, m);
      r.fromCache = true;
      msgCacheSaved.set(r.key, r.messages);
    } catch {
      // another account's, or damaged: the server has it all anyway
    }
  }
}

function saveMessageCaches() {
  const key = msgCacheKey();
  for (const r of rooms.values()) {
    // Only the bottom of the chat, as loaded from the server.
    if (r.hasNewer || r.fromCache || !r.loaded || msgCacheSaved.get(r.key) === r.messages) continue;
    msgCacheSaved.set(r.key, r.messages);
    const c: CachedMessages = {wipeSeen: r.wipeSeen, messages: r.messages.filter(m => !m.pending).slice(-MSG_CACHE_SIZE)};
    AsyncStorage.setItem(msgCacheName(r), b64(aeadSeal(key, utf8(JSON.stringify(c)), MSG_CACHE_AD))).catch(() => {});
  }
}

function forgetMessageCache(r: Room) {
  msgCacheSaved.delete(r.key);
  AsyncStorage.removeItem(msgCacheName(r)).catch(() => {});
}

function clearMessageCaches() {
  msgCacheSaved.clear();
  AsyncStorage.getAllKeys()
    .then(keys => AsyncStorage.multiRemove(keys.filter(k => k.startsWith(MSG_CACHE_PREFIX))))
    .catch(() => {});
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
  /** The other person's picture in a one-to-one chat, else the group picture. */
  picture: AvatarRef | null;
  unread: boolean;
  /** Unread messages from others, as far as this device has loaded them. */
  unreadCount: number;
  /** The latest message, as one line ("Alice: see you there"), or null. */
  preview: string | null;
  lastAt: number;
}

export function roomList(): RoomListItem[] {
  return [...rooms.values()]
    .map(r => {
      // Live data where it's loaded, else what the list showed last launch.
      const cached = listCache[r.key];
      const unreadCount = r.messages.filter(m => !m.pending && m.pos > (lastRead[r.key] ?? 0) && m.sender !== r.me.id && !isCallNotice(m)).length;
      return {
        key: r.key,
        server: r.server,
        id: r.id,
        name: chatTitle(r) ?? cached?.name ?? 'Encrypted chat',
        color: r.view?.color ?? cached?.color ?? FALLBACK_ROOM_COLOR,
        picture: r.view ? chatPicture(r) : (cached?.picture ?? null),
        unread: r.lastPos > 0 ? r.lastPos > (lastRead[r.key] ?? 0) : (cached?.unreadCount ?? 0) > 0,
        unreadCount: r.loaded || r.messages.length ? unreadCount : (cached?.unreadCount ?? 0),
        preview: previewLine(r) ?? cached?.preview ?? null,
        lastAt: Math.max(r.lastAt, cached?.lastAt ?? 0),
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt);
}

function previewLine(r: Room): string | null {
  let m: ChatMessage | undefined = r.hasNewer ? r.latest : undefined;
  if (!r.hasNewer) for (let i = r.messages.length - 1; i >= 0 && !m; i--) if (!r.messages[i].pending && !isCallNotice(r.messages[i])) m = r.messages[i];
  if (!m) return null;
  const who = m.sender === r.me.id ? 'You' : (r.view?.names[m.sender] ?? 'Someone');
  const c = m.content;
  let what = '🔒 Encrypted message';
  if (c?.t === 'text') what = c.body;
  else if (c?.t === 'file') what = c.body || (c.files.every((f: FileRef) => f.mime.startsWith('image/')) ? '📷 Photo' : `📎 ${c.files[0]?.name ?? 'File'}`);
  else if (c?.t === 'ice') what = '🔊 Shared a voice server';
  return `${who}: ${what.replace(/\s+/g, ' ').slice(0, 120)}`;
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
    voice: {},
    hasMore: true,
    hasNewer: false,
    readMark: 0,
    newSinceRead: 0,
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
  forgetMessageCache(r);
  saveLocalList();
  saveVaultSoon(r.server);
}

// ---- loading ----

/** Fetches and verifies a room's log and our keys for it. */
async function loadState(r: Room): Promise<void> {
  // With the log held, only what came after it: the rest was verified
  // already, and re-checking every signature on each load is what made
  // opening slow on long-lived rooms.
  const base = r.log;
  const {events, lastPos, lastAt} = await api.state(r.server, r.id, r.me, base?.state.nextSeq ?? 0);
  // Throws if the server sends anything that breaks the rules.
  let log: ReplayResult;
  try {
    // From what's held now: a push may have moved it on meanwhile.
    log = await extendReplay(r.id, r.log ?? null, events, yieldToUi);
  } catch (e) {
    if (!base) throw e;
    // Didn't follow on from what's held: start over from the whole log.
    const all = await api.state(r.server, r.id, r.me);
    log = await extendReplay(r.id, null, all.events, yieldToUi);
  }
  r.log = log;
  r.lastPos = Math.max(r.lastPos, lastPos);
  r.lastAt = Math.max(r.lastAt, lastAt);
  await loadKeys(r);
  r.view = roomView(r.log, r.keys);
  r.error = null;
  r.syncedAt = Date.now();
  // Reload after this returns: openRoom may be the caller, mid-load.
  if (dropWiped(r)) setTimeout(() => openRoom(r.key, false).catch(() => {}), 0);
}

/**
 * Removes messages from memory (and their cached attachments from the device):
 * deleted for everyone, or wiped.
 */
function forgetMessages(r: Room, gone: (m: ChatMessage) => boolean) {
  const blobs: string[] = [];
  r.messages = r.messages.filter(m => {
    if (m.pending || !gone(m)) return true;
    if (m.content?.t === 'file') for (const f of m.content.files) blobs.push(f.blob);
    return false;
  });
  for (const b of blobs) blobCache.delete(b);
  if (blobs.length) removeSealed(blobs);
  if (r.latest && gone(r.latest)) r.latest = undefined;
  if (r.latestOther && gone(r.latestOther)) r.latestOther = undefined;
}

/**
 * A wipe deletes every message up to it, on the server. When the log shows one
 * this device hasn't handled yet, drop everything held for the room so it
 * reloads from the server, which did the deleting exactly. (Comparing times
 * instead would trust the wiper's clock.) Returns whether it dropped anything.
 */
function dropWiped(r: Room): boolean {
  const w = r.view?.wiped;
  if (!w || r.wipeSeen === w.at) return false;
  const first = r.wipeSeen === undefined && r.messages.length === 0;
  r.wipeSeen = w.at;
  if (first) return false;
  forgetMessages(r, () => true);
  r.hasMore = true;
  r.hasNewer = false;
  r.newSinceRead = 0;
  r.loaded = false;
  return true;
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
  try {
    await loadRooms();
  } finally {
    // Whatever went wrong, the list mustn't sit on "Loading" for ever: it
    // shows what loaded (rooms with errors say so when opened).
    if (!roomsLoaded) {
      roomsLoaded = true;
      emit();
    }
  }
}

async function loadRooms(): Promise<void> {
  const {servers} = await settingsStore.load();
  await loadMyAvatar();
  try {
    lastRead = JSON.parse((await AsyncStorage.getItem(LAST_READ_KEY)) ?? '{}');
  } catch {
    lastRead = {};
  }
  const local = await loadLocalList();
  // Draw last launch's list straight away; live data fills in over it.
  await loadListCache();
  for (const [server, ids] of Object.entries(local)) for (const id of ids) ensureRoom(server, id);
  await loadMessageCaches([...rooms.values()]);
  if (Object.keys(listCache).length) {
    roomsLoaded = true;
    emit();
  }
  const work = Promise.all(
    [...new Set([...servers, ...Object.keys(local)])].map(async server => {
      const fromVault = await readVault(server).catch(() => null);
      if (fromVault) vaultSaved.set(server, JSON.stringify([...fromVault].sort()));
      const ids = new Set([...(local[server] ?? []), ...(fromVault ?? [])]);
      await Promise.all(
        [...ids].map(async id => {
          const r = ensureRoom(server, id);
          try {
            await loadState(r);
            // Shown as soon as its own state is in, not when every room is.
            emit();
            // Not on the way to showing the list: rotation and the picture
            // wait a moment and go one room at a time (after a week away,
            // every room rotating at once held up opening one), and the
            // newest messages for the preview carry on behind it.
            upkeepLater(() => maybeRotate(r).then(() => ensureProfileCurrent(r)));
            upkeepLater(() => syncAvatar(r));
            prefetchLatest(r)
              .then(emit)
              .catch(() => {});
          } catch (e) {
            if (e instanceof ApiError && e.status === 404) rooms.delete(r.key);
            else r.error = String((e as Error).message ?? e);
          }
        }),
      );
      // Keep the vault in step with what's really there.
      if (fromVault && JSON.stringify(roomIdsOn(server)) !== vaultSaved.get(server)) saveVaultSoon(server);
      // Already connected (watch() got there first, before these rooms
      // loaded): subscribe them on that connection.
      if (conns.get(server)?.nonce) wsSubscribe(server, [...rooms.values()].filter(r => r.server === server));
      else if (roomIdsOn(server).length) connect(server);
    }),
  ).then(() => saveLocalList());
  // One slow or unreachable server mustn't hold the whole list: show what's
  // ready after a few seconds, and let the rest arrive as it loads.
  await Promise.race([work, new Promise(res => setTimeout(res, ROOMS_READY_WAIT_MS))]);
  roomsLoaded = true;
  emit();
  work.then(emit).catch(() => {});
}

/** How long after loading starts the rooms' upkeep (see upkeepLater) begins. */
const UPKEEP_DELAY_MS = 3000;
let upkeep: Promise<void> | null = null;

/** Queues work that can wait: a moment after launch, then one job at a time. */
function upkeepLater(job: () => Promise<unknown>) {
  const before = upkeep ?? new Promise<void>(res => setTimeout(res, UPKEEP_DELAY_MS));
  upkeep = before.then(job).then(
    () => {},
    () => {},
  );
}

/** The longest the room list waits for slow servers before showing what it has. */
const ROOMS_READY_WAIT_MS = 1500;

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
function ingest(r: Room, msg: ChatMessage, intoWindow = false) {
  const c = msg.content;
  if (c?.t === 'reaction') {
    const byEmoji: Record<string, string[]> = {};
    for (const [emoji, who] of Object.entries(r.reactions[c.target] ?? {})) {
      // One reaction per person per message: adding one replaces whatever
      // they had on it before (and a removal takes theirs off).
      const rest = emoji === c.emoji || !c.remove ? who.filter(s => s !== msg.sender) : who;
      if (rest.length) byEmoji[emoji] = rest;
    }
    if (!c.remove) byEmoji[c.emoji] = [...(byEmoji[c.emoji] ?? []), msg.sender];
    r.reactions = {...r.reactions, [c.target]: byEmoji};
    return;
  }
  if (c?.t === 'receipt') {
    r.receipts = {...r.receipts, [msg.sender]: c.upTo};
    return;
  }
  // Call notices sit in the timeline but aren't news: no preview, no unread.
  if (msg.pos > 0 && !msg.pending && !isCallNotice(msg)) {
    r.lastPos = Math.max(r.lastPos, msg.pos);
    r.lastAt = Math.max(r.lastAt, msg.createdAt);
    if (msg.pos >= (r.latest?.pos ?? 0)) r.latest = msg;
    if (msg.sender !== r.me.id && msg.pos >= (r.latestOther?.pos ?? 0)) r.latestOther = msg;
  }
  // A window (see jumpToRead) only grows by paging down to what comes next:
  // a line past its end would leave a hole between them.
  if (r.hasNewer && !intoWindow && !msg.pending && msg.pos > newestHeldPos(r)) return;
  r.messages = [...r.messages.filter(x => x.id !== msg.id), msg].sort((a, b) => a.pos - b.pos);
}

/** A "joined the call" / "left the call" line (src/call/voice.ts posts them). */
export const isCallNotice = (m: ChatMessage): boolean => m.content?.t === 'call';

/**
 * Says in the room that this device joined or left its voice. Resolves once
 * the server has it (a leave that couldn't go out is retried; see voice.ts).
 */
export function postCallNotice(key: string, action: 'join' | 'leave'): Promise<void> {
  return send(key, {t: 'call', action});
}

function newestHeldPos(r: Room): number {
  for (let i = r.messages.length - 1; i >= 0; i--) if (!r.messages[i].pending) return r.messages[i].pos;
  return 0;
}

function pruneExpired(r: Room) {
  const cutoff = retentionCutoff(r);
  if (cutoff) r.messages = r.messages.filter(m => m.pending || m.createdAt >= cutoff);
}

/** Loads the newest page of a room (first open) or catches up after a gap. */
/** Hands the JS thread back between small batches, so taps (Back) get through mid-load. */
const yieldToUi = () => new Promise<void>(res => setTimeout(res, 0));

/**
 * Decrypts and files a page of messages a few at a time. Each one is an
 * AEAD open plus a signature check in JS; a whole page in one go held the UI
 * for a noticeable moment.
 */
async function ingestPage(r: Room, page: ServerMessage[], intoWindow = false) {
  for (let i = 0; i < page.length; i++) {
    ingest(r, decrypt(r, page[i]), intoWindow);
    if (i % 8 === 7) await yieldToUi();
  }
}

/**
 * The newest few messages of a room not opened yet, for the room list's
 * preview and unread count. Opening the room later continues from these.
 */
async function prefetchLatest(r: Room) {
  if (r.messages.length) return;
  const page = await api.messages(r.server, r.id, r.me, {limit: 20});
  await ingestPage(r, page);
}

/** When the last full reload (vault, every room's log and keys) ran. */
let lastFullRefresh = Date.now();
/** A pull reloads everything only if the last full reload is older than this. */
const FULL_REFRESH_EVERY_MS = 5 * 60_000;

/**
 * Pull-to-refresh on the room list. Usually just a quick catch-up: each
 * room's messages since the newest one held, all at once (the WebSocket
 * keeps the rest current anyway). Only every few minutes does it also redo
 * the full reload (new rooms from the vault, each room's log and keys).
 */
// ---- catching up after a push wake-up (src/push.ts) ----

/** Messages already handed to onIncoming, so one arriving both by push and by WebSocket notifies once. */
const announced = new Set<string>();
function announce(r: Room, m: ChatMessage) {
  if (announced.has(m.id)) return;
  announced.add(m.id);
  if (announced.size > 2000) announced.delete(announced.values().next().value!);
  incomingListeners.forEach(l => l(r, m));
}

/**
 * A push said this room has something new: fetch what came after the newest
 * message held, and notify for it like a WebSocket push would.
 */
export async function catchUp(key: string): Promise<void> {
  const r = rooms.get(key);
  // Thrown, so the wake-up shows the plain notification instead (src/push.ts).
  if (!r) throw new Error('room not loaded');
  if (!session.get()) throw new Error('locked');
  if (!r.log) await loadState(r);
  connect(r.server); // and get the live connection back, if it dropped
  const newest = newestKnown(r);
  const page = newest
    ? await api.messages(r.server, r.id, r.me, {after: newest.pos, limit: 50})
    : await api.messages(r.server, r.id, r.me, {limit: 5});
  for (const sm of page) {
    // The reconnect above resyncs, which may store this message first
    // (without notifying): announce it either way; announce() dedups.
    let dm = r.messages.find(m => m.id === sm.id);
    if (!dm) {
      if (!r.keys[sm.epoch]) await loadKeys(r);
      dm = decrypt(r, sm);
      ingest(r, dm);
    }
    const c = dm.content;
    const isLine = c?.t === 'text' || c?.t === 'file' || c?.t === 'ice' || !c;
    if (isLine && sm.sender !== r.me.id) announce(r, dm);
  }
  emit();
}

export async function refreshAll(): Promise<void> {
  if (Date.now() - lastFullRefresh > FULL_REFRESH_EVERY_MS) {
    lastFullRefresh = Date.now();
    await refreshRooms().catch(() => {});
  }
  await Promise.all(
    [...rooms.values()].map(async r => {
      if (!r.log || r.loading) return;
      const newest = newestKnown(r);
      if (!newest) return prefetchLatest(r).catch(() => {});
      const page = await api.messages(r.server, r.id, r.me, {after: newest.pos, limit: 200}).catch(() => []);
      await ingestPage(r, page);
      announceCaughtUp(r, page);
    }),
  );
  emit();
}

/**
 * What to catch up from: the newest message held, or while a window is open
 * (which stops short of the newest), the newest one known.
 */
function newestKnown(r: Room): ChatMessage | undefined {
  if (r.hasNewer) return r.latest;
  return r.messages.filter(m => !m.pending).slice(-1)[0];
}

/** Replaces what's held with the newest page: the bottom of the chat. */
async function loadLatest(r: Room): Promise<void> {
  const page = await api.messages(r.server, r.id, r.me, {limit: 50});
  r.messages = r.messages.filter(m => m.pending);
  r.hasMore = page.length === 50;
  r.hasNewer = false;
  r.fromCache = false;
  await ingestPage(r, page);
}

/**
 * Opens a room at the bottom. Pass fresh = false to only catch up (a
 * reconnect, a wipe): that keeps a window open and the "N new" bubble as is.
 * A fresh open notes where reading stopped (readMark) before the screen marks
 * it all read, and asks the server how many came after, for the bubble.
 */
export async function openRoom(key: string, fresh = true): Promise<void> {
  const r = rooms.get(key);
  if (!r) return;
  // Synchronously, before the screen's markRead moves lastRead on.
  const mark = lastRead[key] ?? 0;
  if (fresh) {
    r.readMark = mark;
    r.newSinceRead = 0;
  }
  // One open at a time per room. A catch-up (a reconnect) already under way
  // is waited on, not raced: two at once both rewrote the messages, and a
  // fresh open that just returned left the screen spinning on the other.
  while (r.opening) {
    await r.opening.catch(() => {});
    // That one caught up; a fresh open still checks for itself (quickly).
    if (!fresh) return;
  }
  if (r.loading) {
    // Paging (loadOlder and the like) holds the room.
    if (fresh) countUnread(r, mark).catch(() => {});
    return;
  }
  const opening = openRoomNow(r, fresh, mark);
  r.opening = opening;
  try {
    await opening;
  } finally {
    if (r.opening === opening) r.opening = undefined;
  }
}

async function openRoomNow(r: Room, fresh: boolean, mark: number): Promise<void> {
  r.loading = true;
  emit();
  try {
    if (!r.log) await loadState(r);
    if (fresh) countUnread(r, mark).catch(() => {});
    const newest = newestKnown(r);
    if (!newest || (fresh && r.hasNewer) || r.fromCache) {
      await loadLatest(r);
    } else {
      const page = await api.messages(r.server, r.id, r.me, {after: newest.pos, limit: 200});
      // More than a page behind: skip the gap and start from the bottom.
      if (page.length === 200 && !r.hasNewer) await loadLatest(r);
      else {
        await ingestPage(r, page);
        if (!fresh) announceCaughtUp(r, page);
      }
    }
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

/**
 * Notifies for what a catch-up found (a reconnect, a pull to refresh), as a
 * push would have: otherwise a wake-up arriving after it finds nothing new
 * and stays silent. Only in the background: in the app, it's on screen.
 */
function announceCaughtUp(r: Room, page: ServerMessage[]) {
  if (AppState.currentState === 'active') return;
  for (const sm of page) {
    if (sm.sender === r.me.id) continue;
    const dm = r.messages.find(m => m.id === sm.id);
    const c = dm?.content;
    if (dm && (c?.t === 'text' || c?.t === 'file' || c?.t === 'ice' || !c)) announce(r, dm);
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
    await ingestPage(r, page);
  } catch (e) {
    r.error = String((e as Error).message ?? e);
  } finally {
    r.loading = false;
    emit();
  }
}

/**
 * How many messages from others came after `mark`, counted by the server,
 * which also knows how far this member read on other devices (their
 * receipts): the bubble starts from whichever is further.
 */
async function countUnread(r: Room, mark: number): Promise<void> {
  if (!r.lastPos || r.lastPos <= mark) return;
  const {readPos, count} = await api.unread(r.server, r.id, r.me, mark);
  if (r.readMark !== mark) return; // opened again since
  r.readMark = readPos;
  r.newSinceRead = count;
  emit();
}

/**
 * Jumps to where reading stopped (readMark). If that's already held, there's
 * nothing to load: the screen scrolls to it. Otherwise this swaps what's held
 * for a window around it, which loadNewer pages down from until it meets the
 * newest again (hasNewer). Reactions and receipts are kept: they're per room,
 * not per page.
 */
export async function jumpToRead(key: string): Promise<void> {
  const r = rooms.get(key);
  if (!r || r.loading) return;
  const oldest = r.messages.find(m => !m.pending);
  if (oldest && (oldest.pos <= r.readMark || !r.hasMore)) return;
  r.loading = true;
  emit();
  try {
    const [before, after] = await Promise.all([
      api.messages(r.server, r.id, r.me, {before: r.readMark + 1, limit: 20}),
      api.messages(r.server, r.id, r.me, {after: r.readMark, limit: 50}),
    ]);
    r.messages = r.messages.filter(m => m.pending);
    r.hasMore = before.length === 20;
    r.hasNewer = true;
    await ingestPage(r, [...before, ...after], true);
    settleNewer(r, after.length === 50);
    pruneExpired(r);
  } catch (e) {
    r.error = String((e as Error).message ?? e);
  } finally {
    r.loading = false;
    emit();
  }
}

/** The next page down in a window; it closes once it reaches the newest. */
export async function loadNewer(key: string): Promise<void> {
  const r = rooms.get(key);
  if (!r || r.loading || !r.hasNewer) return;
  r.loading = true;
  emit();
  try {
    const page = await api.messages(r.server, r.id, r.me, {after: newestHeldPos(r), limit: 50});
    await ingestPage(r, page, true);
    settleNewer(r, page.length === 50, page.length === 0);
  } catch (e) {
    r.error = String((e as Error).message ?? e);
  } finally {
    r.loading = false;
    emit();
  }
}

/**
 * A short page means the window reached the newest, unless one arrived
 * meanwhile (held back by ingest): then there's still a page to go. An empty
 * page settles it either way (lastPos can point at a deleted message).
 */
function settleNewer(r: Room, full: boolean, empty = false) {
  r.hasNewer = !empty && (full || newestHeldPos(r) < r.lastPos);
}

/** Leaves a window for the bottom of the chat. */
export async function jumpToLatest(key: string): Promise<void> {
  const r = rooms.get(key);
  if (!r || !r.hasNewer) return;
  r.loading = true;
  emit();
  try {
    await loadLatest(r);
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
  // Tell the room, unless the newest line is our own. (Not the newest held:
  // a window may stop short of it.)
  const newest = r.latestOther?.content ? r.latestOther : undefined;
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
/** When each server's connection dropped, while it's down. */
const offlineSince = new Map<string, number>();
/** A drop shorter than this (usually the app coming back to the foreground) isn't worth a banner. */
const OFFLINE_GRACE_MS = 4000;
export const isServerOnline = (server: string) => {
  const since = offlineSince.get(server);
  return since === undefined || Date.now() - since < OFFLINE_GRACE_MS;
};

type IncomingListener = (room: Room, msg: ChatMessage) => void;
const incomingListeners = new Set<IncomingListener>();
/** Called for each new chat line from someone else (for notifications). */
export function onIncoming(l: IncomingListener): () => void {
  incomingListeners.add(l);
  return () => incomingListeners.delete(l);
}

export function connect(server: string) {
  watchAppState();
  let c = conns.get(server);
  if (c && (c.ws || c.timer)) return;
  if (!c) {
    c = {ws: null, nonce: null, backoff: 1000, timer: null, ready: false, closed: false};
    conns.set(server, c);
  }
  c.closed = false;
  open(server, c);
}

/** When the app went to the background, while it's there. */
let backgroundedAt: number | null = null;
/** Back after longer than this, a connection that looks open may be dead (the server dropped it, the network changed). */
const STALE_AFTER_MS = 30_000;
let watchingAppState = false;

/**
 * Back in the foreground: reconnect now. In the background the retries back
 * off (up to a minute), and a socket left open may have died without a word;
 * waiting on either showed "Can't reach this room's server" for no reason.
 */
function watchAppState() {
  if (watchingAppState) return;
  watchingAppState = true;
  AppState.addEventListener('change', state => {
    if (state === 'background') {
      backgroundedAt = Date.now();
      return;
    }
    if (state !== 'active') return;
    const away = backgroundedAt === null ? 0 : Date.now() - backgroundedAt;
    backgroundedAt = null;
    for (const [server, c] of conns) {
      if (c.closed) continue;
      c.backoff = 1000;
      if (c.timer) {
        clearTimeout(c.timer);
        c.timer = null;
      } else if (c.ws && away > STALE_AFTER_MS) {
        const old = c.ws;
        old.onclose = null;
        old.onmessage = null;
        old.close();
        c.ws = null;
      }
      if (!c.ws) open(server, c);
    }
  });
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
      if (offlineSince.delete(server)) emit();
      // Catch up on anything missed while disconnected (resync also asks
      // who's in voice). A room subscribed to later (just made or joined)
      // asks on its own.
      if (first) resync(server).catch(() => {});
      else {
        for (const id of (msg.rooms ?? []) as string[]) {
          const r = rooms.get(roomKey(server, id));
          if (r) probeVoice(r);
        }
      }
      return;
    }
    handlePush(server, msg).catch(() => {});
  };
  ws.onclose = () => {
    c.ws = null;
    c.ready = false;
    if (c.closed) return;
    if (!offlineSince.has(server)) {
      offlineSince.set(server, Date.now());
      // Shown only if it's still down once the grace period is over.
      setTimeout(emit, OFFLINE_GRACE_MS + 50);
    }
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

/** A room whose log loaded this recently isn't reloaded by a reconnect, only caught up. */
const RESYNC_RELOAD_AFTER_MS = 30_000;

async function resync(server: string) {
  // Every room at once, as loadRooms does. Right after launch the logs were
  // just loaded: reloading (and re-verifying) each one again, one by one,
  // held up the room being opened.
  await Promise.all(
    [...rooms.values()]
      .filter(x => x.server === server)
      .map(async r => {
        try {
          if (Date.now() - (r.syncedAt ?? 0) > RESYNC_RELOAD_AFTER_MS) await loadState(r);
          if (r.loaded) await openRoom(r.key, false);
          maybeRotate(r).catch(() => {});
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) forgetRoom(r.key);
          else r.error = String((e as Error).message ?? e);
        }
      }),
  );
  emit();
  // Ask who's in voice now, rather than waiting for the next heartbeats.
  for (const r of [...rooms.values()].filter(x => x.server === server)) probeVoice(r);
  serverReadyListeners.forEach(l => l(server));
}

// ---- voice signaling ----
//
// Voice rooms (src/call/engine.ts, docs/protocol.md "Voice rooms") signal
// over the same socket. The store opens and checks each box and keeps who is
// in each room's voice (Room.voice) for the room list and room screen; the
// engine handles everything else.

export interface VoicePresence {
  member: string;
  sid: string;
  muted: boolean;
  deaf: boolean;
  /** ms; gone if not heard from by then. */
  expires: number;
}

/** A session not heard from in this long has left. */
export const VOICE_PRESENCE_MS = 40_000;

/** Identifies this app instance in probes (a voice session has its own sid). */
const deviceSid = b64(randomBytes(9));

type RtcListener = (room: Room, from: string, s: OpenedSignal) => void;
const rtcListeners = new Set<RtcListener>();
export function onRtc(l: RtcListener): () => void {
  rtcListeners.add(l);
  return () => rtcListeners.delete(l);
}

type VoiceStartListener = (room: Room, member: string) => void;
const voiceStartListeners = new Set<VoiceStartListener>();
/** Someone opened a room's voice that was empty (for notifications). */
export function onVoiceStart(l: VoiceStartListener): () => void {
  voiceStartListeners.add(l);
  return () => voiceStartListeners.delete(l);
}

type ServerReadyListener = (server: string) => void;
const serverReadyListeners = new Set<ServerReadyListener>();
/** A server's socket is (re)subscribed and its rooms resynced. */
export function onServerReady(l: ServerReadyListener): () => void {
  serverReadyListeners.add(l);
  return () => serverReadyListeners.delete(l);
}

/**
 * Seals a signal under the room's current epoch key and sends it. False if
 * the room's socket is down. If that epoch's key hasn't been fetched yet (a
 * rotation we haven't caught up on), it's fetched first and the signal goes
 * out after.
 */
export function sendRtc(key: string, to: string, s: Signal): boolean {
  const r = rooms.get(key);
  const c = r && conns.get(r.server);
  const epoch = r?.log?.state.epoch;
  if (!r || !c?.ready || !c.ws || epoch === undefined) return false;
  const ts = Date.now();
  const go = () => {
    const k = r.keys[epoch];
    if (!k || !c.ready || !c.ws) return;
    try {
      c.ws.send(JSON.stringify({type: 'rtc', room: r.id, ...(to ? {to} : {}), box: sealSignal(r.me, r.id, epoch, k, to, s, ts)}));
    } catch {
      // socket closing; the engine re-sends what matters on reconnect
    }
  };
  if (r.keys[epoch]) go();
  else loadKeys(r).then(go, () => {});
  return true;
}

/** Who is in a room's voice right now, other than this device's own session. */
export function voicePresence(key: string): VoicePresence[] {
  const r = rooms.get(key);
  if (!r) return [];
  const now = Date.now();
  return Object.values(r.voice).filter(p => p.expires > now);
}


function probeVoice(r: Room) {
  sendRtc(r.key, '', {sid: deviceSid, k: 'probe'});
}

let voiceTimer: ReturnType<typeof setTimeout> | null = null;
/** Re-renders once the next presence entry expires. */
function scheduleVoiceExpiry() {
  if (voiceTimer) clearTimeout(voiceTimer);
  voiceTimer = null;
  let next = Infinity;
  const now = Date.now();
  for (const r of rooms.values()) {
    for (const [k, p] of Object.entries(r.voice)) {
      if (p.expires <= now) delete r.voice[k];
      else next = Math.min(next, p.expires);
    }
  }
  if (next < Infinity) {
    voiceTimer = setTimeout(() => {
      scheduleVoiceExpiry();
      emit();
    }, next - now + 50);
  }
}

async function handleRtc(r: Room, msg: any) {
  if (typeof msg.from !== 'string' || typeof msg.box !== 'string' || msg.from === r.me.id) return;
  const to = typeof msg.to === 'string' ? msg.to : '';
  if (to && to !== r.me.id) return;
  let s: OpenedSignal;
  try {
    const epoch = signalEpoch(msg.box);
    if (!r.keys[epoch]) await loadKeys(r);
    const key = r.keys[epoch];
    if (!key) return;
    s = openSignal(r.id, msg.from, to, msg.box, key);
  } catch {
    return; // forged, stale, or from an epoch we can't read
  }
  const id = `${msg.from}:${s.sid}`;
  const wasEmpty = voicePresence(r.key).length === 0;
  if (s.k === 'beat' || s.k === 'join' || s.k === 'here') {
    r.voice = {
      ...r.voice,
      [id]: {member: msg.from, sid: s.sid, muted: !!s.muted, deaf: !!s.deaf, expires: Date.now() + VOICE_PRESENCE_MS},
    };
    scheduleVoiceExpiry();
    emit();
    if (s.k === 'join' && wasEmpty) voiceStartListeners.forEach(l => l(r, msg.from));
  } else if (s.k === 'leave' && r.voice[id]) {
    const rest = {...r.voice};
    delete rest[id];
    r.voice = rest;
    emit();
  }
  rtcListeners.forEach(l => l(r, msg.from, s));
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
        if (parsed.kind === 'delete') forgetMessages(r, m => m.id === parsed.pub.msg);
        r.view = roomView(r.log, r.keys);
        if (parsed.kind === 'wipe' && dropWiped(r)) openRoom(r.key, false).catch(() => {});
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
      const isLine = dm.content?.t === 'text' || dm.content?.t === 'file' || dm.content?.t === 'ice' || !dm.content;
      if (isLine && r.typing[m.sender]) {
        const {[m.sender]: _gone, ...rest} = r.typing;
        r.typing = rest;
      }
      ingest(r, dm);
      emit();
      if (isLine && m.sender !== r.me.id) announce(r, dm);
      return;
    }
    case 'deleted': {
      const ids = new Set<string>(msg.ids);
      forgetMessages(r, m => ids.has(m.id));
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
    case 'rtc': {
      await handleRtc(r, msg);
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
  return {name: v?.name ?? undefined, color: v?.color ?? undefined, picture: v?.picture ?? undefined, profiles: v?.names ?? {}};
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

// ---- profile picture ----
//
// One picture for the account, published into every room: each room gets its
// own encrypted copy (its own blob and key), so rooms still can't be linked.
// The original stays on this device only, to publish into rooms joined later.

const MY_AVATAR_KEY = 'superchat.myAvatar.v1';
/** This device's picture (base64 JPEG) or null if removed, and when it was set. */
let myAvatar: {data: string | null; at: number} | null = null;

async function loadMyAvatar() {
  try {
    myAvatar = JSON.parse((await AsyncStorage.getItem(MY_AVATAR_KEY)) ?? 'null');
  } catch {
    myAvatar = null;
  }
}

export const getMyAvatar = (): Uint8Array | null => (myAvatar?.data ? unb64(myAvatar.data) : null);

/** Sets (or, with null, removes) the profile picture in every room. */
export async function setMyAvatar(jpeg: Uint8Array | null): Promise<void> {
  myAvatar = {data: jpeg ? b64(jpeg) : null, at: Date.now()};
  await AsyncStorage.setItem(MY_AVATAR_KEY, JSON.stringify(myAvatar));
  emit();
  const results = await Promise.allSettled([...rooms.values()].map(syncAvatar));
  const failed = results.filter(x => x.status === 'rejected').length;
  if (failed) throw new Error(`Couldn't update ${failed} room${failed > 1 ? 's' : ''}; it'll retry next launch.`);
}

/**
 * Brings this room's copy of my picture in line with this device's. Only a
 * newer setting wins, so two devices on one account don't fight over it.
 */
async function syncAvatar(r: Room): Promise<void> {
  const mine = myAvatar;
  const cur = r.view?.avatars[r.me.id];
  if (!mine || !r.log || !(r.me.id in r.log.state.members)) return;
  if (cur && cur.at >= mine.at) return;
  if (!cur && !mine.data) return;
  if (!mine.data) {
    await api.setAvatar(r.server, r.id, r.me, '');
    await publishProfile(r, null);
    return;
  }
  const picture = unb64(mine.data);
  const {key, sealed} = encryptBlob(picture);
  const blob = await uploadBlob(r.server, r.id, r.me, sealed);
  await api.setAvatar(r.server, r.id, r.me, blob);
  putSealed(blob, sealed);
  remember(blob, picture);
  await publishProfile(r, {blob, key: b64(key), at: mine.at});
}

function publishProfile(r: Room, avatar: AvatarRef | null) {
  return append(r, log => ({
    events: [
      {kind: 'profile', enc: {displayName: myName(r), avatar}, encEpoch: log.state.epoch, encKey: r.keys[log.state.epoch]},
    ],
  }));
}

/** A profile event's contents: the name, carrying the current picture along. */
function profileEnc(r: Room, displayName: string): Record<string, unknown> {
  const avatar = r.view?.avatars[r.me.id];
  return avatar ? {displayName, avatar} : {displayName};
}

async function republishProfile(r: Room) {
  const name = myName(r);
  const s = r.log?.state;
  if (!name || !s || !r.keys[s.epoch]) return;
  await append(r, log => ({
    events: [{kind: 'profile', enc: profileEnc(r, name), encEpoch: log.state.epoch, encKey: r.keys[log.state.epoch]}],
  }));
}

/**
 * Re-publishes my profile if the room has been re-keyed since I last did.
 * Someone who joins can only read profiles under keys from after they
 * joined, so each member re-publishes on a new key; that used to happen only
 * when the app was open at the moment of the re-key, and anyone joining
 * while it was closed saw no name for me (until I next changed my profile).
 * Checked whenever the room loads, so a missed re-key is caught up.
 */
async function ensureProfileCurrent(r: Room) {
  const s = r.log?.state;
  if (!s || !(r.me.id in s.members)) return;
  let mine = -1;
  for (const e of r.log!.events) if (e.kind === 'profile' && e.author === r.me.id) mine = Math.max(mine, e.epoch);
  if (mine < s.epoch) await republishProfile(r);
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
  syncAvatar(r).catch(() => {});
  return r.key;
}

export async function addServer(server: string) {
  const s = settingsStore.get();
  if (!s.servers.includes(server)) await settingsStore.update({servers: [...s.servers, server]});
}

/** replaceId: a pending bubble this one takes the place of (a file message, once its files are up). */
export async function send(key: string, content: MessageContent, blobs: string[] = [], replaceId?: string): Promise<void> {
  const r = rooms.get(key);
  const s = r?.log?.state;
  if (!r || !s) throw new Error('room not loaded');
  const epoch = s.epoch;
  if (!r.keys[epoch]) await loadKeys(r);
  const k = r.keys[epoch];
  if (!k) throw new Error("You don't have this room's key yet.");
  const enc = encryptMessage(r.me, r.id, epoch, k, content);
  const isLine = content.t === 'text' || content.t === 'file' || content.t === 'ice';
  // Sending from up in a window goes to the bottom, where the message lands.
  if (isLine && r.hasNewer) await jumpToLatest(key);
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
    if (replaceId) r.messages = r.messages.filter(m => m.id !== replaceId);
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
      if (r.log!.state.epoch !== epoch) return send(key, content, blobs, replaceId);
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

// ---- sending files ----
//
// A file message shows in the chat as soon as it's picked: a pending bubble
// with the pictures themselves (from memory, under "local:" blob IDs) and
// each one's upload progress. The work runs here, not in the room screen, so
// it carries on whatever screen is showing. If it fails, the bubble stays,
// marked as not sent, until it's retried or removed.

interface FileUpload {
  key: string;
  /** The pending bubble (ChatMessage.id). */
  id: string;
  files: Attachment[];
  body: string;
  replyTo?: string;
  /** Each file once it's on the server. */
  refs: (FileRef | null)[];
  progress: number[];
  running: boolean;
}
const fileUploads = new Map<string, FileUpload>();
const UPLOAD_TRIES = 3;
const UPLOADS_AT_ONCE = 2;

const localBlob = (id: string, i: number) => `local:${id}:${i}`;

/** A picked file still being sent, by its local blob ID. */
function localFile(blob: string): Uint8Array | undefined {
  const [, id, i] = blob.split(':');
  return blob.startsWith('local:') ? fileUploads.get(id)?.files[Number(i)]?.data : undefined;
}

/**
 * Sends files (with an optional caption) as one message. Resolves once it's
 * sent; on failure the bubble stays in the chat as not sent, and this rejects.
 */
export async function sendFiles(key: string, files: Attachment[], body: string, replyTo?: string): Promise<void> {
  const r = rooms.get(key);
  if (!r) throw new Error('room not loaded');
  if (r.hasNewer) await jumpToLatest(key);
  const id = `local-${b64(randomBytes(12))}`;
  const u: FileUpload = {key, id, files, body, replyTo, refs: files.map(() => null), progress: files.map(() => 0), running: false};
  fileUploads.set(id, u);
  files.forEach((f, i) => remember(localBlob(id, i), f.data));
  showUpload(u);
  return runUpload(u);
}

/** Tries a file message that wasn't sent again, from the files not uploaded yet. */
export function retryUpload(id: string): Promise<void> {
  const u = fileUploads.get(id);
  return u ? runUpload(u) : Promise.resolve();
}

/** Gives up on a file message that wasn't sent: its bubble goes. */
export function discardUpload(id: string) {
  const u = fileUploads.get(id);
  if (!u || u.running) return;
  fileUploads.delete(id);
  const r = rooms.get(u.key);
  if (r) r.messages = r.messages.filter(m => m.id !== id);
  emit();
}

/** Puts the bubble in (or redraws it) with where the upload is. */
function showUpload(u: FileUpload, failed?: string) {
  const r = rooms.get(u.key);
  if (!r) return;
  const msg: ChatMessage = {
    id: u.id,
    pos: Number.MAX_SAFE_INTEGER,
    sender: r.me.id,
    createdAt: r.messages.find(m => m.id === u.id)?.createdAt ?? Date.now(),
    epoch: r.log?.state.epoch ?? 0,
    content: {
      t: 'file',
      files: u.files.map(
        (f, i) => u.refs[i] ?? {blob: localBlob(u.id, i), key: '', name: f.name, mime: f.mime, size: f.data.length, w: f.w, h: f.h},
      ),
      body: u.body || undefined,
      replyTo: u.replyTo,
      ts: Date.now(),
    } as DecryptedMessage,
    pending: true,
    upload: {progress: [...u.progress], failed},
  };
  r.messages = [...r.messages.filter(m => m.id !== u.id), msg];
}

async function runUpload(u: FileUpload): Promise<void> {
  if (u.running) return;
  u.running = true;
  showUpload(u);
  emit();
  let lastDrawn = 0;
  const progressed = (i: number, frac: number) => {
    if (frac <= u.progress[i]) return; // never backwards
    u.progress[i] = frac;
    if (Date.now() - lastDrawn < 100 && frac < 1) return;
    lastDrawn = Date.now();
    showUpload(u);
    emit();
  };
  try {
    const r = rooms.get(u.key);
    if (!r) throw new Error('room not loaded');
    // A few at a time, each tried again a couple of times before giving up.
    const todo = u.files.map((_, i) => i).filter(i => !u.refs[i]);
    const worker = async () => {
      for (let i = todo.shift(); i !== undefined; i = todo.shift()) {
        const f = u.files[i];
        // Let the bubble paint before encrypting, which holds the JS thread briefly.
        await yieldToUi();
        const {key: fk, sealed} = encryptBlob(f.data);
        let blob = '';
        for (let tries = 1; !blob; tries++) {
          try {
            blob = await uploadBlob(r.server, r.id, r.me, sealed, frac => progressed(i, frac));
          } catch (e) {
            if (tries >= UPLOAD_TRIES) throw e;
            await new Promise(res => setTimeout(res, 1000 * tries));
          }
        }
        // What we just sent never needs downloading back.
        putSealed(blob, sealed);
        remember(blob, f.data);
        u.refs[i] = {blob, key: b64(fk), name: f.name, mime: f.mime, size: f.data.length, w: f.w, h: f.h};
        progressed(i, 1);
      }
    };
    await Promise.all(Array.from({length: Math.min(UPLOADS_AT_ONCE, todo.length)}, worker));
    const refs = u.refs as FileRef[];
    await send(u.key, {t: 'file', files: refs, body: u.body || undefined, replyTo: u.replyTo}, refs.map(x => x.blob), u.id);
    fileUploads.delete(u.id);
  } catch (e) {
    u.running = false;
    showUpload(u, String((e as Error).message ?? e));
    emit();
    throw e;
  }
  u.running = false;
}

const blobCache = new Map<string, Uint8Array>();
export async function fetchFile(key: string, ref: FileRef): Promise<Uint8Array> {
  const local = localFile(ref.blob);
  if (local) return local;
  const cached = blobCache.get(ref.blob);
  if (cached) {
    remember(ref.blob, cached); // most recently used
    return cached;
  }
  const r = rooms.get(key);
  if (!r) throw new Error('room not loaded');
  const fileKey = unb64(ref.key);
  // The device cache holds the sealed blob (blobDisk.ts); a damaged copy just
  // means downloading it again.
  let data: Uint8Array | null = null;
  const onDisk = await getSealed(ref.blob);
  if (onDisk) {
    try {
      data = decryptBlob(fileKey, onDisk);
    } catch {
      data = null;
    }
  }
  if (!data) {
    const sealed = await downloadBlob(r.server, r.id, r.me, ref.blob);
    data = decryptBlob(fileKey, sealed);
    putSealed(ref.blob, sealed);
  }
  remember(ref.blob, data);
  return data;
}

// Keep recent files decrypted in memory only (never on disk), least recently
// used out first.
function remember(blob: string, data: Uint8Array) {
  blobCache.delete(blob);
  blobCache.set(blob, data);
  while (blobCache.size > 24) blobCache.delete(blobCache.keys().next().value!);
}

// And the data: URIs images are shown through, so a row that scrolls back
// into view (or an avatar that repeats) shows at once, with no work at all.
const uriCache = new Map<string, string>();
function rememberUri(blob: string, uri: string) {
  uriCache.delete(blob);
  uriCache.set(blob, uri);
  while (uriCache.size > 48) uriCache.delete(uriCache.keys().next().value!);
}

export interface ShownImage {
  uri: string;
}

/** An image ready in memory, synchronously; null if it needs loading. */
export function peekImage(ref: FileRef): ShownImage | null {
  let uri = uriCache.get(ref.blob);
  if (!uri) {
    const data = blobCache.get(ref.blob);
    if (!data) return null;
    uri = dataUri(ref.mime, data);
  }
  rememberUri(ref.blob, uri);
  return {uri};
}

interface BlobNative {
  open(blob: string, url: string, headers: Record<string, string>, key: string, mime: string): Promise<string>;
}
const NativeBlob = Platform.OS === 'android' ? (NativeModules.Blob as BlobNative | undefined) : undefined;

/**
 * An image ready to show: from memory, or else loaded from the device cache
 * or the server. On Android that whole load (download, decrypt, encode) runs
 * natively off the JS thread (BlobModule.kt), so taps never wait on it; the
 * JS path is the fallback (older Android, the browser).
 */
export function loadImage(key: string, ref: FileRef): Promise<ShownImage> {
  const ready = peekImage(ref);
  if (ready) return Promise.resolve(ready);
  // The same blob asked for again while loading (a row redrawn, a repeated
  // avatar) waits on that load: two at once raced on the native download.
  let p = imageLoads.get(ref.blob);
  if (!p) {
    p = loadImageOnce(key, ref).finally(() => imageLoads.delete(ref.blob));
    imageLoads.set(ref.blob, p);
  }
  return p;
}
const imageLoads = new Map<string, Promise<ShownImage>>();

async function loadImageOnce(key: string, ref: FileRef): Promise<ShownImage> {
  const r = rooms.get(key);
  if (!r) throw new Error('room not loaded');
  if (NativeBlob) {
    const req = blobRequest(r.server, r.id, r.me, ref.blob);
    try {
      const uri = await NativeBlob.open(ref.blob, req.url, req.headers, base64.encode(unb64(ref.key)), ref.mime);
      rememberUri(ref.blob, uri);
      noteCached();
      return {uri};
    } catch (e) {
      if ((e as {code?: string}).code !== 'E_UNSUPPORTED') throw e;
    }
  }
  await fetchFile(key, ref);
  return peekImage(ref)!;
}

/**
 * Toggles my reaction: the same emoji again takes it off; a different one
 * replaces it (one reaction per person per message).
 */
export async function react(key: string, target: string, emoji: string) {
  const r = rooms.get(key)!;
  const current = Object.entries(r.reactions[target] ?? {}).find(([, who]) => who.includes(r.me.id))?.[0];
  if (current === emoji) return send(key, {t: 'reaction', target, emoji, remove: true});
  // Take the old one off explicitly too, so apps from before the
  // one-per-person rule agree.
  if (current) await send(key, {t: 'reaction', target, emoji: current, remove: true});
  return send(key, {t: 'reaction', target, emoji});
}

/** Takes my reaction (whichever it is) off a message. */
export function unreact(key: string, target: string) {
  const r = rooms.get(key)!;
  const current = Object.entries(r.reactions[target] ?? {}).find(([, who]) => who.includes(r.me.id))?.[0];
  return current ? send(key, {t: 'reaction', target, emoji: current, remove: true}) : Promise.resolve();
}

/** Admins only (the log enforces it): deletes every message so far, for everyone. */
export async function wipeChat(key: string) {
  const r = rooms.get(key)!;
  await append(r, () => ({events: [{kind: 'wipe', pub: {}}]}));
  if (dropWiped(r)) await openRoom(r.key, false);
  emit();
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

/**
 * Deletes this account's data from every server: in each room, everything I
 * posted (messages, files, profile picture) is erased and I leave; then the
 * room-list backup on each server is deleted. A room that's already gone, or
 * that I was removed from, is skipped. It stops at the first failure, and
 * running it again finishes the rest. The caller then forgets the key on this
 * device.
 */
export async function deleteAccount(): Promise<void> {
  if (!roomsLoaded) throw new Error("Your chats are still loading. Try again in a moment.");
  const roomServers = new Set([...rooms.values()].map(r => r.server));
  const servers = new Set([...settingsStore.get().servers, ...roomServers]);
  for (const r of [...rooms.values()]) {
    try {
      await api.eraseMine(r.server, r.id, r.me);
      await leave(r.key);
    } catch (e) {
      // Only the server's own "no such room"; a server too old to know this
      // endpoint also answers 404, and that must not count as done.
      if (!(e instanceof ApiError && e.status === 404)) throw e;
      if (!/no such room/.test(e.message)) throw new Error(`${r.server.replace(/^https?:\/\//, '')} doesn't support deleting accounts yet.`);
      forgetRoom(r.key);
    }
  }
  // Leaving queued backup writes; the backups are about to go instead.
  for (const t of vaultTimers.values()) clearTimeout(t);
  vaultTimers.clear();
  for (const server of servers) {
    try {
      await api.deleteVault(server, vaultKeys(account().entropy, server));
    } catch (e) {
      // A saved server I never had a room on may be gone for good; one I did
      // have rooms on must confirm.
      if (roomServers.has(server)) throw e;
    }
  }
}

export const setRetention = (key: string, retentionDays: number) =>
  append(rooms.get(key)!, () => ({events: [{kind: 'settings', pub: {retentionDays}}]}));

export const setMeta = (key: string, name: string, color: string) =>
  append(rooms.get(key)!, log => ({
    events: [{kind: 'meta', enc: {name, color}, encEpoch: log.state.epoch, encKey: rooms.get(key)!.keys[log.state.epoch]}],
  }));

/**
 * Sets (or, with null, removes) the group picture. Like a profile picture:
 * an encrypted blob the server marks as the room's, with the key in the
 * (admin-only) meta event.
 */
export async function setRoomPicture(key: string, jpeg: Uint8Array | null): Promise<void> {
  const r = rooms.get(key)!;
  let picture: AvatarRef | null = null;
  if (jpeg) {
    const {key: fk, sealed} = encryptBlob(jpeg);
    const blob = await uploadBlob(r.server, r.id, r.me, sealed);
    await api.setPicture(r.server, r.id, r.me, blob);
    putSealed(blob, sealed);
    remember(blob, jpeg);
    picture = {blob, key: b64(fk), at: Date.now()};
  } else {
    await api.setPicture(r.server, r.id, r.me, '');
  }
  // Only the picture: an absent name or color means "unchanged".
  await append(r, log => ({
    events: [{kind: 'meta', enc: {picture}, encEpoch: log.state.epoch, encKey: r.keys[log.state.epoch]}],
  }));
}

/**
 * The other person, when this is a one-to-one chat: exactly two members, me
 * and them. Such a chat shows as that person (name and picture) rather than
 * by its room name.
 */
export function dmPeer(r: Room | undefined): string | null {
  const m = r?.view?.members;
  if (!r || !m || m.length !== 2 || !m.some(x => x.id === r.me.id)) return null;
  return m.find(x => x.id !== r.me.id)!.id;
}

/** Whether I'm the only one in the chat. */
const isSolo = (r: Room): boolean => r.view?.members.length === 1 && r.view.members[0].id === r.me.id;

/**
 * What a chat is called: the other person in a one-to-one chat, me when
 * I'm alone in it, else its name, else (no name set, or it was cleared)
 * who's in it.
 */
export function chatTitle(r: Room | undefined): string | null {
  const v = r?.view;
  if (!r || !v) return null;
  const peer = dmPeer(r);
  if (peer) return v.names[peer] ?? fingerprint(peer);
  if (isSolo(r)) return `${v.names[r.me.id] ?? fingerprint(r.me.id)} (You)`;
  if (v.name) return v.name;
  const others = v.members.filter(m => m.id !== r.me.id).map(m => m.name ?? fingerprint(m.id));
  return others.length ? others.join(', ') : 'New chat';
}

/** The picture a chat shows: the other person's in a one-to-one chat, mine when I'm alone in it, else the group's. */
export function chatPicture(r: Room | undefined): AvatarRef | null {
  const peer = dmPeer(r);
  if (peer) return r!.view!.avatars[peer] ?? null;
  if (r && isSolo(r)) return r.view!.avatars[r.me.id] ?? null;
  return r?.view?.picture ?? null;
}

/**
 * Who a group chat without a picture shows instead: up to three others
 * (never me), the latest to speak first, topped up from the rest in a fixed
 * per-chat shuffle so it doesn't jump around between renders.
 */
export function chatFaces(r: Room | undefined): string[] {
  const v = r?.view;
  if (!r || !v || v.picture || dmPeer(r)) return [];
  const others = v.members.map(m => m.id).filter(id => id !== r.me.id);
  const recent: string[] = [];
  for (let i = r.messages.length - 1; i >= 0 && recent.length < 3; i--) {
    const s = r.messages[i].sender;
    if (others.includes(s) && !recent.includes(s)) recent.push(s);
  }
  const mix = (s: string) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  };
  const rest = others.filter(id => !recent.includes(id)).sort((a, b) => mix(r.key + a) - mix(r.key + b));
  return [...recent, ...rest].slice(0, 3);
}

export const setDisplayName = (key: string, displayName: string) =>
  append(rooms.get(key)!, log => ({
    events: [{kind: 'profile', enc: profileEnc(rooms.get(key)!, displayName), encEpoch: log.state.epoch, encKey: rooms.get(key)!.keys[log.state.epoch]}],
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
      syncAvatar(r).catch(() => {});
      return r.key;
    }
    const preview = openPreview(link.secret, res.preview);
    const {batch} = joinBatch(me, log.state, link, preview, displayName);
    try {
      await api.join(link.server, link.invite, me, batch);
      const r = addRoom(link.server, res.room);
      await loadState(r);
      emit();
      syncAvatar(r).catch(() => {});
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
  clearSealed().catch(() => {});
  roomsLoaded = false;
  AsyncStorage.removeItem(ROOMS_KEY).catch(() => {});
  myAvatar = null;
  AsyncStorage.removeItem(MY_AVATAR_KEY).catch(() => {});
  listCache = {};
  AsyncStorage.removeItem(LIST_CACHE_KEY).catch(() => {});
  clearMessageCaches();
  emit();
}
