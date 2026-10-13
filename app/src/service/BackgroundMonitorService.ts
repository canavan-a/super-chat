// Keeps the app's own WebSockets (src/store.ts) alive while it's in the
// background, as an Android foreground service, the same way super-badger
// keeps its notification feed open. There's no FCM and no push server: the
// phone holds an authenticated, end-to-end encrypted connection to each of
// your servers and decrypts new messages locally.
//
// Only ever imported from native-only code paths: index.js (registers the
// foreground-service task) and dynamic import() from App.tsx/SettingsScreen.
import notifee, {AndroidForegroundServiceType} from '@notifee/react-native';

import {notificationColor, notifyMessage} from '../notifications/messages';
import {CH_SERVICE, ensureChannels, NID_FGS, PREFER_SMALL_ICON, PRESS_ACTION} from '../notifications/channels';
import {session} from '../session';
import {settingsStore} from '../settings';
import {connect, onIncoming} from '../store';

let unsubscribe: (() => void) | null = null;

function watch() {
  unsubscribe?.();
  unsubscribe = onIncoming((room, msg) => {
    notifyMessage(room, msg).catch(err => console.warn('[superchat] notify failed', err));
  });
  if (session.get()) settingsStore.get().servers.forEach(connect);
}

// The function Notifee's foreground service task runs. Must never resolve:
// Notifee keeps the service alive while this promise is pending and tears it
// down via stopForegroundService (see stopMonitoring).
export function backgroundRunner(): Promise<void> {
  return new Promise(() => {
    void ensureChannels();
    watch();
  });
}

// Must be called from the foreground (Android 12+ won't start a foreground
// service from the background).
export async function startMonitoring(): Promise<void> {
  await ensureChannels();
  watch();
  await notifee.displayNotification({
    id: NID_FGS,
    title: 'Super Chat',
    body: 'Connected. New messages will notify you.',
    data: PREFER_SMALL_ICON,
    android: {
      channelId: CH_SERVICE,
      // Required: Notifee's default is 'ic_launcher', which doesn't exist
      // (launcher icons are per theme), and Android kills the process over
      // an icon-less foreground notification.
      smallIcon: 'ic_notification',
      pressAction: PRESS_ACTION,
      asForegroundService: true,
      color: await notificationColor(),
      foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
      ongoing: true,
      colorized: false,
    },
  });
}

export async function stopMonitoring(): Promise<void> {
  unsubscribe?.();
  unsubscribe = null;
  await notifee.stopForegroundService();
}
