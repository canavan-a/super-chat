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
  /** The group picture (set by an admin, like the name), or null. */
  picture: AvatarRef | null;
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
  /** Who joined, left or was removed, and when, oldest first: notices in the chat. */
  activity: ActivityView[];
}

export interface ActivityView {
  /** Unique within the room: the event's place in the log. */
  id: string;
  kind: 'join' | 'leave' | 'removed';
  member: string;
  at: number;
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

function asAvatarRef(a: unknown): AvatarRef | null {
  const r = a as AvatarRef | null | undefined;
  return r && typeof r.blob === 'string' && typeof r.key === 'string' ? {blob: r.blob, key: r.key, at: Number(r.at) || 0} : null;
}

export function roomView(r: ReplayResult, keys: Record<number, Uint8Array>): RoomView {
  // undefined: no meta event read yet; "" : the name was cleared.
  let name: string | undefined;
  let color: string | null = null;
  let snapName: string | null = null;
  let snapColor: string | null = null;
  // undefined: no meta event has said anything about the picture yet.
  let picture: AvatarRef | null | undefined;
  let snapPicture: AvatarRef | null = null;
  const names: Record<string, string> = {};
  const avatars: Record<string, AvatarRef> = {};
  let wiped: {by: string; at: number} | null = null;
  const snapNames: Record<string, string> = {};
  const joined: Record<string, string[]> = {};
  const activity: ActivityView[] = [];

  for (const e of r.events) {
    switch (e.kind) {
      case 'meta': {
        const m = openEnc<{name?: string; color?: string; picture?: AvatarRef | null}>(e, keys);
        if (m && typeof m.name === 'string') name = m.name.slice(0, 80);
        if (m?.color) color = String(m.color);
        // Present: the current picture; null: removed; absent: unchanged.
        if (m && 'picture' in m) picture = asAvatarRef(m.picture);
        break;
      }
      case 'epoch': {
        const snap = openEnc<{name?: string; color?: string; picture?: AvatarRef | null; profiles?: Record<string, string>}>(e, keys);
        if (snap && typeof snap.name === 'string') snapName = snap.name.slice(0, 80) || null;
        if (snap?.color) snapColor = String(snap.color);
        if (snap && 'picture' in snap) snapPicture = asAvatarRef(snap.picture);
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
        activity.push({id: `a${e.seq}`, kind: 'join', member: e.author, at: e.ts});
        break;
      case 'leave':
        activity.push({id: `a${e.seq}`, kind: 'leave', member: e.author, at: e.ts});
        break;
      case 'kick':
        activity.push({id: `a${e.seq}`, kind: 'removed', member: e.pub.target, at: e.ts});
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
    name: name === undefined ? snapName : name || null,
    color: color ?? snapColor,
    picture: picture === undefined ? snapPicture : picture,
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
    activity,
  };
}
