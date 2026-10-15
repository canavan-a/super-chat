import {
  memberIdentity,
  newIdentity,
  openSignal,
  randomBytes,
  sealSignal,
  signalEpoch,
} from '../src/crypto';
import {diagnose} from '../src/call/diagnose';
import {
  ANSWERER_GIVE_UP_MS,
  BEAT_MS,
  createVoiceEngine,
  FIND_MS,
  JOIN_TIMEOUT_MS,
  MAX_PEERS,
  RESTART_DELAYS_MS,
  type VoiceDeps,
  WARM_MS,
} from '../src/call/engine';
import {
  buildIceConfig,
  DEFAULT_ICE_SERVERS,
  iceCoverage,
  settingsCoverage,
  validateIceUrl,
} from '../src/call/iceConfig';
import {
  initialQuality,
  nextQuality,
  type InboundSample,
} from '../src/call/quality';
import {tuneSdp} from '../src/call/sdp';

const ROOM = 'room-1';
const member = () => memberIdentity(newIdentity().entropy, ROOM);

describe('signal boxes', () => {
  const key = randomBytes(32);
  const alice = member();
  const bob = member();

  it('round-trips a directed signal', () => {
    const box = sealSignal(alice, ROOM, 3, key, bob.id, {
      sid: 's1',
      k: 'offer',
      sdp: 'v=0',
    });
    expect(signalEpoch(box)).toBe(3);
    const s = openSignal(ROOM, alice.id, bob.id, box, key);
    expect(s).toMatchObject({sid: 's1', k: 'offer', sdp: 'v=0'});
  });

  it('rejects tampering, the wrong room, the wrong recipient and a forged sender', () => {
    const box = sealSignal(alice, ROOM, 3, key, bob.id, {sid: 's1', k: 'ice'});
    const carol = member();
    expect(() =>
      openSignal(ROOM, alice.id, bob.id, box.slice(0, -4) + 'AAAA', key),
    ).toThrow();
    expect(() => openSignal('room-2', alice.id, bob.id, box, key)).toThrow();
    expect(() => openSignal(ROOM, alice.id, carol.id, box, key)).toThrow();
    expect(() => openSignal(ROOM, alice.id, '', box, key)).toThrow();
    // Someone else in the room (who has the key) can't pass off a signal as Alice's.
    const forged = sealSignal(carol, ROOM, 3, key, bob.id, {
      sid: 's1',
      k: 'ice',
    });
    expect(() => openSignal(ROOM, alice.id, bob.id, forged, key)).toThrow();
  });

  it('rejects stale signals', () => {
    const now = Date.now();
    const box = sealSignal(
      alice,
      ROOM,
      1,
      key,
      '',
      {sid: 's', k: 'beat'},
      now - 61_000,
    );
    expect(() => openSignal(ROOM, alice.id, '', box, key, now)).toThrow(
      'stale',
    );
    expect(
      openSignal(
        ROOM,
        alice.id,
        '',
        sealSignal(alice, ROOM, 1, key, '', {sid: 's', k: 'beat'}, now),
        key,
        now,
      ).k,
    ).toBe('beat');
  });
});

describe('tuneSdp', () => {
  const sdp = [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
    'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1;stereo=1',
    'a=rtpmap:63 red/48000/2',
    '',
  ].join('\r\n');

  it('asks for mono CBR opus and drops the audio-level extension', () => {
    const out = tuneSdp(sdp);
    expect(out).not.toContain('ssrc-audio-level');
    expect(out).toContain('abs-send-time');
    const fmtp = out.split('\r\n').find(l => l.startsWith('a=fmtp:111 '))!;
    expect(fmtp).toContain('minptime=10');
    expect(fmtp).toContain('stereo=0');
    expect(fmtp).toContain('cbr=1');
    expect(fmtp).toContain('maxaveragebitrate=32000');
    expect(fmtp).not.toContain('stereo=1');
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('adds an fmtp line when opus has none', () => {
    const out = tuneSdp('v=0\na=rtpmap:109 opus/48000/2\n');
    expect(out).toContain(
      'a=fmtp:109 stereo=0;sprop-stereo=0;cbr=1;maxaveragebitrate=32000;useinbandfec=1',
    );
  });
});

describe('ICE config', () => {
  const base = {
    iceServers: DEFAULT_ICE_SERVERS,
    useServerRelay: true,
    relayOnlyVoice: false,
  };
  const serverTurn = {
    urls: ['stun:t.example:3478', 'turn:t.example:3478'],
    username: 'u',
    credential: 'c',
  };

  it('merges and de-duplicates sources, with credentials only on TURN', () => {
    const cfg = buildIceConfig(
      {...base, iceServers: [...DEFAULT_ICE_SERVERS, ...DEFAULT_ICE_SERVERS]},
      serverTurn,
    );
    expect(cfg.iceServers).toEqual([
      {urls: 'stun:stun.l.google.com:19302'},
      {urls: 'stun:t.example:3478'},
      {urls: 'turn:t.example:3478', username: 'u', credential: 'c'},
    ]);
    expect(iceCoverage(cfg)).toBe('turn');
  });

  it('skips the server relay when switched off or unavailable', () => {
    expect(
      iceCoverage(buildIceConfig({...base, useServerRelay: false}, serverTurn)),
    ).toBe('stun-only');
    expect(iceCoverage(buildIceConfig(base, null))).toBe('stun-only');
    expect(iceCoverage(buildIceConfig({...base, iceServers: []}, null))).toBe(
      'none',
    );
    expect(settingsCoverage({...base, iceServers: []})).toBe('none');
  });

  it('only goes relay-only when there is a relay', () => {
    expect(
      buildIceConfig({...base, relayOnlyVoice: true}, null).iceTransportPolicy,
    ).toBe('all');
    expect(
      buildIceConfig({...base, relayOnlyVoice: true}, serverTurn)
        .iceTransportPolicy,
    ).toBe('relay');
  });

  it('validates URLs', () => {
    for (const ok of [
      'stun:stun.l.google.com:19302',
      'turn:1.2.3.4:3478?transport=udp',
      'turns:t.example.com:443?transport=tcp',
      'turn:[::1]:3478',
    ]) {
      expect(validateIceUrl(ok)).toBeNull();
    }
    for (const bad of [
      '',
      'http://x',
      'turn:',
      'stun:x:3478?transport=tcp',
      'turn:x:99999',
      'turn:has space',
    ]) {
      expect(validateIceUrl(bad)).not.toBeNull();
    }
  });
});

describe('quality', () => {
  const at = (
    t: number,
    packetsReceived: number,
    packetsLost = 0,
    jitter = 0.01,
    audioLevel = 0,
  ): InboundSample => ({
    t,
    packetsReceived,
    packetsLost,
    jitter,
    audioLevel,
  });

  it('flags stalls and weak links', () => {
    let q = initialQuality(0);
    q = nextQuality(q, at(0, 10));
    q = nextQuality(q, at(1000, 60));
    expect(q.quality).toBe('good');
    q = nextQuality(q, at(2000, 60));
    q = nextQuality(q, at(3100, 60));
    expect(q.quality).toBe('stalled');
    q = nextQuality(q, at(3400, 70));
    expect(q.quality).toBe('good');
    for (let t = 3700; t <= 7000; t += 300)
      q = nextQuality(
        q,
        at(t, q.last!.packetsReceived + 5, q.last!.packetsLost + 5),
      );
    expect(q.quality).toBe('weak');
  });

  it('smooths the speaking level', () => {
    let q = nextQuality(initialQuality(0), at(0, 1, 0, 0, 0.8));
    expect(q.level).toBeCloseTo(0.8);
    q = nextQuality(q, at(300, 2, 0, 0, 0));
    expect(q.level).toBeGreaterThan(0.3);
    expect(q.level).toBeLessThan(0.8);
  });
});

describe('diagnose', () => {
  const facts = (o: Partial<Parameters<typeof diagnose>[0]>) => ({
    errors: [],
    candidateTypes: new Set<string>(['host']),
    everConnected: false,
    hadTurn: false,
    ...o,
  });

  it('names the likely cause', () => {
    expect(
      diagnose(facts({errors: [{errorCode: 401, url: 'turn:t:3478'}]})).kind,
    ).toBe('turn-auth');
    expect(
      diagnose(facts({errors: [{errorCode: 701, url: 'stun:s:3478'}]})).kind,
    ).toBe('unreachable');
    expect(diagnose(facts({})).kind).toBe('no-public-address');
    expect(
      diagnose(facts({candidateTypes: new Set(['host', 'srflx'])})).kind,
    ).toBe('nat-blocked');
    expect(
      diagnose(
        facts({candidateTypes: new Set(['host', 'srflx', 'relay'])}),
        'Sam',
      ),
    ).toMatchObject({
      kind: 'peer-side',
      fixInSettings: false,
    });
  });
});

// ---- the engine, over a fake network of fake peer connections ----

class FakeTrack {
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
const fakeStream = () => {
  const t = new FakeTrack();
  return {track: t, stream: {getTracks: () => [t], getAudioTracks: () => [t]}};
};

class FakePC {
  connectionState = 'new';
  listeners: Record<string, ((ev: any) => void)[]> = {};
  offers: any[] = [];
  closed = false;
  remote: any = null;
  addTrack() {}
  addEventListener(type: string, cb: (ev: any) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  fire(type: string, ev: any = {}) {
    (this.listeners[type] ?? []).forEach(cb => cb(ev));
  }
  setState(s: string) {
    this.connectionState = s;
    this.fire('connectionstatechange');
  }
  async createOffer(opts?: any) {
    this.offers.push(opts ?? null);
    return {type: 'offer', sdp: 'v=0\r\na=rtpmap:111 opus/48000/2\r\n'};
  }
  async createAnswer() {
    return {type: 'answer', sdp: 'v=0\r\na=rtpmap:111 opus/48000/2\r\n'};
  }
  async setLocalDescription() {}
  async setRemoteDescription(d: any) {
    this.remote = d;
  }
  async addIceCandidate() {}
  async getStats() {
    return new Map();
  }
  close() {
    this.closed = true;
  }
}

interface Client {
  member: string;
  engine: ReturnType<typeof createVoiceEngine>;
  pcs: FakePC[];
  mic: FakeTrack | null;
  sent: {to: string; k: string}[];
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function network(
  settings = {
    iceServers: DEFAULT_ICE_SERVERS,
    useServerRelay: false,
    relayOnlyVoice: false,
  },
) {
  const clients: Client[] = [];
  const listeners = new Map<
    string,
    Set<(k: string, f: string, s: any) => void>
  >();
  let n = 0;
  function add(member: string): Client {
    const pcs: FakePC[] = [];
    const ls = new Set<(k: string, f: string, s: any) => void>();
    listeners.set(member, ls);
    const c: Client = {member, engine: null as any, pcs, mic: null, sent: []};
    const deps: VoiceDeps = {
      unsupported: () => null,
      micPermission: async () => true,
      getMic: async () => {
        const {track, stream} = fakeStream();
        c.mic = track;
        return stream;
      },
      createPC: () => {
        const pc = new FakePC();
        pcs.push(pc);
        return pc;
      },
      startAudio: () => () => {},
      setSpeaker: () => {},
      send: (_room, to, s) => {
        c.sent.push({to, k: s.k});
        for (const [m, l] of listeners) {
          if (m === member || (to && to !== m)) continue;
          const msg = {...s, ts: Date.now()};
          Promise.resolve().then(() => l.forEach(fn => fn(ROOM, member, msg)));
        }
        return true;
      },
      serverTurn: async () => {
        (c as any).turnCalls = ((c as any).turnCalls ?? 0) + 1;
        return {
          urls: ['turn:t.example:3478'],
          username: 'u',
          credential: 'p',
          ttl: 3600,
        };
      },
      settings: () => settings,
      nameOf: (_k, m) => m,
      roomExists: () => true,
      serverOnline: () => true,
      serverOf: () => 'srv',
      onRtc: l => {
        ls.add(l);
        return () => ls.delete(l);
      },
      onServerReady: () => () => {},
      onStoreChange: () => () => {},
      presenceCount: () =>
        clients.filter(o => o !== c && o.engine.active()).length,
      service: {
        update: () =>
          ((c as any).serviceCalls ??= []).push(c.mic ? 'mic-open' : 'no-mic'),
        stop() {},
      },
      randomId: () => `${member}-s${n++}`,
      now: () => Date.now(),
    };
    c.engine = createVoiceEngine(deps);
    c.engine.start();
    clients.push(c);
    return c;
  }
  return {add, clients};
}

/** Joins and lets the find window pass. */
async function join(c: Client) {
  const p = c.engine.join(ROOM);
  await flush();
  await p;
  await flush();
}

/** The connections actually in use (not warm spares). */
const used = (c: Client) =>
  c.pcs.filter(pc => pc.listeners.connectionstatechange?.length);

/** Marks every pc between two clients connected. */
function connectAll(...cs: Client[]) {
  for (const c of cs)
    for (const pc of c.pcs) if (!pc.closed) pc.setState('connected');
}

describe('voice engine', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('goes live alone, then connects a second person (the one already there offers)', async () => {
    const net = network();
    const a = net.add('A');
    const b = net.add('B');
    await join(a);
    jest.advanceTimersByTime(FIND_MS);
    expect(a.engine.getView().phase).toBe('live');
    expect(a.engine.getView().peers).toHaveLength(0);

    // In voice, A keeps one warmed connection for whoever joins next.
    expect(a.pcs).toHaveLength(1);
    expect(used(a)).toHaveLength(0);

    await join(b);
    await flush();
    expect(used(a)).toEqual([a.pcs[0]]); // B got the warmed one
    expect(a.pcs[0].offers).toHaveLength(1);
    expect(a.pcs).toHaveLength(2); // and a fresh spare is warming
    expect(used(b)).toHaveLength(1);
    expect(b.pcs[0].offers).toHaveLength(0); // the joiner never offers
    expect(b.pcs[0].remote?.type).toBe('offer');
    expect(a.pcs[0].remote?.type).toBe('answer');
    expect(b.engine.getView().phase).toBe('connecting'); // A answered 'here'
    expect(b.engine.getView().peers[0].state).toBe('connecting');

    connectAll(a, b);
    expect(b.engine.getView().phase).toBe('live');
    expect(b.engine.getView().peers[0]).toMatchObject({
      member: 'A',
      state: 'live',
    });
  });

  it('refuses a second voice room while in one', async () => {
    const a = network().add('A');
    await join(a);
    await expect(a.engine.join('room-2')).rejects.toThrow();
  });

  it(`caps a voice room at ${MAX_PEERS + 1}`, async () => {
    const net = network();
    const cs = Array.from({length: MAX_PEERS + 2}, (_, i) => net.add(`M${i}`));
    for (const c of cs.slice(0, MAX_PEERS + 1)) {
      await join(c);
      jest.advanceTimersByTime(FIND_MS);
      await flush();
    }
    connectAll(...cs);
    for (const c of cs.slice(0, MAX_PEERS + 1))
      expect(c.engine.getView().peers).toHaveLength(MAX_PEERS);
    const late = cs[MAX_PEERS + 1];
    await join(late);
    await flush();
    expect(late.engine.active()).toBe(false);
    expect(late.engine.getView().error?.kind).toBe('full');
    expect(late.mic?.stopped).toBe(true);
  });

  it('mutes, and turns sound off and back on', async () => {
    const net = network();
    const a = net.add('A');
    const b = net.add('B');
    await join(a);
    jest.advanceTimersByTime(FIND_MS);
    await join(b);
    await flush();
    connectAll(a, b);
    const remote = new FakeTrack();
    b.pcs[0].fire('track', {
      streams: [{getTracks: () => [remote], getAudioTracks: () => [remote]}],
    });

    b.engine.setMuted(true);
    await flush();
    expect(b.mic!.enabled).toBe(false);
    expect(a.engine.getView().peers[0].muted).toBe(true);
    b.engine.setMuted(false);

    b.engine.setDeafened(true);
    await flush();
    expect(remote.enabled).toBe(false);
    expect(b.mic!.enabled).toBe(false);
    expect(a.engine.getView().peers[0]).toMatchObject({
      muted: true,
      deaf: true,
    });
    b.engine.setDeafened(false);
    expect(remote.enabled).toBe(true);
    expect(b.mic!.enabled).toBe(true); // back to unmuted, as before
    expect(b.engine.getView().muted).toBe(false);

    // Muted before sound off stays muted after.
    b.engine.setMuted(true);
    b.engine.setDeafened(true);
    b.engine.setDeafened(false);
    expect(b.engine.getView().muted).toBe(true);
  });

  it('restarts ICE from the offerer, then explains a connection that never worked', async () => {
    const net = network();
    const a = net.add('A');
    const b = net.add('B');
    await join(a);
    jest.advanceTimersByTime(FIND_MS);
    await join(b);
    await flush();
    const pc = a.pcs[0];
    pc.setState('failed');
    for (const d of RESTART_DELAYS_MS) {
      jest.advanceTimersByTime(d);
      await flush();
      jest.advanceTimersByTime(d * 2 + 5000);
      await flush();
    }
    expect(pc.offers.filter(o => o?.iceRestart)).toHaveLength(
      RESTART_DELAYS_MS.length,
    );
    const peer = a.engine.getView().peers[0];
    expect(peer.state).toBe('failed');
    expect(peer.diagnosis?.kind).toBe('no-public-address');
  });

  it('drops someone who connected and then left, and tells the others', async () => {
    const net = network();
    const a = net.add('A');
    const b = net.add('B');
    await join(a);
    jest.advanceTimersByTime(FIND_MS);
    await join(b);
    await flush();
    connectAll(a, b);
    await b.engine.leave();
    await flush();
    expect(a.engine.getView().peers).toHaveLength(0);
    expect(b.engine.getView().phase).toBe('idle');
    expect(b.sent.at(-1)?.k).toBe('leave');
  });

  it('times out a join that never connects', async () => {
    const net = network();
    const a = net.add('A');
    const b = net.add('B');
    await join(a);
    jest.advanceTimersByTime(FIND_MS);
    await join(b);
    jest.advanceTimersByTime(FIND_MS + JOIN_TIMEOUT_MS);
    await flush();
    expect(b.engine.getView().error?.kind).toBe('timeout');
    expect(b.engine.active()).toBe(true); // still in it: Retry or Leave
  });

  it('asks before joining with no STUN/TURN servers', async () => {
    const a = network({
      iceServers: [],
      useServerRelay: false,
      relayOnlyVoice: false,
    }).add('A');
    await join(a);
    expect(a.engine.getView().phase).toBe('confirm-no-servers');
    expect(a.mic).toBeNull(); // the mic isn't opened until they choose
    await a.engine.confirmNoServers();
    await flush();
    expect(a.engine.getView().phase).toBe('live'); // nobody else here
    expect(a.engine.getView().coverage).toBe('none');
  });

  it('answers probes with a direct beat, and keeps beating', async () => {
    const net = network();
    const a = net.add('A');
    await join(a);
    jest.advanceTimersByTime(FIND_MS);
    const before = a.sent.length;
    jest.advanceTimersByTime(BEAT_MS);
    expect(a.sent.slice(before).some(s => s.k === 'beat' && s.to === '')).toBe(
      true,
    );
  });

  it('gives up as the answerer if the offerer never fixes it', async () => {
    const net = network();
    const a = net.add('A');
    const b = net.add('B');
    await join(a);
    jest.advanceTimersByTime(FIND_MS);
    await join(b);
    await flush();
    b.pcs[0].setState('failed');
    jest.advanceTimersByTime(ANSWERER_GIVE_UP_MS);
    await flush();
    expect(b.engine.getView().peers[0].state).toBe('failed');
  });
});

describe('voice pre-warming', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('joins on connections that were already gathering, without refetching relay credentials', async () => {
    const net = network({
      iceServers: DEFAULT_ICE_SERVERS,
      useServerRelay: true,
      relayOnlyVoice: false,
    });
    const a = net.add('A');
    const b = net.add('B');
    const c = net.add('C');
    await join(a);
    await join(b);
    await flush();
    connectAll(a, b);

    // C has the room's chat open while A and B talk.
    const turnCalls = () => (c as any).turnCalls as number;
    await c.engine.prewarm(ROOM, 2);
    expect(c.pcs).toHaveLength(2);
    expect(turnCalls()).toBe(1);
    const warmed = [...c.pcs];

    await join(c);
    await flush();
    expect(turnCalls()).toBe(1); // cached
    expect(used(c).sort()).toEqual(warmed.sort());
    expect(c.engine.getView().phase).toBe('connecting'); // cards up at once
    connectAll(a, b, c);
    expect(c.engine.getView().phase).toBe('live');
    expect(c.engine.getView().peers.every(p => p.state === 'live')).toBe(true);
  });

  it('lets warmed connections go when the chat closes or after a while', async () => {
    const a = network().add('A');
    await a.engine.prewarm(ROOM, 3);
    expect(a.pcs.filter(pc => !pc.closed)).toHaveLength(3);
    a.engine.cancelPrewarm();
    expect(a.pcs.every(pc => pc.closed)).toBe(true);

    await a.engine.prewarm(ROOM, 1);
    jest.advanceTimersByTime(WARM_MS);
    expect(a.pcs.every(pc => pc.closed)).toBe(true);
  });
});

describe('voice notification (Android foreground service)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('never starts before the microphone is open', async () => {
    // Android 14+ kills the app if a microphone-type foreground service
    // starts without the mic permission.
    const a = network().add('A');
    await join(a);
    jest.advanceTimersByTime(FIND_MS);
    const calls: string[] = (a as any).serviceCalls ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c === 'mic-open')).toBe(true);
  });
});
