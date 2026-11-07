// Big-buffer work (attachments: up to 24 MB) done a slice at a time, handing
// the JS thread back between slices so taps and scrolling never wait on it.
//
// aeadOpenAsync/aeadSealAsync are byte-for-byte XChaCha20-Poly1305 as in
// primitives.ts (RFC 8439 construction, noble's xchacha20poly1305): the same
// stream and tag, just computed in pieces. Small inputs take the one-shot path.
import {xchacha20} from '@noble/ciphers/chacha';
import {poly1305} from '@noble/ciphers/_poly1305';
import {base64} from '@scure/base';
import {aeadOpen, aeadSeal} from './primitives';
import {randomBytes} from './encoding';

/** Bytes of cipher work between yields: a multiple of the 64-byte ChaCha block. */
const CHUNK = 128 * 1024;
/** base64 slices: multiples of 3 bytes (encode) and 4 chars (decode), so they join cleanly. */
const B64_BYTES = 3 * 64 * 1024;
const B64_CHARS = 4 * 64 * 1024;

const pause = () => new Promise<void>(res => setTimeout(res, 0));
const ZEROS16 = new Uint8Array(16);

type Mac = ReturnType<typeof poly1305.create>;

function padTo16(h: Mac, len: number) {
  const left = len % 16;
  if (left) h.update(ZEROS16.subarray(left));
}

function lengths(adLen: number, dataLen: number): Uint8Array {
  const out = new Uint8Array(16);
  const v = new DataView(out.buffer);
  v.setUint32(0, adLen >>> 0, true);
  v.setUint32(4, Math.floor(adLen / 2 ** 32), true);
  v.setUint32(8, dataLen >>> 0, true);
  v.setUint32(12, Math.floor(dataLen / 2 ** 32), true);
  return out;
}

async function tag(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  const h = poly1305.create(xchacha20(key, nonce, new Uint8Array(32)));
  h.update(ad);
  padTo16(h, ad.length);
  for (let off = 0; off < ct.length; off += CHUNK) {
    h.update(ct.subarray(off, off + CHUNK));
    await pause();
  }
  padTo16(h, ct.length);
  h.update(lengths(ad.length, ct.length));
  return h.digest();
}

/** XORs the keystream over buf in place, from block 1 on (block 0 keys the MAC). */
async function xorInPlace(key: Uint8Array, nonce: Uint8Array, buf: Uint8Array): Promise<void> {
  for (let off = 0; off < buf.length; off += CHUNK) {
    const part = buf.subarray(off, off + CHUNK);
    xchacha20(key, nonce, part, part, 1 + off / 64);
    await pause();
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function aeadOpenAsync(key: Uint8Array, sealed: Uint8Array, ad: Uint8Array): Promise<Uint8Array> {
  if (sealed.length <= CHUNK) return aeadOpen(key, sealed, ad);
  const nonce = sealed.subarray(0, 24);
  const ct = sealed.subarray(24, -16);
  // Authenticate first: nothing unverified is ever handed back.
  if (!equal(await tag(key, nonce, ad, ct), sealed.subarray(-16))) throw new Error('invalid tag');
  const out = ct.slice();
  await xorInPlace(key, nonce, out);
  return out;
}

export async function aeadSealAsync(key: Uint8Array, data: Uint8Array, ad: Uint8Array): Promise<Uint8Array> {
  if (data.length <= CHUNK) return aeadSeal(key, data, ad);
  const nonce = randomBytes(24);
  const out = new Uint8Array(24 + data.length + 16);
  out.set(nonce, 0);
  const ct = out.subarray(24, 24 + data.length);
  ct.set(data);
  await xorInPlace(key, nonce, ct);
  out.set(await tag(key, nonce, ad, ct), 24 + data.length);
  return out;
}

export async function b64EncodeAsync(data: Uint8Array): Promise<string> {
  if (data.length <= B64_BYTES) return base64.encode(data);
  const parts: string[] = [];
  for (let off = 0; off < data.length; off += B64_BYTES) {
    parts.push(base64.encode(data.subarray(off, off + B64_BYTES)));
    await pause();
  }
  return parts.join('');
}

export async function b64DecodeAsync(s: string): Promise<Uint8Array> {
  if (s.length <= B64_CHARS) return base64.decode(s);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let off = 0; off < s.length; off += B64_CHARS) {
    const p = base64.decode(s.slice(off, off + B64_CHARS));
    parts.push(p);
    total += p.length;
    await pause();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
