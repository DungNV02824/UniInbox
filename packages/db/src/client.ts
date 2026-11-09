import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;

export interface CreateDbOptions {
  /** Số kết nối tối đa của pool (mặc định 10). */
  max?: number;
  /**
   * Lỗi của kết nối đang rảnh trong pool (Postgres restart, failover, bị ngắt...). Pool luôn có
   * listener 'error' để process không chết vì EventEmitter ném lỗi; mặc định ghi console.error
   * (nếu không có listener nào khác).
   */
  onError?: (error: Error) => void;
}

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

const defaultOnError = (error: Error) => {
  console.error('[db] Lỗi kết nối Postgres trong pool:', error.message);
};

export function createDb(databaseUrl: string, opts: CreateDbOptions = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: opts.max ?? 10 });
  pool.on('error', (error: Error) => {
    if (opts.onError) opts.onError(error);
    // Chỉ ghi mặc định khi không ai khác nghe (người dùng có thể tự gắn qua handle.pool.on('error')).
    else if (pool.listenerCount('error') <= 1) defaultOnError(error);
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
