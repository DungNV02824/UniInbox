// Hạ tầng cho test e2e: Postgres (pgvector) + Redis bằng Testcontainers. Không dùng .env hay docker-compose.
import { randomBytes } from 'node:crypto';
import { createDb, hashPassword, runMigrations, seedUsers, users } from '@dezon/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

export const ADMIN = { email: 'admin@test.dezon.vn', password: 'Admin@12345', name: 'Admin Test' };
export const AGENT = { email: 'sale@test.dezon.vn', password: 'Sale@12345', name: 'Sale Test' };
export const INACTIVE = { email: 'nghiviec@test.dezon.vn', password: 'Inactive@123', name: 'Đã nghỉ' };

/** Cấu hình Meta giả cho test webhook (không gọi Graph API thật). */
export const META = { appId: '1234567890', appSecret: 'test-app-secret', verifyToken: 'test-verify-token' };

export interface TestInfra {
  databaseUrl: string;
  redisUrl: string;
  stop(): Promise<void>;
}

/** Đặt process.env cho app TRƯỚC khi createApp() đọc env. */
export function applyTestEnv(databaseUrl: string, redisUrl: string): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    JWT_SECRET: randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '30d',
    APP_URL: 'http://localhost:3100',
    FEATURE_AI_ENABLED: '',
    ZALO_PERSONAL_ENABLED: '',
    META_APP_ID: META.appId,
    META_APP_SECRET: META.appSecret,
    META_VERIFY_TOKEN: META.verifyToken,
    META_GRAPH_VERSION: 'v24.0',
    META_HUMAN_AGENT_ENABLED: '',
    // Không dùng S3 thật trong test: test cần lưu trữ thì truyền MediaStorage trong bộ nhớ.
    S3_ENDPOINT: '',
    S3_BUCKET: '',
    S3_ACCESS_KEY: '',
    S3_SECRET_KEY: '',
    // Không gọi Gemini/Lark thật: test cần thì truyền LlmClient / fetch giả qua AppOverrides.
    GEMINI_API_KEY: '',
    GEMINI_MODEL: 'gemini-2.5-flash',
    LARK_WEBHOOK_URL: '',
    LARK_WEBHOOK_SECRET: '',
  });
}

export async function startInfra(): Promise<TestInfra> {
  let pg: StartedPostgreSqlContainer | undefined;
  let redis: StartedRedisContainer | undefined;
  try {
    [pg, redis] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg16').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    const databaseUrl = pg.getConnectionUri();
    const redisUrl = redis.getConnectionUrl();
    applyTestEnv(databaseUrl, redisUrl);
    await runMigrations(databaseUrl);
    await seedData(databaseUrl);
    const started = { pg, redis };
    return {
      databaseUrl,
      redisUrl,
      stop: async () => {
        await Promise.all([started.pg.stop(), started.redis.stop()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([pg?.stop(), redis?.stop()]);
    throw error;
  }
}

async function seedData(databaseUrl: string): Promise<void> {
  const { db, close } = createDb(databaseUrl, { max: 1 });
  try {
    await seedUsers(db, { admin: ADMIN, agent: AGENT });
    await db.insert(users).values({
      email: INACTIVE.email,
      name: INACTIVE.name,
      passwordHash: await hashPassword(INACTIVE.password),
      role: 'agent',
      isActive: false,
    });
  } finally {
    await close();
  }
}
