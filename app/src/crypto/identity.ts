// An account is 32 bytes of entropy. The 24-word recovery phrase is those
// bytes. There is nothing else: no username, no password, no server-side
// login, and no account the server knows about at all. In each room you
// appear as a different member key derived from the entropy (memberIdentity),
// so no server can link your rooms to each other or to you.
import {entropyToMnemonic, mnemonicToEntropy, validateMnemonic} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english';
import {scrypt} from './kdf';

import {memberIdFromPub, randomBytes, unb64, utf8, b64} from './encoding';
import {aeadOpen, aeadSeal, edPublicKey, hkdf, xPublicKey} from './primitives';

/** The account: just the entropy, plus a local-only fingerprint of it. */
export interface Identity {
  entropy: Uint8Array;
  /** Shown on this device to tell accounts apart. Never sent anywhere. */
  id: string;
}

/** What you are inside one room: a signing key and an encryption key. */
export interface Member {
  edSeed: Uint8Array;
  edPub: Uint8Array;
  xPriv: Uint8Array;
  xPub: Uint8Array;
  id: string;
}

/** Anything that signs events and requests. */
export type Signer = Pick<Member, 'edSeed' | 'id'>;

export function identityFromEntropy(entropy: Uint8Array): Identity {
  if (entropy.length !== 32) throw new Error('entropy must be 32 bytes');
  return {entropy, id: memberIdFromPub(edPublicKey(hkdf(entropy, 'fingerprint')))};
}

/**
 * Your key pair in one room. Deterministic, so any device restored from the
 * phrase is the same member, and independent per room, so nobody without the
 * phrase can tell that two members are the same person.
 */
export function memberIdentity(entropy: Uint8Array, room: string): Member {
  const edSeed = hkdf(entropy, `room-ed25519|${room}`);
  const xPriv = hkdf(entropy, `room-x25519|${room}`);
  const edPub = edPublicKey(edSeed);
  return {edSeed, edPub, xPriv, xPub: xPublicKey(xPriv), id: memberIdFromPub(edPub)};
}

export function newIdentity(): Identity {
  return identityFromEntropy(randomBytes(32));
}

export function phraseFromEntropy(entropy: Uint8Array): string[] {
  return entropyToMnemonic(entropy, wordlist).split(' ');
}

/** Accepts any spacing/case. Throws with a readable message. */
export function entropyFromPhrase(phrase: string): Uint8Array {
  const words = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (words.split(' ').length !== 24) throw new Error('A recovery phrase is 24 words.');
  const unknown = words.split(' ').filter(w => !wordlist.includes(w));
  if (unknown.length) throw new Error(`Not in the word list: ${unknown.join(', ')}`);
  if (!validateMnemonic(words, wordlist)) throw new Error("Those words don't check out. Look for a typo or a swapped word.");
  return mnemonicToEntropy(words, wordlist);
}

export const WORDLIST = wordlist;

// ---- key file ----

// scrypt cost for the key file. 2^15 is well under a second natively (kdf.ts)
// and a few seconds in a phone's JS engine; the file is useless without the
// passphrase anyway, and the passphrase is the only thing this protects.
const SCRYPT = {N: 1 << 15, r: 8, p: 1};

export interface KeyFile {
  v: 1;
  kdf: 'scrypt';
  n: number;
  r: number;
  p: number;
  salt: string;
  ct: string;
  id: string;
}

export async function exportKeyFile(me: Identity, passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(utf8(passphrase), salt, {...SCRYPT, dkLen: 32});
  const file: KeyFile = {
    v: 1,
    kdf: 'scrypt',
    n: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt: b64(salt),
    ct: b64(aeadSeal(key, me.entropy, utf8('superchat-key'))),
    id: me.id,
  };
  return JSON.stringify(file, null, 2);
}

/** Parses a key file without unlocking it. Throws a readable message. */
export function checkKeyFile(json: string): KeyFile {
  let file: KeyFile;
  try {
    file = JSON.parse(json);
  } catch {
    throw new Error("That isn't a Super Chat key file. It should be the superchat-key.json you saved.");
  }
  if (file?.v !== 1 || file.kdf !== 'scrypt' || typeof file.salt !== 'string' || typeof file.ct !== 'string') {
    throw new Error("That isn't a Super Chat key file. It should be the superchat-key.json you saved.");
  }
  if (!(file.n > 0) || file.n > 1 << 20 || file.r > 16 || file.p > 4) throw new Error('This key file looks damaged.');
  return file;
}

export async function importKeyFile(json: string, passphrase: string): Promise<Identity> {
  const file = checkKeyFile(json);
  const key = await scrypt(utf8(passphrase), unb64(file.salt), {N: file.n, r: file.r, p: file.p, dkLen: 32});
  let entropy: Uint8Array;
  try {
    entropy = aeadOpen(key, unb64(file.ct), utf8('superchat-key'));
  } catch {
    throw new Error("That passphrase doesn't unlock this key file.");
  }
  return identityFromEntropy(entropy);
}
