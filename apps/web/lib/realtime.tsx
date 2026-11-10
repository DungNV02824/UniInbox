'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HandoffCreatedPayload } from '@dezon/shared';
import {
  createAiTypingStore,
  EMPTY_AI_TYPING,
  type AiTypingEntry,
  type AiTypingState,
  type AiTypingStore,
} from '@/lib/ai-typing';
import { api, API_URL } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { contactTagKeys } from '@/lib/contact-tags-api';
import { inboxKeys } from '@/lib/inbox-keys';
import { createConversationBatcher } from '@/lib/conversation-batch';
import { applyConversationUpdates, applyMessageUpdated, applyNewMessage } from '@/lib/realtime-cache';
import { startRealtime } from '@/lib/socket';

export type HandoffListener = (payload: HandoffCreatedPayload) => void;

interface RealtimeContextValue {
  connected: boolean;
  /** Nghe sự kiện `handoff.created` (AI chuyển người thật / nhắc lại). Trả về hàm hủy. */
  subscribeHandoff: (listener: HandoffListener) => () => void;
  /** Trạng thái "AI đang soạn tin…" theo hội thoại (sự kiện `ai.typing`); null khi chưa có kết nối. */
  aiTyping: AiTypingStore | null;
}

const RealtimeContext = createContext<RealtimeContextValue>({
  connected: false,
  subscribeHandoff: () => () => undefined,
  aiTyping: null,
});

/** Mở một kết nối realtime khi đã đăng nhập và đưa sự kiện vào cache TanStack Query. */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const handoffListeners = useRef(new Set<HandoffListener>());
  const [aiTyping] = useState(() => createAiTypingStore());
  const userId = user?.id;
  const role = user?.role;

  const subscribeHandoff = useCallback((listener: HandoffListener) => {
    handoffListeners.current.add(listener);
    return () => {
      handoffListeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (status !== 'authenticated' || !userId || !role) return;
    const viewer = { id: userId, role };
    const batcher = createConversationBatcher((convs) =>
      applyConversationUpdates(queryClient, convs, viewer),
    );
    /** Nhật ký AI (nếu đang mở) có lần chạy mới. */
    const refreshAiRuns = (conversationId: string) =>
      void queryClient.invalidateQueries({ queryKey: inboxKeys.aiRuns(conversationId) });
    const listeners = handoffListeners.current;
    const stop = startRealtime({
      url: API_URL,
      getToken: () => api.getAccessToken(),
      refreshToken: () => api.refreshAccessToken(),
      subscribeSession: (listener) => api.subscribe(listener),
      handlers: {
        // Tin vào khung chat ngay; bản hội thoại (preview, chưa đọc, thứ tự) đi chung bộ gộp với
        // `conversation.updated` để giữ đúng thứ tự tới và không render dồn dập khi đồng bộ lịch sử.
        'message.created': ({ message, conversation }) => {
          applyNewMessage(queryClient, message);
          aiTyping.handleMessage(message);
          batcher.push(conversation);
          if (message.senderType === 'bot') refreshAiRuns(message.conversationId);
        },
        'message.updated': (payload) => applyMessageUpdated(queryClient, payload),
        'conversation.updated': ({ conversation }) => batcher.push(conversation),
        'ai.typing': (payload) => aiTyping.handleTyping(payload),
        // Danh sách nhãn đổi (thêm/đổi tên/đổi màu/xóa): tải lại danh sách + hồ sơ khách đang mở
        // (đổi tên/xóa nhãn sửa luôn tags trên khách).
        'contact_tags.updated': () => {
          void queryClient.invalidateQueries({ queryKey: contactTagKeys.all });
          void queryClient.invalidateQueries({ queryKey: inboxKeys.details() });
        },
        'handoff.created': (payload) => {
          refreshAiRuns(payload.conversationId);
          for (const listener of listeners) {
            try {
              listener(payload);
            } catch {
              // Một listener lỗi không chặn các listener khác.
            }
          }
        },
      },
      onResync: () => {
        batcher.flush();
        void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
        void queryClient.invalidateQueries({ queryKey: contactTagKeys.all });
      },
      onStatusChange: (next) => {
        setConnected(next);
        // Mất kết nối thì có thể lỡ typing:false ⇒ tắt hết cho khỏi treo.
        if (!next) aiTyping.clearAll();
      },
    });
    return () => {
      stop();
      batcher.dispose();
      aiTyping.clearAll();
      setConnected(false);
    };
  }, [status, userId, role, queryClient, aiTyping]);

  useEffect(() => () => aiTyping.dispose(), [aiTyping]);

  const value = useMemo(
    () => ({ connected, subscribeHandoff, aiTyping }),
    [connected, subscribeHandoff, aiTyping],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeStatus(): { connected: boolean } {
  const { connected } = useContext(RealtimeContext);
  return { connected };
}

/** Gọi `listener` mỗi khi có `handoff.created` (listener mới nhất luôn được dùng). */
export function useHandoffEvents(listener: HandoffListener): void {
  const { subscribeHandoff } = useContext(RealtimeContext);
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  });
  useEffect(() => subscribeHandoff((p) => ref.current(p)), [subscribeHandoff]);
}

const noopSubscribe = () => () => undefined;
const emptySnapshot = (): AiTypingState => EMPTY_AI_TYPING;

/** Toàn bộ trạng thái "AI đang soạn tin…" (đổi khi có sự kiện `ai.typing` / tin bot / hết hạn). */
export function useAiTypingState(): AiTypingState {
  const { aiTyping } = useContext(RealtimeContext);
  return useSyncExternalStore(
    aiTyping?.subscribe ?? noopSubscribe,
    aiTyping?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
}

/** Bot có đang soạn tin ở hội thoại này không (null = không). */
export function useAiTyping(conversationId: string | undefined): AiTypingEntry | null {
  const state = useAiTypingState();
  // Kho tự xóa mục hết hạn bằng hẹn giờ nên chỉ cần tra theo id.
  return conversationId ? (state[conversationId] ?? null) : null;
}
