import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  AI_OUTAGE_FALLBACK_ERROR,
  aiOutageCanResume,
  aiOutageConfirmText,
  aiOutageErrorText,
  aiOutageMayChange,
  aiOutageResumedText,
  aiOutageStripText,
  aiOutageView,
} from './ai-outage';

const HANDOFF = {
  reasonCode: 'other' as const,
  summary: 'Lỗi gọi AI: Gemini HTTP 429',
  at: '2026-11-19T00:00:00.000Z',
  acknowledgedBy: null,
};
const ON = { aiEnabled: true, waiting: 0, missed: 0 };
const OFF = { aiEnabled: false, waiting: 0, missed: 0 };
const TAIL = 'Hội thoại nhân viên đã nhận hoặc đã nhắn khách giữ nguyên.';

describe('Bật lại AI toàn hệ thống', () => {
  it('aiOutageView: chỉ nhận số nguyên dương; chưa tải ⇒ AI bật, 0 / 0', () => {
    expect(aiOutageView({ aiEnabled: false, waiting: 3, missed: 2 })).toEqual({
      aiEnabled: false,
      waiting: 3,
      missed: 2,
    });
    expect(aiOutageView({ aiEnabled: true, waiting: -2, missed: Number.NaN })).toEqual(ON);
    expect(aiOutageView(undefined)).toEqual(ON);
    expect(aiOutageView(null)).toEqual(ON);
  });

  it('dải vàng: AI tắt ⇒ luôn hiện (+ tổng chờ); AI bật ⇒ chỉ khi có hội thoại chờ vì AI lỗi', () => {
    expect(aiOutageStripText(OFF)).toBe('AI đang tắt toàn hệ thống');
    expect(aiOutageStripText({ ...OFF, waiting: 2, missed: 3 })).toBe(
      'AI đang tắt toàn hệ thống · 5 hội thoại chờ bot trả lời',
    );
    expect(aiOutageStripText(ON)).toBeNull();
    // Chỉ có khách chưa được trả lời mà AI vẫn bật ⇒ không hiện (đỡ nhiễu).
    expect(aiOutageStripText({ ...ON, missed: 4 })).toBeNull();
    expect(aiOutageStripText({ ...ON, waiting: 5 })).toBe(
      '5 hội thoại đang chờ vì AI lỗi (hết hạn mức / quá tải)',
    );
    expect(aiOutageStripText({ ...ON, waiting: 5, missed: 2 })).toBe(
      '5 hội thoại đang chờ vì AI lỗi (hết hạn mức / quá tải) · 2 khách chưa được trả lời',
    );
  });

  it('AI tắt toàn hệ thống ⇒ chỉ admin bấm được', () => {
    expect(aiOutageCanResume(OFF, 'admin')).toBe(true);
    expect(aiOutageCanResume(OFF, 'agent')).toBe(false);
    expect(aiOutageCanResume(OFF, undefined)).toBe(false);
    expect(aiOutageCanResume(ON, 'agent')).toBe(true);
  });

  it('hộp thoại xác nhận: đủ phần, bỏ phần bằng 0', () => {
    expect(aiOutageConfirmText({ aiEnabled: false, waiting: 4, missed: 2 })).toBe(
      'Hệ thống sẽ thử gọi AI. Nếu AI đã hoạt động: bật lại AI toàn hệ thống, trả lại 4 hội thoại cho bot và trả ' +
        `lời 2 khách bị bỏ lỡ trong 24 giờ qua. ${TAIL}`,
    );
    expect(aiOutageConfirmText({ ...ON, waiting: 4, missed: 2 })).toBe(
      `Hệ thống sẽ thử gọi AI. Nếu AI đã hoạt động: trả lại 4 hội thoại cho bot và trả lời 2 khách bị bỏ lỡ trong 24 giờ qua. ${TAIL}`,
    );
    expect(aiOutageConfirmText({ ...ON, waiting: 4 })).toBe(
      `Hệ thống sẽ thử gọi AI. Nếu AI đã hoạt động: trả lại 4 hội thoại cho bot. ${TAIL}`,
    );
    expect(aiOutageConfirmText({ ...ON, missed: 1 })).toContain(
      'Nếu AI đã hoạt động: trả lời 1 khách bị bỏ lỡ trong 24 giờ qua.',
    );
    expect(aiOutageConfirmText(OFF)).toBe(
      `Hệ thống sẽ thử gọi AI. Nếu AI đã hoạt động: bật lại AI toàn hệ thống. ${TAIL}`,
    );
    // Chưa có số ⇒ nói chung.
    expect(aiOutageConfirmText(ON)).toContain('Nếu AI đã hoạt động: trả lại các hội thoại đang chờ cho bot.');
  });

  it('toast thành công: "toàn hệ thống" khi vừa bật công tắc; tổng = chờ + bỏ sót', () => {
    expect(aiOutageResumedText({ enabledNow: true, waiting: 3, missed: 4 })).toBe(
      'Đã bật lại AI toàn hệ thống — bot sẽ trả lời 7 hội thoại trong ít phút',
    );
    expect(aiOutageResumedText({ enabledNow: false, waiting: 3, missed: 0 })).toBe(
      'Đã bật lại AI — bot sẽ trả lời 3 hội thoại trong ít phút',
    );
    expect(aiOutageResumedText({ enabledNow: true, waiting: 0, missed: 0 })).toBe(
      'Đã bật lại AI toàn hệ thống',
    );
    expect(aiOutageResumedText(undefined)).toBe('Đã bật lại AI');
  });

  it('lỗi: hiện lời máy chủ; lỗi lạ / lời trống ⇒ câu chung', () => {
    expect(aiOutageErrorText(new ApiError(409, 'AI vẫn chưa hoạt động lại: hết hạn mức'))).toBe(
      'AI vẫn chưa hoạt động lại: hết hạn mức',
    );
    expect(aiOutageErrorText(new ApiError(503, '  '))).toBe(AI_OUTAGE_FALLBACK_ERROR);
    expect(aiOutageErrorText(new Error('network'))).toBe(AI_OUTAGE_FALLBACK_ERROR);
  });

  it('aiOutageMayChange: hội thoại vừa chuyển người vì AI lỗi, đang có hội thoại chờ, hoặc AI đang tắt', () => {
    expect(aiOutageMayChange({ handoff: { ...HANDOFF, autoResume: true } }, undefined)).toBe(true);
    expect(aiOutageMayChange({ handoff: { ...HANDOFF, autoResume: true } }, ON)).toBe(true);
    expect(aiOutageMayChange({ handoff: null }, { ...ON, waiting: 2 })).toBe(true);
    expect(aiOutageMayChange({ handoff: null }, OFF)).toBe(true);
    expect(aiOutageMayChange({ handoff: null }, ON)).toBe(false);
    expect(aiOutageMayChange({ handoff: null }, { ...ON, missed: 3 })).toBe(false);
    expect(aiOutageMayChange({ handoff: null }, undefined)).toBe(false);
    expect(aiOutageMayChange({ handoff: { ...HANDOFF, autoResume: false } }, ON)).toBe(false);
  });
});
