'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, API_URL } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { inboxKeys } from '@/lib/inbox-keys';
import { createConversationBatcher } from '@/lib/conversation-batch';
import { applyConversationUpdates, applyMessageUpdated, applyNewMessage } from '@/lib/realtime-cache';
import { startRealtime } from '@/lib/socket';

const RealtimeContext = createContext<{ connected: boolean }>({ connected: false });

/** Mở một kết nối realtime khi đã đăng nhập và đưa sự kiện vào cache TanStack Query. */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const userId = user?.id;
  const role = user?.role;

  useEffect(() => {
    if (status !== 'authenticated' || !userId || !role) return;
    const viewer = { id: userId, role };
    const batcher = createConversationBatcher((convs) =>
      applyConversationUpdates(queryClient, convs, viewer),
    );
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
          batcher.push(conversation);
        },
        'message.updated': (payload) => applyMessageUpdated(queryClient, payload),
        'conversation.updated': ({ conversation }) => batcher.push(conversation),
      },
      onResync: () => {
        batcher.flush();
        void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
      },
      onStatusChange: setConnected,
    });
    return () => {
      stop();
      batcher.dispose();
      setConnected(false);
    };
  }, [status, userId, role, queryClient]);

  return <RealtimeContext.Provider value={{ connected }}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeStatus(): { connected: boolean } {
  return useContext(RealtimeContext);
}
