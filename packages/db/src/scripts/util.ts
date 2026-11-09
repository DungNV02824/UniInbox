/** Mô tả DB để log, KHÔNG kèm mật khẩu. */
export function describeDatabase(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(DATABASE_URL không hợp lệ)';
  }
}
