// Giờ làm việc (app_settings.business_hours) — dùng cho prompt ("đang trong/ngoài giờ").
import { WEEKDAYS, WEEKDAY_LABELS, type BusinessHours, type TimeRange, type Weekday } from '@dezon/shared';

const WEEKDAY_BY_SHORT: Record<string, Weekday> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

interface LocalParts {
  weekday: Weekday;
  year: string;
  month: string;
  day: string;
  /** 'HH:MM' 24h */
  time: string;
}

/** Quy đổi `now` sang múi giờ `timezone` (Intl, tự xử lý giờ mùa hè). */
function localParts(now: Date, timezone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) map[p.type] = p.value;
  const weekday = WEEKDAY_BY_SHORT[map.weekday ?? ''];
  if (!weekday) throw new Error(`Không xác định được thứ trong tuần (${timezone})`);
  // Một số engine cũ trả '24' cho nửa đêm dù hourCycle h23.
  const hour = map.hour === '24' ? '00' : (map.hour ?? '00');
  return {
    weekday,
    year: map.year ?? '',
    month: map.month ?? '',
    day: map.day ?? '',
    time: `${hour}:${map.minute ?? '00'}`,
  };
}

/**
 * true nếu `now` (quy đổi sang bh.timezone bằng Intl.DateTimeFormat) rơi vào một khung
 * [start, end) của ngày tương ứng (mon..sun). Ngày không có khung ⇒ false.
 */
export function isWithinBusinessHours(bh: BusinessHours, now: Date): boolean {
  const { weekday, time } = localParts(now, bh.timezone);
  // So sánh chuỗi 'HH:MM' cùng độ dài tương đương so sánh thời gian.
  return bh.days[weekday].some((r) => r.start <= time && time < r.end);
}

function rangesKey(ranges: readonly TimeRange[]): string {
  return ranges.map((r) => `${r.start}–${r.end}`).join(', ');
}

/**
 * Mô tả tiếng Việt cho prompt; các ngày liên tiếp cùng khung giờ được gộp, ví dụ
 * "Thứ Hai–Thứ Sáu: 08:00–12:00, 13:30–17:30; Thứ Bảy: 08:00–12:00; Chủ Nhật: nghỉ".
 */
export function describeBusinessHours(bh: BusinessHours): string {
  const groups: { from: Weekday; to: Weekday; key: string }[] = [];
  for (const day of WEEKDAYS) {
    const key = rangesKey(bh.days[day]);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.to = day;
    else groups.push({ from: day, to: day, key });
  }
  if (groups.length === 1 && groups[0]?.key === '') return 'Nghỉ cả tuần (không có giờ làm việc)';
  return groups
    .map((g) => {
      const label =
        g.from === g.to ? WEEKDAY_LABELS[g.from] : `${WEEKDAY_LABELS[g.from]}–${WEEKDAY_LABELS[g.to]}`;
      return `${label}: ${g.key === '' ? 'nghỉ' : g.key}`;
    })
    .join('; ');
}

/** Giờ hiện tại theo múi giờ, ví dụ "Thứ Hai 09/11/2026 14:05 (Asia/Ho_Chi_Minh)". */
export function formatLocalNow(now: Date, timezone: string): string {
  const p = localParts(now, timezone);
  return `${WEEKDAY_LABELS[p.weekday]} ${p.day}/${p.month}/${p.year} ${p.time} (${timezone})`;
}
