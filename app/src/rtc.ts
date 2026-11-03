// WebRTC for the native apps: react-native-webrtc for the peer connections.
// Call audio (speaker, earpiece, headsets): on Android, Telecom, through the
// app's self-managed call (call/androidCall.ts); on iOS, and on Android if
// Telecom won't take the call, react-native-incall-manager. The web build
// gets rtc.web.ts instead, on the browser's own WebRTC. src/call/engine.ts
// only talks to what this file exports.
import {DeviceEventEmitter, PermissionsAndroid, Platform} from 'react-native';
import InCallManager from 'react-native-incall-manager';
import {mediaDevices, RTCPeerConnection} from 'react-native-webrtc';

import {androidCall} from './call/androidCall';

export type AudioRoute = 'speaker' | 'earpiece' | 'headset';

/** How setSpeaker reaches the current call's audio. */
let speaker: (on: boolean) => void = inCallManagerSpeaker;

function inCallManagerSpeaker(on: boolean) {
  InCallManager.chooseAudioRoute(on ? 'SPEAKER_PHONE' : 'EARPIECE').catch(() => {
    InCallManager.setForceSpeakerphoneOn(on);
  });
}

/** Android: the voice room as a Telecom call; InCallManager if Telecom says no. */
function telecomAudio(onRoute: (route: AudioRoute) => void, title: string): () => void {
  let fallback: (() => void) | null = null;
  const fallBack = () => {
    if (fallback) return;
    speaker = inCallManagerSpeaker;
    fallback = inCallManagerAudio(onRoute);
  };
  const off = androidCall.on(e => {
    if (e.type === 'route') onRoute(e.value);
    else if (e.type === 'telecom') {
      if (e.value === 'ready') speaker = on => androidCall.setSpeaker(on);
      else fallBack();
    } else if (e.type === 'failed') fallBack();
  });
  androidCall.start(title, 'Connecting…').catch(fallBack);
  return () => {
    off();
    fallback?.();
    speaker = inCallManagerSpeaker;
    androidCall.stop();
  };
}

/** A voice audio session run by the app itself (communication mode, Bluetooth, proximity). */
function inCallManagerAudio(onRoute: (route: AudioRoute) => void): () => void {
  // 'video' only makes the loudspeaker the default instead of the earpiece
  // (right for a voice room). Headsets still win: Bluetooth, then wired,
  // then the default. Never pick a route here: a picked route is treated
  // as the user's choice and overrides headsets.
  InCallManager.start({media: 'video', auto: true});
  InCallManager.setKeepScreenOn(true);
  // Headsets seen so far, so a new one is switched to once, not forced
  // again and again (say, if Bluetooth audio fails to connect).
  const seen = new Set<string>();
  const sub = DeviceEventEmitter.addListener(
    'onAudioDeviceChanged',
    (data: {selectedAudioDevice?: string; availableAudioDeviceList?: string}) => {
      const d = data?.selectedAudioDevice;
      // A headset just connected while speaker or earpiece was picked by
      // hand: the hand-picked route would otherwise keep winning.
      let available: string[] = [];
      try {
        available = JSON.parse(data?.availableAudioDeviceList ?? '[]');
      } catch {}
      const headset = available.includes('BLUETOOTH')
        ? 'BLUETOOTH'
        : available.includes('WIRED_HEADSET')
        ? 'WIRED_HEADSET'
        : null;
      const appeared = headset !== null && !seen.has(headset);
      for (const a of available) seen.add(a);
      for (const s of [...seen]) if (!available.includes(s)) seen.delete(s);
      if (appeared && d !== 'BLUETOOTH' && d !== 'WIRED_HEADSET') {
        InCallManager.chooseAudioRoute(headset).catch(() => {});
        return;
      }
      onRoute(
        d === 'WIRED_HEADSET' || d === 'BLUETOOTH'
          ? 'headset'
          : d === 'EARPIECE'
          ? 'earpiece'
          : 'speaker',
      );
    },
  );
  return () => {
    sub.remove();
    InCallManager.setKeepScreenOn(false);
    InCallManager.stop();
  };
}

export const rtcPlatform = {
  /** False when the platform can't do voice at all (and why). */
  unsupported(): string | null {
    return null;
  },

  async micPermission(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;
    // Bluetooth (Android 12+) is optional: without it, headsets just aren't
    // offered as an audio route.
    const wanted = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
    if (
      Number(Platform.Version) >= 31 &&
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
    ) {
      wanted.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
    }
    const res = await PermissionsAndroid.requestMultiple(wanted);
    return (
      res[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] ===
      PermissionsAndroid.RESULTS.GRANTED
    );
  },

  getMic(): Promise<MediaStream> {
    return mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    } as any) as unknown as Promise<MediaStream>;
  },

  createPC(config: RTCConfiguration): RTCPeerConnection {
    return new RTCPeerConnection(config as any) as unknown as RTCPeerConnection;
  },

  // ---- audio routing ----

  /** The phone speaker/earpiece toggle exists here; the output picker doesn't. */
  hasSpeakerToggle: true,
  hasOutputPicker: false,

  /** Starts a voice audio session; returns what ends it. */
  startAudio(onRoute: (route: AudioRoute) => void, title = ''): () => void {
    return androidCall.available
      ? telecomAudio(onRoute, title)
      : inCallManagerAudio(onRoute);
  },

  setSpeaker(on: boolean) {
    speaker(on);
  },

  async pickOutput(): Promise<string | null> {
    return null;
  },
  async listOutputs(): Promise<{id: string; label: string}[]> {
    return [];
  },
};
