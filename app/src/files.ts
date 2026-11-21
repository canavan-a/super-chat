// Picking and saving files on Android and iOS. Picked files are copied into the
// app's cache (so a content:// URI can be read), read into memory, and the
// copy is deleted straight away: nothing decrypted or about to be encrypted
// is left lying on disk.
import {errorCodes, isErrorWithCode, keepLocalCopy, pick, saveDocuments, types} from '@react-native-documents/picker';
import {ImagePickerResponse, launchCamera, launchImageLibrary} from 'react-native-image-picker';
import RNFS from 'react-native-fs';
import {NativeModules} from 'react-native';
import {base64} from '@scure/base';
import {b64DecodeAsync, b64EncodeAsync} from './crypto/chunked';

import {unutf8, utf8} from './crypto';

export interface PickedFile {
  name: string;
  mime: string;
  data: Uint8Array;
  w?: number;
  h?: number;
  /** Video or voice: seconds long. */
  dur?: number;
  /** Voice: loudness bars, 0–15. */
  wave?: number[];
  /** Video: its poster frame, a small JPEG. */
  thumb?: {data: Uint8Array; w: number; h: number};
}

async function readAndDelete(path: string): Promise<Uint8Array> {
  try {
    return await b64DecodeAsync(await RNFS.readFile(path, 'base64'));
  } finally {
    RNFS.unlink(path).catch(() => {});
  }
}

export interface TextFile {
  name: string;
  text: string;
}

const isCancel = (e: unknown) => isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED;

/**
 * Copies picked documents into the app's cache (the picker hands back
 * content:// URIs), returning the local file path of each, or null where the
 * copy failed.
 */
async function localCopies(files: {uri: string; name: string | null}[]): Promise<(string | null)[]> {
  if (!files.length) return [];
  const res = await keepLocalCopy({
    files: files.map(f => ({uri: f.uri, fileName: f.name ?? 'file'})) as [
      {uri: string; fileName: string},
      ...{uri: string; fileName: string}[],
    ],
    destination: 'cachesDirectory',
  });
  return res.map(r => (r.status === 'success' ? decodeURI(r.localUri.replace('file://', '')) : null));
}

/** Null if the picker was cancelled. Throws with a readable message. */
export async function pickTextFile(): Promise<TextFile | null> {
  let f;
  try {
    [f] = await pick({type: [types.allFiles]});
  } catch (e) {
    if (isCancel(e)) return null;
    throw new Error("Couldn't open the file picker.");
  }
  const [path] = await localCopies([f]);
  if (!path) throw new Error(`Couldn't read ${f.name ?? 'that file'}.`);
  const bytes = await readAndDelete(path);
  if (bytes.length > 64 * 1024) throw new Error(`${f.name ?? 'That file'} is too big to be a key file.`);
  return {name: f.name ?? 'key file', text: unutf8(bytes)};
}

export interface SavedFile {
  name: string;
  /** Human-readable folder, e.g. "Downloads". */
  location: string;
}

interface FileSaverNative {
  create(name: string, mime: string): Promise<string | null>;
  write(uri: string, base64: string): Promise<string | null>;
  discard(uri: string): Promise<void>;
}
// Android only (FileSaverModule.kt); iOS saves through the document picker.
const FileSaver = NativeModules.FileSaver as FileSaverNative | undefined;

/**
 * "Save as…": opens the system save dialog first, so the user picks the folder
 * (it remembers the last one), then gets the bytes, which may be slow
 * (encrypting a key file, downloading an attachment). Null if the dialog was
 * cancelled.
 */
export async function saveFileAs(
  name: string,
  mime: string,
  makeData: () => Promise<Uint8Array>,
): Promise<SavedFile | null> {
  if (!FileSaver) return saveViaFilesApp(name, mime, makeData);
  const uri = await FileSaver.create(name, mime || 'application/octet-stream');
  if (!uri) return null;
  try {
    const saved = await FileSaver.write(uri, await b64EncodeAsync(await makeData()));
    return {name: saved ?? name, location: 'the folder you picked'};
  } catch (e) {
    FileSaver.discard(uri).catch(() => {});
    throw e;
  }
}

/**
 * iOS: there's no save dialog that hands back a place to write, so the bytes
 * go to a temporary file first, which the Files picker then copies to where
 * the user chooses. The temporary copy is deleted either way.
 */
async function saveViaFilesApp(
  name: string,
  mime: string,
  makeData: () => Promise<Uint8Array>,
): Promise<SavedFile | null> {
  const dir = `${RNFS.TemporaryDirectoryPath}/save-${Date.now()}`;
  const path = `${dir}/${name.replace(/[/\\]/g, '_')}`;
  await RNFS.mkdir(dir);
  try {
    await RNFS.writeFile(path, await b64EncodeAsync(await makeData()), 'base64');
    const [res] = await saveDocuments({
      sourceUris: [`file://${encodeURI(path)}`],
      mimeType: mime || 'application/octet-stream',
      fileName: name,
      copy: true,
    });
    if (res.error) throw new Error(`Couldn't save ${name}.`);
    return {name: res.name ?? name, location: 'Files'};
  } catch (e) {
    if (isCancel(e)) return null;
    throw e;
  } finally {
    RNFS.unlink(dir).catch(() => {});
  }
}

export const saveTextFileAs = (name: string, makeText: () => Promise<string>): Promise<SavedFile | null> =>
  saveFileAs(name, 'application/json', async () => utf8(await makeText()));

/** A photo picked to become a profile picture, before cropping. */
export interface AvatarSource {
  /** base64 JPEG, re-encoded by the picker (so upright, and without EXIF) */
  base64: string;
  width: number;
  height: number;
}

/** Picks the photo to crop. Kept to 1600px: plenty to crop a 512px square from. Null if cancelled. */
export async function pickAvatarSource(): Promise<AvatarSource | null> {
  const res = await launchImageLibrary({
    mediaType: 'photo',
    selectionLimit: 1,
    maxWidth: 1600,
    maxHeight: 1600,
    quality: 0.9,
    includeBase64: true,
  });
  if (res.didCancel) return null;
  if (res.errorMessage) throw new Error(res.errorMessage);
  const a = res.assets?.[0];
  if (a?.uri?.startsWith('file://')) RNFS.unlink(a.uri.replace('file://', '')).catch(() => {});
  if (!a?.base64 || !a.width || !a.height) return null;
  return {base64: a.base64, width: a.width, height: a.height};
}

/** The size of the finished profile picture. */
export const AVATAR_SIZE = 512;

interface ImageCropNative {
  crop(base64: string, x: number, y: number, size: number, out: number): Promise<string>;
}

/** Cuts the framed square (in source pixels) out and scales it to AVATAR_SIZE, as a JPEG. */
export async function cropAvatar(src: AvatarSource, x: number, y: number, size: number): Promise<Uint8Array> {
  const native = NativeModules.ImageCrop as ImageCropNative | undefined;
  if (!native) throw new Error('Cropping needs the latest app build.');
  return base64.decode(await native.crop(src.base64, x, y, size, AVATAR_SIZE));
}

// Downscaled and re-encoded, which also strips EXIF (location etc.).
const PHOTO_OPTIONS = {mediaType: 'photo', maxWidth: 2048, maxHeight: 2048, quality: 0.8, includeBase64: true} as const;

export async function pickImages(): Promise<PickedFile[]> {
  return readPhotos(await launchImageLibrary({...PHOTO_OPTIONS, selectionLimit: 6}));
}

/** Opens the camera for one photo, which isn't saved to the gallery. Empty if cancelled. */
export async function takePhoto(): Promise<PickedFile[]> {
  const res = await launchCamera({...PHOTO_OPTIONS, saveToPhotos: false, cameraType: 'back'});
  if (res.errorCode === 'camera_unavailable') throw new Error('No camera available.');
  if (res.errorCode === 'permission') throw new Error('Super Chat needs camera access: allow it in Settings.');
  return readPhotos(res, 'photo.jpg');
}

async function readPhotos(res: ImagePickerResponse, fallbackName = 'image.jpg'): Promise<PickedFile[]> {
  if (res.didCancel || !res.assets) return [];
  if (res.errorMessage) throw new Error(res.errorMessage);
  const out: PickedFile[] = [];
  for (const a of res.assets) {
    if (!a.base64) continue;
    out.push({
      name: a.fileName ?? fallbackName,
      mime: a.type ?? 'image/jpeg',
      data: await b64DecodeAsync(a.base64),
      w: a.width,
      h: a.height,
    });
    if (a.uri?.startsWith('file://')) RNFS.unlink(a.uri.replace('file://', '')).catch(() => {});
  }
  return out;
}

// ---- videos ----
//
// Recorded or picked videos are re-encoded (react-native-compressor: H.264
// MP4, about 720p) so a minute or so fits under the server's blob limit, and
// get a poster frame to show in the chat before anyone downloads the video.

/** Longest video the camera records, in seconds. */
const VIDEO_SECONDS = 120;

const pathOf = (uri: string) => decodeURI(uri.replace('file://', ''));

async function readVideo(uri: string, name: string, dur?: number): Promise<PickedFile> {
  const {Video, Image: ImageCompressor, createVideoThumbnail} = await import('react-native-compressor');
  const temps = [uri];
  try {
    const out = await Video.compress(uri, {compressionMethod: 'auto', maxSize: 1280});
    temps.push(out);
    let thumb: PickedFile['thumb'];
    try {
      const t = await createVideoThumbnail(out);
      temps.push(t.path);
      const small = await ImageCompressor.compress(t.path, {compressionMethod: 'manual', maxWidth: 480, maxHeight: 480, quality: 0.7, output: 'jpg'});
      temps.push(small);
      const scale = Math.min(1, 480 / Math.max(t.width, t.height));
      thumb = {data: await b64DecodeAsync(await RNFS.readFile(pathOf(small), 'base64')), w: Math.round(t.width * scale), h: Math.round(t.height * scale)};
    } catch {
      thumb = undefined; // it still plays; the bubble just has no picture
    }
    return {
      name: name.replace(/\.[^.]+$/, '') + '.mp4',
      mime: 'video/mp4',
      data: await b64DecodeAsync(await RNFS.readFile(pathOf(out), 'base64')),
      w: thumb?.w,
      h: thumb?.h,
      dur: dur ? Math.round(dur) : undefined,
      thumb,
    };
  } finally {
    for (const t of temps) if (t.startsWith('file://') || t.startsWith('/')) RNFS.unlink(pathOf(t)).catch(() => {});
  }
}

/** Opens the camera to record one video, which isn't saved to the gallery. Empty if cancelled. */
/** onCompressing: called as a video starts re-encoding (the slow part), not while the camera is open. */
export async function recordVideo(onCompressing?: () => void): Promise<PickedFile[]> {
  const res = await launchCamera({mediaType: 'video', videoQuality: 'high', durationLimit: VIDEO_SECONDS, saveToPhotos: false, formatAsMp4: true});
  if (res.errorCode === 'camera_unavailable') throw new Error('No camera available.');
  if (res.errorCode === 'permission') throw new Error('Super Chat needs camera access: allow it in Settings.');
  if (res.errorMessage) throw new Error(res.errorMessage);
  const a = res.assets?.[0];
  if (res.didCancel || !a?.uri) return [];
  onCompressing?.();
  return [await readVideo(a.uri, a.fileName ?? 'video.mp4', a.duration)];
}

/** Photos and videos from the gallery: photos re-encoded as before, videos as above. */
export async function pickMedia(onCompressing?: () => void): Promise<PickedFile[]> {
  const res = await launchImageLibrary({...PHOTO_OPTIONS, mediaType: 'mixed', includeBase64: false, selectionLimit: 6, formatAsMp4: true});
  // Errors first: a refused permission comes back with no assets too.
  if (res.errorCode === 'permission') throw new Error('Super Chat needs photo access: allow it in Settings.');
  if (res.errorMessage || res.errorCode) throw new Error(res.errorMessage || "Couldn't open the gallery.");
  if (res.didCancel || !res.assets) return [];
  const out: PickedFile[] = [];
  for (const a of res.assets) {
    if (!a.uri) continue;
    if (a.type?.startsWith('video/')) {
      onCompressing?.();
      out.push(await readVideo(a.uri, a.fileName ?? 'video.mp4', a.duration));
    } else {
      out.push({
        name: a.fileName ?? 'image.jpg',
        mime: a.type ?? 'image/jpeg',
        data: a.uri.startsWith('file://') ? await readAndDelete(pathOf(a.uri)) : await b64DecodeAsync(await RNFS.readFile(a.uri, 'base64')),
        w: a.width,
        h: a.height,
      });
    }
  }
  return out;
}

// ---- playing ----

const playDir = () => `${RNFS.CachesDirectoryPath}/play`;
// Anything left from last time (the app was killed mid-video) goes before the first new one.
let playDirReady: Promise<void> | null = null;

/**
 * A video or voice message, decrypted, as something the player can open: a
 * file in the cache (players stream from a file, not from memory), deleted
 * again by release() and on next launch.
 */
export async function playableUri(data: Uint8Array, mime: string): Promise<{uri: string; release: () => void}> {
  const ext = mime.includes('mp4') ? (mime.startsWith('audio/') ? 'm4a' : 'mp4') : (mime.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/g, '');
  playDirReady ??= RNFS.unlink(playDir())
    .catch(() => {})
    .then(() => RNFS.mkdir(playDir()));
  await playDirReady;
  const path = `${playDir()}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  await RNFS.writeFile(path, await b64EncodeAsync(data), 'base64');
  return {uri: `file://${path}`, release: () => RNFS.unlink(path).catch(() => {})};
}

export async function pickFiles(): Promise<PickedFile[]> {
  try {
    const picked = await pick({allowMultiSelection: true});
    const paths = await localCopies(picked);
    const out: PickedFile[] = [];
    for (let i = 0; i < picked.length; i++) {
      const path = paths[i];
      if (!path) continue;
      out.push({
        name: picked[i].name ?? 'file',
        mime: picked[i].type ?? 'application/octet-stream',
        data: await readAndDelete(path),
      });
    }
    return out;
  } catch (e) {
    if (isCancel(e)) return [];
    throw e;
  }
}

/** An in-memory data: URI for showing a decrypted image. */
export function dataUri(mime: string, data: Uint8Array): string {
  return `data:${mime};base64,${base64.encode(data)}`;
}
