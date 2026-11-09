const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;

/** Định dạng thời lượng dạng `15m`, `30d`, `3600s`, `12h`. */
export const DURATION_PATTERN = /^(\d+)([smhd])$/;

/** Đổi chuỗi thời lượng (`15m`, `30d`...) sang số giây. Ném lỗi nếu sai định dạng hoặc bằng 0. */
export function durationToSeconds(value: string): number {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Thời lượng không hợp lệ (ví dụ đúng: 15m, 30d, 3600s)`);
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof UNIT_SECONDS;
  const seconds = amount * UNIT_SECONDS[unit];
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('Thời lượng phải lớn hơn 0');
  return seconds;
}
