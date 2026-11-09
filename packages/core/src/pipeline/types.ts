import type { ChannelType } from '@dezon/shared';
import type { ChannelConnector } from '../connectors/types';
import type { CredentialsCipher } from '../channels/service';
import type { InboxContext } from '../inbox/types';
import type { MediaStorage } from '../media/types';
import type { RealtimePublisher } from '../realtime';

export interface PipelineLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

export interface PipelineDeps {
  connectors: Partial<Record<ChannelType, ChannelConnector>>;
  storage: MediaStorage;
  cipher: CredentialsCipher;
  publisher: RealtimePublisher;
  ctx: InboxContext;
  logger: PipelineLogger;
  /** Giới hạn tải media tin đến (byte). */
  maxMediaBytes: number;
  /** META_APP_ID...: tin echo mang app_id này là tin hệ thống đã gửi. */
  ownAppIds: Partial<Record<ChannelType, string>>;
  fetch?: typeof fetch;
}

/**
 * Nguồn của tin đến. 'sync-backfill' (đồng bộ lịch sử): không tăng unread, không mở lại hội thoại đã xong,
 * không phát message.created (bên đồng bộ phát conversation.updated một lần mỗi hội thoại).
 * 'sync-incremental' xử lý như webhook. Mặc định 'webhook'.
 */
export type InboundSource = 'webhook' | 'sync-backfill' | 'sync-incremental';

export interface InboundProcessOptions {
  source?: InboundSource;
}

export interface InboundMessageResult {
  /** true nếu lưu tin mới; false nếu trùng / echo của hệ thống / bỏ qua. */
  stored: boolean;
  /** Hội thoại chứa tin vừa lưu. */
  conversation?: { id: string; assignedUserId: string | null };
}
