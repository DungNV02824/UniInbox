// Hợp đồng API hộp thư (Giai đoạn 1A) — dùng chung giữa api, worker và web.
// Ngày giờ trong DTO luôn là chuỗi ISO 8601 (UTC).
import { z } from 'zod';
import type { ChatbotRef } from './chatbots';
import {
  ATTACHMENT_TYPES,
  CHANNEL_TYPES,
  type AiMode,
  type AttachmentType,
  type ChannelAccountStatus,
  type ChannelType,
  type ConversationStatus,
  type HandoffReasonCode,
  type MessageStatus,
  type SenderType,
  type UserRole,
  type WindowSource,
} from './enums';
import type { ZaloOaChannelInfo } from './zalo';

/** Giới hạn ký tự mỗi tin gửi đi (Messenger: "less than 2000"; Zalo OA ~2000). Dài hơn thì API tách thành nhiều tin. */
export const OUTBOUND_TEXT_MAX_CHARS = 1999;
/** Giới hạn tổng độ dài một lần gửi từ ô soạn (sau đó tách thành nhiều tin ≤ OUTBOUND_TEXT_MAX_CHARS). */
export const COMPOSER_TEXT_MAX_CHARS = 8000;
export const MESSAGES_PAGE_MAX = 100;
export const CONVERSATIONS_PAGE_MAX = 100;

// ---------- Kênh ----------

export interface ChannelAccountDto {
  id: string;
  type: ChannelType;
  displayName: string;
  /** page_id / oa_id / zalo uid */
  externalId: string;
  status: ChannelAccountStatus;
  lastError: string | null;
  /** Màu nhãn dạng #rrggbb */
  color: string;
  createdAt: string;
  updatedAt: string;
  /** Ai/cách nào đã kết nối kênh (lưu trong channel_accounts.settings); null/thiếu = không rõ (kênh cũ). */
  connectedBy?: ChannelConnectedBy | null;
  /** Ảnh đại diện Page lấy lúc kết nối (URL CDN của Meta, có thể hết hạn). */
  pictureUrl?: string | null;
  /** Trạng thái đồng bộ hội thoại qua API nền tảng (lưu trong channel_accounts.settings.sync). */
  sync?: ChannelSyncState | null;
  /** Chỉ có với kênh zalo_oa: hạn token (không bao giờ chứa token). */
  zaloOa?: ZaloOaChannelInfo | null;
  /** Số hội thoại / tin nhắn của kênh (GET /channels); null/thiếu = không rõ. */
  stats?: ChannelStats | null;
  /** Chatbot tự gắn cho hội thoại MỚI của kênh; null = không. */
  defaultChatbotId?: string | null;
}

export interface ChannelStats {
  conversations: number;
  messages: number;
}

/** Trạng thái đồng bộ của một kênh (đồng bộ lịch sử + đồng bộ định kỳ). */
export interface ChannelSyncState {
  /** Lần đồng bộ (bất kỳ) thành công gần nhất, ISO. */
  lastSyncedAt: string | null;
  /** Lần đồng bộ lịch sử gần nhất hoàn tất, ISO. */
  lastBackfillAt: string | null;
  /** Số ngày lịch sử đã đồng bộ ở lần đồng bộ lịch sử gần nhất. */
  backfillDays: number | null;
  /** Đang có job đồng bộ lịch sử chạy/chờ. */
  backfillRunning: boolean;
  /** Lỗi gần nhất (tiếng Việt), null nếu ổn. */
  lastError: string | null;
  lastErrorAt: string | null;
  /** Số hội thoại đọc được ở lần đồng bộ lịch sử gần nhất. */
  backfillConversations?: number | null;
  /** Số tin MỚI lưu ở lần đồng bộ lịch sử gần nhất. */
  backfillMessagesStored?: number | null;
  /** Lần đồng bộ lịch sử gần nhất chạm giới hạn an toàn (số hội thoại / số tin mỗi hội thoại). */
  backfillTruncated?: boolean;
  /** Đồng bộ định kỳ tạm dừng tới thời điểm này (Facebook giới hạn tần suất / thiếu quyền), ISO. */
  pausedUntil?: string | null;
}

/** POST /channels/:id/sync (admin): đồng bộ lịch sử N ngày gần nhất. */
export const syncChannelSchema = z.object({
  days: z.number().int().min(1).max(365).optional(),
});
export type SyncChannelRequest = z.infer<typeof syncChannelSchema>;

export interface ChannelConnectedBy {
  /** 'zalo_oauth' = kết nối Zalo OA qua OAuth v4 (người kết nối = actor trong audit_logs). */
  provider: 'facebook_login' | 'token' | 'zalo_oauth';
  /** ID người dùng Facebook (app-scoped) đã đăng nhập để kết nối. */
  fbUserId?: string;
  fbUserName?: string;
}

/** Thông tin kênh rút gọn đi kèm mỗi hội thoại. */
export type ChannelBadge = Pick<ChannelAccountDto, 'id' | 'type' | 'displayName' | 'color' | 'status'>;

export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Màu phải có dạng #rrggbb');

/** POST /channels/messenger (admin): kết nối Fanpage bằng Page Access Token dài hạn. */
export const connectMessengerPageSchema = z.object({
  pageAccessToken: z.string().trim().min(20).max(1000),
  displayName: z.string().trim().min(1).max(100).optional(),
  color: hexColorSchema.optional(),
});
export type ConnectMessengerPageRequest = z.infer<typeof connectMessengerPageSchema>;

/** PATCH /channels/:id (admin) */
export const updateChannelSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    color: hexColorSchema.optional(),
    /** null = bỏ chatbot mặc định của kênh. */
    defaultChatbotId: z.uuid().nullable().optional(),
  })
  .refine((v) => v.displayName !== undefined || v.color !== undefined || v.defaultChatbotId !== undefined, {
    message: 'Không có gì để cập nhật',
  });
export type UpdateChannelRequest = z.infer<typeof updateChannelSchema>;

/**
 * DELETE /channels/:id (admin): xóa hẳn kênh đã ngắt kết nối cùng toàn bộ hội thoại, tin nhắn,
 * danh tính khách của kênh. `confirmName` phải trùng tên kênh (displayName) để tránh xóa nhầm.
 */
export const deleteChannelSchema = z.object({
  confirmName: z.string().trim().min(1).max(200),
});
export type DeleteChannelRequest = z.infer<typeof deleteChannelSchema>;

/** Kết quả DELETE /channels/:id: số bản ghi đã xóa. */
export interface DeleteChannelResult {
  deleted: true;
  conversations: number;
  messages: number;
  /** Khách bị xóa vì không còn danh tính nào trên kênh khác. */
  contacts: number;
}

// ---------- Kết nối bằng Facebook Login ----------

/** POST /channels/messenger/oauth/start (admin) */
export interface FacebookLoginStartResponse {
  /** Mở bằng window.location.assign (chuyển hẳn sang facebook.com). */
  authorizeUrl: string;
}

export interface FacebookLoginPageDto {
  id: string;
  name: string;
  pictureUrl: string | null;
  /** Page đã có kênh đang kết nối trong hệ thống. */
  alreadyConnected: boolean;
  /** Kênh (bất kể trạng thái) có external_id = page id. */
  channelAccountId: string | null;
  /** Tài khoản có đủ quyền (task) để nhắn tin và đăng ký webhook cho Page. */
  canMessage: boolean;
  /** Lý do khi !canMessage (tiếng Việt). */
  cannotMessageReason: string | null;
}

/** GET /channels/messenger/oauth/sessions/:sessionId (admin tạo phiên) — không chứa token. */
export interface FacebookLoginSessionDto {
  sessionId: string;
  fbUser: { id: string; name: string };
  pages: FacebookLoginPageDto[];
  expiresAt: string;
}

export const FACEBOOK_CONNECT_MAX_PAGES = 50;

/** POST /channels/messenger/oauth/sessions/:sessionId/connect (admin) */
export const connectFacebookPagesSchema = z.object({
  pageIds: z
    .array(z.string().regex(/^\d{1,30}$/, 'Page ID không hợp lệ'))
    .min(1, 'Chọn ít nhất một Trang')
    .max(FACEBOOK_CONNECT_MAX_PAGES, `Tối đa ${FACEBOOK_CONNECT_MAX_PAGES} Trang mỗi lần`),
});
export type ConnectFacebookPagesRequest = z.infer<typeof connectFacebookPagesSchema>;

export interface ConnectFacebookPageResult {
  pageId: string;
  ok: boolean;
  channel?: ChannelAccountDto;
  /** Lỗi tiếng Việt khi !ok. */
  error?: string;
}

export interface ConnectFacebookPagesResult {
  results: ConnectFacebookPageResult[];
}

/** Mã lỗi ngắn trong `?fbError=` khi callback Facebook thất bại. */
export const FACEBOOK_LOGIN_ERROR_CODES = [
  'denied',
  'state',
  'exchange',
  'not_configured',
  'unknown',
] as const;
export type FacebookLoginErrorCode = (typeof FACEBOOK_LOGIN_ERROR_CODES)[number];

// ---------- Người dùng (rút gọn) ----------

export interface UserRef {
  id: string;
  name: string;
}

/** GET /users/directory — mọi nhân viên đang hoạt động (dùng cho ô phân công). */
export interface UserDirectoryEntry extends UserRef {
  role: UserRole;
}

// ---------- Cửa sổ gửi (6.5) ----------

export interface SendWindowInfo {
  /** Nhân viên có gửi được ngay bây giờ không. */
  allowed: boolean;
  /** Thời điểm cửa sổ hiện tại đóng (null = không giới hạn, ví dụ Zalo cá nhân). */
  expiresAt: string | null;
  /** Gửi được nhưng có tính phí (Zalo OA 48h–7 ngày). */
  costly?: boolean;
  /** Tin sẽ được gắn tag này (Messenger HUMAN_AGENT). */
  tag?: 'HUMAN_AGENT';
  /** Lý do khi bị chặn hoặc có điều kiện, tiếng Việt, hiển thị cho nhân viên. */
  reason?: string;
}

// ---------- Hội thoại ----------

export interface ContactRef {
  id: string;
  displayName: string;
  /** URL ký có thời hạn (ảnh đã lưu trên S3), hoặc null. */
  avatarUrl: string | null;
  /** Tag của khách, đúng thứ tự đã lưu; [] nếu không có. */
  tags: string[];
}

export interface LastMessagePreview {
  text: string | null;
  senderType: SenderType;
  hasAttachments: boolean;
  /** Nhân viên gửi (để UI hiện "Bạn: " khi là chính mình). */
  senderUserId?: string | null;
  /** Loại tệp đầu tiên khi tin không có chữ. */
  attachmentType?: AttachmentType | null;
  sentAt: string;
}

export interface ConversationSummary {
  id: string;
  status: ConversationStatus;
  aiMode: AiMode;
  assignedUser: UserRef | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastCustomerMessageAt: string | null;
  windowSource: WindowSource | null;
  lastMessage: LastMessagePreview | null;
  contact: ContactRef;
  channel: ChannelBadge;
  sendWindow: SendWindowInfo;
  /** Chatbot đang gắn (vẫn giữ khi đã chuyển người thật để "trả lại cho AI"); null = không có. */
  chatbot?: ChatbotRef | null;
  /** AI tạm dừng tới thời điểm này (nhân viên vừa nhắn), ISO; null = không tạm dừng. */
  aiPausedUntil?: string | null;
  /** Yêu cầu chuyển người thật đang mở (chưa resolve); null = không có. */
  handoff?: ConversationHandoff | null;
}

/** Handoff đang mở của hội thoại. */
export interface ConversationHandoff {
  reasonCode: HandoffReasonCode;
  summary: string;
  /** Thời điểm tạo handoff, ISO. */
  at: string;
  /** Nhân viên đã bấm "Nhận xử lý"; null = chưa ai nhận. */
  acknowledgedBy: UserRef | null;
}

export interface ContactIdentityDto {
  id: string;
  channel: ChannelBadge;
  externalUserId: string;
  conversationId: string | null;
}

export interface ContactDetail extends ContactRef {
  phone: string | null;
  email: string | null;
  notes: string | null;
  identities: ContactIdentityDto[];
}

export interface ConversationDetail extends ConversationSummary {
  contactDetail: ContactDetail;
}

export interface Page<T> {
  items: T[];
  /** Truyền lại vào `cursor` để lấy trang kế; null = hết. */
  nextCursor: string | null;
}

const booleanQuery = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

/** GET /conversations — query string. */
export const listConversationsQuerySchema = z.object({
  channelType: z.enum(CHANNEL_TYPES).optional(),
  channelAccountId: z.uuid().optional(),
  status: z.enum(['open', 'pending_human', 'resolved']).optional(),
  /** 'me' | 'none' | uuid của nhân viên */
  assignee: z.union([z.literal('me'), z.literal('none'), z.uuid()]).optional(),
  unread: booleanQuery,
  /** 'handled' = "AI đang lo": hội thoại có chatbot và ai_mode 'auto'. */
  aiState: z.enum(['handled']).optional(),
  limit: z.coerce.number().int().min(1).max(CONVERSATIONS_PAGE_MAX).default(30),
  cursor: z.string().max(200).optional(),
});
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

/** PATCH /conversations/:id */
export const updateConversationSchema = z
  .object({
    status: z.enum(['open', 'resolved']).optional(),
    /** null = bỏ phân công */
    assignedUserId: z.uuid().nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.assignedUserId !== undefined, {
    message: 'Không có gì để cập nhật',
  });
export type UpdateConversationRequest = z.infer<typeof updateConversationSchema>;

/** PATCH /contacts/:id — cột thông tin khách. */
export const updateContactSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    notes: z.string().max(5000).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  })
  .refine((v) => v.displayName !== undefined || v.notes !== undefined || v.tags !== undefined, {
    message: 'Không có gì để cập nhật',
  });
export type UpdateContactRequest = z.infer<typeof updateContactSchema>;

// ---------- Tin nhắn ----------

export interface MessageAttachmentDto {
  type: AttachmentType;
  mime: string;
  /** URL ký có thời hạn để xem/tải; null nếu chưa tải được về S3. */
  url: string | null;
  width?: number;
  height?: number;
  name?: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderType: SenderType;
  /** Nhân viên gửi (khi senderType = 'agent' và biết người gửi). */
  senderUser: UserRef | null;
  /** Nhãn hiển thị phụ, ví dụ "Meta Business Suite" cho tin echo không rõ nhân viên. */
  senderLabel: string | null;
  text: string | null;
  attachments: MessageAttachmentDto[];
  status: MessageStatus;
  error: string | null;
  sentAt: string;
  createdAt: string;
  /** Echo lại clientId từ request gửi tin để UI khớp tin lạc quan. */
  clientId?: string;
}

/** GET /conversations/:id/messages — trả tin cũ dần; items sắp xếp TĂNG dần theo sentAt trong trang. */
export const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MESSAGES_PAGE_MAX).default(50),
  /** Cursor lấy tin CŨ hơn. */
  cursor: z.string().max(200).optional(),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

/** Tệp đã upload qua POST /media/uploads, đính vào tin gửi đi. */
export const outboundAttachmentInputSchema = z.object({
  storageKey: z
    .string()
    .min(1)
    .max(300)
    .regex(/^uploads\//, 'storageKey không hợp lệ'),
  type: z.enum(ATTACHMENT_TYPES),
  mime: z.string().min(1).max(100),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  name: z.string().max(255).optional(),
});
export type OutboundAttachmentInput = z.infer<typeof outboundAttachmentInputSchema>;

/** POST /conversations/:id/messages */
export const sendMessageSchema = z
  .object({
    text: z.string().max(COMPOSER_TEXT_MAX_CHARS).optional(),
    attachments: z.array(outboundAttachmentInputSchema).max(10).default([]),
    /** id tạm phía client để khớp tin lạc quan */
    clientId: z.string().max(100).optional(),
    /**
     * Nhân viên đã xác nhận gửi tin có tính phí (Zalo OA 48 giờ–7 ngày). Bắt buộc `true` khi
     * sendWindow.costly; thiếu => API trả 409 với code SEND_ERROR_CODES.costlyConfirmRequired.
     */
    confirmCostly: z.boolean().optional(),
  })
  .refine((m) => (m.text?.trim().length ?? 0) > 0 || m.attachments.length > 0, {
    message: 'Tin nhắn phải có nội dung hoặc tệp đính kèm',
  });
export type SendMessageRequest = z.infer<typeof sendMessageSchema>;

/** Mã lỗi máy đọc được trong body lỗi của API (`ApiErrorBody.code`). */
export const SEND_ERROR_CODES = {
  /** 409: tin sẽ bị tính phí (Zalo OA 48 giờ–7 ngày) mà request chưa có confirmCostly: true. */
  costlyConfirmRequired: 'COSTLY_CONFIRM_REQUIRED',
} as const;
export type SendErrorCode = (typeof SEND_ERROR_CODES)[keyof typeof SEND_ERROR_CODES];

/** Định dạng body lỗi của API (khớp ErrorBody của AllExceptionsFilter, thêm `code` tuỳ chọn). */
export interface ApiErrorBody {
  statusCode: number;
  /** Thông điệp tiếng Việt cho người dùng. */
  message: string;
  /** Mã lỗi máy đọc được, ví dụ 'COSTLY_CONFIRM_REQUIRED'. */
  code?: string;
  errors?: { path: string; message: string }[];
}

/** Kết quả POST /media/uploads */
export interface UploadedMediaDto {
  storageKey: string;
  type: AttachmentType;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  name?: string;
  /** URL ký để xem trước */
  url: string;
}
