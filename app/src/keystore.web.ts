// The web build has no hardware keystore, so the entropy is kept in
// localStorage encrypted under a passphrase (scrypt + XChaCha20-Poly1305,
// the same format as the exported key file) and unlocked every session.
import {exportKeyFile, identityFromEntropy, importKeyFile} from './crypto';

const KEY = 'superchat.identity.v1';

export type LockMode = 'biometric' | 'none';

export async function hasStoredIdentity(): Promise<boolean> {
  try {
    return !!localStorage.getItem(KEY);
  } catch {
    return false;
  }
}

export async function storeIdentity(entropy: Uint8Array, passphrase?: string): Promise<LockMode> {
  if (!passphrase) throw new Error('A passphrase is needed to keep your key in this browser.');
  localStorage.setItem(KEY, await exportKeyFile(identityFromEntropy(entropy), passphrase));
  return 'biometric';
}

export async function lockMode(): Promise<LockMode> {
  return 'biometric';
}

export async function loadIdentity(passphrase?: string): Promise<Uint8Array | null> {
  const file = localStorage.getItem(KEY);
  if (!file || !passphrase) return null;
  return (await importKeyFile(file, passphrase)).entropy;
}

export async function forgetIdentity(): Promise<void> {
  localStorage.removeItem(KEY);
}

export const NEEDS_PASSPHRASE = true;
