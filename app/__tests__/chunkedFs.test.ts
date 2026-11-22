// src/chunkedFs.ts against an in-memory stand-in for react-native-fs that
// behaves like the native side: base64 in and out, read(length, position).
const mockFiles = new Map<string, Buffer>();
const mockCalls: string[] = [];

jest.mock('react-native-fs', () => ({
  __esModule: true,
  default: {
    stat: async (p: string) => {
      const f = mockFiles.get(p);
      if (!f) throw new Error('ENOENT');
      return {size: f.length};
    },
    exists: async (p: string) => mockFiles.has(p),
    readFile: async (p: string) => {
      mockCalls.push('readFile');
      return mockFiles.get(p)!.toString('base64');
    },
    read: async (p: string, length: number, position: number) => {
      mockCalls.push('read');
      return mockFiles.get(p)!.subarray(position, position + length).toString('base64');
    },
    writeFile: async (p: string, b64: string) => {
      mockCalls.push('writeFile');
      mockFiles.set(p, Buffer.from(b64, 'base64'));
    },
    appendFile: async (p: string, b64: string) => {
      mockCalls.push('appendFile');
      if (!mockFiles.has(p)) throw new Error('ENOENT');
      mockFiles.set(p, Buffer.concat([mockFiles.get(p)!, Buffer.from(b64, 'base64')]));
    },
    moveFile: async (from: string, to: string) => {
      if (mockFiles.has(to)) throw new Error('exists'); // as on iOS
      mockFiles.set(to, mockFiles.get(from)!);
      mockFiles.delete(from);
    },
    unlink: async (p: string) => {
      if (!mockFiles.delete(p)) throw new Error('ENOENT');
    },
  },
}));

import {readFileChunked, writeFileChunked} from '../src/chunkedFs';

const bytes = (n: number) => Uint8Array.from({length: n}, (_, i) => (i * 7 + Math.floor(i / 512)) % 256);

beforeEach(() => {
  mockFiles.clear();
  mockCalls.length = 0;
});

test.each([0, 1, 1000, 3 * 256 * 1024, 3 * 256 * 1024 + 1, 5 * 1024 * 1024 + 17])('round-trips %i bytes', async n => {
  const data = bytes(n);
  await writeFileChunked('/f', data);
  expect([...mockFiles.keys()]).toEqual(['/f']); // no temp file left behind
  expect(Buffer.from(await readFileChunked('/f')).equals(Buffer.from(data))).toBe(true);
});

test('big files cross the bridge in slices, not one string', async () => {
  await writeFileChunked('/f', bytes(5 * 1024 * 1024));
  expect(mockCalls.filter(c => c === 'appendFile').length).toBeGreaterThan(5);
  mockCalls.length = 0;
  await readFileChunked('/f');
  expect(mockCalls).not.toContain('readFile');
  expect(mockCalls.filter(c => c === 'read').length).toBeGreaterThan(5);
});

test('overwrites an existing file', async () => {
  await writeFileChunked('/f', bytes(10));
  await writeFileChunked('/f', bytes(2 * 1024 * 1024));
  expect((await readFileChunked('/f')).length).toBe(2 * 1024 * 1024);
});
