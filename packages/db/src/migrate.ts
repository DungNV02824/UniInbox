import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createDb } from './client';

/** Thư mục migration SQL; đúng cả khi chạy từ src (tsx) lẫn dist. */
export const MIGRATIONS_FOLDER = path.resolve(__dirname, '../drizzle');
/** Migration ngược: drizzle/down/<tag>.sql, cùng tên với migration xuôi. */
export const DOWN_MIGRATIONS_FOLDER = path.join(MIGRATIONS_FOLDER, 'down');

/** Chạy mọi migration chưa áp dụng. Chạy lại nhiều lần là an toàn (no-op). */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const { db, close } = createDb(databaseUrl, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await close();
  }
}

/**
 * Chạy migration ngược theo thứ tự giảm dần, mỗi file trong một transaction.
 * XÓA DỮ LIỆU — chỉ dùng cho dev/test. `steps` mặc định: tất cả.
 */
export async function rollbackMigrations(databaseUrl: string, steps = Infinity): Promise<string[]> {
  const files = (await readdir(DOWN_MIGRATIONS_FOLDER))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse()
    .slice(0, steps);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const file of files) {
      const sqlText = await readFile(path.join(DOWN_MIGRATIONS_FOLDER, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return files;
}
