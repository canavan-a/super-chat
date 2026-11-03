// Android: while in a voice room, its call-style notification ("<chat>",
// with Mute, Sound off and the hang-up button) says how the call is going.
// The call itself (a self-managed Telecom call, in a phoneCall|microphone
// foreground service of its own) starts and stops with the call audio, in
// rtc.ts; this only keeps its notification up to date and hands the
// notification's buttons, and the system's own mute and hang-up (headsets,
// cars, watches), to the voice engine.
import {Platform} from 'react-native';

import {androidCall} from './androidCall';
import {voiceSummary, type VoiceView} from './engine';

export const VOICE_ACTIONS = {
  mute: 'voice-mute',
  deafen: 'voice-deafen',
  leave: 'voice-leave',
  /** The system muted or unmuted the call (not a toggle). */
  muteOn: 'voice-mute-on',
  muteOff: 'voice-mute-off',
} as const;

let handler: ((id: string) => void) | null = null;
/** Set by the voice singleton: what the notification's buttons do. */
export function setVoiceActionHandler(h: (id: string) => void) {
  handler = h;
}

/** Routes a voice action; true if it was one. */
export function handleVoiceAction(id: string | undefined): boolean {
  if (!id || !Object.values(VOICE_ACTIONS).includes(id as any)) return false;
  handler?.(id);
  return true;
}

// Telecom reports its mute state once as the call starts (always off); only
// changes after that are the user's doing.
let sawMuted = false;
androidCall.on(e => {
  if (e.type === 'action') handleVoiceAction(VOICE_ACTIONS[e.value]);
  else if (e.type === 'telecom') sawMuted = false;
  else if (e.type === 'muted') {
    if (sawMuted) {
      handleVoiceAction(e.value === 'true' ? VOICE_ACTIONS.muteOn : VOICE_ACTIONS.muteOff);
    }
    sawMuted = true;
  }
});

let shown: string | null = null;

export const voiceService = {
  update(view: VoiceView, roomName: string) {
    if (Platform.OS !== 'android') return;
    const live = view.phase === 'live';
    const status = live
      ? `${voiceSummary(view.peers.length, true)}${view.muted ? ' · Muted' : ''}${
          view.deafened ? ' · Sound off' : ''
        }`
      : view.signalingDown
      ? 'Reconnecting…'
      : 'Connecting…';
    const title = roomName || 'Super Chat';
    const key = [title, status, view.muted, view.deafened, live].join('|');
    if (key === shown) return;
    shown = key;
    androidCall.update(title, status, view.muted, view.deafened, live);
  },
  /** The call itself ends with its audio (rtc.ts). */
  stop() {
    shown = null;
  },
};
