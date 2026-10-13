// Your room list, kept on each server as an encrypted blob so a device
// restored from the recovery phrase can find your rooms again without the
// server ever having an account for you (docs/protocol.md, "Finding your
// rooms again"). The vault's ID, its write key and its encryption key are all
// derived from the phrase; the server sees an opaque, padded blob at a random
// looking ID, and can't connect it to any room.
import {sha256} from '@noble/hashes/sha256';

import {b64, concat, memberIdFromPub, unb64, unutf8, utf8} from './encoding';
import {aeadOpen, aeadSeal, edPublicKey, hkdf} from './primitives';
import type {Signer} from './identity';

export interface VaultData {
  v: 1;
  /** Room IDs on this server. */
  rooms: string[];
}

export interface VaultKeys {
  id: string;
  signer: Signer;
  key: Uint8Array;
}

// Per server, so two servers can't match up the same vault.
export function vaultKeys(entropy: Uint8Array, server: string): VaultKeys {
  const edSeed = hkdf(entropy, `vault-sign|${server}`);
  const pub = edPublicKey(edSeed);
  return {
    id: b64(sha256(concat(utf8('sc-vault'), pub)).subarray(0, 16)),
    signer: {edSeed, id: memberIdFromPub(pub)},
    key: hkdf(entropy, `vault-enc|${server}`),
  };
}

// Blobs are padded to a multiple of this, so the size says little about how
// many rooms are in it.
const BUCKET = 4096;

export function sealVault(k: VaultKeys, data: VaultData): string {
  const json = utf8(JSON.stringify(data));
  const padded = new Uint8Array(Math.ceil((json.length + 4) / BUCKET) * BUCKET);
  new DataView(padded.buffer).setUint32(0, json.length);
  padded.set(json, 4);
  return b64(aeadSeal(k.key, padded, utf8('sc-vault|' + k.id)));
}

export function openVault(k: VaultKeys, blob: string): VaultData {
  const padded = aeadOpen(k.key, unb64(blob), utf8('sc-vault|' + k.id));
  const len = new DataView(padded.buffer, padded.byteOffset).getUint32(0);
  const data = JSON.parse(unutf8(padded.subarray(4, 4 + len)));
  if (data?.v !== 1 || !Array.isArray(data.rooms)) throw new Error('bad vault');
  return data;
}
