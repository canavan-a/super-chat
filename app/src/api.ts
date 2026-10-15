// Signed requests to a Super Chat server (docs/protocol.md, "Signed
// requests"). There are no accounts and no logins: each request is signed by
// the member key for the room it's about (see memberIdentity), so the server
// can check you belong without learning who you are or what else you're in.
import {sha256} from '@noble/hashes/sha256';

import {b64, bytesToHex, newId, sign, Signer, utf8} from './crypto';
import type {Batch, ServerMessage, SignedEvent, VaultKeys} from './crypto';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any = null) {
    super(message);
  }
}

function signedHeaders(by: Signer, method: string, pathQuery: string, body: Uint8Array): Record<string, string> {
  const ts = String(Date.now());
  const nonce = newId();
  const msg = utf8(`SC1\n${method}\n${pathQuery}\n${ts}\n${nonce}\n${bytesToHex(sha256(body))}`);
  return {
    'X-SC-Member': by.id,
    'X-SC-Ts': ts,
    'X-SC-Nonce': nonce,
    'X-SC-Sig': b64(sign(by.edSeed, '', msg)),
  };
}

/** How long an API call may take before it's given up on. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Attachments can be large, and uploads slow: more time (XHR counts the whole transfer). */
const DOWNLOAD_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 300_000;

/** A request; signed when `by` is given. */
export async function request<T>(server: string, method: string, path: string, by: Signer | null, body?: unknown): Promise<T> {
  const bytes = body === undefined ? new Uint8Array() : utf8(JSON.stringify(body));
  // A request that never answers (a dead connection, an unreachable server)
  // fails after a while instead of holding everything waiting on it forever.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await fetch(server + path, {
      method,
      headers: {
        ...(by ? signedHeaders(by, method, path, bytes) : {}),
        ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort.signal,
    });
    text = await res.text();
  } catch (e) {
    if (abort.signal.aborted) throw new ApiError(0, `${server.replace(/^https?:\/\//, '')} didn't answer`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  if (!res.ok) {
    throw new ApiError(res.status, json?.error ?? `HTTP ${res.status}`, json);
  }
  return json as T;
}

// Binary transfers go through XMLHttpRequest: React Native's fetch can't
// read a response as an ArrayBuffer, but its XHR can (responseType).
function xhr(
  server: string,
  method: 'GET' | 'PUT',
  path: string,
  by: Signer,
  body?: Uint8Array,
  onProgress?: (fraction: number) => void,
): Promise<{status: number; data: any}> {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest();
    req.open(method, server + path);
    for (const [k, v] of Object.entries(signedHeaders(by, method, path, body ?? new Uint8Array()))) req.setRequestHeader(k, v);
    // Android's networking layer refuses a binary body without a content
    // type (it fails as a bare "network error"); the server ignores it.
    if (body) req.setRequestHeader('Content-Type', 'application/octet-stream');
    if (method === 'GET') req.responseType = 'arraybuffer';
    if (onProgress) {
      const target = method === 'PUT' ? req.upload : req;
      target.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    }
    req.onload = () => resolve({status: req.status, data: req.response});
    req.timeout = method === 'PUT' ? UPLOAD_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS;
    req.ontimeout = () => reject(new ApiError(0, 'timed out'));
    req.onerror = () => reject(new ApiError(0, 'network error'));
    req.send(body as any);
  });
}

export async function uploadBlob(
  server: string,
  room: string,
  by: Signer,
  sealed: Uint8Array,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const res = await xhr(server, 'PUT', `/v1/rooms/${room}/blobs`, by, sealed, onProgress);
  if (res.status !== 201) throw new ApiError(res.status, 'upload failed');
  return JSON.parse(typeof res.data === 'string' ? res.data : '{}').id;
}

/** The signed GET for a blob, for native code to send itself (see BlobModule.kt). Sign it just before use: the server rejects stale timestamps. */
export function blobRequest(server: string, room: string, by: Signer, blob: string): {url: string; headers: Record<string, string>} {
  const path = `/v1/rooms/${room}/blobs/${blob}`;
  return {url: server + path, headers: signedHeaders(by, 'GET', path, new Uint8Array())};
}

export async function downloadBlob(server: string, room: string, by: Signer, blob: string): Promise<Uint8Array> {
  const res = await xhr(server, 'GET', `/v1/rooms/${room}/blobs/${blob}`, by);
  if (res.status !== 200) throw new ApiError(res.status, 'download failed');
  return new Uint8Array(res.data as ArrayBuffer);
}

// ---- endpoints ----

export interface StoredEvent extends SignedEvent {
  seq: number;
  hash: string;
}

export interface Head {
  seq: number;
  hash: string;
}

export const api = {
  health: async (server: string): Promise<boolean> => {
    try {
      const res = await fetch(server + '/health');
      const j = await res.json();
      return res.ok && j?.app === 'superchat';
    } catch {
      return false;
    }
  },
  createRoom: (server: string, by: Signer, batch: Batch) =>
    request<{id: string; head: Head}>(server, 'POST', '/v1/rooms', by, batch),
  state: (server: string, room: string, by: Signer, since = 0) =>
    request<{events: StoredEvent[]; lastPos: number; lastAt: number}>(server, 'GET', `/v1/rooms/${room}/state?since=${since}`, by),
  append: (server: string, room: string, by: Signer, batch: Batch) =>
    request<{head: Head}>(server, 'POST', `/v1/rooms/${room}/events`, by, batch),
  keys: (server: string, room: string, by: Signer) =>
    request<{envelopes: {epoch: number; sealed: string}[]}>(server, 'GET', `/v1/rooms/${room}/keys`, by).then(r => r.envelopes),
  messages: (server: string, room: string, by: Signer, q: {before?: number; after?: number; limit?: number}) => {
    const params = Object.entries(q)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return request<{messages: ServerMessage[]}>(server, 'GET', `/v1/rooms/${room}/messages${params ? '?' + params : ''}`, by).then(
      r => r.messages,
    );
  },
  post: (server: string, room: string, by: Signer, m: {id: string; epoch: number; kind: string; ct: string; blobs?: string[]}) =>
    request<{pos: number; createdAt: number}>(server, 'POST', `/v1/rooms/${room}/messages`, by, m),
  inviteUses: (server: string, room: string, by: Signer) =>
    request<{uses: {invite: string; member: string; usedAt: number}[]}>(server, 'GET', `/v1/rooms/${room}/invites/uses`, by).then(
      r => r.uses,
    ),
  getInvite: (server: string, invite: string) =>
    request<{room: string; preview: string; events: StoredEvent[]}>(server, 'GET', `/v1/invites/${invite}`, null),
  join: (server: string, invite: string, by: Signer, batch: Batch) =>
    request<{room: string; head: Head}>(server, 'POST', `/v1/invites/${invite}/join`, by, batch),
  getVault: async (server: string, k: VaultKeys): Promise<string | null> => {
    try {
      return (await request<{blob: string}>(server, 'GET', `/v1/vault/${k.id}`, null)).blob;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  putVault: (server: string, k: VaultKeys, blob: string) => request<void>(server, 'PUT', `/v1/vault/${k.id}`, k.signer, {blob}),
  /** Marks an uploaded blob as my profile picture in this room ("" clears it). */
  setAvatar: (server: string, room: string, by: Signer, blob: string) =>
    request<void>(server, 'PUT', `/v1/rooms/${room}/avatar`, by, {blob}),
  /** Admins: marks an uploaded blob as the room's group picture ("" clears it). */
  setPicture: (server: string, room: string, by: Signer, blob: string) =>
    request<void>(server, 'PUT', `/v1/rooms/${room}/picture`, by, {blob}),
  /** The STUN/TURN servers (and short-lived TURN credentials) this server offers for voice. */
  turn: (server: string, room: string, by: Signer) =>
    request<{urls: string[]; username?: string; credential?: string; ttl?: number}>(server, 'GET', `/v1/rooms/${room}/turn`, by),
};
