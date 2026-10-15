import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Pressable, Text} from 'react-native';

import {alreadyAdded, describeIce, sharedEntry} from '../src/call/iceShare';

jest.mock('../src/call/testIce', () => ({testIceServer: jest.fn()}));
jest.mock('../src/platformConfirm', () => ({
  platformConfirm: (_t: string, _m: string, _l: string, ok: () => void) => ok(),
}));
const mockSend = jest.fn(async () => {});
jest.mock('../src/store', () => {
  const actual = jest.requireActual('../src/store');
  return {
    ...actual,
    send: (...a: unknown[]) => mockSend(...(a as [])),
    roomList: () => [
      {
        key: 's|1',
        server: 's',
        id: '1',
        name: 'Den',
        color: '#4C8BF5',
        picture: null,
        unread: false,
        unreadCount: 0,
        preview: null,
        lastAt: 2,
      },
      {
        key: 's|2',
        server: 's',
        id: '2',
        name: 'Sam',
        color: '#34C759',
        picture: null,
        unread: false,
        unreadCount: 0,
        preview: null,
        lastAt: 1,
      },
    ],
    useStore: (f: () => unknown) => f(),
  };
});

const TURN = {
  urls: 'turn:ice.aidan.house?transport=udp',
  username: 'alice',
  credential: 's3cret',
};

describe('a shared server', () => {
  it('only accepts a valid server, credentials only for TURN', () => {
    expect(sharedEntry(TURN)).toEqual(TURN);
    expect(
      sharedEntry({
        urls: 'stun:s.example.com:3478',
        username: 'x',
        credential: 'y',
      }),
    ).toEqual({urls: 'stun:s.example.com:3478'});
    for (const bad of [
      null,
      'turn:x',
      {urls: 'http://evil'},
      {urls: 'turn:x'}, // no credentials
      {urls: 'turn:x', username: 'u', credential: ''},
      {urls: 'turn:x', username: 'u', credential: 7},
      {urls: 'turn:x', username: 'u'.repeat(600), credential: 'p'},
    ]) {
      expect(sharedEntry(bad)).toBeNull();
    }
  });

  it('describes itself and knows when it is already added', () => {
    expect(describeIce(TURN)).toEqual({
      kind: 'TURN',
      host: 'ice.aidan.house',
      transport: 'UDP',
      tls: false,
    });
    expect(alreadyAdded(TURN, [TURN])).toBe(true);
    expect(alreadyAdded(TURN, [{...TURN, credential: 'other'}])).toBe(false);
  });
});

describe('sharing and adding', () => {
  const {testIceServer} = require('../src/call/testIce');
  const {IceServerCard} = require('../src/components/IceServerCard');
  const {IceShareSheet} = require('../src/components/IceShareSheet');
  const {ThemeProvider} = require('../src/theme');
  const {settingsStore} = require('../src/settings');

  const button = (tree: renderer.ReactTestRenderer, label: string | RegExp) =>
    tree.root
      .findAll(
        n =>
          n.type === Pressable &&
          n.findAll(
            t =>
              t.type === Text &&
              (typeof label === 'string'
                ? t.props.children === label
                : label.test(String(t.props.children))),
          ).length > 0,
      )
      .at(-1)!;
  // All visible text, joined (the sheet's list doesn't serialize as JSON).
  const texts = (tree: renderer.ReactTestRenderer) =>
    tree.root
      .findAll(n => n.type === Text)
      .map(n => [].concat(n.props.children).join(''))
      .join(' | ');
  const render = (el: React.ReactElement) => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<ThemeProvider>{el}</ThemeProvider>);
    });
    return tree;
  };

  it('shares a server to a chat picked from the recent list', async () => {
    const onClose = jest.fn();
    const tree = render(<IceShareSheet entry={TURN} onClose={onClose} />);
    expect(texts(tree)).toContain('Den');
    await act(async () => button(tree, 'Sam').props.onPress());
    expect(mockSend).toHaveBeenCalledWith('s|2', {t: 'ice', server: TURN});
    expect(texts(tree)).toContain('Shared with Sam');
  });

  it('shows the server, tests it, and adds it only once it works', async () => {
    await settingsStore.update({iceServers: []});
    let resolve!: (r: {ok: boolean; message: string}) => void;
    testIceServer.mockImplementation(() => new Promise(r => (resolve = r)));
    const tree = render(
      <IceServerCard server={TURN} mine={false} sharedBy="Sam" color="#000" />,
    );
    act(() => button(tree, 'Add').props.onPress());
    const json = () => texts(tree);
    expect(json()).toContain('ice.aidan.house');
    expect(json()).toContain('alice');
    expect(json()).not.toContain('s3cret'); // hidden until "Show"
    expect(testIceServer).toHaveBeenCalledWith(TURN);
    const add = () => button(tree, 'Add').props;
    expect(add().disabled).toBe(true);

    await act(async () =>
      resolve({
        ok: false,
        message: '✗ Your TURN server rejected the username or password.',
      }),
    );
    expect(add().disabled).toBe(true);

    act(() => {
      button(tree, 'Test').props.onPress();
    });
    await act(async () => resolve({ok: true, message: '✓ Relay works'}));
    expect(add().disabled).toBe(false);
    act(() => button(tree, 'Show').props.onPress());
    expect(json()).toContain('s3cret');

    await act(async () => add().onPress());
    expect(settingsStore.get().iceServers).toEqual([TURN]);
    expect(json()).toContain('Added ✓');
  });

  it("doesn't offer to add a server that isn't valid", () => {
    const tree = render(
      <IceServerCard
        server={{urls: 'http://evil'}}
        mine={false}
        sharedBy="Sam"
        color="#000"
      />,
    );
    expect(texts(tree)).toContain("couldn't be read");
    expect(button(tree, 'Add')).toBeUndefined();
  });
});
