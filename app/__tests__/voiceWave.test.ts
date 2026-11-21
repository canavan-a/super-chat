import {attachmentLabel, FileRef} from '../src/crypto';
import {barsOf, clock, dbToLevel, toBars, WAVE_BARS, WAVE_MAX} from '../src/voiceWave';

const ref = (mime: string, extra: Partial<FileRef> = {}): FileRef => ({blob: 'b', key: 'k', name: 'x', mime, size: 1, ...extra});

describe('voice waveform', () => {
  it('maps meter dB to 0–1', () => {
    expect(dbToLevel(0)).toBe(1);
    expect(dbToLevel(-25)).toBe(0.5);
    expect(dbToLevel(-160)).toBe(0);
    expect(dbToLevel(NaN)).toBe(0);
  });

  it('boils any number of samples down to WAVE_BARS bars, keeping peaks', () => {
    const bars = toBars(Array.from({length: 403}, (_, i) => (i === 200 ? 1 : 0.2)));
    expect(bars).toHaveLength(WAVE_BARS);
    expect(Math.max(...bars)).toBe(WAVE_MAX);
    expect(bars.filter(b => b === WAVE_MAX)).toHaveLength(1);
    expect(toBars([0.5])).toHaveLength(WAVE_BARS);
    expect(toBars([])).toEqual(Array(WAVE_BARS).fill(0));
  });

  it('reads bars from a message defensively', () => {
    expect(barsOf(undefined)).toHaveLength(WAVE_BARS);
    expect(barsOf('nonsense')).toHaveLength(WAVE_BARS);
    const odd = barsOf([99, -4, 'x', 7]);
    expect(odd).toHaveLength(WAVE_BARS);
    expect(Math.max(...odd)).toBeLessThanOrEqual(WAVE_MAX);
    expect(Math.min(...odd)).toBeGreaterThanOrEqual(0);
  });

  it('formats times', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(75.9)).toBe('1:15');
  });
});

describe('attachmentLabel', () => {
  it('names what a file message holds', () => {
    expect(attachmentLabel([ref('image/jpeg')])).toBe('📷 Photo');
    expect(attachmentLabel([ref('video/mp4')])).toBe('🎥 Video');
    expect(attachmentLabel([ref('image/png'), ref('video/mp4')])).toBe('📷 Photo & video');
    expect(attachmentLabel([ref('audio/mp4', {wave: [1, 2]})])).toBe('🎤 Voice message');
    expect(attachmentLabel([ref('audio/mpeg', {name: 'song.mp3'})])).toBe('📎 song.mp3');
  });
});
