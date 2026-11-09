import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rollbackMigrations, runMigrations } from '../src';

const EXPECTED_TABLES = [
  'ai_runs',
  'ai_suggestions',
  'audit_logs',
  'catalog_items',
  'channel_accounts',
  'contact_identities',
  'contacts',
  'conversations',
  'customer_memories',
  'handoffs',
  'knowledge_chunks',
  'knowledge_documents',
  'messages',
  'style_examples',
  'users',
];

let container: StartedPostgreSqlContainer;
let url: string;

async function query<T extends pg.QueryResultRow>(text: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

const publicTables = async () =>
  (
    await query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    )
  ).map((r) => r.tablename);

const vectorInstalled = async () =>
  (await query<{ n: number }>("select count(*)::int as n from pg_extension where extname = 'vector'"))[0]
    ?.n === 1;

const appliedCount = async () =>
  (await query<{ n: number }>('select count(*)::int as n from drizzle.__drizzle_migrations'))[0]?.n;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  url = container.getConnectionUri();
});

afterAll(async () => {
  await container?.stop();
});

describe('migrations', () => {
  it('chạy sạch trên DB trống', async () => {
    expect(await publicTables()).toEqual([]);
    expect(await vectorInstalled()).toBe(false);
    await runMigrations(url);
  });

  it('bật extension vector', async () => {
    expect(await vectorInstalled()).toBe(true);
  });

  it('tạo đủ 15 bảng của mục 5', async () => {
    expect(await publicTables()).toEqual(EXPECTED_TABLES);
  });

  it('có index HNSW vector_cosine_ops trên knowledge_chunks, catalog_items, style_examples', async () => {
    const rows = await query<{ tablename: string; indexdef: string }>(
      "select tablename, indexdef from pg_indexes where schemaname = 'public' and indexdef ilike '%using hnsw%'",
    );
    const byTable = new Map(rows.map((r) => [r.tablename, r.indexdef]));
    for (const table of ['knowledge_chunks', 'catalog_items', 'style_examples']) {
      expect(byTable.get(table)).toMatch(/vector_cosine_ops/);
    }
  });

  it('mọi bảng có id uuid, created_at, updated_at timestamptz NOT NULL', async () => {
    const rows = await query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `select table_name, column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and column_name in ('id', 'created_at', 'updated_at')`,
    );
    for (const table of EXPECTED_TABLES) {
      const cols = rows.filter((r) => r.table_name === table);
      expect(cols.find((c) => c.column_name === 'id')?.data_type).toBe('uuid');
      for (const name of ['created_at', 'updated_at']) {
        const col = cols.find((c) => c.column_name === name);
        expect(col?.data_type, `${table}.${name}`).toBe('timestamp with time zone');
        expect(col?.is_nullable).toBe('NO');
      }
    }
  });

  it('chạy lại lần hai là no-op', async () => {
    const before = await appliedCount();
    await runMigrations(url);
    expect(await appliedCount()).toBe(before);
    expect(await publicTables()).toEqual(EXPECTED_TABLES);
  });

  it('migration ngược xóa sạch, sau đó chạy xuôi lại được', async () => {
    const files = await rollbackMigrations(url);
    expect(files).toEqual([
      '0003_message_client_id.sql',
      '0002_message_channel_matches_conversation.sql',
      '0001_init_schema.sql',
      '0000_enable_extensions.sql',
    ]);
    expect(await publicTables()).toEqual([]);
    expect(await vectorInstalled()).toBe(false);
    const types = await query<{ typname: string }>(
      "select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype = 'e'",
    );
    expect(types).toEqual([]);

    await runMigrations(url);
    expect(await publicTables()).toEqual(EXPECTED_TABLES);
    expect(await vectorInstalled()).toBe(true);
  });

  it('rollback một bước (0003) chỉ gỡ cột client_id, giữ bảng và dữ liệu', async () => {
    const col =
      "select count(*)::int as n from information_schema.columns where table_name = 'messages' and column_name = 'client_id'";
    expect((await query<{ n: number }>(col))[0]?.n).toBe(1);
    expect(await rollbackMigrations(url, 1)).toEqual(['0003_message_client_id.sql']);
    expect((await query<{ n: number }>(col))[0]?.n).toBe(0);
    expect(await publicTables()).toEqual(EXPECTED_TABLES);
    await runMigrations(url);
    expect((await query<{ n: number }>(col))[0]?.n).toBe(1);
  });

  it('rollback hai bước (0003, 0002) gỡ thêm FK ghép, giữ bảng và dữ liệu', async () => {
    const fk =
      "select count(*)::int as n from pg_constraint where conname = 'messages_conversation_channel_account_fk'";
    expect((await query<{ n: number }>(fk))[0]?.n).toBe(1);
    expect(await rollbackMigrations(url, 2)).toEqual([
      '0003_message_client_id.sql',
      '0002_message_channel_matches_conversation.sql',
    ]);
    expect((await query<{ n: number }>(fk))[0]?.n).toBe(0);
    expect(await publicTables()).toEqual(EXPECTED_TABLES);
    await runMigrations(url);
    expect((await query<{ n: number }>(fk))[0]?.n).toBe(1);
  });

  it('rollback ba bước giữ extension và cho phép chạy lại 0001', async () => {
    await rollbackMigrations(url, 3);
    expect(await publicTables()).toEqual([]);
    expect(await vectorInstalled()).toBe(true);
    await runMigrations(url);
    expect(await publicTables()).toEqual(EXPECTED_TABLES);
  });
});
