// app_settings (key/value jsonb): giờ làm việc, Lark, công tắc AI tổng.
import { appSettings, auditLogs, type Db } from '@dezon/db';
import {
  aiSettingsSchema,
  businessHoursSchema,
  DEFAULT_AI_SETTINGS,
  DEFAULT_BUSINESS_HOURS,
  type AiSettings,
  type BusinessHours,
  type LarkSettingsDto,
  type UpdateLarkSettingsRequest,
} from '@dezon/shared';
import { eq } from 'drizzle-orm';
import type { CredentialsCipher } from '../channels/service';

/** Khóa trong app_settings (khớp APP_SETTING_KEYS của @dezon/db). */
export const SETTING_KEYS = {
  businessHours: 'business_hours',
  lark: 'lark',
  ai: 'ai',
} as const;
type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/** Giá trị lưu ở app_settings['lark'] (secretEnc = cipher.encryptJson(secret)). KHÔNG trả ra client. */
export interface StoredLarkSettings {
  webhookUrl: string | null;
  secretEnc: string | null;
}

/** Cấu hình Lark đã giải mã, chỉ dùng phía server (notifyLark). */
export interface LarkConfig {
  webhookUrl: string;
  secret: string | null;
}

/** Cấu hình Lark mặc định từ env (LARK_WEBHOOK_URL / LARK_WEBHOOK_SECRET); chuỗi rỗng = không có. */
export interface LarkFallback {
  webhookUrl?: string | null;
  secret?: string | null;
}

type DbOrTx = Pick<Db, 'select' | 'insert'>;

async function readSetting(db: Pick<Db, 'select'>, key: SettingKey): Promise<unknown> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);
  return row?.value;
}

async function writeSetting(
  db: DbOrTx,
  key: SettingKey,
  value: unknown,
  actorUserId: string,
  audit: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ key, value, updatedBy: actorUserId })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedBy: actorUserId, updatedAt: now } });
  await db.insert(auditLogs).values({
    userId: actorUserId,
    action: `settings.${key}`,
    entity: 'app_setting',
    entityId: key,
    data: audit,
  });
}

function parseStoredLark(value: unknown): StoredLarkSettings | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return {
    webhookUrl: typeof v.webhookUrl === 'string' && v.webhookUrl ? v.webhookUrl : null,
    secretEnc: typeof v.secretEnc === 'string' && v.secretEnc ? v.secretEnc : null,
  };
}

/** Thiếu dòng hoặc giá trị không qua businessHoursSchema ⇒ DEFAULT_BUSINESS_HOURS. */
export async function getBusinessHours(db: Db): Promise<BusinessHours> {
  const parsed = businessHoursSchema.safeParse(await readSetting(db, SETTING_KEYS.businessHours));
  return parsed.success ? parsed.data : DEFAULT_BUSINESS_HOURS;
}

/** Upsert (input đã qua businessHoursSchema). updated_by = actorUserId. Audit 'settings.business_hours'. */
export async function putBusinessHours(
  db: Db,
  actorUserId: string,
  input: BusinessHours,
): Promise<BusinessHours> {
  const value = businessHoursSchema.parse(input);
  await db.transaction(async (tx) => {
    await writeSetting(tx, SETTING_KEYS.businessHours, value, actorUserId, { timezone: value.timezone });
  });
  return value;
}

/** { webhookUrl, hasSecret } — thiếu dòng ⇒ { webhookUrl: null, hasSecret: false }. Chỉ đọc DB (không env). */
export async function getLarkSettings(db: Db): Promise<LarkSettingsDto> {
  const stored = parseStoredLark(await readSetting(db, SETTING_KEYS.lark));
  return { webhookUrl: stored?.webhookUrl ?? null, hasSecret: Boolean(stored?.secretEnc) };
}

/**
 * Upsert. secret: undefined ⇒ giữ secretEnc cũ; null hoặc '' ⇒ xóa; chuỗi ⇒ cipher.encryptJson(secret).
 * Audit 'settings.lark' (chỉ ghi webhookUrl có/không và hasSecret, KHÔNG ghi secret).
 */
export async function putLarkSettings(
  db: Db,
  actorUserId: string,
  input: UpdateLarkSettingsRequest,
  cipher: CredentialsCipher,
): Promise<LarkSettingsDto> {
  return db.transaction(async (tx) => {
    const current = parseStoredLark(await readSetting(tx, SETTING_KEYS.lark));
    let secretEnc: string | null;
    if (input.secret === undefined) secretEnc = current?.secretEnc ?? null;
    else if (input.secret === null || input.secret.trim() === '') secretEnc = null;
    else secretEnc = cipher.encryptJson(input.secret.trim());
    const value: StoredLarkSettings = { webhookUrl: input.webhookUrl || null, secretEnc };
    await writeSetting(tx, SETTING_KEYS.lark, value, actorUserId, {
      hasWebhookUrl: Boolean(value.webhookUrl),
      hasSecret: Boolean(secretEnc),
      secretChanged: input.secret !== undefined,
    });
    return { webhookUrl: value.webhookUrl, hasSecret: Boolean(secretEnc) };
  });
}

/**
 * Cấu hình Lark đã giải mã; null nếu không có webhookUrl. Giải mã lỗi ⇒ secret null (log warn ở caller).
 * `fallback` (env LARK_WEBHOOK_URL/LARK_WEBHOOK_SECRET) chỉ dùng khi app_settings CHƯA TỪNG có dòng 'lark';
 * khi admin đã lưu (kể cả xóa webhook) thì DB thắng — để admin tắt được Lark mà không cần sửa env.
 */
export async function getLarkConfig(
  db: Db,
  cipher: CredentialsCipher,
  fallback?: LarkFallback,
): Promise<LarkConfig | null> {
  const raw = await readSetting(db, SETTING_KEYS.lark);
  if (raw === undefined) {
    const url = fallback?.webhookUrl?.trim();
    if (!url) return null;
    return { webhookUrl: url, secret: fallback?.secret?.trim() || null };
  }
  const stored = parseStoredLark(raw);
  if (!stored?.webhookUrl) return null;
  let secret: string | null = null;
  if (stored.secretEnc) {
    try {
      const decrypted = cipher.decryptJson<unknown>(stored.secretEnc);
      secret = typeof decrypted === 'string' && decrypted ? decrypted : null;
    } catch {
      secret = null;
    }
  }
  return { webhookUrl: stored.webhookUrl, secret };
}

/** Thiếu dòng (hoặc giá trị sai) ⇒ DEFAULT_AI_SETTINGS ({ enabled: true }). */
export async function getAiSettings(db: Db): Promise<AiSettings> {
  const parsed = aiSettingsSchema.safeParse(await readSetting(db, SETTING_KEYS.ai));
  return parsed.success ? parsed.data : DEFAULT_AI_SETTINGS;
}

/** Upsert. Audit 'settings.ai'. */
export async function putAiSettings(db: Db, actorUserId: string, input: AiSettings): Promise<AiSettings> {
  const value: AiSettings = { enabled: aiSettingsSchema.parse(input).enabled };
  await db.transaction(async (tx) => {
    await writeSetting(tx, SETTING_KEYS.ai, value, actorUserId, { enabled: value.enabled });
  });
  return value;
}
