import { describe, expect, it } from 'vitest';
import { rejectHandoffSchema } from '@dezon/shared';
import { ApiError } from './api';
import {
  REJECT_FALLBACK_ERROR,
  REJECT_REASON_MAX,
  canRejectHandoff,
  rejectErrorText,
  rejectHandoffBody,
  rejectReasonError,
  rejectReasonLength,
} from './handoff-reject';

describe('lý do "Không đạt"', () => {
  it('đếm ký tự sau khi trim, theo code point (emoji = 1)', () => {
    expect(rejectReasonLength('')).toBe(0);
    expect(rejectReasonLength('   \n ')).toBe(0);
    expect(rejectReasonLength('  móng  ')).toBe(4);
    expect(rejectReasonLength('👍🏗️')).toBe(Array.from('👍🏗️').length);
    expect(rejectReasonLength('😀')).toBe(1);
  });

  it('trống ⇒ chỉ báo lỗi khi đã chạm vào ô', () => {
    expect(rejectReasonError('  ', false)).toBeNull();
    expect(rejectReasonError('  ')).toBe('Nhập lý do không đạt.');
  });

  it('quá dài ⇒ báo lỗi; đúng giới hạn (kể cả emoji) ⇒ hợp lệ', () => {
    expect(REJECT_REASON_MAX).toBe(1000);
    expect(rejectReasonError('a'.repeat(1000))).toBeNull();
    expect(rejectReasonError(`  ${'a'.repeat(1000)}  `)).toBeNull();
    expect(rejectReasonError('😀'.repeat(1000))).toBeNull();
    expect(rejectReasonError('a'.repeat(1001))).toMatch(/tối đa 1000 ký tự/);
    expect(rejectReasonError('a'.repeat(1001), false)).toMatch(/tối đa 1000/);
  });

  it('thân yêu cầu: trim lý do, khớp schema dùng chung; lý do sai ⇒ null', () => {
    const body = rejectHandoffBody('  Công trình mới làm móng, chưa lên tầng \n');
    expect(body).toEqual({ reason: 'Công trình mới làm móng, chưa lên tầng' });
    expect(rejectHandoffSchema.safeParse(body).success).toBe(true);
    expect(rejectHandoffBody('   ')).toBeNull();
    expect(rejectHandoffBody('x'.repeat(1001))).toBeNull();
    // Hai bên cùng giới hạn: 1000 emoji vẫn được máy chủ nhận.
    expect(rejectHandoffSchema.safeParse(rejectHandoffBody('😀'.repeat(1000))).success).toBe(true);
  });

  it('câu lỗi: dùng thông báo của ApiError, còn lại câu mặc định', () => {
    expect(rejectErrorText(new ApiError(422, 'Hội thoại chưa gắn chatbot'))).toBe(
      'Hội thoại chưa gắn chatbot',
    );
    expect(rejectErrorText(new ApiError(500, '  '))).toBe(REJECT_FALLBACK_ERROR);
    expect(rejectErrorText(new Error('boom'))).toBe(REJECT_FALLBACK_ERROR);
    expect(rejectErrorText(undefined)).toBe(REJECT_FALLBACK_ERROR);
  });
});

describe('nút "Không đạt" hiện khi nào', () => {
  const handoff = { id: 'h1' } as never;
  const chatbot = { id: 'b1' } as never;
  it('chờ người + yêu cầu mở + có chatbot ⇒ hiện', () => {
    expect(canRejectHandoff({ status: 'pending_human', handoff, chatbot })).toBe(true);
  });
  it('bot đã gỡ/xóa (chatbot null) ⇒ ẩn — máy chủ chắc chắn từ chối', () => {
    expect(canRejectHandoff({ status: 'pending_human', handoff, chatbot: null })).toBe(false);
  });
  it('không có yêu cầu mở / không chờ người ⇒ ẩn', () => {
    expect(canRejectHandoff({ status: 'pending_human', handoff: null, chatbot })).toBe(false);
    expect(canRejectHandoff({ status: 'open', handoff, chatbot })).toBe(false);
  });
});
