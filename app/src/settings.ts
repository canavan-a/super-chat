import AsyncStorage from '@react-native-async-storage/async-storage';

import {DEFAULT_ICE_SERVERS, type IceServerEntry} from './call/iceConfig';

// Everyone's default server. Anyone can run their own and add it in
// Settings → Servers; rooms remember which server they live on.
export const DEFAULT_SERVER = 'https://chat.superbadger.io';

const STORAGE_KEY = 'superchat.settings.v1';

/** The quick reactions: the long-press menu, and the choices for double-tap. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

export interface Settings {
  // Where new rooms are created. Joining follows the invite link's server.
  defaultServer: string;
  // Every server this device has rooms on (or was told about in Settings).
  servers: string[];
  // Suggested display name for new rooms and joins; each room keeps its own.
  displayName: string;
  // See src/theme.tsx for the palettes.
  themeName: 'light' | 'dark' | 'slate' | 'sepia' | 'ember';
  // Android-only: a foreground service keeps each server's WebSocket open so
  // new messages notify while the app is in the background. Opt-in, since
  // it's a real foreground service with a persistent notification.
  bgNotifications: boolean;
  // Show the sender and decrypted text in notifications. Off shows only the
  // room name and "New message". The lock screen hides it either way (the
  // channel is private).
  notifPreviews: boolean;
  // One-time switch of notifPreviews to on for installs from before it was
  // the default.
  previewsDefaultOn: boolean;
  // Minutes in the background before the app asks for biometrics again.
  // 0 = every time it's reopened.
  lockAfterMin: number;
  // Android-only: switch the launcher icon to the one matching the current
  // theme (see src/appIcon.ts).
  themedIcon: boolean;
  // Play the animated launch splash.
  launchSplash: boolean;
  // Crash-loop protection for the splash: a launch counts as a strike before
  // the animation starts and is cleared when it finishes. After
  // MAX_SPLASH_STRIKES in a row the splash turns itself off.
  splashStrikes: number;
  splashAutoDisabled: boolean;
  // The room last open, reopened on launch.
  lastRoom: string | null;
  // What double-tapping a message reacts with (one of QUICK_REACTIONS).
  doubleTapReaction: string;
  // Voice: STUN/TURN servers this device uses (Settings → Voice). Kept on
  // this device only: never synced in the vault or sent to anyone. TURN
  // passwords only grant relay use; voice media is encrypted end to end.
  iceServers: IceServerEntry[];
  // Send all voice through a TURN relay, so peers never see this device's IP.
  relayOnlyVoice: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  defaultServer: DEFAULT_SERVER,
  servers: [DEFAULT_SERVER],
  displayName: '',
  themeName: 'dark',
  bgNotifications: false,
  notifPreviews: true,
  previewsDefaultOn: true,
  doubleTapReaction: '❤️',
  lockAfterMin: 1,
  themedIcon: true,
  launchSplash: true,
  splashStrikes: 0,
  splashAutoDisabled: false,
  lastRoom: null,
  iceServers: DEFAULT_ICE_SERVERS,
  relayOnlyVoice: false,
};

type Listener = (settings: Settings) => void;

let current: Settings = DEFAULT_SETTINGS;
let loaded = false;
const listeners = new Set<Listener>();

async function load(): Promise<Settings> {
  if (loaded) {
    return current;
  }
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      current = {...DEFAULT_SETTINGS, ...saved};
      if (!saved.previewsDefaultOn) current = {...current, notifPreviews: true, previewsDefaultOn: true};
    }
  } catch {
    // fall back to defaults — a corrupt/missing value shouldn't crash startup
  }
  loaded = true;
  return current;
}

async function save(next: Settings): Promise<void> {
  current = next;
  listeners.forEach(l => l(current));
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort persistence; the in-memory value above is still updated
  }
}

async function update(patch: Partial<Settings>): Promise<void> {
  await save({...current, ...patch});
}

export const settingsStore = {
  get: (): Settings => current,
  load,
  save,
  update,
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function normalizeServer(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//.test(u)) u = `https://${u}`;
  return u;
}
