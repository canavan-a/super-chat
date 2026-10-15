// Why a peer connection couldn't be made, in words someone can act on.
// Shared by voice (a tile that can't connect) and Settings' Test button.

export interface IceErrorInfo {
  errorCode: number;
  url?: string;
}

export interface IceFacts {
  errors: IceErrorInfo[];
  /** Candidate types we gathered: host, srflx, prflx, relay. */
  candidateTypes: Set<string>;
  /** Servers we configured that produced no candidate at all. */
  silentServers?: string[];
  everConnected: boolean;
  /** Were any TURN servers configured? */
  hadTurn: boolean;
}

export type DiagnosisKind =
  | 'turn-auth'
  | 'unreachable'
  | 'no-public-address'
  | 'nat-blocked'
  | 'peer-side';

export interface Diagnosis {
  kind: DiagnosisKind;
  message: string;
  /** Whether fixing your STUN/TURN settings is the likely remedy. */
  fixInSettings: boolean;
}

export function diagnose(f: IceFacts, peerName = 'them'): Diagnosis {
  const auth = f.errors.find(
    e =>
      e.errorCode === 401 ||
      e.errorCode === 403 ||
      e.errorCode === 437 ||
      e.errorCode === 441,
  );
  if (auth) {
    return {
      kind: 'turn-auth',
      message: `Your TURN server ${
        auth.url ?? ''
      } rejected the username or password.`.replace('  ', ' '),
      fixInSettings: true,
    };
  }
  const unreachable =
    f.errors.find(e => e.errorCode === 701)?.url ?? f.silentServers?.[0];
  if (
    unreachable &&
    !f.candidateTypes.has('srflx') &&
    !f.candidateTypes.has('relay')
  ) {
    return {
      kind: 'unreachable',
      message: `Couldn't reach ${unreachable}. Check the address, port and transport, and that it's online.`,
      fixInSettings: true,
    };
  }
  if (!f.candidateTypes.has('srflx') && !f.candidateTypes.has('relay')) {
    return {
      kind: 'no-public-address',
      message:
        "No public address found. Your STUN servers aren't working, or you have none.",
      fixInSettings: true,
    };
  }
  if (!f.candidateTypes.has('relay')) {
    return {
      kind: 'nat-blocked',
      message: f.hadTurn
        ? "A direct connection was blocked by NAT or a firewall, and your TURN server didn't give a relay. Check its settings, or your NAT or firewall."
        : 'A direct connection was blocked by NAT or a firewall (yours or theirs). Add a TURN server, or check your NAT or firewall settings.',
      fixInSettings: true,
    };
  }
  return {
    kind: 'peer-side',
    message: `Couldn't connect to ${peerName}. Their network or relay setup may be the problem.`,
    fixInSettings: false,
  };
}
