// Thu nhỏ + nén ảnh ở trình duyệt trước khi gửi chat thử (JPEG, cạnh dài ≤ 1600 px).
// Chỉ chạy phía client (canvas, createImageBitmap); phần tính toán thuần nằm ở chatbot-test.ts.
import {
  TEST_IMAGE_MAX_SIDE,
  TEST_IMAGE_QUALITY,
  checkImageFile,
  fitWithin,
  imageIsSendable,
  imageTooLargeMessage,
  newEntryId,
  type TestImage,
} from '@/lib/chatbot-test';

export class ImagePrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImagePrepareError';
  }
}

async function decode(
  file: File,
): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      // imageOrientation: ảnh chụp điện thoại xoay theo EXIF như khi xem.
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // Rơi xuống <img> (một số trình duyệt không giải mã được qua createImageBitmap).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const s = typeof reader.result === 'string' ? reader.result : '';
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** Một tệp ảnh → TestImage (JPEG đã thu nhỏ). Lỗi ném ImagePrepareError với câu tiếng Việt. */
export async function prepareTestImage(file: File): Promise<TestImage> {
  const invalid = checkImageFile(file);
  if (invalid) throw new ImagePrepareError(invalid);
  const label = file.name ? `“${file.name}”` : 'Ảnh này';

  let decoded: Awaited<ReturnType<typeof decode>>;
  try {
    decoded = await decode(file);
  } catch {
    throw new ImagePrepareError(
      `Không đọc được ${label}. Có thể định dạng ảnh chưa được hỗ trợ (thử JPG hoặc PNG).`,
    );
  }
  try {
    const { width, height } = fitWithin(decoded.width, decoded.height, TEST_IMAGE_MAX_SIDE);
    if (!width || !height) throw new ImagePrepareError(`Không đọc được ${label}.`);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ImagePrepareError(`Trình duyệt không xử lý được ${label}.`);
    // JPEG không có nền trong suốt: lót trắng cho PNG/WebP/GIF.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', TEST_IMAGE_QUALITY),
    );
    if (!blob) throw new ImagePrepareError(`Không nén được ${label}.`);
    const data = await blobToBase64(blob);
    const image: TestImage = { id: newEntryId(), mimeType: 'image/jpeg', data, name: file.name || undefined };
    if (!imageIsSendable(image)) throw new ImagePrepareError(imageTooLargeMessage(file.name));
    return image;
  } finally {
    decoded.close();
  }
}

/** Nhiều tệp: trả các ảnh chuẩn bị được + các câu lỗi (không dừng vì một tệp hỏng). */
export async function prepareTestImages(
  files: readonly File[],
): Promise<{ images: TestImage[]; errors: string[] }> {
  const images: TestImage[] = [];
  const errors: string[] = [];
  // Tuần tự để không giải mã 10 ảnh 12 MP cùng lúc.
  for (const file of files) {
    try {
      images.push(await prepareTestImage(file));
    } catch (err) {
      errors.push(
        err instanceof ImagePrepareError ? err.message : `Không xử lý được “${file.name || 'ảnh'}”.`,
      );
    }
  }
  return { images, errors };
}
