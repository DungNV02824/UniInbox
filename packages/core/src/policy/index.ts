// ChannelPolicy (mục 6.5): kiểm tra cửa sổ gửi theo kênh.
import type { ChannelType, SendWindowInfo, WindowSource } from '@dezon/shared';

export interface PolicyOptions {
  /** META_HUMAN_AGENT_ENABLED */
  metaHumanAgentEnabled: boolean;
  /** ZALO_OA_ALLOW_PAID_BOT */
  zaloOaAllowPaidBot: boolean;
}

export interface PolicyConversation {
  channelType: ChannelType;
  lastCustomerMessageAt: Date | null;
  windowSource: WindowSource | null;
  /** Thời điểm tin đầu tiên của khách (dùng cho cửa sổ hội thoại từ quảng cáo). */
  firstCustomerMessageAt: Date | null;
}

export interface CanSendResult {
  allowed: boolean;
  costly?: boolean;
  tag?: 'HUMAN_AGENT';
  reason?: string;
  /** Khi nào cửa sổ áp dụng cho kết quả này đóng (null = không giới hạn). */
  expiresAt: Date | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Cửa sổ tiêu chuẩn của Messenger. */
export const MESSENGER_STANDARD_WINDOW_MS = 24 * HOUR_MS;
/** Cửa sổ HUMAN_AGENT và cửa sổ hội thoại bắt đầu từ quảng cáo (⚠️ cần xác minh với tài liệu Meta). */
export const MESSENGER_EXTENDED_WINDOW_MS = 7 * DAY_MS;
export const ZALO_OA_FREE_WINDOW_MS = 48 * HOUR_MS;
export const ZALO_OA_PAID_WINDOW_MS = 7 * DAY_MS;

const NO_CUSTOMER_MESSAGE = 'Khách chưa nhắn tin cho kênh này nên chưa thể gửi tin.';

const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);
const blocked = (reason: string): CanSendResult => ({ allowed: false, reason, expiresAt: null });

function messengerCanSend(
  conv: PolicyConversation,
  last: Date,
  by: 'bot' | 'agent',
  now: Date,
  opts: PolicyOptions,
): CanSendResult {
  // Cửa sổ tiêu chuẩn: 24h từ tin cuối của khách; hội thoại từ quảng cáo: thêm 7 ngày từ tin đầu.
  let standardEnd = addMs(last, MESSENGER_STANDARD_WINDOW_MS);
  if (conv.windowSource === 'ads') {
    const adsEnd = addMs(conv.firstCustomerMessageAt ?? last, MESSENGER_EXTENDED_WINDOW_MS);
    if (adsEnd > standardEnd) standardEnd = adsEnd;
  }
  if (now <= standardEnd) return { allowed: true, expiresAt: standardEnd };

  const humanAgentEnd = addMs(last, MESSENGER_EXTENDED_WINDOW_MS);
  if (now > humanAgentEnd) {
    return blocked('Đã quá 7 ngày kể từ tin cuối của khách. Messenger không cho gửi tin nữa.');
  }
  if (by === 'bot') {
    return blocked('Đã quá 24 giờ kể từ tin cuối của khách. Bot không được gửi tin ngoài cửa sổ 24 giờ.');
  }
  if (!opts.metaHumanAgentEnabled) {
    return blocked('Đã quá 24 giờ kể từ tin cuối của khách. Messenger chỉ cho trả lời trong 24 giờ.');
  }
  return {
    allowed: true,
    tag: 'HUMAN_AGENT',
    reason: 'Ngoài 24 giờ: tin sẽ gửi kèm tag HUMAN_AGENT (chỉ nhân viên, tối đa 7 ngày).',
    expiresAt: humanAgentEnd,
  };
}

function zaloOaCanSend(last: Date, by: 'bot' | 'agent', now: Date, opts: PolicyOptions): CanSendResult {
  const freeEnd = addMs(last, ZALO_OA_FREE_WINDOW_MS);
  if (now <= freeEnd) return { allowed: true, expiresAt: freeEnd };

  const paidEnd = addMs(last, ZALO_OA_PAID_WINDOW_MS);
  if (now > paidEnd) {
    return blocked('Đã quá 7 ngày kể từ tin cuối của khách. Zalo OA không cho gửi tin nữa.');
  }
  if (by === 'bot' && !opts.zaloOaAllowPaidBot) {
    return blocked('Đã quá 48 giờ kể từ tin cuối của khách. Bot không tự gửi tin có tính phí.');
  }
  return {
    allowed: true,
    costly: true,
    reason: 'Đã quá 48 giờ kể từ tin cuối của khách: tin nhắn tư vấn sẽ bị tính phí.',
    expiresAt: paidEnd,
  };
}

/** Các mốc biên tính bao gồm (đúng 24h vẫn được gửi). */
export function canSend(
  conv: PolicyConversation,
  by: 'bot' | 'agent',
  now: Date,
  opts: PolicyOptions,
): CanSendResult {
  switch (conv.channelType) {
    case 'zalo_personal':
      // Luôn gửi được về mặt kỹ thuật; rate limit áp ở tầng gửi.
      return { allowed: true, expiresAt: null };
    case 'messenger':
      if (!conv.lastCustomerMessageAt) return blocked(NO_CUSTOMER_MESSAGE);
      return messengerCanSend(conv, conv.lastCustomerMessageAt, by, now, opts);
    case 'zalo_oa':
      if (!conv.lastCustomerMessageAt) return blocked(NO_CUSTOMER_MESSAGE);
      return zaloOaCanSend(conv.lastCustomerMessageAt, by, now, opts);
  }
}

/** Dạng DTO cho UI (by = 'agent'). */
export function sendWindowInfo(conv: PolicyConversation, now: Date, opts: PolicyOptions): SendWindowInfo {
  const r = canSend(conv, 'agent', now, opts);
  return {
    allowed: r.allowed,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    ...(r.costly ? { costly: true } : {}),
    ...(r.tag ? { tag: r.tag } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
  };
}
