import { describe, expect, it } from 'vitest';
import { checkUpload } from './upload-policy';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

describe('checkUpload', () => {
  it('nhận ảnh đúng chữ ký, chuẩn hóa mime', () => {
    expect(checkUpload('image/png', PNG)).toEqual({ ok: true, mime: 'image/png', type: 'image' });
    expect(checkUpload('IMAGE/JPEG; charset=binary', JPEG)).toEqual({
      ok: true,
      mime: 'image/jpeg',
      type: 'image',
    });
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
    expect(checkUpload('image/webp', webp)).toMatchObject({ ok: true, type: 'image' });
    expect(checkUpload('image/gif', Buffer.from('GIF89a....'))).toMatchObject({ ok: true });
  });

  it('nhận tài liệu: pdf, docx (zip), doc (OLE), txt', () => {
    expect(checkUpload('application/pdf', Buffer.from('%PDF-1.7\n'))).toMatchObject({
      ok: true,
      type: 'file',
    });
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]);
    expect(
      checkUpload('application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip),
    ).toMatchObject({ ok: true });
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]);
    expect(checkUpload('application/msword', ole)).toMatchObject({ ok: true });
    expect(checkUpload('text/plain', Buffer.from('Chào chị Lan'))).toMatchObject({ ok: true });
  });

  it('từ chối mime ngoài whitelist, nội dung giả mạo, tệp rỗng', () => {
    expect(checkUpload('image/svg+xml', Buffer.from('<svg/>'))).toEqual({ ok: false, reason: 'mime' });
    expect(checkUpload('application/x-msdownload', Buffer.from('MZ'))).toEqual({ ok: false, reason: 'mime' });
    expect(checkUpload('image/png', JPEG)).toEqual({ ok: false, reason: 'content' });
    expect(checkUpload('text/plain', Buffer.from([0x41, 0x00]))).toEqual({ ok: false, reason: 'content' });
    expect(checkUpload('image/png', Buffer.alloc(0))).toEqual({ ok: false, reason: 'empty' });
  });
});
