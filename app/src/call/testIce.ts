// Settings' "Test" for one STUN/TURN server: gather candidates through only
// that server for a few seconds and see what comes back. Reports problems in
// the same words a failed voice connection does (diagnose.ts).
import {rtcPlatform} from '../rtc';
import {diagnose, type IceErrorInfo} from './diagnose';
import {isTurnUrl, type IceServerEntry} from './iceConfig';

export type IceTestResult =
  | {ok: true; message: string}
  | {ok: false; message: string};

export const ICE_TEST_MS = 5000;

export async function testIceServer(
  entry: IceServerEntry,
  timeoutMs = ICE_TEST_MS,
): Promise<IceTestResult> {
  const turn = isTurnUrl(entry.urls);
  const why = rtcPlatform.unsupported();
  if (why) return {ok: false, message: why};
  const server: RTCIceServer = turn
    ? {urls: entry.urls, username: entry.username, credential: entry.credential}
    : {urls: entry.urls};
  const pc: any = rtcPlatform.createPC({
    iceServers: [server],
    iceTransportPolicy: turn ? 'relay' : 'all',
  });
  const types = new Set<string>();
  const errors: IceErrorInfo[] = [];
  try {
    await new Promise<void>(resolve => {
      const done = setTimeout(resolve, timeoutMs);
      pc.addEventListener('icecandidate', (ev: any) => {
        const c = ev?.candidate;
        if (!c) {
          clearTimeout(done);
          resolve();
          return;
        }
        const type = c.type ?? /typ (\w+)/.exec(c.candidate ?? '')?.[1];
        if (type) types.add(type);
        if ((turn && type === 'relay') || (!turn && type === 'srflx')) {
          clearTimeout(done);
          resolve();
        }
      });
      pc.addEventListener('icecandidateerror', (ev: any) => {
        if (typeof ev?.errorCode === 'number')
          errors.push({errorCode: ev.errorCode, url: ev.url ?? entry.urls});
      });
      // A data channel is enough to make it gather; no microphone needed.
      pc.createDataChannel('ice-test');
      pc.createOffer()
        .then((o: any) => pc.setLocalDescription(o))
        .catch(() => {
          clearTimeout(done);
          resolve();
        });
    });
  } finally {
    try {
      pc.close();
    } catch {}
  }
  if (turn && types.has('relay')) return {ok: true, message: '✓ Relay works'};
  if (!turn && types.has('srflx')) return {ok: true, message: '✓ Reachable'};
  const d = diagnose({
    errors,
    candidateTypes: types,
    silentServers: [entry.urls],
    everConnected: false,
    hadTurn: turn,
  });
  if (turn && d.kind !== 'turn-auth' && d.kind !== 'unreachable') {
    // Reached nothing useful but no specific error: the usual cause.
    return {
      ok: false,
      message: '✗ No relay: check the address, port, username and password',
    };
  }
  return {ok: false, message: `✗ ${d.message}`};
}
