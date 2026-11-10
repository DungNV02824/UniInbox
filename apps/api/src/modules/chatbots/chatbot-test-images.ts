// Kiểm nội dung ảnh gửi kèm "Chat thử". Zod của @dezon/shared (chatbotTestImageSchema) đã kiểm mime khai báo,
// base64 chuẩn, dung lượng ≤ CHATBOT_LIMITS.testImageMaxBytes và số ảnh; ở đây chỉ còn kiểm byte đầu tệp.
import type { ChatbotTestImageMime } from '@dezon/shared';
import { BadRequestException } from '@nestjs/common';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isGif = (head: Buffer) =>
  head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'));

/** Nhận dạng ảnh qua "magic bytes". null = không phải JPEG/PNG/WebP (GIF cũng null — không hỗ trợ). */
export function sniffImageMime(head: Buffer): ChatbotTestImageMime | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Mime thật của ảnh (base64 đã qua Zod) theo byte đầu tệp — trình duyệt khai báo mime theo đuôi tệp nên có thể
 * sai (ảnh JPEG đặt tên .png): dùng mime nhận ra, không tin mime khai báo. Không phải ảnh ⇒ 400 tiếng Việt.
 * `label` dùng trong thông điệp lỗi (vd. "Ảnh thứ 3").
 */
export function resolveTestImageMime(data: string, label: string): ChatbotTestImageMime {
  // 16 ký tự base64 = 12 byte đầu: đủ cho mọi chữ ký ở trên.
  const head = Buffer.from(data.slice(0, 16), 'base64');
  const mime = sniffImageMime(head);
  if (!mime && isGif(head)) {
    throw new BadRequestException(`${label} là ảnh GIF — chưa hỗ trợ, vui lòng gửi ảnh JPEG, PNG hoặc WebP`);
  }
  if (!mime) throw new BadRequestException(`${label} không phải ảnh JPEG, PNG hoặc WebP hợp lệ`);
  return mime;
}
