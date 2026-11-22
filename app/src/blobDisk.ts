// On-device cache of attachment blobs, so an image is downloaded once rather
// than on every open. It stores exactly what the server stores: the sealed
// (encrypted) blob. The key to open it lives only in the message that points
// at it, so a cached file is as unreadable as the server's copy, and nothing
// decrypted ever touches disk (store.ts decrypts in memory, as before).
//
// App-private storage, capped by size: the least recently used blobs go
// first. blobDisk.web.ts is the browser's (no-op) version.
//
// The one exception is profile and chat pictures (avatars/, below): those are
// kept decrypted, written once by native code (BlobModule), so a cold start
// shows them straight from a file:// URI with no crypto or base64 in JS.
import RNFS from 'react-native-fs';
import {readFileChunked, writeFileChunked} from './chunkedFs';

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
    const data = await readFileChunked(p);
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
    await writeFileChunked(pathOf(blob), sealed);
    trimSoon();
  } catch {
    // not cached; it'll be downloaded again next time
  }
}

/** Removes every cached blob (the account was removed from this device). */
export async function clearSealed(): Promise<void> {
  ready = null;
  avatarFiles.clear();
  await Promise.all([RNFS.unlink(DIR).catch(() => {}), RNFS.unlink(AVATAR_DIR).catch(() => {})]);
}

// ---- decrypted pictures ----

/** Where BlobModule.openToFile writes them (filesDir / Documents + "/avatars"). */
const AVATAR_DIR = `${RNFS.DocumentDirectoryPath}/avatars`;
/** Newest kept up to this; an older one just re-decrypts when next shown. */
const AVATAR_MAX_BYTES = 20 * 1024 * 1024;
const safeName = (blob: string) => blob.replace(/[^A-Za-z0-9_-]/g, '_');
/** Blob id (safe name) to file:// URI, for every picture on disk. */
const avatarFiles = new Map<string, string>();

/**
 * Lists the pictures on disk, so avatarFile can answer mid-render. Run once
 * at launch, before the room list draws. Never throws.
 */
export async function loadAvatarFiles(): Promise<void> {
  try {
    if (!(await RNFS.exists(AVATAR_DIR))) return;
    const files = (await RNFS.readDir(AVATAR_DIR)).filter(f => f.isFile());
    // Left by a write cut short.
    for (const f of files) if (f.name.endsWith('.part')) RNFS.unlink(f.path).catch(() => {});
    const done = files.filter(f => !f.name.endsWith('.part'));
    done.sort((a, b) => (b.mtime?.getTime() ?? 0) - (a.mtime?.getTime() ?? 0));
    let total = 0;
    for (const f of done) {
      total += Number(f.size);
      if (total > AVATAR_MAX_BYTES) RNFS.unlink(f.path).catch(() => {});
      else avatarFiles.set(f.name, `file://${f.path}`);
    }
  } catch {
    // none listed: they're opened (and written) again as they're shown
  }
}

/** The decrypted picture's file:// URI if it's on disk, synchronously. */
export const avatarFile = (blob: string): string | null => avatarFiles.get(safeName(blob)) ?? null;

/** BlobModule.openToFile wrote one. */
export const noteAvatarFile = (blob: string, uri: string): void => {
  avatarFiles.set(safeName(blob), uri);
};

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
