// Turns getStats() snapshots of one peer's incoming audio into the speaking
// level and the connection quality its tile shows. Pure, so it's tested
// without WebRTC.

export interface InboundSample {
  /** ms */
  t: number;
  packetsReceived: number;
  packetsLost: number;
  /** seconds */
  jitter: number;
  /** 0..1 */
  audioLevel: number;
}

export type Quality = 'good' | 'weak' | 'stalled';

export interface QualityState {
  last: InboundSample | null;
  /** When packets last arrived. */
  lastFlowAt: number;
  /** When loss/jitter first went bad, or 0. */
  badSince: number;
  quality: Quality;
  level: number;
}

export const STALL_MS = 2000;
export const WEAK_MS = 3000;
export const WEAK_LOSS = 0.1;
export const WEAK_JITTER_S = 0.1;

export const initialQuality = (now: number): QualityState => ({
  last: null,
  lastFlowAt: now,
  badSince: 0,
  quality: 'good',
  level: 0,
});

export function nextQuality(
  prev: QualityState,
  s: InboundSample,
): QualityState {
  const last = prev.last;
  let lastFlowAt = prev.lastFlowAt;
  let badSince = prev.badSince;
  let bad = s.jitter > WEAK_JITTER_S;
  if (last) {
    const got = s.packetsReceived - last.packetsReceived;
    const lost = Math.max(0, s.packetsLost - last.packetsLost);
    if (got > 0) lastFlowAt = s.t;
    if (got + lost > 0 && lost / (got + lost) > WEAK_LOSS) bad = true;
  } else if (s.packetsReceived > 0) {
    lastFlowAt = s.t;
  }
  badSince = bad ? badSince || s.t : 0;
  const quality: Quality =
    s.t - lastFlowAt >= STALL_MS
      ? 'stalled'
      : badSince && s.t - badSince >= WEAK_MS
      ? 'weak'
      : 'good';
  // A little smoothing so the ring doesn't flicker; it rises faster than it falls.
  const level =
    s.audioLevel > prev.level
      ? s.audioLevel
      : prev.level * 0.6 + s.audioLevel * 0.4;
  return {last: s, lastFlowAt, badSince, quality, level};
}

/** Pulls our numbers out of an RTCStatsReport (or anything iterable like one). */
export function inboundFromStats(
  report: any,
  now: number,
): InboundSample | null {
  let found: InboundSample | null = null;
  const each = (st: any) => {
    if (
      st?.type === 'inbound-rtp' &&
      (st.kind === 'audio' || st.mediaType === 'audio')
    ) {
      found = {
        t: now,
        packetsReceived: st.packetsReceived ?? 0,
        packetsLost: st.packetsLost ?? 0,
        jitter: st.jitter ?? 0,
        audioLevel: st.audioLevel ?? 0,
      };
    }
  };
  if (report && typeof report.forEach === 'function') report.forEach(each);
  else if (report) Object.values(report).forEach(each);
  return found;
}

/** Our own microphone level, from the outgoing side of any peer connection. */
export function localLevelFromStats(report: any): number | null {
  let level: number | null = null;
  const each = (st: any) => {
    if (
      st?.type === 'media-source' &&
      st.kind === 'audio' &&
      typeof st.audioLevel === 'number'
    )
      level = st.audioLevel;
  };
  if (report && typeof report.forEach === 'function') report.forEach(each);
  else if (report) Object.values(report).forEach(each);
  return level;
}

/** Candidate types we gathered, for diagnose.ts. */
export function localCandidateTypes(report: any): Set<string> {
  const types = new Set<string>();
  const each = (st: any) => {
    if (st?.type === 'local-candidate' && st.candidateType)
      types.add(st.candidateType);
  };
  if (report && typeof report.forEach === 'function') report.forEach(each);
  else if (report) Object.values(report).forEach(each);
  return types;
}
