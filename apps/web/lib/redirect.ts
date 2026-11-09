const BASE = 'http://dezon.invalid';
// Ký tự điều khiển: trình phân tích URL (WHATWG) tự bỏ TAB/CR/LF nên '/\t/evil.com' thành '//evil.com'.
const UNSAFE_CHARS = /[\u0000-\u001F\u007F\\]/;

/** Chỉ chấp nhận đường dẫn nội bộ (chống open redirect qua ?next=). */
export function safeNextPath(next: string | null | undefined, fallback = '/inbox'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || UNSAFE_CHARS.test(next)) return fallback;
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;
  if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
