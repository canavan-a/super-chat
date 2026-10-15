// Browsers have no foreground services; see voiceService.ts for Android.
import type {VoiceView} from './engine';

export const voiceService = {
  update(_view: VoiceView, _roomName: string) {},
  stop() {},
};

export const VOICE_ACTIONS = {
  mute: 'voice-mute',
  deafen: 'voice-deafen',
  leave: 'voice-leave',
} as const;
export function handleVoiceAction(_id: string | undefined): boolean {
  return false;
}
export function setVoiceActionHandler(_h: (id: string) => void) {}
