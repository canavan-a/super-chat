// The App Store build: which build it says it is, abuse reports, and the
// iOS Keychain left over from a deleted install. Jest's react-native preset
// runs as iOS.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

import {distribution, isSideload} from '../src/distribution';
import {hasStoredIdentity} from '../src/keystore';
import {reportMailto} from '../src/privacy/contact';

const body = (url: string) => decodeURIComponent(new URL(url).searchParams.get('body') ?? '');

describe('iOS build', () => {
  it('is the ios distribution, not sideload', () => {
    expect(distribution).toBe('ios');
    expect(isSideload).toBe(false);
  });
});

describe('reportMailto', () => {
  it('names the room and member, and nothing else', () => {
    const url = reportMailto({server: 'https://chat.example', room: 'r123', member: 'm456', name: 'Sam & co'});
    expect(url.startsWith('mailto:')).toBe(true);
    expect(body(url)).toBe('Server: https://chat.example\nRoom: r123\nMember: Sam & co (m456)\n\nWhat happened?\n\n');
  });

  it('asks which room when reported from Settings', () => {
    expect(body(reportMailto())).toContain('Which room is it');
  });
});

describe('hasStoredIdentity on iOS', () => {
  const services = Keychain.getAllGenericPasswordServices as jest.Mock;
  const reset = Keychain.resetGenericPassword as jest.Mock;

  beforeEach(async () => {
    await AsyncStorage.clear();
    reset.mockClear();
    services.mockResolvedValue(['superchat.identity.v1']);
  });
  afterAll(() => services.mockResolvedValue([]));

  it('keeps a key this install stored', async () => {
    await AsyncStorage.setItem('superchat.keystore.mode', 'biometric');
    expect(await hasStoredIdentity()).toBe(true);
    expect(reset).not.toHaveBeenCalled();
  });

  it('forgets a key left by a deleted install', async () => {
    expect(await hasStoredIdentity()).toBe(false);
    expect(reset).toHaveBeenCalledWith({service: 'superchat.identity.v1'});
  });
});
