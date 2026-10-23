// scrypt (RFC 7914) for key files: the iOS twin of android/…/Scrypt.java, with
// the same derive(pass, salt, n, r, p, dkLen) taking and returning base64.
// Native because in Hermes a key file's 2^15 cost took seconds and froze the
// UI (no spinner even drew); here it runs off the JS thread. The core is plain
// C so it can be checked against the RFC's test vectors without Xcode:
//   gcc -x c -DSCRYPT_TEST -O2 ScryptModule.m -lcrypto && ./a.out

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCRYPT_TEST
#include <openssl/evp.h>
static int pbkdf2(const uint8_t *pass, size_t passLen, const uint8_t *salt, size_t saltLen, uint8_t *out, size_t len)
{
  return PKCS5_PBKDF2_HMAC((const char *)pass, (int)passLen, salt, (int)saltLen, 1, EVP_sha256(), (int)len, out) ? 0 : -1;
}
#else
#import <CommonCrypto/CommonKeyDerivation.h>
/** PBKDF2-HMAC-SHA256 with one iteration, as scrypt uses it. */
static int pbkdf2(const uint8_t *pass, size_t passLen, const uint8_t *salt, size_t saltLen, uint8_t *out, size_t len)
{
  return CCKeyDerivationPBKDF(kCCPBKDF2, (const char *)pass, passLen, salt, saltLen, kCCPRFHmacAlgSHA256, 1, out, len)
             == kCCSuccess ? 0 : -1;
}
#endif

#define R(a, b) (((a) << (b)) | ((a) >> (32 - (b))))

static void salsa8(uint32_t b[16])
{
  uint32_t x[16];
  memcpy(x, b, sizeof x);
  for (int i = 0; i < 8; i += 2) {
    x[4] ^= R(x[0] + x[12], 7);   x[8] ^= R(x[4] + x[0], 9);
    x[12] ^= R(x[8] + x[4], 13);  x[0] ^= R(x[12] + x[8], 18);
    x[9] ^= R(x[5] + x[1], 7);    x[13] ^= R(x[9] + x[5], 9);
    x[1] ^= R(x[13] + x[9], 13);  x[5] ^= R(x[1] + x[13], 18);
    x[14] ^= R(x[10] + x[6], 7);  x[2] ^= R(x[14] + x[10], 9);
    x[6] ^= R(x[2] + x[14], 13);  x[10] ^= R(x[6] + x[2], 18);
    x[3] ^= R(x[15] + x[11], 7);  x[7] ^= R(x[3] + x[15], 9);
    x[11] ^= R(x[7] + x[3], 13);  x[15] ^= R(x[11] + x[7], 18);
    x[1] ^= R(x[0] + x[3], 7);    x[2] ^= R(x[1] + x[0], 9);
    x[3] ^= R(x[2] + x[1], 13);   x[0] ^= R(x[3] + x[2], 18);
    x[6] ^= R(x[5] + x[4], 7);    x[7] ^= R(x[6] + x[5], 9);
    x[4] ^= R(x[7] + x[6], 13);   x[5] ^= R(x[4] + x[7], 18);
    x[11] ^= R(x[10] + x[9], 7);  x[8] ^= R(x[11] + x[10], 9);
    x[9] ^= R(x[8] + x[11], 13);  x[10] ^= R(x[9] + x[8], 18);
    x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9);
    x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
  }
  for (int i = 0; i < 16; i++) b[i] += x[i];
}

/** BlockMix: b (2r 16-word blocks) is mixed in place, y is scratch of the same size. */
static void blockMix(uint32_t *b, uint32_t *y, size_t r)
{
  uint32_t x[16];
  memcpy(x, b + (2 * r - 1) * 16, sizeof x);
  for (size_t i = 0; i < 2 * r; i++) {
    for (int k = 0; k < 16; k++) x[k] ^= b[i * 16 + k];
    salsa8(x);
    memcpy(y + i * 16, x, sizeof x);
  }
  for (size_t i = 0; i < r; i++) {
    memcpy(b + i * 16, y + 2 * i * 16, sizeof x);
    memcpy(b + (r + i) * 16, y + (2 * i + 1) * 16, sizeof x);
  }
}

/** 0 on success, -1 on bad parameters or out of memory. */
static int scryptDerive(const uint8_t *pass, size_t passLen, const uint8_t *salt, size_t saltLen,
                        uint64_t n, uint32_t r, uint32_t p, uint8_t *out, size_t dkLen)
{
  if (n < 2 || (n & (n - 1)) || r < 1 || p < 1 || n > (1u << 24) || (uint64_t)r * p >= (1u << 30)) return -1;
  size_t blockInts = 32 * (size_t)r, blockBytes = 128 * (size_t)r;
  uint8_t *b = malloc(blockBytes * p);
  uint32_t *x = malloc(blockBytes), *y = malloc(blockBytes), *v = malloc(blockBytes * n);
  int ok = b && x && y && v && pbkdf2(pass, passLen, salt, saltLen, b, blockBytes * p) == 0;
  for (uint32_t i = 0; ok && i < p; i++) {
    uint8_t *bi = b + i * blockBytes;
    for (size_t k = 0; k < blockInts; k++)
      x[k] = (uint32_t)bi[4 * k] | (uint32_t)bi[4 * k + 1] << 8 | (uint32_t)bi[4 * k + 2] << 16 | (uint32_t)bi[4 * k + 3] << 24;
    for (uint64_t k = 0; k < n; k++) {
      memcpy(v + k * blockInts, x, blockBytes);
      blockMix(x, y, r);
    }
    for (uint64_t k = 0; k < n; k++) {
      uint64_t j = x[(2 * r - 1) * 16] & (n - 1);
      for (size_t m = 0; m < blockInts; m++) x[m] ^= v[j * blockInts + m];
      blockMix(x, y, r);
    }
    for (size_t k = 0; k < blockInts; k++) {
      bi[4 * k] = (uint8_t)x[k];
      bi[4 * k + 1] = (uint8_t)(x[k] >> 8);
      bi[4 * k + 2] = (uint8_t)(x[k] >> 16);
      bi[4 * k + 3] = (uint8_t)(x[k] >> 24);
    }
  }
  ok = ok && pbkdf2(pass, passLen, b, blockBytes * p, out, dkLen) == 0;
  if (v) memset(v, 0, blockBytes * n);
  if (b) memset(b, 0, blockBytes * p);
  free(b);
  free(x);
  free(y);
  free(v);
  return ok ? 0 : -1;
}

#ifndef SCRYPT_TEST

#import <React/RCTBridgeModule.h>

@interface ScryptModule : NSObject <RCTBridgeModule>
@end

@implementation ScryptModule

RCT_EXPORT_MODULE(Scrypt)

- (dispatch_queue_t)methodQueue
{
  return dispatch_queue_create("com.superchatapp.Scrypt", DISPATCH_QUEUE_SERIAL);
}

RCT_EXPORT_METHOD(derive:(NSString *)pass
                  salt:(NSString *)salt
                  n:(double)n
                  r:(double)r
                  p:(double)p
                  dkLen:(double)dkLen
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  @autoreleasepool {
    NSData *passBytes = [[NSData alloc] initWithBase64EncodedString:pass options:0];
    NSData *saltBytes = [[NSData alloc] initWithBase64EncodedString:salt options:0];
    NSMutableData *out = dkLen >= 1 && dkLen <= 1024 ? [NSMutableData dataWithLength:(NSUInteger)dkLen] : nil;
    if (!passBytes || !saltBytes || !out || n < 2 || r < 1 || p < 1 ||
        scryptDerive(passBytes.bytes, passBytes.length, saltBytes.bytes, saltBytes.length,
                     (uint64_t)n, (uint32_t)r, (uint32_t)p, out.mutableBytes, out.length) != 0) {
      reject(@"E_SCRYPT", @"Couldn't derive the key.", nil);
      return;
    }
    resolve([out base64EncodedStringWithOptions:0]);
  }
}

@end

#else

#include <stdio.h>

static int check(const char *pass, const char *salt, uint64_t n, uint32_t r, uint32_t p, size_t len, const char *hex)
{
  uint8_t out[64];
  char got[129];
  if (scryptDerive((const uint8_t *)pass, strlen(pass), (const uint8_t *)salt, strlen(salt), n, r, p, out, len)) return 1;
  for (size_t i = 0; i < len; i++) sprintf(got + 2 * i, "%02x", out[i]);
  int bad = strcmp(got, hex) != 0;
  printf("%s N=%llu r=%u p=%u %s\n", bad ? "FAIL" : "ok  ", (unsigned long long)n, r, p, got);
  return bad;
}

int main(int argc, char **argv)
{
  // An extra vector from the command line: pass salt n r p hex.
  if (argc == 7)
    return check(argv[1], argv[2], strtoull(argv[3], 0, 10), atoi(argv[4]), atoi(argv[5]), strlen(argv[6]) / 2, argv[6]);
  // RFC 7914 §12 (the first, empty-passphrase vector is skipped: CommonCrypto
  // rejects an empty password and key-file passphrases are never empty).
  return check("password", "NaCl", 1024, 8, 16, 64,
               "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162"
               "2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640") |
         check("pleaseletmein", "SodiumChloride", 16384, 8, 1, 64,
               "7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2"
               "d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887");
}

#endif
