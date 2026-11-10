// Dữ liệu mẫu cho test hộp thư.
import type { ConversationSummary, MessageDto, Page } from '@dezon/shared';
import type { ChatMessage, ConversationsData, MessagesData } from '@/lib/inbox-cache';

export const CHANNEL = {
  id: 'ch-1',
  type: 'messenger' as const,
  displayName: 'Dezon Nội Thất',
  color: '#2563eb',
  status: 'connected' as const,
};

let seq = 0;

export function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  const sentAt = overrides.sentAt ?? new Date(Date.UTC(2026, 10, 5, 8, 0, seq)).toISOString();
  return {
    id: `m-${seq}`,
    conversationId: 'c-1',
    senderType: 'customer',
    senderUser: null,
    senderLabel: null,
    text: `tin ${seq}`,
    attachments: [],
    status: 'received',
    error: null,
    sentAt,
    createdAt: sentAt,
    ...overrides,
  };
}

export function conv(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'c-1',
    status: 'open',
    aiMode: 'off',
    assignedUser: null,
    unreadCount: 0,
    lastMessageAt: '2026-11-05T08:00:00.000Z',
    lastCustomerMessageAt: '2026-11-05T08:00:00.000Z',
    windowSource: 'organic',
    lastMessage: null,
    contact: { id: 'k-1', displayName: 'Chị Lan', avatarUrl: null, tags: [] },
    channel: CHANNEL,
    sendWindow: { allowed: true, expiresAt: '2026-11-06T08:00:00.000Z' },
    ...overrides,
  };
}

/** Dữ liệu infinite query tin nhắn; `pages[0]` là trang mới nhất. */
export function messagesData(...pages: { items: MessageDto[]; nextCursor?: string | null }[]): MessagesData {
  return {
    pages: pages.map((p) => ({ items: p.items, nextCursor: p.nextCursor ?? null })),
    pageParams: pages.map((_, i) => (i === 0 ? undefined : `cur-${i}`)),
  };
}

export function conversationsData(...pages: Page<ConversationSummary>[]): ConversationsData {
  return { pages, pageParams: pages.map((_, i) => (i === 0 ? undefined : `cur-${i}`)) };
}
