import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from '@dezon/shared';
import { conv } from './__fixtures__/inbox';
import { createConversationBatcher } from './conversation-batch';

/** Hẹn giờ giả: chạy tay bằng `tick()`. */
function fakeTimers() {
  let fn: (() => void) | null = null;
  return {
    timers: {
      set: (f: () => void) => {
        fn = f;
        return 1;
      },
      clear: () => {
        fn = null;
      },
    },
    tick() {
      const f = fn;
      fn = null;
      f?.();
    },
    armed: () => fn !== null,
  };
}

describe('createConversationBatcher', () => {
  it('sự kiện lẻ áp ngay; sự kiện dồn dập được gom, chống trùng theo id, giữ thứ tự tới', () => {
    const calls: string[][] = [];
    const t = fakeTimers();
    const b = createConversationBatcher((cs) => calls.push(cs.map((c) => c.id)), 200, t.timers);

    b.push(conv({ id: 'a' }));
    expect(calls).toEqual([['a']]);

    b.push(conv({ id: 'b' }));
    b.push(conv({ id: 'c' }));
    b.push(conv({ id: 'b', unreadCount: 5 }));
    expect(calls).toHaveLength(1);

    t.tick();
    expect(calls[1]).toEqual(['c', 'b']);
    // Vừa có đợt gom → mở cửa sổ mới; hết cửa sổ mà không có gì thì đóng.
    expect(t.armed()).toBe(true);
    t.tick();
    expect(t.armed()).toBe(false);
    expect(calls).toHaveLength(2);

    b.push(conv({ id: 'd' }));
    expect(calls[2]).toEqual(['d']);
  });

  it('bản tới sau của cùng hội thoại thắng', () => {
    const got: ConversationSummary[][] = [];
    const t = fakeTimers();
    const b = createConversationBatcher((cs) => got.push(cs), 200, t.timers);
    b.push(conv({ id: 'x' }));
    b.push(conv({ id: 'y', unreadCount: 1 }));
    b.push(conv({ id: 'y', unreadCount: 2 }));
    b.flush();
    expect(got[1]!.map((c) => c.unreadCount)).toEqual([2]);
  });

  it('dispose bỏ bản đang chờ và hủy hẹn giờ', () => {
    const calls: string[][] = [];
    const t = fakeTimers();
    const b = createConversationBatcher((cs) => calls.push(cs.map((c) => c.id)), 200, t.timers);
    b.push(conv({ id: 'a' }));
    b.push(conv({ id: 'b' }));
    b.dispose();
    expect(t.armed()).toBe(false);
    b.flush();
    expect(calls).toEqual([['a']]);
  });
});
