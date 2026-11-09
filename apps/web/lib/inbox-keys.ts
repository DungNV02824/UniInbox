import type { ConversationFilters } from '@/lib/inbox-api';

/** Query key của hộp thư. Mọi key bắt đầu bằng 'conversations' để invalidate một lần khi reconnect. */
export const inboxKeys = {
  all: ['conversations'] as const,
  lists: () => ['conversations', 'list'] as const,
  list: (filters: ConversationFilters) => ['conversations', 'list', filters] as const,
  detail: (id: string) => ['conversations', 'detail', id] as const,
  messages: (id: string) => ['conversations', 'messages', id] as const,
};

export const channelsKey = ['channels'] as const;
export const directoryKey = ['users', 'directory'] as const;
