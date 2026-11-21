// A voice message's waveform: loudness sampled while recording, boiled down
// to a few dozen bars that travel inside the (encrypted) message, so the
// bubble draws its shape without downloading the audio.

/** Bars a voice message's waveform is drawn with. */
export const WAVE_BARS = 40;
/** Bar heights run 0..WAVE_MAX. */
export const WAVE_MAX = 15;
/** Longest voice message, in seconds: it stops (and sends) there. */
export const VOICE_SECONDS = 300;

/** A meter reading in dBFS (≤ 0, as both native recorders report) to 0–1. */
export function dbToLevel(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db + 50) / 50));
}

/** Levels (0–1) sampled through the recording, as WAVE_BARS bars of 0..WAVE_MAX. */
export function toBars(levels: number[], bars = WAVE_BARS): number[] {
  if (!levels.length) return Array(bars).fill(0);
  const out: number[] = [];
  for (let b = 0; b < bars; b++) {
    const from = Math.floor((b * levels.length) / bars);
    const to = Math.max(from + 1, Math.floor(((b + 1) * levels.length) / bars));
    let peak = 0;
    for (let i = from; i < to && i < levels.length; i++) peak = Math.max(peak, levels[i]);
    out.push(Math.round(Math.max(0, Math.min(1, peak)) * WAVE_MAX));
  }
  return out;
}

/** Bars from a message, safe against anything odd in it: always WAVE_BARS of 0..WAVE_MAX. */
export function barsOf(wave: unknown): number[] {
  if (!Array.isArray(wave) || !wave.length) return Array(WAVE_BARS).fill(3);
  const nums = wave.map(n => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(WAVE_MAX, n)) : 0));
  return nums.length === WAVE_BARS ? nums : toBars(nums.map(n => n / WAVE_MAX));
}

/** 75 → "1:15". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
