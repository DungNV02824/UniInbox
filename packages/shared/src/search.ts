// Chuẩn hóa chuỗi tìm kiếm tiếng Việt: bỏ dấu, đ → d, chữ thường, gộp khoảng trắng.
// Dùng chung cho máy chủ (tham số `q` + SQL translate) và web (lọc lại hội thoại realtime).

/** Ký tự có dấu (chữ thường, NFC) → ký tự không dấu tương ứng — cùng độ dài, dùng cho SQL translate(). */
export const VN_ACCENTED_CHARS = 'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ';
export const VN_PLAIN_CHARS = [...VN_ACCENTED_CHARS]
  .map((c) => (c === 'đ' ? 'd' : c.normalize('NFD').replace(/\p{M}/gu, '')))
  .join('');

/** Độ dài tối đa của từ khóa tìm kiếm. */
export const SEARCH_QUERY_MAX = 100;

/** "  Đúng   VĂN " → "dung van". */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Giữ dấu: NFC, chữ thường, gộp khoảng trắng. */
export function foldSearchText(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Cách so khớp cho từ khóa: gõ KHÔNG dấu ⇒ so dạng bỏ dấu ("dung" khớp "Đúng", "dụng"); gõ CÓ dấu ⇒ so
 * đúng dấu (không phân biệt hoa thường) để "Đúng" không ra cả "xây dựng".
 */
export function searchMode(query: string): { accented: boolean; term: string } {
  const folded = foldSearchText(query);
  const plain = normalizeSearchText(query);
  return folded === plain ? { accented: false, term: plain } : { accented: true, term: folded };
}

/** Chuỗi `haystack` có chứa từ khóa không (theo searchMode). */
export function matchesSearch(haystack: string | null | undefined, query: string): boolean {
  const { accented, term } = searchMode(query);
  if (!term) return true;
  const text = haystack ?? '';
  return (accented ? foldSearchText(text) : normalizeSearchText(text)).includes(term);
}
