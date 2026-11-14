// "Tái chăm sóc khách bị bỏ sót" (trình soạn chatbot) — hàm thuần để test độc lập.
import {
  REENGAGE_LIMITS,
  type ReengageConversationItem,
  type ReengagePreview,
  type ReengageStartResult,
} from '@dezon/shared';
import { ApiError } from '@/lib/api';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Kiểm tra ô "số ngày" (số nguyên trong [daysMin, daysMax]). */
export function parseReengageDays(
  value: string | number,
): { ok: true; days: number } | { ok: false; error: string } {
  const raw = typeof value === 'number' ? String(value) : value.trim();
  const days = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isInteger(days) ||
    days < REENGAGE_LIMITS.daysMin ||
    days > REENGAGE_LIMITS.daysMax
  ) {
    return {
      ok: false,
      error: `Số ngày phải là số nguyên từ ${REENGAGE_LIMITS.daysMin} đến ${REENGAGE_LIMITS.daysMax}.`,
    };
  }
  return { ok: true, days };
}

/** Mặc định chọn sẵn tối đa `max` khách đầu danh sách. */
export function initialSelection(
  items: Pick<ReengageConversationItem, 'conversationId'>[],
  max: number = REENGAGE_LIMITS.maxPerRun,
): Set<string> {
  return new Set(items.slice(0, Math.max(0, max)).map((i) => i.conversationId));
}

/** Bật/tắt một khách; đã đủ `max` thì không thêm được (trả lại đúng tập cũ). */
export function toggleSelection(
  selected: ReadonlySet<string>,
  id: string,
  max: number = REENGAGE_LIMITS.maxPerRun,
): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else if (next.size < max) next.add(id);
  else return selected as Set<string>;
  return next;
}

/** Ô "Chọn tất cả" được đánh dấu khi đã chọn hết số chọn được (min(danh sách, max)). */
export function isAllSelected(
  selected: ReadonlySet<string>,
  items: Pick<ReengageConversationItem, 'conversationId'>[],
  max: number = REENGAGE_LIMITS.maxPerRun,
): boolean {
  const limit = Math.min(items.length, max);
  if (limit === 0) return false;
  let count = 0;
  for (const i of items) if (selected.has(i.conversationId)) count++;
  return count >= limit;
}

/** Chỉ giữ id còn trong danh sách (phòng khi kiểm tra lại cho danh sách khác). */
export function selectedIds(
  selected: ReadonlySet<string>,
  items: Pick<ReengageConversationItem, 'conversationId'>[],
): string[] {
  return items.filter((i) => selected.has(i.conversationId)).map((i) => i.conversationId);
}

/** "N khách đã được xếp hàng từ lần trước, đang chờ bot" (null khi không có). */
export function alreadyQueuedText(alreadyQueued: number): string | null {
  if (alreadyQueued <= 0) return null;
  return `${alreadyQueued} khách đã được xếp hàng từ lần trước, đang chờ bot`;
}

/** Dòng tóm tắt kết quả kiểm tra: số khách = số lần gọi AI (khách đã xếp hàng từ lần trước không tính lại). */
export function previewSummaryText(
  preview: Pick<ReengagePreview, 'days' | 'eligible' | 'truncated' | 'alreadyQueued'>,
): string {
  const n = preview.eligible.length;
  const queued = alreadyQueuedText(preview.alreadyQueued);
  if (n === 0) {
    return queued
      ? `Không còn khách bị bỏ sót nào khác mà bot còn gửi được trong ${preview.days} ngày qua · ${queued}.`
      : `Không có khách nào bị bỏ sót mà bot còn gửi được trong ${preview.days} ngày qua.`;
  }
  const more = preview.truncated ? '+' : '';
  const base = `Bot sẽ trả lời ${n}${more} khách bị bỏ sót (≈ ${n}${more} lần gọi AI)`;
  return queued ? `${base} · ${queued}` : base;
}

/** "Đã chọn K/N" + vì sao bị giới hạn (khi danh sách dài hơn mức tối đa mỗi lần). */
export function selectionCapText(
  selectedCount: number,
  total: number,
  max: number = REENGAGE_LIMITS.maxPerRun,
): string {
  const base = `Đã chọn ${selectedCount}/${total} khách`;
  if (total <= max) return base;
  return `${base} · mỗi lần tối đa ${max} khách để kiểm soát chi phí AI; bắt đầu xong bấm "Kiểm tra lại" để chọn tiếp các khách còn lại (khách đã xếp hàng không hiện lại; lần sau tự nối tiếp sau hàng đang chờ, không gửi dồn).`;
}

/** Phút dự kiến, làm tròn lên (ít nhất 1). */
export function formatEstimatedMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 1) return 'khoảng 1 phút';
  return `khoảng ${Math.ceil(minutes)} phút`;
}

/** Bấm "Bắt đầu" mà không khách nào được (hoặc đã được) xếp hàng ⇒ báo lỗi. Chỉ trùng lần trước thì không phải lỗi. */
export function isStartResultError(result: Pick<ReengageStartResult, 'queued' | 'alreadyQueued'>): boolean {
  return result.queued === 0 && result.alreadyQueued === 0;
}

/**
 * Kết quả sau khi bấm "Bắt đầu". Mọi lần bấm (mọi bot) dùng chung một hàng giãn cách: startsInMinutes > 0 ⇒ lần này
 * nối sau các khách còn chờ từ trước (estimatedMinutes đã tính cả hàng đó).
 */
export function startResultText(
  result: Pick<
    ReengageStartResult,
    'queued' | 'alreadyQueued' | 'spacingSec' | 'estimatedMinutes' | 'startsInMinutes'
  >,
): string {
  const queued = alreadyQueuedText(result.alreadyQueued);
  if (result.queued === 0) {
    if (queued) return `Không xếp thêm khách nào: ${queued}.`;
    return 'Không xếp hàng được khách nào: các hội thoại đã chọn không còn chờ trả lời (đã có người trả lời, quá khung giờ hoặc đã gỡ bot).';
  }
  const after =
    result.startsInMinutes > 0
      ? ` nối sau các khách đang chờ trong hàng (bắt đầu sau ${formatEstimatedMinutes(result.startsInMinutes)}),`
      : '';
  const base = `Đã xếp hàng ${result.queued} khách,${after} bot trả lời lần lượt ~${result.spacingSec} giây/khách, xong trong ${formatEstimatedMinutes(result.estimatedMinutes)}.`;
  return queued ? `${base} Ngoài ra ${queued}.` : base;
}

/** Dòng phụ khi có id bị bỏ qua lúc bắt đầu. */
export function skippedText(skipped: number): string | null {
  if (skipped <= 0) return null;
  return `Bỏ qua ${skipped} khách không còn chờ trả lời (đã có người trả lời, quá hoặc sắp hết khung giờ, hoặc đã gỡ bot).`;
}

/** Khách đã chờ bao lâu: "vừa xong", "5 phút trước", "3 giờ trước", "12 ngày trước". */
export function formatWaitingSince(iso: string, now: Date = new Date()): string {
  const diff = now.getTime() - Date.parse(iso);
  if (Number.isNaN(diff)) return '';
  if (diff < MINUTE) return 'vừa xong';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} phút trước`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} giờ trước`;
  return `${Math.floor(diff / DAY)} ngày trước`;
}

/** Đường dẫn mở hội thoại trong hộp thư. */
export function inboxConversationHref(conversationId: string): string {
  return `/inbox/${encodeURIComponent(conversationId)}`;
}

/** Trích tin khách cuối (null = chỉ có tệp). */
export function excerptText(item: Pick<ReengageConversationItem, 'lastCustomerText'>): string {
  const text = item.lastCustomerText?.replace(/\s+/g, ' ').trim();
  return text || '[Tệp đính kèm]';
}

/** Thông báo lỗi tiếng Việt cho hai nút "Kiểm tra" / "Bắt đầu". */
export function reengageErrorText(err: unknown, action: 'preview' | 'start'): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'Không tìm thấy chatbot (có thể đã bị xóa).';
    if (err.status === 403) return 'Chỉ quản trị viên mới dùng được tính năng này.';
    if (err.message) return err.message;
  }
  return action === 'preview'
    ? 'Không kiểm tra được. Vui lòng thử lại.'
    : 'Không bắt đầu được. Vui lòng thử lại.';
}

// ---------- Ô chỉ dẫn gõ tay: "Quy tắc chăm sóc" / "Nội dung chăm sóc lại" ----------

export interface ReengageGuidanceDraft {
  rules: string;
  content: string;
}

export const EMPTY_REENGAGE_GUIDANCE: ReengageGuidanceDraft = { rules: '', content: '' };

/** Khóa localStorage nhớ chỉ dẫn gõ lần trước theo từng bot (chỉ trên trình duyệt này). */
export function reengageGuidanceStorageKey(chatbotId: string): string {
  return `dezon:reengage-guidance:${chatbotId}`;
}

/** Số ký tự đếm như máy chủ (theo ký tự, không theo đơn vị UTF-16) — dùng cho bộ đếm "x/4000". */
export function guidanceLength(text: string): number {
  return Array.from(text.trim()).length;
}

/** Lỗi độ dài của một ô (null = hợp lệ). */
export function guidanceError(text: string): string | null {
  const max = REENGAGE_LIMITS.guidanceMaxChars;
  return guidanceLength(text) > max ? `Tối đa ${max} ký tự.` : null;
}

/** Thân gửi kèm "Bắt đầu": chỉ ô có chữ (trim) — ô trống thì bỏ, bot trả lời như lượt thường. */
export function guidanceBody(draft: ReengageGuidanceDraft): { rules?: string; content?: string } {
  const rules = draft.rules.trim();
  const content = draft.content.trim();
  return { ...(rules ? { rules } : {}), ...(content ? { content } : {}) };
}

/** Đọc bản nháp đã lưu (JSON hỏng / thiếu ⇒ ô trống). */
export function parseStoredGuidance(raw: string | null): ReengageGuidanceDraft {
  if (!raw) return EMPTY_REENGAGE_GUIDANCE;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return EMPTY_REENGAGE_GUIDANCE;
    const o = v as Record<string, unknown>;
    return {
      rules: typeof o.rules === 'string' ? o.rules : '',
      content: typeof o.content === 'string' ? o.content : '',
    };
  } catch {
    return EMPTY_REENGAGE_GUIDANCE;
  }
}

/** Đọc chỉ dẫn đã lưu của bot; localStorage bị chặn (ẩn danh, chặn dữ liệu trang) ⇒ ô trống. */
export function loadReengageGuidance(chatbotId: string): ReengageGuidanceDraft {
  try {
    return parseStoredGuidance(window.localStorage.getItem(reengageGuidanceStorageKey(chatbotId)));
  } catch {
    return EMPTY_REENGAGE_GUIDANCE;
  }
}

/** Lưu chỉ dẫn của bot (cả hai trống ⇒ xóa khóa); lỗi lưu thì bỏ qua — chỉ là tiện ích. */
export function saveReengageGuidance(chatbotId: string, draft: ReengageGuidanceDraft): void {
  try {
    const key = reengageGuidanceStorageKey(chatbotId);
    if (!draft.rules.trim() && !draft.content.trim()) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify({ rules: draft.rules, content: draft.content }));
  } catch {
    // bỏ qua
  }
}
