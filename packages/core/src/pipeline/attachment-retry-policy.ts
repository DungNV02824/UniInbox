// Quy tắc tải lại tệp tin đến bị hỏng lúc nhận (storage_key ''). Không import gì của pipeline/inbox để read-model
// (DTO "đang tải lại") dùng được mà không vòng phụ thuộc.
import type { MessageAttachment } from '@dezon/shared';

/**
 * Chỉ tải lại tệp của tin LƯU (hoặc gửi) trong N ngày gần nhất: link CDN Facebook hết hạn sau vài ngày kể từ lúc
 * hệ thống lấy được link — tức lúc lưu tin (created_at). Đồng bộ lịch sử lưu tin cũ (sent_at vài tuần trước) với
 * link vừa lấy ⇒ tính theo GREATEST(sent_at, created_at).
 */
export const ATTACHMENT_RETRY_WINDOW_DAYS = 3;
/** Tối đa số lần tải lại một tệp (khoảng ~4 giờ với backoff bên dưới) rồi bỏ hẳn. */
export const ATTACHMENT_RETRY_MAX_ATTEMPTS = 8;
/** Backoff: lần kế tiếp sau 2^retry_count phút (2, 4, 8 … 128), trần 240 phút. */
export const ATTACHMENT_RETRY_MAX_BACKOFF_MIN = 240;
/**
 * Lỗi GHI KHO không tính lượt (kho cả hệ thống hỏng thì tệp không mất lượt vì lỗi của mình), nhưng chỉ tới chừng
 * này lần mỗi tệp: quá thì tính như lỗi tạm thời thường (có backoff + trần lượt) — một tệp mà kho luôn từ chối
 * (giới hạn kích thước của gateway…) không bị thử mãi suốt cửa sổ. ~24 lần ≈ cả ngày kho hỏng khi quét xoay vòng.
 */
export const ATTACHMENT_RETRY_MAX_FREE_STORE_ERRORS = 24;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Mốc tính cửa sổ của tin: thời điểm muộn hơn giữa lúc gửi và lúc lưu (≈ lúc lấy được link CDN). */
export interface AttachmentRetryMessageTimes {
  sentAt: Date;
  createdAt: Date;
}

export function attachmentRetryCutoff(now: Date): Date {
  return new Date(now.getTime() - ATTACHMENT_RETRY_WINDOW_DAYS * DAY_MS);
}

export function attachmentRetryBackoffMs(retryCount: number): number {
  return Math.min(2 ** Math.max(0, retryCount), ATTACHMENT_RETRY_MAX_BACKOFF_MIN) * MINUTE_MS;
}

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

export function attachmentRetryCount(a: MessageAttachment): number {
  return count(a.retry_count);
}

export function attachmentStoreErrorCount(a: MessageAttachment): number {
  return count(a.store_error_count);
}

/**
 * Tệp hỏng còn được tải lại (chưa tính backoff): chưa có storage_key, có URL http(s), chưa bị đánh dấu bỏ hẳn,
 * chưa hết lượt, tin còn trong cửa sổ. Dùng cho DTO ("Đang tải lại tệp…").
 */
export function isAttachmentRetryPending(
  a: MessageAttachment,
  msg: AttachmentRetryMessageTimes,
  now: Date,
): boolean {
  const windowAt = Math.max(msg.sentAt.getTime(), msg.createdAt.getTime());
  return (
    !a.storage_key &&
    isHttpUrl(a.original_url) &&
    a.retry_exhausted !== true &&
    attachmentRetryCount(a) < ATTACHMENT_RETRY_MAX_ATTEMPTS &&
    windowAt >= attachmentRetryCutoff(now).getTime()
  );
}

/** Còn được tải lại VÀ đã tới lượt (qua backoff kể từ last_retry_at). */
export function isAttachmentRetryDue(
  a: MessageAttachment,
  msg: AttachmentRetryMessageTimes,
  now: Date,
): boolean {
  if (!isAttachmentRetryPending(a, msg, now)) return false;
  if (!a.last_retry_at) return true;
  const last = Date.parse(a.last_retry_at);
  if (!Number.isFinite(last)) return true;
  return now.getTime() >= last + attachmentRetryBackoffMs(attachmentRetryCount(a));
}
