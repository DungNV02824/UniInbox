import { describe, expect, it } from 'vitest';
import { enterSends } from './composer-keys';

const enter = { key: 'Enter', shiftKey: false, isComposing: false };

describe('enterSends', () => {
  it('máy tính: Enter gửi, Shift+Enter xuống dòng', () => {
    expect(enterSends(enter, false)).toBe(true);
    expect(enterSends({ ...enter, shiftKey: true }, false)).toBe(false);
  });

  it('đang gõ dấu bằng bộ gõ: không gửi', () => {
    expect(enterSends({ ...enter, isComposing: true }, false)).toBe(false);
  });

  it('màn hình cảm ứng: Enter luôn xuống dòng', () => {
    expect(enterSends(enter, true)).toBe(false);
  });

  it('phím khác không gửi', () => {
    expect(enterSends({ ...enter, key: 'a' }, false)).toBe(false);
  });
});
