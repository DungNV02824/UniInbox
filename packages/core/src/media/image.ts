// Xử lý ảnh bằng sharp: xoay theo EXIF, thu nhỏ ≤ 1600px, đọc kích thước.
import sharp from 'sharp';

export const MAX_IMAGE_SIDE = 1600;

/** Định dạng giữ nguyên khi resize; định dạng khác chuyển sang jpeg. */
const KEPT_FORMATS = new Set(['jpeg', 'png', 'webp']);

export interface ProcessedImage {
  data: Buffer;
  mime: string;
  width: number;
  height: number;
}

/** Kích thước ảnh (dùng cho gif động/sticker giữ nguyên tệp). Không đọc được => undefined. */
export async function readImageSize(data: Buffer): Promise<{ width: number; height: number } | undefined> {
  try {
    const meta = await sharp(data, { animated: true }).metadata();
    const width = meta.width;
    // Ảnh động: chiều cao một khung hình.
    const height = meta.pageHeight ?? meta.height;
    return width && height ? { width, height } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Xoay theo EXIF, resize fit inside 1600×1600 (không phóng to), giữ jpeg/png/webp, còn lại chuyển jpeg.
 * Ném lỗi nếu sharp không đọc được ảnh (caller tự quyết định lưu nguyên bản).
 */
export async function processImage(data: Buffer): Promise<ProcessedImage> {
  const input = sharp(data, { failOn: 'error' });
  const meta = await input.metadata();
  const format = meta.format && KEPT_FORMATS.has(meta.format) ? meta.format : 'jpeg';

  let pipeline = input
    .rotate()
    .resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, { fit: 'inside', withoutEnlargement: true });
  if (format === 'png') pipeline = pipeline.png();
  else if (format === 'webp') pipeline = pipeline.webp({ quality: 85 });
  // jpeg không có kênh alpha: nền trắng cho ảnh trong suốt được chuyển định dạng.
  else pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 85 });

  const { data: out, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { data: out, mime: `image/${format}`, width: info.width, height: info.height };
}
