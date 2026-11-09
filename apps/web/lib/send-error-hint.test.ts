import { describe, expect, it } from 'vitest';
import { DEV_MODE_SEND_HINT, sendErrorHint } from './send-error-hint';

describe('sendErrorHint', () => {
  it('lỗi thiếu quyền / không tìm thấy người nhận: nhắc giới hạn chế độ Phát triển', () => {
    expect(sendErrorHint('Ứng dụng chưa có quyền gửi tin cho Fanpage này (mã 10)')).toBe(DEV_MODE_SEND_HINT);
    expect(sendErrorHint('Ứng dụng chưa được cấp quyền gửi tin (pages_messaging) (mã 200)')).toBe(
      DEV_MODE_SEND_HINT,
    );
    expect(sendErrorHint('Không tìm thấy người nhận trên Messenger (mã 100/2018001)')).toBe(
      DEV_MODE_SEND_HINT,
    );
  });

  it('lỗi khác hoặc không có lỗi: không gợi ý', () => {
    expect(sendErrorHint('Đã ngoài cửa sổ gửi tin của Messenger (mã 10/2018278)')).toBeNull();
    expect(sendErrorHint(null)).toBeNull();
    expect(sendErrorHint('')).toBeNull();
  });
});
