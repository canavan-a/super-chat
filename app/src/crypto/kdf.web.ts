// Key-file scrypt in the browser: @noble/hashes (see kdf.ts for Android).
import {scryptAsync} from '@noble/hashes/scrypt';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  dkLen: number;
}

export const scrypt = (pass: Uint8Array, salt: Uint8Array, o: ScryptParams): Promise<Uint8Array> =>
  scryptAsync(pass, salt, o);
