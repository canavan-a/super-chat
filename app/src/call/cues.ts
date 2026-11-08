// The join and leave sounds in a voice call ("rising trio": three quick sine
// notes climbing for a join, falling for a leave). Made here as a small WAV,
// so there are no sound files to bundle or license, and played natively
// (CallCueModule on Android and iOS) through the call's own audio, so it
// follows the speaker/earpiece/headset the call is on and never interrupts it.
import {base64} from '@scure/base';
import {NativeModules, Platform} from 'react-native';

export type Cue = 'join' | 'leave';

const RATE = 22050;
const NOTES = [74, 79, 86]; // D5, G5, D6
const STEP = 0.06; // seconds between notes
const NOTE = 0.18; // each note's length
const GAIN = 0.3;
const ATTACK = 0.005;

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** The cue as 16-bit mono PCM samples. */
export function cueSamples(cue: Cue): Int16Array {
  const notes = cue === 'join' ? NOTES : [...NOTES].reverse();
  const len = Math.ceil((STEP * (notes.length - 1) + NOTE + 0.02) * RATE);
  const mix = new Float32Array(len);
  notes.forEach((n, i) => {
    const start = Math.round(i * STEP * RATE);
    const f = hz(n);
    for (let j = 0; j < NOTE * RATE && start + j < len; j++) {
      const t = j / RATE;
      // Quick linear attack, then an exponential fade to silence.
      const env = t < ATTACK ? (t / ATTACK) * GAIN : GAIN * (0.0001 / GAIN) ** ((t - ATTACK) / (NOTE - ATTACK));
      mix[start + j] += Math.sin(2 * Math.PI * f * t) * env;
    }
  });
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.max(-1, Math.min(1, mix[i])) * 0x7fff;
  return out;
}

/** The cue as a WAV file. */
export function cueWav(cue: Cue): Uint8Array {
  const pcm = cueSamples(cue);
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  pcm.forEach((s, i) => v.setInt16(44 + i * 2, s, true));
  return bytes;
}

const cache = new Map<Cue, string>();
const wavBase64 = (cue: Cue) => {
  let s = cache.get(cue);
  if (!s) cache.set(cue, (s = base64.encode(cueWav(cue))));
  return s;
};

export function playCue(cue: Cue): void {
  try {
    if (Platform.OS === 'web') {
      new Audio(`data:audio/wav;base64,${wavBase64(cue)}`).play().catch(() => {});
    } else {
      NativeModules.CallCue?.play(wavBase64(cue));
    }
  } catch {
    // A missing sound never matters to the call itself.
  }
}
