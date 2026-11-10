'use client';

// Hook dữ liệu của tính năng Chatbot AI trong hộp thư: danh sách bot cho ô chọn, nhật ký AI,
// các thao tác (gắn bot, tiếp tục AI, nhận / xong handoff) cập nhật lạc quan + báo lỗi bằng toast.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatbotRef, ConversationSummary } from '@dezon/shared';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import {
  extractConversation,
  withAiResumed,
  withChatbot,
  withHandoffAcknowledged,
  withHandoffResolved,
} from '@/lib/inbox-ai';
import { inboxApi, looksLikeConversation } from '@/lib/inbox-api';
import { chatbotOptionsKey, inboxKeys } from '@/lib/inbox-keys';
import { errorText } from '@/lib/inbox-queries';
import { applyConversationUpdate, patchConversationEverywhere } from '@/lib/realtime-cache';

/** Bot cho ô chọn ở khung chat (đã gồm bot tắt nếu là admin; component tự lọc bot đang bật). */
export function useChatbotOptions(enabled = true) {
  return useQuery({
    queryKey: chatbotOptionsKey,
    queryFn: () => inboxApi.listChatbots(),
    staleTime: 60_000,
    enabled,
  });
}

/** Nhật ký AI của một hội thoại (admin), chỉ tải khi mở mục. */
export function useAiRuns(conversationId: string, enabled: boolean) {
  return useQuery({
    queryKey: inboxKeys.aiRuns(conversationId),
    queryFn: () => inboxApi.listAiRuns(conversationId),
    enabled,
    staleTime: 15_000,
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
