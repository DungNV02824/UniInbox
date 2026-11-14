// Nút "Không đạt" trên banner Cần người — hàm thuần (đếm ký tự, kiểm tra lý do, câu lỗi) để test độc lập.
import { HANDOFF_REJECT_LIMITS, type ConversationSummary, type RejectHandoffRequest } from '@dezon/shared';
import { ApiError } from '@/lib/api';

export const REJECT_REASON_MAX = HANDOFF_REJECT_LIMITS.reasonMaxChars;
export const REJECT_FALLBACK_ERROR = 'Không gửi được. Vui lòng thử lại.';

/**
 * Hiện nút "Không đạt" không: đang chờ người, có yêu cầu chuyển người mở VÀ có chatbot gắn (AI soạn tin bằng persona
 * của bot — không gắn bot thì máy chủ chắc chắn từ chối, khỏi để nhân viên gõ lý do vô ích).
 */
export function canRejectHandoff(c: Pick<ConversationSummary, 'status' | 'handoff' | 'chatbot'>): boolean {
  return c.status === 'pending_human' && !!c.handoff && !!c.chatbot;
}

/** Số ký tự của lý do sau khi bỏ khoảng trắng hai đầu (đếm theo code point, khớp máy chủ). */
export function rejectReasonLength(value: string): number {
  return Array.from(value.trim()).length;
}

/** Câu lỗi của ô lý do, null nếu hợp lệ. `touched` false ⇒ chưa báo "trống" (mới mở hộp thoại). */
export function rejectReasonError(value: string, touched = true): string | null {
  const len = rejectReasonLength(value);
  if (len === 0) return touched ? 'Nhập lý do không đạt.' : null;
  if (len > REJECT_REASON_MAX) return `Lý do tối đa ${REJECT_REASON_MAX} ký tự (đang ${len}).`;
  return null;
}

/** Thân yêu cầu gửi lên (lý do đã trim), null nếu lý do không hợp lệ. */
export function rejectHandoffBody(value: string): RejectHandoffRequest | null {
  if (rejectReasonError(value) !== null) return null;
  return { reason: value.trim() };
}

/** Câu lỗi hiện trong hộp thoại khi gửi thất bại. */
export function rejectErrorText(err: unknown): string {
  if (err instanceof ApiError && err.message.trim()) return err.message;
  return REJECT_FALLBACK_ERROR;
}
