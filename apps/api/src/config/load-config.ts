import { loadEnv, loadRootEnv } from '@dezon/shared/server';
import type { AppConfig } from './config.constants';

/**
 * Nạp `.env` ở gốc repo (trừ khi NODE_ENV=test) rồi validate bằng Zod.
 * Env sai => in lỗi dễ đọc (không in giá trị secret) và thoát process với mã 1.
 */
export function loadAppConfig(): AppConfig {
  loadRootEnv();
  try {
    return Object.freeze(loadEnv(process.env));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n[api] Không khởi động được — ${message}\n\n`);
    return process.exit(1);
  }
}
