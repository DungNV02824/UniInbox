// "Nhóm Lark theo chatbot" (Cài đặt → Thông báo Lark): CRUD nhóm + chọn nơi gửi thông báo của một hội thoại.
// Bot thuộc ≥1 nhóm ⇒ CHỈ gửi các nhóm đó; bot không thuộc nhóm nào / hội thoại không có bot ⇒ nhóm chung
// (getLarkConfig, app_settings.lark + env fallback) như trước. Không gửi cả hai.
import { auditLogs, chatbots, conversations, larkGroupChatbots, larkGroups, type Db } from '@dezon/db';
import {
  createLarkGroupSchema,
  LARK_GROUP_LIMITS,
  updateLarkGroupSchema,
  type CreateLarkGroupRequest,
  type LarkGroupDto,
  type UpdateLarkGroupRequest,
} from '@dezon/shared';
import { asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { ZodError } from 'zod';
import type { CredentialsCipher } from '../channels/service';
import { InboxNotFoundError, InboxValidationError } from '../inbox/errors';
import type { PipelineLogger } from '../pipeline/types';
import { notifyLark, type LarkCardMessage, type NotifyLarkOptions } from './lark';
import { getLarkConfig, type LarkConfig, type LarkFallback } from './settings';

export const LARK_GROUP_NOT_FOUND = 'Không tìm thấy nhóm Lark';
export const LARK_GROUP_UNKNOWN_CHATBOT =
  'Có chatbot không tồn tại (có thể đã bị xóa) — tải lại trang rồi chọn lại';
export const LARK_GROUP_LIMIT_REACHED = `Tối đa ${LARK_GROUP_LIMITS.maxGroups} nhóm Lark`;
export const LARK_GROUP_SECRET_UNREADABLE = 'Không đọc được secret của nhóm Lark — nhập lại secret rồi lưu';

/** Nơi gửi thông báo Lark đã giải mã. `larkGroupId` null = nhóm chung (app_settings.lark / env). */
export interface LarkTarget extends LarkConfig {
  larkGroupId: string | null;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type DbOrTx = Db | Tx;

function zodMessage(error: ZodError): string {
  return error.issues[0]?.message ?? 'Dữ liệu không hợp lệ';
}

/** secret: undefined ⇒ giữ `current`; null/'' (sau trim) ⇒ xóa; chuỗi ⇒ mã hóa bằng cipher (như app_settings.lark). */
function nextSecretEnc(
  secret: string | null | undefined,
  current: string | null,
  cipher: CredentialsCipher,
): string | null {
  if (secret === undefined) return current;
  if (secret === null || secret.trim() === '') return null;
  return cipher.encryptJson(secret.trim());
}

function decryptSecret(cipher: CredentialsCipher, secretEnc: string): string {
  const value = cipher.decryptJson<unknown>(secretEnc);
  if (typeof value !== 'string' || !value) throw new Error('secret không hợp lệ');
  return value;
}

/**
 * Bỏ trùng, kiểm mọi id có trong bảng chatbots; thiếu ⇒ InboxValidationError (400).
 * FOR KEY SHARE: giữ các dòng bot tới hết transaction — deleteChatbot chạy song song phải chờ (hoặc, nếu nó xóa
 * trước, dòng không còn ⇒ 400 ở đây) thay vì để insert lark_group_chatbots vỡ FK (23503 ⇒ 500).
 */
async function checkChatbotIds(db: DbOrTx, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return unique;
  const found = await db
    .select({ id: chatbots.id })
    .from(chatbots)
    .where(inArray(chatbots.id, unique))
    .for('key share');
  if (found.length !== unique.length) throw new InboxValidationError(LARK_GROUP_UNKNOWN_CHATBOT);
  return unique;
}

async function replaceChatbots(
  db: DbOrTx,
  larkGroupId: string,
  chatbotIds: readonly string[],
): Promise<void> {
  await db.delete(larkGroupChatbots).where(eq(larkGroupChatbots.larkGroupId, larkGroupId));
  if (chatbotIds.length > 0) {
    await db.insert(larkGroupChatbots).values(chatbotIds.map((chatbotId) => ({ larkGroupId, chatbotId })));
  }
}

/** Đọc DTO (chatbotIds theo tên bot). `ids` thiếu ⇒ mọi nhóm, theo tên nhóm. */
async function loadDtos(db: DbOrTx, ids?: readonly string[]): Promise<LarkGroupDto[]> {
  const base = db
    .select({
      id: larkGroups.id,
      name: larkGroups.name,
      webhookUrl: larkGroups.webhookUrl,
      secretEnc: larkGroups.secretEnc,
      createdAt: larkGroups.createdAt,
      updatedAt: larkGroups.updatedAt,
    })
    .from(larkGroups);
  const rows = await (ids ? base.where(inArray(larkGroups.id, [...ids])) : base).orderBy(
    asc(larkGroups.name),
    asc(larkGroups.createdAt),
  );
  if (rows.length === 0) return [];
  const links = await db
    .select({ larkGroupId: larkGroupChatbots.larkGroupId, chatbotId: larkGroupChatbots.chatbotId })
    .from(larkGroupChatbots)
    .innerJoin(chatbots, eq(chatbots.id, larkGroupChatbots.chatbotId))
    .where(
      inArray(
        larkGroupChatbots.larkGroupId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(chatbots.name), asc(chatbots.id));
  const byGroup = new Map<string, string[]>();
  for (const l of links) {
    const list = byGroup.get(l.larkGroupId) ?? [];
    list.push(l.chatbotId);
    byGroup.set(l.larkGroupId, list);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    webhookUrl: r.webhookUrl,
    hasSecret: Boolean(r.secretEnc),
    chatbotIds: byGroup.get(r.id) ?? [],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

async function loadDto(db: DbOrTx, id: string): Promise<LarkGroupDto> {
  const [dto] = await loadDtos(db, [id]);
  if (!dto) throw new InboxNotFoundError(LARK_GROUP_NOT_FOUND);
  return dto;
}

/** Mọi nhóm Lark (theo tên). Secret không bao giờ trả ra (chỉ hasSecret). */
export function listLarkGroups(db: Db): Promise<LarkGroupDto[]> {
  return loadDtos(db);
}

/**
 * Tạo nhóm. Quá LARK_GROUP_LIMITS.maxGroups / chatbot không tồn tại ⇒ InboxValidationError (400).
 * Audit 'settings.lark_group.create' (tên, có secret, danh sách bot — KHÔNG ghi webhook/secret).
 */
export async function createLarkGroup(
  db: Db,
  actorUserId: string,
  input: CreateLarkGroupRequest,
  cipher: CredentialsCipher,
): Promise<LarkGroupDto> {
  const parsed = createLarkGroupSchema.safeParse(input);
  if (!parsed.success) throw new InboxValidationError(zodMessage(parsed.error));
  const value = parsed.data;
  return db.transaction(async (tx) => {
    // Khóa theo bảng để hai request tạo cùng lúc không vượt giới hạn.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('lark_groups'))`);
    const [{ total } = { total: 0 }] = await tx.select({ total: count() }).from(larkGroups);
    if (total >= LARK_GROUP_LIMITS.maxGroups) throw new InboxValidationError(LARK_GROUP_LIMIT_REACHED);
    const chatbotIds = await checkChatbotIds(tx, value.chatbotIds);
    const secretEnc = nextSecretEnc(value.secret, null, cipher);
    const [row] = await tx
      .insert(larkGroups)
      .values({ name: value.name, webhookUrl: value.webhookUrl, secretEnc })
      .returning({ id: larkGroups.id });
    const id = row!.id;
    await replaceChatbots(tx, id, chatbotIds);
    await tx.insert(auditLogs).values({
      userId: actorUserId,
      action: 'settings.lark_group.create',
      entity: 'lark_group',
      entityId: id,
      data: { name: value.name, hasSecret: Boolean(secretEnc), chatbotIds },
    });
    return loadDto(tx, id);
  });
}

/**
 * Sửa nhóm. secret: bỏ qua = giữ, null/'' = xóa, chuỗi = đặt mới. chatbotIds có ⇒ thay toàn bộ danh sách bot.
 * Không có nhóm ⇒ InboxNotFoundError (404); chatbot không tồn tại ⇒ InboxValidationError (400).
 * Audit 'settings.lark_group.update' (chỉ tên trường đổi + có secret, KHÔNG ghi webhook/secret).
 */
export async function updateLarkGroup(
  db: Db,
  actorUserId: string,
  id: string,
  input: UpdateLarkGroupRequest,
  cipher: CredentialsCipher,
): Promise<LarkGroupDto> {
  const parsed = updateLarkGroupSchema.safeParse(input);
  if (!parsed.success) throw new InboxValidationError(zodMessage(parsed.error));
  const value = parsed.data;
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: larkGroups.id, secretEnc: larkGroups.secretEnc })
      .from(larkGroups)
      .where(eq(larkGroups.id, id))
      .for('update');
    if (!current) throw new InboxNotFoundError(LARK_GROUP_NOT_FOUND);
    const chatbotIds =
      value.chatbotIds !== undefined ? await checkChatbotIds(tx, value.chatbotIds) : undefined;
    const secretEnc = nextSecretEnc(value.secret, current.secretEnc, cipher);
    await tx
      .update(larkGroups)
      .set({
        ...(value.name !== undefined ? { name: value.name } : {}),
        ...(value.webhookUrl !== undefined ? { webhookUrl: value.webhookUrl } : {}),
        secretEnc,
        updatedAt: new Date(),
      })
      .where(eq(larkGroups.id, id));
    if (chatbotIds !== undefined) await replaceChatbots(tx, id, chatbotIds);
    const fields = (['name', 'webhookUrl', 'secret', 'chatbotIds'] as const).filter(
      (k) => value[k] !== undefined,
    );
    await tx.insert(auditLogs).values({
      userId: actorUserId,
      action: 'settings.lark_group.update',
      entity: 'lark_group',
      entityId: id,
      data: {
        fields,
        hasSecret: Boolean(secretEnc),
        ...(chatbotIds !== undefined ? { chatbotIds } : {}),
      },
    });
    return loadDto(tx, id);
  });
}

/** Xóa nhóm (dòng gắn bot xóa theo cascade). Không có ⇒ InboxNotFoundError. Audit 'settings.lark_group.delete'. */
export async function deleteLarkGroup(db: Db, actorUserId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(larkGroups)
      .where(eq(larkGroups.id, id))
      .returning({ id: larkGroups.id, name: larkGroups.name });
    if (!deleted) throw new InboxNotFoundError(LARK_GROUP_NOT_FOUND);
    await tx.insert(auditLogs).values({
      userId: actorUserId,
      action: 'settings.lark_group.delete',
      entity: 'lark_group',
      entityId: id,
      data: { name: deleted.name },
    });
  });
}

/**
 * Cấu hình đã giải mã của MỘT nhóm (nút "Gửi thử"). Không có ⇒ InboxNotFoundError; secret không giải mã được ⇒
 * InboxValidationError (gửi không chữ ký thì Lark cũng từ chối).
 */
export async function getLarkGroupConfig(db: Db, cipher: CredentialsCipher, id: string): Promise<LarkConfig> {
  const [row] = await db
    .select({ webhookUrl: larkGroups.webhookUrl, secretEnc: larkGroups.secretEnc })
    .from(larkGroups)
    .where(eq(larkGroups.id, id));
  if (!row) throw new InboxNotFoundError(LARK_GROUP_NOT_FOUND);
  if (!row.secretEnc) return { webhookUrl: row.webhookUrl, secret: null };
  try {
    return { webhookUrl: row.webhookUrl, secret: decryptSecret(cipher, row.secretEnc) };
  } catch {
    throw new InboxValidationError(LARK_GROUP_SECRET_UNREADABLE);
  }
}

/**
 * Nơi gửi thông báo Lark cho hội thoại gắn `chatbotId`:
 * - bot thuộc ≥1 nhóm ⇒ CHỈ các nhóm đó (theo tên nhóm). Nhóm có secret không giải mã được ⇒ log warn và BỎ QUA
 *   (gửi không chữ ký thì Lark từ chối) — không rơi về nhóm chung;
 * - bot không thuộc nhóm nào / chatbotId null ⇒ [getLarkConfig(db, cipher, fallback)] (nhóm chung như trước), hoặc
 *   [] nếu nhóm chung chưa cấu hình.
 * Bỏ trùng webhook (hai nhóm cùng URL ⇒ gửi một lần, giữ nhóm đầu theo tên).
 */
export async function getLarkTargets(
  db: Db,
  cipher: CredentialsCipher,
  input: { chatbotId: string | null },
  fallback?: LarkFallback,
  logger?: Pick<PipelineLogger, 'warn'>,
): Promise<LarkTarget[]> {
  if (input.chatbotId) {
    const rows = await db
      .select({ id: larkGroups.id, webhookUrl: larkGroups.webhookUrl, secretEnc: larkGroups.secretEnc })
      .from(larkGroupChatbots)
      .innerJoin(larkGroups, eq(larkGroups.id, larkGroupChatbots.larkGroupId))
      .where(eq(larkGroupChatbots.chatbotId, input.chatbotId))
      .orderBy(asc(larkGroups.name), asc(larkGroups.createdAt));
    if (rows.length > 0) {
      const targets: LarkTarget[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.webhookUrl)) continue;
        let secret: string | null = null;
        if (row.secretEnc) {
          try {
            secret = decryptSecret(cipher, row.secretEnc);
          } catch {
            logger?.warn(
              { larkGroupId: row.id, chatbotId: input.chatbotId },
              'Bỏ qua nhóm Lark: không giải mã được secret',
            );
            continue;
          }
        }
        seen.add(row.webhookUrl);
        targets.push({ larkGroupId: row.id, webhookUrl: row.webhookUrl, secret });
      }
      return targets;
    }
  }
  const global = await getLarkConfig(db, cipher, fallback);
  return global ? [{ larkGroupId: null, ...global }] : [];
}

/** chatbot_id hiện tại của hội thoại (null nếu không gắn bot hoặc không có hội thoại). */
export async function conversationChatbotId(db: Db, conversationId: string): Promise<string | null> {
  const [row] = await db
    .select({ chatbotId: conversations.chatbotId })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row?.chatbotId ?? null;
}

export interface NotifyConversationLarkOptions extends NotifyLarkOptions {
  /** env LARK_WEBHOOK_URL/SECRET — chỉ dùng cho nhóm chung khi admin chưa từng lưu cấu hình. */
  fallback?: LarkFallback | null;
  logger: Pick<PipelineLogger, 'warn'>;
}

/**
 * Gửi thẻ Lark của một hội thoại tới mọi nơi getLarkTargets chọn. `chatbotId` undefined ⇒ đọc từ hội thoại.
 * Lỗi của từng nhóm chỉ log warn (không chứa webhook/secret) — các nhóm khác vẫn gửi. Lỗi đọc cấu hình ⇒ ném
 * (caller tự bắt). Trả số nơi gửi thành công / tổng số nơi.
 */
export async function notifyConversationLark(
  db: Db,
  cipher: CredentialsCipher,
  target: { conversationId: string; chatbotId?: string | null },
  card: LarkCardMessage,
  options: NotifyConversationLarkOptions,
): Promise<{ sent: number; targets: number }> {
  const { fallback, logger, ...notifyOptions } = options;
  const chatbotId =
    target.chatbotId !== undefined
      ? target.chatbotId
      : await conversationChatbotId(db, target.conversationId);
  const targets = await getLarkTargets(db, cipher, { chatbotId }, fallback ?? undefined, logger);
  const results = await Promise.allSettled(targets.map((t) => notifyLark(t, card, notifyOptions)));
  let sent = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      sent += 1;
      return;
    }
    const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
    logger.warn(
      { conversationId: target.conversationId, larkGroupId: targets[i]!.larkGroupId, err },
      'Không gửi được thông báo Lark',
    );
  });
  return { sent, targets: targets.length };
}
