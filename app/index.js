/**
 * @format
 */

// Must come first: noble's randomBytes uses crypto.getRandomValues, which
// Hermes doesn't have until this polyfill installs the native one.
import 'react-native-get-random-values';
import notifee, {EventType} from '@notifee/react-native';
import {AppRegistry} from 'react-native';
import App from './src/App';
import {name as appName} from './app.json';
import {pendingNav} from './src/notifications/pendingNav';
import {backgroundRunner} from './src/service/BackgroundMonitorService';

// Registers the function Notifee's foreground service runs. Must happen at
// module top level, before AppRegistry.registerComponent.
notifee.registerForegroundService(() => backgroundRunner());

// A notification tap while the app is alive but backgrounded: there's no
// mounted React tree here, so the room is stashed in pendingNav for App.tsx.
// (Killed app: notifee.getInitialNotification() in App.tsx. Foreground:
// notifee.onForegroundEvent, also in App.tsx.)
notifee.onBackgroundEvent(async ({type, detail}) => {
  if (type === EventType.PRESS) {
    const key = detail.notification?.data?.roomKey;
    if (typeof key === 'string') pendingNav.set(key);
    if (detail.notification?.id) await notifee.cancelNotification(detail.notification.id);
  }
});

AppRegistry.registerComponent(appName, () => App);
