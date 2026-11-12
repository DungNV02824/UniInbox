// Phân loại lỗi tải lại tệp (vĩnh viễn / tạm thời / lỗi kho) và hạn ghi kho — không cần Postgres.
import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorage } from '../../test/helpers/memory-storage';
import { DownloadError, downloadToBuffer } from '../media/download';
import {
  AttachmentStoreError,
  downloadAndStoreAttachment,
  isPermanentAttachmentError,
} from './attachment-download';
import { safeErrorMessage } from './helpers';
import { DrizzleQueryError } from 'drizzle-orm';

const URL_WITH_TOKEN = 'https://scontent.xx.fbcdn.net/v/t1/abc.jpg?oh=SECRET&oe=1234';

const fetchReturning = (res: () => Response | Promise<Response>) => vi.fn<typeof fetch>(async () => res());

async function downloadError(fetchImpl: typeof fetch, maxBytes = 1000): Promise<unknown> {
  return downloadToBuffer(URL_WITH_TOKEN, { maxBytes, fetch: fetchImpl }).then(
    () => {
      throw new Error('Phải lỗi');
    },
    (e: unknown) => e,
  );
}

describe('isPermanentAttachmentError + DownloadError', () => {
  it.each([403, 404, 410])('CDN trả HTTP %i (link hết hạn / tệp bị gỡ) ⇒ vĩnh viễn', async (status) => {
    const error = await downloadError(fetchReturning(() => new Response('x', { status })));
    expect(error).toBeInstanceOf(DownloadError);
    expect(error).toMatchObject({ reason: 'http', status });
    expect(isPermanentAttachmentError(error)).toBe(true);
  });

  it.each([400, 401, 408, 429, 500, 502, 503, 504])('HTTP %i ⇒ tạm thời (thử lại sau)', async (status) => {
    const error = await downloadError(fetchReturning(() => new Response('x', { status })));
    expect(error).toMatchObject({ reason: 'http', status });
    expect(isPermanentAttachmentError(error)).toBe(false);
  });

  it('quá thời gian (TimeoutError / AbortError) ⇒ tạm thời', async () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      const error = await downloadError(
        vi.fn<typeof fetch>(async () => {
          throw new DOMException('aborted', name);
        }),
      );
      expect(error).toBeInstanceOf(DownloadError);
      // AbortError không do signal của mình ⇒ coi như lỗi mạng; cả hai đều tạm thời.
      expect(['timeout', 'network']).toContain((error as DownloadError).reason);
      expect(isPermanentAttachmentError(error)).toBe(false);
    }
  });

  it('lỗi mạng ⇒ tạm thời, thông điệp không chứa URL', async () => {
    const error = await downloadError(
      vi.fn<typeof fetch>(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(error).toMatchObject({ reason: 'network' });
    expect((error as Error).message).not.toContain('SECRET');
    expect(isPermanentAttachmentError(error)).toBe(false);
  });

  it('Content-Length vượt giới hạn ⇒ too_large, vĩnh viễn', async () => {
    const error = await downloadError(
      fetchReturning(() => new Response(new Uint8Array(10), { headers: { 'content-length': '5000' } })),
    );
    expect(error).toMatchObject({ reason: 'too_large' });
    expect(isPermanentAttachmentError(error)).toBe(true);
  });

  it('stream vượt giới hạn (không có Content-Length) ⇒ too_large, vĩnh viễn', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(400));
        controller.close();
      },
    });
    const error = await downloadError(fetchReturning(() => new Response(body)));
    expect(error).toMatchObject({ reason: 'too_large' });
    expect(isPermanentAttachmentError(error)).toBe(true);
  });

  it('lỗi kho và lỗi lạ không phải vĩnh viễn', () => {
    expect(isPermanentAttachmentError(new AttachmentStoreError('kho hỏng'))).toBe(false);
    expect(isPermanentAttachmentError(new Error('HTTP 404'))).toBe(false);
  });
});

describe('downloadAndStoreAttachment — ghi kho', () => {
  const ok = () =>
    fetchReturning(
      () => new Response(Buffer.from('%PDF-1.4'), { headers: { 'content-type': 'application/pdf' } }),
    );

  it('lệnh ghi lỗi ⇒ AttachmentStoreError (giữ lỗi gốc trong cause)', async () => {
    const storage = createMemoryStorage();
    const cause = new Error('We encountered an internal error, please try again.');
    storage.put = async () => {
      throw cause;
    };
    const error = await downloadAndStoreAttachment(
      { storage, maxMediaBytes: 1000, fetch: ok() },
      { url: URL_WITH_TOKEN, type: 'file' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AttachmentStoreError);
    expect((error as Error).cause).toBe(cause);
  });

  it('lệnh ghi treo ⇒ hủy request (signal) và báo AttachmentStoreError sau storeTimeoutMs', async () => {
    const storage = createMemoryStorage();
    let signal: AbortSignal | undefined;
    storage.put = (_key, _body, _type, options) => {
      signal = options?.signal;
      return new Promise<void>(() => undefined);
    };
    const error = await downloadAndStoreAttachment(
      { storage, maxMediaBytes: 1000, fetch: ok() },
      { url: URL_WITH_TOKEN, type: 'file' },
      { storeTimeoutMs: 30 },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AttachmentStoreError);
    expect((error as Error).message).toMatch(/quá thời gian/);
    expect(signal?.aborted).toBe(true);
  });

  it('ghi bình thường: truyền signal, lưu prefix media', async () => {
    const storage = createMemoryStorage();
    const put = vi.spyOn(storage, 'put');
    const stored = await downloadAndStoreAttachment(
      { storage, maxMediaBytes: 1000, fetch: ok() },
      { url: URL_WITH_TOKEN, type: 'file', name: 'bao-gia.pdf' },
    );
    expect(stored.storage_key).toMatch(/^media\//);
    expect(storage.objects.has(stored.storage_key)).toBe(true);
    expect(put.mock.calls[0]![3]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('safeErrorMessage', () => {
  it('lỗi truy vấn drizzle: không lộ SQL/params (URL CDN có token), chỉ lỗi gốc của Postgres', () => {
    const pgError = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });
    const error = new DrizzleQueryError(
      'update "messages" set "attachments" = $1 where "messages"."id" = $2',
      [JSON.stringify([{ storage_key: '', original_url: URL_WITH_TOKEN, name: 'Nguyễn Văn A.jpg' }]), 'id'],
      pgError,
    );
    const message = safeErrorMessage(error);
    expect(message).toBe('Lỗi truy vấn DB [57P01]: terminating connection due to administrator command');
    expect(message).not.toContain('https://');
    expect(message).not.toContain('Nguyễn');
  });

  it('lỗi khác: che URL còn sót', () => {
    expect(safeErrorMessage(new Error(`fetch ${URL_WITH_TOKEN} failed`))).toBe('fetch <url> failed');
    expect(safeErrorMessage('db down')).toBe('db down');
  });
});
