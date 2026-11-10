import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rollbackMigrations, runMigrations } from '../src';

const EXPECTED_TABLES = [
  'ai_runs',
  'ai_suggestions',
  'app_settings',
  'audit_logs',
  'catalog_items',
  'channel_accounts',
  'chatbots',
  'contact_identities',
  'contact_tags',
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

/** app_settings dùng `key` text làm khóa chính (không có cột id). */
const TABLES_WITHOUT_ID = new Set(['app_settings']);

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

  it('tạo đủ 15 bảng của mục 5 + chatbots, app_settings', async () => {
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
      if (!TABLES_WITHOUT_ID.has(table)) {
        expect(cols.find((c) => c.column_name === 'id')?.data_type, `${table}.id`).toBe('uuid');
      }
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
      '0007_contact_tags.sql',
      '0006_response_speed.sql',
      '0005_escalate_when_unsure.sql',
      '0004_chatbots.sql',
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

  it('0007: rollback gỡ contact_tags, giữ contacts.tags; chạy lại seed nhãn sẵn có (bỏ trùng hoa thường)', async () => {
    expect(await rollbackMigrations(url, 1)).toEqual(['0007_contact_tags.sql']);
    expect(await publicTables()).toEqual(EXPECTED_TABLES.filter((t) => t !== 'contact_tags'));
    await query(
      `insert into contacts (display_name, tags, created_at) values
       ('Khách A', '{VIP,Sofa}', now() - interval '2 day'),
       ('Khách B', '{vip," Giường ",sofa}', now() - interval '1 day'),
       ('Khách C', '{}', now())`,
    );
    await runMigrations(url);
    const rows = await query<{ name: string; color: string; sort_order: number; created_by: string | null }>(
      'select name, color, sort_order, created_by from contact_tags order by sort_order',
    );
    expect(rows).toEqual([
      { name: 'Giường', color: 'blue', sort_order: 0, created_by: null },
      { name: 'Sofa', color: 'blue', sort_order: 1, created_by: null },
      { name: 'VIP', color: 'blue', sort_order: 2, created_by: null },
    ]);
    // Unique không phân biệt hoa thường; màu ngoài danh sách bị CHECK chặn.
    await expect(query("insert into contact_tags (name) values ('sofa')")).rejects.toThrow(
      /contact_tags_name_lower_unique/,
    );
    await expect(query("insert into contact_tags (name, color) values ('Mới', 'black')")).rejects.toThrow(
      /contact_tags_color_check/,
    );
    await query("delete from contacts where display_name in ('Khách A', 'Khách B', 'Khách C')");
    await query('delete from contact_tags');
  });

  it('rollback hai bước (0007, 0006) gỡ cột response_speed và CHECK, giữ bot và dữ liệu', async () => {
    const col =
      "select count(*)::int as n from information_schema.columns where table_name = 'chatbots' and column_name = 'response_speed'";
    const chk =
      "select count(*)::int as n from pg_constraint where conname = 'chatbots_response_speed_check'";
    await query("insert into chatbots (name) values ('Bot tốc độ')");
    expect((await query<{ n: number }>(col))[0]?.n).toBe(1);
    expect((await query<{ n: number }>(chk))[0]?.n).toBe(1);
    expect(await rollbackMigrations(url, 2)).toEqual(['0007_contact_tags.sql', '0006_response_speed.sql']);
    expect((await query<{ n: number }>(col))[0]?.n).toBe(0);
    expect((await query<{ n: number }>(chk))[0]?.n).toBe(0);
    expect(await query("select name from chatbots where name = 'Bot tốc độ'")).toHaveLength(1);
    await runMigrations(url);
    // Bot có sẵn nhận mặc định 'fast' khi chạy xuôi lại.
    expect(await query("select response_speed from chatbots where name = 'Bot tốc độ'")).toEqual([
      { response_speed: 'fast' },
    ]);
    await query("delete from chatbots where name = 'Bot tốc độ'");
  });

  it('rollback ba bước (0007..0005) gỡ cột escalate_when_unsure, giữ bot và dữ liệu', async () => {
    const col =
      "select count(*)::int as n from information_schema.columns where table_name = 'chatbots' and column_name = 'escalate_when_unsure'";
    await query("insert into chatbots (name) values ('Bot giữ lại')");
    expect((await query<{ n: number }>(col))[0]?.n).toBe(1);
    expect(await rollbackMigrations(url, 3)).toEqual([
      '0007_contact_tags.sql',
      '0006_response_speed.sql',
      '0005_escalate_when_unsure.sql',
    ]);
    expect((await query<{ n: number }>(col))[0]?.n).toBe(0);
    expect(await query("select name from chatbots where name = 'Bot giữ lại'")).toHaveLength(1);
    await runMigrations(url);
    expect((await query<{ n: number }>(col))[0]?.n).toBe(1);
    expect(await query("select escalate_when_unsure from chatbots where name = 'Bot giữ lại'")).toEqual([
      { escalate_when_unsure: true },
    ]);
    await query("delete from chatbots where name = 'Bot giữ lại'");
  });

  it('rollback bốn bước (0007..0004) gỡ chatbots, app_settings và 3 cột FK, giữ bảng khác', async () => {
    const cols = `select table_name, column_name from information_schema.columns
       where (table_name = 'conversations' and column_name = 'chatbot_id')
          or (table_name = 'channel_accounts' and column_name = 'default_chatbot_id')
          or (table_name = 'ai_runs' and column_name = 'chatbot_id')
       order by table_name`;
    expect(await query<{ table_name: string; column_name: string }>(cols)).toEqual([
      { table_name: 'ai_runs', column_name: 'chatbot_id' },
      { table_name: 'channel_accounts', column_name: 'default_chatbot_id' },
      { table_name: 'conversations', column_name: 'chatbot_id' },
    ]);
    const fks = await query<{ conname: string; confdeltype: string }>(
      `select conname, confdeltype from pg_constraint where conname in
       ('conversations_chatbot_id_chatbots_id_fk', 'channel_accounts_default_chatbot_id_chatbots_id_fk',
        'ai_runs_chatbot_id_chatbots_id_fk')
       order by conname`,
    );
    // 'n' = ON DELETE SET NULL
    expect(fks).toEqual([
      { conname: 'ai_runs_chatbot_id_chatbots_id_fk', confdeltype: 'n' },
      { conname: 'channel_accounts_default_chatbot_id_chatbots_id_fk', confdeltype: 'n' },
      { conname: 'conversations_chatbot_id_chatbots_id_fk', confdeltype: 'n' },
    ]);

    expect(await rollbackMigrations(url, 4)).toEqual([
      '0007_contact_tags.sql',
      '0006_response_speed.sql',
      '0005_escalate_when_unsure.sql',
      '0004_chatbots.sql',
    ]);
    expect(await query(cols)).toEqual([]);
    expect(await publicTables()).toEqual(
      EXPECTED_TABLES.filter((t) => t !== 'chatbots' && t !== 'app_settings' && t !== 'contact_tags'),
    );
    await runMigrations(url);
    expect(await publicTables()).toEqual(EXPECTED_TABLES);
    expect(await query(cols)).toHaveLength(3);
  });

  it('chatbots: tên unique, giá trị mặc định đúng đặc tả', async () => {
    const rows = await query<{
      is_active: boolean;
      temperature: number;
      reply_delay_sec: number;
      max_wait_sec: number;
      max_replies_per_hour: number;
      escalate_when_unsure: boolean;
      response_speed: string;
      examples: unknown;
      handoff_keywords: string[];
    }>(
      `insert into chatbots (name) values ('Bot mặc định')
       returning is_active, temperature, reply_delay_sec, max_wait_sec, max_replies_per_hour, escalate_when_unsure, response_speed, examples, handoff_keywords`,
    );
    expect(rows[0]).toEqual({
      is_active: true,
      temperature: 0.4,
      reply_delay_sec: 10,
      max_wait_sec: 45,
      max_replies_per_hour: 20,
      escalate_when_unsure: true,
      response_speed: 'fast',
      examples: [],
      handoff_keywords: [],
    });
    await expect(query("insert into chatbots (name) values ('Bot mặc định')")).rejects.toThrow();
    await expect(
      query("insert into chatbots (name, response_speed) values ('Bot sai tốc độ', 'turbo')"),
    ).rejects.toThrow(/chatbots_response_speed_check/);
    await query("delete from chatbots where name = 'Bot mặc định'");
  });

  it('rollback năm bước (0007..0003) gỡ thêm cột client_id, giữ bảng và dữ liệu', async () => {
    const col =
      "select count(*)::int as n from information_schema.columns where table_name = 'messages' and column_name = 'client_id'";
    expect((await query<{ n: number }>(col))[0]?.n).toBe(1);
    expect(await rollbackMigrations(url, 5)).toEqual([
      '0007_contact_tags.sql',
      '0006_response_speed.sql',
      '0005_escalate_when_unsure.sql',
      '0004_chatbots.sql',
      '0003_message_client_id.sql',
    ]);
    expect((await query<{ n: number }>(col))[0]?.n).toBe(0);
    await runMigrations(url);
    expect((await query<{ n: number }>(col))[0]?.n).toBe(1);
    expect(await publicTables()).toEqual(EXPECTED_TABLES);
  });

  it('rollback sáu bước (0007..0002) gỡ thêm FK ghép, giữ bảng gốc và dữ liệu', async () => {
    const fk =
      "select count(*)::int as n from pg_constraint where conname = 'messages_conversation_channel_account_fk'";
    expect((await query<{ n: number }>(fk))[0]?.n).toBe(1);
    expect(await rollbackMigrations(url, 6)).toEqual([
      '0007_contact_tags.sql',
      '0006_response_speed.sql',
      '0005_escalate_when_unsure.sql',
      '0004_chatbots.sql',
      '0003_message_client_id.sql',
      '0002_message_channel_matches_conversation.sql',
    ]);
    expect((await query<{ n: number }>(fk))[0]?.n).toBe(0);
    await runMigrations(url);
    expect((await query<{ n: number }>(fk))[0]?.n).toBe(1);
    expect(await publicTables()).toEqual(EXPECTED_TABLES);
  });

  it('rollback bảy bước giữ extension và cho phép chạy lại 0001', async () => {
    await rollbackMigrations(url, 7);
    expect(await publicTables()).toEqual([]);
    expect(await vectorInstalled()).toBe(true);
    await runMigrations(url);
    expect(await publicTables()).toEqual(EXPECTED_TABLES);
  });
});
