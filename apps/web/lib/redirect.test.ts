import { describe, expect, it } from 'vitest';
import { safeNextPath } from './redirect';

describe('safeNextPath()', () => {
  it('giữ đường dẫn nội bộ', () => {
    expect(safeNextPath('/inbox?c=1')).toBe('/inbox?c=1');
    expect(safeNextPath('/inbox?c=1#m2')).toBe('/inbox?c=1#m2');
  });

  it('chặn URL ngoài và giá trị rỗng', () => {
    expect(safeNextPath(null)).toBe('/inbox');
    expect(safeNextPath('')).toBe('/inbox');
    expect(safeNextPath('https://evil.example')).toBe('/inbox');
    expect(safeNextPath('//evil.example')).toBe('/inbox');
    expect(safeNextPath('/\\evil.example')).toBe('/inbox');
    expect(safeNextPath('/login?next=/inbox')).toBe('/inbox');
  });

  it('chặn ký tự điều khiển mà trình phân tích URL tự bỏ (TAB, LF, CR)', () => {
    expect(safeNextPath('/\t/evil.example')).toBe('/inbox');
    expect(safeNextPath('/\n/evil.example')).toBe('/inbox');
    expect(safeNextPath('/\r/evil.example')).toBe('/inbox');
    // Giá trị ?next=/%09/evil.example sau khi URLSearchParams giải mã.
    expect(safeNextPath(new URLSearchParams('next=/%09/evil.example').get('next'))).toBe('/inbox');
  });

  it('chặn /login dù viết dạng chuẩn hóa', () => {
    expect(safeNextPath('/./login')).toBe('/inbox');
    expect(safeNextPath('/inbox/../login')).toBe('/inbox');
  });
});
