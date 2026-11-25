import fs from 'fs';
import path from 'path';

import {
  applyEvent,
  b64,
  buildEvents,
  cloneState,
  createInvite,
  createRoomBatch,
  decryptBlob,
  decryptMessage,
  encryptBlob,
  encryptMessage,
  entropyFromPhrase,
  extendReplay,
  exportKeyFile,
  identityFromEntropy,
  importKeyFile,
  joinBatch,
  memberIdentity,
  openVault,
  sealVault,
  vaultKeys,
  newEpoch,
  newIdentity,
  openEnvelope,
  openPreview,
  parseEvent,
  parseInviteLink,
  phraseFromEntropy,
  replay,
  roomView,
  ServerMessage,
  SignedEvent,
  unb64,
  utf8,
  unutf8,
} from '../src/crypto';
import {edPublicKey, hkdf, joinProofMessage, newId, openEnc, openSignal, randomBytes, sealSignal, sign} from '../src/crypto';

// A stranger's key in a given room.
const member = (room: string) => memberIdentity(newIdentity().entropy, room);

function setupRoom() {
  const created = createRoomBatch(newIdentity(), {name: 'Den', color: '#4C8BF5'}, 'Alice', 30);
  const alice = created.me;
  const r = replay(created.room, created.batch.events);
  return {alice, created, r};
}

describe('identity', () => {
  it('round-trips the recovery phrase and derives the same account', () => {
    const me = newIdentity();
    const words = phraseFromEntropy(me.entropy);
    expect(words).toHaveLength(24);
    const again = identityFromEntropy(entropyFromPhrase(words.join('  ').toUpperCase()));
    expect(again.id).toBe(me.id);
    expect(memberIdentity(again.entropy, 'AAAAAAAAAAAAAAAAAAAAAA').id).toBe(memberIdentity(me.entropy, 'AAAAAAAAAAAAAAAAAAAAAA').id);
  });

  it('rejects a phrase with a typo', () => {
    const words = phraseFromEntropy(newIdentity().entropy);
    words[3] = words[3] === 'abandon' ? 'ability' : 'abandon';
    expect(() => entropyFromPhrase(words.join(' '))).toThrow();
    expect(() => entropyFromPhrase('not a phrase')).toThrow(/24 words/);
  });

  it('round-trips the key file and refuses a wrong passphrase', async () => {
    const me = newIdentity();
    const file = await exportKeyFile(me, 'correct horse');
    expect((await importKeyFile(file, 'correct horse')).id).toBe(me.id);
    await expect(importKeyFile(file, 'wrong')).rejects.toThrow(/doesn't unlock/);
    await expect(importKeyFile('{"hello":1}', 'x')).rejects.toThrow(/isn't a Super Chat key file/);
  });

  it('is a different, unrelated member in every room', () => {
    const me = newIdentity();
    const inA = memberIdentity(me.entropy, 'AAAAAAAAAAAAAAAAAAAAAA');
    const inB = memberIdentity(me.entropy, 'BBBBBBBBBBBBBBBBBBBBBB');
    expect(inA.id).not.toBe(inB.id);
    expect(b64(inA.xPub)).not.toBe(b64(inB.xPub));
    // …and the same member again on any device with the same phrase.
    expect(memberIdentity(me.entropy, 'AAAAAAAAAAAAAAAAAAAAAA').id).toBe(inA.id);
    // The local fingerprint is none of them.
    expect([inA.id, inB.id]).not.toContain(me.id);
  });

  it('keeps the room list in a padded vault only the phrase can open', () => {
    const me = newIdentity();
    const k = vaultKeys(me.entropy, 'https://chat.example');
    const one = sealVault(k, {v: 1, rooms: ['AAAAAAAAAAAAAAAAAAAAAA']});
    const many = sealVault(k, {v: 1, rooms: Array.from({length: 40}, (_, i) => String(i).padStart(22, 'A'))});
    expect(openVault(k, many).rooms).toHaveLength(40);
    // Size doesn't give away the room count.
    expect(one.length).toBe(many.length);
    // Another server gets a different vault; another account can't open it.
    expect(vaultKeys(me.entropy, 'https://other.example').id).not.toBe(k.id);
    expect(() => openVault(vaultKeys(newIdentity().entropy, 'https://chat.example'), one)).toThrow();
  });
});

describe('room log', () => {
  it('creates a room with a readable name and the creator as admin', () => {
    const {alice, created, r} = setupRoom();
    const keys = {1: openEnvelope(alice, created.room, 1, created.batch.envelopes![alice.id], r.commits[1])};
    const view = roomView(r, keys);
    expect(view.name).toBe('Den');
    expect(view.members).toEqual([{id: alice.id, role: 'admin', name: 'Alice'}]);
  });

  it('sets, keeps and removes the group picture, and clears the name', () => {
    const {alice, created, r} = setupRoom();
    const key = openEnvelope(alice, created.room, 1, created.batch.envelopes![alice.id], r.commits[1]);
    const meta = (enc: Record<string, unknown>) => {
      const {signed, state} = buildEvents(alice, r.state, [{kind: 'meta', enc, encEpoch: 1, encKey: key}]);
      r.state = state;
      for (const se of signed) r.events.push(parseEvent(se));
    };
    const pic = {blob: 'b1', key: 'k1', at: 5};
    meta({picture: pic});
    expect(roomView(r, {1: key}).picture).toEqual(pic);
    expect(roomView(r, {1: key}).name).toBe('Den');
    // A name/color change without a picture leaves it alone.
    meta({name: 'Den 2', color: '#34C759'});
    expect(roomView(r, {1: key}).picture).toEqual(pic);
    meta({picture: null});
    expect(roomView(r, {1: key}).picture).toBeNull();
    meta({name: '', color: '#34C759'});
    expect(roomView(r, {1: key}).name).toBeNull();
  });

  it('rejects a tampered event', () => {
    const {created} = setupRoom();
    const evs = created.batch.events.slice();
    const body = JSON.parse(unutf8(unb64(evs[0].body)));
    body.pub.retentionDays = 0;
    evs[0] = {body: b64(utf8(JSON.stringify(body))), sig: evs[0].sig};
    expect(() => replay(created.room, evs)).toThrow(/signature/);
  });

  it('rejects a non-admin promoting themselves', () => {
    const {alice, r} = setupRoom();
    const bob = member(r.state.room);
    // Bob somehow appended a promote without being a member: invalid.
    expect(() => buildEvents(bob, r.state, [{kind: 'promote', pub: {target: bob.id}}])).toThrow(/only admins/);
    expect(r.state.members[alice.id]).toBe('admin');
  });

  it('refuses a member the server slipped in without an invite proof', () => {
    const {r} = setupRoom();
    const ghost = member(r.state.room);
    expect(() => buildEvents(ghost, r.state, [{kind: 'join', pub: {invite: 'AAAAAAAAAAAAAAAAAAAAAA', proof: 'x'}}])).toThrow();
  });

  it('lets an invited account join, and only from that point on', async () => {
    const {alice, created, r} = setupRoom();
    const k1 = openEnvelope(alice, created.room, 1, created.batch.envelopes![alice.id], r.commits[1]);

    const early = encryptMessage(alice, created.room, 1, k1, {t: 'text', body: 'before bob'});

    const inv = createInvite(alice, r.state, 'https://chat.example', {name: 'Den', color: '#fff', inviter: 'Alice'}, {
      expiresAt: 0,
      maxUses: 1,
    });
    const link = parseInviteLink(inv.link)!;
    expect(link.invite).toBe(inv.id);
    expect(openPreview(link.secret, inv.batch.preview!)?.name).toBe('Den');

    const afterInvite = replay(created.room, [...created.batch.events, ...inv.batch.events]);
    const bob = member(created.room);
    const join = joinBatch(bob, afterInvite.state, link, null, 'Bob');
    const all: SignedEvent[] = [...created.batch.events, ...inv.batch.events, ...join.batch.events];
    const after = replay(created.room, all);

    expect(after.state.members[bob.id]).toBe('member');
    expect(after.state.epoch).toBe(2);
    // Bob got a key for epoch 2 only…
    const k2 = openEnvelope(bob, created.room, 2, join.batch.envelopes![bob.id], after.commits[2]);
    expect(Object.keys(join.batch.envelopes!).sort()).toEqual([alice.id, bob.id].sort());
    // …which can't open what was sent under epoch 1.
    const earlyMsg: ServerMessage = {pos: 1, id: early.id, room: created.room, epoch: 1, sender: alice.id, kind: 'msg', ct: early.ct, createdAt: 0};
    expect(() => decryptMessage(earlyMsg, k2)).toThrow();
    // Alice can open the new epoch too.
    expect(b64(openEnvelope(alice, created.room, 2, join.batch.envelopes![alice.id], after.commits[2]))).toBe(b64(k2));

    // The invite was single use.
    const carol = member(created.room);
    expect(() =>
      joinBatch(carol, after.state, link, null, 'Carol'),
    ).toThrow(/used up/);

    // Members see who joined through which invite.
    const view = roomView(after, {1: k1, 2: k2});
    expect(view.invites[0].joined).toEqual([bob.id]);
    expect(view.members.find(m => m.id === bob.id)?.name).toBe('Bob');

    // Joins and departures, for the notices in the chat; Bob's name is still
    // known once he's gone.
    const left = buildEvents(bob, after.state, [{kind: 'leave'}]);
    const gone = replay(created.room, [...all, ...left.signed]);
    // Replaying only what's new on top of a verified log gives the same as
    // replaying it all; events already held are skipped.
    const stepped = await extendReplay(created.room, await extendReplay(created.room, afterInvite, join.batch.events), left.signed);
    expect(stepped).toEqual(gone);
    expect(await extendReplay(created.room, after, all)).toEqual(after);
    expect(await extendReplay(created.room, null, [...all, ...left.signed], async () => {})).toEqual(gone);
    const goneView = roomView(gone, {1: k1, 2: k2});
    expect(goneView.activity.map(a => [a.kind, a.member])).toEqual([
      ['join', bob.id],
      ['leave', bob.id],
    ]);
    expect(new Set(goneView.activity.map(a => a.id)).size).toBe(2);
    expect(goneView.names[bob.id]).toBe('Bob');
  });

  it('refuses a join signed with the wrong invite secret', () => {
    const {alice, created, r} = setupRoom();
    const inv = createInvite(alice, r.state, 'https://chat.example', {name: '', color: '', inviter: ''}, {expiresAt: 0, maxUses: 0});
    const s = replay(created.room, [...created.batch.events, ...inv.batch.events]).state;
    const link = parseInviteLink(inv.link)!;
    const wrong = {...link, secret: new Uint8Array(32).fill(7)};
    expect(() => joinBatch(member(created.room), s, wrong, null, 'M')).toThrow(/proof/);
  });

  it('rejects an epoch that seals to an outsider', () => {
    const {alice, r} = setupRoom();
    const outsider = member(r.state.room);
    const s = cloneState(r.state);
    s.members[outsider.id] = 'member'; // pretend, to build the envelope list
    s.keys[outsider.id] = b64(outsider.xPub);
    const ep = newEpoch(s);
    expect(() => buildEvents(alice, r.state, [ep.event])).toThrow(/recipients/);
  });

  it('applies the same rules when appending with a clock', () => {
    const {alice, r} = setupRoom();
    const {signed} = buildEvents(alice, r.state, [{kind: 'settings', pub: {retentionDays: 7}}], Date.now() - 10 * 60 * 1000);
    expect(() => applyEvent(cloneState(r.state), parseEvent(signed[0]), Date.now())).toThrow(/clock/);
  });
});

describe('messages and blobs', () => {
  it('round-trips and detects tampering and impersonation', () => {
    const {alice, created, r} = setupRoom();
    const key = openEnvelope(alice, created.room, 1, created.batch.envelopes![alice.id], r.commits[1]);
    const enc = encryptMessage(alice, created.room, 1, key, {t: 'text', body: 'hi', replyTo: undefined});
    const m: ServerMessage = {pos: 1, id: enc.id, room: created.room, epoch: 1, sender: alice.id, kind: 'msg', ct: enc.ct, createdAt: 0};
    expect(decryptMessage(m, key)).toMatchObject({t: 'text', body: 'hi'});
    // Another member claiming to be the sender: AD mismatch.
    expect(() => decryptMessage({...m, sender: newIdentity().id}, key)).toThrow();
    // The server relabelling it as a reaction.
    expect(() => decryptMessage({...m, kind: 'reaction'}, key)).toThrow();
  });

  it('encrypts blobs', () => {
    const data = utf8('picture bytes');
    const {key, sealed} = encryptBlob(data);
    expect(unutf8(decryptBlob(key, sealed))).toBe('picture bytes');
    sealed[30] ^= 1;
    expect(() => decryptBlob(key, sealed)).toThrow();
  });
});

describe('invite links', () => {
  it('parses both link forms', () => {
    const secret = new Uint8Array(32).fill(1);
    const https = `https://chat.superbadger.io/i/AAAAAAAAAAAAAAAAAAAAAA#${b64(secret)}`;
    expect(parseInviteLink(https)?.server).toBe('https://chat.superbadger.io');
    const app = `superchat://join?s=${encodeURIComponent('https://x.example')}&i=AAAAAAAAAAAAAAAAAAAAAA&k=${b64(secret)}`;
    expect(parseInviteLink(app)?.server).toBe('https://x.example');
    expect(parseInviteLink('https://evil.example/i/x')).toBeNull();
  });
});

// Writes a log built by this client for the Go server's tests to replay
// (shared/proto/interop_test.go), so the two implementations are checked
// against each other. The fixture is committed; it's rewritten only when
// missing or with WRITE_FIXTURE=1 (after changing the protocol), so normal
// test runs don't churn it.
describe('interop fixture', () => {
  it('builds a log the Go side can replay', () => {
    const {alice, created} = setupRoom();
    const r = replay(created.room, created.batch.events);
    const inv = createInvite(alice, r.state, 'https://chat.example', {name: 'Den', color: '#fff', inviter: 'Alice'}, {expiresAt: 0, maxUses: 0});
    const s = replay(created.room, [...created.batch.events, ...inv.batch.events]).state;
    const bob = member(created.room);
    const join = joinBatch(bob, s, parseInviteLink(inv.link)!, null, 'Bob');
    const events = [...created.batch.events, ...inv.batch.events, ...join.batch.events];
    const final = replay(created.room, events).state;
    const out = {
      room: created.room,
      events,
      expect: {nextSeq: final.nextSeq, head: final.head, epoch: final.epoch, members: final.members},
    };
    const file = path.resolve(__dirname, '../../shared/proto/testdata/ts-log.json');
    expect(replay(out.room, out.events).state.head).toBe(out.expect.head);
    if (process.env.WRITE_FIXTURE === '1' || !fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify(out, null, 2));
    }
  });
});

// ---- Go interop vectors (shared/crypto/interop_test.go) ----
//
// One vector format, both ways. This test writes ts-vectors.json for the Go
// side to check, and checks go-vectors.json, which the Go tests write. Each
// side reproduces what's deterministic (member IDs, the phrase, the invite key
// and join proof, the vault ID) and opens everything else. Like the log
// fixture above, ts-vectors.json is rewritten only when missing or with
// WRITE_FIXTURE=1.

interface Vectors {
  entropy: string;
  bobEntropy: string;
  phrase: string;
  fingerprint: string;
  room: string;
  server: string;
  aliceId: string;
  bobId: string;
  events: SignedEvent[];
  expect: {nextSeq: number; head: string; epoch: number; members: Record<string, string>};
  envelopes: {epoch: number; member: string; sealed: string}[];
  keys: Record<string, string>;
  enc: {seq: number; expect: unknown}[];
  invite: {link: string; preview: string; previewPlain: unknown};
  messages: {message: ServerMessage; expect: unknown; ts: number}[];
  rtc: {from: string; to: string; box: string; now: number; expect: unknown};
  blob: {key: string; sealed: string; plain: string};
  vault: {server: string; id: string; blob: string; rooms: string[]};
  view: unknown;
}

// The room view in a form both languages build the same way: members sorted by
// ID (Go has no insertion order), and "" for no name or color.
const normView = (v: ReturnType<typeof roomView>) => ({
  name: v.name ?? '',
  color: v.color ?? '',
  picture: v.picture,
  retentionDays: v.retentionDays,
  epoch: v.epoch,
  names: v.names,
  avatars: v.avatars,
  members: [...v.members].sort((a, b) => (a.id < b.id ? -1 : 1)).map(m => ({id: m.id, role: m.role, name: m.name ?? ''})),
  activity: v.activity,
  wiped: v.wiped,
});

const VECTORS_DIR = path.resolve(__dirname, '../../shared/crypto/testdata');
const strip = ({v: _v, ts: _ts, ...rest}: any) => rest;

function buildVectors(): Vectors {
  const entropy = Uint8Array.from({length: 32}, (_, i) => i + 1);
  const bobEntropy = Uint8Array.from({length: 32}, (_, i) => 200 - i);
  const server = 'https://chat.example';
  const created = createRoomBatch(identityFromEntropy(entropy), {name: 'Den', color: '#4C8BF5'}, 'Alice', 30);
  const room = created.room;
  const alice = created.me;
  const bob = memberIdentity(bobEntropy, room);
  const s1 = replay(room, created.batch.events).state;
  const preview = {name: 'Den', color: '#4C8BF5', inviter: 'Alice'};
  const inv = createInvite(alice, s1, server, preview, {expiresAt: 0, maxUses: 0});
  const s2 = replay(room, [...created.batch.events, ...inv.batch.events]).state;
  const join = joinBatch(bob, s2, parseInviteLink(inv.link)!, preview, 'Bob');
  const s3 = replay(room, [...created.batch.events, ...inv.batch.events, ...join.batch.events]).state;
  // A profile picture, and a meta with a group picture and a name long enough
  // to be cut at 80 UTF-16 units (the emoji counts as two).
  const {signed: extra} = buildEvents(alice, s3, [
    {kind: 'profile', enc: {displayName: 'Alice', avatar: {blob: newId(), key: b64(randomBytes(32)), at: 1_700_000_000_000}}, encEpoch: 2, encKey: join.key},
    {kind: 'meta', enc: {name: '😀 ' + 'x'.repeat(100), picture: {blob: newId(), key: b64(randomBytes(32)), at: 1_700_000_000_123}}, encEpoch: 2, encKey: join.key},
  ]);
  const events = [...created.batch.events, ...inv.batch.events, ...join.batch.events, ...extra];
  const r = replay(room, events);
  const keys = {1: created.key, 2: join.key};
  const msg = (from: typeof alice, content: any, pos: number) => {
    const m = encryptMessage(from, room, 2, join.key, content);
    const message: ServerMessage = {pos, id: m.id, room, epoch: 2, sender: from.id, kind: m.kind, ct: m.ct, createdAt: 0};
    const d = decryptMessage(message, join.key);
    return {message, expect: strip(d), ts: d.ts};
  };
  const first = msg(alice, {t: 'text', body: `hi <@${bob.id}> 😀 & "quotes"   end`, replyTo: newId()}, 1);
  const now = 1_700_000_000_000;
  const signal = {sid: 'alice-sid', to_sid: 'bob-sid', k: 'offer' as const, sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n', muted: true, deaf: false};
  const blobPlain = utf8('a picture, say');
  const blob = encryptBlob(blobPlain);
  const vk = vaultKeys(entropy, server);
  return {
    entropy: b64(entropy),
    bobEntropy: b64(bobEntropy),
    phrase: phraseFromEntropy(entropy).join(' '),
    fingerprint: identityFromEntropy(entropy).id,
    room,
    server,
    aliceId: alice.id,
    bobId: bob.id,
    events,
    expect: {nextSeq: r.state.nextSeq, head: r.state.head, epoch: r.state.epoch, members: r.state.members},
    envelopes: [
      {epoch: 1, member: alice.id, sealed: created.batch.envelopes![alice.id]},
      {epoch: 2, member: alice.id, sealed: join.batch.envelopes![alice.id]},
      {epoch: 2, member: bob.id, sealed: join.batch.envelopes![bob.id]},
    ],
    keys: {1: b64(keys[1]), 2: b64(keys[2])},
    enc: r.events.filter(e => e.enc).map(e => ({seq: e.seq, expect: openEnc(e, keys)})),
    invite: {link: inv.link, preview: inv.batch.preview!, previewPlain: preview},
    messages: [
      first,
      msg(alice, {t: 'file', files: [{blob: newId(), key: b64(randomBytes(32)), name: 'a.jpg', mime: 'image/jpeg', size: 1234, w: 10, h: 20}], body: 'caption'}, 2),
      msg(alice, {t: 'edit', target: first.message.id, body: 'hi again'}, 3),
      msg(bob, {t: 'reaction', target: first.message.id, emoji: '👍'}, 4),
    ],
    rtc: {from: alice.id, to: bob.id, box: sealSignal(alice, room, 2, join.key, bob.id, signal, now), now, expect: signal},
    blob: {key: b64(blob.key), sealed: b64(blob.sealed), plain: b64(blobPlain)},
    vault: {server, id: vk.id, blob: sealVault(vk, {v: 1, rooms: [room]}), rooms: [room]},
    view: normView(roomView(r, keys)),
  };
}

function checkVectors(v: Vectors) {
  const entropy = unb64(v.entropy);
  expect(phraseFromEntropy(entropy).join(' ')).toBe(v.phrase);
  expect(b64(entropyFromPhrase(v.phrase))).toBe(v.entropy);
  expect(identityFromEntropy(entropy).id).toBe(v.fingerprint);
  const alice = memberIdentity(entropy, v.room);
  const bob = memberIdentity(unb64(v.bobEntropy), v.room);
  expect(alice.id).toBe(v.aliceId);
  expect(bob.id).toBe(v.bobId);

  const r = replay(v.room, v.events);
  expect({nextSeq: r.state.nextSeq, head: r.state.head, epoch: r.state.epoch, members: r.state.members}).toEqual(v.expect);

  const link = parseInviteLink(v.invite.link)!;
  const inviteSeed = hkdf(link.secret, 'invite-sign');
  expect(b64(edPublicKey(inviteSeed))).toBe(r.events.find(e => e.kind === 'invite')!.pub.key);
  expect(b64(sign(inviteSeed, '', joinProofMessage(v.room, link.invite, bob.id)))).toBe(r.events.find(e => e.kind === 'join')!.pub.proof);
  expect(openPreview(link.secret, v.invite.preview)).toEqual(v.invite.previewPlain);

  const keys: Record<number, Uint8Array> = {};
  for (const e of v.envelopes) {
    const k = openEnvelope(e.member === alice.id ? alice : bob, v.room, e.epoch, e.sealed, r.commits[e.epoch]);
    expect(b64(k)).toBe(v.keys[e.epoch]);
    keys[e.epoch] = k;
  }
  expect(v.enc.length).toBeGreaterThanOrEqual(4);
  for (const x of v.enc) expect(openEnc(r.events[x.seq], keys)).toEqual(x.expect);

  expect(v.messages.length).toBeGreaterThanOrEqual(4);
  for (const m of v.messages) {
    const d = decryptMessage(m.message, keys[m.message.epoch]);
    expect(strip(d)).toEqual(m.expect);
    expect(d.ts).toBe(m.ts);
  }

  expect(strip(openSignal(v.room, v.rtc.from, v.rtc.to, v.rtc.box, keys[2], v.rtc.now))).toEqual(v.rtc.expect);
  expect(b64(decryptBlob(unb64(v.blob.key), unb64(v.blob.sealed)))).toBe(v.blob.plain);

  const vk = vaultKeys(entropy, v.vault.server);
  expect(vk.id).toBe(v.vault.id);
  expect(openVault(vk, v.vault.blob).rooms).toEqual(v.vault.rooms);

  expect(normView(roomView(r, keys))).toEqual(v.view);
}

describe('Go interop vectors', () => {
  it('writes vectors for the Go side, and they check out here too', () => {
    checkVectors(buildVectors());
    const file = path.join(VECTORS_DIR, 'ts-vectors.json');
    const rewrite = process.env.WRITE_FIXTURE === '1' || !fs.existsSync(file);
    // The committed file must still check out, unless it's being replaced.
    if (!rewrite) checkVectors(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (rewrite) {
      fs.mkdirSync(VECTORS_DIR, {recursive: true});
      fs.writeFileSync(file, JSON.stringify(buildVectors(), null, 2));
    }
  });

  it('opens what the Go side wrote', () => {
    const file = path.join(VECTORS_DIR, 'go-vectors.json');
    if (!fs.existsSync(file)) {
      console.warn('no go-vectors.json yet: run the shared/ Go tests first');
      return;
    }
    checkVectors(JSON.parse(fs.readFileSync(file, 'utf8')));
  });
});
