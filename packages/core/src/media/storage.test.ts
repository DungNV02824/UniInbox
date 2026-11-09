import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '../../test/helpers/memory-storage';
import { storeMedia } from './storage';

const image = (width: number, height: number, format: 'jpeg' | 'png' | 'tiff' | 'gif') =>
  sharp({ create: { width, height, channels: 3, background: '#3366cc' } })
    .toFormat(format)
    .toBuffer();

const KEY_PATTERN = /^media\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(\w+)$/;

describe('storeMedia', () => {
  it('ảnh jpeg 3000x2000 thu về 1600x1067, giữ jpeg', async () => {
    const storage = createMemoryStorage();
    const stored = await storeMedia(storage, {
      data: await image(3000, 2000, 'jpeg'),
      mime: 'image/jpeg',
      prefix: 'media',
      originalUrl: 'https://cdn.example.com/a.jpg',
    });
    expect(stored).toMatchObject({
      type: 'image',
      mime: 'image/jpeg',
      width: 1600,
      height: 1067,
      original_url: 'https://cdn.example.com/a.jpg',
    });
    expect(stored.storage_key).toMatch(KEY_PATTERN);
    expect(stored.storage_key.endsWith('.jpg')).toBe(true);
    const saved = storage.objects.get(stored.storage_key)!;
    expect(saved.contentType).toBe('image/jpeg');
    expect(stored.size).toBe(saved.body.byteLength);
    const meta = await sharp(saved.body).metadata();
    expect([meta.width, meta.height]).toEqual([1600, 1067]);
  });

  it('png giữ png; ảnh nhỏ không phóng to; suy type từ mime', async () => {
    const storage = createMemoryStorage();
    const stored = await storeMedia(storage, {
      data: await image(800, 600, 'png'),
      mime: 'image/png; charset=binary',
      filename: 'anh.png',
      prefix: 'uploads',
    });
    expect(stored).toMatchObject({
      type: 'image',
      mime: 'image/png',
      width: 800,
      height: 600,
      name: 'anh.png',
    });
    expect(stored.storage_key).toMatch(/^uploads\/\d{4}\/\d{2}\/.+\.png$/);
  });

  it('định dạng lạ (tiff) chuyển sang jpeg và đổi đuôi tên', async () => {
    const storage = createMemoryStorage();
    const stored = await storeMedia(storage, {
      data: await image(2000, 4000, 'tiff'),
      mime: 'image/tiff',
      filename: 'scan.tiff',
      prefix: 'media',
    });
    expect(stored).toMatchObject({ mime: 'image/jpeg', width: 800, height: 1600, name: 'scan.jpg' });
  });

  it('xoay ảnh theo EXIF', async () => {
    const storage = createMemoryStorage();
    // orientation 6 = xoay 90°: ảnh 400x200 hiển thị thành 200x400.
    const data = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#fff' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const stored = await storeMedia(storage, { data, mime: 'image/jpeg', prefix: 'media' });
    expect([stored.width, stored.height]).toEqual([200, 400]);
  });

  it('gif và sticker giữ nguyên tệp, vẫn đọc kích thước', async () => {
    const storage = createMemoryStorage();
    const gif = await image(2000, 100, 'gif');
    const stored = await storeMedia(storage, { data: gif, mime: 'image/gif', prefix: 'media' });
    expect(stored).toMatchObject({ type: 'image', mime: 'image/gif', width: 2000, height: 100 });
    expect(storage.objects.get(stored.storage_key)!.body.equals(gif)).toBe(true);

    const png = await image(2400, 2400, 'png');
    const sticker = await storeMedia(storage, {
      data: png,
      mime: 'image/png',
      type: 'sticker',
      prefix: 'media',
    });
    expect(sticker).toMatchObject({ type: 'sticker', width: 2400, height: 2400 });
  });

  it('tệp không phải ảnh: type theo mime, đuôi theo mime hoặc tên tệp', async () => {
    const storage = createMemoryStorage();
    const pdf = await storeMedia(storage, {
      data: Buffer.from('%PDF-1.4'),
      mime: 'application/pdf',
      filename: 'bao-gia.pdf',
      prefix: 'media',
    });
    expect(pdf).toMatchObject({ type: 'file', mime: 'application/pdf', size: 8, name: 'bao-gia.pdf' });
    expect(pdf.storage_key.endsWith('.pdf')).toBe(true);
    expect(pdf.width).toBeUndefined();

    const video = await storeMedia(storage, { data: Buffer.from('x'), mime: 'video/mp4', prefix: 'media' });
    expect(video.type).toBe('video');
    const unknown = await storeMedia(storage, { data: Buffer.from('x'), prefix: 'media', filename: 'a.XYZ' });
    expect(unknown).toMatchObject({ type: 'file', mime: 'application/octet-stream' });
    expect(unknown.storage_key.endsWith('.xyz')).toBe(true);
  });

  it('mime nguy hiểm (svg, html) lưu thành octet-stream + attachment; svg không còn là ảnh', async () => {
    const storage = createMemoryStorage();
    const svg = await storeMedia(storage, {
      data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      mime: 'image/svg+xml',
      type: 'image',
      filename: 'logo.svg',
      prefix: 'media',
    });
    expect(svg).toMatchObject({ type: 'file', mime: 'application/octet-stream', name: 'logo.svg' });
    expect(svg.width).toBeUndefined();
    expect(storage.objects.get(svg.storage_key)).toMatchObject({
      contentType: 'application/octet-stream',
      contentDisposition: `attachment; filename="logo.svg"; filename*=UTF-8''logo.svg`,
    });

    const html = await storeMedia(storage, {
      data: Buffer.from('<html><script>alert(1)</script></html>'),
      mime: 'text/html; charset=utf-8',
      filename: 'báo "giá".html',
      prefix: 'media',
    });
    expect(html).toMatchObject({ type: 'file', mime: 'application/octet-stream' });
    expect(storage.objects.get(html.storage_key)!.contentDisposition).toBe(
      `attachment; filename="b_o _gi__.html"; filename*=UTF-8''b%C3%A1o%20%22gi%C3%A1%22.html`,
    );
  });

  it('ảnh/video/audio lưu inline (không Content-Disposition); tài liệu lưu kèm attachment', async () => {
    const storage = createMemoryStorage();
    const jpg = await storeMedia(storage, {
      data: await image(10, 10, 'jpeg'),
      mime: 'image/jpeg',
      prefix: 'media',
    });
    expect(storage.objects.get(jpg.storage_key)!.contentDisposition).toBeUndefined();
    const audio = await storeMedia(storage, { data: Buffer.from('x'), mime: 'audio/mpeg', prefix: 'media' });
    expect(storage.objects.get(audio.storage_key)!.contentDisposition).toBeUndefined();
    const pdf = await storeMedia(storage, {
      data: Buffer.from('%PDF'),
      mime: 'application/pdf',
      prefix: 'media',
    });
    expect(pdf.mime).toBe('application/pdf');
    expect(storage.objects.get(pdf.storage_key)!.contentDisposition).toBe('attachment');
  });

  it('ảnh hỏng: lưu nguyên bản, không có kích thước', async () => {
    const storage = createMemoryStorage();
    const stored = await storeMedia(storage, {
      data: Buffer.from('not an image'),
      mime: 'image/jpeg',
      prefix: 'media',
    });
    expect(stored).toMatchObject({ type: 'image', mime: 'image/jpeg', size: 12 });
    expect(stored.width).toBeUndefined();
  });
});
