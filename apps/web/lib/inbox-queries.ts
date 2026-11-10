'use client';

// Hook dữ liệu của hộp thư (TanStack Query) + gửi tin lạc quan.
import { useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ContactDetail,
  ConversationDetail,
  MessageAttachmentDto,
  SendMessageRequest,
  UpdateContactRequest,
  UpdateConversationRequest,
} from '@dezon/shared';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { channelsRefetchInterval } from '@/lib/channel-sync';
import {
  channelsApi,
  inboxApi,
  looksLikeContactDetail,
  looksLikeConversation,
  normalizeFilters,
  type ConversationFilters,
} from '@/lib/inbox-api';
import {
  markFetchedPage,
  mergeFetchedMessages,
  patchTempMessage,
  resolveOptimistic,
  TEMP_ID_PREFIX,
  upsertMessage,
  type ChatMessage,
  type MessagesData,
} from '@/lib/inbox-cache';
import { channelsKey, directoryKey, inboxKeys } from '@/lib/inbox-keys';
import {
  applyConversationUpdate,
  markReadLocally,
  renameContactLocally,
  setContactTagsLocally,
} from '@/lib/realtime-cache';

/**
 * Chu kỳ làm mới dữ liệu chứa URL ký S3 (ảnh/tệp/avatar). URL do API ký sống MEDIA_SIGNED_URL_TTL_SEC
 * (mặc định 3600s); làm mới mỗi 20 phút nên mọi URL đang hiển thị còn hạn ≥ 40 phút.
 * Giả định TTL > 20 phút (ghi trong DECISIONS.md).
 */
export const SIGNED_URL_REFRESH_MS = 20 * 60_000;

export function useConversations(filters: ConversationFilters) {
  const normalized = normalizeFilters(filters);
  return useInfiniteQuery({
    queryKey: inboxKeys.list(normalized),
    queryFn: ({ pageParam }) => inboxApi.listConversations(normalized, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: SIGNED_URL_REFRESH_MS,
  });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: inboxKeys.detail(id ?? ''),
    queryFn: () => inboxApi.getConversation(id!),
    enabled: !!id,
    refetchInterval: SIGNED_URL_REFRESH_MS,
  });
}

export function useMessages(id: string | undefined) {
  return useInfiniteQuery({
    queryKey: inboxKeys.messages(id ?? ''),
    queryFn: async ({ pageParam }) => markFetchedPage(await inboxApi.listMessages(id!, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!id,
    // Socket giữ tin luôn mới; vẫn tải lại định kỳ (và khi quay lại tab sau lâu) để URL ký không hết
    // hạn, và khi reconnect (invalidate). Lần tải lại gộp với cache, không làm mất tin socket/tin tạm.
    structuralSharing: mergeFetchedMessages,
    staleTime: SIGNED_URL_REFRESH_MS,
    refetchInterval: SIGNED_URL_REFRESH_MS,
    refetchOnWindowFocus: true,
  });
}

/** `poll`: tự tải lại (5s khi có kênh đang đồng bộ lịch sử, 60s khi không) — dùng ở trang Kênh. */
export function useChannels({ poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: channelsKey,
    queryFn: () => channelsApi.list(),
    staleTime: poll ? 0 : 60_000,
    refetchInterval: poll ? (query) => channelsRefetchInterval(query.state.data) : false,
  });
}

export function useDirectory() {
  return useQuery({ queryKey: directoryKey, queryFn: () => inboxApi.userDirectory(), staleTime: 5 * 60_000 });
}

export function errorText(err: unknown, fallback = 'Có lỗi xảy ra. Vui lòng thử lại.'): string {
  return err instanceof ApiError ? err.message : fallback;
}

function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Gửi tin lạc quan: hiện tin tạm "Đang gửi" ngay, thay bằng tin thật khi có phản hồi/sự kiện socket. */
export function useSendMessage(conversationId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();

  const deliver = useCallback(
    async (clientId: string, body: SendMessageRequest) => {
      try {
        const res = await inboxApi.sendMessage(conversationId, body);
        qc.setQueryData<MessagesData>(inboxKeys.messages(conversationId), (old) =>
          resolveOptimistic(old, clientId, res.messages),
        );
        return true;
      } catch (err) {
        const message = errorText(err, 'Gửi tin thất bại. Vui lòng thử lại.');
        qc.setQueryData<MessagesData>(inboxKeys.messages(conversationId), (old) =>
          patchTempMessage(old, clientId, { status: 'failed', error: message }),
        );
        if (err instanceof ApiError && err.status === 422) {
          toast({ title: 'Không gửi được tin', description: message, variant: 'destructive' });
          // Cửa sổ gửi/trạng thái kênh có thể đã đổi: tải lại thông tin hội thoại.
          void qc.invalidateQueries({ queryKey: inboxKeys.detail(conversationId) });
        } else {
          toast({ title: 'Gửi tin thất bại', description: message, variant: 'destructive' });
        }
        return false;
      }
    },
    [conversationId, qc, toast],
  );

  const send = useCallback(
    (input: {
      text?: string;
      attachments: SendMessageRequest['attachments'];
      preview: MessageAttachmentDto[];
    }) => {
      const clientId = newClientId();
      const now = new Date().toISOString();
      const body: SendMessageRequest = {
        text: input.text,
        attachments: input.attachments,
        clientId,
      };
      const temp: ChatMessage = {
        id: `${TEMP_ID_PREFIX}${clientId}`,
        conversationId,
        senderType: 'agent',
        senderUser: user ? { id: user.id, name: user.name } : null,
        senderLabel: null,
        text: input.text ?? null,
        attachments: input.preview,
        status: 'queued',
        error: null,
        sentAt: now,
        createdAt: now,
        clientId,
        pending: body,
      };
      qc.setQueryData<MessagesData>(inboxKeys.messages(conversationId), (old) => upsertMessage(old, temp));
      return deliver(clientId, body);
    },
    [conversationId, deliver, qc, user],
  );

  /**
   * Gửi lại tin lạc quan bị lỗi với CÙNG clientId. Máy chủ chống trùng theo (hội thoại, clientId): nếu lần
   * trước thực ra đã tới máy chủ (chỉ mất phản hồi / đẩy job lỗi), nhận lại đúng các tin cũ, không tạo bản thứ hai.
   */
  const retry = useCallback(
    (msg: ChatMessage) => {
      if (!msg.pending || !msg.clientId) return;
      qc.setQueryData<MessagesData>(inboxKeys.messages(conversationId), (old) =>
        patchTempMessage(old, msg.clientId!, { status: 'queued', error: null }),
      );
      void deliver(msg.clientId, msg.pending);
    },
    [conversationId, deliver, qc],
  );

  return { send, retry };
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useCallback(
    async (conversationId: string) => {
      markReadLocally(qc, conversationId);
      try {
        await inboxApi.markRead(conversationId);
      } catch {
        void qc.invalidateQueries({ queryKey: inboxKeys.detail(conversationId) });
      }
    },
    [qc],
  );
}

export function useUpdateConversation(conversationId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (body: UpdateConversationRequest) => inboxApi.updateConversation(conversationId, body),
    onSuccess: (data) => {
      if (looksLikeConversation(data) && user) applyConversationUpdate(qc, data, user);
      void qc.invalidateQueries({ queryKey: inboxKeys.detail(conversationId) });
      void qc.invalidateQueries({ queryKey: inboxKeys.lists() });
    },
    onError: (err) =>
      toast({ title: 'Không cập nhật được hội thoại', description: errorText(err), variant: 'destructive' }),
  });
}

export function useUpdateContact(conversationId: string, contactId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: UpdateContactRequest) => inboxApi.updateContact(contactId, body),
    // Nhãn đổi ⇒ hiện ngay cạnh tên khách ở danh sách + đầu khung chat (không chờ realtime).
    onMutate: (body) => ({
      undoTags: body.tags ? setContactTagsLocally(qc, contactId, body.tags) : undefined,
    }),
    onSuccess: (data, body) => {
      qc.setQueryData<ConversationDetail>(inboxKeys.detail(conversationId), (old) => {
        if (!old) return old;
        const contactDetail: ContactDetail = looksLikeContactDetail(data)
          ? { ...old.contactDetail, ...data }
          : {
              ...old.contactDetail,
              ...(body.displayName !== undefined && { displayName: body.displayName }),
              ...(body.notes !== undefined && { notes: body.notes }),
              ...(body.tags !== undefined && { tags: body.tags }),
            };
        return {
          ...old,
          contact: { ...old.contact, displayName: contactDetail.displayName },
          contactDetail,
        };
      });
      if (body.displayName !== undefined) renameContactLocally(qc, contactId, body.displayName);
      if (body.tags !== undefined) {
        const saved = looksLikeContactDetail(data) && Array.isArray(data.tags) ? data.tags : body.tags;
        setContactTagsLocally(qc, contactId, saved);
      }
    },
    onError: (err, _body, ctx) => {
      if (ctx?.undoTags) {
        ctx.undoTags();
        void qc.invalidateQueries({ queryKey: inboxKeys.lists() });
      }
      toast({ title: 'Không lưu được thông tin khách', description: errorText(err), variant: 'destructive' });
    },
  });
}
