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
}

function pick(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
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

export async function pickFiles(): Promise<PickedFile[]> {
  return Promise.all((await pick('*/*', true)).slice(0, 6).map(read));
}

export function dataUri(mime: string, data: Uint8Array): string {
  return `data:${mime};base64,${base64.encode(data)}`;
}
