import React from 'react';
import {BackHandler, TextInput} from 'react-native';
import renderer, {act, ReactTestInstance} from 'react-test-renderer';
import {describe, expect, it, jest, beforeEach} from '@jest/globals';

import {exportKeyFile, newIdentity} from '../src/crypto';
import {OnboardingScreen} from '../src/screens/OnboardingScreen';
import {ThemeProvider} from '../src/theme';

const picked: {next: any} = {next: null};
const saved: {calls: number; fail: boolean} = {calls: 0, fail: false};
jest.mock('../src/files', () => ({
  pickTextFile: async () => picked.next,
  saveTextFileAs: async (_name: string, makeText: () => Promise<string>) => {
    saved.calls++;
    await makeText();
    if (saved.fail) throw new Error('disk full');
    return {name: 'superchat-key.json', location: 'the folder you picked'};
  },
}));
jest.mock('../src/keystore', () => ({
  NEEDS_PASSPHRASE: false,
  storeIdentity: async () => 'biometric',
}));
jest.mock('../src/logo/LogoArt', () => ({LogoArt: () => null}));
jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  require('react-native/Libraries/Utilities/__mocks__/BackHandler'),
);

const flush = () => act(async () => {});

function mount() {
  const onDone = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ThemeProvider>
        <OnboardingScreen onDone={onDone} />
      </ThemeProvider>,
    );
  });
  return {tree, onDone};
}

const texts = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => typeof n.props.children === 'string' || Array.isArray(n.props.children))
    .flatMap(n => (Array.isArray(n.props.children) ? n.props.children : [n.props.children]))
    .filter(c => typeof c === 'string')
    .join(' | ');

function press(t: renderer.ReactTestRenderer, label: string) {
  const target = t.root.find(
    n => typeof n.props.onPress === 'function' && texts({root: n} as any).includes(label),
  );
  return act(async () => {
    await target.props.onPress();
  });
}

function type(input: ReactTestInstance, text: string) {
  act(() => input.props.onChangeText(text));
}

const back = () =>
  act(() => {
    (BackHandler as any).mockPressBack();
  });

describe('onboarding', () => {
  beforeEach(() => {
    picked.next = null;
    saved.calls = 0;
    saved.fail = false;
  });

  it('goes back with both the Back link and the hardware button', async () => {
    const {tree} = mount();
    await press(tree, 'Create a new account');
    expect(texts(tree)).toContain('Your recovery phrase');
    back();
    expect(texts(tree)).toContain('Create a new account');
    await press(tree, 'I have a recovery phrase');
    expect(texts(tree)).toContain('Enter your 24 words');
    await press(tree, 'Back');
    expect(texts(tree)).toContain('Create a new account');
  });

  it('confirms a saved key file and then skips the word check', async () => {
    const {tree, onDone} = mount();
    await press(tree, 'Create a new account');
    await press(tree, 'Also save a key file');
    const [p1, p2] = tree.root.findAllByType(TextInput);
    type(p1, 'correct horse');
    type(p2, 'correct horse');
    await press(tree, 'Save key file');
    await flush();
    expect(saved.calls).toBe(1);
    expect(texts(tree)).toContain('Key file saved');
    expect(texts(tree)).toContain('the folder you picked');
    await press(tree, 'Continue');
    await flush();
    expect(texts(tree)).not.toContain('Check your phrase');
    expect(onDone).toHaveBeenCalled();
  });

  it('says so when saving the key file fails', async () => {
    saved.fail = true;
    const {tree} = mount();
    await press(tree, 'Create a new account');
    await press(tree, 'Also save a key file');
    const [p1, p2] = tree.root.findAllByType(TextInput);
    type(p1, 'correct horse');
    type(p2, 'correct horse');
    await press(tree, 'Save key file');
    await flush();
    expect(texts(tree)).toContain("The key file wasn't saved");
    expect(texts(tree)).toContain('disk full');
  });

  it('rejects a file that is not a key file before asking for a passphrase', async () => {
    picked.next = {name: 'photo.jpg', text: 'not json'};
    const {tree} = mount();
    await press(tree, 'Import a key file');
    expect(texts(tree)).toContain("Couldn't use that file");
    expect(texts(tree)).toContain('Create a new account'); // still on welcome
  });

  it('shows a wrong passphrase, then success, when importing a key file', async () => {
    const me = newIdentity();
    picked.next = {name: 'superchat-key.json', text: await exportKeyFile(me, 'right one')};
    const {tree, onDone} = mount();
    await press(tree, 'Import a key file');
    expect(texts(tree)).toContain('Unlock key file');
    expect(texts(tree)).toContain('superchat-key.json');

    const input = tree.root.findByType(TextInput);
    type(input, 'wrong one');
    await press(tree, 'Unlock');
    await flush();
    expect(texts(tree)).toContain("doesn't unlock this key file");

    type(tree.root.findByType(TextInput), 'right one');
    await press(tree, 'Unlock');
    await flush();
    expect(texts(tree)).toContain('Account restored');
    await press(tree, 'Continue');
    await flush();
    expect(onDone).toHaveBeenCalledWith(me.entropy);

    // Back from the import steps returns to the start.
    back();
  });
});
