import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadToBuffer } from './download';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'image/png; charset=binary' });
        res.end(Buffer.alloc(100, 1));
        return;
      case '/big-no-length':
        // Không có Content-Length: stream nhiều chunk, phải chặn khi vượt giới hạn.
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        for (let i = 0; i < 20; i++) res.write(Buffer.alloc(1024));
        res.end();
        return;
      case '/big-length':
        res.writeHead(200, { 'content-length': '5000' });
        res.end(Buffer.alloc(5000));
        return;
      case '/slow':
        res.writeHead(200);
        res.write('a');
        setTimeout(() => res.end('b'), 2_000).unref();
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('downloadToBuffer', () => {
  it('tải được và trả mime từ Content-Type', async () => {
    const result = await downloadToBuffer(`${base}/ok`, { maxBytes: 1000 });
    expect(result.data.byteLength).toBe(100);
    expect(result.mime).toBe('image/png');
  });

  it('chặn khi vượt maxBytes dù không có Content-Length', async () => {
    await expect(downloadToBuffer(`${base}/big-no-length`, { maxBytes: 4096 })).rejects.toThrow(/vượt quá/);
  });

  it('chặn sớm theo Content-Length', async () => {
    await expect(downloadToBuffer(`${base}/big-length`, { maxBytes: 1000 })).rejects.toThrow(/vượt quá/);
  });

  it('quá thời gian thì báo lỗi rõ ràng', async () => {
    await expect(downloadToBuffer(`${base}/slow`, { maxBytes: 1000, timeoutMs: 200 })).rejects.toThrow(
      /quá thời gian/,
    );
  });

  it('HTTP lỗi thì ném lỗi kèm mã', async () => {
    await expect(downloadToBuffer(`${base}/missing`, { maxBytes: 1000 })).rejects.toThrow(/HTTP 404/);
  });

  it('lỗi không chứa URL', async () => {
    const error = await downloadToBuffer('http://127.0.0.1:1/secret-token', { maxBytes: 10 }).catch(
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('secret-token');
  });
});
