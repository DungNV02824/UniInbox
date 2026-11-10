import { describe, expect, it } from 'vitest';
import { TAG_COLORS } from '@dezon/shared';
import {
  isTagColor,
  LEGACY_TAG_CHIP_CLASS,
  TAG_CHIP_CLASSES,
  TAG_SWATCH_CLASSES,
  tagChipClass,
  tagSwatchClass,
} from './tag-colors';

describe('tag colours', () => {
  it('có lớp chip + ô màu cho đủ 10 màu, không trùng nhau', () => {
    for (const c of TAG_COLORS) {
      expect(TAG_CHIP_CLASSES[c]).toMatch(/bg-/);
      expect(TAG_CHIP_CLASSES[c]).toMatch(/dark:/);
      expect(TAG_SWATCH_CLASSES[c]).toMatch(/^bg-/);
    }
    expect(new Set(Object.values(TAG_CHIP_CLASSES)).size).toBe(TAG_COLORS.length);
    expect(new Set(Object.values(TAG_SWATCH_CLASSES)).size).toBe(TAG_COLORS.length);
  });

  it('màu hợp lệ dùng bảng màu, màu lạ/null về kiểu nhãn cũ', () => {
    expect(tagChipClass('blue')).toBe(TAG_CHIP_CLASSES.blue);
    expect(tagChipClass(null)).toBe(LEGACY_TAG_CHIP_CLASS);
    expect(tagChipClass('magenta')).toBe(LEGACY_TAG_CHIP_CLASS);
    expect(tagChipClass(undefined)).toBe(LEGACY_TAG_CHIP_CLASS);
    expect(tagSwatchClass('red')).toBe('bg-red-500');
    expect(tagSwatchClass('??')).not.toBe(tagSwatchClass('gray'));
    // Nhãn cũ khác nhãn màu "Xám".
    expect(LEGACY_TAG_CHIP_CLASS).not.toBe(TAG_CHIP_CLASSES.gray);
  });

  it('isTagColor', () => {
    expect(isTagColor('pink')).toBe(true);
    expect(isTagColor('Pink')).toBe(false);
    expect(isTagColor(3)).toBe(false);
  });
});
