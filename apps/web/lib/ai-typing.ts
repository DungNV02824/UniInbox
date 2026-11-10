// "AI đang soạn tin…": giữ trạng thái bot đang soạn theo hội thoại từ sự kiện realtime `ai.typing`.
// Kho thuần (không phụ thuộc React) để test bằng đồng hồ giả; React đọc qua useSyncExternalStore.
import { AI_TYPING_TTL_MS, type AiTypingPayload, type MessageDto } from '@dezon/shared';

/**
 * Lưới an toàn phía web: không nhận được typing:false (worker chết, mất kết nối giữa chừng) thì tự tắt sau
 * ngần này. Ngắn hơn AI_TYPING_TTL_MS của hợp đồng để chỉ báo không "treo" lâu; worker phát lại typing:true
 * thì hẹn giờ được gia hạn.
 */
export const AI_TYPING_CLIENT_TIMEOUT_MS = Math.min(30_000, AI_TYPING_TTL_MS);

export interface AiTypingEntry {
  /** Tên bot (null = không rõ). */
  chatbotName: string | null;
  /** Mốc (ms) tự tắt. */
  expiresAt: number;
}

export type AiTypingState = Readonly<Record<string, AiTypingEntry>>;

export const EMPTY_AI_TYPING: AiTypingState = Object.freeze({});

/** Áp một sự kiện `ai.typing`. Trả về CHÍNH state cũ nếu không có gì đổi (để React không render lại). */
export function applyAiTyping(
  state: AiTypingState,
  payload: AiTypingPayload,
  now: number,
  timeoutMs = AI_TYPING_CLIENT_TIMEOUT_MS,
): AiTypingState {
  if (!payload.conversationId) return state;
  if (!payload.typing) return clearAiTyping(state, payload.conversationId);
  const prev = state[payload.conversationId];
  const chatbotName = payload.chatbotName?.trim() || null;
  const expiresAt = now + timeoutMs;
  if (prev && prev.chatbotName === chatbotName && prev.expiresAt === expiresAt) return state;
  return { ...state, [payload.conversationId]: { chatbotName, expiresAt } };
}

export function clearAiTyping(state: AiTypingState, conversationId: string): AiTypingState {
  if (!(conversationId in state)) return state;
  const next = { ...state };
  delete next[conversationId];
  return next;
}

/** Tin bot đã tới hội thoại đó ⇒ tắt chỉ báo (không chờ typing:false). Tin khác giữ nguyên. */
export function applyMessageToAiTyping(
  state: AiTypingState,
  message: Pick<MessageDto, 'conversationId' | 'senderType'>,
): AiTypingState {
  return message.senderType === 'bot' ? clearAiTyping(state, message.conversationId) : state;
}

/** Bỏ các mục đã quá hạn. */
export function pruneAiTyping(state: AiTypingState, now: number): AiTypingState {
  let next: Record<string, AiTypingEntry> | null = null;
  for (const [id, entry] of Object.entries(state)) {
    if (entry.expiresAt <= now) {
      next ??= { ...state };
      delete next[id];
    }
  }
  return next ?? state;
}

/** Mốc hết hạn gần nhất (null = không còn mục nào) — để hẹn đúng một bộ đếm giờ. */
export function nextAiTypingExpiry(state: AiTypingState): number | null {
  let min: number | null = null;
  for (const entry of Object.values(state)) {
    if (min === null || entry.expiresAt < min) min = entry.expiresAt;
  }
  return min;
}

/** Mục đang soạn của hội thoại (đã hết hạn coi như không có). */
export function aiTypingFor(state: AiTypingState, conversationId: string, now: number): AiTypingEntry | null {
  const entry = state[conversationId];
  return entry && entry.expiresAt > now ? entry : null;
}

/** "Bot CTV đang soạn tin…" / "AI đang soạn tin…". */
export function aiTypingLabel(chatbotName: string | null | undefined): string {
  const name = chatbotName?.trim();
  return name ? `${name} đang soạn tin…` : 'AI đang soạn tin…';
}

// ---------- Kho có hẹn giờ ----------

export interface AiTypingClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realClock: AiTypingClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface AiTypingStore {
  getSnapshot: () => AiTypingState;
  subscribe: (listener: () => void) => () => void;
  /** Sự kiện `ai.typing`. */
  handleTyping: (payload: AiTypingPayload) => void;
  /** Sự kiện `message.created` (tin bot ⇒ tắt). */
  handleMessage: (message: Pick<MessageDto, 'conversationId' | 'senderType'>) => void;
  /** Mất kết nối / đăng xuất: tắt hết. */
  clearAll: () => void;
  /** Hủy bộ đếm giờ (khi unmount). */
  dispose: () => void;
}

export function createAiTypingStore(opts: { clock?: AiTypingClock; timeoutMs?: number } = {}): AiTypingStore {
  const clock = opts.clock ?? realClock;
  const timeoutMs = opts.timeoutMs ?? AI_TYPING_CLIENT_TIMEOUT_MS;
  let state: AiTypingState = EMPTY_AI_TYPING;
  let timer: unknown = null;
  const listeners = new Set<() => void>();

  function schedule() {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
    const at = nextAiTypingExpiry(state);
    if (at === null) return;
    timer = clock.setTimeout(
      () => {
        timer = null;
        set(pruneAiTyping(state, clock.now()));
      },
      Math.max(0, at - clock.now()),
    );
  }

  function set(next: AiTypingState) {
    if (next === state) {
      // Vẫn hẹn lại nếu bộ đếm vừa chạy mà chưa có gì hết hạn (đồng hồ lệch vài ms).
      if (timer === null) schedule();
      return;
    }
    state = next;
    schedule();
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    handleTyping: (payload) => set(applyAiTyping(state, payload, clock.now(), timeoutMs)),
    handleMessage: (message) => set(applyMessageToAiTyping(state, message)),
    clearAll: () => set(EMPTY_AI_TYPING),
    dispose() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      listeners.clear();
    },
  };
}
