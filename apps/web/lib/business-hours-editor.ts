// Trình sửa "Giờ làm việc" (trang Cài đặt): trạng thái form, kiểm tra hợp lệ, sao chép. Hàm thuần để test.
import { WEEKDAYS, type BusinessHours, type TimeRange, type Weekday } from '@dezon/shared';

export const MAX_RANGES_PER_DAY = 4;
export const DEFAULT_RANGE: TimeRange = { start: '08:00', end: '17:30' };

export interface DayDraft {
  closed: boolean;
  /** Vẫn giữ khung giờ khi bật "Nghỉ" để mở lại không mất dữ liệu. */
  ranges: TimeRange[];
}

export interface BusinessHoursDraft {
  timezone: string;
  days: Record<Weekday, DayDraft>;
}

export function toDraft(bh: BusinessHours): BusinessHoursDraft {
  const days = {} as Record<Weekday, DayDraft>;
  for (const d of WEEKDAYS) {
    const ranges = bh.days[d] ?? [];
    days[d] =
      ranges.length === 0
        ? { closed: true, ranges: [{ ...DEFAULT_RANGE }] }
        : { closed: false, ranges: ranges.map((r) => ({ ...r })) };
  }
  return { timezone: bh.timezone, days };
}

/** Draft → body PUT: ngày nghỉ = [], khung giờ sắp theo giờ bắt đầu. */
export function fromDraft(draft: BusinessHoursDraft): BusinessHours {
  const days = {} as BusinessHours['days'];
  for (const d of WEEKDAYS) {
    const day = draft.days[d];
    days[d] = day.closed ? [] : [...day.ranges].sort((a, b) => a.start.localeCompare(b.start));
  }
  return { timezone: draft.timezone, days };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function fromMinutes(total: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(total)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Chuẩn hóa giờ gõ tay về 'HH:MM' (24 giờ): "8" → "08:00", "830" → "08:30", "8h30"/"8g30"/"8.30" → "08:30",
 * "17:5" → "17:50" (phút một chữ số = chục phút). Không hiểu được => giữ nguyên để bộ kiểm tra báo lỗi.
 */
export function normalizeTimeInput(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return raw.trim();
  let h: number;
  let m: number;
  const sep = /^(\d{1,2})[:h.g](\d{0,2})$/.exec(s);
  if (sep) {
    h = Number(sep[1]);
    m = sep[2] ? Number(sep[2].padEnd(2, '0')) : 0;
  } else if (/^\d{1,4}$/.test(s)) {
    if (s.length <= 2) {
      h = Number(s);
      m = 0;
    } else {
      h = Number(s.slice(0, s.length - 2));
      m = Number(s.slice(-2));
    }
  } else {
    return raw.trim();
  }
  if (h > 23 || m > 59) return raw.trim();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface DayValidation {
  /** Lỗi theo từng khung giờ (cùng chỉ số với ranges). */
  ranges: (string | null)[];
  /** Lỗi chung của ngày (vd quá 4 khung). */
  day: string | null;
}

/** Kiểm tra một ngày: định dạng, bắt đầu < kết thúc, không chồng lấn, ≤ 4 khung. Ngày nghỉ luôn hợp lệ. */
export function validateDay(day: DayDraft): DayValidation {
  const out: DayValidation = { ranges: day.ranges.map(() => null), day: null };
  if (day.closed) return out;
  if (day.ranges.length === 0) out.day = 'Thêm ít nhất một khung giờ hoặc chọn "Nghỉ"';
  if (day.ranges.length > MAX_RANGES_PER_DAY) out.day = `Tối đa ${MAX_RANGES_PER_DAY} khung giờ mỗi ngày`;

  day.ranges.forEach((r, i) => {
    if (!HHMM.test(r.start) || !HHMM.test(r.end)) out.ranges[i] = 'Nhập giờ dạng HH:MM';
    else if (r.start >= r.end) out.ranges[i] = 'Giờ bắt đầu phải trước giờ kết thúc';
  });

  // Chồng lấn: so từng cặp hợp lệ, báo ở khung bắt đầu muộn hơn.
  const valid = day.ranges
    .map((r, i) => ({ ...r, i }))
    .filter((r) => out.ranges[r.i] === null)
    .sort((a, b) => a.start.localeCompare(b.start));
  for (let k = 1; k < valid.length; k += 1) {
    const prev = valid[k - 1]!;
    const cur = valid[k]!;
    if (cur.start < prev.end) out.ranges[cur.i] = `Chồng lên khung ${prev.start}–${prev.end}`;
  }
  return out;
}

export function validateDraft(draft: BusinessHoursDraft): {
  days: Record<Weekday, DayValidation>;
  hasErrors: boolean;
} {
  const days = {} as Record<Weekday, DayValidation>;
  let hasErrors = false;
  for (const d of WEEKDAYS) {
    days[d] = validateDay(draft.days[d]);
    if (days[d].day || days[d].ranges.some(Boolean)) hasErrors = true;
  }
  if (!draft.timezone) hasErrors = true;
  return { days, hasErrors };
}

/** Khung giờ mới thêm vào cuối: bắt đầu 1 giờ sau khung cuối, dài 2 giờ (không vượt 23:59). */
export function nextRange(ranges: readonly TimeRange[]): TimeRange {
  if (ranges.length === 0) return { ...DEFAULT_RANGE };
  const lastEnd = Math.max(...ranges.map((r) => toMinutes(r.end)));
  const start = Math.min(lastEnd + 60, 22 * 60);
  return { start: fromMinutes(start), end: fromMinutes(Math.min(start + 120, 23 * 60 + 59)) };
}

export function addRange(day: DayDraft): DayDraft {
  if (day.ranges.length >= MAX_RANGES_PER_DAY) return day;
  return { closed: false, ranges: [...day.ranges, nextRange(day.ranges)] };
}

export function removeRange(day: DayDraft, index: number): DayDraft {
  const ranges = day.ranges.filter((_, i) => i !== index);
  // Xóa khung cuối cùng => coi như nghỉ (giữ một khung mặc định để mở lại).
  return ranges.length === 0 ? { closed: true, ranges: [{ ...DEFAULT_RANGE }] } : { ...day, ranges };
}

export function updateRange(day: DayDraft, index: number, patch: Partial<TimeRange>): DayDraft {
  return { ...day, ranges: day.ranges.map((r, i) => (i === index ? { ...r, ...patch } : r)) };
}

export function setClosed(day: DayDraft, closed: boolean): DayDraft {
  return { closed, ranges: day.ranges.length ? day.ranges : [{ ...DEFAULT_RANGE }] };
}

/** Sao chép giờ của một ngày sang mọi ngày (bản sao sâu). */
export function copyDayToAll(draft: BusinessHoursDraft, from: Weekday): BusinessHoursDraft {
  const src = draft.days[from];
  const days = {} as Record<Weekday, DayDraft>;
  for (const d of WEEKDAYS) days[d] = { closed: src.closed, ranges: src.ranges.map((r) => ({ ...r })) };
  return { ...draft, days };
}

/** "08:00–12:00, 13:30–17:30" hoặc "Nghỉ". */
export function summarizeDay(day: DayDraft): string {
  if (day.closed || day.ranges.length === 0) return 'Nghỉ';
  return [...day.ranges]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((r) => `${r.start}–${r.end}`)
    .join(', ');
}

export function isDraftDirty(draft: BusinessHoursDraft, saved: BusinessHours | undefined): boolean {
  if (!saved) return false;
  return JSON.stringify(fromDraft(draft)) !== JSON.stringify(fromDraft(toDraft(saved)));
}

/** Múi giờ hay dùng (đặt Việt Nam lên đầu). Giá trị đang lưu ngoài danh sách vẫn được giữ. */
export const COMMON_TIMEZONES: { value: string; label: string }[] = [
  { value: 'Asia/Ho_Chi_Minh', label: 'Việt Nam (GMT+7, Asia/Ho_Chi_Minh)' },
  { value: 'Asia/Bangkok', label: 'Thái Lan (GMT+7, Asia/Bangkok)' },
  { value: 'Asia/Singapore', label: 'Singapore (GMT+8)' },
  { value: 'Asia/Shanghai', label: 'Trung Quốc (GMT+8)' },
  { value: 'Asia/Tokyo', label: 'Nhật Bản (GMT+9)' },
  { value: 'Asia/Seoul', label: 'Hàn Quốc (GMT+9)' },
  { value: 'Australia/Sydney', label: 'Úc – Sydney' },
  { value: 'Europe/London', label: 'Anh – London' },
  { value: 'Europe/Berlin', label: 'Đức – Berlin' },
  { value: 'America/New_York', label: 'Mỹ – New York' },
  { value: 'America/Los_Angeles', label: 'Mỹ – Los Angeles' },
  { value: 'UTC', label: 'UTC' },
];

export function timezoneOptions(current: string): { value: string; label: string }[] {
  if (!current || COMMON_TIMEZONES.some((t) => t.value === current)) return COMMON_TIMEZONES;
  return [{ value: current, label: current }, ...COMMON_TIMEZONES];
}
