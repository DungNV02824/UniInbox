import { describe, expect, it } from 'vitest';
import {
  AI_TYPING_CLIENT_TIMEOUT_MS,
  aiTypingFor,
  aiTypingLabel,
  applyAiTyping,
  applyMessageToAiTyping,
  createAiTypingStore,
  EMPTY_AI_TYPING,
  nextAiTypingExpiry,
  pruneAiTyping,
  type AiTypingClock,
} from './ai-typing';

const on = (conversationId: string, chatbotName: string | null = 'Bot CTV') => ({
  conversationId,
  typing: true,
  chatbotName,
});
const off = (conversationId: string) => ({ conversationId, typing: false, chatbotName: null });

describe('reducer ai.typing', () => {
  it('bật theo hội thoại, tắt khi typing:false, giữ state cũ khi không đổi', () => {
    const s1 = applyAiTyping(EMPTY_AI_TYPING, on('c1'), 1000, 30_000);
    expect(s1.c1).toEqual({ chatbotName: 'Bot CTV', expiresAt: 31_000 });
    expect(applyAiTyping(s1, on('c1'), 1000, 30_000)).toBe(s1);
    // Phát lại typing:true ⇒ gia hạn.
    expect(applyAiTyping(s1, on('c1'), 5000, 30_000).c1!.expiresAt).toBe(35_000);
    const s2 = applyAiTyping(s1, off('c1'), 2000);
    expect(s2).toEqual({});
    expect(applyAiTyping(s2, off('c1'), 2000)).toBe(s2);
  });

  it('tên bot rỗng ⇒ null; mặc định hẹn 30 giây', () => {
    expect(AI_TYPING_CLIENT_TIMEOUT_MS).toBe(30_000);
    const s = applyAiTyping(EMPTY_AI_TYPING, on('c1', '  '), 0);
    expect(s.c1).toEqual({ chatbotName: null, expiresAt: 30_000 });
  });

  it('tin bot của hội thoại đó tắt chỉ báo; tin khách / hội thoại khác thì không', () => {
    const s = applyAiTyping(applyAiTyping(EMPTY_AI_TYPING, on('c1'), 0), on('c2'), 0);
    expect(applyMessageToAiTyping(s, { conversationId: 'c1', senderType: 'customer' })).toBe(s);
    expect(applyMessageToAiTyping(s, { conversationId: 'c1', senderType: 'agent' })).toBe(s);
    expect(Object.keys(applyMessageToAiTyping(s, { conversationId: 'c1', senderType: 'bot' }))).toEqual([
      'c2',
    ]);
    expect(applyMessageToAiTyping(s, { conversationId: 'c9', senderType: 'bot' })).toBe(s);
  });

  it('prune / mốc gần nhất / tra cứu bỏ mục quá hạn', () => {
    const s = applyAiTyping(applyAiTyping(EMPTY_AI_TYPING, on('c1'), 0, 10), on('c2'), 0, 50);
    expect(nextAiTypingExpiry(s)).toBe(10);
    expect(nextAiTypingExpiry(EMPTY_AI_TYPING)).toBeNull();
    expect(pruneAiTyping(s, 5)).toBe(s);
    expect(Object.keys(pruneAiTyping(s, 10))).toEqual(['c2']);
    expect(aiTypingFor(s, 'c1', 9)).not.toBeNull();
    expect(aiTypingFor(s, 'c1', 10)).toBeNull();
    expect(aiTypingFor(s, 'zz', 0)).toBeNull();
  });

  it('nhãn', () => {
    expect(aiTypingLabel(null)).toBe('AI đang soạn tin…');
    expect(aiTypingLabel(' ')).toBe('AI đang soạn tin…');
    expect(aiTypingLabel('Bot CTV')).toBe('Bot CTV đang soạn tin…');
  });
});

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: AiTypingClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (h) => void timers.delete(h as number),
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  };
  return { clock, advance, pending: () => timers.size };
}

describe('createAiTypingStore', () => {
  it('tự tắt sau thời gian chờ và báo listener', () => {
    const { clock, advance, pending } = fakeClock();
    const store = createAiTypingStore({ clock, timeoutMs: 30_000 });
    let calls = 0;
    const unsub = store.subscribe(() => (calls += 1));
    store.handleTyping(on('c1'));
    expect(calls).toBe(1);
    expect(store.getSnapshot().c1).toBeDefined();
    advance(29_999);
    expect(store.getSnapshot().c1).toBeDefined();
    advance(1);
    expect(store.getSnapshot()).toEqual({});
    expect(calls).toBe(2);
    expect(pending()).toBe(0);
    unsub();
  });

  it('typing:false, tin bot, clearAll đều tắt và hủy hẹn giờ', () => {
    const { clock, pending } = fakeClock();
    const store = createAiTypingStore({ clock });
    store.handleTyping(on('c1'));
    store.handleTyping(off('c1'));
    expect(store.getSnapshot()).toEqual({});
    expect(pending()).toBe(0);

    store.handleTyping(on('c1'));
    store.handleMessage({ conversationId: 'c1', senderType: 'bot' });
    expect(store.getSnapshot()).toEqual({});

    store.handleTyping(on('c1'));
    store.handleTyping(on('c2'));
    store.clearAll();
    expect(store.getSnapshot()).toEqual({});
    expect(pending()).toBe(0);
  });

  it('gia hạn khi nhận lại typing:true; nhiều hội thoại hết hạn lần lượt', () => {
    const { clock, advance } = fakeClock();
    const store = createAiTypingStore({ clock, timeoutMs: 1000 });
    store.handleTyping(on('c1'));
    advance(600);
    store.handleTyping(on('c2'));
    store.handleTyping(on('c1')); // c1 gia hạn tới 1600
    advance(500); // 1100
    expect(Object.keys(store.getSnapshot()).sort()).toEqual(['c1', 'c2']);
    advance(500); // 1600: cả hai hết hạn
    expect(store.getSnapshot()).toEqual({});
  });

  it('dispose hủy hẹn giờ', () => {
    const { clock, pending } = fakeClock();
    const store = createAiTypingStore({ clock });
    store.handleTyping(on('c1'));
    store.dispose();
    expect(pending()).toBe(0);
  });
});
