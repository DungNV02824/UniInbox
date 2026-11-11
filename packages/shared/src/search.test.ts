import { describe, expect, it } from 'vitest';
import { listConversationsQuerySchema } from './inbox';
import { matchesSearch, normalizeSearchText, searchMode, VN_ACCENTED_CHARS, VN_PLAIN_CHARS } from './search';

describe('tìm kiếm tiếng Việt', () => {
  it('bảng translate cùng độ dài, chỉ còn chữ không dấu', () => {
    expect([...VN_PLAIN_CHARS]).toHaveLength([...VN_ACCENTED_CHARS].length);
    expect(VN_PLAIN_CHARS).toMatch(/^[aeiouyd]+$/);
  });

  it('bỏ dấu, đ → d, chữ thường, gộp khoảng trắng (cả chuỗi NFD)', () => {
    expect(normalizeSearchText('  Đúng   VĂN ')).toBe('dung van');
    expect(normalizeSearchText('Lê Hồ Minh Khôi'.normalize('NFD'))).toBe('le ho minh khoi');
    expect(normalizeSearchText('Nguyễn Hữu Nguyên')).toBe('nguyen huu nguyen');
  });

  it('matchesSearch: có dấu / không dấu đều khớp; từ khóa rỗng = khớp', () => {
    expect(matchesSearch('Đúng Văn', 'dung van')).toBe(true);
    expect(matchesSearch('Đúng Văn', 'ĐÚNG')).toBe(true);
    expect(matchesSearch('Đúng Văn', 'khoi')).toBe(false);
    expect(matchesSearch(null, 'a')).toBe(false);
    expect(matchesSearch('x', '   ')).toBe(true);
  });

  it('gõ có dấu ⇒ so đúng dấu (không ra "dựng" khi tìm "Đúng")', () => {
    expect(searchMode('Đúng  Văn')).toEqual({ accented: true, term: 'đúng văn' });
    expect(searchMode('Dung Van')).toEqual({ accented: false, term: 'dung van' });
    expect(matchesSearch('Xây dựng nhà', 'Đúng')).toBe(false);
    expect(matchesSearch('Xây dựng nhà', 'dung')).toBe(true);
    expect(matchesSearch('ĐÚNG VĂN', 'đúng')).toBe(true);
  });

  it('tham số q: cắt khoảng trắng, rỗng ⇒ bỏ, quá dài ⇒ lỗi', () => {
    expect(listConversationsQuerySchema.parse({ q: '  van ' }).q).toBe('van');
    expect(listConversationsQuerySchema.parse({ q: '   ' }).q).toBeUndefined();
    expect(listConversationsQuerySchema.safeParse({ q: 'a'.repeat(101) }).success).toBe(false);
  });
});
