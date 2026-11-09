import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { ConversationDetail, MessageDto, Page } from '@dezon/shared';
import { conv, conversationsData, messagesData, msg } from './__fixtures__/inbox';
import {
  flattenMessages,
  markFetchedPage,
  mergeFetchedMessages,
  type ConversationsData,
  type MessagesData,
} from './inbox-cache';
import { inboxKeys } from './inbox-keys';
import {
  applyConversationUpdate,
  applyConversationUpdates,
  applyMessageCreated,
  applyMessageUpdated,
  markReadLocally,
} from './realtime-cache';

const agent = { id: 'u-a', role: 'agent' as const };

describe('realtime-cache', () => {
  it('message.created: chèn tin vào hội thoại đang mở và cập nhật mọi danh sách theo bộ lọc', () => {
    const qc = new QueryClient();
    const existing = msg();
    qc.setQueryData(inboxKeys.messages('c-1'), messagesData({ items: [existing] }));
    qc.setQueryData(inboxKeys.list({}), conversationsData({ items: [conv()], nextCursor: null }));
    qc.setQueryData(
      inboxKeys.list({ status: 'resolved' }),
      conversationsData({ items: [], nextCursor: null }),
    );

    const incoming = msg();
    const summary = conv({ unreadCount: 1, lastMessageAt: incoming.sentAt });
    applyMessageCreated(qc, { message: incoming, conversation: summary }, agent);
    applyMessageCreated(qc, { message: incoming, conversation: summary }, agent); // sự kiện lặp

    const messages = flattenMessages(qc.getQueryData<MessagesData>(inboxKeys.messages('c-1')));
    expect(messages.map((m) => m.id)).toEqual([existing.id, incoming.id]);
    const all = qc.getQueryData<ConversationsData>(inboxKeys.list({}))!;
    expect(all.pages[0]!.items).toHaveLength(1);
    expect(all.pages[0]!.items[0]!.unreadCount).toBe(1);
    expect(
      qc.getQueryData<ConversationsData>(inboxKeys.list({ status: 'resolved' }))!.pages[0]!.items,
    ).toEqual([]);
  });

  it('conversation.updated: phân công cho người khác → xóa khỏi danh sách của agent, cập nhật chi tiết', () => {
    const qc = new QueryClient();
    qc.setQueryData(inboxKeys.list({}), conversationsData({ items: [conv()], nextCursor: null }));
    const detail = {
      ...conv(),
      contactDetail: {
        id: 'k-1',
        displayName: 'Chị Lan',
        avatarUrl: null,
        phone: null,
        email: null,
        tags: [],
        notes: null,
        identities: [],
      },
    };
    qc.setQueryData(inboxKeys.detail('c-1'), detail);

    applyConversationUpdate(qc, conv({ assignedUser: { id: 'u-b', name: 'Bình' } }), agent);

    expect(qc.getQueryData<ConversationsData>(inboxKeys.list({}))!.pages[0]!.items).toEqual([]);
    expect(qc.getQueryData<ConversationDetail>(inboxKeys.detail('c-1'))!.assignedUser?.id).toBe('u-b');
  });

  it('đồng bộ lịch sử: nhiều conversation.updated gộp một lần cho mọi danh sách theo bộ lọc', () => {
    const qc = new QueryClient();
    qc.setQueryData(inboxKeys.list({}), conversationsData({ items: [], nextCursor: null }));
    qc.setQueryData(inboxKeys.list({ unread: true }), conversationsData({ items: [], nextCursor: null }));
    const convs = [
      conv({ id: 's1', lastMessageAt: '2026-11-01T08:00:00.000Z' }),
      conv({ id: 's2', lastMessageAt: '2026-11-04T08:00:00.000Z', unreadCount: 2 }),
    ];
    applyConversationUpdates(qc, convs, agent);
    const all = qc.getQueryData<ConversationsData>(inboxKeys.list({}))!;
    expect(all.pages[0]!.items.map((c) => c.id)).toEqual(['s2', 's1']);
    const unread = qc.getQueryData<ConversationsData>(inboxKeys.list({ unread: true }))!;
    expect(unread.pages[0]!.items.map((c) => c.id)).toEqual(['s2']);
  });

  it('markReadLocally: về 0 ở danh sách và chi tiết', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      inboxKeys.list({}),
      conversationsData({ items: [conv({ unreadCount: 3 })], nextCursor: null }),
    );
    markReadLocally(qc, 'c-1');
    expect(qc.getQueryData<ConversationsData>(inboxKeys.list({}))!.pages[0]!.items[0]!.unreadCount).toBe(0);
  });

  describe('sự kiện tới trong lúc khung chat đang tải', () => {
    /** Máy chủ giả: mỗi GET chụp danh sách hiện tại rồi chờ `releaseAll()` mới trả về. */
    function setupServer(initial: MessageDto[]) {
      const server = { items: [...initial] };
      const releases: (() => void)[] = [];
      let calls = 0;
      const qc = new QueryClient();
      const observer = new InfiniteQueryObserver(qc, {
        queryKey: inboxKeys.messages('c-1'),
        queryFn: async () => {
          calls += 1;
          const snapshot: Page<MessageDto> = { items: [...server.items], nextCursor: null };
          await new Promise<void>((r) => releases.push(r));
          return markFetchedPage(snapshot);
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: () => undefined,
        structuralSharing: mergeFetchedMessages,
      });
      const unsubscribe = observer.subscribe(() => {});
      const releaseAll = async () => {
        while (releases.length) releases.shift()!();
        await new Promise((r) => setTimeout(r, 0));
      };
      return { qc, server, releaseAll, unsubscribe, calls: () => calls };
    }
    const read = (qc: QueryClient) =>
      flattenMessages(qc.getQueryData<MessagesData>(inboxKeys.messages('c-1')));
    const tick = () => new Promise((r) => setTimeout(r, 0));

    it('tải lần đầu: tin socket tới trước phản hồi GET (bản chụp thiếu tin) → hủy và tải lại, không mất tin', async () => {
      const old = msg();
      const { qc, server, releaseAll, unsubscribe, calls } = setupServer([old]);
      const incoming = msg();
      server.items.push(incoming);
      applyMessageCreated(qc, { message: incoming, conversation: conv() }, agent);
      await tick();
      await releaseAll();
      await releaseAll();
      expect(calls()).toBe(2);
      expect(read(qc).map((m) => m.id)).toEqual([old.id, incoming.id]);
      unsubscribe();
    });

    it('tải lại (đã có dữ liệu): tin/trạng thái từ socket trong lúc tải được giữ', async () => {
      const mine = msg({ senderType: 'agent', status: 'queued' });
      const { qc, server, releaseAll, unsubscribe } = setupServer([mine]);
      await releaseAll();
      void qc.refetchQueries({ queryKey: inboxKeys.messages('c-1') });
      await tick();
      const incoming = msg();
      server.items.push(incoming);
      applyMessageCreated(qc, { message: incoming, conversation: conv() }, agent);
      applyMessageUpdated(qc, { message: { ...mine, status: 'sent' } });
      await releaseAll();
      const flat = read(qc);
      expect(flat.map((m) => m.id)).toEqual([mine.id, incoming.id]);
      expect(flat[0]!.status).toBe('sent');
      unsubscribe();
    });
  });
});
