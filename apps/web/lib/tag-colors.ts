// Màu nhãn khách → lớp Tailwind (chuỗi viết nguyên văn để Tailwind quét được).
import { TAG_COLORS, type TagColor } from '@dezon/shared';

/** Chip nhãn (nền/chữ/viền) — sáng + tối. */
export const TAG_CHIP_CLASSES: Record<TagColor, string> = {
  gray: 'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200',
  red: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/50 dark:text-red-300',
  orange:
    'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/70 dark:bg-orange-950/50 dark:text-orange-300',
  amber:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-300',
  green:
    'border-green-200 bg-green-50 text-green-700 dark:border-green-900/70 dark:bg-green-950/50 dark:text-green-300',
  teal: 'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900/70 dark:bg-teal-950/50 dark:text-teal-300',
  blue: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/70 dark:bg-blue-950/50 dark:text-blue-300',
  indigo:
    'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900/70 dark:bg-indigo-950/50 dark:text-indigo-300',
  purple:
    'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-900/70 dark:bg-purple-950/50 dark:text-purple-300',
  pink: 'border-pink-200 bg-pink-50 text-pink-700 dark:border-pink-900/70 dark:bg-pink-950/50 dark:text-pink-300',
};

/** Ô màu đặc (bảng chọn màu, chấm màu). */
export const TAG_SWATCH_CLASSES: Record<TagColor, string> = {
  gray: 'bg-slate-500',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-400',
  green: 'bg-green-500',
  teal: 'bg-teal-500',
  blue: 'bg-blue-500',
  indigo: 'bg-indigo-500',
  purple: 'bg-purple-500',
  pink: 'bg-pink-500',
};

/** Nhãn cũ không có trong danh sách (hoặc màu lạ): xám, viền nét đứt để phân biệt với nhãn màu "Xám". */
export const LEGACY_TAG_CHIP_CLASS =
  'border-dashed border-slate-300 bg-muted text-muted-foreground dark:border-slate-600';

export const LEGACY_TAG_SWATCH_CLASS = 'bg-slate-300 dark:bg-slate-600';

export function isTagColor(value: unknown): value is TagColor {
  return typeof value === 'string' && (TAG_COLORS as readonly string[]).includes(value);
}

/** Lớp chip theo màu; null/không hợp lệ = kiểu nhãn cũ (xám nét đứt). */
export function tagChipClass(color: string | null | undefined): string {
  return isTagColor(color) ? TAG_CHIP_CLASSES[color] : LEGACY_TAG_CHIP_CLASS;
}

export function tagSwatchClass(color: string | null | undefined): string {
  return isTagColor(color) ? TAG_SWATCH_CLASSES[color] : LEGACY_TAG_SWATCH_CLASS;
}
