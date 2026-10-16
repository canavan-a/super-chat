import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {AppState, Pressable, ScrollView, Text} from 'react-native';

import {Overlay} from '../src/components/Overlay';
import {PortalOutlet, PortalProvider} from '../src/components/Portal';

/** A button (Pressable): the outermost test node with an onPress handler. */
const isButton = (n: renderer.ReactTestInstance) =>
  typeof n.props.onPress === 'function' &&
  typeof n.parent?.props?.onPress !== 'function';

const mockLoad = jest.fn();
jest.mock('../src/keystore', () => ({
  loadIdentity: (...a: unknown[]) => mockLoad(...a),
  NEEDS_PASSPHRASE: false,
}));
jest.mock('../src/logo/LogoArt', () => ({LogoArt: () => null}));

describe('modal sheets', () => {
  it('draw at the app root, not inside the scrolling page that opened them', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <PortalProvider>
          <ScrollView testID="page">
            <Overlay visible modal onClose={() => {}}>
              <Text>sheet</Text>
            </Overlay>
          </ScrollView>
          <PortalOutlet />
        </PortalProvider>,
      );
    });
    const page = tree.root.findByProps({testID: 'page'});
    expect(page.findAll(n => n.type === Text)).toHaveLength(0);
    expect(
      tree.root.findAll(n => n.type === Text && n.props.children === 'sheet'),
    ).toHaveLength(1);
    // Closing it removes it from the root too.
    act(() => {
      tree.update(
        <PortalProvider>
          <ScrollView testID="page" />
          <PortalOutlet />
        </PortalProvider>,
      );
    });
    expect(
      tree.root.findAll(n => n.type === Text && n.props.children === 'sheet'),
    ).toHaveLength(0);
  });

  it('render in place when there is no portal host', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <Overlay visible modal onClose={() => {}}>
          <Text>sheet</Text>
        </Overlay>,
      );
    });
    expect(
      tree.root.findAll(n => n.type === Text && n.props.children === 'sheet'),
    ).toHaveLength(1);
  });
});

describe('fingerprint unlock', () => {
  const {LockScreen} = require('../src/screens/LockScreen');
  const {ThemeProvider} = require('../src/theme');
  let appState: string;
  let appStateListener: ((s: string) => void) | null;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLoad.mockReset();
    appState = 'active';
    appStateListener = null;
    Object.defineProperty(AppState, 'currentState', {
      get: () => appState,
      configurable: true,
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _: string,
      l: (s: string) => void,
    ) => {
      appStateListener = l;
      return {remove: () => {}};
    }) as any);
    (globalThis as any).requestAnimationFrame = (f: () => void) =>
      setTimeout(f, 0);
  });
  afterEach(() => jest.useRealTimers());

  const render = (onUnlock = jest.fn()) => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ThemeProvider>
          <LockScreen onUnlock={onUnlock} onForget={() => {}} />
        </ThemeProvider>,
      );
    });
    return tree;
  };
  const unlockButton = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll(
      n =>
        isButton(n) &&
        n.findAll(t => t.type === Text && t.props.children === 'Unlock')
          .length > 0,
    )[0];

  it('waits until the app is in front before asking', () => {
    appState = 'background';
    mockLoad.mockReturnValue(new Promise(() => {}));
    render();
    act(() => jest.advanceTimersByTime(2000));
    expect(mockLoad).not.toHaveBeenCalled();
    act(() => appStateListener?.('active'));
    act(() => jest.advanceTimersByTime(400));
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it('frees Unlock if the prompt never answers, and a late answer still unlocks', async () => {
    let answer!: (v: Uint8Array) => void;
    mockLoad.mockReturnValueOnce(new Promise(r => (answer = r)));
    const onUnlock = jest.fn();
    const tree = render(onUnlock);
    act(() => jest.advanceTimersByTime(400));
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(unlockButton(tree).props.disabled).toBe(true);

    act(() => jest.advanceTimersByTime(6000));
    expect(unlockButton(tree).props.disabled).toBe(false);

    await act(async () => answer(new Uint8Array([1, 2, 3])));
    act(() => jest.advanceTimersByTime(50));
    expect(onUnlock).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });
});
