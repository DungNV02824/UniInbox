// Chuyển message.attachments[] của Messenger thành InboundAttachment (docs/research/messenger-platform.md §3a).
// Loại không tải được (fallback/post/reel/template/location...) => bỏ, nhưng ghi chú vào text để nhân viên thấy.
import type { InboundAttachment } from '@dezon/shared';
import { z } from 'zod';

const attachmentSchema = z.looseObject({
  type: z.string(),
  payload: z
    .looseObject({
      url: z.string().optional(),
      title: z.string().optional(),
      sticker_id: z.union([z.number(), z.string()]).optional(),
    })
    .nullable()
    .optional(),
});

type RawAttachment = z.infer<typeof attachmentSchema>;

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file']);

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
  txt: 'text/plain',
};

/** URL http(s) hợp lệ (InboundAttachment.url yêu cầu URL). */
export function parseHttpUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Tên tệp cuối đường dẫn CDN (Messenger giữ tên gốc cho type 'file'). */
function fileNameOf(url: URL): string | undefined {
  const last = url.pathname.split('/').filter(Boolean).pop();
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Đoán mime theo đuôi tệp trong URL; không chắc thì bỏ trống (bước tải về sẽ lấy content-type). */
function mimeOf(url: URL): string | undefined {
  const ext = url.pathname.split('.').pop()?.toLowerCase();
  return ext ? MIME_BY_EXT[ext] : undefined;
}

function noteFor(att: RawAttachment, url: URL | undefined): string {
  const title = att.payload?.title?.trim();
  const link = url ? url.toString() : undefined;
  const label = [title, link].filter(Boolean).join(' — ');
  switch (att.type) {
    case 'fallback':
      return label ? `[Liên kết] ${label}` : '[Nội dung chia sẻ không hỗ trợ]';
    case 'post':
    case 'ig_post':
      return label ? `[Bài viết] ${label}` : '[Bài viết]';
    case 'reel':
    case 'ig_reel':
      return label ? `[Reel] ${label}` : '[Reel]';
    case 'template':
      return '[Mẫu tin/sản phẩm]';
    case 'location':
      return label ? `[Vị trí] ${label}` : '[Vị trí]';
    case 'appointment_booking':
      return '[Đặt lịch hẹn]';
    default:
      return label ? `[Tệp đính kèm ${att.type}] ${label}` : `[Tệp đính kèm không hỗ trợ: ${att.type}]`;
  }
}

export interface MappedAttachments {
  attachments: InboundAttachment[];
  /** Ghi chú thêm vào text cho đính kèm không tải được. */
  notes: string[];
}

export function mapAttachments(list: unknown[] | undefined, text: string | undefined): MappedAttachments {
  const attachments: InboundAttachment[] = [];
  const notes: string[] = [];
  const seenStickers = new Set<string>();

  for (const item of list ?? []) {
    const parsed = attachmentSchema.safeParse(item);
    if (!parsed.success) continue;
    const att = parsed.data;
    const url = parseHttpUrl(att.payload?.url);
    const stickerId = att.payload?.sticker_id;

    // Sticker kiểu mới, hoặc kiểu cũ 'image' có sticker_id; giai đoạn chuyển tiếp có thể gửi cả hai => khử trùng.
    if (att.type === 'sticker' || (att.type === 'image' && stickerId !== undefined)) {
      const key = stickerId !== undefined ? String(stickerId) : url?.toString();
      if (key && seenStickers.has(key)) continue;
      if (key) seenStickers.add(key);
      if (url) attachments.push({ url: url.toString(), type: 'sticker', ...withMime(url) });
      else notes.push('[Nhãn dán]');
      continue;
    }

    if (MEDIA_TYPES.has(att.type) && url) {
      const type = att.type as InboundAttachment['type'];
      const name = type === 'file' ? fileNameOf(url) : undefined;
      attachments.push({ url: url.toString(), type, ...withMime(url), ...(name ? { name } : {}) });
      continue;
    }

    const note = noteFor(att, url);
    // Fallback kèm text đã chứa link (chia sẻ liên kết) => không lặp lại link.
    if (att.type === 'fallback' && url && text?.includes(url.toString())) continue;
    if (att.type === 'fallback' && att.payload?.url && text?.includes(att.payload.url)) continue;
    notes.push(note);
  }
  return { attachments, notes };
}

function withMime(url: URL): { mime?: string } {
  const mime = mimeOf(url);
  return mime ? { mime } : {};
}
