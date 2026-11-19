// Nút "Bật lại AI" — bật lại AI cho TOÀN HỆ THỐNG (sau khi hết hạn mức / quá tải, hoặc admin đã tắt công tắc AI chung):
// chữ hiển thị + quy tắc thuần, tách khỏi component để kiểm thử.
// Hợp đồng API: AiOutageStatus / AiOutageResumeResponse trong @dezon/shared (chatbots.ts).
import {
  AI_MISSED_REPLY_MAX_AGE_HOURS,
  type AiOutageResumeResponse,
  type AiOutageStatus,
  type ConversationSummary,
  type UserRole,
} from '@dezon/shared';
import { ApiError } from '@/lib/api';

/** Tải lại trạng thái mỗi phút (ngoài sự kiện realtime). */
export const AI_OUTAGE_REFETCH_MS = 60_000;

export const AI_OUTAGE_RESUME_LABEL = 'Bật lại AI';
export const AI_OUTAGE_RESUME_NOW_LABEL = 'Bật lại AI ngay';
export const AI_OUTAGE_PENDING_LABEL = 'Đang kiểm tra AI…';
export const AI_OUTAGE_CONFIRM_TITLE = 'Bật lại AI?';
/** Công tắc AI chung đang tắt mà người xem không phải admin (máy chủ sẽ trả 403). */
export const AI_OUTAGE_ADMIN_HINT = 'Nhờ quản trị viên bật lại AI';
export const AI_OUTAGE_FALLBACK_ERROR = 'Không bật lại được AI. Vui lòng thử lại.';

/** Trạng thái đã chuẩn hóa; chưa tải ⇒ coi như AI bật, không ai chờ (không hiện dải). */
export interface AiOutageView {
  aiEnabled: boolean;
  waiting: number;
  missed: number;
}

function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function aiOutageView(status: Partial<AiOutageStatus> | null | undefined): AiOutageView {
  return {
    aiEnabled: status?.aiEnabled !== false,
    waiting: count(status?.waiting),
    missed: count(status?.missed),
  };
}

/**
 * Dòng chữ của dải vàng đầu danh sách; null ⇒ ẩn. AI tắt toàn hệ thống ⇒ luôn hiện. AI bật ⇒ chỉ hiện khi có hội
 * thoại "Cần người" vì AI lỗi (chỉ có khách chưa được trả lời mà AI vẫn bật ⇒ không hiện cho đỡ nhiễu).
 */
export function aiOutageStripText(s: AiOutageView): string | null {
  if (!s.aiEnabled) {
    const total = s.waiting + s.missed;
    return `AI đang tắt toàn hệ thống${total > 0 ? ` · ${total} hội thoại chờ bot trả lời` : ''}`;
  }
  if (s.waiting === 0) return null;
  const missed = s.missed > 0 ? ` · ${s.missed} khách chưa được trả lời` : '';
  return `${s.waiting} hội thoại đang chờ vì AI lỗi (hết hạn mức / quá tải)${missed}`;
}

/** Có được bấm "Bật lại AI" không: công tắc chung đang tắt thì chỉ admin bật được. */
export function aiOutageCanResume(
  s: Pick<AiOutageView, 'aiEnabled'>,
  role: UserRole | null | undefined,
): boolean {
  return s.aiEnabled || role === 'admin';
}

/** "a", "a và b", "a, b và c". */
function joinVi(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} và ${parts[parts.length - 1]}`;
}

/** Nội dung hộp thoại xác nhận "Bật lại AI?" — bỏ các phần bằng 0. */
export function aiOutageConfirmText(s: AiOutageView): string {
  const parts: string[] = [];
  if (!s.aiEnabled) parts.push('bật lại AI toàn hệ thống');
  if (s.waiting > 0) parts.push(`trả lại ${s.waiting} hội thoại cho bot`);
  if (s.missed > 0)
    parts.push(`trả lời ${s.missed} khách bị bỏ lỡ trong ${AI_MISSED_REPLY_MAX_AGE_HOURS} giờ qua`);
  // Chưa có số (chưa tải / vừa đổi) ⇒ nói chung chung, máy chủ tự tính lúc bấm.
  if (parts.length === 0) parts.push('trả lại các hội thoại đang chờ cho bot');
  return (
    `Hệ thống sẽ thử gọi AI. Nếu AI đã hoạt động: ${joinVi(parts)}. ` +
    'Hội thoại nhân viên đã nhận hoặc đã nhắn khách giữ nguyên.'
  );
}

/** Toast khi máy chủ đã nhận lệnh (số lấy từ phản hồi — đúng lúc bấm). */
export function aiOutageResumedText(
  r:
    | Partial<Pick<AiOutageResumeResponse, 'enabledNow' | 'waiting' | 'missed' | 'stillDown'>>
    | null
    | undefined,
): string {
  const head = r?.enabledNow ? 'Đã bật lại AI toàn hệ thống' : 'Đã bật lại AI';
  const down = r?.stillDown ?? [];
  const blocked = down.reduce((n, d) => n + count(d.conversations), 0);
  const total = Math.max(0, count(r?.waiting) + count(r?.missed) - blocked);
  return total > 0 ? `${head} — bot sẽ trả lời ${total} hội thoại trong ít phút` : head;
}

/**
 * Model gọi thử vẫn lỗi khi bấm (phản hồi stillDown): "gemini-x (12 hội thoại): máy chủ Gemini đang lỗi" — hội thoại
 * của các model đó chưa được trả lại, hệ thống tự thử lại mỗi 3 phút. null ⇒ mọi model đều chạy được.
 */
export function aiOutageStillDownText(
  r: Partial<Pick<AiOutageResumeResponse, 'stillDown'>> | null | undefined,
): string | null {
  const down = r?.stillDown ?? [];
  if (down.length === 0) return null;
  const parts = down.map(
    (d) =>
      `${d.model}${count(d.conversations) > 0 ? ` (${count(d.conversations)} hội thoại)` : ''}: ${d.reason}`,
  );
  return `Model vẫn lỗi — ${parts.join('; ')}. Hệ thống tự thử lại mỗi 3 phút, hoặc đổi Model của bot sang model khác.`;
}

/** Lỗi hiện trong hộp thoại: lời máy chủ (vd. "AI vẫn chưa hoạt động lại: …") hoặc câu chung. */
export function aiOutageErrorText(err: unknown): string {
  if (err instanceof ApiError && err.message.trim()) return err.message;
  return AI_OUTAGE_FALLBACK_ERROR;
}

/**
 * Sự kiện `conversation.updated` có thể làm đổi những gì dải vàng hiển thị? Hội thoại vừa chuyển người vì AI lỗi
 * (handoff.autoResume) ⇒ có; đang có hội thoại chờ hoặc AI đang tắt (đếm cả khách chưa được trả lời) ⇒ có.
 * Còn lại (AI bật, không ai chờ) ⇒ không tải lại cho đỡ tốn.
 */
export function aiOutageMayChange(
  conversation: Pick<ConversationSummary, 'handoff'>,
  cached: Partial<AiOutageStatus> | null | undefined,
): boolean {
  if (conversation.handoff?.autoResume) return true;
  if (!cached) return false;
  return cached.aiEnabled === false || count(cached.waiting) > 0;
}
