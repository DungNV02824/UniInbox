import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AttachmentType } from '@dezon/shared';
import { processImage, readImageSize } from './image';
import {
  attachmentDisposition,
  DEFAULT_MIME,
  extFromMime,
  isInlineMime,
  normalizeMime,
  replaceExt,
  safeStoredMime,
  typeFromMime,
} from './mime';
import type { MediaStorage, MediaStorageConfig, StoreMediaInput, StoredMedia } from './types';

export { downloadToBuffer } from './download';

export function createS3Storage(config: MediaStorageConfig): MediaStorage {
  const base: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  };
  const client = new S3Client({ ...base, ...(config.endpoint ? { endpoint: config.endpoint } : {}) });
  // Client riêng để ký URL bằng endpoint mà trình duyệt mở được (dev: localhost thay vì tên service).
  const signerEndpoint = config.publicEndpoint ?? config.endpoint;
  const signer =
    signerEndpoint === config.endpoint
      ? client
      : new S3Client({ ...base, ...(signerEndpoint ? { endpoint: signerEndpoint } : {}) });
  const Bucket = config.bucket;

  const getBody = async (key: string) => {
    const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
    if (!res.Body) throw new Error(`Không đọc được tệp ${key}`);
    return res.Body;
  };

  return {
    async put(key, body, contentType, options) {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ...(options?.contentDisposition ? { ContentDisposition: options.contentDisposition } : {}),
        }),
      );
    },
    async get(key) {
      const body = await getBody(key);
      return Buffer.from(await body.transformToByteArray());
    },
    async getStream(key) {
      const body = await getBody(key);
      if (body instanceof Readable) return body;
      return Readable.fromWeb(body.transformToWebStream() as Parameters<typeof Readable.fromWeb>[0]);
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    signedUrl(key, ttlSec) {
      return getSignedUrl(signer, new GetObjectCommand({ Bucket, Key: key }), {
        expiresIn: ttlSec ?? config.signedUrlTtlSec,
      });
    },
    async ping() {
      await client.send(new HeadBucketCommand({ Bucket }));
    },
  };
}

/** Khóa lưu trữ: prefix/yyyy/mm/<uuid>.<ext> (theo giờ UTC). */
export function buildStorageKey(prefix: StoreMediaInput['prefix'], ext: string, now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${prefix}/${yyyy}/${mm}/${randomUUID()}.${ext}`;
}

/** Ảnh tĩnh được resize; gif (có thể động), svg và sticker giữ nguyên tệp. */
function shouldResize(type: AttachmentType, mime: string): boolean {
  return type === 'image' && mime.startsWith('image/') && mime !== 'image/gif' && mime !== 'image/svg+xml';
}

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Lưu tệp: ảnh resize ≤ 1600px (giữ tỉ lệ, đọc width/height); khóa dạng prefix/yyyy/mm/uuid.ext.
 * Mime ngoài danh sách an toàn (svg, html...) lưu thành application/octet-stream; tệp không phải
 * ảnh/video/audio lưu kèm Content-Disposition: attachment (mở URL ký là tải về, không render).
 */
export async function storeMedia(storage: MediaStorage, input: StoreMediaInput): Promise<StoredMedia> {
  const declared = normalizeMime(input.mime) ?? DEFAULT_MIME;
  let mime = safeStoredMime(declared);
  // Ảnh "nguy hiểm" (svg) coi như tệp thường, không hiển thị inline.
  const type: AttachmentType =
    input.type === 'image' && mime === DEFAULT_MIME && declared !== DEFAULT_MIME
      ? 'file'
      : (input.type ?? typeFromMime(mime));
  // Nền tảng báo là ảnh nhưng không có mime: để sharp nhận diện.
  if (type === 'image' && !mime.startsWith('image/')) mime = 'image/jpeg';

  let data = input.data;
  let name = input.filename;
  let size: { width: number; height: number } | undefined;

  if (shouldResize(type, mime)) {
    try {
      const out = await processImage(data);
      if (out.mime !== mime && name) name = replaceExt(name, extFromMime(out.mime));
      data = out.data;
      mime = out.mime;
      size = { width: out.width, height: out.height };
    } catch {
      // Ảnh hỏng/định dạng sharp không đọc được (HEIC...): lưu nguyên bản, không có kích thước.
      size = undefined;
    }
  } else if (mime.startsWith('image/')) {
    size = await readImageSize(data);
  }

  const key = buildStorageKey(input.prefix, extFromMime(mime, name));
  await storage.put(
    key,
    data,
    mime,
    isInlineMime(mime) ? undefined : { contentDisposition: attachmentDisposition(name) },
  );

  return {
    type,
    storage_key: key,
    mime,
    ...(size ? { width: size.width, height: size.height } : {}),
    size: data.byteLength,
    ...(name ? { name } : {}),
    ...(isHttpUrl(input.originalUrl) ? { original_url: input.originalUrl } : {}),
  };
}
