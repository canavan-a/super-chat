// Where the account's entropy lives: the Android Keystore or the iOS
// Keychain, via react-native-keychain, behind the device's biometrics or
// screen-lock PIN/passcode.
// Nothing else about the account is stored: every key is derived from it.
import {Platform} from 'react-native';
import * as Keychain from 'react-native-keychain';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {b64, unb64} from './crypto';

// Android v1 keys were made fingerprint-only. v2 keys also open with the
// screen-lock PIN (see patches/react-native-keychain). A Keystore key's rules
// can't change, so a v1 key is copied to v2 on its next unlock.
const LEGACY_SERVICE = 'superchat.identity.v1';
const SERVICE = Platform.OS === 'android' ? 'superchat.identity.v2' : LEGACY_SERVICE;
const MODE_KEY = 'superchat.keystore.mode';
// No longer written; still removed by forgetIdentity for older installs.
const ACCOUNT_KEY = 'superchat.keystore.account';

/** 'biometric': needs biometrics or the screen-lock PIN to open. 'none': the
 * device has no screen lock, so the Keystore can't require one. */
export type LockMode = 'biometric' | 'none';

const storedServices = (): Promise<string[]> =>
  Keychain.getAllGenericPasswordServices().catch(() => [] as string[]);

export async function hasStoredIdentity(): Promise<boolean> {
  const services = await storedServices();
  if (!services.includes(SERVICE) && !services.includes(LEGACY_SERVICE)) return false;
  // The iOS Keychain outlives the app, but AsyncStorage doesn't, and
  // storeIdentity always writes MODE_KEY. A key without it was left by a
  // deleted install: forget it, so removing the app erases the account on
  // iOS too, as the privacy policy says.
  if (Platform.OS === 'ios' && (await AsyncStorage.getItem(MODE_KEY)) === null) {
    await Keychain.resetGenericPassword({service: SERVICE}).catch(() => {});
    return false;
  }
  return true;
}

export async function storeIdentity(entropy: Uint8Array, _passphrase?: string): Promise<LockMode> {
  const mode = await storeUnder(SERVICE, entropy);
  // Only once the new copy is in place, so the account is never left unstored.
  if (SERVICE !== LEGACY_SERVICE) await Keychain.resetGenericPassword({service: LEGACY_SERVICE}).catch(() => {});
  return mode;
}

async function storeUnder(service: string, entropy: Uint8Array): Promise<LockMode> {
  await Keychain.resetGenericPassword({service}).catch(() => {});
  try {
    const ok = await Keychain.setGenericPassword('superchat', b64(entropy), {
      service,
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
    service,
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
  const legacy = SERVICE !== LEGACY_SERVICE && !(await storedServices()).includes(SERVICE);
  const creds = await Keychain.getGenericPassword({
    service: legacy ? LEGACY_SERVICE : SERVICE,
    authenticationPrompt: {title: 'Unlock Super Chat', cancel: 'Cancel'},
  });
  if (!creds) return null;
  const entropy = unb64(creds.password);
  // Move a fingerprint-only key to one the PIN opens too. In the background:
  // making a StrongBox key can take seconds. If it fails, the old key stays
  // and this is tried again next unlock.
  if (legacy) storeIdentity(entropy).catch(() => {});
  return entropy;
}

export async function forgetIdentity(): Promise<void> {
  await Keychain.resetGenericPassword({service: SERVICE});
  if (SERVICE !== LEGACY_SERVICE) await Keychain.resetGenericPassword({service: LEGACY_SERVICE}).catch(() => {});
  await AsyncStorage.multiRemove([MODE_KEY, ACCOUNT_KEY]);
}

/** Native unlocks by biometrics or the screen-lock PIN, not a passphrase. */
export const NEEDS_PASSPHRASE = false;
