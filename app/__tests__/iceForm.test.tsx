import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Pressable, Text, TextInput} from 'react-native';

import {
  EMPTY_ICE_FORM,
  entryFromForm,
  entryKey,
  iceFormFrom,
  type IceForm,
} from '../src/call/iceConfig';

/** A button (Pressable): the outermost test node with an onPress handler. */
const isButton = (n: renderer.ReactTestInstance) =>
  typeof n.props.onPress === 'function' &&
  typeof n.parent?.props?.onPress !== 'function';

jest.mock('../src/call/testIce', () => ({testIceServer: jest.fn()}));

const form = (o: Partial<IceForm>): IceForm => ({...EMPTY_ICE_FORM, ...o});
const url = (o: Partial<IceForm>) => {
  const r = entryFromForm(form({username: 'u', password: 'p', ...o}));
  return 'entry' in r ? r.entry.urls : `error: ${r.error}`;
};

describe('the server form', () => {
  it('builds every standard URI form (RFC 7064 / 7065)', () => {
    expect(url({kind: 'stun', address: 'stun.example.com'})).toBe(
      'stun:stun.example.com',
    );
    expect(
      url({kind: 'stun', address: 'stun.example.com:3478', tls: true}),
    ).toBe('stuns:stun.example.com:3478');
    expect(url({kind: 'turn', address: 't.example.com:3478'})).toBe(
      'turn:t.example.com:3478',
    );
    expect(
      url({kind: 'turn', address: 't.example.com', transport: 'udp'}),
    ).toBe('turn:t.example.com?transport=udp');
    expect(
      url({kind: 'turn', address: 't.example.com', transport: 'tcp'}),
    ).toBe('turn:t.example.com?transport=tcp');
    expect(
      url({
        kind: 'turn',
        address: 't.example.com:443',
        tls: true,
        transport: 'tcp',
      }),
    ).toBe('turns:t.example.com:443?transport=tcp');
    expect(
      url({
        kind: 'turn',
        address: 't.example.com',
        tls: true,
        transport: 'udp',
      }),
    ).toBe('turns:t.example.com?transport=udp');
    expect(url({kind: 'turn', address: '[2001:db8::1]:3478'})).toBe(
      'turn:[2001:db8::1]:3478',
    );
    expect(url({kind: 'turn', address: '203.0.113.5'})).toBe(
      'turn:203.0.113.5',
    );
  });

  it('takes a pasted URL as it is, transport included', () => {
    expect(
      url({kind: 'turn', address: 'turns:t.example.com:5349?transport=tcp'}),
    ).toBe('turns:t.example.com:5349?transport=tcp');
    expect(url({kind: 'stun', address: 'stun:stun.l.google.com:19302'})).toBe(
      'stun:stun.l.google.com:19302',
    );
    expect(url({kind: 'stun', address: 'turn:t.example.com'})).toMatch(
      /That's a TURN address/,
    );
  });

  it('says what is missing', () => {
    expect(url({kind: 'turn', address: ''})).toMatch(
      /Enter the server address/,
    );
    expect(url({kind: 'turn', address: 'bad host'})).toMatch(/^error:/);
    expect(url({kind: 'turn', address: 't.example.com:99999'})).toMatch(/Port/);
    expect(
      entryFromForm(
        form({kind: 'turn', address: 't', username: '', password: 'p'}),
      ),
    ).toEqual({error: 'TURN needs a username'});
    expect(
      entryFromForm(
        form({kind: 'turn', address: 't', username: 'u', password: ''}),
      ),
    ).toEqual({error: 'TURN needs a password'});
    // Editing: a blank password keeps the saved one.
    expect(
      entryFromForm(
        form({kind: 'turn', address: 't', username: 'u', password: ''}),
        'saved',
      ),
    ).toEqual({
      entry: {urls: 'turn:t', username: 'u', credential: 'saved'},
    });
    // STUN takes no credentials.
    expect(
      entryFromForm(
        form({kind: 'stun', address: 's', username: 'u', password: 'p'}),
      ),
    ).toEqual({entry: {urls: 'stun:s'}});
  });

  it('round-trips a saved server into the form (without its password)', () => {
    for (const urls of [
      'stun:s:3478',
      'stuns:s',
      'turn:t:3478',
      'turn:t?transport=udp',
      'turns:t:443?transport=tcp',
    ]) {
      const f = iceFormFrom({urls, username: 'u', credential: 'secret'});
      expect(f.password).toBe('');
      const r = entryFromForm(f, 'secret');
      expect('entry' in r && r.entry.urls).toBe(urls);
    }
  });

  it('ties a test result to the exact credentials', () => {
    const a = {urls: 'turn:t', username: 'u', credential: 'one'};
    expect(entryKey(a)).not.toBe(entryKey({...a, credential: 'two'}));
  });
});

describe('Settings → Voice: add server', () => {
  const {testIceServer} = require('../src/call/testIce');
  const {VoiceSettings} = require('../src/components/VoiceSettings');
  const {ThemeProvider} = require('../src/theme');
  const {settingsStore} = require('../src/settings');

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const press = (tree: renderer.ReactTestRenderer, label: string) => {
    const btn = tree.root.findAll(
      n =>
        isButton(n) &&
        n.findAll(t => t.type === Text && t.props.children === label).length >
          0,
    )[0];
    return btn;
  };
  const input = (tree: renderer.ReactTestRenderer, label: string) =>
    tree.root.findAll(
      n => n.type === TextInput && n.props.accessibilityLabel === label,
    )[0];

  async function openForm() {
    await settingsStore.update({iceServers: []});
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ThemeProvider>
          <VoiceSettings />
        </ThemeProvider>,
      );
    });
    act(() => press(tree, 'Add server').props.onPress());
    return tree;
  }

  it('tests automatically and only saves a server that works', async () => {
    let resolve!: (r: {ok: boolean; message: string}) => void;
    testIceServer.mockImplementation(() => new Promise(r => (resolve = r)));
    const tree = await openForm();
    act(() =>
      input(tree, 'Server address').props.onChangeText('turn.example.com:3478'),
    );
    act(() => input(tree, 'Username').props.onChangeText('alice'));
    act(() => input(tree, 'Password').props.onChangeText('wrong'));
    expect(press(tree, 'Save').props.disabled).toBe(true);

    act(() => jest.advanceTimersByTime(800));
    expect(testIceServer).toHaveBeenLastCalledWith({
      urls: 'turn:turn.example.com:3478',
      username: 'alice',
      credential: 'wrong',
    });
    await act(async () =>
      resolve({
        ok: false,
        message: '✗ Your TURN server rejected the username or password.',
      }),
    );
    expect(press(tree, 'Save').props.disabled).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toContain(
      'rejected the username or password',
    );

    // Fixing the password re-tests; a pass enables Save.
    act(() => input(tree, 'Password').props.onChangeText('right'));
    act(() => jest.advanceTimersByTime(800));
    await act(async () => resolve({ok: true, message: '✓ Relay works'}));
    expect(press(tree, 'Save').props.disabled).toBe(false);

    // Any change afterwards needs a new pass.
    act(() => input(tree, 'Username').props.onChangeText('alice2'));
    expect(press(tree, 'Save').props.disabled).toBe(true);
    act(() => input(tree, 'Username').props.onChangeText('alice'));
    act(() => jest.advanceTimersByTime(800));
    await act(async () => resolve({ok: true, message: '✓ Relay works'}));

    await act(async () => press(tree, 'Save').props.onPress());
    expect(settingsStore.get().iceServers).toEqual([
      {
        urls: 'turn:turn.example.com:3478',
        username: 'alice',
        credential: 'right',
      },
    ]);
  });
});
