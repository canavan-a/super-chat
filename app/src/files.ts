// Picking and saving files on Android. Picked files are copied into the
// app's cache (so a content:// URI can be read), read into memory, and the
// copy is deleted straight away: nothing decrypted or about to be encrypted
// is left lying on disk.
import DocumentPicker from 'react-native-document-picker';
import {launchImageLibrary} from 'react-native-image-picker';
import RNFS from 'react-native-fs';
import {NativeModules} from 'react-native';
import {base64} from '@scure/base';

import {unutf8, utf8} from './crypto';

export interface PickedFile {
  name: string;
  mime: string;
  data: Uint8Array;
  w?: number;
  h?: number;
}

async function readAndDelete(path: string): Promise<Uint8Array> {
  try {
    return base64.decode(await RNFS.readFile(path, 'base64'));
  } finally {
    RNFS.unlink(path).catch(() => {});
  }
}

export interface TextFile {
  name: string;
  text: string;
}

/** Null if the picker was cancelled. Throws with a readable message. */
export async function pickTextFile(): Promise<TextFile | null> {
  let f;
  try {
    [f] = await DocumentPicker.pick({type: [DocumentPicker.types.allFiles], copyTo: 'cachesDirectory'});
  } catch (e) {
    if (DocumentPicker.isCancel(e)) return null;
    throw new Error("Couldn't open the file picker.");
  }
  if (!f.fileCopyUri) throw new Error(`Couldn't read ${f.name ?? 'that file'}.`);
  const bytes = await readAndDelete(decodeURI(f.fileCopyUri.replace('file://', '')));
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
const FileSaver = NativeModules.FileSaver as FileSaverNative;

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
  const uri = await FileSaver.create(name, mime || 'application/octet-stream');
  if (!uri) return null;
  try {
    const saved = await FileSaver.write(uri, base64.encode(await makeData()));
    return {name: saved ?? name, location: 'the folder you picked'};
  } catch (e) {
    FileSaver.discard(uri).catch(() => {});
    throw e;
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

export async function pickImages(): Promise<PickedFile[]> {
  const res = await launchImageLibrary({
    mediaType: 'photo',
    selectionLimit: 6,
    // Downscaled and re-encoded, which also strips EXIF (location etc.).
    maxWidth: 2048,
    maxHeight: 2048,
    quality: 0.8,
    includeBase64: true,
  });
  if (res.didCancel || !res.assets) return [];
  if (res.errorMessage) throw new Error(res.errorMessage);
  const out: PickedFile[] = [];
  for (const a of res.assets) {
    if (!a.base64) continue;
    out.push({
      name: a.fileName ?? 'image.jpg',
      mime: a.type ?? 'image/jpeg',
      data: base64.decode(a.base64),
      w: a.width,
      h: a.height,
    });
    if (a.uri?.startsWith('file://')) RNFS.unlink(a.uri.replace('file://', '')).catch(() => {});
  }
  return out;
}

export async function pickFiles(): Promise<PickedFile[]> {
  try {
    const picked = await DocumentPicker.pick({allowMultiSelection: true, copyTo: 'cachesDirectory'});
    const out: PickedFile[] = [];
    for (const f of picked) {
      if (!f.fileCopyUri) continue;
      out.push({
        name: f.name ?? 'file',
        mime: f.type ?? 'application/octet-stream',
        data: await readAndDelete(decodeURI(f.fileCopyUri.replace('file://', ''))),
      });
    }
    return out;
  } catch (e) {
    if (DocumentPicker.isCancel(e)) return [];
    throw e;
  }
}

/** An in-memory data: URI for showing a decrypted image. */
export function dataUri(mime: string, data: Uint8Array): string {
  return `data:${mime};base64,${base64.encode(data)}`;
}
