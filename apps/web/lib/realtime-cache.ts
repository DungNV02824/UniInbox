// Đưa sự kiện realtime / kết quả thao tác vào cache TanStack Query.
import type { QueryClient } from '@tanstack/react-query';
import type {
  ConversationDetail,
  ConversationSummary,
  MessageCreatedPayload,
  MessageUpdatedPayload,
} from '@dezon/shared';
import type { ConversationFilters } from '@/lib/inbox-api';
import {
  applyConversationsToList,
  applyConversationToList,
  mergeSummaryIntoDetail,
  patchContactTagsInDetail,
  patchContactTagsInList,
  patchConversationsInList,
  updateExistingMessage,
  upsertMessage,
  type ConversationsData,
  type MessagesData,
  type Viewer,
} from '@/lib/inbox-cache';
import { inboxKeys } from '@/lib/inbox-keys';

/** Cập nhật mọi danh sách hội thoại đang có trong cache (mỗi bộ lọc một danh sách) + chi tiết. */
export function applyConversationUpdate(qc: QueryClient, conv: ConversationSummary, viewer: Viewer): void {
  for (const [key] of qc.getQueriesData<ConversationsData>({ queryKey: inboxKeys.lists() })) {
    const filters = (key[2] ?? {}) as ConversationFilters;
    qc.setQueryData<ConversationsData>(key, (old) => applyConversationToList(old, conv, filters, viewer));
  }
  qc.setQueryData<ConversationDetail>(inboxKeys.detail(conv.id), (old) => mergeSummaryIntoDetail(old, conv));
}

/** Như `applyConversationUpdate` cho cả loạt hội thoại (gộp sự kiện dồn dập khi đồng bộ lịch sử). */
export function applyConversationUpdates(
  qc: QueryClient,
  convs: readonly ConversationSummary[],
  viewer: Viewer,
): void {
  if (convs.length === 0) return;
  if (convs.length === 1) return applyConversationUpdate(qc, convs[0]!, viewer);
  for (const [key] of qc.getQueriesData<ConversationsData>({ queryKey: inboxKeys.lists() })) {
    const filters = (key[2] ?? {}) as ConversationFilters;
    qc.setQueryData<ConversationsData>(key, (old) => applyConversationsToList(old, convs, filters, viewer));
  }
  for (const conv of convs) {
    qc.setQueryData<ConversationDetail>(inboxKeys.detail(conv.id), (old) =>
      mergeSummaryIntoDetail(old, conv),
    );
  }
}

/**
 * Sự kiện tin tới khi khung chat đang tải LẦN ĐẦU (chưa có dữ liệu): setQueryData bỏ qua, còn bản đang
 * tải có thể đã chụp trước tin này → hủy và tải lại. (Đã có dữ liệu mà đang tải lại thì
 * `mergeFetchedMessages` giữ tin/trạng thái từ socket nên không cần.)
 */
function reloadIfFirstLoad(qc: QueryClient, conversationId: string): void {
  const queryKey = inboxKeys.messages(conversationId);
  const state = qc.getQueryState(queryKey);
  if (!state || state.data !== undefined || state.fetchStatus !== 'fetching') return;
  void qc
    .cancelQueries({ queryKey, exact: true })
    .then(() => qc.refetchQueries({ queryKey, exact: true }))
    .catch(() => undefined);
}

/** Chỉ đưa tin mới vào khung chat (phần hội thoại đi qua bộ gộp `conversation-batch`). */
export function applyNewMessage(qc: QueryClient, message: MessageCreatedPayload['message']): void {
  reloadIfFirstLoad(qc, message.conversationId);
  qc.setQueryData<MessagesData>(inboxKeys.messages(message.conversationId), (old) =>
    upsertMessage(old, message),
  );
}

export function applyMessageCreated(qc: QueryClient, payload: MessageCreatedPayload, viewer: Viewer): void {
  applyNewMessage(qc, payload.message);
  applyConversationUpdate(qc, payload.conversation, viewer);
}

export function applyMessageUpdated(qc: QueryClient, payload: MessageUpdatedPayload): void {
  reloadIfFirstLoad(qc, payload.message.conversationId);
  qc.setQueryData<MessagesData>(inboxKeys.messages(payload.message.conversationId), (old) =>
    updateExistingMessage(old, payload.message),
  );
}

/** Đánh dấu đã đọc ngay trên giao diện (trước khi máy chủ xác nhận). */
export function markReadLocally(qc: QueryClient, conversationId: string): void {
  for (const [key] of qc.getQueriesData<ConversationsData>({ queryKey: inboxKeys.lists() })) {
    qc.setQueryData<ConversationsData>(key, (old) =>
      patchConversationsInList(
        old,
        (c) => c.id === conversationId,
        (c) => ({ ...c, unreadCount: 0 }),
      ),
    );
  }
  qc.setQueryData<ConversationDetail>(inboxKeys.detail(conversationId), (old) =>
    old ? { ...old, unreadCount: 0 } : old,
  );
}

/** Đổi tên khách trong mọi danh sách đã tải. */
export function renameContactLocally(qc: QueryClient, contactId: string, displayName: string): void {
  for (const [key] of qc.getQueriesData<ConversationsData>({ queryKey: inboxKeys.lists() })) {
    qc.setQueryData<ConversationsData>(key, (old) =>
      patchConversationsInList(
        old,
        (c) => c.contact.id === contactId,
        (c) => ({ ...c, contact: { ...c.contact, displayName } }),
      ),
    );
  }
}

/**
 * Đổi nhãn khách ngay trên giao diện: mọi danh sách + mọi chi tiết hội thoại của khách đó
 * (realtime `conversation.updated` sẽ gộp bản của máy chủ sau). Trả về hàm hoàn tác.
 */
export function setContactTagsLocally(qc: QueryClient, contactId: string, tags: string[]): () => void {
  const prevLists = qc.getQueriesData<ConversationsData>({ queryKey: inboxKeys.lists() });
  const prevDetails = qc.getQueriesData<ConversationDetail>({ queryKey: inboxKeys.details() });
  for (const [key] of prevLists) {
    qc.setQueryData<ConversationsData>(key, (old) => patchContactTagsInList(old, contactId, tags));
  }
  for (const [key] of prevDetails) {
    qc.setQueryData<ConversationDetail>(key, (old) => patchContactTagsInDetail(old, contactId, tags));
  }
  return () => {
    for (const [key, data] of prevLists) qc.setQueryData(key, data);
    for (const [key, data] of prevDetails) {
      if (data?.contact.id === contactId) qc.setQueryData(key, data);
    }
  };
}

/**
 * Sửa lạc quan một hội thoại trong chi tiết + mọi danh sách đã tải (không lọc lại; kết quả máy chủ
 * sẽ đi qua `applyConversationUpdate`). Trả về hàm hoàn tác (khôi phục bản chụp trước khi sửa).
 */
export function patchConversationEverywhere(
  qc: QueryClient,
  conversationId: string,
  patch: (c: ConversationSummary) => ConversationSummary,
): () => void {
  const detailKey = inboxKeys.detail(conversationId);
  const prevDetail = qc.getQueryData<ConversationDetail>(detailKey);
  const prevLists = qc.getQueriesData<ConversationsData>({ queryKey: inboxKeys.lists() });

  qc.setQueryData<ConversationDetail>(detailKey, (old) => (old ? { ...old, ...patch(old) } : old));
  for (const [key] of prevLists) {
    qc.setQueryData<ConversationsData>(key, (old) =>
      patchConversationsInList(old, (c) => c.id === conversationId, patch),
    );
  }

  return () => {
    if (prevDetail !== undefined) qc.setQueryData(detailKey, prevDetail);
    for (const [key, data] of prevLists) qc.setQueryData(key, data);
  };
}
