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
    await expect(importKeyFile(file, 'wrong')).rejects.toThrow(/Wrong passphrase/);
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

  it('lets an invited account join, and only from that point on', () => {
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
// (server/proto/interop_test.go), so the two implementations are checked
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
    const file = path.resolve(__dirname, '../../server/proto/testdata/ts-log.json');
    expect(replay(out.room, out.events).state.head).toBe(out.expect.head);
    if (process.env.WRITE_FIXTURE === '1' || !fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify(out, null, 2));
    }
  });
});
