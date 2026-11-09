import { describe, expect, it } from 'vitest';
import { sendMessageSchema } from './inbox';
import { isZaloOaSendableAttachment, ZALO_OA_CONNECT_ERROR_CODES, ZALO_OA_CONNECT_ERROR_MESSAGES } from './zalo';

describe('isZaloOaSendableAttachment', () => {
  it('nhận ảnh và tệp PDF/DOC/DOCX/CSV', () => {
    expect(isZaloOaSendableAttachment({ type: 'image', mime: 'image/png' })).toBe(true);
    expect(isZaloOaSendableAttachment({ type: 'file', mime: 'application/pdf' })).toBe(true);
    expect(
      isZaloOaSendableAttachment({ type: 'file', mime: 'application/octet-stream', name: 'Báo giá.DOCX' }),
    ).toBe(true);
  });

  it('chặn video, âm thanh, Excel', () => {
    expect(isZaloOaSendableAttachment({ type: 'video', mime: 'video/mp4' })).toBe(false);
    expect(isZaloOaSendableAttachment({ type: 'audio', mime: 'audio/mpeg' })).toBe(false);
    expect(
      isZaloOaSendableAttachment({
        type: 'file',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        name: 'a.xlsx',
      }),
    ).toBe(false);
  });
});

describe('hợp đồng Zalo OA', () => {
  it('mỗi mã lỗi kết nối có thông điệp tiếng Việt', () => {
    for (const code of ZALO_OA_CONNECT_ERROR_CODES) {
      expect(ZALO_OA_CONNECT_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });

  it('sendMessageSchema nhận confirmCostly tuỳ chọn', () => {
    expect(sendMessageSchema.parse({ text: 'a', confirmCostly: true }).confirmCostly).toBe(true);
    expect(sendMessageSchema.parse({ text: 'a' }).confirmCostly).toBeUndefined();
    expect(sendMessageSchema.safeParse({ text: 'a', confirmCostly: 'yes' }).success).toBe(false);
  });
});
