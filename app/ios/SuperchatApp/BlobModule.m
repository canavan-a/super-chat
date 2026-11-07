// Opens an attachment (or profile picture) for display entirely off the JS
// thread: the iOS twin of android/…/BlobModule.kt. The sealed blob comes from
// the device cache (src/blobDisk.ts's folder) or is downloaded into it, then
// is decrypted here and handed back as a data: URI. In JS the same work
// (base64, AEAD over megabytes) competed with every tap. Nothing decrypted is
// written to disk.
//
// XChaCha20-Poly1305 is plain C (iOS has no ChaCha in CommonCrypto, and
// CryptoKit is Swift-only, and lacks the X variant), so it can be checked
// against the JS implementation without Xcode:
//   node <vectors script> && gcc -x c -DBLOB_TEST -O2 BlobModule.m && ./a.out <dir>

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// ---- ChaCha20 (RFC 8439) and HChaCha20 ----

#define ROTL(a, b) (((a) << (b)) | ((a) >> (32 - (b))))
#define QR(a, b, c, d) \
  a += b; d ^= a; d = ROTL(d, 16); \
  c += d; b ^= c; b = ROTL(b, 12); \
  a += b; d ^= a; d = ROTL(d, 8);  \
  c += d; b ^= c; b = ROTL(b, 7)

static uint32_t le32(const uint8_t *p)
{
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static void put32(uint8_t *p, uint32_t v)
{
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  p[2] = (uint8_t)(v >> 16);
  p[3] = (uint8_t)(v >> 24);
}

static void rounds(uint32_t x[16])
{
  for (int i = 0; i < 10; i++) {
    QR(x[0], x[4], x[8], x[12]);
    QR(x[1], x[5], x[9], x[13]);
    QR(x[2], x[6], x[10], x[14]);
    QR(x[3], x[7], x[11], x[15]);
    QR(x[0], x[5], x[10], x[15]);
    QR(x[1], x[6], x[11], x[12]);
    QR(x[2], x[7], x[8], x[13]);
    QR(x[3], x[4], x[9], x[14]);
  }
}

static void setup(uint32_t s[16], const uint8_t key[32])
{
  s[0] = 0x61707865;
  s[1] = 0x3320646e;
  s[2] = 0x79622d32;
  s[3] = 0x6b206574;
  for (int i = 0; i < 8; i++) s[4 + i] = le32(key + 4 * i);
}

/** HChaCha20: the subkey for XChaCha's first 16 nonce bytes. */
static void hchacha(uint8_t out[32], const uint8_t key[32], const uint8_t nonce[16])
{
  uint32_t x[16];
  setup(x, key);
  for (int i = 0; i < 4; i++) x[12 + i] = le32(nonce + 4 * i);
  rounds(x);
  for (int i = 0; i < 4; i++) {
    put32(out + 4 * i, x[i]);
    put32(out + 16 + 4 * i, x[12 + i]);
  }
}

/** XORs the ChaCha20 (IETF: 32-bit counter, 12-byte nonce) keystream over buf in place. */
static void chachaXor(const uint8_t key[32], const uint8_t nonce[12], uint32_t counter, uint8_t *buf, size_t len)
{
  uint32_t s[16], x[16];
  uint8_t block[64];
  setup(s, key);
  for (int i = 0; i < 3; i++) s[13 + i] = le32(nonce + 4 * i);
  while (len) {
    s[12] = counter++;
    memcpy(x, s, sizeof x);
    rounds(x);
    for (int i = 0; i < 16; i++) put32(block + 4 * i, x[i] + s[i]);
    size_t n = len < 64 ? len : 64;
    for (size_t i = 0; i < n; i++) buf[i] ^= block[i];
    buf += n;
    len -= n;
  }
  memset(block, 0, sizeof block);
  memset(x, 0, sizeof x);
  memset(s, 0, sizeof s);
}

// ---- Poly1305 (26-bit limbs, after poly1305-donna) ----

typedef struct {
  uint32_t r[5], h[5], pad[4];
} Poly;

static void polyInit(Poly *p, const uint8_t key[32])
{
  p->r[0] = le32(key) & 0x3ffffff;
  p->r[1] = (le32(key + 3) >> 2) & 0x3ffff03;
  p->r[2] = (le32(key + 6) >> 4) & 0x3ffc0ff;
  p->r[3] = (le32(key + 9) >> 6) & 0x3f03fff;
  p->r[4] = (le32(key + 12) >> 8) & 0x00fffff;
  memset(p->h, 0, sizeof p->h);
  for (int i = 0; i < 4; i++) p->pad[i] = le32(key + 16 + 4 * i);
}

/** Whole 16-byte blocks. */
static void polyBlocks(Poly *p, const uint8_t *m, size_t len)
{
  const uint32_t r0 = p->r[0], r1 = p->r[1], r2 = p->r[2], r3 = p->r[3], r4 = p->r[4];
  const uint32_t s1 = r1 * 5, s2 = r2 * 5, s3 = r3 * 5, s4 = r4 * 5;
  uint32_t h0 = p->h[0], h1 = p->h[1], h2 = p->h[2], h3 = p->h[3], h4 = p->h[4];
  for (; len >= 16; m += 16, len -= 16) {
    h0 += le32(m) & 0x3ffffff;
    h1 += (le32(m + 3) >> 2) & 0x3ffffff;
    h2 += (le32(m + 6) >> 4) & 0x3ffffff;
    h3 += (le32(m + 9) >> 6) & 0x3ffffff;
    h4 += (le32(m + 12) >> 8) | (1 << 24);
    uint64_t d0 = (uint64_t)h0 * r0 + (uint64_t)h1 * s4 + (uint64_t)h2 * s3 + (uint64_t)h3 * s2 + (uint64_t)h4 * s1;
    uint64_t d1 = (uint64_t)h0 * r1 + (uint64_t)h1 * r0 + (uint64_t)h2 * s4 + (uint64_t)h3 * s3 + (uint64_t)h4 * s2;
    uint64_t d2 = (uint64_t)h0 * r2 + (uint64_t)h1 * r1 + (uint64_t)h2 * r0 + (uint64_t)h3 * s4 + (uint64_t)h4 * s3;
    uint64_t d3 = (uint64_t)h0 * r3 + (uint64_t)h1 * r2 + (uint64_t)h2 * r1 + (uint64_t)h3 * r0 + (uint64_t)h4 * s4;
    uint64_t d4 = (uint64_t)h0 * r4 + (uint64_t)h1 * r3 + (uint64_t)h2 * r2 + (uint64_t)h3 * r1 + (uint64_t)h4 * r0;
    uint32_t c;
    c = (uint32_t)(d0 >> 26); h0 = (uint32_t)d0 & 0x3ffffff;
    d1 += c; c = (uint32_t)(d1 >> 26); h1 = (uint32_t)d1 & 0x3ffffff;
    d2 += c; c = (uint32_t)(d2 >> 26); h2 = (uint32_t)d2 & 0x3ffffff;
    d3 += c; c = (uint32_t)(d3 >> 26); h3 = (uint32_t)d3 & 0x3ffffff;
    d4 += c; c = (uint32_t)(d4 >> 26); h4 = (uint32_t)d4 & 0x3ffffff;
    h0 += c * 5; c = h0 >> 26; h0 &= 0x3ffffff;
    h1 += c;
  }
  p->h[0] = h0; p->h[1] = h1; p->h[2] = h2; p->h[3] = h3; p->h[4] = h4;
}

/** Data zero-padded to a 16-byte boundary, as the AEAD construction feeds it. */
static void polyPadded(Poly *p, const uint8_t *m, size_t len)
{
  size_t whole = len & ~(size_t)15;
  polyBlocks(p, m, whole);
  if (len > whole) {
    uint8_t block[16] = {0};
    memcpy(block, m + whole, len - whole);
    polyBlocks(p, block, 16);
  }
}

static void polyFinish(Poly *p, uint8_t tag[16])
{
  uint32_t h0 = p->h[0], h1 = p->h[1], h2 = p->h[2], h3 = p->h[3], h4 = p->h[4], c;
  c = h1 >> 26; h1 &= 0x3ffffff;
  h2 += c; c = h2 >> 26; h2 &= 0x3ffffff;
  h3 += c; c = h3 >> 26; h3 &= 0x3ffffff;
  h4 += c; c = h4 >> 26; h4 &= 0x3ffffff;
  h0 += c * 5; c = h0 >> 26; h0 &= 0x3ffffff;
  h1 += c;
  // h - p, taken if it doesn't go negative.
  uint32_t g0 = h0 + 5; c = g0 >> 26; g0 &= 0x3ffffff;
  uint32_t g1 = h1 + c; c = g1 >> 26; g1 &= 0x3ffffff;
  uint32_t g2 = h2 + c; c = g2 >> 26; g2 &= 0x3ffffff;
  uint32_t g3 = h3 + c; c = g3 >> 26; g3 &= 0x3ffffff;
  uint32_t g4 = h4 + c - (1u << 26);
  uint32_t mask = (g4 >> 31) - 1;
  h0 = (h0 & ~mask) | (g0 & mask);
  h1 = (h1 & ~mask) | (g1 & mask);
  h2 = (h2 & ~mask) | (g2 & mask);
  h3 = (h3 & ~mask) | (g3 & mask);
  h4 = (h4 & ~mask) | (g4 & mask);
  h0 = h0 | (h1 << 26);
  h1 = (h1 >> 6) | (h2 << 20);
  h2 = (h2 >> 12) | (h3 << 14);
  h3 = (h3 >> 18) | (h4 << 8);
  uint64_t f;
  f = (uint64_t)h0 + p->pad[0]; put32(tag, (uint32_t)f);
  f = (uint64_t)h1 + p->pad[1] + (f >> 32); put32(tag + 4, (uint32_t)f);
  f = (uint64_t)h2 + p->pad[2] + (f >> 32); put32(tag + 8, (uint32_t)f);
  f = (uint64_t)h3 + p->pad[3] + (f >> 32); put32(tag + 12, (uint32_t)f);
  memset(p, 0, sizeof *p);
}

// ---- XChaCha20-Poly1305 open ----

/**
 * sealed = nonce(24) | ciphertext | tag(16), as src/crypto/primitives.ts
 * writes it. On success the plaintext (len - 40 bytes) is written to out and
 * 0 returned; -1 if it doesn't verify (out is then left untouched).
 */
static int xchachaOpen(const uint8_t key[32], const uint8_t *sealed, size_t len,
                       const uint8_t *ad, size_t adLen, uint8_t *out)
{
  if (len < 40) return -1;
  const uint8_t *ct = sealed + 24;
  size_t ctLen = len - 40;
  uint8_t sub[32], nonce[12] = {0}, polyKey[64] = {0}, tag[16], lens[16];
  hchacha(sub, key, sealed);
  memcpy(nonce + 4, sealed + 16, 8);
  chachaXor(sub, nonce, 0, polyKey, sizeof polyKey);
  Poly p;
  polyInit(&p, polyKey);
  polyPadded(&p, ad, adLen);
  polyPadded(&p, ct, ctLen);
  uint64_t a = adLen, c = ctLen;
  for (int i = 0; i < 8; i++) {
    lens[i] = (uint8_t)(a >> (8 * i));
    lens[8 + i] = (uint8_t)(c >> (8 * i));
  }
  polyBlocks(&p, lens, 16);
  polyFinish(&p, tag);
  uint8_t diff = 0;
  for (int i = 0; i < 16; i++) diff |= tag[i] ^ sealed[len - 16 + i];
  int ok = diff == 0;
  if (ok) {
    memcpy(out, ct, ctLen);
    chachaXor(sub, nonce, 1, out, ctLen);
  }
  memset(sub, 0, sizeof sub);
  memset(polyKey, 0, sizeof polyKey);
  return ok ? 0 : -1;
}

static const uint8_t BLOB_AD[] = {'s', 'c', '-', 'b', 'l', 'o', 'b'};

#ifndef BLOB_TEST

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

@interface BlobModule : NSObject <RCTBridgeModule>
@end

@implementation BlobModule {
  dispatch_queue_t _workers;
  /** Two opens of the same blob at once raced on its download: one at a time per blob (striped, so this never grows). */
  NSArray<NSLock *> *_locks;
}

RCT_EXPORT_MODULE(Blob)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if ((self = [super init])) {
    _workers = dispatch_queue_create("com.superchatapp.Blob", DISPATCH_QUEUE_CONCURRENT);
    NSMutableArray *locks = [NSMutableArray arrayWithCapacity:16];
    for (int i = 0; i < 16; i++) [locks addObject:[NSLock new]];
    _locks = locks;
  }
  return self;
}

/** The same folder as react-native-fs's DocumentDirectoryPath + "/blobs". */
- (NSString *)pathOf:(NSString *)blob
{
  NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
  NSString *dir = [docs stringByAppendingPathComponent:@"blobs"];
  [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  // Blob ids are server-made; never let one reach outside the folder.
  NSRegularExpression *unsafe = [NSRegularExpression regularExpressionWithPattern:@"[^A-Za-z0-9_-]" options:0 error:nil];
  NSString *name = [unsafe stringByReplacingMatchesInString:blob options:0 range:NSMakeRange(0, blob.length) withTemplate:@"_"];
  return [dir stringByAppendingPathComponent:name];
}

/** Downloads into path (via a temporary file of its own); nil, or why not. */
- (NSString *)download:(NSString *)url headers:(NSDictionary *)headers into:(NSString *)path
{
  NSURL *u = [NSURL URLWithString:url];
  if (!u) return @"Download failed.";
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:u cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:15];
  for (NSString *k in headers) {
    id v = headers[k];
    if ([v isKindOfClass:[NSString class]]) [req setValue:v forHTTPHeaderField:k];
  }
  NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration ephemeralSessionConfiguration];
  cfg.timeoutIntervalForResource = 60;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:cfg];
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSString *failure = nil;
  NSString *tmp = [path stringByAppendingFormat:@".%@.part", [NSUUID UUID].UUIDString];
  [[session downloadTaskWithRequest:req completionHandler:^(NSURL *location, NSURLResponse *response, NSError *error) {
    NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 0;
    if (error || !location) {
      failure = @"Download failed.";
    } else if (status != 200) {
      failure = status == 404 ? @"That file is gone." : [NSString stringWithFormat:@"Download failed (%ld).", (long)status];
    } else {
      // The handed-over file is deleted once this returns: move it now.
      NSFileManager *fm = [NSFileManager defaultManager];
      if (![fm moveItemAtURL:location toURL:[NSURL fileURLWithPath:tmp] error:nil]) {
        failure = @"Couldn't save the download.";
      } else {
        [fm removeItemAtPath:path error:nil];
        if (![fm moveItemAtPath:tmp toPath:path error:nil]) failure = @"Couldn't save the download.";
      }
    }
    dispatch_semaphore_signal(done);
  }] resume];
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
  [session finishTasksAndInvalidate];
  [[NSFileManager defaultManager] removeItemAtPath:tmp error:nil];
  return failure;
}

/** The decrypted blob, or nil with *why set. */
- (NSData *)openLocked:(NSString *)blob url:(NSString *)url headers:(NSDictionary *)headers key:(NSData *)key why:(NSString **)why
{
  NSString *path = [self pathOf:blob];
  NSFileManager *fm = [NSFileManager defaultManager];
  BOOL fresh = NO;
  if (![fm fileExistsAtPath:path]) {
    if ((*why = [self download:url headers:headers into:path])) return nil;
    fresh = YES;
  }
  for (;;) {
    NSData *sealed = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:nil];
    if (sealed.length >= 40) {
      NSMutableData *plain = [NSMutableData dataWithLength:sealed.length - 40];
      if (plain && xchachaOpen(key.bytes, sealed.bytes, sealed.length, BLOB_AD, sizeof BLOB_AD, plain.mutableBytes) == 0) {
        // Recently used, for trimming (src/blobDisk.ts goes by mtime).
        [fm setAttributes:@{NSFileModificationDate : [NSDate date]} ofItemAtPath:path error:nil];
        return plain;
      }
    }
    if (fresh) {
      *why = @"Couldn't decrypt that file.";
      return nil;
    }
    // A damaged cached copy: fetch it again, once.
    [fm removeItemAtPath:path error:nil];
    if ((*why = [self download:url headers:headers into:path])) return nil;
    fresh = YES;
  }
}

/**
 * Resolves with "data:<mime>;base64,…". url and headers are the signed
 * request to download it when it isn't cached; key is the file key
 * (standard base64).
 */
RCT_EXPORT_METHOD(open:(NSString *)blob
                  url:(NSString *)url
                  headers:(NSDictionary *)headers
                  key:(NSString *)key
                  mime:(NSString *)mime
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(_workers, ^{
    @autoreleasepool {
      NSData *fileKey = [[NSData alloc] initWithBase64EncodedString:key options:0];
      if (fileKey.length != 32) {
        reject(@"E_BLOB", @"Couldn't open that file.", nil);
        return;
      }
      NSLock *lock = self->_locks[(blob.hash & 0x7fffffff) % self->_locks.count];
      NSString *why = nil;
      [lock lock];
      NSData *plain = [self openLocked:blob url:url headers:headers key:fileKey why:&why];
      [lock unlock];
      if (!plain) {
        reject(@"E_BLOB", why ?: @"Couldn't open that file.", nil);
        return;
      }
      resolve([NSString stringWithFormat:@"data:%@;base64,%@", mime, [plain base64EncodedStringWithOptions:0]]);
    }
  });
}

@end

#else

#include <stdio.h>

static uint8_t *slurp(const char *dir, const char *name, size_t *len)
{
  char path[1024];
  snprintf(path, sizeof path, "%s/%s", dir, name);
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  uint8_t *buf = malloc(n ? n : 1);
  *len = fread(buf, 1, n, f);
  fclose(f);
  return buf;
}

/** dir holds <case>.key, <case>.sealed and <case>.plain (absent: must fail) for each case named on stdin. */
int main(int argc, char **argv)
{
  if (argc != 2) return 2;
  char name[256], file[300];
  int bad = 0;
  while (scanf("%255s", name) == 1) {
    size_t kl, sl, pl = 0;
    snprintf(file, sizeof file, "%s.key", name);
    uint8_t *key = slurp(argv[1], file, &kl);
    snprintf(file, sizeof file, "%s.sealed", name);
    uint8_t *sealed = slurp(argv[1], file, &sl);
    snprintf(file, sizeof file, "%s.plain", name);
    uint8_t *plain = slurp(argv[1], file, &pl);
    uint8_t *out = malloc(sl);
    int rc = xchachaOpen(key, sealed, sl, BLOB_AD, sizeof BLOB_AD, out);
    int ok = plain ? rc == 0 && pl == sl - 40 && memcmp(out, plain, pl) == 0 : rc != 0;
    printf("%s %s (%zu bytes)\n", ok ? "ok  " : "FAIL", name, sl);
    bad |= !ok;
    free(key);
    free(sealed);
    free(plain);
    free(out);
  }
  return bad;
}

#endif
