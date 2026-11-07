import {aeadOpen, aeadSeal} from '../src/crypto/primitives';
import {aeadOpenAsync, aeadSealAsync, b64DecodeAsync, b64EncodeAsync} from '../src/crypto/chunked';
const randomBytes = (n: number) => Uint8Array.from({length: n}, (_, i) => (i * 7919 + n) & 255);
import {base64} from '@scure/base';

const ad = new TextEncoder().encode('sc-blob');

describe('chunked AEAD and base64', () => {
  for (const size of [0, 1, 1000, 128 * 1024, 128 * 1024 + 1, 300_001, 1024 * 1024 + 17]) {
    it(`matches the one-shot cipher at ${size} bytes`, async () => {
      const key = randomBytes(32);
      const data = randomBytes(size);
      const sealed = aeadSeal(key, data, ad);
      expect(Buffer.from(await aeadOpenAsync(key, sealed, ad)).equals(Buffer.from(data))).toBe(true);
      const sealed2 = await aeadSealAsync(key, data, ad);
      expect(Buffer.from(aeadOpen(key, sealed2, ad)).equals(Buffer.from(data))).toBe(true);
      expect(await b64EncodeAsync(sealed)).toBe(base64.encode(sealed));
      expect(Buffer.from(await b64DecodeAsync(base64.encode(sealed))).equals(Buffer.from(sealed))).toBe(true);
    });
  }

  it('rejects a tampered large blob', async () => {
    const key = randomBytes(32);
    const sealed = aeadSeal(key, randomBytes(500_000), ad);
    sealed[1000] ^= 1;
    await expect(aeadOpenAsync(key, sealed, ad)).rejects.toThrow('invalid tag');
  });
});
