// The browser keeps no blob cache on disk (see blobDisk.ts for Android);
// store.ts's in-memory cache still saves refetches within a session.
export const getSealed = async (_blob: string): Promise<Uint8Array | null> => null;
export const putSealed = async (_blob: string, _sealed: Uint8Array): Promise<void> => {};
export const clearSealed = async (): Promise<void> => {};
export const removeSealed = async (_blobs: string[]): Promise<void> => {};
export const noteCached = (): void => {};
