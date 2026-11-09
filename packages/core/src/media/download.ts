// Tải URL tạm của nền tảng (ảnh/tệp khách gửi, avatar) về bộ nhớ, có giới hạn kích thước và thời gian.
import { normalizeMime } from './mime';

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface DownloadOptions {
  maxBytes: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Đọc stream và dừng ngay khi vượt maxBytes (không tin Content-Length). Lỗi KHÔNG chứa URL
 * (URL CDN của nền tảng có token).
 */
export async function downloadToBuffer(
  url: string,
  opts: DownloadOptions,
): Promise<{ data: Buffer; mime?: string }> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await doFetch(url, { signal, redirect: 'follow' });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Tải tệp thất bại: HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge(opts.maxBytes);
    }
    const data = await readLimited(res, opts.maxBytes);
    const mime = normalizeMime(res.headers.get('content-type'));
    return mime ? { data, mime } : { data };
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
      throw new Error(`Tải tệp quá thời gian (${Math.round(timeoutMs / 1000)}s)`, { cause: error });
    }
    if (error instanceof Error && error.message.startsWith('Tải tệp')) throw error;
    throw new Error(`Tải tệp thất bại: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function tooLarge(maxBytes: number): Error {
  const limit = maxBytes >= 1024 * 1024 ? `${Math.floor(maxBytes / 1024 / 1024)} MB` : `${maxBytes} byte`;
  return new Error(`Tải tệp thất bại: tệp vượt quá ${limit}`);
}

async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
