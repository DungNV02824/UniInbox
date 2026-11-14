// Gộp sự kiện `conversation.updated` dồn dập (đồng bộ lịch sử phát một sự kiện cho MỖI hội thoại) để
// danh sách chỉ render lại vài lần thay vì hàng trăm lần. Sự kiện lẻ vẫn áp dụng ngay (không trễ).
import type { ConversationSummary } from '@dezon/shared';

export interface ConversationBatcher {
  /** Nhận một hội thoại vừa đổi; bản tới sau của cùng hội thoại thay bản cũ đang chờ. */
  push(conv: ConversationSummary): void;
  /** Áp ngay mọi bản đang chờ. */
  flush(): void;
  /** Hủy hẹn giờ, bỏ bản đang chờ (khi ngắt realtime). */
  dispose(): void;
}

interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Throttle "đầu + cuối": sự kiện đầu tiên áp ngay rồi mở cửa sổ `windowMs`; các sự kiện trong cửa sổ
 * được gom (chống trùng theo id, giữ thứ tự tới) và áp một lần khi cửa sổ đóng.
 */
export function createConversationBatcher(
  apply: (convs: ConversationSummary[]) => void,
  windowMs = 200,
  timers: Timers = defaultTimers,
): ConversationBatcher {
  const pending = new Map<string, ConversationSummary>();
  let timer: unknown = null;

  const flush = () => {
    if (pending.size === 0) return;
    const convs = [...pending.values()];
    pending.clear();
    apply(convs);
  };

  const onWindowEnd = () => {
    timer = null;
    if (pending.size === 0) return;
    flush();
    // Vẫn còn dồn dập: mở cửa sổ mới để gom tiếp.
    timer = timers.set(onWindowEnd, windowMs);
  };

  return {
    push(conv) {
      if (timer === null) {
        apply([conv]);
        timer = timers.set(onWindowEnd, windowMs);
        return;
      }
      pending.delete(conv.id);
      pending.set(conv.id, conv);
    },
    flush,
    dispose() {
      if (timer !== null) timers.clear(timer);
      timer = null;
      pending.clear();
    },
  };
}

export interface KeyedDebouncer {
  /** Hẹn chạy cho `key` sau `delayMs`; gọi lại trong lúc chờ thì dời hẹn (chỉ chạy một lần). */
  push(key: string): void;
  /** Hủy mọi hẹn đang chờ. */
  dispose(): void;
}

/**
 * Debounce theo khóa: `conversation.updated` dồn dập của cùng một hội thoại chỉ tải lại hồ sơ khách một lần
 * (vd. bot vừa trả lời vừa điền thông tin khách ⇒ vài sự kiện liền nhau).
 */
export function createKeyedDebouncer(
  run: (key: string) => void,
  delayMs = 400,
  timers: Timers = defaultTimers,
): KeyedDebouncer {
  const pending = new Map<string, unknown>();
  return {
    push(key) {
      const prev = pending.get(key);
      if (prev !== undefined) timers.clear(prev);
      pending.set(
        key,
        timers.set(() => {
          pending.delete(key);
          run(key);
        }, delayMs),
      );
    },
    dispose() {
      for (const handle of pending.values()) timers.clear(handle);
      pending.clear();
    },
  };
}
