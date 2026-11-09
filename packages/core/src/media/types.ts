// Lưu trữ media trên S3-compatible (SeaweedFS dev, R2/S3 prod).
import type { Readable } from 'node:stream';
import type { AttachmentType, MessageAttachment } from '@dezon/shared';

export interface MediaStorageConfig {
  endpoint?: string;
  /** Endpoint trình duyệt truy cập được, dùng khi ký URL (mặc định = endpoint). */
  publicEndpoint?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  forcePathStyle: boolean;
  signedUrlTtlSec: number;
}

export interface PutOptions {
  /** Content-Disposition lưu cùng object (ví dụ 'attachment' cho tệp không phải ảnh/video/audio). */
  contentDisposition?: string;
}

export interface MediaStorage {
  put(key: string, body: Buffer, contentType: string, options?: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  /** URL GET ký có thời hạn (mặc định signedUrlTtlSec). */
  signedUrl(key: string, ttlSec?: number): Promise<string>;
  /** Kiểm tra kết nối/bucket (dùng cho /health nếu cần). */
  ping(): Promise<void>;
}

/** Hàm ký URL — tách riêng để phần đọc dữ liệu (DTO) không phụ thuộc S3 khi test. */
export type UrlSigner = (storageKey: string) => Promise<string>;

/** Kết quả xử lý một tệp (resize ảnh ≤ 1600px, lấy kích thước). */
export interface StoredMedia extends MessageAttachment {
  size: number;
  name?: string;
}

export interface StoreMediaInput {
  data: Buffer;
  mime?: string;
  filename?: string;
  /** Gợi ý loại tệp từ nền tảng; nếu thiếu thì suy từ mime. */
  type?: AttachmentType;
  /** Tiền tố khóa: 'media' cho tin đến, 'uploads' cho tệp nhân viên tải lên, 'avatars' cho ảnh đại diện. */
  prefix: 'media' | 'uploads' | 'avatars';
  originalUrl?: string;
}
