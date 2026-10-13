// On-device cache of attachment blobs, so an image is downloaded once rather
// than on every open. It stores exactly what the server stores: the sealed
// (encrypted) blob. The key to open it lives only in the message that points
// at it, so a cached file is as unreadable as the server's copy, and nothing
// decrypted ever touches disk (store.ts decrypts in memory, as before).
//
// App-private storage, capped by size: the least recently used blobs go
// first. blobDisk.web.ts is the browser's (no-op) version.
import RNFS from 'react-native-fs';
import {base64} from '@scure/base';

const DIR = `${RNFS.DocumentDirectoryPath}/blobs`;
/** Total size the cache is trimmed back to. */
const MAX_BYTES = 300 * 1024 * 1024;

// Blob ids are server-made; never let one reach outside DIR.
const pathOf = (blob: string) => `${DIR}/${blob.replace(/[^A-Za-z0-9_-]/g, '_')}`;

let ready: Promise<void> | null = null;
const ensureDir = () => (ready ??= RNFS.mkdir(DIR).catch(() => {}));

/** The cached sealed blob, or null. Never throws. */
export async function getSealed(blob: string): Promise<Uint8Array | null> {
  try {
    const p = pathOf(blob);
    if (!(await RNFS.exists(p))) return null;
    const data = base64.decode(await RNFS.readFile(p, 'base64'));
    // Mark it recently used, for trimming.
    RNFS.touch(p, new Date(), new Date()).catch(() => {});
    return data;
  } catch {
    return null;
  }
}

/** Caches a sealed blob. Best effort: a full disk just means no cache. */
export async function putSealed(blob: string, sealed: Uint8Array): Promise<void> {
  try {
    await ensureDir();
    await RNFS.writeFile(pathOf(blob), base64.encode(sealed), 'base64');
    trimSoon();
  } catch {
    // not cached; it'll be downloaded again next time
  }
}

/** Removes every cached blob (the account was removed from this device). */
export async function clearSealed(): Promise<void> {
  ready = null;
  await RNFS.unlink(DIR).catch(() => {});
}

let trimTimer: ReturnType<typeof setTimeout> | null = null;
function trimSoon() {
  if (trimTimer) return;
  trimTimer = setTimeout(() => {
    trimTimer = null;
    trim().catch(() => {});
  }, 5000);
}

async function trim(): Promise<void> {
  const files = await RNFS.readDir(DIR);
  let total = files.reduce((n, f) => n + Number(f.size), 0);
  if (total <= MAX_BYTES) return;
  files.sort((a, b) => (a.mtime?.getTime() ?? 0) - (b.mtime?.getTime() ?? 0));
  for (const f of files) {
    if (total <= MAX_BYTES * 0.8) break;
    await RNFS.unlink(f.path).catch(() => {});
    total -= Number(f.size);
  }
}

/** Drops cached blobs whose messages are gone (deleted for everyone, wiped). */
export async function removeSealed(blobs: string[]): Promise<void> {
  await Promise.all(blobs.map(b => RNFS.unlink(pathOf(b)).catch(() => {})));
}

/** Native code (BlobModule.kt) cached a blob in this folder: keep the size cap. */
export const noteCached = (): void => trimSoon();
