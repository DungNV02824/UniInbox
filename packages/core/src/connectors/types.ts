// Interface connector dùng chung cho mọi kênh (mục 9, Giai đoạn 1A).
// Connector KHÔNG truy cập DB: chỉ chuyển payload nền tảng <-> dạng chuẩn và gọi API nền tảng.
import type { ChannelType, NormalizedInboundMessage } from '@dezon/shared';

/** Tài khoản kênh đã giải mã credentials (chỉ dùng trong process, không log). */
export interface ResolvedChannelAccount {
  id: string;
  type: ChannelType;
  externalId: string;
  credentials: Record<string, unknown>;
}

/** Danh tính khách trên kênh (người nhận khi gửi). */
export interface ChannelRecipient {
  externalUserId: string;
}

/** Sự kiện chuẩn hóa từ webhook. Tin nhắn dùng NormalizedInboundMessage (mục 6.1). */
export type InboundEvent =
  | { kind: 'message'; message: NormalizedInboundMessage }
  | {
      kind: 'delivery';
      channelAccountId: string;
      externalUserId: string;
      /** id tin trên nền tảng đã giao tới khách (có thể rỗng nếu chỉ có watermark) */
      externalMessageIds: string[];
      /** Mọi tin gửi trước thời điểm này đã giao */
      watermark: Date | null;
    }
  | {
      kind: 'read';
      channelAccountId: string;
      externalUserId: string;
      /** Mọi tin gửi trước thời điểm này đã được khách xem */
      watermark: Date;
      /** id tin cụ thể đã xem (Zalo OA `user_seen_message.message.msg_ids`); thiếu = chỉ dùng watermark. */
      externalMessageIds?: string[];
    };

/** Tra channel_account theo id ngoài (page_id / oa_id) khi parse webhook. */
export type AccountResolver = (
  channelType: ChannelType,
  externalId: string,
) => Promise<{ id: string } | null>;

export interface OutboundTextPart {
  kind: 'text';
  text: string;
}

export interface OutboundFilePart {
  kind: 'attachment';
  type: 'image' | 'file' | 'video' | 'audio';
  mime: string;
  filename: string;
  /** Nội dung tệp (worker đọc từ S3). */
  data: Buffer;
}

/** Một tin gửi đi = đúng một phần (text HOẶC một tệp). API/worker tách tin trước khi gọi connector. */
export type OutboundPart = OutboundTextPart | OutboundFilePart;

export interface SendOptions {
  /** Tag Messenger khi ngoài cửa sổ 24h (chỉ cho tin của nhân viên). */
  tag?: 'HUMAN_AGENT';
  /** id nội bộ của message: connector gắn vào metadata để khớp echo (chống gửi trùng khi thử lại). */
  messageId?: string;
}

/**
 * Hành động người gửi (Messenger Send API `sender_action`): 'typing_on' = hiện dấu ba chấm "đang soạn tin" trên
 * Messenger của khách (Facebook tự tắt sau ~20 s hoặc khi Page gửi tin), 'typing_off' = tắt ngay,
 * 'mark_seen' = đánh dấu đã xem.
 */
export const SENDER_ACTIONS = ['typing_on', 'typing_off', 'mark_seen'] as const;
export type SenderAction = (typeof SENDER_ACTIONS)[number];

export interface SendResult {
  externalMessageId: string;
}

/**
 * Nguyên nhân lỗi vĩnh viễn mà pipeline xử lý riêng.
 * - 'outside_window': nền tảng báo ngoài cửa sổ gửi (Messenger; Zalo OA -230/-232).
 * - 'billing': hết hạn mức / chưa liên kết hoặc hết tiền ZCA (Zalo OA -211/-320/-321).
 * - 'unsupported_attachment': loại tệp nền tảng không nhận (Zalo OA chỉ ảnh + PDF/DOC/DOCX/CSV).
 */
export type PermanentSendReason = 'outside_window' | 'billing' | 'unsupported_attachment';

/** Lỗi không nên thử lại: hết cửa sổ, token hỏng, người nhận không tồn tại... */
export class PermanentSendError extends Error {
  override readonly name = 'PermanentSendError';
  constructor(
    message: string,
    /** Lỗi do credentials của kênh (token hết hạn/thu hồi) => đánh dấu channel_account lỗi. */
    readonly credentialsInvalid = false,
    readonly platformCode?: string | number,
    readonly reason?: PermanentSendReason,
  ) {
    super(message);
  }
}

/** Lỗi tạm thời: mạng, 5xx, rate limit — để BullMQ thử lại. */
export class TransientSendError extends Error {
  override readonly name = 'TransientSendError';
  constructor(
    message: string,
    readonly platformCode?: string | number,
  ) {
    super(message);
  }
}

/** Header và raw body của webhook — đủ để kiểm chữ ký. */
export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

export interface ChannelConnector {
  readonly type: ChannelType;
  /** Kiểm chữ ký webhook trên raw body. */
  verifyWebhook(req: WebhookRequest): boolean;
  /** Chuẩn hóa payload webhook (đã parse JSON) thành sự kiện. Bỏ qua tài khoản không có trong hệ thống. */
  parseWebhook(body: unknown, resolveAccount: AccountResolver): Promise<InboundEvent[]>;
  send(
    account: ResolvedChannelAccount,
    to: ChannelRecipient,
    part: OutboundPart,
    options?: SendOptions,
  ): Promise<SendResult>;
  fetchProfile?(
    account: ResolvedChannelAccount,
    externalUserId: string,
  ): Promise<{ name?: string; avatarUrl?: string; phone?: string }>;
  /**
   * Gửi hành động người gửi (chỉ báo "đang soạn tin"). Tùy chọn: kênh không hỗ trợ (Zalo OA) bỏ trống ⇒ caller bỏ
   * qua. Messenger: POST `<config.graphBaseUrl>/<account.externalId>/messages` (token = pageTokenOf(account), như
   * send) với body `{ recipient: { id: to.externalUserId }, sender_action: action }` — KHÔNG kèm `message`,
   * `messaging_type` hay `tag`. Lỗi ném PermanentSendError / TransientSendError giống send; caller (runtime AI)
   * PHẢI nuốt mọi lỗi (chỉ log debug) vì đây là việc phụ, không được làm chậm hay hỏng lượt trả lời.
   * Timeout nên ngắn (≤ 3 s) — không thử lại.
   */
  sendSenderAction?(
    account: ResolvedChannelAccount,
    to: ChannelRecipient,
    action: SenderAction,
  ): Promise<void>;
}
