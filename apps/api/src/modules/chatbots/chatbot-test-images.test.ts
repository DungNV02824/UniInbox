import { describe, expect, it } from 'vitest';
import { resolveTestImageMime, sniffImageMime } from './chatbot-test-images';

const b64 = (bytes: number[] | Buffer) => Buffer.from(bytes).toString('base64');

describe('sniffImageMime', () => {
  it('nhận ra JPEG, PNG, WebP theo byte đầu; GIF không hỗ trợ ⇒ null', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      'image/png',
    );
    expect(sniffImageMime(Buffer.from('GIF87a....'))).toBeNull();
    expect(sniffImageMime(Buffer.from('GIF89a....'))).toBeNull();
    expect(
      sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])),
    ).toBe('image/webp');
  });

  it('không phải ảnh / quá ngắn => null', () => {
    expect(sniffImageMime(Buffer.from('hello world!'))).toBeNull();
    expect(sniffImageMime(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(
      sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])),
    ).toBeNull();
  });
});

describe('resolveTestImageMime', () => {
  it('GIF => 400 nói rõ chưa hỗ trợ GIF', () => {
    expect(() => resolveTestImageMime(b64(Buffer.from('GIF89a......')), 'Ảnh thứ 2')).toThrow(
      'Ảnh thứ 2 là ảnh GIF — chưa hỗ trợ, vui lòng gửi ảnh JPEG, PNG hoặc WebP',
    );
  });

  it('dùng mime nhận ra từ dữ liệu', () => {
    expect(resolveTestImageMime(b64([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]), 'Ảnh thứ 1')).toBe(
      'image/jpeg',
    );
  });

  it('không phải ảnh => 400 có nhãn ảnh', () => {
    expect(() => resolveTestImageMime(b64(Buffer.from('chỉ là chữ thôi')), 'Ảnh thứ 4')).toThrow(
      'Ảnh thứ 4 không phải ảnh JPEG, PNG hoặc WebP hợp lệ',
    );
  });
});
