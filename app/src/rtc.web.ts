// WebRTC in the browser (see rtc.ts for the Android app). Remote audio is
// played by src/call/RemoteAudio.web.tsx, which also applies the chosen
// output device.
export type AudioRoute = 'speaker' | 'earpiece' | 'headset';

const md = () =>
  typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;

export const rtcPlatform = {
  unsupported(): string | null {
    if (
      typeof window === 'undefined' ||
      typeof RTCPeerConnection === 'undefined'
    ) {
      return "This browser doesn't support voice (WebRTC).";
    }
    if (!window.isSecureContext || !md()?.getUserMedia) {
      return 'Voice needs a secure (https) connection to use the microphone.';
    }
    return null;
  },

  // The browser asks for the microphone itself, in getUserMedia.
  async micPermission(): Promise<boolean> {
    return true;
  },

  getMic(): Promise<MediaStream> {
    return md()!.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  },

  createPC(config: RTCConfiguration): RTCPeerConnection {
    return new RTCPeerConnection(config);
  },

  // Browsers can't pick the earpiece; desktop browsers can pick an output.
  hasSpeakerToggle: false,
  get hasOutputPicker(): boolean {
    const isMobile =
      typeof navigator !== 'undefined' &&
      /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    return (
      !isMobile &&
      (typeof (md() as any)?.selectAudioOutput === 'function' ||
        (typeof HTMLMediaElement !== 'undefined' &&
          'setSinkId' in HTMLMediaElement.prototype))
    );
  },

  startAudio(_onRoute: (route: AudioRoute) => void): () => void {
    let lock: any = null;
    (navigator as any).wakeLock
      ?.request('screen')
      .then((l: any) => (lock = l))
      .catch(() => {});
    return () => {
      lock?.release?.().catch?.(() => {});
    };
  },

  setSpeaker(_on: boolean) {},

  /** The browser's own output chooser, where it has one. */
  async pickOutput(): Promise<string | null> {
    const select = (md() as any)?.selectAudioOutput;
    if (typeof select !== 'function') return null;
    try {
      const d = await select.call(md());
      return d?.deviceId ?? null;
    } catch {
      return null;
    }
  },

  async listOutputs(): Promise<{id: string; label: string}[]> {
    try {
      const all = await md()!.enumerateDevices();
      return all
        .filter(d => d.kind === 'audiooutput')
        .map((d, i) => ({
          id: d.deviceId,
          label:
            d.label ||
            (d.deviceId === 'default' ? 'Default' : `Output ${i + 1}`),
        }));
    } catch {
      return [];
    }
  },
};
