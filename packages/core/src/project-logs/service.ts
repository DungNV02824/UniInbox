// "Nhật ký công trình": AI ghi một dòng khi bot xác nhận tiếp nhận một công trình người nhắn gửi (bot bật
// CaptureConfig.projectLog). Bấm dòng trên web ⇒ khung chat cuộn tới anchor_message_id và tô sáng message_ids.
// Hàm KHÔNG phát realtime: bên gọi (runtime AI / API) phát conversation.updated.
import { auditLogs, messages, projectLogs, type Db, type ProjectLogField } from '@dezon/db';
import {
  CAPTURE_LIMITS,
  PROJECT_LOG_LIMITS,
  type ConversationSummary,
  type ProjectLogConfig,
  type ProjectLogDto,
} from '@dezon/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { truncateCodePoints } from '../contacts/profile-fields';
import { assertCanView, CONVERSATION_NOT_FOUND } from '../inbox/access';
import { InboxNotFoundError } from '../inbox/errors';
import { loadSummary, type DbLike } from '../inbox/read-model';
import type { InboxContext, Viewer } from '../inbox/types';

export const PROJECT_LOG_NOT_FOUND = 'Không tìm thấy dòng nhật ký công trình';

export interface RecordProjectLogsInput {
  conversationId: string;
  chatbotId: string | null;
  /** Lượt AI ghi nhật ký; có ⇒ chống ghi trùng khi job chạy lại (đã có dòng của aiRunId ⇒ trả id cũ). */
  aiRunId: string | null;
  config: ProjectLogConfig;
  /** Mỗi công trình AI trả về: khóa trường ⇒ giá trị (khóa lạ / trường tắt bị bỏ). */
  entries: Array<Record<string, string>>;
  /** Tin khách của lượt (ảnh, địa chỉ…). */
  customerMessageIds: string[];
  /** Tin bot vừa gửi trả lời lượt đó. */
  botMessageIds: string[];
  now: Date;
}

/** Chuẩn hóa giá trị AI điền: gộp khoảng trắng, trim, cắt CAPTURE_LIMITS.valueMax ký tự. Không phải chuỗi ⇒ ''. */
function cleanValue(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return truncateCodePoints(raw.replace(/\s+/g, ' ').trim(), CAPTURE_LIMITS.valueMax).trim();
}

/**
 * Một công trình ⇒ các trường BẬT của cấu hình (theo thứ tự cấu hình, nhãn của cấu hình), bỏ trường trống.
 * Không còn trường nào ⇒ [].
 */
export function projectLogFieldsOf(
  config: ProjectLogConfig,
  entry: Record<string, unknown>,
): ProjectLogField[] {
  const out: ProjectLogField[] = [];
  for (const field of config.fields) {
    if (!field.enabled || !Object.hasOwn(entry, field.key)) continue;
    const value = cleanValue(entry[field.key]);
    if (value !== '') out.push({ key: field.key, label: field.label, value });
  }
  return out;
}

/** Bỏ trùng, giữ thứ tự xuất hiện đầu tiên. */
function uniqueInOrder(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Tin để cuộn tới: tin khách có ảnh sớm nhất (sent_at, id) của lượt; không có ⇒ tin khách sớm nhất; không có tin
 * khách nào còn trong hội thoại ⇒ tin bot đầu tiên; không có ⇒ null.
 */
async function pickAnchor(
  db: DbLike,
  conversationId: string,
  customerMessageIds: string[],
  botMessageIds: string[],
): Promise<string | null> {
  if (customerMessageIds.length > 0) {
    const rows = await db
      .select({
        id: messages.id,
        hasImage: sql<boolean>`${messages.attachments} @> '[{"type":"image"}]'::jsonb`,
      })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), inArray(messages.id, customerMessageIds)))
      .orderBy(asc(messages.sentAt), asc(messages.id));
    const withImage = rows.find((r) => r.hasImage);
    if (withImage) return withImage.id;
    if (rows[0]) return rows[0].id;
  }
  return botMessageIds[0] ?? null;
}

/**
 * Ghi các dòng nhật ký công trình của một lượt bot. Không làm gì (trả []) khi cấu hình tắt hoặc không có công trình.
 * - Tối đa PROJECT_LOG_LIMITS.maxEntriesPerTurn công trình; mỗi công trình chỉ giữ trường BẬT (projectLogFieldsOf),
 *   công trình không còn giá trị nào bị bỏ.
 * - message_ids = tin khách ++ tin bot (bỏ trùng, giữ thứ tự); anchor = pickAnchor.
 * - created_at: công trình thứ i = now − i ms ⇒ danh sách mới-nhất-trước hiện các công trình của một lượt đúng thứ
 *   tự AI liệt kê.
 * - Chống trùng theo aiRunId (job chạy lại): đã có dòng của aiRunId ⇒ trả id các dòng đó, không ghi thêm. Nên gọi
 *   trong transaction (khóa advisory theo aiRunId giữ tới hết transaction).
 * Trả id các dòng (theo thứ tự công trình).
 */
export async function recordProjectLogs(tx: DbLike, input: RecordProjectLogsInput): Promise<string[]> {
  if (!input.config.enabled || input.entries.length === 0) return [];
  const rows = input.entries
    .slice(0, PROJECT_LOG_LIMITS.maxEntriesPerTurn)
    .map((entry) => projectLogFieldsOf(input.config, entry))
    .filter((fields) => fields.length > 0);
  if (rows.length === 0) return [];

  if (input.aiRunId) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`project_logs:${input.aiRunId}`}, 0))`,
    );
    const existing = await tx
      .select({ id: projectLogs.id })
      .from(projectLogs)
      .where(eq(projectLogs.aiRunId, input.aiRunId))
      .orderBy(desc(projectLogs.createdAt), asc(projectLogs.id));
    if (existing.length > 0) return existing.map((r) => r.id);
  }

  const messageIds = uniqueInOrder([...input.customerMessageIds, ...input.botMessageIds]);
  const anchorMessageId = await pickAnchor(
    tx,
    input.conversationId,
    uniqueInOrder(input.customerMessageIds),
    uniqueInOrder(input.botMessageIds),
  );
  const inserted = await tx
    .insert(projectLogs)
    .values(
      rows.map((fields, i) => {
        const at = new Date(input.now.getTime() - i);
        return {
          conversationId: input.conversationId,
          chatbotId: input.chatbotId,
          aiRunId: input.aiRunId,
          fields,
          messageIds,
          anchorMessageId,
          createdAt: at,
          updatedAt: at,
        };
      }),
    )
    .returning({ id: projectLogs.id });
  return inserted.map((r) => r.id);
}

type ProjectLogRow = typeof projectLogs.$inferSelect;

function toProjectLogDto(row: ProjectLogRow): ProjectLogDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    fields: (row.fields ?? []).map((f) => ({ key: f.key, label: f.label, value: f.value })),
    messageIds: row.messageIds ?? [],
    anchorMessageId: row.anchorMessageId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Nhật ký công trình của hội thoại, MỚI NHẤT trước (created_at desc, id desc), tối đa `limit` dòng. Không kiểm quyền. */
export async function listProjectLogs(
  db: DbLike,
  conversationId: string,
  limit: number = PROJECT_LOG_LIMITS.detailMaxItems,
): Promise<ProjectLogDto[]> {
  const rows = await db
    .select()
    .from(projectLogs)
    .where(eq(projectLogs.conversationId, conversationId))
    .orderBy(desc(projectLogs.createdAt), desc(projectLogs.id))
    .limit(limit);
  return rows.map(toProjectLogDto);
}

export interface DeleteProjectLogResult {
  /** Nhật ký còn lại (như ConversationDetail.projectLogs). */
  projectLogs: ProjectLogDto[];
  /** Summary hội thoại để bên gọi phát conversation.updated. */
  conversation: ConversationSummary;
}

/**
 * Nhân viên xóa một dòng nhật ký công trình. Quyền: xem được hội thoại (assertCanView — ném InboxNotFoundError /
 * InboxForbiddenError); dòng không thuộc hội thoại ⇒ InboxNotFoundError. Audit 'project_log.delete' chỉ ghi logId
 * (không ghi giá trị trường). Trả nhật ký còn lại + summary (bên gọi phát realtime).
 */
export async function deleteProjectLog(
  db: Db,
  viewer: Viewer,
  conversationId: string,
  logId: string,
  ctx: InboxContext,
): Promise<DeleteProjectLogResult> {
  await assertCanView(db, viewer, conversationId);
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(projectLogs)
      .where(and(eq(projectLogs.id, logId), eq(projectLogs.conversationId, conversationId)))
      .returning({ id: projectLogs.id });
    if (!deleted) throw new InboxNotFoundError(PROJECT_LOG_NOT_FOUND);
    await tx.insert(auditLogs).values({
      userId: viewer.id,
      action: 'project_log.delete',
      entity: 'conversation',
      entityId: conversationId,
      data: { logId },
    });
  });
  const [logs, conversation] = await Promise.all([
    listProjectLogs(db, conversationId),
    loadSummary(db, conversationId, ctx),
  ]);
  if (!conversation) throw new InboxNotFoundError(CONVERSATION_NOT_FOUND);
  return { projectLogs: logs, conversation };
}
