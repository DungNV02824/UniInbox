// Tải một tệp đính kèm tin đến từ URL của nền tảng về S3 — dùng chung cho luồng nhận (inbound.ts) và luồng tự
// tải lại tệp hỏng (attachment-retry.ts) để mime/kích thước/khóa lưu xử lý giống hệt nhau.
import type { InboundAttachment, MessageAttachment } from '@dezon/shared';
import { DownloadError } from '../media/download';
import { DEFAULT_MIME } from '../media/mime';
import { downloadToBuffer, storeMedia } from '../media/storage';
import type { MediaStorage, StoredMedia } from '../media/types';
import type { PipelineDeps } from './types';

/** Lỗi khi GHI vào kho (S3) — không phải lỗi của link nền tảng. */
export class AttachmentStoreError extends Error {
  override readonly name = 'AttachmentStoreError';
}

/**
 * Thời gian tối đa cho một lệnh GHI kho. Client S3 không có timeout mặc định: kho nhận kết nối mà không trả lời
 * (SeaweedFS chờ cấp volume…) thì lệnh ghi treo mãi — job nhận tin / lượt tải lại kẹt theo.
 */
export const ATTACHMENT_STORE_TIMEOUT_MS = 90_000;

export interface DownloadAndStoreOptions {
  /** Mặc định ATTACHMENT_STORE_TIMEOUT_MS. */
  storeTimeoutMs?: number;
}

/** Tải URL (giới hạn deps.maxMediaBytes) rồi lưu prefix 'media'. Ném DownloadError hoặc AttachmentStoreError. */
export async function downloadAndStoreAttachment(
  deps: Pick<PipelineDeps, 'storage' | 'maxMediaBytes' | 'fetch'>,
  att: Pick<InboundAttachment, 'url' | 'type' | 'mime' | 'name'>,
  options: DownloadAndStoreOptions = {},
): Promise<StoredMedia> {
  const file = await downloadToBuffer(att.url, {
    maxBytes: deps.maxMediaBytes,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const mime = file.mime && file.mime !== DEFAULT_MIME ? file.mime : (att.mime ?? file.mime);
  return storeMedia(guardPuts(deps.storage, options.storeTimeoutMs ?? ATTACHMENT_STORE_TIMEOUT_MS), {
    data: file.data,
    ...(mime ? { mime } : {}),
    ...(att.name ? { filename: att.name } : {}),
    type: att.type,
    prefix: 'media',
    originalUrl: att.url,
  });
}

/**
 * Chỉ lỗi của lệnh ghi (put) mới là lỗi kho; lỗi xử lý tệp khác trong storeMedia giữ nguyên. Mỗi lệnh ghi có hạn
 * timeoutMs: hủy request (signal) và — phòng kho không hỗ trợ hủy — không đợi quá hạn.
 */
function guardPuts(storage: MediaStorage, timeoutMs: number): MediaStorage {
  const put: MediaStorage['put'] = async (key, body, contentType, options) => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AttachmentStoreError(`Lưu tệp vào kho quá thời gian (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([
        storage
          .put(key, body, contentType, { ...options, signal: controller.signal })
          .catch((error: unknown) => {
            if (error instanceof AttachmentStoreError) throw error;
            throw new AttachmentStoreError(
              `Lưu tệp vào kho thất bại: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    put,
    get: (key) => storage.get(key),
    getStream: (key) => storage.getStream(key),
    delete: (key) => storage.delete(key),
    signedUrl: (key, ttlSec) => storage.signedUrl(key, ttlSec),
    ping: () => storage.ping(),
  };
}

/**
 * Phần tử giữ chỗ cho tệp tải hỏng: storage_key = '' + original_url (DTO trả url = null) để nhân viên biết khách có
 * gửi tệp; worker tự tải lại (attachment-retry.ts).
 */
export function failedAttachment(
  att: Pick<InboundAttachment, 'url' | 'type' | 'mime' | 'name'>,
): MessageAttachment {
  return {
    type: att.type,
    storage_key: '',
    mime: att.mime ?? DEFAULT_MIME,
    original_url: att.url,
    ...(att.name ? { name: att.name } : {}),
  };
}

/**
 * Lỗi vĩnh viễn (không tải lại nữa): CDN trả 403/404/410 (link hết hạn / tệp bị gỡ) hoặc tệp vượt giới hạn.
 * Lỗi mạng, quá thời gian, 5xx, 429 và lỗi kho đều là tạm thời.
 */
export function isPermanentAttachmentError(error: unknown): boolean {
  if (!(error instanceof DownloadError)) return false;
  if (error.reason === 'too_large') return true;
  return error.reason === 'http' && (error.status === 403 || error.status === 404 || error.status === 410);
}
