/**
 * @jest-environment node
 */
// End to end against a real server: two clients, each with its own copy of
// the app's store (jest.isolateModules), talking to a freshly built
// superchat-server over HTTP and WebSocket. Runs only with E2E=1, since it
// builds the Go server:
//
//   E2E=1 npx jest __tests__/e2e.test.ts
import {ChildProcess, execFileSync, spawn} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const run = process.env.E2E === '1' ? describe : describe.skip;

// Node has fetch but no XMLHttpRequest, which the app uses for binary
// transfers (React Native and browsers both have it). Enough of one for that.
class NodeXHR {
  status = 0;
  response: any = null;
  responseType = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private method = 'GET';
  private url = '';
  private headers: Record<string, string> = {};
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body?: Uint8Array) {
    fetch(this.url, {method: this.method, headers: this.headers, body: body as any})
      .then(async res => {
        this.status = res.status;
        this.response = this.responseType === 'arraybuffer' ? await res.arrayBuffer() : await res.text();
        this.onload?.();
      })
      .catch(() => this.onerror?.());
  }
}
(globalThis as any).XMLHttpRequest = NodeXHR;

type Client = {
  store: typeof import('../src/store');
  session: typeof import('../src/session');
  settings: typeof import('../src/settings');
  crypto: typeof import('../src/crypto');
  entropy: Uint8Array;
  /** This client's member ID in a room. */
  in: (roomKey: string) => string;
};

function client(server: string, entropy?: Uint8Array): Client {
  let c!: Client;
  jest.isolateModules(() => {
    const crypto = require('../src/crypto');
    const session = require('../src/session');
    const settings = require('../src/settings');
    const store = require('../src/store');
    const me = session.session.unlock(entropy ?? crypto.newIdentity().entropy);
    settings.settingsStore.update({servers: [server], defaultServer: server});
    c = {store, session, settings, crypto, entropy: me.entropy, in: (k: string) => store.getRoom(k)!.me.id};
  });
  return c;
}

async function until<T>(fn: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 50));
  }
}

run('end to end', () => {
  let server: ChildProcess;
  let url: string;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superchat-e2e-'));
    const bin = path.join(dir, 'superchat-server');
    execFileSync('go', ['build', '-o', bin, './cmd/superchat-server'], {
      cwd: path.resolve(__dirname, '../../server'),
      env: {...process.env, CGO_ENABLED: '0'},
    });
    const port = 20000 + Math.floor(Math.random() * 20000);
    url = `http://127.0.0.1:${port}`;
    server = spawn(bin, [], {
      env: {...process.env, SUPERCHAT_LISTEN_ADDR: `127.0.0.1:${port}`, SUPERCHAT_DATA_DIR: dir},
      stdio: 'ignore',
    });
    await until(async () => true, 100);
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(url + '/health')).ok) return;
      } catch {
        // not up yet
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('server did not start');
  }, 120_000);

  afterAll(() => {
    server?.kill();
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('creates, invites, chats, moderates and forgets', async () => {
    const alice = client(url);
    const bob = client(url);
    const carol = client(url);

    // Alice makes a room and says something before anyone else is in it.
    const key = await alice.store.createRoom(url, 'Den', '#4C8BF5', 30, 'Alice');
    await alice.store.openRoom(key);
    await alice.store.send(key, {t: 'text', body: 'before bob'});

    // She invites Bob with a single-use link.
    const link = await alice.store.makeInvite(key, {expiresAt: 0, maxUses: 1});
    const parsed = bob.crypto.parseInviteLink(link)!;
    const preview = await bob.store.previewInvite(parsed);
    expect(preview.name).toBe('Den');
    expect(preview.inviter).toBe('Alice');

    const bobKey = await bob.store.join(parsed, 'Bob');
    await bob.store.openRoom(bobKey);
    // Bob can't see what was said before he joined.
    expect(bob.store.getRoom(bobKey)!.messages.map(m => m.content && 'body' in m.content && m.content.body)).not.toContain(
      'before bob',
    );
    // Bob sees the room's name and Alice's display name.
    expect(bob.store.getRoom(bobKey)!.view!.name).toBe('Den');

    // Alice learns about Bob over the WebSocket, then they talk.
    await until(() => alice.store.getRoom(key)!.view!.members.length === 2);
    alice.store.connect(url);
    bob.store.connect(url);
    await new Promise(r => setTimeout(r, 300));
    await bob.store.send(bobKey, {t: 'text', body: 'hi alice'});
    const got = await until(() =>
      alice.store.getRoom(key)!.messages.find(m => m.content?.t === 'text' && m.content.body === 'hi alice'),
    );
    const bobId = bob.in(bobKey);
    const aliceId = alice.in(key);
    expect(got.sender).toBe(bobId);
    expect(alice.store.getRoom(key)!.view!.names[bobId]).toBe('Bob');

    // Reactions and an encrypted file.
    await alice.store.react(key, got.id, '👍');
    await until(() => bob.store.getRoom(bobKey)!.reactions[got.id]?.['👍']?.includes(aliceId));
    await alice.store.sendFiles(key, [{name: 'note.txt', mime: 'text/plain', data: alice.crypto.utf8('secret file')}], '');
    const fileMsg = await until(() => bob.store.getRoom(bobKey)!.messages.find(m => m.content?.t === 'file'));
    const ref = (fileMsg.content as any).files[0];
    expect(bob.crypto.unutf8(await bob.store.fetchFile(bobKey, ref))).toBe('secret file');

    // The invite was single use: Carol can't use it.
    await expect(carol.store.previewInvite(carol.crypto.parseInviteLink(link)!)).rejects.toThrow(/no longer valid/);

    // Bob deletes his own message; it's gone for Alice too.
    await bob.store.deleteMessage(bobKey, bob.store.getRoom(bobKey)!.messages.find(m => m.id === got.id)!);
    await until(() => !alice.store.getRoom(key)!.messages.some(m => m.id === got.id));

    // Bob (a member) can't make invites.
    await expect(bob.store.makeInvite(bobKey, {expiresAt: 0, maxUses: 0})).rejects.toThrow(/only admins/);

    // Alice promotes Bob; now he can.
    await alice.store.setRole(key, bobId, 'admin');
    await until(() => bob.store.getRoom(bobKey)!.view!.members.find(m => m.id === bobId)?.role === 'admin');
    const link2 = await bob.store.makeInvite(bobKey, {expiresAt: 0, maxUses: 0});

    // Carol joins with Bob's link; then Alice revokes it and removes Carol.
    const carolKey = await carol.store.join(carol.crypto.parseInviteLink(link2)!, 'Carol');
    await carol.store.openRoom(carolKey);
    const inviteId = link2.split('/i/')[1].split('#')[0];
    await alice.store.revokeInvite(key, inviteId);
    const epochBefore = alice.store.getRoom(key)!.log!.state.epoch;
    await alice.store.kick(key, carol.in(carolKey));
    const after = alice.store.getRoom(key)!.log!.state;
    expect(after.epoch).toBe(epochBefore + 1);
    expect(Object.keys(after.members).sort()).toEqual([aliceId, bobId].sort());

    // A message after the kick: Bob reads it, Carol can't fetch it at all.
    await alice.store.send(key, {t: 'text', body: 'after carol'});
    await until(() => bob.store.getRoom(bobKey)!.messages.some(m => m.content?.t === 'text' && m.content.body === 'after carol'));
    await until(() => !carol.store.getRoom(carolKey));

    // Retention is an admin setting everyone sees.
    await alice.store.setRetention(key, 1);
    await until(() => bob.store.getRoom(bobKey)!.view!.retentionDays === 1);

    // ---- what the server knows ----
    // Alice makes a second room. She's a different member there, and the
    // server's database has nothing that connects the two.
    const key2 = await alice.store.createRoom(url, 'Second', '#34C759', 0, 'Alice');
    const aliceId2 = alice.in(key2);
    expect(aliceId2).not.toBe(aliceId);
    const {DatabaseSync} = require('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'superchat.db'), {readOnly: true});
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t: any) => t.name);
    expect(tables).not.toContain('accounts');
    const rows: string[] = tables.flatMap((t: string) =>
      db.prepare(`SELECT * FROM "${t}"`).all().map((r: any) => JSON.stringify(r)),
    );
    db.close();
    const dump = rows.join('\n');
    // Every row that mentions Alice's room-1 key is about room 1 only, and
    // likewise for room 2.
    const room1 = key.split('|')[1];
    const room2 = key2.split('|')[1];
    expect(dump).toContain(aliceId);
    expect(dump).toContain(aliceId2);
    for (const row of rows) {
      if (row.includes(aliceId)) expect(row).not.toContain(room2);
      if (row.includes(aliceId2)) expect(row).not.toContain(room1);
      expect(row.includes(aliceId) && row.includes(aliceId2)).toBe(false);
    }
    // Nothing account-level is stored: no master key, no fingerprint.
    expect(dump).not.toContain(alice.session.session.get()!.id);

    // ---- restoring from the phrase ----
    // Flush Alice's (normally randomly delayed) vault write, then a fresh
    // install with only her phrase finds both rooms.
    alice.store.saveVaultSoon(url, 0);
    await new Promise(r => setTimeout(r, 300));
    const restored = client(url, alice.entropy);
    await restored.store.refreshRooms();
    const names = restored.store.roomList().map(r => r.name).sort();
    expect(names).toEqual(['Den', 'Second']);
    expect(restored.in(key)).toBe(aliceId);

    for (const c of [alice, bob, carol, restored]) c.store.disconnectAll();
  }, 60_000);
});
