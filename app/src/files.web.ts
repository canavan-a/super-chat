// Browser versions of src/files.ts: an <input type=file> to pick, and a
// temporary object URL to download.
import {base64} from '@scure/base';

import {unutf8, utf8} from './crypto';

export interface PickedFile {
  name: string;
  mime: string;
  data: Uint8Array;
  w?: number;
  h?: number;
  dur?: number;
  wave?: number[];
  thumb?: {data: Uint8Array; w: number; h: number};
}

function pick(accept: string, multiple: boolean, capture?: 'environment'): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    // Phones open the camera; desktops ignore it and show the file picker.
    if (capture) input.setAttribute('capture', capture);
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

async function read(f: File): Promise<PickedFile> {
  return {name: f.name, mime: f.type || 'application/octet-stream', data: new Uint8Array(await f.arrayBuffer())};
}

export interface TextFile {
  name: string;
  text: string;
}

export async function pickTextFile(): Promise<TextFile | null> {
  const [f] = await pick('.json,application/json', false);
  if (!f) return null;
  if (f.size > 64 * 1024) throw new Error(`${f.name} is too big to be a key file.`);
  return {name: f.name, text: unutf8(new Uint8Array(await f.arrayBuffer()))};
}

export interface SavedFile {
  name: string;
  location: string;
}

// Browsers have no save dialog to open first; these just download.
export async function saveFileAs(
  name: string,
  _mime: string,
  makeData: () => Promise<Uint8Array>,
): Promise<SavedFile | null> {
  return saveFile(name, await makeData());
}

export async function saveTextFileAs(name: string, makeText: () => Promise<string>): Promise<SavedFile | null> {
  return saveFile(name, utf8(await makeText()));
}

async function saveFile(name: string, data: Uint8Array): Promise<SavedFile> {
  const url = URL.createObjectURL(new Blob([data]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return {name, location: "your browser's downloads"};
}

export async function pickImages(): Promise<PickedFile[]> {
  return Promise.all((await pick('image/*', true)).slice(0, 6).map(read));
}

export async function takePhoto(): Promise<PickedFile[]> {
  return Promise.all((await pick('image/*', false, 'environment')).slice(0, 1).map(read));
}

/** Rejects if p hasn't settled in time: some browsers never fire a video's events. */
function within<T>(p: Promise<T>, ms = 8000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
}

/** A video, with its length and a poster frame grabbed through a <video> and a canvas. */
async function readVideo(f: File): Promise<PickedFile> {
  const file = await read(f);
  const url = URL.createObjectURL(f);
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = url;
    v.playsInline = true;
    v.load(); // Safari won't start loading an off-page video otherwise
    await within(
      new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error('unreadable'));
      }),
    );
    const dur = Number.isFinite(v.duration) ? Math.round(v.duration) : undefined;
    const at = Math.min(0.5, (v.duration || 1) / 2);
    if (Math.abs(v.currentTime - at) > 0.01) {
      await within(
        new Promise<void>((res, rej) => {
          v.onseeked = () => res();
          v.onerror = () => rej(new Error('unreadable'));
          v.currentTime = at;
        }),
      );
    }
    const scale = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    canvas.getContext('2d')!.drawImage(v, 0, 0, canvas.width, canvas.height);
    const thumb = {data: await toJpeg(canvas, 0.7), w: canvas.width, h: canvas.height};
    return {...file, w: thumb.w, h: thumb.h, dur, thumb};
  } catch {
    return file; // a format this browser can't decode: it still sends, without a picture
  } finally {
    URL.revokeObjectURL(url);
  }
}

const readAny = (f: File) => (f.type.startsWith('video/') ? readVideo(f) : read(f));

/** Phones open the camera in video mode; desktops show the file picker. */
export async function recordVideo(onCompressing?: () => void): Promise<PickedFile[]> {
  const files = (await pick('video/*', false, 'environment')).slice(0, 1);
  if (files.length) onCompressing?.();
  return Promise.all(files.map(readVideo));
}

export async function pickMedia(onCompressing?: () => void): Promise<PickedFile[]> {
  const files = (await pick('image/*,video/*', true)).slice(0, 6);
  if (files.some(f => f.type.startsWith('video/'))) onCompressing?.();
  return Promise.all(files.map(readAny));
}

/** A decrypted video or voice message for <video>/<audio>: an object URL, revoked by release(). */
export async function playableUri(data: Uint8Array, mime: string): Promise<{uri: string; release: () => void}> {
  const uri = URL.createObjectURL(new Blob([data as BlobPart], {type: mime}));
  return {uri, release: () => URL.revokeObjectURL(uri)};
}

export async function pickFiles(): Promise<PickedFile[]> {
  return Promise.all((await pick('*/*', true)).slice(0, 6).map(read));
}

export function dataUri(mime: string, data: Uint8Array): string {
  return `data:${mime};base64,${base64.encode(data)}`;
}

/** A photo picked to become a profile picture, before cropping (see files.ts). */
export interface AvatarSource {
  base64: string;
  width: number;
  height: number;
}

export const AVATAR_SIZE = 512;

const toJpeg = async (canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> => {
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', quality));
  if (!blob) throw new Error("Couldn't read that image.");
  return new Uint8Array(await blob.arrayBuffer());
};

/** Picks the photo to crop, re-encoded at up to 1600px (which also drops its EXIF). Null if cancelled. */
export async function pickAvatarSource(): Promise<AvatarSource | null> {
  const [f] = await pick('image/*', false);
  if (!f) return null;
  const img = await createImageBitmap(f);
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return {base64: base64.encode(await toJpeg(canvas, 0.9)), width: canvas.width, height: canvas.height};
}

/** Cuts the framed square (in source pixels) out and scales it to AVATAR_SIZE, as a JPEG. */
export async function cropAvatar(src: AvatarSource, x: number, y: number, size: number): Promise<Uint8Array> {
  const img = await createImageBitmap(new Blob([base64.decode(src.base64)], {type: 'image/jpeg'}));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_SIZE;
  canvas.getContext('2d')!.drawImage(img, x, y, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  return toJpeg(canvas, 0.85);
}
