// The app's one voice engine (call/engine.ts), wired to the store, this
// platform's WebRTC (rtc.ts / rtc.web.ts) and settings.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useSyncExternalStore} from 'react';

import {b64, fingerprint, randomBytes} from '../crypto';
import {rtcPlatform} from '../rtc';
import {settingsStore} from '../settings';
import {
  getRoom,
  isServerOnline,
  onRtc,
  onServerReady,
  postCallNotice,
  roomsReady,
  sendRtc,
  subscribe,
  voicePresence,
  type VoicePresence,
} from '../store';
import {createVoiceEngine, MAX_PEERS, type VoiceView} from './engine';
import {
  setVoiceActionHandler,
  VOICE_ACTIONS,
  voiceService,
} from './voiceService';

export const voice = createVoiceEngine({
  unsupported: () => rtcPlatform.unsupported(),
  micPermission: () => rtcPlatform.micPermission(),
  getMic: () => rtcPlatform.getMic() as any,
  createPC: cfg => rtcPlatform.createPC(cfg) as any,
  startAudio: onRoute => rtcPlatform.startAudio(onRoute),
  setSpeaker: on => rtcPlatform.setSpeaker(on),
  send: sendRtc,
  settings: () => settingsStore.get(),
  nameOf: (key, member) => {
    const r = getRoom(key);
    if (!member) return r?.view?.name ?? '';
    return r?.view?.names[member] || fingerprint(member);
  },
  roomExists: key => !!getRoom(key),
  serverOnline: key => {
    const r = getRoom(key);
    return r ? isServerOnline(r.server) : true;
  },
  serverOf: key => getRoom(key)?.server ?? null,
  onRtc: l => onRtc((room, from, s) => l(room.key, from, s)),
  onServerReady,
  onStoreChange: subscribe,
  presenceCount: key => voicePresence(key).length,
  service: voiceService,
  onSession: (key, action) => callNotice(key, action),
  randomId: () => b64(randomBytes(9)),
  now: () => Date.now(),
});

// "Alice joined the call" / "left the call" lines in the chat. Which room's
// call this device is in is remembered until its leave is posted, so a leave
// that never went out (the app was killed mid-call, or offline as it left)
// goes out the next time that room's server is reachable.
const OPEN_CALL_KEY = 'superchat.openCall.v1';

function callNotice(key: string, action: 'join' | 'leave') {
  if (action === 'join') AsyncStorage.setItem(OPEN_CALL_KEY, key).catch(() => {});
  postCallNotice(key, action)
    .then(() => (action === 'leave' ? settleOpenCall(key) : undefined))
    .catch(() => {});
}

/** The leave for `key` is out: forget it, unless this device is back in that call. */
async function settleOpenCall(key: string) {
  const v = voice.getView();
  if (v.roomKey === key && v.phase !== 'idle') return;
  if ((await AsyncStorage.getItem(OPEN_CALL_KEY)) === key) await AsyncStorage.removeItem(OPEN_CALL_KEY);
}

onServerReady(async server => {
  const key = await AsyncStorage.getItem(OPEN_CALL_KEY).catch(() => null);
  if (!key) return;
  const v = voice.getView();
  if (v.roomKey === key && v.phase !== 'idle') return; // still in it
  const r = getRoom(key);
  if (!r) {
    // Left the room since: nobody to tell.
    if (roomsReady()) AsyncStorage.removeItem(OPEN_CALL_KEY).catch(() => {});
    return;
  }
  if (r.server !== server) return;
  await postCallNotice(key, 'leave')
    .then(() => settleOpenCall(key))
    .catch(() => {});
});

setVoiceActionHandler(id => {
  const v = voice.getView();
  if (id === VOICE_ACTIONS.mute) voice.setMuted(!v.muted);
  else if (id === VOICE_ACTIONS.deafen) voice.setDeafened(!v.deafened);
  else if (id === VOICE_ACTIONS.leave) voice.leave().catch(() => {});
});

export function useVoice(): VoiceView {
  return useSyncExternalStore(voice.subscribe, voice.getView, voice.getView);
}

/** Everyone in a room's voice, counting this device when it's in it. */
export function roomVoice(key: string): {
  others: VoicePresence[];
  count: number;
  mine: boolean;
  full: boolean;
} {
  const v = voice.getView();
  const mine = v.roomKey === key && v.phase !== 'idle';
  const others = voicePresence(key);
  const count = others.length + (mine ? 1 : 0);
  return {others, count, mine, full: !mine && count >= MAX_PEERS + 1};
}

voice.start();

// Browsers: a tab coming back (mobile browsers suspend background tabs), and
// the device's own network going away.
if (
  typeof document !== 'undefined' &&
  typeof window !== 'undefined' &&
  typeof window.addEventListener === 'function'
) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') voice.resume();
  });
  window.addEventListener('online', () => voice.setUnstable(false));
  window.addEventListener('offline', () => voice.setUnstable(true));
}
