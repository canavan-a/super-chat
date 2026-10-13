// Picking and saving files on Android. Picked files are copied into the
// app's cache (so a content:// URI can be read), read into memory, and the
// copy is deleted straight away: nothing decrypted or about to be encrypted
// is left lying on disk.
import DocumentPicker from 'react-native-document-picker';
import {launchImageLibrary} from 'react-native-image-picker';
import RNFS from 'react-native-fs';
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

export async function pickTextFile(): Promise<string | null> {
  try {
    const [f] = await DocumentPicker.pick({type: [DocumentPicker.types.allFiles], copyTo: 'cachesDirectory'});
    if (!f.fileCopyUri) throw new Error(f.copyError ?? "Couldn't read that file.");
    return unutf8(await readAndDelete(decodeURI(f.fileCopyUri.replace('file://', ''))));
  } catch (e) {
    if (DocumentPicker.isCancel(e)) return null;
    throw e;
  }
}

/** Saves to Downloads. Returns a message saying where. */
export async function saveTextFile(name: string, text: string): Promise<string> {
  return saveFile(name, utf8(text));
}

export async function saveFile(name: string, data: Uint8Array): Promise<string> {
  const safe = name.replace(/[^\w.\- ]/g, '_') || 'file';
  let path = `${RNFS.DownloadDirectoryPath}/${safe}`;
  for (let i = 1; await RNFS.exists(path); i++) {
    path = `${RNFS.DownloadDirectoryPath}/${safe.replace(/(\.[^.]*)?$/, ` (${i})$1`)}`;
  }
  await RNFS.writeFile(path, base64.encode(data), 'base64');
  return `Saved to Downloads as ${path.split('/').pop()}.`;
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
