// Đọc lịch sử hội thoại Zalo OA qua OpenAPI (docs/research/zalo-oa.md §6, §7). CHỈ GET.
// Lỗi ném PermanentSendError / TransientSendError (giống bộ đọc Messenger) để lớp đồng bộ tạm dừng / thử lại.
import type { NormalizedInboundMessage } from '@dezon/shared';
import { notImplemented } from '../../not-implemented';
import type { ResolvedChannelAccount } from '../types';

/** Một tin trong `listrecentchat` / `conversation` (v2.0). id là CHUỖI số lớn hơn 2^53 — không parse số. */
export interface ZaloOaHistoryMessage {
  messageId: string;
  /** src 1 = khách gửi OA ('in'); src 0 = OA gửi khách ('out'). */
  direction: 'in' | 'out';
  time: Date;
  /** text, voice, photo, GIF, link, links, sticker, location (chuỗi gốc). */
  type: string;
  text?: string;
  url?: string;
  thumb?: string;
  fromId: string;
  toId: string;
  fromDisplayName?: string;
  fromAvatar?: string;
  toDisplayName?: string;
  toAvatar?: string;
  /** Phần tử gốc của mảng data. */
  raw: unknown;
}

export interface ZaloOaUserDetail {
  userId: string;
  userIdByApp: string | null;
  displayName: string | null;
  /** avatars['240'] ?? avatar — URL không lâu dài, phải tải về S3. */
  avatarUrl: string | null;
  isFollower: boolean | null;
  /** is_sensitive: người dùng dưới 18 tuổi. */
  isSensitive: boolean;
  /** shared_info.phone (ép về chuỗi). */
  phone: string | null;
  /** user_last_interaction_date dd/MM/yyyy (chỉ ngày). */
  lastInteractionDate: string | null;
}

export interface ZaloOaListUsersOptions {
  offset: number;
  /** Tối đa 50. */
  count: number;
  /** TODAY | YESTERDAY | L7D | L30D | "YYYY_MM_DD:YYYY_MM_DD" (giờ Việt Nam). */
  lastInteractionPeriod?: string;
  isFollower?: boolean;
}

export interface ZaloOaPageOptions {
  offset: number;
  /** Tối đa 10. */
  count: number;
}

export interface ZaloOaConversationsReader {
  /** GET /v2.0/oa/listrecentchat?data={offset,count} — mới nhất trước (độ sâu offset ≥ 10 chưa xác minh). */
  listRecentChat(account: ResolvedChannelAccount, opts: ZaloOaPageOptions): Promise<ZaloOaHistoryMessage[]>;
  /** GET /v2.0/oa/conversation?data={user_id (chuỗi),offset,count} — mới nhất trước. */
  getConversation(
    account: ResolvedChannelAccount,
    userId: string,
    opts: ZaloOaPageOptions,
  ): Promise<ZaloOaHistoryMessage[]>;
  /** GET /v3.0/oa/user/getlist — chỉ trả id. */
  listUsers(
    account: ResolvedChannelAccount,
    opts: ZaloOaListUsersOptions,
  ): Promise<{ total: number; userIds: string[] }>;
  /** GET /v3.0/oa/user/detail?data={"user_id":"…"} */
  getUserDetail(account: ResolvedChannelAccount, userId: string): Promise<ZaloOaUserDetail>;
  /** POST /v3.0/oa/quota/message {user_id} → data.last_interaction (ms); null nếu không có. */
  getLastInteraction(account: ResolvedChannelAccount, userId: string): Promise<Date | null>;
}

/**
 * Chuyển một tin lịch sử thành NormalizedInboundMessage (channelType 'zalo_oa'):
 * - direction 'in' => senderType 'customer', externalUserId = fromId; 'out' => 'agent', externalUserId = toId.
 * - photo/GIF/sticker/voice => attachments theo `url`; link/location => text mô tả; loại lạ => text "[type]".
 * - profileHint từ from_display_name/from_avatar (tin 'in').
 * - raw = phần tử gốc kèm `{ source: 'zalo_history' }` (KHÔNG có app_id => pipeline không coi là echo của mình;
 *   tin 'out' khớp external_message_id đã có thì bị bỏ qua nhờ chống trùng).
 * Trả null nếu tin không đủ dữ liệu.
 */
export function zaloHistoryMessageToInbound(
  _message: ZaloOaHistoryMessage,
  _ctx: { channelAccountId: string; oaId: string },
): NormalizedInboundMessage | null {
  return notImplemented('zaloHistoryMessageToInbound');
}

export function createZaloOaConversationsReader(_config: {
  openApiBaseUrl: string;
  appSecret: string;
  fetch?: typeof fetch;
}): ZaloOaConversationsReader {
  return notImplemented('createZaloOaConversationsReader');
}
