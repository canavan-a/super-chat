// Turns a verified log plus whatever epoch keys we hold into what the UI
// shows: room name and color, members with roles and display names, invites.
import {applyEvent, LogState, newState, openEnc, parseEvent, ParsedEvent, Role, SignedEvent} from './log';

export interface MemberView {
  id: string;
  role: Role;
  name: string | null;
}

export interface InviteView {
  id: string;
  creator: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  uses: number;
  revoked: boolean;
  /** Accounts that joined through this invite, from the log. */
  joined: string[];
}

export interface RoomView {
  id: string;
  name: string | null;
  color: string | null;
  members: MemberView[];
  invites: InviteView[];
  retentionDays: number;
  epoch: number;
  /** Profile names of everyone seen in the log, including past members. */
  names: Record<string, string>;
  /** Profile pictures, by member: the blob and the key to open it. */
  avatars: Record<string, AvatarRef>;
  /** The latest "wipe chat history": who did it and when. Nothing older survives it. */
  wiped: {by: string; at: number} | null;
}

/**
 * A profile picture: an encrypted blob marked as the member's avatar on the
 * server (PUT /rooms/:id/avatar), with its key. A new picture is a new blob,
 * so the blob id doubles as the "has it changed" check. `at` is when it was
 * set, so a device only replaces a picture newer than its own.
 */
export interface AvatarRef {
  blob: string;
  key: string;
  at: number;
}

export interface ReplayResult {
  state: LogState;
  events: ParsedEvent[];
  /** Commitment per epoch, from the signed epoch events. */
  commits: Record<number, string>;
}

/** Parses and replays a full log, throwing at the first invalid event. */
export function replay(room: string, events: SignedEvent[]): ReplayResult {
  const state = newState(room);
  const parsed: ParsedEvent[] = [];
  const commits: Record<number, string> = {};
  for (const se of events) {
    const e = parseEvent(se);
    applyEvent(state, e);
    if (e.kind === 'epoch') commits[e.pub.epoch] = e.pub.commit;
    parsed.push(e);
  }
  return {state, events: parsed, commits};
}

export function roomView(r: ReplayResult, keys: Record<number, Uint8Array>): RoomView {
  let name: string | null = null;
  let color: string | null = null;
  let snapName: string | null = null;
  let snapColor: string | null = null;
  const names: Record<string, string> = {};
  const avatars: Record<string, AvatarRef> = {};
  let wiped: {by: string; at: number} | null = null;
  const snapNames: Record<string, string> = {};
  const joined: Record<string, string[]> = {};

  for (const e of r.events) {
    switch (e.kind) {
      case 'meta': {
        const m = openEnc<{name?: string; color?: string}>(e, keys);
        if (m?.name) name = String(m.name).slice(0, 80);
        if (m?.color) color = String(m.color);
        break;
      }
      case 'epoch': {
        const snap = openEnc<{name?: string; color?: string; profiles?: Record<string, string>}>(e, keys);
        if (snap?.name) snapName = String(snap.name).slice(0, 80);
        if (snap?.color) snapColor = String(snap.color);
        for (const [id, n] of Object.entries(snap?.profiles ?? {})) snapNames[id] = String(n).slice(0, 40);
        break;
      }
      case 'profile': {
        const p = openEnc<{displayName?: string; avatar?: AvatarRef | null}>(e, keys);
        if (p?.displayName) names[e.author] = String(p.displayName).slice(0, 40);
        // Present: the current picture; null: removed; absent: unchanged.
        if (p && 'avatar' in p) {
          const a = p.avatar;
          if (a && typeof a.blob === 'string' && typeof a.key === 'string') {
            avatars[e.author] = {blob: a.blob, key: a.key, at: Number(a.at) || 0};
          } else {
            delete avatars[e.author];
          }
        }
        break;
      }
      case 'join':
        (joined[e.pub.invite] ??= []).push(e.author);
        break;
      case 'wipe':
        wiped = {by: e.author, at: e.ts};
        break;
    }
  }

  // A member's own signed profile beats what someone else's snapshot says.
  const allNames = {...snapNames, ...names};
  const s = r.state;
  return {
    id: s.room,
    // Only admins can author meta; a snapshot is a fallback for members who
    // joined after the last meta event.
    name: name ?? snapName,
    color: color ?? snapColor,
    members: Object.keys(s.members)
      .sort((a, b) => (s.members[a] === s.members[b] ? 0 : s.members[a] === 'admin' ? -1 : 1))
      .map(id => ({id, role: s.members[id], name: allNames[id] ?? null})),
    invites: Object.entries(s.invites)
      .map(([id, iv]) => ({id, ...iv, joined: joined[id] ?? []}))
      .sort((a, b) => b.createdAt - a.createdAt),
    retentionDays: s.retentionDays,
    epoch: s.epoch,
    names: allNames,
    avatars,
    wiped,
  };
}
