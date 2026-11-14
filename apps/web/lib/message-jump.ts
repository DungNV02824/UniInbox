// "Nhảy tới tin nhắn": bấm một dòng Nhật ký công trình ⇒ khung chat cuộn tới tin của công trình đó (tải thêm tin
// cũ nếu chưa có) và làm nổi các tin ấy vài giây. Kho thuần (không phụ thuộc React) để test bằng đồng hồ giả;
// React đọc qua useSyncExternalStore.
import { useSyncExternalStore } from 'react';

/** Thời gian làm nổi các tin sau khi cuộn tới (ms). */
export const MESSAGE_HIGHLIGHT_MS = 3000;
/** Tối đa số trang tin cũ tải thêm cho một lần nhảy. */
export const MESSAGE_JUMP_MAX_PAGES = 30;

export interface MessageJumpRequest {
  /** Tăng dần mỗi lần yêu cầu (phân biệt hai lần bấm cùng một dòng). */
  seq: number;
  conversationId: string;
  /** Tin để cuộn tới (null = dùng tin đầu tiên còn thấy trong `highlightIds`). */
  anchorId: string | null;
  /** Các tin làm nổi (đồng thời là tin dự phòng để cuộn tới theo thứ tự). */
  highlightIds: readonly string[];
  /**
   * ISO. Đã tải tới tin cũ hơn mốc này mà vẫn chưa thấy tin cần tới ⇒ thôi tải thêm (tin đã bị xóa) — khỏi tải
   * hết lịch sử hội thoại dài.
   */
  notBefore: string | null;
}

export interface MessageHighlight {
  seq: number;
  conversationId: string;
  ids: ReadonlySet<string>;
}

export interface MessageJumpState {
  /** Yêu cầu đang chờ khung chat xử lý (null = không có). */
  request: MessageJumpRequest | null;
  /** Tin đang được làm nổi (null = không có). */
  highlight: MessageHighlight | null;
}

export const EMPTY_MESSAGE_JUMP: MessageJumpState = Object.freeze({ request: null, highlight: null });

interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Listener = () => void;

export interface MessageJumpStore {
  subscribe: (listener: Listener) => () => void;
  getSnapshot: () => MessageJumpState;
  /** Yêu cầu khung chat của `conversationId` cuộn tới tin. Thay yêu cầu cũ (nếu còn). Trả về seq. */
  requestJump: (
    conversationId: string,
    anchorId: string | null,
    highlightIds: readonly string[],
    opts?: { notBefore?: string | null },
  ) => number;
  /**
   * Khung chat xử lý xong yêu cầu `seq`: `found` ⇒ làm nổi `highlightIds` trong MESSAGE_HIGHLIGHT_MS rồi tự tắt.
   * Yêu cầu đã bị thay thế ⇒ bỏ qua.
   */
  finishJump: (seq: number, found: boolean) => void;
  /** Bỏ yêu cầu đang chờ + làm nổi của hội thoại (không truyền ⇒ tất cả). */
  clear: (conversationId?: string) => void;
  dispose: () => void;
}

export function createMessageJumpStore(
  timers: Timers = defaultTimers,
  highlightMs = MESSAGE_HIGHLIGHT_MS,
): MessageJumpStore {
  let state: MessageJumpState = EMPTY_MESSAGE_JUMP;
  let seq = 0;
  let timer: unknown = null;
  const listeners = new Set<Listener>();

  const set = (next: MessageJumpState) => {
    if (next === state) return;
    state = next;
    listeners.forEach((l) => l());
  };
  const stopTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    requestJump(conversationId, anchorId, highlightIds, opts) {
      seq += 1;
      stopTimer();
      set({
        request: {
          seq,
          conversationId,
          anchorId: anchorId || null,
          highlightIds: [...new Set(highlightIds.filter(Boolean))],
          notBefore: opts?.notBefore ?? null,
        },
        // Bấm dòng khác ⇒ tắt làm nổi cũ ngay.
        highlight: null,
      });
      return seq;
    },
    finishJump(doneSeq, found) {
      const req = state.request;
      if (!req || req.seq !== doneSeq) return;
      stopTimer();
      if (!found) {
        set({ request: null, highlight: null });
        return;
      }
      const ids = new Set(req.highlightIds);
      if (req.anchorId) ids.add(req.anchorId);
      set({ request: null, highlight: { seq: req.seq, conversationId: req.conversationId, ids } });
      timer = timers.set(() => {
        timer = null;
        if (state.highlight?.seq === doneSeq) set({ ...state, highlight: null });
      }, highlightMs);
    },
    clear(conversationId) {
      const keepRequest = conversationId && state.request?.conversationId !== conversationId;
      const keepHighlight = conversationId && state.highlight?.conversationId !== conversationId;
      if (!keepHighlight) stopTimer();
      set(
        keepRequest && keepHighlight
          ? state
          : {
              request: keepRequest ? state.request : null,
              highlight: keepHighlight ? state.highlight : null,
            },
      );
    },
    dispose() {
      stopTimer();
      listeners.clear();
    },
  };
}

// ---------- Quyết định từng bước (hàm thuần) ----------

export type MessageJumpStep =
  /** Tin đã có trong danh sách ⇒ cuộn tới. */
  | { kind: 'scroll'; targetId: string }
  /** Chưa thấy tin, còn trang cũ hơn ⇒ tải thêm. */
  | { kind: 'fetch' }
  /** Không thấy tin nào của công trình (đã xóa / quá xa). */
  | { kind: 'missing' };

/**
 * Bước tiếp theo của một lần nhảy. `loaded` = tin đang có trong khung chat (cũ → mới). Ưu tiên tin neo; chưa thấy
 * thì tải thêm trang cũ cho tới khi hết trang / đủ MESSAGE_JUMP_MAX_PAGES / đã qua mốc `notBefore`, rồi mới dùng
 * tin dự phòng đầu tiên còn thấy trong `highlightIds`.
 */
export function planMessageJump(input: {
  request: Pick<MessageJumpRequest, 'anchorId' | 'highlightIds' | 'notBefore'>;
  loaded: readonly { id: string; sentAt: string }[];
  hasNextPage: boolean;
  pagesFetched: number;
  maxPages?: number;
}): MessageJumpStep {
  const { request, loaded, hasNextPage, pagesFetched, maxPages = MESSAGE_JUMP_MAX_PAGES } = input;
  const candidates = [
    ...new Set([request.anchorId, ...request.highlightIds].filter((x): x is string => !!x)),
  ];
  if (candidates.length === 0) return { kind: 'missing' };
  const have = new Set(loaded.map((m) => m.id));
  const preferred = candidates[0]!;
  if (have.has(preferred)) return { kind: 'scroll', targetId: preferred };

  const oldest = loaded[0];
  const pastWindow =
    !!request.notBefore &&
    !!oldest &&
    Number.isFinite(Date.parse(request.notBefore)) &&
    Date.parse(oldest.sentAt) < Date.parse(request.notBefore);
  if (hasNextPage && pagesFetched < maxPages && !pastWindow) return { kind: 'fetch' };

  const fallback = candidates.find((id) => have.has(id));
  return fallback ? { kind: 'scroll', targetId: fallback } : { kind: 'missing' };
}

// ---------- Dùng trong React ----------

export const messageJumpStore = createMessageJumpStore();

const emptySnapshot = (): MessageJumpState => EMPTY_MESSAGE_JUMP;

export function useMessageJump(): MessageJumpState {
  return useSyncExternalStore(messageJumpStore.subscribe, messageJumpStore.getSnapshot, emptySnapshot);
}

/** Yêu cầu khung chat cuộn tới tin (xem MessageJumpStore.requestJump). */
export function requestMessageJump(
  conversationId: string,
  anchorId: string | null,
  highlightIds: readonly string[],
  opts?: { notBefore?: string | null },
): number {
  return messageJumpStore.requestJump(conversationId, anchorId, highlightIds, opts);
}
