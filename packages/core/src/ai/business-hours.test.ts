import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from '@dezon/shared';
import { describe, expect, it } from 'vitest';
import { describeBusinessHours, formatLocalNow, isWithinBusinessHours } from './business-hours';

// 2026-11-09 là Thứ Hai. Asia/Ho_Chi_Minh = UTC+7.
const vn = (local: string) => new Date(`${local}+07:00`);

describe('isWithinBusinessHours', () => {
  const bh = DEFAULT_BUSINESS_HOURS;

  it('trong/ngoài khung [start, end) theo giờ VN', () => {
    expect(isWithinBusinessHours(bh, vn('2026-11-09T07:59:00'))).toBe(false);
    expect(isWithinBusinessHours(bh, vn('2026-11-09T08:00:00'))).toBe(true);
    expect(isWithinBusinessHours(bh, vn('2026-11-09T17:29:00'))).toBe(true);
    expect(isWithinBusinessHours(bh, vn('2026-11-09T17:30:00'))).toBe(false);
  });

  it('khung kết thúc 24:00 bao cả 23:59', () => {
    const allDay: BusinessHours = {
      ...DEFAULT_BUSINESS_HOURS,
      days: { ...DEFAULT_BUSINESS_HOURS.days, mon: [{ start: '20:00', end: '24:00' }] },
    };
    expect(isWithinBusinessHours(allDay, vn('2026-11-09T23:59:00'))).toBe(true);
    expect(isWithinBusinessHours(allDay, vn('2026-11-09T19:59:00'))).toBe(false);
  });

  it('Chủ Nhật nghỉ, Thứ Bảy làm', () => {
    expect(isWithinBusinessHours(bh, vn('2026-11-14T10:00:00'))).toBe(true); // Thứ Bảy
    expect(isWithinBusinessHours(bh, vn('2026-11-15T10:00:00'))).toBe(false); // Chủ Nhật
  });

  it('dùng ngày theo múi giờ của cài đặt, không theo UTC', () => {
    // 2026-11-08T23:30Z = 06:30 Thứ Hai ở VN (Chủ Nhật theo UTC).
    const t = new Date('2026-11-09T01:30:00Z'); // 08:30 Thứ Hai VN
    expect(isWithinBusinessHours(bh, t)).toBe(true);
    // 2026-11-15T01:30Z = 08:30 Chủ Nhật VN ⇒ nghỉ.
    expect(isWithinBusinessHours(bh, new Date('2026-11-15T01:30:00Z'))).toBe(false);
    // 2026-11-14T18:00Z = 01:00 Chủ Nhật VN, nhưng ở New York là 13:00 Thứ Bảy.
    const ny: BusinessHours = { ...bh, timezone: 'America/New_York' };
    expect(isWithinBusinessHours(ny, new Date('2026-11-14T18:00:00Z'))).toBe(true);
    expect(isWithinBusinessHours(bh, new Date('2026-11-14T18:00:00Z'))).toBe(false);
  });

  it('nhiều khung giờ trong ngày (nghỉ trưa)', () => {
    const split: BusinessHours = {
      ...bh,
      days: {
        ...bh.days,
        mon: [
          { start: '08:00', end: '12:00' },
          { start: '13:30', end: '17:30' },
        ],
      },
    };
    expect(isWithinBusinessHours(split, vn('2026-11-09T12:30:00'))).toBe(false);
    expect(isWithinBusinessHours(split, vn('2026-11-09T13:30:00'))).toBe(true);
  });
});

describe('describeBusinessHours', () => {
  it('gộp các ngày liên tiếp cùng khung giờ', () => {
    expect(describeBusinessHours(DEFAULT_BUSINESS_HOURS)).toBe(
      'Thứ Hai–Thứ Bảy: 08:00–17:30; Chủ Nhật: nghỉ',
    );
  });

  it('nhiều khung và ngày khác nhau', () => {
    const r = [
      { start: '08:00', end: '12:00' },
      { start: '13:30', end: '17:30' },
    ];
    const bh: BusinessHours = {
      timezone: 'Asia/Ho_Chi_Minh',
      days: { mon: r, tue: r, wed: r, thu: r, fri: r, sat: [{ start: '08:00', end: '12:00' }], sun: [] },
    };
    expect(describeBusinessHours(bh)).toBe(
      'Thứ Hai–Thứ Sáu: 08:00–12:00, 13:30–17:30; Thứ Bảy: 08:00–12:00; Chủ Nhật: nghỉ',
    );
  });

  it('nghỉ cả tuần', () => {
    const days = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    expect(describeBusinessHours({ timezone: 'Asia/Ho_Chi_Minh', days })).toBe(
      'Nghỉ cả tuần (không có giờ làm việc)',
    );
  });
});

describe('formatLocalNow', () => {
  it('định dạng tiếng Việt theo múi giờ', () => {
    expect(formatLocalNow(vn('2026-11-09T14:05:00'), 'Asia/Ho_Chi_Minh')).toBe(
      'Thứ Hai 09/11/2026 14:05 (Asia/Ho_Chi_Minh)',
    );
    expect(formatLocalNow(new Date('2026-11-09T00:05:00Z'), 'America/New_York')).toBe(
      'Chủ Nhật 08/11/2026 19:05 (America/New_York)',
    );
  });

  it('nửa đêm hiển thị 00:xx', () => {
    expect(formatLocalNow(vn('2026-11-10T00:15:00'), 'Asia/Ho_Chi_Minh')).toBe(
      'Thứ Ba 10/11/2026 00:15 (Asia/Ho_Chi_Minh)',
    );
  });
});
