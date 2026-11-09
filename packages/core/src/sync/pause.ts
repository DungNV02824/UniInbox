// Tạm dừng đồng bộ định kỳ của một kênh sau lỗi mà thử lại mỗi phút chỉ làm tệ thêm.
import { PermanentSendError, TransientSendError } from '../connectors/types';

/** Facebook giới hạn tần suất (mã 4, 17, 32, 613, 80001, 80006 hoặc HTTP 429): nghỉ 15 phút. */
export const SYNC_RATE_LIMIT_PAUSE_MS = 15 * 60_000;
/** Lỗi không thử lại được mà không do token (thiếu quyền đọc, máy chủ chưa cấu hình): nghỉ 30 phút. */
export const SYNC_PERMANENT_PAUSE_MS = 30 * 60_000;

const RATE_LIMIT_CODES = new Set(['4', '17', '32', '613', '80001', '80006']);

export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof TransientSendError)) return false;
  const code = String(error.platformCode ?? '');
  return code === 'HTTP 429' || RATE_LIMIT_CODES.has(code.split('/')[0] ?? '');
}

/** Số ms tạm dừng đồng bộ định kỳ sau lỗi; 0 = không tạm dừng (tick sau thử lại như thường). */
export function pauseAfter(error: unknown): number {
  if (isRateLimitError(error)) return SYNC_RATE_LIMIT_PAUSE_MS;
  // Token hỏng => kênh 'expired', tick tự bỏ qua; không cần tạm dừng.
  if (error instanceof PermanentSendError && !error.credentialsInvalid) return SYNC_PERMANENT_PAUSE_MS;
  return 0;
}
