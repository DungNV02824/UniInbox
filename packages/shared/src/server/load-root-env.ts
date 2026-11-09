import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/** Tìm thư mục gốc monorepo (chứa pnpm-workspace.yaml) bằng cách đi ngược lên từ `start`. */
export function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Nạp `<repo root>/.env` vào process.env (trừ khi NODE_ENV=test).
 * process.loadEnvFile KHÔNG ghi đè biến đã có sẵn, nên biến môi trường thật luôn được ưu tiên.
 * Trả về đường dẫn file đã nạp, hoặc null.
 */
export function loadRootEnv(): string | null {
  if (process.env.NODE_ENV === 'test') return null;
  const starts = [process.cwd()];
  if (typeof __dirname !== 'undefined') starts.push(__dirname);
  for (const start of starts) {
    const root = findRepoRoot(start);
    if (!root) continue;
    const file = join(root, '.env');
    if (!existsSync(file)) continue;
    process.loadEnvFile(file);
    return file;
  }
  return null;
}
