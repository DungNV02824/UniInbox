import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from '@dezon/shared';
import { conv, conversationsData, messagesData, msg } from './__fixtures__/inbox';
import {
  applyConversationsToList,
  applyConversationToList,
  canView,
  flattenMessages,
  markFetchedPage,
  matchesFilters,
  mergeFetchedMessages,
  mergeSummaryIntoDetail,
  patchContactTagsInDetail,
  patchContactTagsInList,
  type MessagesData,
  patchTempMessage,
  resolveOptimistic,
  TEMP_ID_PREFIX,
  updateExistingMessage,
  upsertMessage,
  type ChatMessage,
} from './inbox-cache';

const admin = { id: 'u-admin', role: 'admin' as const };
const agent = { id: 'u-a', role: 'agent' as const };
const other = { id: 'u-b', name: 'Bình' };

const ids = (list: { id: string }[]) => list.map((m) => m.id);

describe('upsertMessage', () => {
  it('chèn tin mới vào cuối trang mới nhất, giữ số trang', () => {
    const older = [msg(), msg()];
    const newer = [msg(), msg()];
    const data = messagesData({ items: newer }, { items: older, nextCursor: null });
    const incoming = msg();
    const next = upsertMessage(data, incoming)!;
    expect(next.pages).toHaveLength(2);
    expect(ids(next.pages[1]!.items)).toEqual(ids(older));
    expect(ids(flattenMessages(next))).toEqual([...ids(older), ...ids(newer), incoming.id]);
  });

  it('chống trùng theo id (socket + phản hồi POST cùng một tin)', () => {
    const a = msg();
    const data = messagesData({ items: [a] });
    const once = upsertMessage(data, { ...a, status: 'sent' })!;
    const twice = upsertMessage(once, { ...a, status: 'delivered' })!;
    expect(flattenMessages(twice)).toHaveLength(1);
    expect(flattenMessages(twice)[0]!.status).toBe('delivered');
  });

  it('thay tin lạc quan bằng tin thật có cùng clientId', () => {
    const a = msg();
    const temp = msg({ id: `${TEMP_ID_PREFIX}abc`, clientId: 'abc', senderType: 'agent', status: 'queued' });
    const data = messagesData({ items: [a, temp] });
    const real = msg({ clientId: 'abc', senderType: 'agent', status: 'sent' });
    const list = flattenMessages(upsertMessage(data, real));
    expect(ids(list)).toEqual([a.id, real.id]);
  });

  it('không thay tin THẬT khác có cùng clientId (tin dài bị tách thành nhiều tin)', () => {
    const first = msg({ clientId: 'abc', senderType: 'agent', status: 'sent' });
    const data = messagesData({ items: [first] });
    const second = msg({ clientId: 'abc', senderType: 'agent', status: 'sent' });
    expect(ids(flattenMessages(upsertMessage(data, second)))).toEqual([first.id, second.id]);
  });

  it('tin lạc quan luôn nằm cuối dù giờ máy khách lệch', () => {
    const temp = msg({ id: `${TEMP_ID_PREFIX}x`, clientId: 'x', sentAt: '2020-01-01T00:00:00.000Z' });
    const data = messagesData({ items: [temp] });
    const incoming = msg();
    expect(ids(flattenMessages(upsertMessage(data, incoming)))).toEqual([incoming.id, temp.id]);
  });

  it('bỏ qua khi cache chưa có dữ liệu (hội thoại chưa mở)', () => {
    expect(upsertMessage(undefined, msg())).toBeUndefined();
  });
});

describe('updateExistingMessage / resolveOptimistic / patchTempMessage', () => {
  it('message.updated chỉ cập nhật tin đã có', () => {
    const a = msg({ senderType: 'agent', status: 'sent' });
    const data = messagesData({ items: [a] });
    expect(flattenMessages(updateExistingMessage(data, { ...a, status: 'seen' }))[0]!.status).toBe('seen');
    expect(updateExistingMessage(data, msg())).toBe(data);
  });

  it('phản hồi POST thay tin tạm bằng nhiều tin thật và không trùng với tin socket đã tới trước', () => {
    const temp = msg({ id: `${TEMP_ID_PREFIX}c1`, clientId: 'c1', status: 'queued' });
    const r1 = msg({ clientId: 'c1', senderType: 'agent', status: 'queued' });
    const r2 = msg({ clientId: 'c1', senderType: 'agent', status: 'queued' });
    // Socket đã đưa r1 vào (thay tin tạm), sau đó POST trả về [r1, r2].
    const afterSocket = upsertMessage(messagesData({ items: [temp] }), r1);
    const final = flattenMessages(resolveOptimistic(afterSocket, 'c1', [r1, r2]));
    expect(ids(final)).toEqual([r1.id, r2.id]);
  });

  it('phản hồi POST (queued) tới sau message.updated (failed) → giữ failed, không lùi về "Đang gửi"', () => {
    const temp = msg({ id: `${TEMP_ID_PREFIX}c3`, clientId: 'c3', status: 'queued' });
    const real = msg({ clientId: 'c3', senderType: 'agent', status: 'queued' });
    let data = upsertMessage(messagesData({ items: [temp] }), real); // socket message.created
    data = updateExistingMessage(data, { ...real, status: 'failed', error: 'Graph 551' }); // worker
    const final = flattenMessages(resolveOptimistic(data, 'c3', [real]));
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ id: real.id, status: 'failed', error: 'Graph 551' });
  });

  it('upsert không lùi trạng thái (message.created lặp tới sau message.updated)', () => {
    const a = msg({ senderType: 'agent', status: 'delivered' });
    const next = upsertMessage(messagesData({ items: [a] }), { ...a, status: 'queued', text: 'mới' });
    expect(flattenMessages(next)[0]).toMatchObject({ status: 'delivered', text: 'mới' });
  });

  it('đánh dấu tin tạm bị lỗi', () => {
    const temp = msg({ id: `${TEMP_ID_PREFIX}c2`, clientId: 'c2', status: 'queued' });
    const next = patchTempMessage(messagesData({ items: [temp] }), 'c2', {
      status: 'failed',
      error: 'Hết cửa sổ',
    });
    expect(flattenMessages(next)[0]).toMatchObject({ status: 'failed', error: 'Hết cửa sổ' });
  });
});

describe('mergeFetchedMessages (structuralSharing của query tin nhắn)', () => {
  const fetchedData = (...pages: { items: ChatMessage[]; nextCursor?: string | null }[]): MessagesData => {
    const data = messagesData(...pages);
    return { ...data, pages: data.pages.map((p) => markFetchedPage(p)) };
  };

  it('cập nhật thủ công (setQueryData, trang không đánh dấu) đi qua nguyên vẹn', () => {
    const temp = msg({ id: `${TEMP_ID_PREFIX}x`, clientId: 'x', status: 'queued' });
    const old = messagesData({ items: [temp] });
    const manual = messagesData({ items: [] });
    expect(mergeFetchedMessages(old, manual)).toBe(manual);
    expect(mergeFetchedMessages(undefined, manual)).toBe(manual);
  });

  it('tải lại giữ tin tạm/lỗi, tin socket tới trong lúc tải và trạng thái mới hơn; lấy bản mới từ máy chủ', () => {
    const a = msg({ senderType: 'agent', status: 'sent' });
    const viaSocket = msg();
    const temp = msg({ id: `${TEMP_ID_PREFIX}t`, clientId: 't', status: 'failed', error: 'x' });
    const cache = messagesData({ items: [{ ...a, status: 'seen' }, viaSocket, temp] });
    const snapshot = { ...a, text: 'url mới' }; // bản chụp: chưa có viaSocket, status cũ
    const merged = mergeFetchedMessages(cache, fetchedData({ items: [snapshot] })) as MessagesData;
    const flat = flattenMessages(merged);
    expect(ids(flat)).toEqual([a.id, viaSocket.id, temp.id]);
    expect(flat[0]).toMatchObject({ status: 'seen', text: 'url mới' });
  });

  it('bỏ tin cũ hơn phần vừa tải khi còn trang trước (thuộc trang chưa tải)', () => {
    const older = msg();
    const newer = msg();
    const cache = messagesData({ items: [older, newer], nextCursor: 'cur' });
    const merged = mergeFetchedMessages(cache, fetchedData({ items: [newer], nextCursor: 'cur' }));
    expect(ids(flattenMessages(merged as MessagesData))).toEqual([newer.id]);
  });

  it('không có gì mới → trả lại tham chiếu cũ (không render lại)', () => {
    const a = msg();
    const cache = messagesData({ items: [a] });
    expect(mergeFetchedMessages(cache, fetchedData({ items: [{ ...a }] }))).toBe(cache);
  });
});

describe('quyền xem', () => {
  it('admin xem tất cả; agent xem của mình hoặc chưa phân công', () => {
    expect(canView(conv({ assignedUser: other }), admin)).toBe(true);
    expect(canView(conv({ assignedUser: null }), agent)).toBe(true);
    expect(canView(conv({ assignedUser: { id: agent.id, name: 'A' } }), agent)).toBe(true);
    expect(canView(conv({ assignedUser: other }), agent)).toBe(false);
  });

  it('bộ lọc người phụ trách: me / none / id nhân viên', () => {
    const mine = conv({ assignedUser: { id: admin.id, name: 'A' } });
    expect(matchesFilters(mine, { assignee: 'me' }, admin)).toBe(true);
    expect(matchesFilters(mine, { assignee: 'none' }, admin)).toBe(false);
    expect(matchesFilters(conv({ assignedUser: other }), { assignee: other.id }, admin)).toBe(true);
    expect(matchesFilters(mine, { assignee: other.id }, admin)).toBe(false);
    expect(matchesFilters(conv(), { assignee: other.id }, admin)).toBe(false);
  });
});

describe('applyConversationToList', () => {
  const a = conv({ id: 'a', lastMessageAt: '2026-11-05T10:00:00.000Z' });
  const b = conv({ id: 'b', lastMessageAt: '2026-11-05T09:00:00.000Z' });
  const c = conv({ id: 'c', lastMessageAt: '2026-11-05T08:00:00.000Z' });

  it('đưa hội thoại có tin mới lên đầu, giữ số trang', () => {
    const data = conversationsData({ items: [a, b], nextCursor: 'x' }, { items: [c], nextCursor: null });
    const updated = { ...c, lastMessageAt: '2026-11-05T11:00:00.000Z', unreadCount: 1 };
    const next = applyConversationToList(data, updated, {}, agent)!;
    expect(next.pages).toHaveLength(2);
    expect(ids(next.pages.flatMap((p) => p.items))).toEqual(['c', 'a', 'b']);
    expect(next.pages[1]!.nextCursor).toBeNull();
  });

  it('xóa khỏi danh sách khi agent không còn quyền xem (phân công cho người khác)', () => {
    const data = conversationsData({ items: [a, b], nextCursor: null });
    const next = applyConversationToList(data, { ...a, assignedUser: other }, {}, agent)!;
    expect(ids(next.pages[0]!.items)).toEqual(['b']);
    // Admin vẫn thấy.
    const forAdmin = applyConversationToList(data, { ...a, assignedUser: other }, {}, admin)!;
    expect(ids(forAdmin.pages[0]!.items)).toEqual(['a', 'b']);
  });

  it('xóa khi không còn khớp bộ lọc, chèn khi bắt đầu khớp', () => {
    const data = conversationsData({ items: [a, b], nextCursor: null });
    const resolved = applyConversationToList(data, { ...a, status: 'resolved' }, { status: 'open' }, agent)!;
    expect(ids(resolved.pages[0]!.items)).toEqual(['b']);
    const mine = conversationsData({ items: [], nextCursor: null });
    const assigned = { ...c, assignedUser: { id: agent.id, name: 'A' } };
    expect(ids(applyConversationToList(mine, assigned, { assignee: 'me' }, agent)!.pages[0]!.items)).toEqual([
      'c',
    ]);
  });

  it('không chèn hội thoại cũ hơn phần đã tải khi còn trang sau', () => {
    const data = conversationsData({ items: [a, b], nextCursor: 'x' });
    expect(applyConversationToList(data, c, {}, agent)).toBe(data);
  });

  it('bộ lọc "Chưa đọc": giữ dòng vừa được đọc, không chèn hội thoại đã đọc', () => {
    const unreadA = { ...a, unreadCount: 2 };
    const data = conversationsData({ items: [unreadA], nextCursor: null });
    const read = applyConversationToList(data, { ...a, unreadCount: 0 }, { unread: true }, agent)!;
    expect(read.pages[0]!.items[0]!.unreadCount).toBe(0);
    expect(applyConversationToList(data, b, { unread: true }, agent)).toBe(data);
  });

  it('chống trùng: cập nhật tại chỗ hội thoại đã có', () => {
    const data = conversationsData({ items: [a, b], nextCursor: null });
    const next = applyConversationToList(data, { ...b, unreadCount: 3 }, {}, agent)!;
    expect(next.pages[0]!.items).toHaveLength(2);
    expect(next.pages[0]!.items.find((x) => x.id === 'b')!.unreadCount).toBe(3);
  });
});

describe('applyConversationsToList (đồng bộ lịch sử: nhiều hội thoại cùng lúc)', () => {
  const at = (h: number) => `2026-11-05T${String(h).padStart(2, '0')}:00:00.000Z`;

  it('chèn nhiều hội thoại mới và sắp đúng thứ tự tin cuối, giữ số trang', () => {
    const data = conversationsData({ items: [conv({ id: 'x', lastMessageAt: at(12) })], nextCursor: null });
    const incoming = [5, 14, 9, 1].map((h) => conv({ id: `n${h}`, lastMessageAt: at(h) }));
    const next = applyConversationsToList(data, incoming, {}, admin)!;
    expect(next.pages).toHaveLength(1);
    expect(ids(next.pages[0]!.items)).toEqual(['n14', 'x', 'n9', 'n5', 'n1']);
  });

  it('danh sách đang rỗng cũng nhận hội thoại đồng bộ về', () => {
    const data = conversationsData({ items: [], nextCursor: null });
    const next = applyConversationsToList(data, [conv({ id: 'a' }), conv({ id: 'b' })], {}, admin)!;
    expect(next.pages[0]!.items).toHaveLength(2);
  });

  it('còn trang sau: bỏ hội thoại cũ hơn phần đã tải (có khi cuộn tới), chèn hội thoại mới hơn', () => {
    const data = conversationsData({ items: [conv({ id: 'x', lastMessageAt: at(10) })], nextCursor: 'c' });
    const next = applyConversationsToList(
      data,
      [conv({ id: 'old', lastMessageAt: at(2) }), conv({ id: 'new', lastMessageAt: at(11) })],
      {},
      admin,
    )!;
    expect(ids(next.pages[0]!.items)).toEqual(['new', 'x']);
    expect(next.pages[0]!.nextCursor).toBe('c');
  });

  it('bộ lọc "Chưa đọc": chỉ chèn hội thoại có tin chưa đọc', () => {
    const data = conversationsData({ items: [], nextCursor: null });
    const next = applyConversationsToList(
      data,
      [conv({ id: 'r', unreadCount: 0 }), conv({ id: 'u', unreadCount: 3 })],
      { unread: true },
      admin,
    )!;
    expect(ids(next.pages[0]!.items)).toEqual(['u']);
  });

  it('không có gì để áp → trả lại tham chiếu cũ', () => {
    const data = conversationsData({ items: [], nextCursor: null });
    expect(applyConversationsToList(data, [], {}, admin)).toBe(data);
    expect(applyConversationsToList(undefined, [conv()], {}, admin)).toBeUndefined();
  });
});

describe('mergeSummaryIntoDetail', () => {
  it('gộp tóm tắt mới, giữ contactDetail và đồng bộ tên/ảnh khách', () => {
    const detail = {
      ...conv(),
      contactDetail: {
        id: 'k-1',
        displayName: 'Chị Lan',
        avatarUrl: null,
        phone: null,
        email: null,
        tags: ['vip'],
        notes: 'ghi chú',
        identities: [],
      },
    };
    const merged = mergeSummaryIntoDetail(
      detail,
      conv({ unreadCount: 4, contact: { id: 'k-1', displayName: 'Lan Anh', avatarUrl: 'u', tags: ['vip'] } }),
    )!;
    expect(merged.unreadCount).toBe(4);
    expect(merged.contactDetail).toMatchObject({
      displayName: 'Lan Anh',
      avatarUrl: 'u',
      tags: ['vip'],
      notes: 'ghi chú',
    });
    expect(mergeSummaryIntoDetail(detail, conv({ id: 'other' }))).toBe(detail);
  });
});

describe('đổi nhãn khách trong cache', () => {
  const detailOf = (c = conv()) => ({
    ...c,
    contactDetail: {
      id: c.contact.id,
      displayName: c.contact.displayName,
      avatarUrl: null,
      phone: null,
      email: null,
      tags: ['cũ'],
      notes: null,
      identities: [],
    },
  });

  it('patchContactTagsInList: sửa mọi hội thoại của khách (mọi trang), giữ nguyên khách khác', () => {
    const a = conv({ id: 'c-1', contact: { id: 'k-1', displayName: 'Lan', avatarUrl: null, tags: [] } });
    const b = conv({ id: 'c-2', contact: { id: 'k-2', displayName: 'Hà', avatarUrl: null, tags: ['x'] } });
    const a2 = conv({ id: 'c-3', contact: { id: 'k-1', displayName: 'Lan', avatarUrl: null, tags: [] } });
    const data = conversationsData({ items: [a, b], nextCursor: 'n' }, { items: [a2], nextCursor: null });
    const next = patchContactTagsInList(data, 'k-1', ['VIP'])!;
    expect(next.pages[0]!.items[0]!.contact.tags).toEqual(['VIP']);
    expect(next.pages[0]!.items[1]).toBe(b);
    expect(next.pages[1]!.items[0]!.contact.tags).toEqual(['VIP']);
    expect(patchContactTagsInList(undefined, 'k-1', ['VIP'])).toBeUndefined();
  });

  it('patchContactTagsInDetail: sửa cả contact lẫn contactDetail; khác khách thì trả nguyên', () => {
    const detail = detailOf();
    const next = patchContactTagsInDetail(detail, 'k-1', ['VIP', 'Sỉ'])!;
    expect(next.contact.tags).toEqual(['VIP', 'Sỉ']);
    expect(next.contactDetail.tags).toEqual(['VIP', 'Sỉ']);
    expect(patchContactTagsInDetail(detail, 'k-9', ['VIP'])).toBe(detail);
    expect(patchContactTagsInDetail(undefined, 'k-1', ['VIP'])).toBeUndefined();
  });

  it('mergeSummaryIntoDetail: đồng bộ nhãn từ tóm tắt; tóm tắt thiếu tags thì giữ nhãn cũ', () => {
    const detail = detailOf();
    const withTags = conv({ contact: { id: 'k-1', displayName: 'Chị Lan', avatarUrl: null, tags: ['VIP'] } });
    expect(mergeSummaryIntoDetail(detail, withTags)!.contactDetail.tags).toEqual(['VIP']);
    const legacy = conv({
      contact: { id: 'k-1', displayName: 'Chị Lan', avatarUrl: null } as ConversationSummary['contact'],
    });
    expect(mergeSummaryIntoDetail(detail, legacy)!.contactDetail.tags).toEqual(['cũ']);
  });
});
