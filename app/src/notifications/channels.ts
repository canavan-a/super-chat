// Notifee channel setup, as in super-badger. Only ever imported from
// native-only code paths (BackgroundMonitorService, index.js, or dynamic
// imports from shared screens), never statically from a file the Vite web
// build bundles.
import notifee, {AndroidImportance, AndroidVisibility} from '@notifee/react-native';

export const CH_SERVICE = 'superchat-fgs';
export const CH_MESSAGES = 'superchat-messages';
export const NID_FGS = 'superchat-connection';

let ensured = false;

export async function ensureChannels(): Promise<void> {
  if (ensured) return;
  ensured = true;
  await notifee.createChannel({id: CH_SERVICE, name: 'Connection', importance: AndroidImportance.LOW});
  await notifee.createChannel({
    id: CH_MESSAGES,
    name: 'Messages',
    importance: AndroidImportance.HIGH,
    // Lock screen shows that something arrived, never what.
    visibility: AndroidVisibility.PRIVATE,
  });
}

// Tap target for every notification. Not Notifee's 'default' launch activity:
// that resolves to whichever launcher alias is enabled (.IconLight, .IconDark,
// … — see AndroidManifest.xml), which isn't a class Notifee can start. Name
// the real activity instead.
export const PRESS_ACTION = {id: 'default', launchActivity: 'com.superchatapp.MainActivity'};

// Spread into every notification's `data`: Notification.EXTRA_PREFER_SMALL_ICON,
// so Android 17+ shows the bubble icon tinted with the notification's color
// rather than the light theme's launcher icon. patches/ lets Notifee pass a
// boolean through.
export const PREFER_SMALL_ICON = {'android.app.preferSmallIcon': true as unknown as string};
