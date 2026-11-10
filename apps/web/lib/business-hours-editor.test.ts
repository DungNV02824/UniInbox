import { DEFAULT_BUSINESS_HOURS } from '@dezon/shared';
import { describe, expect, it } from 'vitest';
import {
  addRange,
  copyDayToAll,
  fromDraft,
  isDraftDirty,
  nextRange,
  normalizeTimeInput,
  removeRange,
  setClosed,
  summarizeDay,
  timezoneOptions,
  toDraft,
  updateRange,
  validateDay,
  validateDraft,
} from './business-hours-editor';

describe('toDraft / fromDraft', () => {
  it('khứ hồi giữ nguyên; ngày rỗng = nghỉ (giữ khung mặc định để mở lại)', () => {
    const draft = toDraft(DEFAULT_BUSINESS_HOURS);
    expect(draft.days.sun).toEqual({ closed: true, ranges: [{ start: '08:00', end: '17:30' }] });
    expect(fromDraft(draft)).toEqual(DEFAULT_BUSINESS_HOURS);
  });

  it('fromDraft sắp khung theo giờ bắt đầu, ngày nghỉ => []', () => {
    const draft = toDraft(DEFAULT_BUSINESS_HOURS);
    draft.days.mon = {
      closed: false,
      ranges: [
        { start: '13:30', end: '17:30' },
        { start: '08:00', end: '12:00' },
      ],
    };
    draft.days.tue = { closed: true, ranges: [{ start: '08:00', end: '12:00' }] };
    const bh = fromDraft(draft);
    expect(bh.days.mon.map((r) => r.start)).toEqual(['08:00', '13:30']);
    expect(bh.days.tue).toEqual([]);
  });
});

describe('validateDay', () => {
  it('ngày nghỉ luôn hợp lệ', () => {
    expect(validateDay({ closed: true, ranges: [{ start: '18:00', end: '08:00' }] })).toEqual({
      ranges: [null],
      day: null,
    });
  });

  it('bắt đầu ≥ kết thúc, sai định dạng, chồng lấn', () => {
    const v = validateDay({
      closed: false,
      ranges: [
        { start: '08:00', end: '12:00' },
        { start: '11:00', end: '13:00' },
        { start: '15:00', end: '14:00' },
        { start: '', end: '16:00' },
      ],
    });
    expect(v.ranges[0]).toBeNull();
    expect(v.ranges[1]).toBe('Chồng lên khung 08:00–12:00');
    expect(v.ranges[2]).toMatch(/trước giờ kết thúc/);
    expect(v.ranges[3]).toMatch(/HH:MM/);
  });

  it('khung liền kề không tính chồng lấn; quá 4 khung báo lỗi ngày', () => {
    expect(
      validateDay({
        closed: false,
        ranges: [
          { start: '08:00', end: '12:00' },
          { start: '12:00', end: '13:00' },
        ],
      }).ranges,
    ).toEqual([null, null]);
    const five = Array.from({ length: 5 }, (_, i) => ({
      start: `0${i}:00`,
      end: `0${i}:30`,
    }));
    expect(validateDay({ closed: false, ranges: five }).day).toMatch(/Tối đa 4/);
  });

  it('validateDraft gom lỗi', () => {
    const draft = toDraft(DEFAULT_BUSINESS_HOURS);
    expect(validateDraft(draft).hasErrors).toBe(false);
    draft.days.wed = { closed: false, ranges: [{ start: '10:00', end: '09:00' }] };
    expect(validateDraft(draft).hasErrors).toBe(true);
  });
});

describe('thao tác', () => {
  it('nextRange / addRange giới hạn 4 khung', () => {
    expect(nextRange([])).toEqual({ start: '08:00', end: '17:30' });
    expect(nextRange([{ start: '08:00', end: '12:00' }])).toEqual({ start: '13:00', end: '15:00' });
    expect(nextRange([{ start: '08:00', end: '23:30' }])).toEqual({ start: '22:00', end: '23:59' });
    let day = { closed: false, ranges: [{ start: '08:00', end: '09:00' }] };
    for (let i = 0; i < 6; i += 1) day = addRange(day);
    expect(day.ranges).toHaveLength(4);
  });

  it('removeRange khung cuối => nghỉ; updateRange; setClosed', () => {
    const day = { closed: false, ranges: [{ start: '08:00', end: '09:00' }] };
    expect(removeRange(day, 0).closed).toBe(true);
    expect(updateRange(day, 0, { end: '10:00' }).ranges[0]).toEqual({ start: '08:00', end: '10:00' });
    expect(setClosed({ closed: true, ranges: [] }, false).ranges).toHaveLength(1);
  });

  it('copyDayToAll sao chép sâu', () => {
    const draft = toDraft(DEFAULT_BUSINESS_HOURS);
    const copied = copyDayToAll(draft, 'sun');
    expect(Object.values(copied.days).every((d) => d.closed)).toBe(true);
    copied.days.mon.ranges[0]!.start = '09:00';
    expect(copied.days.tue.ranges[0]!.start).toBe('08:00');
  });

  it('summarizeDay', () => {
    expect(summarizeDay({ closed: true, ranges: [] })).toBe('Nghỉ');
    expect(
      summarizeDay({
        closed: false,
        ranges: [
          { start: '13:30', end: '17:30' },
          { start: '08:00', end: '12:00' },
        ],
      }),
    ).toBe('08:00–12:00, 13:30–17:30');
  });

  it('isDraftDirty', () => {
    const draft = toDraft(DEFAULT_BUSINESS_HOURS);
    expect(isDraftDirty(draft, DEFAULT_BUSINESS_HOURS)).toBe(false);
    // Bật "Nghỉ" rồi tắt lại với khung y cũ => không đổi.
    draft.days.sun = setClosed(draft.days.sun, true);
    expect(isDraftDirty(draft, DEFAULT_BUSINESS_HOURS)).toBe(false);
    draft.days.mon = setClosed(draft.days.mon, true);
    expect(isDraftDirty(draft, DEFAULT_BUSINESS_HOURS)).toBe(true);
  });

  it('timezoneOptions giữ múi giờ lạ đang lưu', () => {
    expect(timezoneOptions('Asia/Ho_Chi_Minh')[0]!.value).toBe('Asia/Ho_Chi_Minh');
    expect(timezoneOptions('Asia/Kolkata')[0]!.value).toBe('Asia/Kolkata');
  });
});

describe('normalizeTimeInput', () => {
  it('chuẩn hóa nhiều kiểu gõ về HH:MM 24 giờ', () => {
    expect(normalizeTimeInput('8')).toBe('08:00');
    expect(normalizeTimeInput(' 830 ')).toBe('08:30');
    expect(normalizeTimeInput('1730')).toBe('17:30');
    expect(normalizeTimeInput('8h30')).toBe('08:30');
    expect(normalizeTimeInput('8g')).toBe('08:00');
    expect(normalizeTimeInput('17:5')).toBe('17:50');
    expect(normalizeTimeInput('08:00')).toBe('08:00');
  });

  it('không hiểu hoặc ngoài phạm vi => giữ nguyên', () => {
    expect(normalizeTimeInput('25:00')).toBe('25:00');
    expect(normalizeTimeInput('abc')).toBe('abc');
    expect(normalizeTimeInput('')).toBe('');
  });
});
