// Lets go of the native launch splash (Android: the launcher icon shown from
// the first frame, MainActivity.kt / LaunchSplashModule.kt) once JS has drawn
// something to take over from. Native gives up by itself after 5 s anyway.
// iOS's launch screen and the web's are handled by their platforms: no-op.
import {NativeModules} from 'react-native';

let hidden = false;

export function hideLaunchSplash(): void {
  if (hidden) return;
  hidden = true;
  try {
    (NativeModules.LaunchSplash as {hide?: () => void} | undefined)?.hide?.();
  } catch {
    // no native module: nothing to hide
  }
}

/** For tests. */
export function resetLaunchSplashForTests(): void {
  hidden = false;
}
