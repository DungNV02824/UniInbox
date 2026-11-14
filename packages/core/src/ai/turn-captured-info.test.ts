// turnCapturedInfo (hàm thuần của runtime): `captured` model điền + dự phòng SĐT bằng regex.
import { DEFAULT_CAPTURE_CONFIG, type CaptureConfig } from '@dezon/shared';
import { describe, expect, it } from 'vitest';
import { turnCapturedInfo } from './runtime';

const CAPTURE_ON: CaptureConfig = { ...DEFAULT_CAPTURE_CONFIG, enabled: true };

describe('turnCapturedInfo', () => {
  it('SĐT model hợp lệ thắng, không đánh dấu đoán', () => {
    expect(turnCapturedInfo(CAPTURE_ON, { phone: '0912345678' }, ['0987654321'])).toEqual({
      phone: '0912345678',
      fields: {},
    });
  });

  it('model không điền captured / điền phone sai dạng ⇒ dự phòng regex, phoneGuessed', () => {
    expect(turnCapturedInfo(CAPTURE_ON, undefined, ['Số em 0987654321 ạ'])).toEqual({
      phone: '0987654321',
      phoneGuessed: true,
      fields: {},
    });
    expect(turnCapturedInfo(CAPTURE_ON, { phone: 'không rõ', need: 'Sơn' }, ['0987654321'])).toEqual({
      phone: '0987654321',
      phoneGuessed: true,
      fields: { need: 'Sơn' },
    });
  });

  it('model điền captured mà bỏ phone ⇒ tôn trọng, không lấy số trong tin', () => {
    expect(turnCapturedInfo(CAPTURE_ON, { need: 'Sơn nhà' }, ['0987654321'])).toEqual({
      phone: null,
      fields: { need: 'Sơn nhà' },
    });
  });

  it('lượt có Nhật ký công trình ⇒ không đoán SĐT từ tin (số là của nhà thầu); SĐT model điền vẫn giữ', () => {
    const logs = [{ dia_chi: '252 Nguyễn Thái Bình', sdt_nha_thau: '0937 549 534' }];
    expect(turnCapturedInfo(CAPTURE_ON, undefined, ['0937 549 534'], logs)).toBeNull();
    expect(turnCapturedInfo(CAPTURE_ON, undefined, ['sđt 0937549534'], logs)).toBeNull();
    expect(
      turnCapturedInfo(CAPTURE_ON, { phone: 'không rõ', need: 'Gửi ảnh' }, ['0937549534'], logs),
    ).toEqual({
      phone: null,
      fields: { need: 'Gửi ảnh' },
    });
    expect(turnCapturedInfo(CAPTURE_ON, { phone: '0912345678' }, ['0937549534'], logs)).toEqual({
      phone: '0912345678',
      fields: {},
    });
    // Không có công trình (rỗng) ⇒ dự phòng như cũ.
    expect(turnCapturedInfo(CAPTURE_ON, undefined, ['0937549534'], [])).toEqual({
      phone: '0937549534',
      phoneGuessed: true,
      fields: {},
    });
  });

  it('số của người khác trong tin ⇒ không đoán; không có gì ⇒ null', () => {
    expect(
      turnCapturedInfo(CAPTURE_ON, undefined, ['shipper gọi em số 0987654321 mà em không nghe được']),
    ).toBeNull();
    expect(turnCapturedInfo(CAPTURE_ON, undefined, [null, 'chào shop'])).toBeNull();
    expect(turnCapturedInfo(DEFAULT_CAPTURE_CONFIG, { need: 'x' }, ['0987654321'])).toBeNull();
  });
});
