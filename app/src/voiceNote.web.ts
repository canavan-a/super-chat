// Browser version of voiceNote.ts: MediaRecorder for the audio, an
// AnalyserNode for the loudness. MP4/AAC where the browser can record it
// (Chrome, Edge, Safari), so phones play it; Opus in WebM otherwise (Firefox),
// which iOS can't play.
import type {PickedFile} from './files';
import {toBars} from './voiceWave';

export interface VoiceRecording {
  stop(): Promise<PickedFile | null>;
  cancel(): void;
}

const TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

export async function startVoiceNote(onLevel: (level: number, seconds: number) => void): Promise<VoiceRecording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error("This browser can't record audio.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}});
  } catch {
    throw new Error('Super Chat needs microphone access: allow it for this site.');
  }
  const type = TYPES.find(t => MediaRecorder.isTypeSupported(t)) ?? '';
  const rec = new MediaRecorder(stream, {...(type ? {mimeType: type} : {}), audioBitsPerSecond: 64000});
  const chunks: Blob[] = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);

  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const levels: number[] = [];
  const started = performance.now();
  const seconds = () => (performance.now() - started) / 1000;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    // Same scale as the native meters: dBFS, -50..0 → 0..1.
    const level = peak > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(peak) + 50) / 50)) : 0;
    levels.push(level);
    onLevel(level, seconds());
  }, 100);
  rec.start(250);

  const finish = () =>
    new Promise<void>(res => {
      clearInterval(timer);
      rec.onstop = () => res();
      if (rec.state !== 'inactive') rec.stop();
      else res();
      stream.getTracks().forEach(t => t.stop());
      ctx.close().catch(() => {});
    });

  return {
    async stop() {
      const dur = seconds();
      await finish();
      if (dur < 0.7) return null;
      const mime = (rec.mimeType || type || 'audio/webm').split(';')[0];
      const data = new Uint8Array(await new Blob(chunks, {type: mime}).arrayBuffer());
      const ext = mime.includes('mp4') ? 'm4a' : 'webm';
      return {name: `Voice message.${ext}`, mime, data, dur: Math.round(dur), wave: toBars(levels)};
    },
    cancel() {
      finish();
    },
  };
}
