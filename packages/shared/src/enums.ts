// Giá trị enum dùng chung giữa DB (pgEnum), API, worker và web.
// Đây là "hợp đồng" của mục 5 trong đặc tả: thêm giá trị mới phải đi kèm migration.

export const CHANNEL_TYPES = ['zalo_oa', 'messenger', 'zalo_personal'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const SENDER_TYPES = ['customer', 'bot', 'agent', 'system'] as const;
export type SenderType = (typeof SENDER_TYPES)[number];

export const AI_MODES = ['auto', 'suggest', 'off'] as const;
export type AiMode = (typeof AI_MODES)[number];

export const CONVERSATION_STATUSES = ['open', 'pending_human', 'resolved'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_STATUSES = ['received', 'queued', 'sent', 'delivered', 'seen', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const USER_ROLES = ['admin', 'agent'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const CHANNEL_ACCOUNT_STATUSES = ['connected', 'expired', 'error', 'disconnected'] as const;
export type ChannelAccountStatus = (typeof CHANNEL_ACCOUNT_STATUSES)[number];

export const WINDOW_SOURCES = ['organic', 'ads'] as const;
export type WindowSource = (typeof WINDOW_SOURCES)[number];

export const ATTACHMENT_TYPES = ['image', 'file', 'sticker', 'video', 'audio'] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

export const AI_SUGGESTION_STATUSES = ['pending', 'sent', 'edited_sent', 'discarded'] as const;
export type AiSuggestionStatus = (typeof AI_SUGGESTION_STATUSES)[number];

export const AI_RUN_DECISIONS = ['reply', 'escalate', 'no_reply', 'suggest', 'error'] as const;
export type AiRunDecision = (typeof AI_RUN_DECISIONS)[number];

export const HANDOFF_REASON_CODES = [
  'discount',
  'complaint',
  'human_request',
  'out_of_scope',
  'closing',
  'low_confidence',
  'other',
] as const;
export type HandoffReasonCode = (typeof HANDOFF_REASON_CODES)[number];

export const KNOWLEDGE_SOURCE_TYPES = ['manual', 'url', 'file', 'faq'] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

/** Kích thước vector embedding. Cột `vector(N)` trong DB cố định theo hằng số này; env EMBEDDING_DIM phải khớp. */
export const EMBEDDING_DIM = 1024;

/** Tên các hàng đợi BullMQ dùng trong hệ thống (mục 3, 6). */
export const QUEUE_NAMES = {
  system: 'system',
  inbound: 'inbound',
  outbound: 'outbound',
  aiReply: 'ai-reply',
  memoryUpdate: 'memory-update',
  zaloOaTokenRefresh: 'zalo-oa-token-refresh',
  /** Đồng bộ hội thoại từ API nền tảng (lịch sử + định kỳ), bổ sung cho webhook. */
  channelSync: 'channel-sync',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
