import type { AttachmentType } from '@dezon/shared';

type MagicCheck = (data: Buffer) => boolean;

const startsWith =
  (...bytes: number[]): MagicCheck =>
  (data) =>
    data.length >= bytes.length && bytes.every((b, i) => data[i] === b);

const isJpeg = startsWith(0xff, 0xd8, 0xff);
const isPng = startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const isGif = (data: Buffer) => ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('latin1'));
const isWebp = (data: Buffer) =>
  data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP';
const isPdf = (data: Buffer) => data.subarray(0, 5).toString('latin1') === '%PDF-';
/** zip, docx, xlsx đều là ZIP (PK\x03\x04; PK\x05\x06 = zip rỗng). */
const isZip = (data: Buffer) =>
  startsWith(0x50, 0x4b, 0x03, 0x04)(data) || startsWith(0x50, 0x4b, 0x05, 0x06)(data);
/** doc, xls đời cũ: OLE Compound File. */
const isOle = startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
/** Văn bản: không chứa byte NUL. */
const isText = (data: Buffer) => !data.includes(0);

interface UploadRule {
  type: AttachmentType;
  matches: MagicCheck;
}

/** Whitelist mime nhân viên được tải lên (ảnh + tài liệu thường gặp). */
export const UPLOAD_RULES: Readonly<Record<string, UploadRule>> = {
  'image/jpeg': { type: 'image', matches: isJpeg },
  'image/png': { type: 'image', matches: isPng },
  'image/webp': { type: 'image', matches: isWebp },
  'image/gif': { type: 'image', matches: isGif },
  'application/pdf': { type: 'file', matches: isPdf },
  'application/msword': { type: 'file', matches: isOle },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { type: 'file', matches: isZip },
  'application/vnd.ms-excel': { type: 'file', matches: isOle },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { type: 'file', matches: isZip },
  'text/plain': { type: 'file', matches: isText },
  'application/zip': { type: 'file', matches: isZip },
  'application/x-zip-compressed': { type: 'file', matches: isZip },
};

export type UploadCheck =
  { ok: true; mime: string; type: AttachmentType } | { ok: false; reason: 'mime' | 'content' | 'empty' };

/** Chuẩn hóa mime (bỏ tham số, chữ thường) rồi kiểm whitelist và chữ ký đầu tệp. */
export function checkUpload(rawMime: string, data: Buffer): UploadCheck {
  const mime = rawMime.split(';')[0]!.trim().toLowerCase();
  const rule = UPLOAD_RULES[mime];
  if (!rule) return { ok: false, reason: 'mime' };
  if (data.length === 0) return { ok: false, reason: 'empty' };
  if (!rule.matches(data)) return { ok: false, reason: 'content' };
  return { ok: true, mime, type: rule.type };
}
