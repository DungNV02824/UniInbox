// Đồng hồ cửa sổ gửi (6.5): tính trạng thái hiển thị từ SendWindowInfo và thời điểm hiện tại.
import type { SendWindowInfo } from '@dezon/shared';

/** Dưới ngưỡng này đồng hồ chuyển vàng. */
export const WINDOW_WARN_MS = 2 * 60 * 60 * 1000;

export type WindowTone = 'ok' | 'warn' | 'expired' | 'unlimited';

export interface WindowState {
  tone: WindowTone;
  /** Thời gian còn lại (ms), null khi không giới hạn. */
  remainingMs: number | null;
  /** Nhãn ngắn trên header. */
  label: string;
  /** Gửi được ngay bây giờ (đã tính cả việc hết hạn tại máy khách). */
  canSend: boolean;
  /** Lý do khi bị chặn/có điều kiện. */
  reason?: string;
}

export const WINDOW_EXPIRED_REASON = 'Đã hết thời hạn được phép trả lời khách trên kênh này.';

/** "5 giờ 12 phút" khi còn ≥ 1 giờ; "12:05" (phút:giây) khi dưới 1 giờ. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d} ngày ${h % 24} giờ`;
  }
  if (h >= 1) return `${h} giờ ${m} phút`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function sendWindowState(info: SendWindowInfo, now: number = Date.now()): WindowState {
  if (!info.allowed) {
    return {
      tone: 'expired',
      remainingMs: 0,
      label: 'Hết cửa sổ gửi',
      canSend: false,
      reason: info.reason ?? WINDOW_EXPIRED_REASON,
    };
  }
  if (!info.expiresAt) {
    return {
      tone: 'unlimited',
      remainingMs: null,
      label: 'Không giới hạn',
      canSend: true,
      reason: info.reason,
    };
  }
  const remaining = Date.parse(info.expiresAt) - now;
  if (Number.isNaN(remaining) || remaining <= 0) {
    // Máy chủ chưa kịp cập nhật: coi như hết hạn tới khi tải lại thông tin cửa sổ.
    return {
      tone: 'expired',
      remainingMs: 0,
      label: 'Hết cửa sổ gửi',
      canSend: false,
      reason: WINDOW_EXPIRED_REASON,
    };
  }
  return {
    tone: remaining > WINDOW_WARN_MS ? 'ok' : 'warn',
    remainingMs: remaining,
    label: `Còn ${formatCountdown(remaining)}`,
    canSend: true,
    reason: info.reason,
  };
}
