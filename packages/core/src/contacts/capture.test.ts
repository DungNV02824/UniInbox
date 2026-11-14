import { describe, expect, it } from 'vitest';
import { extractVnPhones, fallbackPhoneFromTexts, normalizeVnPhone } from './capture';
import { defaultProfileFieldLabel, toProfileFieldDtos, truncateCodePoints } from './profile-fields';

describe('normalizeVnPhone', () => {
  it('nhận di động 0xxxxxxxxx, bỏ khoảng trắng / chấm / gạch / ngoặc', () => {
    expect(normalizeVnPhone('0912345678')).toBe('0912345678');
    expect(normalizeVnPhone(' 0912 345 678 ')).toBe('0912345678');
    expect(normalizeVnPhone('0912.345.678')).toBe('0912345678');
    expect(normalizeVnPhone('091-234-5678')).toBe('0912345678');
    expect(normalizeVnPhone('(091) 2345678')).toBe('0912345678');
    for (const p of ['0312345678', '0512345678', '0712345678', '0812345678'])
      expect(normalizeVnPhone(p)).toBe(p);
  });

  it('+84 / 84 ⇒ 0xxxxxxxxx', () => {
    expect(normalizeVnPhone('+84912345678')).toBe('0912345678');
    expect(normalizeVnPhone('+84 91 234 5678')).toBe('0912345678');
    expect(normalizeVnPhone('84912345678')).toBe('0912345678');
    expect(normalizeVnPhone('(+84) 0912 345 678')).toBe('0912345678');
  });

  it('nhận số cố định 02x (10–11 số)', () => {
    expect(normalizeVnPhone('02838234567')).toBe('02838234567');
    expect(normalizeVnPhone('(028) 3823 4567')).toBe('02838234567');
    expect(normalizeVnPhone('0243123456')).toBe('0243123456');
    expect(normalizeVnPhone('+84 28 3823 4567')).toBe('02838234567');
  });

  it('sai dạng ⇒ null', () => {
    for (const p of [
      '',
      '   ',
      '091234567', // thiếu số
      '09123456789', // thừa số
      '0112345678', // đầu số không có
      '0412345678',
      '0612345678',
      '912345678', // thiếu 0
      '8491234567', // 84 + thiếu số
      '0912a45678',
      '+1 415 555 0100',
      '0'.repeat(40),
    ]) {
      expect(normalizeVnPhone(p)).toBeNull();
    }
    expect(normalizeVnPhone(null)).toBeNull();
    expect(normalizeVnPhone(undefined)).toBeNull();
  });
});

describe('extractVnPhones', () => {
  it('tìm SĐT trong câu, chuẩn hóa, bỏ trùng, giữ thứ tự', () => {
    expect(
      extractVnPhones('Số em 0912 345 678 nhé, hoặc +84 98.765.4321; gọi lại 0912345678 cũng được'),
    ).toEqual(['0912345678', '0987654321']);
  });

  it('nhận số cố định và dạng có ngoặc', () => {
    expect(extractVnPhones('Văn phòng: (028) 3823 4567')).toEqual(['02838234567']);
    expect(extractVnPhones('zalo (+84) 912-345-678')).toEqual(['0912345678']);
  });

  it('cụm số dính số khác phía sau ⇒ thử bỏ nhóm cuối', () => {
    expect(extractVnPhones('0912 345 678 5 người')).toEqual(['0912345678']);
  });

  it('bỏ số không phải SĐT (giá tiền, mã đơn, số dài)', () => {
    expect(extractVnPhones('Giá 15000000đ, mã đơn 123456789012, diện tích 100m2')).toEqual([]);
    expect(extractVnPhones('09123456789012')).toEqual([]);
    expect(extractVnPhones('')).toEqual([]);
  });

  it('bỏ ngày + giờ và số nằm giữa một số dài hơn (có dấu chấm)', () => {
    for (const text of [
      'hẹn 08.12.2024 14h nhé',
      '08-12-2024 15:30',
      'ngày 05-09-2024 10 giờ',
      'đặt lịch 08 12 2024 14h',
      'giá 84.500.000.000 đ',
      'mã đơn 2.091.234.567.8',
      'tổng 1,091,234,567 đ',
    ]) {
      expect(extractVnPhones(text), text).toEqual([]);
    }
    // SĐT thật cạnh ngày vẫn nhận.
    expect(extractVnPhones('hẹn 08.12.2024, gọi 0912.345.678')).toEqual(['0912345678']);
  });
});

describe('fallbackPhoneFromTexts', () => {
  it('tin chỉ để cho SĐT ⇒ lấy; tin cuối cùng thắng', () => {
    expect(fallbackPhoneFromTexts(['0912345678'])).toBe('0912345678');
    expect(fallbackPhoneFromTexts(['Số điện thoại của em là 0912 345 678 ạ'])).toBe('0912345678');
    expect(fallbackPhoneFromTexts(['zalo mình 0912.345.678 nhé'])).toBe('0912345678');
    expect(fallbackPhoneFromTexts(['Số cũ 0912.111.222', 'À nhầm, số em là +84 987 654 321'])).toBe(
      '0987654321',
    );
  });

  it('số của người khác / kể chuyện quanh số / nhiều số / không có ⇒ null', () => {
    expect(fallbackPhoneFromTexts(['shipper gọi em số 0987654321 mà em không nghe được'])).toBeNull();
    expect(fallbackPhoneFromTexts(['anh liên hệ chị Lan 0912345678 giúp em'])).toBeNull();
    expect(fallbackPhoneFromTexts(['số em 0912345678 hoặc vợ em 0987654321'])).toBeNull();
    expect(fallbackPhoneFromTexts(['hẹn 08.12.2024 14h nhé'])).toBeNull();
    expect(fallbackPhoneFromTexts([null, '', 'chào shop'])).toBeNull();
  });
});

describe('profile-fields', () => {
  it('nhãn mặc định: trường có sẵn ⇒ tên tiếng Việt, còn lại ⇒ khóa', () => {
    expect(defaultProfileFieldLabel('need')).toBe('Nhu cầu');
    expect(defaultProfileFieldLabel('phone')).toBe('SĐT');
    expect(defaultProfileFieldLabel('khu_vuc')).toBe('khu_vuc');
    expect(defaultProfileFieldLabel('toString')).toBe('toString');
  });

  it('cắt theo code point (không cắt đôi emoji)', () => {
    expect(truncateCodePoints('ab😀cd', 3)).toBe('ab😀');
    expect(truncateCodePoints('abc', 5)).toBe('abc');
  });

  it("toProfileFieldDtos: 'need' trước, rồi theo updatedAt tăng dần; nhãn trống ⇒ mặc định; bỏ mục hỏng", () => {
    const dtos = toProfileFieldDtos({
      khu_vuc: { label: 'Khu vực', value: 'Q7', source: 'ai', updatedAt: '2026-01-02T00:00:00.000Z' },
      ngan_sach: { label: '', value: '50tr', source: 'user', updatedAt: '2026-01-01T00:00:00.000Z' },
      need: { label: 'Nhu cầu', value: 'Sofa', source: 'ai', updatedAt: '2026-01-03T00:00:00.000Z' },
      hong: { label: 'x', value: '', source: 'ai', updatedAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(dtos.map((d) => [d.key, d.label, d.source])).toEqual([
      ['need', 'Nhu cầu', 'ai'],
      ['ngan_sach', 'ngan_sach', 'user'],
      ['khu_vuc', 'Khu vực', 'ai'],
    ]);
    expect(toProfileFieldDtos(null)).toEqual([]);
  });
});
