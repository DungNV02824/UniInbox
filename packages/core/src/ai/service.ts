// CRUD chatbot + thao tác chatbot/handoff trên hội thoại (gọi từ apps/api). Ghi audit_logs.
import {
  aiRuns,
  auditLogs,
  channelAccounts,
  chatbots,
  conversations,
  handoffs,
  messages,
  type Db,
} from '@dezon/db';
import type {
  AiRunDto,
  ChatbotDto,
  ChatbotSummary,
  CreateChatbotRequest,
  UpdateChatbotRequest,
} from '@dezon/shared';
import { and, asc, count, desc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { CONVERSATION_NOT_FOUND, canViewConversation } from '../inbox/access';
import { resolveOpenHandoffs, type UpdateConversationResult } from '../inbox/commands';
import { InboxForbiddenError, InboxNotFoundError, InboxValidationError } from '../inbox/errors';
import { loadSummary, type DbLike } from '../inbox/read-model';
import type { InboxContext, Viewer } from '../inbox/types';
import { isUniqueViolation } from '../pipeline/helpers';
import { ChatbotNameConflictError } from './errors';
import { normalizeForMatch } from './prefilter';

/** Số lần chạy AI trả về cho "Nhật ký AI". */
export const AI_RUNS_PAGE_SIZE = 20;

const CHATBOT_NOT_FOUND = 'Không tìm thấy chatbot';

type ChatbotRow = typeof chatbots.$inferSelect;
type ChatbotSet = Partial<typeof chatbots.$inferInsert>;

/** Số hội thoại đang gắn mỗi bot (subquery đếm theo nhóm — không N+1). */
function conversationCounts(db: DbLike) {
  return db
    .select({ chatbotId: conversations.chatbotId, n: count().as('conv_n') })
    .from(conversations)
    .groupBy(conversations.chatbotId)
    .as('bot_conv_counts');
}

async function selectChatbotsWithCount(db: DbLike, where: SQL | undefined) {
  const counts = conversationCounts(db);
  return db
    .select({ bot: chatbots, n: counts.n })
    .from(chatbots)
    .leftJoin(counts, eq(counts.chatbotId, chatbots.id))
    .where(where)
    .orderBy(asc(chatbots.name), asc(chatbots.id));
}

function toDto(row: ChatbotRow, conversationCount: number): ChatbotDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    instructions: row.instructions,
    knowledge: row.knowledge,
    examples: row.examples,
    handoffKeywords: row.handoffKeywords,
    notifyKeywords: row.notifyKeywords,
    handoffMessage: row.handoffMessage,
    model: row.model,
    temperature: row.temperature,
    replyDelaySec: row.replyDelaySec,
    maxWaitSec: row.maxWaitSec,
    maxRepliesPerHour: row.maxRepliesPerHour,
    escalateWhenUnsure: row.escalateWhenUnsure,
    responseSpeed: row.responseSpeed,
    handoffAckLabel: row.handoffAckLabel,
    handoffResolveLabel: row.handoffResolveLabel,
    handoffActionLark: row.handoffActionLark,
    handoffAckMessage: row.handoffAckMessage,
    handoffResolveMessage: row.handoffResolveMessage,
    aiHandoffMode: row.aiHandoffMode,
    agentReplyMode: row.agentReplyMode,
    agentPauseMinutes: row.agentPauseMinutes,
    handoffReminderMin: row.handoffReminderMin,
    conversationCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Trim + bỏ trùng theo dạng không dấu (giữ bản viết đầu tiên). */
function cleanKeywords(keywords: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const kw = raw.trim();
    const key = normalizeForMatch(kw);
    if (!kw || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
  }
  return out;
}

/**
 * Một từ khóa không được nằm ở cả "Báo nhân viên + DỪNG bot" (handoffKeywords) lẫn "Báo nhân viên, bot VẪN trả
 * lời" (notifyKeywords) — so theo dạng không dấu (normalizeForMatch). Trùng ⇒ InboxValidationError (HTTP 400).
 */
function assertNoKeywordOverlap(handoffKeywords: readonly string[], notifyKeywords: readonly string[]): void {
  const handoff = new Set(handoffKeywords.map((kw) => normalizeForMatch(kw)));
  const dup = notifyKeywords.find((kw) => handoff.has(normalizeForMatch(kw)));
  if (dup !== undefined) {
    throw new InboxValidationError(`Từ khóa "${dup}" đang nằm ở cả hai danh sách`);
  }
}

/** Chuỗi rỗng sau trim ⇒ null (description / handoffMessage / tên nút / tin khi bấm nút). */
const nullIfBlank = (v: string | null | undefined) => (v == null || v.trim() === '' ? null : v.trim());

function toSet(input: Partial<CreateChatbotRequest>): ChatbotSet {
  const set: ChatbotSet = {};
  if (input.name !== undefined) set.name = input.name.trim();
  if (input.description !== undefined) set.description = nullIfBlank(input.description);
  if (input.isActive !== undefined) set.isActive = input.isActive;
  if (input.instructions !== undefined) set.instructions = input.instructions;
  if (input.knowledge !== undefined) set.knowledge = input.knowledge;
  if (input.examples !== undefined) set.examples = input.examples;
  if (input.handoffKeywords !== undefined) set.handoffKeywords = cleanKeywords(input.handoffKeywords);
  if (input.notifyKeywords !== undefined) set.notifyKeywords = cleanKeywords(input.notifyKeywords);
  if (input.handoffMessage !== undefined) set.handoffMessage = nullIfBlank(input.handoffMessage);
  if (input.model !== undefined) set.model = nullIfBlank(input.model);
  if (input.temperature !== undefined) set.temperature = input.temperature;
  if (input.replyDelaySec !== undefined) set.replyDelaySec = input.replyDelaySec;
  if (input.maxWaitSec !== undefined) set.maxWaitSec = input.maxWaitSec;
  if (input.maxRepliesPerHour !== undefined) set.maxRepliesPerHour = input.maxRepliesPerHour;
  if (input.escalateWhenUnsure !== undefined) set.escalateWhenUnsure = input.escalateWhenUnsure;
  if (input.responseSpeed !== undefined) set.responseSpeed = input.responseSpeed;
  if (input.handoffAckLabel !== undefined) set.handoffAckLabel = nullIfBlank(input.handoffAckLabel);
  if (input.handoffResolveLabel !== undefined)
    set.handoffResolveLabel = nullIfBlank(input.handoffResolveLabel);
  if (input.handoffActionLark !== undefined) set.handoffActionLark = input.handoffActionLark;
  if (input.handoffAckMessage !== undefined) set.handoffAckMessage = nullIfBlank(input.handoffAckMessage);
  if (input.handoffResolveMessage !== undefined)
    set.handoffResolveMessage = nullIfBlank(input.handoffResolveMessage);
  if (input.aiHandoffMode !== undefined) set.aiHandoffMode = input.aiHandoffMode;
  if (input.agentReplyMode !== undefined) set.agentReplyMode = input.agentReplyMode;
  if (input.agentPauseMinutes !== undefined) set.agentPauseMinutes = input.agentPauseMinutes;
  if (input.handoffReminderMin !== undefined) set.handoffReminderMin = input.handoffReminderMin;
  return set;
}

/** Ghi bot; vi phạm unique (tên) ⇒ ChatbotNameConflictError. */
async function mapConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isUniqueViolation(error)) throw new ChatbotNameConflictError();
    throw error;
  }
}

/**
 * GET /chatbots. Admin: mọi bot; agent: chỉ bot is_active. Sắp theo tên (asc).
 * conversationCount = số hội thoại có chatbot_id = bot (bất kể ai_mode).
 */
export async function listChatbots(db: Db, viewer: Viewer): Promise<ChatbotSummary[]> {
  const rows = await selectChatbotsWithCount(
    db,
    viewer.role === 'admin' ? undefined : eq(chatbots.isActive, true),
  );
  return rows.map((r) => ({
    id: r.bot.id,
    name: r.bot.name,
    description: r.bot.description,
    isActive: r.bot.isActive,
    conversationCount: Number(r.n ?? 0),
    handoffAckLabel: r.bot.handoffAckLabel,
    handoffResolveLabel: r.bot.handoffResolveLabel,
  }));
}

/** GET /chatbots/:id (admin). Không có ⇒ InboxNotFoundError('Không tìm thấy chatbot'). */
export async function getChatbot(db: Db, id: string): Promise<ChatbotDto> {
  const [row] = await selectChatbotsWithCount(db, eq(chatbots.id, id));
  if (!row) throw new InboxNotFoundError(CHATBOT_NOT_FOUND);
  return toDto(row.bot, Number(row.n ?? 0));
}

/**
 * POST /chatbots (admin). Trường thiếu dùng DEFAULT của DB; handoffKeywords / notifyKeywords trim + bỏ trùng
 * (không dấu); từ khóa nằm ở cả hai danh sách ⇒ InboxValidationError. created_by = actorUserId. Trùng tên ⇒
 * ChatbotNameConflictError. Audit 'chatbot.create'.
 */
export async function createChatbot(
  db: Db,
  actorUserId: string,
  input: CreateChatbotRequest,
): Promise<ChatbotDto> {
  const set = toSet(input);
  assertNoKeywordOverlap(set.handoffKeywords ?? [], set.notifyKeywords ?? []);
  const row = await mapConflict(() =>
    db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(chatbots)
        .values({ ...set, name: input.name.trim(), createdBy: actorUserId })
        .returning();
      if (!saved) throw new Error('Không tạo được chatbot');
      await tx.insert(auditLogs).values({
        userId: actorUserId,
        action: 'chatbot.create',
        entity: 'chatbot',
        entityId: saved.id,
        data: { name: saved.name },
      });
      return saved;
    }),
  );
  return toDto(row, 0);
}

/**
 * PATCH /chatbots/:id (admin). Không có ⇒ InboxNotFoundError; trùng tên ⇒ ChatbotNameConflictError. Sửa một
 * trong hai danh sách từ khóa ⇒ kiểm trùng trên kết quả sau khi gộp (giá trị đang lưu + patch), trùng ⇒
 * InboxValidationError. Audit 'chatbot.update'.
 */
export async function updateChatbot(
  db: Db,
  actorUserId: string,
  id: string,
  input: UpdateChatbotRequest,
): Promise<ChatbotDto> {
  const set = toSet(input);
  await mapConflict(() =>
    db.transaction(async (tx) => {
      if (set.handoffKeywords !== undefined || set.notifyKeywords !== undefined) {
        // Khóa dòng để hai PATCH song song (mỗi bên sửa một danh sách) không cùng lọt kiểm trùng.
        const [stored] = await tx
          .select({ handoffKeywords: chatbots.handoffKeywords, notifyKeywords: chatbots.notifyKeywords })
          .from(chatbots)
          .where(eq(chatbots.id, id))
          .for('update');
        if (!stored) throw new InboxNotFoundError(CHATBOT_NOT_FOUND);
        assertNoKeywordOverlap(
          set.handoffKeywords ?? stored.handoffKeywords,
          set.notifyKeywords ?? stored.notifyKeywords,
        );
      }
      const [saved] = await tx
        .update(chatbots)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(chatbots.id, id))
        .returning({ id: chatbots.id });
      if (!saved) throw new InboxNotFoundError(CHATBOT_NOT_FOUND);
      // Không ghi nội dung (hướng dẫn/kiến thức), chỉ tên trường đã sửa.
      await tx.insert(auditLogs).values({
        userId: actorUserId,
        action: 'chatbot.update',
        entity: 'chatbot',
        entityId: id,
        data: { fields: Object.keys(set) },
      });
    }),
  );
  return getChatbot(db, id);
}

export interface DeleteChatbotResult {
  /** Hội thoại đã bị gỡ bot (ai_mode ⇒ 'off'), mới nhất (last_message_at) trước — API phát realtime có giới hạn. */
  detachedConversationIds: string[];
}

/**
 * DELETE /chatbots/:id (admin). Trong một transaction: hội thoại đang gắn bot ⇒ chatbot_id null,
 * ai_mode 'off'; kênh có default_chatbot_id = bot ⇒ null (FK cũng SET NULL); xóa bot (ai_runs.chatbot_id
 * tự SET NULL). Không có ⇒ InboxNotFoundError. Audit 'chatbot.delete'.
 */
export async function deleteChatbot(db: Db, actorUserId: string, id: string): Promise<DeleteChatbotResult> {
  return db.transaction(async (tx) => {
    const [bot] = await tx
      .select({ id: chatbots.id, name: chatbots.name })
      .from(chatbots)
      .where(eq(chatbots.id, id))
      .for('update');
    if (!bot) throw new InboxNotFoundError(CHATBOT_NOT_FOUND);
    const now = new Date();
    const detached = await tx
      .update(conversations)
      .set({ chatbotId: null, aiMode: 'off', updatedAt: now })
      .where(eq(conversations.chatbotId, id))
      .returning({ id: conversations.id, lastMessageAt: conversations.lastMessageAt });
    await tx
      .update(channelAccounts)
      .set({ defaultChatbotId: null, updatedAt: now })
      .where(eq(channelAccounts.defaultChatbotId, id));
    await tx.delete(chatbots).where(eq(chatbots.id, id));
    await tx.insert(auditLogs).values({
      userId: actorUserId,
      action: 'chatbot.delete',
      entity: 'chatbot',
      entityId: id,
      data: { name: bot.name, detachedConversations: detached.length },
    });
    const recentFirst = [...detached].sort(
      (a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0),
    );
    return { detachedConversationIds: recentFirst.map((r) => r.id) };
  });
}

// ---------- Thao tác trên hội thoại ----------

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

interface LockedConversation {
  id: string;
  assignedUserId: string | null;
  chatbotId: string | null;
  status: (typeof conversations.$inferSelect)['status'];
}

/**
 * Khóa dòng hội thoại (FOR UPDATE), kiểm quyền xem, chạy `fn` trong cùng transaction rồi trả summary mới.
 */
async function withConversation(
  db: Db,
  viewer: Viewer,
  conversationId: string,
  ctx: InboxContext,
  fn: (tx: Tx, conv: LockedConversation) => Promise<void>,
): Promise<UpdateConversationResult> {
  const previousAssigneeId = await db.transaction(async (tx) => {
    const [conv] = await tx
      .select({
        id: conversations.id,
        assignedUserId: conversations.assignedUserId,
        chatbotId: conversations.chatbotId,
        status: conversations.status,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('update');
    if (!conv) throw new InboxNotFoundError(CONVERSATION_NOT_FOUND);
    if (!canViewConversation(viewer, conv)) {
      throw new InboxForbiddenError('Bạn không có quyền thao tác trên hội thoại này');
    }
    await fn(tx, conv);
    return conv.assignedUserId;
  });
  const summary = await loadSummary(db, conversationId, ctx);
  if (!summary) throw new InboxNotFoundError(CONVERSATION_NOT_FOUND);
  return { conversation: summary, previousAssigneeId };
}

const audit = (viewer: Viewer, action: string, conversationId: string, data: Record<string, unknown>) => ({
  userId: viewer.id,
  action,
  entity: 'conversation',
  entityId: conversationId,
  data,
});

/**
 * PATCH /conversations/:id/chatbot. Viewer phải xem được hội thoại (canViewConversation) ⇒ không thì
 * InboxForbiddenError. chatbotId ≠ null: bot phải tồn tại và is_active (không ⇒ InboxValidationError);
 * set chatbot_id = id, ai_mode 'auto', ai_paused_until null — chọn lại ĐÚNG bot đang gắn cũng vậy (bật lại
 * bot sau khi ai_mode bị tắt, ví dụ sau "Xong"). Đang pending_human mà bật bot ⇒ coi như "trả lại cho AI":
 * đóng handoff mở, status 'open', xóa handoff_reason/handoff_at (tránh bot chạy rồi bị chặn vì chờ người).
 * chatbotId null: chatbot_id null, ai_mode 'off' (không đụng status/handoff). Audit 'conversation.chatbot'
 * { from, to[, resolvedHandoffIds] }. Trả ConversationSummary mới (API phát conversation.updated).
 */
export async function setConversationChatbot(
  db: Db,
  viewer: Viewer,
  conversationId: string,
  chatbotId: string | null,
  ctx: InboxContext,
): Promise<UpdateConversationResult> {
  return withConversation(db, viewer, conversationId, ctx, async (tx, conv) => {
    const now = ctx.now();
    if (chatbotId) {
      const [bot] = await tx
        .select({ id: chatbots.id, isActive: chatbots.isActive })
        .from(chatbots)
        .where(eq(chatbots.id, chatbotId));
      if (!bot) throw new InboxValidationError('Chatbot không tồn tại');
      if (!bot.isActive) throw new InboxValidationError('Chatbot đang tắt, hãy bật bot trước khi dùng');
    }
    const resolvedHandoffIds =
      chatbotId && conv.status === 'pending_human'
        ? await resolveOpenHandoffs(tx, conv.id, viewer.id, now)
        : [];
    const reopen = chatbotId !== null && conv.status === 'pending_human';
    await tx
      .update(conversations)
      .set(
        chatbotId
          ? {
              chatbotId,
              aiMode: 'auto',
              aiPausedUntil: null,
              updatedAt: now,
              ...(reopen ? { status: 'open' as const, handoffReason: null, handoffAt: null } : {}),
            }
          : { chatbotId: null, aiMode: 'off', updatedAt: now },
      )
      .where(eq(conversations.id, conv.id));
    await tx.insert(auditLogs).values(
      audit(viewer, 'conversation.chatbot', conv.id, {
        from: conv.chatbotId,
        to: chatbotId,
        ...(reopen ? { resolvedHandoffIds } : {}),
      }),
    );
  });
}

/**
 * Có nên "đánh thức" chatbot ngay không (job AI_KICK_JOB_NAME): hội thoại có bot đang bật (bot is_active,
 * ai_mode 'auto'), không pending_human (trừ bot aiHandoffMode 'continue'), không đang tạm dừng, và tin cuối cùng (bỏ qua tin system) là của
 * khách — tức khách đang chờ mà chưa ai trả lời. Gọi sau bật bot / "trả lại cho AI" / "Tiếp tục AI".
 */
export async function needsChatbotKick(db: DbLike, conversationId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({
      aiPausedUntil: conversations.aiPausedUntil,
      lastSender: sql<string | null>`(
        select m.sender_type from ${messages} m
        where m.conversation_id = ${conversations.id} and m.sender_type <> 'system'
        order by m.sent_at desc, m.id desc
        limit 1
      )`,
    })
    .from(conversations)
    .innerJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.aiMode, 'auto'),
        // Chờ người ⇒ không đánh thức — trừ bot 'continue' (AI tự chuyển mà bot vẫn trả lời).
        or(ne(conversations.status, 'pending_human'), eq(chatbots.aiHandoffMode, 'continue')),
        eq(chatbots.isActive, true),
      ),
    );
  if (!row || row.lastSender !== 'customer') return false;
  return !row.aiPausedUntil || row.aiPausedUntil <= now;
}

/** POST /conversations/:id/ai/resume: ai_paused_until = null (quyền như trên). Audit 'conversation.ai_resume'. */
export async function resumeConversationAi(
  db: Db,
  viewer: Viewer,
  conversationId: string,
  ctx: InboxContext,
): Promise<UpdateConversationResult> {
  return withConversation(db, viewer, conversationId, ctx, async (tx, conv) => {
    await tx
      .update(conversations)
      .set({ aiPausedUntil: null, updatedAt: ctx.now() })
      .where(eq(conversations.id, conv.id));
    await tx.insert(auditLogs).values(audit(viewer, 'conversation.ai_resume', conv.id, {}));
  });
}

/**
 * POST /conversations/:id/handoff/ack ("Nhận xử lý"). Handoff mở mới nhất (resolved_at null) ⇒
 * acknowledged_by = viewer, acknowledged_at = now (đã ack thì giữ nguyên). Hội thoại chưa phân công ⇒
 * phân công cho viewer. Không có handoff mở ⇒ InboxValidationError. Audit 'handoff.ack'.
 */
export interface AckHandoffResult extends UpdateConversationResult {
  /** Handoff vừa được ack ở lần bấm này; null = đã có người nhận từ trước (bấm lại không báo Lark lần nữa). */
  ackedHandoffId: string | null;
}

export async function ackHandoff(
  db: Db,
  viewer: Viewer,
  conversationId: string,
  ctx: InboxContext,
): Promise<AckHandoffResult> {
  let ackedHandoffId: string | null = null;
  const result = await withConversation(db, viewer, conversationId, ctx, async (tx, conv) => {
    const now = ctx.now();
    const [open] = await tx
      .select({ id: handoffs.id, acknowledgedBy: handoffs.acknowledgedBy })
      .from(handoffs)
      .where(and(eq(handoffs.conversationId, conv.id), isNull(handoffs.resolvedAt)))
      .orderBy(desc(handoffs.createdAt))
      .limit(1);
    if (!open) throw new InboxValidationError('Hội thoại không có yêu cầu chuyển người nào đang mở');
    if (!open.acknowledgedBy) {
      await tx
        .update(handoffs)
        .set({ acknowledgedBy: viewer.id, acknowledgedAt: now, updatedAt: now })
        .where(eq(handoffs.id, open.id));
      ackedHandoffId = open.id;
    }
    const assign = conv.assignedUserId === null;
    if (assign) {
      await tx
        .update(conversations)
        .set({ assignedUserId: viewer.id, updatedAt: now })
        .where(eq(conversations.id, conv.id));
    }
    await tx
      .insert(auditLogs)
      .values(audit(viewer, 'handoff.ack', conv.id, { handoffId: open.id, assigned: assign }));
  });
  return { ...result, ackedHandoffId };
}

/**
 * POST /conversations/:id/handoff/resolve ("Đã xong, trả lại cho AI"). Mọi handoff mở ⇒ resolved_at = now
 * (ack luôn nếu chưa); conversation: status 'open', ai_mode = chatbot_id ? 'auto' : 'off',
 * ai_paused_until null, handoff_reason null, handoff_at null. Audit 'handoff.resolve'.
 * Không có handoff mở và hội thoại không ở pending_human ⇒ không làm gì (bấm hai lần không lỗi).
 */
export interface ResolveHandoffResult extends UpdateConversationResult {
  /** Các handoff vừa đóng ở lần bấm này ([] = bấm lại / không có gì để đóng). */
  resolvedHandoffIds: string[];
}

export async function resolveHandoff(
  db: Db,
  viewer: Viewer,
  conversationId: string,
  ctx: InboxContext,
): Promise<ResolveHandoffResult> {
  let resolvedHandoffIds: string[] = [];
  const result = await withConversation(db, viewer, conversationId, ctx, async (tx, conv) => {
    const now = ctx.now();
    const resolved = await resolveOpenHandoffs(tx, conv.id, viewer.id, now);
    resolvedHandoffIds = resolved;
    if (resolved.length === 0 && conv.status !== 'pending_human') return;
    await tx
      .update(conversations)
      .set({
        status: 'open',
        aiMode: conv.chatbotId ? 'auto' : 'off',
        aiPausedUntil: null,
        handoffReason: null,
        handoffAt: null,
        updatedAt: now,
      })
      .where(eq(conversations.id, conv.id));
    await tx.insert(auditLogs).values(
      audit(viewer, 'handoff.resolve', conv.id, {
        handoffIds: resolved,
        aiMode: conv.chatbotId ? 'auto' : 'off',
      }),
    );
  });
  return { ...result, resolvedHandoffIds };
}

/** GET /conversations/:id/ai-runs (admin): `limit` lần chạy mới nhất (createdAt desc), kèm tên bot. */
export async function listAiRuns(
  db: Db,
  conversationId: string,
  limit = AI_RUNS_PAGE_SIZE,
): Promise<AiRunDto[]> {
  const rows = await db
    .select({ run: aiRuns, chatbotName: chatbots.name })
    .from(aiRuns)
    .leftJoin(chatbots, eq(chatbots.id, aiRuns.chatbotId))
    .where(eq(aiRuns.conversationId, conversationId))
    .orderBy(desc(aiRuns.createdAt), desc(aiRuns.id))
    .limit(limit);
  return rows.map(({ run, chatbotName }) => ({
    id: run.id,
    createdAt: run.createdAt.toISOString(),
    decision: run.decision,
    model: run.model,
    latencyMs: run.latencyMs,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    reasoningSummary: run.reasoningSummary,
    error: run.error,
    toolCalls: run.toolCalls,
    chatbotName,
  }));
}
