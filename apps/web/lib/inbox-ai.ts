// Logic THUẦN của tính năng Chatbot AI trong hộp thư (trạng thái AI của hội thoại, cập nhật lạc quan,
// bộ lọc "AI đang lo", nhãn tin bot, nhật ký AI). Không phụ thuộc React để test độc lập.
import {
  HANDOFF_REASON_LABELS,
  type AiRunDecision,
  type ChatbotRef,
  type ConversationSummary,
  type MessageDto,
  type UserRef,
} from '@dezon/shared';

/** Bộ lọc trạng thái AI phía web. 'handled' = "AI đang lo" (có chatbot và ai_mode auto). */
export type AiStateFilter = 'handled';

type AiFields = Pick<ConversationSummary, 'status' | 'aiMode' | 'chatbot' | 'aiPausedUntil' | 'handoff'>;

/** AI đang tạm dừng (nhân viên vừa nhắn) tại thời điểm `now` (ms). */
export function isAiPaused(c: Pick<ConversationSummary, 'aiPausedUntil'>, now: number): boolean {
  if (!c.aiPausedUntil) return false;
  const until = Date.parse(c.aiPausedUntil);
  return Number.isFinite(until) && until > now;
}

/**
 * Trạng thái AI hiển thị của hội thoại:
 * - 'handoff': đang chờ người thật (pending_human);
 * - 'paused': có bot, ai_mode auto nhưng đang tạm dừng vì nhân viên vừa nhắn;
 * - 'active': bot đang tự trả lời;
 * - 'none': không có bot hoặc bot đang tắt cho hội thoại.
 */
export type ConversationAiState = 'handoff' | 'paused' | 'active' | 'none';

export function conversationAiState(c: AiFields, now: number): ConversationAiState {
  if (c.status === 'pending_human') return 'handoff';
  if (!c.chatbot || c.aiMode !== 'auto') return 'none';
  return isAiPaused(c, now) ? 'paused' : 'active';
}

/**
 * Trạng thái ô "Chatbot" ở đầu khung chat:
 * - 'handoff': đang chờ người thật ⇒ khóa ô chọn (bấm "Đã xong, trả lại cho AI" để bật lại bot);
 * - 'on': có bot và ai_mode auto (bot đang lo — kể cả đang tạm dừng ngắn hạn);
 * - 'off': còn gắn bot nhưng ai_mode off (ví dụ sau "Xong" hoặc sau khi chuyển người) ⇒ "Bot đang tắt — Bật lại";
 * - 'none': chưa gắn bot.
 */
export type ChatbotControlState = 'handoff' | 'on' | 'off' | 'none';

export function chatbotControlState(
  c: Pick<ConversationSummary, 'status' | 'aiMode' | 'chatbot'>,
): ChatbotControlState {
  if (c.status === 'pending_human') return 'handoff';
  if (!c.chatbot) return 'none';
  return c.aiMode === 'auto' ? 'on' : 'off';
}

/** Gợi ý khi ô chọn bị khóa vì hội thoại đang chờ người thật. */
export const CHATBOT_LOCKED_HINT = "Bấm 'Đã xong, trả lại cho AI' để bật lại bot";

/** "AI đang lo": hội thoại có chatbot và ai_mode auto (kể cả đang tạm dừng ngắn hạn). */
export function matchesAiState(
  c: Pick<ConversationSummary, 'aiMode' | 'chatbot'>,
  filter: AiStateFilter | undefined,
): boolean {
  if (!filter) return true;
  return !!c.chatbot && c.aiMode === 'auto';
}

// ---------- Cập nhật lạc quan (trước khi máy chủ trả lời) ----------

/**
 * Bật bot (kể cả chọn lại đúng bot đang gắn) ⇒ ai_mode auto, xóa tạm dừng; nếu đang chờ người thì máy chủ
 * coi như "trả lại cho AI" (mở lại, đóng handoff). Tắt ⇒ off.
 */
export function withChatbot<T extends ConversationSummary>(c: T, bot: ChatbotRef | null): T {
  if (!bot) return { ...c, chatbot: null, aiMode: 'off', aiPausedUntil: null };
  const next: T = { ...c, chatbot: bot, aiMode: 'auto', aiPausedUntil: null };
  return c.status === 'pending_human' ? { ...next, status: 'open', handoff: null } : next;
}

/** "Tiếp tục AI": xóa tạm dừng. */
export function withAiResumed<T extends ConversationSummary>(c: T): T {
  return { ...c, aiPausedUntil: null };
}

/** "Nhận xử lý": ghi người nhận; hội thoại chưa phân công thì giao luôn cho người nhận. */
export function withHandoffAcknowledged<T extends ConversationSummary>(c: T, user: UserRef): T {
  return {
    ...c,
    assignedUser: c.assignedUser ?? user,
    handoff: c.handoff ? { ...c.handoff, acknowledgedBy: user } : c.handoff,
  };
}

/** "Đã xong, trả lại cho AI": mở lại, đóng handoff, bật lại AI nếu còn bot. */
export function withHandoffResolved<T extends ConversationSummary>(c: T): T {
  return {
    ...c,
    status: 'open',
    handoff: null,
    aiMode: c.chatbot ? 'auto' : c.aiMode,
    aiPausedUntil: null,
  };
}

/** Phản hồi API có thể là ConversationSummary hoặc `{ conversation }` (UpdateConversationResult). */
export function extractConversation(
  value: unknown,
  looksLike: (v: unknown) => v is ConversationSummary,
): ConversationSummary | null {
  if (looksLike(value)) return value;
  if (value && typeof value === 'object' && 'conversation' in value) {
    const inner = (value as { conversation: unknown }).conversation;
    if (looksLike(inner)) return inner;
  }
  return null;
}

// ---------- Hiển thị ----------

/** Nhãn người gửi của tin bot: "AI · <tên bot>" (senderLabel = tên bot), thiếu tên thì "AI". */
export function botSenderLabel(m: Pick<MessageDto, 'senderLabel'>): string {
  const name = m.senderLabel?.trim();
  return name ? `AI · ${name}` : 'AI';
}

/** Nhãn lý do chuyển người (mã lạ ⇒ "Lý do khác"). */
export function handoffReasonLabel(code: string | null | undefined): string {
  if (!code) return HANDOFF_REASON_LABELS.other;
  return (HANDOFF_REASON_LABELS as Record<string, string>)[code] ?? HANDOFF_REASON_LABELS.other;
}

export const AI_RUN_DECISION_LABELS: Record<AiRunDecision, string> = {
  reply: 'Trả lời',
  escalate: 'Chuyển người',
  no_reply: 'Không trả lời',
  suggest: 'Gợi ý',
  error: 'Lỗi',
};

/** Lớp màu badge cho từng quyết định trong "Nhật ký AI". */
export const AI_RUN_DECISION_TONES: Record<AiRunDecision, string> = {
  reply: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  escalate: 'border-red-200 bg-red-50 text-red-700',
  no_reply: 'border-slate-200 bg-slate-50 text-slate-600',
  suggest: 'border-sky-200 bg-sky-50 text-sky-700',
  error: 'border-amber-200 bg-amber-50 text-amber-800',
};

/** "1,2 s" / "850 ms". */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

export interface ChatbotOption {
  id: string;
  label: string;
}

/**
 * Lựa chọn của ô "Chatbot" ở khung chat: bot đang bật (theo tên); bot đang gắn mà đã tắt / không còn
 * trong danh sách vẫn hiện (kèm "(đã tắt)") để ô chọn không nói sai.
 */
export function chatbotSelectOptions(
  bots: readonly { id: string; name: string; isActive: boolean }[],
  current: ChatbotRef | null | undefined,
): ChatbotOption[] {
  const active = bots
    .filter((b) => b.isActive)
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
    .map((b) => ({ id: b.id, label: b.name }));
  if (current && !active.some((o) => o.id === current.id)) {
    active.push({ id: current.id, label: `${current.name} (đã tắt)` });
  }
  return active;
}
