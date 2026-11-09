import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn()', () => {
  it('gộp class và bỏ giá trị falsy', () => {
    const hidden = false;
    expect(cn('a', hidden && 'b', undefined, null, 'c')).toBe('a c');
  });

  it('hỗ trợ object và mảng', () => {
    expect(cn(['a', { b: true, c: false }])).toBe('a b');
  });

  it('class Tailwind sau thắng class xung đột trước', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
    expect(cn('flex', 'hidden')).toBe('hidden');
    expect(cn('text-sm text-muted-foreground', 'text-brand')).toBe('text-sm text-brand');
  });
});
