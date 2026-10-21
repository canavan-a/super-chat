// Notifications for the Google Play and iOS builds, through FCM (the sideload
// build keeps its own background connection instead; see src/distribution.ts).
// On iOS, FCM hands wake-ups to APNs (ios/SuperchatApp/PushModule.m).
//
// Each room has an FCM topic derived from its ID (server/push.Topic computes
// the same). This device subscribes itself to its rooms' topics, so the chat
// server never sees a device token and can't link this device's member IDs
// across rooms. A wake-up carries only the topic: the app fetches the new
// messages from the server and decrypts them itself (store.catchUp), and the
// usual notification code shows them. With the app closed (keys not in
// memory) a plain "New message" shows instead: drawn by the native side on
// Android, and by iOS itself from the push on iPhone.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppState, NativeEventEmitter, NativeModules} from 'react-native';

import {b64, sha256, utf8} from './crypto';
import {catchUp, roomList, subscribe} from './store';

interface PushNative {
  isAvailable(): Promise<boolean>;
  subscribe(topic: string): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
  clearLocked(): void;
}

const Native = NativeModules.Push as PushNative | undefined;
const SUBSCRIBED_KEY = 'superchat.push.topics.v1';
/** Room changes settle before subscriptions are synced. */
const SYNC_DELAY_MS = 1500;

/** A room's FCM topic: "sc-" ‖ b64url(sha256("superchat-topic|" ‖ room)[0:16]). */
export function roomTopic(room: string): string {
  return 'sc-' + b64(sha256(utf8('superchat-topic|' + room)).subarray(0, 16));
}

let started = false;

/** Call once the app is unlocked. Does nothing outside the Google Play build. */
export async function startPush(): Promise<void> {
  if (!Native || started) return;
  started = true;
  // Without Google Play services (say, GrapheneOS without sandboxed Play)
  // there's no FCM, and on iOS this asks for permission to notify, which
  // may be refused: notifications then only come while the app is open.
  if (!(await Native.isAvailable().catch(() => false))) return;
  Native.clearLocked();
  AppState.addEventListener(
    'change',
    s => s === 'active' && Native.clearLocked(),
  );
  new NativeEventEmitter(NativeModules.Push).addListener(
    'PushWake',
    (e: {topic?: string}) => {
      if (e?.topic) onWake(e.topic).catch(() => {});
    },
  );
  subscribe(scheduleSync);
  scheduleSync();
}

async function onWake(topic: string) {
  const room = roomList().find(r => roomTopic(r.id) === topic);
  if (room) await catchUp(room.key);
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncing: Promise<void> = Promise.resolve();

function scheduleSync() {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncing = syncing.then(syncTopics).catch(() => {});
  }, SYNC_DELAY_MS);
}

/** Subscribe to the topics of rooms we're in; unsubscribe from rooms we've left. */
export async function syncTopics(): Promise<void> {
  if (!Native) return;
  const want = new Set(roomList().map(r => roomTopic(r.id)));
  let have: string[] = [];
  try {
    have = JSON.parse((await AsyncStorage.getItem(SUBSCRIBED_KEY)) ?? '[]');
  } catch {}
  const now = new Set(have);
  for (const t of want) {
    if (now.has(t)) continue;
    try {
      await Native.subscribe(t);
      now.add(t);
    } catch {
      // offline or Play services busy: the next sync retries
    }
  }
  for (const t of have) {
    if (want.has(t)) continue;
    try {
      await Native.unsubscribe(t);
      now.delete(t);
    } catch {}
  }
  await AsyncStorage.setItem(SUBSCRIBED_KEY, JSON.stringify([...now])).catch(
    () => {},
  );
}
