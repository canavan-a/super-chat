// A light tap of feedback for long-presses and reactions. Android only: the
// browser's vibration is no substitute, so the web build skips it.
import {Platform, Vibration} from 'react-native';

/** A short tick: something just happened under your finger. */
export function tick(): void {
  if (Platform.OS === 'android') Vibration.vibrate(12);
}
