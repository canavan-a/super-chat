// The short sounds in a voice call, all sine notes from the same synth:
//   join      "rising trio": three quick notes climbing (D5 G5 D6)
//   leave     the same trio falling
//   lost      one note gliding down an octave: someone's connection dropped
//   back      two bright notes climbing (G5 D6): they reconnected after "lost"
//   thinking  four quiet quick notes, repeated while someone is reconnecting
//             or slow to connect (the engine repeats it, see call/engine.ts)
// Made here as a small WAV, so there are no sound files to bundle or license,
// and played natively (CallCueModule on Android and iOS) through the call's
// own audio, so it follows the speaker/earpiece/headset the call is on and
// never interrupts it.
import {base64} from '@scure/base';
import {NativeModules, Platform} from 'react-native';

export type Cue = 'join' | 'leave' | 'lost' | 'back' | 'thinking';

const RATE = 22050;
const ATTACK = 0.005;

interface Note {
  /** MIDI note. */
  m: number;
  /** Start, seconds. */
  t: number;
  /** Length, seconds. */
  d: number;
  gain: number;
  /** Semitones the pitch slides by over the note. */
  glide?: number;
}

const TRIO = [74, 79, 86]; // D5, G5, D6
const trio = (ms: number[]): Note[] =>
  ms.map((m, i) => ({m, t: i * 0.06, d: 0.18, gain: 0.3}));

const CUES: Record<Cue, Note[]> = {
  join: trio(TRIO),
  leave: trio([...TRIO].reverse()),
  lost: [{m: 86, t: 0, d: 0.45, gain: 0.22, glide: -12}],
  back: [
    {m: 79, t: 0, d: 0.12, gain: 0.25},
    {m: 86, t: 0.07, d: 0.3, gain: 0.25},
  ],
  thinking: [74, 79, 74, 79].map((m, i) => ({m, t: i * 0.12, d: 0.14, gain: 0.14})),
};

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** The cue as 16-bit mono PCM samples. */
export function cueSamples(cue: Cue): Int16Array {
  const notes = CUES[cue];
  const end = Math.max(...notes.map(n => n.t + n.d));
  const len = Math.ceil((end + 0.02) * RATE);
  const mix = new Float32Array(len);
  for (const n of notes) {
    const start = Math.round(n.t * RATE);
    let phase = 0;
    for (let j = 0; j < n.d * RATE && start + j < len; j++) {
      const t = j / RATE;
      phase += (2 * Math.PI * hz(n.m + (n.glide ?? 0) * (t / n.d))) / RATE;
      // Quick linear attack, then an exponential fade to silence.
      const env =
        t < ATTACK
          ? (t / ATTACK) * n.gain
          : n.gain * (0.0001 / n.gain) ** ((t - ATTACK) / (n.d - ATTACK));
      mix[start + j] += Math.sin(phase) * env;
    }
  }
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
