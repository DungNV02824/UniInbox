import { describe, expect, it, vi } from 'vitest';
import {
  createMessageJumpStore,
  EMPTY_MESSAGE_JUMP,
  MESSAGE_HIGHLIGHT_MS,
  MESSAGE_JUMP_MAX_PAGES,
  planMessageJump,
} from './message-jump';

function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    size: () => pending.size,
  };
}

describe('kho nhảy tới tin', () => {
  it('requestJump → finishJump(found) ⇒ làm nổi tin rồi tự tắt sau MESSAGE_HIGHLIGHT_MS', () => {
    const t = fakeTimers();
    const store = createMessageJumpStore(t.timers);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.getSnapshot()).toBe(EMPTY_MESSAGE_JUMP);

    const seq = store.requestJump('c-1', 'm-1', ['m-1', 'm-2', 'm-2', '']);
    const req = store.getSnapshot().request!;
    expect(req).toMatchObject({ seq, conversationId: 'c-1', anchorId: 'm-1', highlightIds: ['m-1', 'm-2'] });
    expect(listener).toHaveBeenCalledTimes(1);

    store.finishJump(seq, true);
    const s = store.getSnapshot();
    expect(s.request).toBeNull();
    expect(s.highlight?.conversationId).toBe('c-1');
    expect([...s.highlight!.ids]).toEqual(['m-1', 'm-2']);

    t.advance(MESSAGE_HIGHLIGHT_MS - 1);
    expect(store.getSnapshot().highlight).not.toBeNull();
    t.advance(1);
    expect(store.getSnapshot().highlight).toBeNull();
  });

  it('không thấy tin ⇒ bỏ yêu cầu, không làm nổi', () => {
    const store = createMessageJumpStore(fakeTimers().timers);
    const seq = store.requestJump('c-1', null, ['m-9']);
    store.finishJump(seq, false);
    expect(store.getSnapshot()).toEqual({ request: null, highlight: null });
  });

  it('bấm dòng khác ⇒ yêu cầu cũ bị thay, kết quả của yêu cầu cũ bị bỏ qua, tắt làm nổi cũ', () => {
    const t = fakeTimers();
    const store = createMessageJumpStore(t.timers);
    const first = store.requestJump('c-1', 'a', ['a']);
    store.finishJump(first, true);
    expect(store.getSnapshot().highlight).not.toBeNull();

    const second = store.requestJump('c-1', 'b', ['b']);
    expect(store.getSnapshot().highlight).toBeNull();
    expect(t.size()).toBe(0);
    const third = store.requestJump('c-1', 'c', ['c']);
    store.finishJump(second, true);
    expect(store.getSnapshot().request?.seq).toBe(third);
    expect(store.getSnapshot().highlight).toBeNull();
  });

  it('clear(conversationId) chỉ bỏ của hội thoại đó', () => {
    const store = createMessageJumpStore(fakeTimers().timers);
    store.requestJump('c-1', 'a', ['a']);
    const before = store.getSnapshot();
    store.clear('c-2');
    expect(store.getSnapshot()).toBe(before);
    store.clear('c-1');
    expect(store.getSnapshot().request).toBeNull();
  });
});

describe('planMessageJump', () => {
  const m = (id: string, sentAt = '2026-11-10T08:00:00.000Z') => ({ id, sentAt });
  const req = (anchorId: string | null, highlightIds: string[], notBefore: string | null = null) => ({
    anchorId,
    highlightIds,
    notBefore,
  });

  it('tin neo đã có ⇒ cuộn tới tin neo', () => {
    expect(
      planMessageJump({
        request: req('a', ['a', 'b']),
        loaded: [m('x'), m('a'), m('b')],
        hasNextPage: true,
        pagesFetched: 0,
      }),
    ).toEqual({ kind: 'scroll', targetId: 'a' });
  });

  it('chưa có tin neo, còn trang ⇒ tải thêm (dù tin dự phòng đã có)', () => {
    expect(
      planMessageJump({
        request: req('a', ['a', 'b']),
        loaded: [m('b')],
        hasNextPage: true,
        pagesFetched: 3,
      }),
    ).toEqual({ kind: 'fetch' });
  });

  it('hết trang / đủ số trang ⇒ tin dự phòng đầu tiên còn thấy, không có ⇒ missing', () => {
    const base = { request: req('a', ['a', 'b', 'c']), loaded: [m('c'), m('b')] };
    expect(planMessageJump({ ...base, hasNextPage: false, pagesFetched: 0 })).toEqual({
      kind: 'scroll',
      targetId: 'b',
    });
    expect(planMessageJump({ ...base, hasNextPage: true, pagesFetched: MESSAGE_JUMP_MAX_PAGES })).toEqual({
      kind: 'scroll',
      targetId: 'b',
    });
    expect(
      planMessageJump({ request: req('a', ['a']), loaded: [m('x')], hasNextPage: false, pagesFetched: 0 }),
    ).toEqual({ kind: 'missing' });
  });

  it('không có tin neo ⇒ dùng tin đầu của highlightIds làm tin ưu tiên', () => {
    expect(
      planMessageJump({
        request: req(null, ['p', 'q']),
        loaded: [m('q')],
        hasNextPage: true,
        pagesFetched: 0,
      }),
    ).toEqual({ kind: 'fetch' });
    expect(
      planMessageJump({
        request: req(null, ['p', 'q']),
        loaded: [m('p')],
        hasNextPage: true,
        pagesFetched: 0,
      }),
    ).toEqual({ kind: 'scroll', targetId: 'p' });
    expect(
      planMessageJump({ request: req(null, []), loaded: [m('p')], hasNextPage: true, pagesFetched: 0 }),
    ).toEqual({ kind: 'missing' });
  });

  it('đã tải qua mốc notBefore mà chưa thấy ⇒ thôi tải thêm', () => {
    const request = req('a', ['a'], '2026-11-07T00:00:00.000Z');
    expect(
      planMessageJump({
        request,
        loaded: [m('x', '2026-11-08T00:00:00.000Z')],
        hasNextPage: true,
        pagesFetched: 1,
      }),
    ).toEqual({ kind: 'fetch' });
    expect(
      planMessageJump({
        request,
        loaded: [m('x', '2026-11-06T23:59:00.000Z')],
        hasNextPage: true,
        pagesFetched: 1,
      }),
    ).toEqual({ kind: 'missing' });
  });
});
