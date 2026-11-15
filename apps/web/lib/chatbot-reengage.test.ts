import { afterEach, describe, expect, it, vi } from 'vitest';
import { REENGAGE_LIMITS, reengagePreviewSchema, reengageStartSchema } from '@dezon/shared';
import { ApiError } from './api';
import {
  alreadyQueuedText,
  eligibleHeadingText,
  followupGuidanceHint,
  loadReengageMode,
  outsideWindowTexts,
  parseReengageMode,
  reengageDescription,
  reengageModeHint,
  reengageModeStorageKey,
  reengagePreviewBody,
  reengageStartBody,
  rowTimeLabel,
  saveReengageMode,
  excerptText,
  formatEstimatedMinutes,
  formatWaitingSince,
  guidanceBody,
  guidanceError,
  guidanceLength,
  parseStoredGuidance,
  reengageGuidanceStorageKey,
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

describe('ô chỉ dẫn gõ tay (Quy tắc chăm sóc / Nội dung chăm sóc lại)', () => {
  it('guidanceBody chỉ gửi ô có chữ (trim)', () => {
    expect(guidanceBody({ rules: '  ', content: '' })).toEqual({});
    expect(guidanceBody({ rules: ' Xưng em ', content: '' })).toEqual({ rules: 'Xưng em' });
    expect(guidanceBody({ rules: 'a', content: ' b ' })).toEqual({ rules: 'a', content: 'b' });
  });

  it('guidanceError / guidanceLength theo ký tự sau trim', () => {
    const max = REENGAGE_LIMITS.guidanceMaxChars;
    expect(guidanceLength('  ab  ')).toBe(2);
    expect(guidanceError('x'.repeat(max))).toBeNull();
    expect(guidanceError(`  ${'x'.repeat(max)}  `)).toBeNull();
    expect(guidanceError('x'.repeat(max + 1))).toBe(`Tối đa ${max} ký tự.`);
  });

  it('parseStoredGuidance: JSON hỏng / thiếu / sai kiểu ⇒ ô trống', () => {
    expect(parseStoredGuidance(null)).toEqual({ rules: '', content: '' });
    expect(parseStoredGuidance('{oops')).toEqual({ rules: '', content: '' });
    expect(parseStoredGuidance('"x"')).toEqual({ rules: '', content: '' });
    expect(parseStoredGuidance('{"rules":"A","content":5}')).toEqual({ rules: 'A', content: '' });
  });

  it('khóa lưu riêng theo bot', () => {
    expect(reengageGuidanceStorageKey('bot-1')).toBe('dezon:reengage-guidance:bot-1');
  });
});

describe('đối tượng tái chăm sóc (Khách bị bỏ sót / Khách không bị bỏ sót)', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';

  it('parseReengageMode: giá trị lạ / thiếu ⇒ missed', () => {
    expect(parseReengageMode('followup')).toBe('followup');
    expect(parseReengageMode('missed')).toBe('missed');
    expect(parseReengageMode(null)).toBe('missed');
    expect(parseReengageMode('khác')).toBe('missed');
    expect(parseReengageMode(1)).toBe('missed');
  });

  it('mô tả hộp thoại theo đối tượng', () => {
    expect(reengageDescription('missed', 'Bot A')).toBe(
      'Tìm khách đã nhắn "Bot A" mà chưa ai trả lời, rồi cho bot trả lời lần lượt.',
    );
    const f = reengageDescription('followup', 'Bot A');
    expect(f).toContain('Tìm khách bên mình đã trả lời nhưng chưa nhắn lại');
    expect(f).toContain('rồi cho bot chủ động nhắn khơi gợi lại câu chuyện.');
    expect(reengageModeHint('missed')).toContain('chưa ai trả lời');
    expect(reengageModeHint('followup')).toContain('khơi gợi');
  });

  it('tóm tắt / tiêu đề / nhãn thời gian theo đối tượng', () => {
    const p = { days: 15, eligible: items(4) as never, truncated: false, alreadyQueued: 0 };
    expect(previewSummaryText(p)).toBe(previewSummaryText(p, 'missed'));
    expect(previewSummaryText(p, 'followup')).toBe('Bot sẽ nhắn khơi gợi 4 khách (≈ 4 lần gọi AI)');
    expect(
      previewSummaryText(
        { ...p, eligible: items(300) as never, truncated: true, alreadyQueued: 2 },
        'followup',
      ),
    ).toBe(
      'Bot sẽ nhắn khơi gợi 300+ khách (≈ 300+ lần gọi AI) · 2 khách đã được xếp hàng từ lần trước, đang chờ bot',
    );
    const none = previewSummaryText({ ...p, days: 7, eligible: [] }, 'followup');
    expect(none).toContain('7 ngày');
    expect(none).not.toContain('bỏ sót');
    expect(eligibleHeadingText('missed', 3)).toBe('Bot sẽ trả lời (3)');
    expect(eligibleHeadingText('followup', 3)).toBe('Bot sẽ nhắn (3)');
    expect(rowTimeLabel('missed')).toBe('Tin cuối');
    expect(rowTimeLabel('followup')).toBe('Tin cuối của khách');
  });

  it('mục khách bot không gửi được: "missed" bảo nhân viên trả lời; "followup" không bảo "trả lời ngay"', () => {
    expect(outsideWindowTexts('missed', 'done', 2)).toEqual({
      heading: 'Bot không kịp gửi — nhân viên trả lời ngay (2)',
      blurb:
        'Khung gửi tin của kênh đã hoặc sẽ đóng trước lượt của bot, nên bot không gửi những khách này. Mở hội thoại để nhân viên trả lời.',
    });
    expect(outsideWindowTexts('missed', 'preview', 4).heading).toBe(
      'Quá khung giờ Facebook — nhân viên tự xử lý (4)',
    );
    expect(outsideWindowTexts('missed', 'preview', 4).blurb).toContain('Mở hội thoại để nhân viên trả lời.');
    for (const when of ['done', 'preview'] as const) {
      const t = outsideWindowTexts('followup', when, 3);
      expect(t.heading).toContain('(3)');
      expect(t.heading).not.toContain('trả lời');
      expect(t.blurb).not.toContain('trả lời');
      expect(t.blurb).toContain('nếu nhân viên muốn tự nhắn khơi gợi');
    }
    expect(outsideWindowTexts('followup', 'done', 1).heading).toBe(
      'Bot không kịp nhắn — nhân viên tự quyết định có nhắn không (1)',
    );
  });

  it('kết quả bắt đầu / bỏ qua theo đối tượng', () => {
    const r = {
      queued: 2,
      alreadyQueued: 0,
      skipped: 0,
      spacingSec: 15,
      startsInMinutes: 0,
      estimatedMinutes: 1,
    };
    expect(startResultText(r, 'followup')).toBe(
      'Đã xếp hàng 2 khách, bot nhắn lần lượt ~15 giây/khách, xong trong khoảng 1 phút.',
    );
    expect(startResultText(r)).toContain('bot trả lời lần lượt');
    expect(startResultText({ ...r, queued: 0 }, 'followup')).toContain('không còn phù hợp');
    expect(skippedText(1, 'followup')).toContain('khách vừa nhắn lại');
    expect(skippedText(1)).toContain('không còn chờ trả lời');
    expect(skippedText(0, 'followup')).toBeNull();
  });

  it('gợi ý điền Nội dung chỉ khi followup và cả hai ô trống (không chặn)', () => {
    expect(followupGuidanceHint('missed', { rules: '', content: '' })).toBeNull();
    expect(followupGuidanceHint('followup', { rules: ' ', content: '' })).toContain('Nội dung chăm sóc lại');
    expect(followupGuidanceHint('followup', { rules: 'Xưng em', content: '' })).toBeNull();
    expect(followupGuidanceHint('followup', { rules: '', content: 'Ưu đãi' })).toBeNull();
  });

  it('thân gửi lên máy chủ luôn kèm mode và hợp lệ theo schema', () => {
    expect(reengagePreviewBody(15, 'followup')).toEqual({ days: 15, mode: 'followup' });
    expect(reengagePreviewSchema.parse(reengagePreviewBody(7, 'missed'))).toEqual({
      days: 7,
      mode: 'missed',
    });
    const body = reengageStartBody({
      days: 15,
      mode: 'followup',
      conversationIds: [uuid],
      guidance: { rules: '  ', content: ' Ưu đãi tháng 11 ' },
    });
    expect(body).toEqual({ days: 15, mode: 'followup', conversationIds: [uuid], content: 'Ưu đãi tháng 11' });
    expect(reengageStartSchema.parse(body).mode).toBe('followup');
    expect(
      reengageStartBody({
        days: 3,
        mode: 'missed',
        conversationIds: [uuid],
        guidance: { rules: '', content: '' },
      }),
    ).toEqual({ days: 3, mode: 'missed', conversationIds: [uuid] });
  });

  describe('nhớ đối tượng theo bot (localStorage)', () => {
    afterEach(() => vi.unstubAllGlobals());

    function stubStorage(store: Map<string, string>) {
      vi.stubGlobal('window', {
        localStorage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => void store.set(k, v),
          removeItem: (k: string) => void store.delete(k),
        },
      });
    }

    it('lưu followup, mặc định thì xóa khóa', () => {
      const store = new Map<string, string>();
      stubStorage(store);
      expect(reengageModeStorageKey('bot-1')).toBe('dezon:reengage-mode:bot-1');
      expect(loadReengageMode('bot-1')).toBe('missed');
      saveReengageMode('bot-1', 'followup');
      expect(store.get('dezon:reengage-mode:bot-1')).toBe('followup');
      expect(loadReengageMode('bot-1')).toBe('followup');
      expect(loadReengageMode('bot-2')).toBe('missed');
      saveReengageMode('bot-1', 'missed');
      expect(store.has('dezon:reengage-mode:bot-1')).toBe(false);
    });

    it('localStorage bị chặn ⇒ mặc định, không ném lỗi', () => {
      vi.stubGlobal('window', {
        get localStorage(): Storage {
          throw new Error('SecurityError');
        },
      });
      expect(loadReengageMode('bot-1')).toBe('missed');
      expect(() => saveReengageMode('bot-1', 'followup')).not.toThrow();
    });
  });
});
