'use client';

// Hook dữ liệu của tính năng Chatbot AI trong hộp thư: danh sách bot cho ô chọn,
// các thao tác (gắn bot, tiếp tục AI, nhận / xong / không đạt handoff) cập nhật lạc quan + báo lỗi bằng toast.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatbotRef, ConversationSummary, RejectHandoffRequest } from '@dezon/shared';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import {
  extractConversation,
  withAiResumed,
  withChatbot,
  withHandoffAcknowledged,
  withHandoffResolved,
} from '@/lib/inbox-ai';
import { AI_OUTAGE_REFETCH_MS, aiOutageResumedText, aiOutageStillDownText } from '@/lib/ai-outage';
import { aiOutageApi, inboxApi, looksLikeConversation } from '@/lib/inbox-api';
import { aiOutageKey, chatbotOptionsKey, inboxKeys } from '@/lib/inbox-keys';
import { errorText } from '@/lib/inbox-queries';
import { applyConversationUpdate, patchConversationEverywhere } from '@/lib/realtime-cache';
import { settingsKeys } from '@/lib/settings-api';

/** Bot cho ô chọn ở khung chat (đã gồm bot tắt nếu là admin; component tự lọc bot đang bật). */
export function useChatbotOptions(enabled = true) {
  return useQuery({
    queryKey: chatbotOptionsKey,
    queryFn: () => inboxApi.listChatbots(),
    staleTime: 60_000,
    enabled,
  });
}

interface AiActionOptions<V> {
  run: (vars: V) => Promise<unknown>;
  optimistic: (c: ConversationSummary, vars: V) => ConversationSummary;
  errorTitle: string;
}

function useConversationAiAction<V>(conversationId: string, opts: AiActionOptions<V>) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  return useMutation({
    mutationFn: opts.run,
    onMutate: async (vars: V) => {
      await qc.cancelQueries({ queryKey: inboxKeys.detail(conversationId), exact: true });
      return { rollback: patchConversationEverywhere(qc, conversationId, (c) => opts.optimistic(c, vars)) };
    },
    onError: (err, _vars, context) => {
      context?.rollback();
      toast({ title: opts.errorTitle, description: errorText(err), variant: 'destructive' });
    },
    onSuccess: (data) => {
      const conv = extractConversation(data, looksLikeConversation);
      if (conv && user) applyConversationUpdate(qc, conv, user);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: inboxKeys.detail(conversationId) });
      void qc.invalidateQueries({ queryKey: inboxKeys.lists() });
    },
  });
}

/** Gắn / bỏ chatbot cho hội thoại (null = Tắt). */
export function useSetConversationChatbot(conversationId: string) {
  return useConversationAiAction<ChatbotRef | null>(conversationId, {
    run: (bot) => inboxApi.setConversationChatbot(conversationId, bot?.id ?? null),
    optimistic: (c, bot) => withChatbot(c, bot),
    errorTitle: 'Không đổi được chatbot',
  });
}

export function useResumeAi(conversationId: string) {
  return useConversationAiAction<void>(conversationId, {
    run: () => inboxApi.resumeAi(conversationId),
    optimistic: (c) => withAiResumed(c),
    errorTitle: 'Không tiếp tục được AI',
  });
}

export function useAckHandoff(conversationId: string) {
  const { user } = useAuth();
  return useConversationAiAction<void>(conversationId, {
    run: () => inboxApi.ackHandoff(conversationId),
    optimistic: (c) => (user ? withHandoffAcknowledged(c, { id: user.id, name: user.name }) : c),
    errorTitle: 'Không nhận xử lý được',
  });
}

export function useResolveHandoff(conversationId: string) {
  return useConversationAiAction<void>(conversationId, {
    run: () => inboxApi.resolveHandoff(conversationId),
    optimistic: (c) => withHandoffResolved(c),
    errorTitle: 'Không trả lại cho AI được',
  });
}

/**
 * "Không đạt": AI soạn tin báo khách rồi gửi ngay (tin bot về qua socket). Không cập nhật lạc quan — banner Cần
 * người giữ nguyên; lỗi hiện trong hộp thoại (giữ lý do đã gõ) nên không bắn toast.
 */
export function useRejectHandoff(conversationId: string) {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (body: RejectHandoffRequest) => inboxApi.rejectHandoff(conversationId, body),
    onSuccess: (data) => {
      const conv = extractConversation(data, looksLikeConversation);
      if (conv && user) applyConversationUpdate(qc, conv, user);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: inboxKeys.detail(conversationId) });
      void qc.invalidateQueries({ queryKey: inboxKeys.lists() });
    },
  });
}

/**
 * Trạng thái "Bật lại AI": công tắc AI chung + số hội thoại chờ vì AI lỗi / khách chưa được trả lời. Tải lại mỗi
 * phút; RealtimeProvider còn invalidate khi có `conversation.updated` liên quan (xem aiOutageMayChange).
 */
export function useAiOutageStatus(enabled = true) {
  return useQuery({
    queryKey: aiOutageKey,
    queryFn: () => aiOutageApi.status(),
    staleTime: 30_000,
    refetchInterval: AI_OUTAGE_REFETCH_MS,
    enabled,
  });
}

/**
 * "Bật lại AI" (toàn hệ thống): máy chủ gọi thử AI rồi bật công tắc chung (nếu tắt), trả các hội thoại chờ cho bot
 * và đánh thức bot trả lời khách bị bỏ sót (worker xử lý). Thành công ⇒ toast + tải lại danh sách / chi tiết / công
 * tắc AI ở Cài đặt; lỗi (AI vẫn lỗi, không phải admin…) KHÔNG bắn toast — hộp thoại hiện lời máy chủ.
 */
export function useResumeAiOutage() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => aiOutageApi.resume(),
    onSuccess: (data) => {
      const stillDown = aiOutageStillDownText(data);
      toast({
        title: aiOutageResumedText(data),
        ...(stillDown ? { description: stillDown } : {}),
        variant: 'success',
        duration: stillDown ? 15000 : 7000,
      });
      void qc.invalidateQueries({ queryKey: settingsKeys.ai });
    },
    onSettled: () => {
      // Lỗi cũng tải lại: vd. "không còn gì để làm" ⇒ dải vàng tự ẩn.
      void qc.invalidateQueries({ queryKey: aiOutageKey });
      void qc.invalidateQueries({ queryKey: inboxKeys.lists() });
      void qc.invalidateQueries({ queryKey: inboxKeys.details() });
    },
  });
}
