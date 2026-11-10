import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from './rate-limiter';

describe('SlidingWindowLimiter', () => {
  it('chặn khi vượt giới hạn trong cửa sổ, mở lại khi cửa sổ trôi qua; mỗi khóa đếm riêng', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(2, 60_000, () => now);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    expect(limiter.take('b')).toBe(true);
    now = 60_000;
    expect(limiter.take('a')).toBe(true);
  });
});
