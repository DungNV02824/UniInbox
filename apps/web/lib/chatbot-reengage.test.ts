import { describe, expect, it } from 'vitest';
import { REENGAGE_LIMITS } from '@dezon/shared';
import { ApiError } from './api';
import {
  alreadyQueuedText,
  excerptText,
  formatEstimatedMinutes,
  formatWaitingSince,
  inboxConversationHref,
  initialSelection,
  isAllSelected,
  isStartResultError,
  parseReengageDays,
  previewSummaryText,
  reengageErrorText,
  selectedIds,
  selectionCapText,
  skippedText,
  startResultText,
  toggleSelection,
} from './chatbot-reengage';

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ conversationId: `c${i}` }));

describe('parseReengageDays', () => {
  it('nhận số nguyên trong khoảng', () => {
    expect(parseReengageDays('15')).toEqual({ ok: true, days: 15 });
    expect(parseReengageDays(' 1 ')).toEqual({ ok: true, days: 1 });
    expect(parseReengageDays(REENGAGE_LIMITS.daysMax)).toEqual({ ok: true, days: 30 });
  });
  it('từ chối ngoài khoảng, số lẻ, rỗng', () => {
    for (const v of ['0', '31', '1.5', '', 'abc', '-2', '1e1']) {
      expect(parseReengageDays(v).ok).toBe(false);
    }
  });
});

describe('chọn khách (giới hạn mỗi lần)', () => {
  it('mặc định chọn tất cả khi ít hơn mức tối đa', () => {
    expect(initialSelection(items(3), 100).size).toBe(3);
  });
  it('mặc định chỉ chọn `max` khách đầu', () => {
    const s = initialSelection(items(150), REENGAGE_LIMITS.maxPerRun);
    expect(s.size).toBe(REENGAGE_LIMITS.maxPerRun);
    expect(s.has('c0')).toBe(true);
    expect(s.has('c100')).toBe(false);
  });
  it('không thêm được khi đã đủ, bỏ chọn rồi thêm được', () => {
    const full = initialSelection(items(3), 2);
    expect(toggleSelection(full, 'c2', 2)).toBe(full);
    const less = toggleSelection(full, 'c0', 2);
    expect(less.has('c0')).toBe(false);
    const again = toggleSelection(less, 'c2', 2);
    expect([...again].sort()).toEqual(['c1', 'c2']);
    expect(full.has('c0')).toBe(true); // không sửa tập cũ
  });
  it('isAllSelected theo min(danh sách, max)', () => {
    expect(isAllSelected(initialSelection(items(5), 2), items(5), 2)).toBe(true);
    expect(isAllSelected(new Set(['c0']), items(5), 2)).toBe(false);
    expect(isAllSelected(new Set(), [], 2)).toBe(false);
  });
  it('selectedIds giữ thứ tự danh sách và bỏ id lạ', () => {
    expect(selectedIds(new Set(['c2', 'x', 'c0']), items(3))).toEqual(['c0', 'c2']);
  });
  it('selectionCapText giải thích giới hạn khi danh sách dài', () => {
    expect(selectionCapText(3, 3, 100)).toBe('Đã chọn 3/3 khách');
    expect(selectionCapText(100, 120, 100)).toContain('mỗi lần tối đa 100 khách');
    expect(selectionCapText(100, 120, 100)).toContain('khách đã xếp hàng không hiện lại');
    expect(selectionCapText(100, 120, 100)).toContain('nối tiếp sau hàng đang chờ');
  });
});

describe('câu chữ', () => {
  it('tóm tắt = số lần gọi AI', () => {
    expect(
      previewSummaryText({ days: 15, eligible: items(4) as never, truncated: false, alreadyQueued: 0 }),
    ).toBe('Bot sẽ trả lời 4 khách bị bỏ sót (≈ 4 lần gọi AI)');
    expect(
      previewSummaryText({ days: 15, eligible: items(300) as never, truncated: true, alreadyQueued: 0 }),
    ).toBe('Bot sẽ trả lời 300+ khách bị bỏ sót (≈ 300+ lần gọi AI)');
    expect(previewSummaryText({ days: 7, eligible: [], truncated: false, alreadyQueued: 0 })).toContain(
      '7 ngày',
    );
  });
  it('tóm tắt nhắc khách đã xếp hàng từ lần trước', () => {
    expect(
      previewSummaryText({ days: 15, eligible: items(4) as never, truncated: false, alreadyQueued: 2 }),
    ).toBe(
      'Bot sẽ trả lời 4 khách bị bỏ sót (≈ 4 lần gọi AI) · 2 khách đã được xếp hàng từ lần trước, đang chờ bot',
    );
    const none = previewSummaryText({ days: 7, eligible: [], truncated: false, alreadyQueued: 3 });
    expect(none).toContain('7 ngày');
    expect(none).toContain('3 khách đã được xếp hàng từ lần trước, đang chờ bot');
    expect(alreadyQueuedText(0)).toBeNull();
  });
  it('kết quả bắt đầu', () => {
    const base = { skipped: 0, outsideWindow: [], spacingSec: 15, startsInMinutes: 0 };
    const r8 = { ...base, queued: 8, alreadyQueued: 0, estimatedMinutes: 2 };
    expect(startResultText(r8)).toBe(
      'Đã xếp hàng 8 khách, bot trả lời lần lượt ~15 giây/khách, xong trong khoảng 2 phút.',
    );
    // Nối sau hàng còn chờ từ lần trước (bot khác / lần bấm trước): báo lúc bắt đầu, thời gian xong tính cả hàng đó.
    expect(startResultText({ ...r8, startsInMinutes: 25, estimatedMinutes: 27 })).toBe(
      'Đã xếp hàng 8 khách, nối sau các khách đang chờ trong hàng (bắt đầu sau khoảng 25 phút), bot trả lời lần lượt ~15 giây/khách, xong trong khoảng 27 phút.',
    );
    expect(isStartResultError(r8)).toBe(false);
    const r0 = { ...base, queued: 0, alreadyQueued: 0, skipped: 3, estimatedMinutes: 0 };
    expect(startResultText(r0)).toContain('Không xếp hàng');
    expect(isStartResultError(r0)).toBe(true);
    // Chỉ trùng lần bấm trước: không phải lỗi.
    const dup = { ...base, queued: 0, alreadyQueued: 2, estimatedMinutes: 0 };
    expect(startResultText(dup)).toBe(
      'Không xếp thêm khách nào: 2 khách đã được xếp hàng từ lần trước, đang chờ bot.',
    );
    expect(isStartResultError(dup)).toBe(false);
    expect(startResultText({ ...base, queued: 1, alreadyQueued: 1, estimatedMinutes: 1 })).toContain(
      'Ngoài ra 1 khách đã được xếp hàng từ lần trước, đang chờ bot.',
    );
    expect(formatEstimatedMinutes(0.25)).toBe('khoảng 1 phút');
    expect(formatEstimatedMinutes(2.25)).toBe('khoảng 3 phút');
    expect(skippedText(0)).toBeNull();
    expect(skippedText(2)).toContain('Bỏ qua 2 khách');
  });
  it('trích tin', () => {
    expect(excerptText({ lastCustomerText: '  Chào\n shop ' })).toBe('Chào shop');
    expect(excerptText({ lastCustomerText: null })).toBe('[Tệp đính kèm]');
  });
  it('đường dẫn hội thoại', () => {
    expect(inboxConversationHref('abc')).toBe('/inbox/abc');
  });
});

describe('formatWaitingSince', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  it('giờ tương đối tiếng Việt', () => {
    expect(formatWaitingSince('2026-11-12T11:59:30Z', now)).toBe('vừa xong');
    expect(formatWaitingSince('2026-11-12T11:55:00Z', now)).toBe('5 phút trước');
    expect(formatWaitingSince('2026-11-12T09:00:00Z', now)).toBe('3 giờ trước');
    expect(formatWaitingSince('2026-10-31T12:00:00Z', now)).toBe('12 ngày trước');
    expect(formatWaitingSince('hỏng', now)).toBe('');
  });
});

describe('reengageErrorText', () => {
  it('lỗi tiếng Việt', () => {
    expect(reengageErrorText(new ApiError(404, 'Not Found'), 'preview')).toContain('Không tìm thấy chatbot');
    expect(reengageErrorText(new ApiError(400, 'Số ngày không hợp lệ'), 'start')).toBe(
      'Số ngày không hợp lệ',
    );
    expect(reengageErrorText(new Error('x'), 'start')).toBe('Không bắt đầu được. Vui lòng thử lại.');
  });
});
