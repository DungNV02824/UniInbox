import { randomBytes } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { EMBEDDING_DIM } from '../enums';
import { durationToSeconds } from '../duration';
import { loadEnv, type Env } from './env';

const secrets = {
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  JWT_SECRET: 'access-secret-'.padEnd(48, 'a'),
  JWT_REFRESH_SECRET: 'refresh-secret-'.padEnd(48, 'b'),
};

const validEnv = (): Record<string, string | undefined> => ({
  ...secrets,
  DATABASE_URL: 'postgres://dezon:db-password-xyz@localhost:5433/dezon_inbox',
  REDIS_URL: 'redis://localhost:6379',
});

function errorOf(source: Record<string, string | undefined>): string {
  try {
    loadEnv(source);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('loadEnv lẽ ra phải ném lỗi');
}

describe('loadEnv', () => {
  it('parse env hợp lệ tối thiểu và điền mặc định', () => {
    const env = loadEnv(validEnv());
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.APP_URL).toBe('http://localhost:3100');
    expect(env.API_URL).toBe('http://localhost:4000');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.JWT_ACCESS_TTL).toBe('15m');
    expect(env.JWT_REFRESH_TTL).toBe('30d');
    expect(env.EMBEDDING_DIM).toBe(EMBEDDING_DIM);
    expect(env.AI_MIN_CONFIDENCE).toBe(0.6);
    expect(env.AI_DEBOUNCE_MS).toBe(12000);
    expect(env.FEATURE_AI_ENABLED).toBe(false);
    expect(env.ZALO_PERSONAL_ENABLED).toBe(false);
    expect(env.META_HUMAN_AGENT_ENABLED).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('biến Zalo OA (1B) có mặc định và kiểm giá trị', () => {
    const env = loadEnv(validEnv());
    expect(env.ZALO_OAUTH_BASE_URL).toBe('https://oauth.zaloapp.com');
    expect(env.ZALO_OPENAPI_BASE_URL).toBe('https://openapi.zalo.me');
    expect(env.ZALO_VERIFIER_DIR).toBe('./data/zalo-verifier');
    expect(env.ZALO_SIGNATURE_TIMESTAMP_SOURCE).toBe('body');
    expect(env.ZALO_SYNC_INTERVAL_SEC).toBe(60);
    expect(env.ZALO_HISTORY_DAYS).toBe(7);
    expect(loadEnv({ ...validEnv(), ZALO_SIGNATURE_TIMESTAMP_SOURCE: 'header' }).ZALO_SIGNATURE_TIMESTAMP_SOURCE).toBe(
      'header',
    );
    expect(() => loadEnv({ ...validEnv(), ZALO_SIGNATURE_TIMESTAMP_SOURCE: 'query' })).toThrow(
      /ZALO_SIGNATURE_TIMESTAMP_SOURCE/,
    );
    expect(() => loadEnv({ ...validEnv(), ZALO_HISTORY_DAYS: '0' })).toThrow(/ZALO_HISTORY_DAYS/);
  });

  it('chuỗi rỗng ở biến tùy chọn => undefined / mặc định', () => {
    const env = loadEnv({
      ...validEnv(),
      ANTHROPIC_API_KEY: '',
      META_GRAPH_VERSION: '',
      API_PORT: '',
      LARK_WEBHOOK_URL: '',
      META_LOGIN_DIALOG_BASE_URL: '',
      FEATURE_AI_ENABLED: '',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.META_GRAPH_VERSION).toBeUndefined();
    expect(env.LARK_WEBHOOK_URL).toBeUndefined();
    expect(env.META_LOGIN_DIALOG_BASE_URL).toBeUndefined();
    expect(env.API_PORT).toBe(4000);
    expect(env.FEATURE_AI_ENABLED).toBe(false);
  });

  it('boolean: "false"/"0" => false, "true"/"1" => true', () => {
    const env = loadEnv({
      ...validEnv(),
      FEATURE_AI_ENABLED: 'false',
      ZALO_PERSONAL_ENABLED: 'true',
      META_HUMAN_AGENT_ENABLED: '1',
      ZALO_OA_ALLOW_PAID_BOT: '0',
      AI_SEND_HOLDING_MESSAGE: 'false',
    });
    expect(env.FEATURE_AI_ENABLED).toBe(false);
    expect(env.ZALO_PERSONAL_ENABLED).toBe(true);
    expect(env.META_HUMAN_AGENT_ENABLED).toBe(true);
    expect(env.ZALO_OA_ALLOW_PAID_BOT).toBe(false);
    expect(env.AI_SEND_HOLDING_MESSAGE).toBe(false);
  });

  it('META_LOGIN_DIALOG_BASE_URL nhận URL http(s), từ chối giá trị khác', () => {
    expect(
      loadEnv({ ...validEnv(), META_LOGIN_DIALOG_BASE_URL: 'http://localhost:4900' })
        .META_LOGIN_DIALOG_BASE_URL,
    ).toBe('http://localhost:4900');
    expect(errorOf({ ...validEnv(), META_LOGIN_DIALOG_BASE_URL: 'facebook' })).toContain(
      'META_LOGIN_DIALOG_BASE_URL',
    );
  });

  it('boolean không hợp lệ bị từ chối', () => {
    expect(errorOf({ ...validEnv(), FEATURE_AI_ENABLED: 'yes' })).toContain('FEATURE_AI_ENABLED');
  });

  it('số được coerce và validate', () => {
    expect(loadEnv({ ...validEnv(), API_PORT: '4100' }).API_PORT).toBe(4100);
    expect(errorOf({ ...validEnv(), API_PORT: 'abc' })).toContain('API_PORT');
  });

  it('liệt kê mọi biến bắt buộc bị thiếu', () => {
    const message = errorOf({});
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'ENCRYPTION_KEY', 'JWT_SECRET', 'JWT_REFRESH_SECRET']) {
      expect(message).toContain(key);
    }
  });

  it('thông báo lỗi không chứa giá trị secret', () => {
    const badKey = randomBytes(16).toString('base64');
    const shortSecret = 'short-secret-value';
    const message = errorOf({
      ...validEnv(),
      ENCRYPTION_KEY: badKey,
      JWT_SECRET: shortSecret,
      DATABASE_URL: 'mysql://root:db-password-xyz@host/db',
      FEATURE_AI_ENABLED: 'not-a-bool',
    });
    expect(message).toContain('ENCRYPTION_KEY');
    expect(message).toContain('JWT_SECRET');
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('FEATURE_AI_ENABLED');
    expect(message).not.toContain(badKey);
    expect(message).not.toContain(shortSecret);
    expect(message).not.toContain('db-password-xyz');
    expect(message).not.toContain(secrets.JWT_REFRESH_SECRET);
    expect(message).not.toContain('not-a-bool');
  });

  it('JWT_SECRET và JWT_REFRESH_SECRET phải khác nhau', () => {
    const message = errorOf({ ...validEnv(), JWT_REFRESH_SECRET: secrets.JWT_SECRET });
    expect(message).toContain('JWT_REFRESH_SECRET');
    expect(message).not.toContain(secrets.JWT_SECRET);
  });

  it('EMBEDDING_DIM khác hằng số bị từ chối', () => {
    expect(errorOf({ ...validEnv(), EMBEDDING_DIM: '1536' })).toContain('EMBEDDING_DIM');
    expect(loadEnv({ ...validEnv(), EMBEDDING_DIM: String(EMBEDDING_DIM) }).EMBEDDING_DIM).toBe(
      EMBEDDING_DIM,
    );
  });

  it('TTL sai định dạng bị từ chối', () => {
    expect(errorOf({ ...validEnv(), JWT_ACCESS_TTL: '15 minutes' })).toContain('JWT_ACCESS_TTL');
  });

  it('TTL bằng 0 hoặc vượt số nguyên an toàn bị từ chối ngay ở bước env', () => {
    expect(errorOf({ ...validEnv(), JWT_ACCESS_TTL: '0m' })).toContain('JWT_ACCESS_TTL');
    expect(errorOf({ ...validEnv(), JWT_REFRESH_TTL: '99999999999999d' })).toContain('JWT_REFRESH_TTL');
  });

  it('production bắt buộc APP_URL/API_URL dùng https', () => {
    const message = errorOf({ ...validEnv(), NODE_ENV: 'production' });
    expect(message).toContain('APP_URL');
    expect(message).toContain('API_URL');
    const env = loadEnv({
      ...validEnv(),
      NODE_ENV: 'production',
      APP_URL: 'https://inbox.dezon.vn',
      API_URL: 'https://api-inbox.dezon.vn',
    });
    expect(env.NODE_ENV).toBe('production');
  });

  it('kiểu Env suy ra đúng', () => {
    expectTypeOf<Env['FEATURE_AI_ENABLED']>().toEqualTypeOf<boolean>();
    expectTypeOf<Env['API_PORT']>().toEqualTypeOf<number>();
    expectTypeOf<Env['DATABASE_URL']>().toEqualTypeOf<string>();
    expectTypeOf<Env['NODE_ENV']>().toEqualTypeOf<'development' | 'test' | 'production'>();
    expectTypeOf<Env['ANTHROPIC_API_KEY']>().toEqualTypeOf<string | undefined>();
  });
});

describe('durationToSeconds', () => {
  it('đổi đúng đơn vị', () => {
    expect(durationToSeconds('15m')).toBe(900);
    expect(durationToSeconds('30d')).toBe(2_592_000);
    expect(durationToSeconds('3600s')).toBe(3600);
    expect(durationToSeconds('12h')).toBe(43_200);
  });

  it('từ chối định dạng sai', () => {
    expect(() => durationToSeconds('15')).toThrow();
    expect(() => durationToSeconds('0m')).toThrow();
    expect(() => durationToSeconds('1w')).toThrow();
  });
});
