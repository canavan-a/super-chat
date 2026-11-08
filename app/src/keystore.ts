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
// can't change, so a v1 key is copied to v2 on unlock, and v1 is only deleted
// once v2 has unlocked by itself.
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

const storeLocked = (service: string, entropy: Uint8Array) =>
  Keychain.setGenericPassword('superchat', b64(entropy), {
    service,
    accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    storage: Keychain.STORAGE_TYPE.RSA,
    securityLevel: Keychain.SECURITY_LEVEL.ANY,
  });

async function storeUnder(service: string, entropy: Uint8Array): Promise<LockMode> {
  await Keychain.resetGenericPassword({service}).catch(() => {});
  try {
    const ok = await storeLocked(service, entropy);
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

const read = (service: string) =>
  Keychain.getGenericPassword({
    service,
    authenticationPrompt: {title: 'Unlock Super Chat', cancel: 'Cancel'},
  });

/** Prompts for biometrics/PIN (if the key needs it). Null if cancelled. */
export async function loadIdentity(_passphrase?: string): Promise<Uint8Array | null> {
  if (SERVICE === LEGACY_SERVICE) {
    const creds = await read(SERVICE);
    return creds ? unb64(creds.password) : null;
  }
  // Android. Don't pick the entry from getAllGenericPasswordServices: it
  // lists Keystore key aliases, and a v2 key can exist without a stored entry
  // (a copy that failed halfway). Reading an entry that isn't there answers
  // false without a prompt, so try v2 and fall back to v1.
  try {
    const creds = await read(SERVICE);
    if (creds) {
      // v2 works: the fingerprint-only v1 copy can go.
      if ((await storedServices()).includes(LEGACY_SERVICE)) {
        Keychain.resetGenericPassword({service: LEGACY_SERVICE}).catch(() => {});
      }
      return unb64(creds.password);
    }
  } catch (e) {
    // The person cancelled: don't ask them again for the old key.
    if (/cancel/i.test((e as Error).message ?? '')) throw e;
    if (!(await storedServices()).includes(LEGACY_SERVICE)) throw e;
  }
  const creds = await read(LEGACY_SERVICE);
  if (!creds) return null;
  const entropy = unb64(creds.password);
  // Copy to a v2 key the PIN opens too. Locked storage only, never the
  // unprotected fallback, and v1 stays until v2 has unlocked. In the
  // background: making a StrongBox key can take seconds. If it fails, this
  // is tried again next unlock.
  if ((await lockMode()) === 'biometric') {
    Keychain.resetGenericPassword({service: SERVICE})
      .catch(() => {})
      .then(() => storeLocked(SERVICE, entropy))
      .catch(() => {});
  }
  return entropy;
}

export async function forgetIdentity(): Promise<void> {
  await Keychain.resetGenericPassword({service: SERVICE});
  if (SERVICE !== LEGACY_SERVICE) await Keychain.resetGenericPassword({service: LEGACY_SERVICE}).catch(() => {});
  await AsyncStorage.multiRemove([MODE_KEY, ACCOUNT_KEY]);
}

/** Native unlocks by biometrics or the screen-lock PIN, not a passphrase. */
export const NEEDS_PASSPHRASE = false;
