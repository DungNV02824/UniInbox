// Tiện ích mime/đuôi tệp cho media.
import type { AttachmentType } from '@dezon/shared';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

export const DEFAULT_MIME = 'application/octet-stream';

/** "Image/JPEG; charset=x" -> "image/jpeg"; rỗng -> undefined. */
export function normalizeMime(mime: string | null | undefined): string | undefined {
  const value = mime?.split(';')[0]?.trim().toLowerCase();
  return value ? value : undefined;
}

/** Ảnh có thể chứa script khi trình duyệt mở trực tiếp. */
const ACTIVE_IMAGE_MIMES = new Set(['image/svg+xml']);

/**
 * Mime được phép lưu lên S3 (Content-Type khi trình duyệt mở URL ký): ảnh (trừ svg), video, audio và
 * các loại tài liệu đã biết. Còn lại (text/html, image/svg+xml, application/xhtml+xml...) =>
 * application/octet-stream để không render nội dung do khách gửi trên domain S3.
 */
export function safeStoredMime(mime: string): string {
  if (/^(image|video|audio)\/[a-z0-9.+-]+$/.test(mime) && !ACTIVE_IMAGE_MIMES.has(mime)) return mime;
  if (!ACTIVE_IMAGE_MIMES.has(mime) && mime in EXT_BY_MIME) return mime;
  return DEFAULT_MIME;
}

/** Mở trực tiếp trong trình duyệt (inline) được; loại khác lưu kèm Content-Disposition: attachment. */
export function isInlineMime(mime: string): boolean {
  return /^(image|video|audio)\//.test(mime) && !ACTIVE_IMAGE_MIMES.has(mime);
}

/** Content-Disposition: attachment kèm tên tệp (RFC 6266/5987, chỉ ký tự an toàn ở dạng ASCII). */
export function attachmentDisposition(filename?: string): string {
  if (!filename) return 'attachment';
  const ascii = filename.replace(/[^\w.\- ]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function typeFromMime(mime: string): AttachmentType {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Đuôi tệp theo mime; không biết thì lấy từ tên tệp, cuối cùng là 'bin'. */
export function extFromMime(mime: string, filename?: string): string {
  const known = EXT_BY_MIME[mime];
  if (known) return known;
  const fromName = filename?.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  return fromName ? fromName.toLowerCase() : 'bin';
}

/** Đổi đuôi tên tệp (khi ảnh bị chuyển định dạng). */
export function replaceExt(filename: string, ext: string): string {
  const dot = filename.lastIndexOf('.');
  return `${dot > 0 ? filename.slice(0, dot) : filename}.${ext}`;
}
