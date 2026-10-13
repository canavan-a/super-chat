// Where the account's entropy lives on Android: the Keystore, via
// react-native-keychain, behind the device's biometrics or screen-lock PIN.
// Nothing else about the account is stored: every key is derived from it.
import * as Keychain from 'react-native-keychain';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {b64, unb64} from './crypto';

const SERVICE = 'superchat.identity.v1';
const MODE_KEY = 'superchat.keystore.mode';

/** 'biometric': needs biometrics or the screen-lock PIN to open. 'none': the
 * device has no screen lock, so the Keystore can't require one. */
export type LockMode = 'biometric' | 'none';

export async function hasStoredIdentity(): Promise<boolean> {
  const services = await Keychain.getAllGenericPasswordServices().catch(() => [] as string[]);
  return services.includes(SERVICE);
}

export async function storeIdentity(entropy: Uint8Array, _passphrase?: string): Promise<LockMode> {
  await Keychain.resetGenericPassword({service: SERVICE}).catch(() => {});
  try {
    const ok = await Keychain.setGenericPassword('superchat', b64(entropy), {
      service: SERVICE,
      accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      storage: Keychain.STORAGE_TYPE.RSA,
      securityLevel: Keychain.SECURITY_LEVEL.ANY,
    });
    if (ok) {
      await AsyncStorage.setItem(MODE_KEY, 'biometric');
      return 'biometric';
    }
  } catch {
    // No biometrics or screen lock set up: fall through.
  }
  await Keychain.setGenericPassword('superchat', b64(entropy), {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    storage: Keychain.STORAGE_TYPE.AES,
  });
  await AsyncStorage.setItem(MODE_KEY, 'none');
  return 'none';
}

export async function lockMode(): Promise<LockMode> {
  return ((await AsyncStorage.getItem(MODE_KEY)) as LockMode) ?? 'biometric';
}

/** Prompts for biometrics/PIN (if the key needs it). Null if cancelled. */
export async function loadIdentity(_passphrase?: string): Promise<Uint8Array | null> {
  const creds = await Keychain.getGenericPassword({
    service: SERVICE,
    authenticationPrompt: {title: 'Unlock Super Chat', cancel: 'Cancel'},
  });
  if (!creds) return null;
  return unb64(creds.password);
}

export async function forgetIdentity(): Promise<void> {
  await Keychain.resetGenericPassword({service: SERVICE});
  await AsyncStorage.removeItem(MODE_KEY);
}

/** Native unlocks by biometrics, not a passphrase. */
export const NEEDS_PASSPHRASE = false;
