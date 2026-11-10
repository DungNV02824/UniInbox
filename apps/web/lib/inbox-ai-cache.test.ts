// Cache hộp thư với các trường Chatbot AI (chatbot, aiPausedUntil, handoff) và bộ lọc "AI đang lo".
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { ConversationDetail } from '@dezon/shared';
import { conv, conversationsData } from './__fixtures__/inbox';
import { withChatbot } from './inbox-ai';
import {
  applyConversationToList,
  matchesFilters,
  mergeSummaryIntoDetail,
  type ConversationsData,
} from './inbox-cache';
import { inboxKeys } from './inbox-keys';
import { applyConversationUpdate, patchConversationEverywhere } from './realtime-cache';

const admin = { id: 'u-admin', role: 'admin' as const };
const BOT = { id: 'b-1', name: 'Tư vấn sofa' };
const HANDOFF = {
  reasonCode: 'complaint' as const,
  summary: 'Khách phàn nàn giao chậm',
  at: '2026-11-09T07:59:00.000Z',
  acknowledgedBy: null,
};

function detail(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  const base = conv({ contact: { ...conv().contact, tags: ['vip'] } });
  return {
    ...base,
    contactDetail: {
      ...base.contact,
      phone: '0900000000',
      email: null,
      tags: ['vip'],
      notes: 'ghi chú',
      identities: [],
    },
    ...overrides,
  };
}

const listItems = (data: ConversationsData | undefined) => data?.pages.flatMap((p) => p.items) ?? [];

describe('bộ lọc "AI đang lo" trong cache danh sách', () => {
  it('matchesFilters xét aiState', () => {
    expect(matchesFilters(conv({ chatbot: BOT, aiMode: 'auto' }), { aiState: 'handled' }, admin)).toBe(true);
    expect(matchesFilters(conv({ chatbot: BOT, aiMode: 'off' }), { aiState: 'handled' }, admin)).toBe(false);
    expect(matchesFilters(conv(), {}, admin)).toBe(true);
  });

  it('tắt bot ⇒ hội thoại rời danh sách "AI đang lo"; bật ⇒ vào lại', () => {
    const on = conv({ chatbot: BOT, aiMode: 'auto' });
    const data = conversationsData({ items: [on], nextCursor: null });
    const off = applyConversationToList(data, withChatbot(on, null), { aiState: 'handled' }, admin);
    expect(listItems(off)).toHaveLength(0);
    const back = applyConversationToList(off, on, { aiState: 'handled' }, admin);
    expect(listItems(back).map((c) => c.id)).toEqual(['c-1']);
  });

  it('chuyển người (pending_human) ⇒ vào danh sách "Cần người"', () => {
    const data = conversationsData({ items: [], nextCursor: null });
    const handed = conv({ status: 'pending_human', aiMode: 'off', chatbot: BOT, handoff: HANDOFF });
    const next = applyConversationToList(data, handed, { status: 'pending_human' }, admin);
    expect(listItems(next)[0]?.handoff).toEqual(HANDOFF);
  });
});

describe('mergeSummaryIntoDetail với trường AI', () => {
  it('ghi đè chatbot / aiPausedUntil / handoff (kể cả về null), giữ contactDetail', () => {
    const old = detail({ chatbot: BOT, aiPausedUntil: '2026-11-09T08:30:00.000Z', handoff: HANDOFF });
    const merged = mergeSummaryIntoDetail(
      old,
      conv({ chatbot: null, aiPausedUntil: null, handoff: null, contact: { ...old.contact, tags: ['vip'] } }),
    )!;
    expect(merged.chatbot).toBeNull();
    expect(merged.aiPausedUntil).toBeNull();
    expect(merged.handoff).toBeNull();
    expect(merged.contactDetail.tags).toEqual(['vip']);
  });

  it('bản tóm tắt thiếu trường AI (payload cũ) không xóa giá trị đang có', () => {
    const old = detail({ chatbot: BOT });
    expect(mergeSummaryIntoDetail(old, conv())!.chatbot).toEqual(BOT);
  });
});

describe('conversation.updated cập nhật trường AI ở mọi cache', () => {
  it('danh sách + chi tiết nhận chatbot, aiPausedUntil, handoff mới', () => {
    const qc = new QueryClient();
    qc.setQueryData(inboxKeys.list({}), conversationsData({ items: [conv()], nextCursor: null }));
    qc.setQueryData(inboxKeys.detail('c-1'), detail());

    const ack = { ...HANDOFF, acknowledgedBy: { id: 'u-a', name: 'An' } };
    const updated = conv({
      status: 'pending_human',
      chatbot: BOT,
      aiPausedUntil: '2026-11-09T08:30:00.000Z',
      handoff: ack,
    });
    applyConversationUpdate(qc, updated, admin);

    const row = listItems(qc.getQueryData<ConversationsData>(inboxKeys.list({})))[0]!;
    expect(row).toMatchObject({ chatbot: BOT, aiPausedUntil: updated.aiPausedUntil, handoff: ack });
    const d = qc.getQueryData<ConversationDetail>(inboxKeys.detail('c-1'))!;
    expect(d).toMatchObject({ chatbot: BOT, aiPausedUntil: updated.aiPausedUntil, handoff: ack });
    expect(d.contactDetail.phone).toBe('0900000000');
  });
});

describe('patchConversationEverywhere (cập nhật lạc quan)', () => {
  it('sửa chi tiết + mọi danh sách, hoàn tác khôi phục bản cũ', () => {
    const qc = new QueryClient();
    const original = conv();
    qc.setQueryData(inboxKeys.list({}), conversationsData({ items: [original], nextCursor: null }));
    qc.setQueryData(
      inboxKeys.list({ status: 'open' }),
      conversationsData({ items: [original], nextCursor: null }),
    );
    qc.setQueryData(inboxKeys.detail('c-1'), detail());

    const rollback = patchConversationEverywhere(qc, 'c-1', (c) => withChatbot(c, BOT));
    for (const filters of [{}, { status: 'open' as const }]) {
      const row = listItems(qc.getQueryData<ConversationsData>(inboxKeys.list(filters)))[0]!;
      expect(row).toMatchObject({ chatbot: BOT, aiMode: 'auto' });
    }
    const patched = qc.getQueryData<ConversationDetail>(inboxKeys.detail('c-1'))!;
    expect(patched).toMatchObject({ chatbot: BOT, aiMode: 'auto' });
    expect(patched.contactDetail.notes).toBe('ghi chú');

    rollback();
    expect(listItems(qc.getQueryData<ConversationsData>(inboxKeys.list({})))[0]).toEqual(original);
    expect(qc.getQueryData<ConversationDetail>(inboxKeys.detail('c-1'))!.chatbot).toBeUndefined();
  });
});
