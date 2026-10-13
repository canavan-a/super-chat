package com.superchatapp;

import java.security.GeneralSecurityException;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * XChaCha20-Poly1305 opening, byte-for-byte what @noble/ciphers seals
 * attachments with (src/crypto/primitives.ts aeadOpen): sealed = 24-byte
 * nonce ‖ ciphertext ‖ 16-byte tag. HChaCha20 turns the key and the nonce's
 * first 16 bytes into a subkey; the platform's ChaCha20-Poly1305 (Android 9+)
 * does the rest with the nonce's last 8 bytes. Plain Java with no Android
 * dependencies so it can be checked against the JS library with a bare JDK.
 */
public final class XChaCha {
  private XChaCha() {}

  public static byte[] open(byte[] key, byte[] sealed, byte[] ad) throws GeneralSecurityException {
    if (key.length != 32) throw new IllegalArgumentException("key must be 32 bytes");
    if (sealed.length < 24 + 16) throw new GeneralSecurityException("ciphertext too short");
    byte[] subkey = hchacha20(key, sealed, 0);
    byte[] nonce = new byte[12];
    System.arraycopy(sealed, 16, nonce, 4, 8);
    Cipher c = Cipher.getInstance("ChaCha20-Poly1305");
    c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(subkey, "ChaCha20"), new IvParameterSpec(nonce));
    c.updateAAD(ad);
    return c.doFinal(sealed, 24, sealed.length - 24);
  }

  /** HChaCha20(key, nonce[off..off+16]) → 32-byte subkey. */
  static byte[] hchacha20(byte[] key, byte[] n, int off) {
    int[] s = new int[16];
    s[0] = 0x61707865;
    s[1] = 0x3320646e;
    s[2] = 0x79622d32;
    s[3] = 0x6b206574;
    for (int i = 0; i < 8; i++) s[4 + i] = le32(key, 4 * i);
    for (int i = 0; i < 4; i++) s[12 + i] = le32(n, off + 4 * i);
    for (int i = 0; i < 10; i++) {
      qr(s, 0, 4, 8, 12);
      qr(s, 1, 5, 9, 13);
      qr(s, 2, 6, 10, 14);
      qr(s, 3, 7, 11, 15);
      qr(s, 0, 5, 10, 15);
      qr(s, 1, 6, 11, 12);
      qr(s, 2, 7, 8, 13);
      qr(s, 3, 4, 9, 14);
    }
    byte[] out = new byte[32];
    int[] pick = {0, 1, 2, 3, 12, 13, 14, 15};
    for (int i = 0; i < 8; i++) put32(out, 4 * i, s[pick[i]]);
    return out;
  }

  private static void qr(int[] s, int a, int b, int c, int d) {
    s[a] += s[b];
    s[d] = Integer.rotateLeft(s[d] ^ s[a], 16);
    s[c] += s[d];
    s[b] = Integer.rotateLeft(s[b] ^ s[c], 12);
    s[a] += s[b];
    s[d] = Integer.rotateLeft(s[d] ^ s[a], 8);
    s[c] += s[d];
    s[b] = Integer.rotateLeft(s[b] ^ s[c], 7);
  }

  private static int le32(byte[] b, int i) {
    return (b[i] & 0xff) | (b[i + 1] & 0xff) << 8 | (b[i + 2] & 0xff) << 16 | (b[i + 3] & 0xff) << 24;
  }

  private static void put32(byte[] b, int i, int v) {
    b[i] = (byte) v;
    b[i + 1] = (byte) (v >>> 8);
    b[i + 2] = (byte) (v >>> 16);
    b[i + 3] = (byte) (v >>> 24);
  }
}
