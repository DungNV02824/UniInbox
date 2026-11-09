import { describe, expect, it } from 'vitest';
import { formatDayLabel, formatPreview, formatRelativeTime, initials, safeColor } from './inbox-format';

const base = { sentAt: '2026-11-05T08:00:00.000Z', hasAttachments: false };

describe('formatPreview', () => {
  it('tin khách: chỉ nội dung, gộp khoảng trắng', () => {
    expect(formatPreview({ ...base, senderType: 'customer', text: 'Cho em hỏi\n  giá  sofa' })).toBe(
      'Cho em hỏi giá sofa',
    );
  });

  it('tin nhân viên: "NV: ", "Bạn: " khi biết chính mình gửi', () => {
    expect(formatPreview({ ...base, senderType: 'agent', text: 'Dạ chào chị' }, 'u1')).toBe(
      'NV: Dạ chào chị',
    );
    expect(formatPreview({ ...base, senderType: 'agent', text: 'Dạ', senderUserId: 'u1' }, 'u1')).toBe(
      'Bạn: Dạ',
    );
  });

  it('tin chỉ có tệp: [Ảnh]/[Tệp] khi biết loại, mặc định [Tệp đính kèm]', () => {
    const att = { ...base, text: null, hasAttachments: true };
    expect(formatPreview({ ...att, senderType: 'customer', attachmentType: 'image' })).toBe('[Ảnh]');
    expect(formatPreview({ ...att, senderType: 'agent', attachmentType: 'file' })).toBe('NV: [Tệp]');
    expect(formatPreview({ ...att, senderType: 'customer' })).toBe('[Tệp đính kèm]');
  });

  it('chưa có tin', () => {
    expect(formatPreview(null)).toBe('Chưa có tin nhắn');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-11-05T10:00:00.000Z');
  it('theo khoảng cách thời gian', () => {
    expect(formatRelativeTime('2026-11-05T09:59:30.000Z', now)).toBe('Vừa xong');
    expect(formatRelativeTime('2026-11-05T09:55:00.000Z', now)).toBe('5 phút');
    expect(formatRelativeTime('2026-11-05T07:00:00.000Z', now)).toBe('3 giờ');
    expect(formatRelativeTime('2026-11-03T10:00:00.000Z', now)).toBe('2 ngày');
    expect(formatRelativeTime(null, now)).toBe('');
  });

  it('quá 7 ngày: ngày/tháng (kèm năm nếu khác năm)', () => {
    expect(formatRelativeTime(new Date(2026, 9, 1, 12).toISOString(), now)).toBe('01/10');
    expect(formatRelativeTime(new Date(2025, 11, 31, 12).toISOString(), now)).toBe('31/12/25');
  });
});

describe('formatDayLabel', () => {
  it('Hôm nay / Hôm qua / ngày cụ thể', () => {
    const now = new Date(2026, 10, 5, 15);
    expect(formatDayLabel(new Date(2026, 10, 5, 1).toISOString(), now)).toBe('Hôm nay');
    expect(formatDayLabel(new Date(2026, 10, 4, 23).toISOString(), now)).toBe('Hôm qua');
    expect(formatDayLabel(new Date(2026, 10, 2, 9).toISOString(), now)).toMatch(/02\/11\/2026$/);
  });
});

describe('initials / safeColor', () => {
  it('chữ cái đầu', () => {
    expect(initials('Nguyễn Thị Lan')).toBe('NL');
    expect(initials('lan')).toBe('L');
    expect(initials('  ')).toBe('?');
    expect(initials('Dezon Shop (test)')).toBe('DS');
    expect(initials('Quản trị Dezon (test)')).toBe('QD');
    expect(initials('"Lan" (VIP)')).toBe('LV');
    expect(initials('— —')).toBe('?');
  });

  it('màu sai định dạng thì về xám', () => {
    expect(safeColor('#2563eb')).toBe('#2563eb');
    expect(safeColor('red;background:url(x)')).toBe('#64748b');
  });
});
