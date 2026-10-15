// WebRTC for the Android app: react-native-webrtc for the peer connections,
// react-native-incall-manager for audio routing (speaker, earpiece,
// headsets). The web build gets rtc.web.ts instead, on the browser's own
// WebRTC. src/call/engine.ts only talks to what this file exports.
import {DeviceEventEmitter, PermissionsAndroid, Platform} from 'react-native';
import InCallManager from 'react-native-incall-manager';
import {mediaDevices, RTCPeerConnection} from 'react-native-webrtc';

export type AudioRoute = 'speaker' | 'earpiece' | 'headset';

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

  /** Starts a voice audio session (communication mode, Bluetooth, proximity). */
  startAudio(onRoute: (route: AudioRoute) => void): () => void {
    InCallManager.start({media: 'audio', auto: true});
    InCallManager.setKeepScreenOn(true);
    const sub = DeviceEventEmitter.addListener(
      'onAudioDeviceChanged',
      (data: {selectedAudioDevice?: string}) => {
        const d = data?.selectedAudioDevice;
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
  },

  setSpeaker(on: boolean) {
    InCallManager.chooseAudioRoute(on ? 'SPEAKER_PHONE' : 'EARPIECE').catch(
      () => {
        InCallManager.setForceSpeakerphoneOn(on);
      },
    );
  },

  async pickOutput(): Promise<string | null> {
    return null;
  },
  async listOutputs(): Promise<{id: string; label: string}[]> {
    return [];
  },
};
