// Android: a voice room as a self-managed Telecom call, with its own
// foreground service and call-style notification
// (android/.../VoiceCallService.kt). Telecom owns call audio (communication
// mode, Bluetooth/wired/earpiece/speaker routing, audio focus); if it can't
// take the call, rtc.ts falls back to routing audio itself.
import {NativeEventEmitter, NativeModules, Platform} from 'react-native';

interface VoiceCallNative {
  start(title: string, status: string): Promise<boolean>;
  update(title: string, status: string, muted: boolean, deafened: boolean, live: boolean): void;
  setSpeaker(on: boolean): void;
  stop(): void;
}

export type CallEvent =
  | {type: 'action'; value: 'mute' | 'deafen' | 'leave'}
  | {type: 'route'; value: 'speaker' | 'earpiece' | 'headset'}
  | {type: 'muted'; value: 'true' | 'false'}
  | {type: 'telecom'; value: 'ready' | 'unavailable'}
  | {type: 'failed'; value: string};

const native: VoiceCallNative | undefined =
  Platform.OS === 'android' ? NativeModules.VoiceCall : undefined;

const emitter = native ? new NativeEventEmitter(NativeModules.VoiceCall) : null;

export const androidCall = {
  available: !!native,
  start: (title: string, status: string) => native!.start(title, status),
  update: (title: string, status: string, muted: boolean, deafened: boolean, live: boolean) =>
    native?.update(title, status, muted, deafened, live),
  setSpeaker: (on: boolean) => native?.setSpeaker(on),
  stop: () => native?.stop(),
  on(l: (e: CallEvent) => void): () => void {
    const sub = emitter?.addListener('VoiceCall', l as (e: unknown) => void);
    return () => sub?.remove();
  },
};
