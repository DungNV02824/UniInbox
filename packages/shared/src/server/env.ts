// Validate biến môi trường (mục 10). Biến của giai đoạn sau là tùy chọn; chuỗi rỗng => undefined.
import { z } from 'zod';
import { EMBEDDING_DIM } from '../enums';
import { DURATION_PATTERN, durationToSeconds } from '../duration';
import { parseEncryptionKey } from './crypto';

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** Tùy chọn: rỗng/thiếu => undefined. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());

/** Có giá trị mặc định khi rỗng/thiếu. */
const withDefault = <T extends z.ZodType>(schema: T, value: z.output<T>) =>
  z.preprocess(emptyToUndefined, schema.default(value as never));

const required = <T extends z.ZodType<unknown, string>>(name: string, schema: T) =>
  z.preprocess(emptyToUndefined, z.string({ error: `${name} là bắt buộc` }).pipe(schema));

const int = (def: number, min = 0) => withDefault(z.coerce.number().int().min(min), def);

/** Chỉ chấp nhận 'true' | 'false' | '1' | '0' (z.coerce.boolean sẽ biến 'false' thành true). */
const bool = (def: boolean) =>
  withDefault(
    z.stringbool({
      truthy: ['true', '1'],
      falsy: ['false', '0'],
      error: "Chỉ nhận 'true', 'false', '1' hoặc '0'",
    }),
    def,
  );

const urlWithProtocols = (name: string, protocols: string[]) =>
  z.string().refine(
    (value) => {
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: `${name} phải là URL dạng ${protocols.map((p) => `${p}//`).join(' hoặc ')}` },
  );

const httpUrl = () => z.url({ protocol: /^https?$/, error: 'Phải là URL http(s) hợp lệ' });

const isValidDuration = (value: string): boolean => {
  try {
    durationToSeconds(value);
    return true;
  } catch {
    return false;
  }
};

/** Validate bằng chính durationToSeconds: chặn cả 0m và giá trị vượt số nguyên an toàn. */
const duration = (def: string) =>
  withDefault(
    z
      .string()
      .regex(DURATION_PATTERN, 'Định dạng thời lượng: 15m, 30d, 3600s...')
      .refine(isValidDuration, 'Thời lượng phải lớn hơn 0 và không quá lớn'),
    def,
  );

const jwtSecret = (name: string) => required(name, z.string().min(32, `${name} phải dài ít nhất 32 ký tự`));

const encryptionKey = required(
  'ENCRYPTION_KEY',
  z.string().refine(
    (value) => {
      try {
        parseEncryptionKey(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'ENCRYPTION_KEY phải là base64 của đúng 32 byte' },
  ),
);

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const envSchema = z
  .object({
    // ===== Chung =====
    NODE_ENV: withDefault(z.enum(['development', 'test', 'production']), 'development'),
    APP_URL: withDefault(httpUrl(), 'http://localhost:3100'),
    API_URL: withDefault(httpUrl(), 'http://localhost:4000'),
    API_PORT: int(4000, 1),
    WEB_PORT: int(3100, 1),
    TZ: withDefault(z.string(), 'Asia/Ho_Chi_Minh'),
    ENCRYPTION_KEY: encryptionKey,
    JWT_SECRET: jwtSecret('JWT_SECRET'),
    JWT_REFRESH_SECRET: jwtSecret('JWT_REFRESH_SECRET'),
    JWT_ACCESS_TTL: duration('15m'),
    JWT_REFRESH_TTL: duration('30d'),
    LOG_LEVEL: withDefault(z.enum(LOG_LEVELS), 'info'),

    // ===== Hạ tầng =====
    DATABASE_URL: required('DATABASE_URL', urlWithProtocols('DATABASE_URL', ['postgres:', 'postgresql:'])),
    REDIS_URL: required('REDIS_URL', urlWithProtocols('REDIS_URL', ['redis:', 'rediss:'])),
    S3_ENDPOINT: optional(httpUrl()),
    S3_BUCKET: optional(z.string()),
    S3_ACCESS_KEY: optional(z.string()),
    S3_SECRET_KEY: optional(z.string()),
    S3_REGION: withDefault(z.string(), 'auto'),
    /** SeaweedFS/MinIO cần path-style; R2/S3 thật dùng virtual-hosted (false). */
    S3_FORCE_PATH_STYLE: bool(true),
    /** Endpoint S3 mà trình duyệt truy cập được để mở URL ký (mặc định = S3_ENDPOINT). */
    S3_PUBLIC_ENDPOINT: optional(httpUrl()),
    MEDIA_MAX_UPLOAD_MB: int(10, 1),
    MEDIA_SIGNED_URL_TTL_SEC: int(3600, 60),
    SMTP_URL: optional(urlWithProtocols('SMTP_URL', ['smtp:', 'smtps:'])),

    // ===== Seed =====
    SEED_ADMIN_EMAIL: optional(z.email()),
    SEED_ADMIN_PASSWORD: optional(z.string()),
    SEED_ADMIN_NAME: optional(z.string()),
    SEED_AGENT_EMAIL: optional(z.email()),
    SEED_AGENT_PASSWORD: optional(z.string()),

    // ===== AI (Giai đoạn 2+) =====
    /** Nhà cung cấp LLM cho chatbot. Chủ sản phẩm chọn Gemini (xem DECISIONS.md). */
    AI_PROVIDER: withDefault(z.enum(['gemini', 'anthropic']), 'gemini'),
    GEMINI_API_KEY: optional(z.string()),
    /** Model mặc định của chatbot (mỗi bot chọn được model riêng). */
    GEMINI_MODEL: withDefault(z.string(), 'gemini-3.5-flash'),
    ANTHROPIC_API_KEY: optional(z.string()),
    AI_MODEL_MAIN: withDefault(z.string(), 'claude-sonnet-5-5'),
    AI_MODEL_FAST: withDefault(z.string(), 'claude-haiku-5-5'),
    EMBEDDING_PROVIDER: withDefault(z.string(), 'voyage'),
    VOYAGE_API_KEY: optional(z.string()),
    EMBEDDING_MODEL: optional(z.string()),
    EMBEDDING_DIM: withDefault(
      z.coerce
        .number()
        .int()
        .refine((dim) => dim === EMBEDDING_DIM, {
          message: `EMBEDDING_DIM phải bằng ${EMBEDDING_DIM} (kích thước cột vector trong DB)`,
        }),
      EMBEDDING_DIM,
    ),
    AI_DEBOUNCE_MS: int(12000),
    AI_DEBOUNCE_MAX_WAIT_MS: int(45000),
    AI_PAUSE_AFTER_AGENT_MIN: int(30),
    AI_MIN_CONFIDENCE: withDefault(z.coerce.number().min(0).max(1), 0.6),
    AI_MAX_AUTO_REPLIES_PER_HOUR: int(20),
    AI_SEND_HOLDING_MESSAGE: bool(false),

    // ===== Meta / Messenger (1A) =====
    META_APP_ID: optional(z.string()),
    META_APP_SECRET: optional(z.string()),
    META_VERIFY_TOKEN: optional(z.string()),
    META_GRAPH_VERSION: optional(z.string().regex(/^v\d+\.\d+$/, 'Dạng vXX.Y, ví dụ v23.0')),
    META_HUMAN_AGENT_ENABLED: bool(false),
    /** Facebook Login for Business: Configuration ID (thay cho scope). Trống => dùng scope. */
    META_LOGIN_CONFIG_ID: optional(z.string().regex(/^\d{1,30}$/, 'META_LOGIN_CONFIG_ID phải là dãy số')),
    /** Đổi được để trỏ tới Graph API giả lập khi test. */
    META_GRAPH_BASE_URL: withDefault(httpUrl(), 'https://graph.facebook.com'),
    /** Số ngày lịch sử hội thoại tải về khi kết nối Page / bấm "Đồng bộ lịch sử". */
    MESSENGER_HISTORY_DAYS: int(30, 1),
    /** Chu kỳ đồng bộ định kỳ (giây) kéo tin mới qua Conversations API; 0 = tắt. */
    MESSENGER_SYNC_INTERVAL_SEC: int(60, 0),
    /** Host dialog Facebook Login; chỉ đổi khi test với dialog giả lập. Trống => https://www.facebook.com. */
    META_LOGIN_DIALOG_BASE_URL: optional(httpUrl()),

    // ===== Zalo OA (1B) =====
    ZALO_APP_ID: optional(z.string()),
    ZALO_APP_SECRET: optional(z.string()),
    ZALO_OA_SECRET_KEY: optional(z.string()),
    ZALO_OA_ALLOW_PAID_BOT: bool(false),
    /** Host OAuth v4 (authorize + access_token). Đổi để trỏ tới Zalo giả lập khi test. */
    ZALO_OAUTH_BASE_URL: withDefault(httpUrl(), 'https://oauth.zaloapp.com'),
    /** Host OpenAPI (message/cs, upload, user/detail, conversation...). Đổi để trỏ tới Zalo giả lập khi test. */
    ZALO_OPENAPI_BASE_URL: withDefault(httpUrl(), 'https://openapi.zalo.me'),
    /** Thư mục chứa tệp xác thực domain; API trả GET /zalo_verifier*.html từ đây (không auth). */
    ZALO_VERIFIER_DIR: withDefault(z.string().min(1), './data/zalo-verifier'),
    /** Nguồn `timeStamp` khi kiểm X-ZEvent-Signature: trường `timestamp` của body (mặc định) hay header. */
    ZALO_SIGNATURE_TIMESTAMP_SOURCE: withDefault(z.enum(['body', 'header']), 'body'),
    /** Chu kỳ đồng bộ định kỳ Zalo OA (giây); 0 = tắt. */
    ZALO_SYNC_INTERVAL_SEC: int(60, 0),
    /** Số ngày lịch sử kéo về khi kết nối OA / mặc định của nút "Đồng bộ lịch sử" (1-365). */
    ZALO_HISTORY_DAYS: withDefault(z.coerce.number().int().min(1).max(365), 7),

    // ===== Zalo cá nhân (1C) =====
    ZALO_PERSONAL_ENABLED: bool(false),
    ZALO_PERSONAL_MIN_SEND_INTERVAL_MS: int(3000),

    // ===== Catalog dezon.vn (2) =====
    CATALOG_PROVIDER: withDefault(z.string(), 'wordpress'),
    CATALOG_BASE_URL: withDefault(httpUrl(), 'https://dezon.vn'),
    CATALOG_API_USER: optional(z.string()),
    CATALOG_API_APP_PASSWORD: optional(z.string()),

    // ===== Tính năng =====
    FEATURE_AI_ENABLED: bool(false),
    UNANSWERED_ALERT_MIN: int(15),
    HANDOFF_ESCALATE_AFTER_MIN: int(15),

    // ===== Thông báo =====
    LARK_WEBHOOK_URL: optional(httpUrl()),
    LARK_WEBHOOK_SECRET: optional(z.string()),
    VAPID_PUBLIC_KEY: optional(z.string()),
    VAPID_PRIVATE_KEY: optional(z.string()),

    // ===== Giám sát =====
    SENTRY_DSN: optional(httpUrl()),

    // ===== Web =====
    NEXT_PUBLIC_API_URL: optional(httpUrl()),
  })
  .superRefine((env, ctx) => {
    if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET phải khác JWT_SECRET',
      });
    }
    if (env.NODE_ENV === 'production') {
      for (const key of ['APP_URL', 'API_URL'] as const) {
        if (!env[key].startsWith('https://')) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} phải dùng https trong production` });
        }
      }
    }
  });

export type Env = z.output<typeof envSchema>;

/**
 * Validate env. Ném Error liệt kê mọi biến sai kèm lý do — KHÔNG in giá trị (tránh lộ secret).
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '(env)';
    return `  - ${key}: ${issue.message}`;
  });
  throw new Error(`Biến môi trường không hợp lệ:\n${lines.join('\n')}`);
}
