// Voice rooms: every chat room has one, and this device can be in at most one
// at a time. Audio goes peer to peer over a WebRTC mesh (at most 8 people),
// signaled through the room's WebSocket with sealed, signed boxes (see
// docs/protocol.md, "Voice rooms", and crypto/rtc.ts). Nothing here is
// stored or known to the server.
//
// The engine is created with its dependencies (createVoiceEngine) so tests
// can drive it with fake peer connections; the app uses the `voice`
// singleton at the bottom, wired to the store and the platform's WebRTC.
import type {OpenedSignal, Signal} from '../crypto';
import {diagnose, type Diagnosis, type IceErrorInfo} from './diagnose';
import {
  buildIceConfig,
  iceCoverage,
  type IceCoverage,
  type VoiceIceSettings,
} from './iceConfig';
import {
  inboundFromStats,
  initialQuality,
  localCandidateTypes,
  localLevelFromStats,
  nextQuality,
  type QualityState,
} from './quality';
import {tuneSdp} from './sdp';

export const MAX_PEERS = 7; // so at most 8 people
export const BEAT_MS = 15_000;
export const PRESENCE_MS = 40_000;
export const FIND_MS = 1_500;
export const JOIN_TIMEOUT_MS = 20_000;
export const DISCONNECT_GRACE_MS = 5_000;
export const RESTART_DELAYS_MS = [2_000, 4_000, 8_000];
export const ANSWERER_GIVE_UP_MS = 30_000;
export const STATS_MS = 300;
/** How long a pre-warmed connection is kept without a join. */
export const WARM_MS = 5 * 60_000;

export type AudioRoute = 'speaker' | 'earpiece' | 'headset';

export type Phase =
  | 'idle'
  | 'config' // building the ICE config from this device's servers
  | 'confirm-no-servers' // waiting on the "no STUN/TURN servers" popup
  | 'mic' // asking for / opening the microphone
  | 'finding' // join sent, waiting for here/full replies
  | 'connecting' // peers known, none connected yet
  | 'live'
  | 'leaving';

export type PeerState =
  | 'connecting'
  | 'live'
  | 'weak'
  | 'stalled'
  | 'reconnecting'
  | 'failed';

export interface PeerView {
  id: string;
  member: string;
  sid: string;
  state: PeerState;
  muted: boolean;
  deaf: boolean;
  level: number;
  diagnosis: Diagnosis | null;
}

export type VoiceErrorKind = 'unsupported' | 'mic-denied' | 'full' | 'timeout';

export interface VoiceError {
  kind: VoiceErrorKind;
  message: string;
  diagnosis?: Diagnosis | null;
}

export interface VoiceView {
  roomKey: string | null;
  phase: Phase;
  error: VoiceError | null;
  muted: boolean;
  deafened: boolean;
  speakerOn: boolean;
  route: AudioRoute;
  outputDevice: string | null;
  coverage: IceCoverage | null;
  stunWarningDismissed: boolean;
  /** The room's WebSocket is down: signaling paused, media may continue. */
  signalingDown: boolean;
  /** Every peer is struggling at once: probably our own network. */
  unstable: boolean;
  /** Web: the browser refused to start audio until a tap. */
  audioBlocked: boolean;
  peers: PeerView[];
  localLevel: number;
  /** When this session went live (ms), for the bar's timer. */
  startedAt: number;
  /** A short-lived message, e.g. "Sam dropped". */
  notice: {text: string; at: number} | null;
}

export const IDLE_VIEW: VoiceView = {
  roomKey: null,
  phase: 'idle',
  error: null,
  muted: false,
  deafened: false,
  speakerOn: true,
  route: 'speaker',
  outputDevice: null,
  coverage: null,
  stunWarningDismissed: false,
  signalingDown: false,
  unstable: false,
  audioBlocked: false,
  peers: [],
  localLevel: 0,
  startedAt: 0,
  notice: null,
};

// The slices of WebRTC the engine uses; satisfied by the browser's and
// react-native-webrtc's objects, and by the fakes in tests.
export interface TrackLike {
  enabled: boolean;
  stop(): void;
}
export interface StreamLike {
  getTracks(): TrackLike[];
  getAudioTracks(): TrackLike[];
}
export interface PCLike {
  connectionState: string;
  addTrack(track: any, stream: any): unknown;
  addEventListener(type: string, cb: (ev: any) => void): void;
  createOffer(opts?: any): Promise<{type: string; sdp?: string}>;
  createAnswer(): Promise<{type: string; sdp?: string}>;
  setLocalDescription(d: any): Promise<void>;
  setRemoteDescription(d: any): Promise<void>;
  addIceCandidate(c: any): Promise<void>;
  getStats(): Promise<any>;
  close(): void;
}

export interface VoiceDeps {
  unsupported(): string | null;
  micPermission(): Promise<boolean>;
  getMic(): Promise<StreamLike>;
  createPC(cfg: RTCConfiguration): PCLike;
  startAudio(onRoute: (r: AudioRoute) => void): () => void;
  setSpeaker(on: boolean): void;
  send(roomKey: string, to: string, s: Signal): boolean;
  settings(): VoiceIceSettings;
  nameOf(roomKey: string, member: string): string;
  roomExists(roomKey: string): boolean;
  serverOnline(roomKey: string): boolean;
  serverOf(roomKey: string): string | null;
  onRtc(
    l: (roomKey: string, from: string, s: OpenedSignal) => void,
  ): () => void;
  onServerReady(l: (server: string) => void): () => void;
  onStoreChange(l: () => void): () => void;
  /** How many sessions the room's presence says are in its voice (not counting us). */
  presenceCount(roomKey: string): number;
  /** Android: keeps voice alive in the background (a microphone foreground service). */
  service: {update(view: VoiceView, roomName: string): void; stop(): void};
  /** This device entered (after it told the room) or left a room's voice. */
  onSession?(roomKey: string, action: 'join' | 'leave'): void;
  randomId(): string;
  now(): number;
}

interface Peer {
  id: string;
  member: string;
  sid: string;
  pc: PCLike;
  offerer: boolean;
  remoteSet: boolean;
  pendingIce: unknown[];
  stream: StreamLike | null;
  muted: boolean;
  deaf: boolean;
  conn: string;
  everConnected: boolean;
  restarts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  giveUpTimer: ReturnType<typeof setTimeout> | null;
  lastHeard: number;
  quality: QualityState;
  iceErrors: IceErrorInfo[];
  candidateTypes: Set<string>;
  failed: boolean;
  diagnosis: Diagnosis | null;
}

interface Session {
  roomKey: string;
  sid: string;
  cfg: RTCConfiguration | null;
  coverage: IceCoverage | null;
  stream: StreamLike | null;
  peers: Map<string, Peer>;
  muted: boolean;
  mutedBeforeDeaf: boolean;
  deafened: boolean;
  timers: ReturnType<typeof setTimeout>[];
  intervals: ReturnType<typeof setInterval>[];
  stopAudio: (() => void) | null;
  gotReplies: boolean;
  /** Cleared on leave, so async steps of an abandoned join stop. */
  alive: boolean;
  /** We broadcast join (so leaving must broadcast leave). */
  joined: boolean;
}

export function createVoiceEngine(deps: VoiceDeps) {
  let session: Session | null = null;
  let view: VoiceView = IDLE_VIEW;
  const listeners = new Set<() => void>();
  let unsubs: (() => void)[] = [];

  const sinceLive = {at: 0};

  function notify() {
    view = buildView();
    listeners.forEach(l => l());
    // The Android voice notification is a microphone-type foreground
    // service, which Android 14+ refuses (killing the app) unless the mic
    // permission is already granted: only once the mic is actually open.
    const ph = view.phase;
    if (
      session?.stream &&
      (ph === 'finding' || ph === 'connecting' || ph === 'live')
    ) {
      deps.service.update(view, roomName());
    }
  }

  function roomName() {
    return session ? deps.nameOf(session.roomKey, '') : '';
  }

  // ---- the view ----

  let extra: Partial<VoiceView> = {};

  function peerState(p: Peer): PeerState {
    if (p.failed) return 'failed';
    if (p.conn === 'disconnected' || (p.conn === 'failed' && p.everConnected))
      return 'reconnecting';
    if (p.conn === 'failed') return 'connecting';
    if (p.conn !== 'connected')
      return p.everConnected ? 'reconnecting' : 'connecting';
    return p.quality.quality === 'stalled'
      ? 'stalled'
      : p.quality.quality === 'weak'
      ? 'weak'
      : 'live';
  }

  function buildView(): VoiceView {
    if (!session)
      return {
        ...IDLE_VIEW,
        notice: extra.notice ?? null,
        error: extra.error ?? null,
      };
    const peers: PeerView[] = [...session.peers.values()].map(p => ({
      id: p.id,
      member: p.member,
      sid: p.sid,
      state: peerState(p),
      muted: p.muted,
      deaf: p.deaf,
      level: p.quality.level,
      diagnosis: p.diagnosis,
    }));
    const struggling = peers.filter(
      p => p.state === 'reconnecting' || p.state === 'stalled',
    );
    return {
      ...IDLE_VIEW,
      ...extra,
      roomKey: session.roomKey,
      muted: session.muted,
      deafened: session.deafened,
      coverage: session.coverage,
      signalingDown: !deps.serverOnline(session.roomKey),
      unstable:
        (peers.length > 0 && struggling.length === peers.length) ||
        !!extra.unstable,
      peers,
      startedAt: sinceLive.at,
    };
  }

  function setExtra(patch: Partial<VoiceView>) {
    extra = {...extra, ...patch};
    notify();
  }

  function flash(text: string) {
    setExtra({notice: {text, at: deps.now()}});
  }

  // ---- signaling ----

  function send(to: string, s: Omit<Signal, 'sid'>) {
    if (!session) return false;
    return deps.send(session.roomKey, to, {...s, sid: session.sid} as Signal);
  }

  function beat(to = '', toSid?: string) {
    if (!session) return;
    send(to, {
      k: 'beat',
      muted: session.muted,
      deaf: session.deafened,
      ...(toSid ? {to_sid: toSid} : {}),
    });
  }

  function onSignal(roomKey: string, from: string, s: OpenedSignal) {
    const ses = session;
    if (!ses || roomKey !== ses.roomKey || phaseNow() === 'leaving') return;
    if (s.k === 'probe') {
      if (inVoice()) beat(from, s.sid);
      return;
    }
    if (s.to_sid && s.to_sid !== ses.sid) return;
    if (s.sid === ses.sid) return;
    const id = `${from}:${s.sid}`;
    const peer = ses.peers.get(id);
    if (peer) peer.lastHeard = deps.now();
    switch (s.k) {
      case 'join':
        if (!inVoice()) return;
        if (peer) {
          // They reconnected to the server with the same session.
          if (peer.offerer && peer.conn !== 'connected') restartNow(peer);
          beat(from, s.sid);
          return;
        }
        if (ses.peers.size >= MAX_PEERS) {
          send(from, {k: 'full', to_sid: s.sid});
          return;
        }
        send(from, {
          k: 'here',
          to_sid: s.sid,
          muted: ses.muted,
          deaf: ses.deafened,
        });
        makeOffer(addPeer(from, s.sid, true, s), false).catch(() => {});
        return;
      case 'here':
        ses.gotReplies = true;
        if (!peer && ses.peers.size < MAX_PEERS) addPeer(from, s.sid, false, s);
        if (phaseNow() === 'finding') setPhase('connecting');
        notify();
        return;
      case 'full':
        if (phaseNow() === 'finding' || phaseNow() === 'connecting') {
          const n = MAX_PEERS + 1;
          endSession({kind: 'full', message: `Voice room is full (${n}/${n})`});
        }
        return;
      case 'offer': {
        let p = peer;
        if (!p) {
          if (ses.peers.size >= MAX_PEERS) {
            send(from, {k: 'full', to_sid: s.sid});
            return;
          }
          p = addPeer(from, s.sid, false, s);
        }
        answer(p, s.sdp ?? '').catch(() => {});
        return;
      }
      case 'answer':
        if (peer?.offerer && s.sdp) {
          peer.pc
            .setRemoteDescription({type: 'answer', sdp: s.sdp})
            .then(() => {
              peer.remoteSet = true;
              flushIce(peer);
            })
            .catch(() => {});
        }
        return;
      case 'ice':
        if (!peer || !s.cand) return;
        if (peer.remoteSet) peer.pc.addIceCandidate(s.cand).catch(() => {});
        else peer.pendingIce.push(s.cand);
        return;
      case 'beat':
        if (peer) {
          peer.muted = !!s.muted;
          peer.deaf = !!s.deaf;
          notify();
        }
        return;
      case 'leave':
        if (peer) {
          dropPeer(peer);
          notify();
        }
        return;
    }
  }

  // ---- peers ----

  function addPeer(
    member: string,
    sid: string,
    offerer: boolean,
    s?: Partial<Signal>,
  ): Peer {
    const ses = session!;
    const pc = takeWarm(ses.roomKey, ses.cfg) ?? deps.createPC(ses.cfg ?? {});
    // Keep one gathered connection ready for whoever joins next.
    if (ses.peers.size + 1 < MAX_PEERS) refillWarm(ses.roomKey, 1);
    const p: Peer = {
      id: `${member}:${sid}`,
      member,
      sid,
      pc,
      offerer,
      remoteSet: false,
      pendingIce: [],
      stream: null,
      muted: !!s?.muted,
      deaf: !!s?.deaf,
      conn: 'new',
      everConnected: false,
      restarts: 0,
      restartTimer: null,
      graceTimer: null,
      giveUpTimer: null,
      lastHeard: deps.now(),
      quality: initialQuality(deps.now()),
      iceErrors: [],
      candidateTypes: new Set(),
      failed: false,
      diagnosis: null,
    };
    ses.peers.set(p.id, p);
    ses.stream?.getTracks().forEach(t => pc.addTrack(t, ses.stream));
    pc.addEventListener('icecandidate', (ev: any) => {
      const c = ev?.candidate;
      if (!c) return;
      if (c.type) p.candidateTypes.add(c.type);
      send(member, {
        k: 'ice',
        to_sid: sid,
        cand: typeof c.toJSON === 'function' ? c.toJSON() : c,
      });
    });
    pc.addEventListener('icecandidateerror', (ev: any) => {
      if (typeof ev?.errorCode === 'number')
        p.iceErrors.push({errorCode: ev.errorCode, url: ev.url});
    });
    pc.addEventListener('track', (ev: any) => {
      p.stream =
        ev?.streams?.[0] ??
        (ev?.track
          ? {getTracks: () => [ev.track], getAudioTracks: () => [ev.track]}
          : null);
      applyDeafen();
      notify();
    });
    pc.addEventListener('connectionstatechange', () => onConnState(p));
    notify();
    return p;
  }

  function flushIce(p: Peer) {
    const queued = p.pendingIce;
    p.pendingIce = [];
    queued.forEach(c => p.pc.addIceCandidate(c).catch(() => {}));
  }

  async function makeOffer(p: Peer, iceRestart: boolean) {
    const offer = await p.pc.createOffer(
      iceRestart ? {iceRestart: true} : undefined,
    );
    await p.pc.setLocalDescription(offer);
    if (!session?.peers.has(p.id)) return;
    send(p.member, {k: 'offer', to_sid: p.sid, sdp: tuneSdp(offer.sdp ?? '')});
  }

  async function answer(p: Peer, sdp: string) {
    await p.pc.setRemoteDescription({type: 'offer', sdp});
    p.remoteSet = true;
    flushIce(p);
    const ans = await p.pc.createAnswer();
    await p.pc.setLocalDescription(ans);
    if (!session?.peers.has(p.id)) return;
    send(p.member, {k: 'answer', to_sid: p.sid, sdp: tuneSdp(ans.sdp ?? '')});
  }

  function clearPeerTimers(p: Peer) {
    for (const k of ['restartTimer', 'graceTimer', 'giveUpTimer'] as const) {
      if (p[k]) clearTimeout(p[k]!);
      p[k] = null;
    }
  }

  function onConnState(p: Peer) {
    if (!session?.peers.has(p.id)) return;
    p.conn = p.pc.connectionState;
    if (p.conn === 'connected') {
      p.everConnected = true;
      p.restarts = 0;
      p.failed = false;
      p.diagnosis = null;
      clearPeerTimers(p);
      if (phaseNow() === 'finding' || phaseNow() === 'connecting') goLive();
    } else if (p.conn === 'disconnected') {
      // Often recovers on its own; give it a moment before restarting ICE.
      if (!p.graceTimer) {
        p.graceTimer = setTimeout(() => {
          p.graceTimer = null;
          if (p.conn === 'disconnected') scheduleRestart(p);
        }, DISCONNECT_GRACE_MS);
      }
    } else if (p.conn === 'failed') {
      scheduleRestart(p);
    }
    notify();
  }

  function scheduleRestart(p: Peer) {
    if (!p.offerer) {
      // Only the side that made the offer restarts ICE; the other waits for it.
      if (!p.giveUpTimer) {
        p.giveUpTimer = setTimeout(() => {
          p.giveUpTimer = null;
          if (p.conn !== 'connected') giveUp(p).catch(() => {});
        }, ANSWERER_GIVE_UP_MS);
      }
      return;
    }
    if (p.restartTimer) return;
    if (p.restarts >= RESTART_DELAYS_MS.length) {
      giveUp(p).catch(() => {});
      return;
    }
    const delay = RESTART_DELAYS_MS[p.restarts++];
    p.restartTimer = setTimeout(() => {
      p.restartTimer = null;
      if (!session?.peers.has(p.id) || p.conn === 'connected') return;
      makeOffer(p, true).catch(() => {});
      // If this attempt doesn't connect either, try again (or give up).
      p.restartTimer = setTimeout(() => {
        p.restartTimer = null;
        if (session?.peers.has(p.id) && p.conn !== 'connected')
          scheduleRestart(p);
      }, delay * 2 + DISCONNECT_GRACE_MS);
    }, delay);
  }

  /** Restart ICE right away (we just came back online); resets the attempts. */
  function restartNow(p: Peer) {
    clearPeerTimers(p);
    p.restarts = 0;
    makeOffer(p, true).catch(() => {});
  }

  async function giveUp(p: Peer) {
    if (!session?.peers.has(p.id)) return;
    clearPeerTimers(p);
    try {
      localCandidateTypes(await p.pc.getStats()).forEach(t =>
        p.candidateTypes.add(t),
      );
    } catch {}
    const cfg = session.cfg;
    const name = deps.nameOf(session.roomKey, p.member);
    if (p.everConnected) {
      dropPeer(p);
      flash(`${name} dropped`);
      return;
    }
    p.failed = true;
    p.diagnosis = diagnose(
      {
        errors: p.iceErrors,
        candidateTypes: p.candidateTypes,
        everConnected: false,
        hadTurn: cfg ? iceCoverage(cfg) === 'turn' : false,
      },
      name,
    );
    notify();
  }

  function dropPeer(p: Peer) {
    clearPeerTimers(p);
    try {
      p.pc.close();
    } catch {}
    session?.peers.delete(p.id);
  }

  // ---- mute, sound off, speaker ----

  function applyMute() {
    session?.stream
      ?.getAudioTracks()
      .forEach(t => (t.enabled = !session!.muted));
  }

  function applyDeafen() {
    if (!session) return;
    for (const p of session.peers.values())
      p.stream?.getAudioTracks().forEach(t => (t.enabled = !session!.deafened));
  }

  // ---- phases ----

  function phaseNow(): Phase {
    return session ? (extra.phase as Phase) ?? 'idle' : 'idle';
  }

  function setPhase(phase: Phase) {
    setExtra({phase});
  }

  function inVoice() {
    const ph = phaseNow();
    return ph === 'finding' || ph === 'connecting' || ph === 'live';
  }

  function goLive() {
    if (!sinceLive.at) sinceLive.at = deps.now();
    setPhase('live');
  }

  function later(ms: number, fn: () => void) {
    const t = setTimeout(fn, ms);
    session?.timers.push(t);
  }

  // ---- pre-warming ----
  //
  // While a room's chat is open and someone is in its voice, we keep peer
  // connections gathering ICE candidates (iceCandidatePoolSize), one per
  // person there. Joining then skips that wait: each connection's
  // candidates already are. Nothing touches the microphone until Join.
  // Inside voice, one warmed connection waits for the next person to join.

  interface Warm {
    roomKey: string;
    cfg: RTCConfiguration;
    cfgKey: string;
    pool: PCLike[];
    timer: ReturnType<typeof setTimeout> | null;
  }
  let warm: Warm | null = null;
  async function iceConfigFor(_roomKey: string): Promise<RTCConfiguration> {
    return {...buildIceConfig(deps.settings()), iceCandidatePoolSize: 1};
  }

  function closeWarm() {
    if (!warm) return;
    if (warm.timer) clearTimeout(warm.timer);
    warm.pool.forEach(pc => {
      try {
        pc.close();
      } catch {}
    });
    warm = null;
  }

  function takeWarm(
    roomKey: string,
    cfg: RTCConfiguration | null,
  ): PCLike | null {
    if (
      !warm ||
      warm.roomKey !== roomKey ||
      !cfg ||
      warm.cfgKey !== JSON.stringify(cfg)
    )
      return null;
    return warm.pool.shift() ?? null;
  }

  function refillWarm(roomKey: string, want: number) {
    if (!warm || warm.roomKey !== roomKey) return;
    while (warm.pool.length < want) warm.pool.push(deps.createPC(warm.cfg));
  }

  /** Get ready to join this room's voice (call while its chat is open and voice is busy). */
  async function prewarm(roomKey: string, people: number) {
    if (session && session.roomKey !== roomKey) return;
    if (session) return; // in voice: the spare is kept by addPeer
    const cfg = await iceConfigFor(roomKey);
    if (session) return;
    const cfgKey = JSON.stringify(cfg);
    if (!warm || warm.roomKey !== roomKey || warm.cfgKey !== cfgKey) {
      closeWarm();
      warm = {roomKey, cfg, cfgKey, pool: [], timer: null};
    }
    refillWarm(roomKey, Math.min(MAX_PEERS, Math.max(1, people)));
    // Don't hold relay allocations for ever if the screen is just left open.
    if (warm.timer) clearTimeout(warm.timer);
    warm.timer = setTimeout(closeWarm, WARM_MS);
  }

  async function join(
    roomKey: string,
    opts: {allowNoServers?: boolean} = {},
  ): Promise<void> {
    if (session) throw new Error('Already in a voice room');
    const why = deps.unsupported();
    extra = {};
    if (why) {
      setExtra({error: {kind: 'unsupported', message: why}});
      return;
    }
    const ses: Session = {
      roomKey,
      sid: deps.randomId(),
      cfg: null,
      coverage: null,
      stream: null,
      peers: new Map(),
      muted: false,
      mutedBeforeDeaf: false,
      deafened: false,
      timers: [],
      intervals: [],
      stopAudio: null,
      gotReplies: false,
      alive: true,
      joined: false,
    };
    session = ses;
    sinceLive.at = 0;
    extra = {phase: 'config'};
    notify();

    // Usually instant: the room screen pre-warmed this while voice was busy.
    const cfg =
      warm?.roomKey === roomKey ? warm.cfg : await iceConfigFor(roomKey);
    if (!ses.alive) return;
    ses.cfg = cfg;
    ses.coverage = iceCoverage(ses.cfg);
    if (ses.coverage === 'none' && !opts.allowNoServers) {
      setPhase('confirm-no-servers');
      return;
    }
    await openMic(ses);
  }

  /** The "no STUN/TURN servers" popup's "Join anyway". */
  async function confirmNoServers() {
    const ses = session;
    if (!ses || phaseNow() !== 'confirm-no-servers') return;
    await openMic(ses);
  }

  async function openMic(ses: Session) {
    setPhase('mic');
    let ok = false;
    try {
      ok = await deps.micPermission();
      if (ok && ses.alive) ses.stream = await deps.getMic();
    } catch {
      ok = false;
    }
    if (!ses.alive) {
      ses.stream?.getTracks().forEach(t => t.stop());
      return;
    }
    if (!ok || !ses.stream) {
      endSession({
        kind: 'mic-denied',
        message: 'Microphone access is needed to join voice.',
      });
      return;
    }
    ses.stopAudio = deps.startAudio(route =>
      setExtra({route, speakerOn: route === 'speaker'}),
    );
    // The platform reports the real route (a headset, if one is connected)
    // right after; until then, assume the default.
    extra = {...extra, speakerOn: true, route: 'speaker'};
    // Someone known to be here: show their cards connecting right away.
    // Nobody: we're live at once (anyone joining later connects to us).
    const expected = deps.presenceCount(ses.roomKey);
    if (expected > 0) setPhase('connecting');
    else goLive();
    send('', {k: 'join', muted: ses.muted, deaf: ses.deafened});
    ses.joined = true;
    deps.onSession?.(ses.roomKey, 'join');
    // Inside voice, keep one warmed connection for the next joiner.
    if (!warm || warm.roomKey !== ses.roomKey) {
      closeWarm();
      warm = {
        roomKey: ses.roomKey,
        cfg: ses.cfg ?? {},
        cfgKey: JSON.stringify(ses.cfg),
        pool: [],
        timer: null,
      };
    }
    if (warm.timer) clearTimeout(warm.timer);
    warm.timer = null;
    refillWarm(ses.roomKey, 1);
    ses.intervals.push(setInterval(() => beat(), BEAT_MS));
    ses.intervals.push(
      setInterval(() => pollStats().catch(() => {}), STATS_MS),
    );
    later(FIND_MS, () => {
      // Presence was stale (nobody answered): we're the only one here.
      if (
        phaseNow() === 'connecting' &&
        !ses.gotReplies &&
        ses.peers.size === 0
      )
        goLive();
    });
    later(FIND_MS + JOIN_TIMEOUT_MS, () => {
      if (session !== ses || phaseNow() !== 'connecting') return;
      const peers = [...ses.peers.values()];
      if (peers.some(p => p.everConnected)) return;
      const facts = peers[0];
      setExtra({
        error: {
          kind: 'timeout',
          message: "Couldn't connect to voice",
          diagnosis: facts
            ? diagnose(
                {
                  errors: facts.iceErrors,
                  candidateTypes: facts.candidateTypes,
                  everConnected: false,
                  hadTurn: ses.coverage === 'turn',
                },
                deps.nameOf(ses.roomKey, facts.member),
              )
            : null,
        },
      });
    });
  }

  async function pollStats() {
    const ses = session;
    if (!ses) return;
    const now = deps.now();
    let local: number | null = null;
    for (const p of [...ses.peers.values()]) {
      if (now - p.lastHeard > PRESENCE_MS) {
        dropPeer(p);
        if (p.everConnected)
          flash(`${deps.nameOf(ses.roomKey, p.member)} dropped`);
        continue;
      }
      if (p.failed || p.conn !== 'connected') continue;
      let report: any;
      try {
        report = await p.pc.getStats();
      } catch {
        continue;
      }
      const sample = inboundFromStats(report, now);
      if (sample) p.quality = nextQuality(p.quality, sample);
      if (local === null) local = localLevelFromStats(report);
    }
    if (session !== ses) return;
    extra = {...extra, localLevel: ses.muted ? 0 : local ?? 0};
    notify();
  }

  function endSession(error: VoiceError | null) {
    const ses = session;
    if (!ses) return;
    ses.alive = false;
    if (ses.joined) {
      send('', {k: 'leave'});
      deps.onSession?.(ses.roomKey, 'leave');
    }
    for (const p of [...ses.peers.values()]) dropPeer(p);
    ses.timers.forEach(clearTimeout);
    ses.intervals.forEach(clearInterval);
    ses.stream?.getTracks().forEach(t => t.stop());
    ses.stopAudio?.();
    session = null;
    closeWarm();
    sinceLive.at = 0;
    extra = error ? {error} : {};
    deps.service.stop();
    notify();
  }

  // ---- reacting to the store ----

  function start() {
    if (unsubs.length) return;
    unsubs = [
      deps.onRtc(onSignal),
      deps.onServerReady(server => {
        const ses = session;
        if (!ses || deps.serverOf(ses.roomKey) !== server || !inVoice()) return;
        // Back online: tell everyone we're still here (same sid) and restart
        // ICE now for anything that dropped, instead of waiting for it.
        send('', {k: 'join', muted: ses.muted, deaf: ses.deafened});
        for (const p of ses.peers.values())
          if (p.offerer && p.conn !== 'connected') restartNow(p);
      }),
      deps.onStoreChange(() => {
        const ses = session;
        if (!ses) return;
        if (!deps.roomExists(ses.roomKey)) {
          endSession(null); // removed from the room
          return;
        }
        const down = !deps.serverOnline(ses.roomKey);
        if (down !== view.signalingDown) notify();
      }),
    ];
  }

  return {
    start,
    stop() {
      unsubs.forEach(u => u());
      unsubs = [];
    },
    subscribe(l: () => void): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getView: (): VoiceView => view,
    /** True while this device is in (or joining) a voice room. */
    active: () => !!session,
    join,
    confirmNoServers,
    prewarm,
    /** The room's chat closed, or its voice emptied. */
    cancelPrewarm() {
      if (!session) closeWarm();
    },
    /** Cancel a join in progress, or leave. */
    async leave() {
      if (!session) return;
      setPhase('leaving');
      endSession(null);
    },
    /** Leave the current room's voice (if any), then join another. */
    async switchTo(roomKey: string, opts?: {allowNoServers?: boolean}) {
      if (session) endSession(null);
      await join(roomKey, opts);
    },
    async retry() {
      const key = session?.roomKey;
      if (!key) return;
      endSession(null);
      await join(key);
    },
    clearError() {
      if (!extra.error) return;
      setExtra({error: null});
    },
    setMuted(muted: boolean) {
      const ses = session;
      if (!ses) return;
      if (!muted && ses.deafened) {
        // Unmuting while sound is off turns sound back on too.
        ses.deafened = false;
        applyDeafen();
      }
      ses.muted = muted;
      applyMute();
      beat();
      notify();
    },
    setDeafened(deafened: boolean) {
      const ses = session;
      if (!ses || ses.deafened === deafened) return;
      if (deafened) {
        ses.mutedBeforeDeaf = ses.muted;
        ses.muted = true;
      } else {
        ses.muted = ses.mutedBeforeDeaf;
      }
      ses.deafened = deafened;
      applyMute();
      applyDeafen();
      beat();
      notify();
    },
    setSpeakerOn(on: boolean) {
      if (!session || view.route === 'headset') return;
      deps.setSpeaker(on);
      setExtra({speakerOn: on, route: on ? 'speaker' : 'earpiece'});
    },
    setOutputDevice(id: string | null) {
      if (!session) return;
      setExtra({outputDevice: id});
    },
    setAudioBlocked(blocked: boolean) {
      if (view.audioBlocked !== blocked) setExtra({audioBlocked: blocked});
    },
    dismissStunWarning() {
      setExtra({stunWarningDismissed: true});
    },
    setUnstable(unstable: boolean) {
      if (!!extra.unstable !== unstable) setExtra({unstable});
    },
    /** The tab came back (mobile browsers suspend background tabs). */
    resume() {
      const ses = session;
      if (!ses || !inVoice()) return;
      for (const p of ses.peers.values())
        if (p.offerer && p.conn !== 'connected') restartNow(p);
    },
    /** The remote audio streams, for RemoteAudio.web.tsx. */
    remoteStreams(): {id: string; stream: StreamLike}[] {
      if (!session) return [];
      return [...session.peers.values()]
        .filter(p => p.stream)
        .map(p => ({id: p.id, stream: p.stream!}));
    },
  };
}

export type VoiceEngine = ReturnType<typeof createVoiceEngine>;

/** Who's in a voice room, in words: "Just you", "You and 2 others", "3 in voice". */
export function voiceSummary(others: number, mine: boolean): string {
  if (!mine) return `${others} in voice`;
  if (others === 0) return 'Just you';
  return `You and ${others} ${others === 1 ? 'other' : 'others'}`;
}
