// MediaStorage giả trong bộ nhớ cho test.
import { Readable } from 'node:stream';
import type { MediaStorage } from '../../src/media/types';

export interface MemoryStorage extends MediaStorage {
  objects: Map<string, { body: Buffer; contentType: string; contentDisposition?: string }>;
}

export function createMemoryStorage(): MemoryStorage {
  const objects = new Map<string, { body: Buffer; contentType: string; contentDisposition?: string }>();
  const read = (key: string): Buffer => {
    const obj = objects.get(key);
    if (!obj) throw new Error(`Không có tệp ${key}`);
    return obj.body;
  };
  return {
    objects,
    async put(key, body, contentType, options) {
      objects.set(key, {
        body,
        contentType,
        ...(options?.contentDisposition ? { contentDisposition: options.contentDisposition } : {}),
      });
    },
    async get(key) {
      return read(key);
    },
    async getStream(key) {
      return Readable.from(read(key));
    },
    async delete(key) {
      objects.delete(key);
    },
    async signedUrl(key) {
      return `https://signed.test/${key}`;
    },
    async ping() {},
  };
}
