// What the UI's "Voice" buttons do: open the room's voice, joining it if
// needed. One voice room per device: joining another room's asks first,
// then leaves the current one before joining.
import {platformConfirm} from '../platformConfirm';
import type {Route} from '../routes';
import {getRoom} from '../store';
import {roomVoice, voice} from './voice';

export function openVoice(roomKey: string, navigate: (r: Route) => void) {
  const v = voice.getView();
  if (v.roomKey === roomKey && v.phase !== 'idle') {
    navigate({name: 'voice', key: roomKey});
    return;
  }
  if (roomVoice(roomKey).full) {
    navigate({name: 'voice', key: roomKey}); // shows who's in it, and that it's full
    return;
  }
  const go = () => {
    voice.clearError();
    navigate({name: 'voice', key: roomKey});
    voice.switchTo(roomKey).catch(() => {});
  };
  if (v.roomKey && v.phase !== 'idle') {
    const from = getRoom(v.roomKey)?.view?.name ?? 'another room';
    const to = getRoom(roomKey)?.view?.name ?? 'this room';
    platformConfirm(
      'Switch voice room?',
      `Leave voice in ${from} and join ${to}?`,
      'Switch',
      go,
      false,
    );
    return;
  }
  go();
}
