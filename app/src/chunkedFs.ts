// Reading and writing big files (videos, voice messages, cached blobs) a
// slice at a time. One RNFS call with a whole 24 MB file means a ~32 MB
// base64 string crossing the bridge in one go: the JS thread stalls building
// and parsing it, and the native-modules queue is tied up so every other
// native call (keychain, other files) waits behind it. In slices, both sides
// get the thread back between pieces.
import RNFS from 'react-native-fs';
import {b64DecodeAsync, b64EncodeAsync} from './crypto/chunked';

/** Bytes per slice: a multiple of 3, so base64 slices need no padding mid-file. */
const SLICE = 3 * 256 * 1024;

export async function readFileChunked(path: string): Promise<Uint8Array> {
  const size = Number((await RNFS.stat(path)).size);
  if (size <= SLICE) return b64DecodeAsync(await RNFS.readFile(path, 'base64'));
  const out = new Uint8Array(size);
  let at = 0;
  while (at < size) {
    // iOS asks for line-feed endings; there are none without a line length, but be safe.
    const b64 = (await RNFS.read(path, Math.min(SLICE, size - at), at, 'base64')).replace(/\s/g, '');
    const part = await b64DecodeAsync(b64);
    if (!part.length) throw new Error("Couldn't read the whole file.");
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Writes to a temporary name, then moves it into place: never a half-written file at `path`. */
export async function writeFileChunked(path: string, data: Uint8Array): Promise<void> {
  const tmp = `${path}.${Math.random().toString(36).slice(2)}.part`;
  try {
    await RNFS.writeFile(tmp, await b64EncodeAsync(data.subarray(0, SLICE)), 'base64');
    for (let off = SLICE; off < data.length; off += SLICE) {
      await RNFS.appendFile(tmp, await b64EncodeAsync(data.subarray(off, off + SLICE)), 'base64');
    }
    if (await RNFS.exists(path)) await RNFS.unlink(path).catch(() => {});
    await RNFS.moveFile(tmp, path);
  } catch (e) {
    RNFS.unlink(tmp).catch(() => {});
    throw e;
  }
}
