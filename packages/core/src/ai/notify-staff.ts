// "Báo nhân viên, bot VẪN trả lời": khách nhắn từ khóa notifyKeywords của bot ⇒ báo nhân viên đúng một lần
// (tin system trong hội thoại + realtime handoff.created { botContinues: true } + thẻ Lark) mà KHÔNG chuyển người:
// không tạo handoffs, không đổi status/ai_mode, không lên lịch nhắc lại. Bot vẫn trả lời bình thường.
import { channelAccounts, contacts, conversations, messages, type Db } from '@dezon/db';
import { HANDOFF_REASON_LABELS } from '@dezon/shared';
import { and, eq, gt, sql } from 'drizzle-orm';
import { roomsForConversation } from '../realtime';
import { emitMessagesCreated, errorText } from './delivery';
import { notifyLarkSafe } from './escalate';
import { keywordHandoffReason, matchHandoffKeyword, normalizeForMatch } from './prefilter';
import type { AiRuntimeDeps } from './runtime';

/** Không báo lại cùng hội thoại + cùng từ khóa trong khoảng này (retry job, chạy lại, khách gửi nhiều ảnh liền). */
export const NOTIFY_STAFF_DEDUPE_SEC = 10 * 60;

/** Khóa Redis chống báo trùng (SET NX EX NOTIFY_STAFF_DEDUPE_SEC); từ khóa chuẩn hóa không dấu. */
export const notifyStaffDedupeKey = (conversationId: string, keyword: string): string =>
  `ai-notify:${conversationId}:${normalizeForMatch(keyword)}`;

/** Đầu tin system báo nhân viên (loadTurnHistory dùng nhận diện tin cũ chưa có dấu raw.notifyStaff). */
export const NOTIFY_STAFF_SYSTEM_PREFIX = 'Đã báo nhân viên: khách nhắn từ khóa ';

/** Tin system trong hội thoại khi đã báo nhân viên. */
export function notifyStaffSystemText(keyword: string): string {
  return `${NOTIFY_STAFF_SYSTEM_PREFIX}"${keyword}" — bot vẫn tiếp tục trả lời`;
}

/** Đoạn trích tin khách tối đa trong tóm tắt (thẻ Lark / thông báo trong app). */
const EXCERPT_MAX = 300;

export interface NotifyStaffInput {
  keyword: string;
  /** Tin khách của lượt (lấy đoạn trích tin chứa từ khóa cho tóm tắt). */
  customerTexts?: readonly (string | null)[];
  /** Lần chạy AI của lượt (gắn vào tin system). */
  aiRunId?: string | null;
}

/** Tóm tắt cho nhân viên: từ khóa + nhãn lý do (như pre-filter) + trích tin khách chứa từ khóa (nếu có). */
export function notifyStaffSummary(keyword: string, customerTexts: readonly (string | null)[] = []): string {
  const label = HANDOFF_REASON_LABELS[keywordHandoffReason(keyword)];
  const head = `Khách nhắn từ khóa báo nhân viên "${keyword}" (${label}) — bot vẫn tiếp tục trả lời`;
  const text = customerTexts.find((t): t is string => !!t && matchHandoffKeyword(t, [keyword]) !== null);
  if (!text) return head;
  const flat = text.replace(/\s+/g, ' ').trim();
  const excerpt = flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX - 1)}…` : flat;
  return `${head}. Tin khách: "${excerpt}"`;
}

/** Dấu trong messages.raw của tin system báo nhân viên (loadTurnHistory nhận diện tin này để đưa vào lịch sử). */
export interface NotifyStaffRaw {
  notifyStaff: { keyword: string };
}

/** raw của tin system "Đã báo nhân viên" (notifyStaffKeyword ghi). */
export const notifyStaffRaw = (keyword: string): NotifyStaffRaw => ({ notifyStaff: { keyword } });

/**
 * Giữ chỗ chống trùng: 'duplicate' = đã báo cùng từ khóa trong NOTIFY_STAFF_DEDUPE_SEC; 'claimed' = vừa lấy khóa
 * Redis (SET NX — chống hai job song song; phải nhả nếu chưa lưu được tin system); 'db' = Redis lỗi, dự phòng bằng
 * DB (tin system cùng nội dung trong khoảng đó) không thấy tin nào.
 */
async function claimNotify(
  db: Db,
  deps: AiRuntimeDeps,
  conversationId: string,
  keyword: string,
): Promise<'duplicate' | 'claimed' | 'db'> {
  try {
    const ok = await deps.redis.set(
      notifyStaffDedupeKey(conversationId, keyword),
      '1',
      'EX',
      NOTIFY_STAFF_DEDUPE_SEC,
      'NX',
    );
    return ok === null ? 'duplicate' : 'claimed';
  } catch (error) {
    deps.logger.warn(
      { conversationId, err: errorText(error) },
      'Không kiểm được chống trùng báo nhân viên qua Redis — dùng DB',
    );
    const [row] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.senderType, 'system'),
          eq(messages.text, notifyStaffSystemText(keyword)),
          gt(messages.createdAt, sql`now() - make_interval(secs => ${NOTIFY_STAFF_DEDUPE_SEC})`),
        ),
      )
      .limit(1);
    return row ? 'duplicate' : 'db';
  }
}

/** Nhả khóa chống trùng khi chưa lưu được tin system (để lần chạy sau còn báo được). Lỗi Redis chỉ log. */
async function releaseNotifyClaim(deps: AiRuntimeDeps, conversationId: string, keyword: string) {
  try {
    await deps.redis.del(notifyStaffDedupeKey(conversationId, keyword));
  } catch (error) {
    deps.logger.warn(
      { conversationId, err: errorText(error) },
      'Không nhả được khóa chống trùng báo nhân viên',
    );
  }
}

/**
 * Báo nhân viên vì từ khóa notifyKeywords (không chuyển người). Trả false nếu đã báo cùng từ khóa gần đây hoặc
 * không tìm thấy hội thoại. Các bước: chống trùng ⇒ tin system (status 'sent', ai_run_id, raw notifyStaffRaw) +
 * last_message_at ⇒ message.created ⇒ handoff.created { reasonCode = keywordHandoffReason(kw), summary, contactName,
 * channelName, botContinues: true } tới roomsForConversation ⇒ thẻ Lark vàng (lỗi realtime/Lark chỉ log). Lỗi DB
 * TRƯỚC khi tin system commit ⇒ nhả khóa Redis chống trùng rồi ném (runtime tự bắt) — lần chạy sau vẫn báo được.
 */
export async function notifyStaffKeyword(
  db: Db,
  deps: AiRuntimeDeps,
  conversationId: string,
  input: NotifyStaffInput,
): Promise<boolean> {
  const { keyword } = input;
  const claim = await claimNotify(db, deps, conversationId, keyword);
  if (claim === 'duplicate') return false;

  // Từ đây tới khi tin system commit: lỗi (hoặc không thấy hội thoại) ⇒ nhả khóa, nếu không khóa giữ 10 phút mà
  // nhân viên chưa hề được báo (bot thì đã nói với khách "em đã báo nhân viên").
  let persisted: { info: NotifyConversationInfo; systemId: string } | null;
  try {
    persisted = await persistNotifyMessage(db, deps, conversationId, input);
  } catch (error) {
    if (claim === 'claimed') await releaseNotifyClaim(deps, conversationId, keyword);
    throw error;
  }
  if (!persisted) {
    if (claim === 'claimed') await releaseNotifyClaim(deps, conversationId, keyword);
    return false;
  }
  const { info, systemId } = persisted;

  await emitMessagesCreated(db, deps, [systemId], conversationId);
  const reasonCode = keywordHandoffReason(keyword);
  const summary = notifyStaffSummary(keyword, input.customerTexts);
  try {
    deps.publisher.emit(roomsForConversation({ assignedUserId: info.assignedUserId }), 'handoff.created', {
      conversationId,
      reasonCode,
      summary,
      contactName: info.contactName,
      channelName: info.channelName,
      botContinues: true,
    });
  } catch (error) {
    // Tin system đã commit (không nhả khóa — chạy lại sẽ tạo tin trùng); vẫn gửi thẻ Lark.
    deps.logger.error(
      { conversationId, err: errorText(error) },
      'Không phát được handoff.created (báo nhân viên)',
    );
  }
  deps.logger.info({ conversationId, reasonCode }, 'Đã báo nhân viên (từ khóa báo, bot vẫn trả lời)');
  await notifyLarkSafe(db, deps, {
    conversationId,
    contactName: info.contactName,
    channelName: info.channelName,
    reasonCode,
    summary,
    botContinues: true,
  });
  return true;
}

interface NotifyConversationInfo {
  channelAccountId: string;
  assignedUserId: string | null;
  contactName: string;
  channelName: string;
}

/** Tìm hội thoại rồi lưu tin system + last_message_at trong một transaction. Không thấy hội thoại ⇒ null. */
async function persistNotifyMessage(
  db: Db,
  deps: AiRuntimeDeps,
  conversationId: string,
  input: NotifyStaffInput,
): Promise<{ info: NotifyConversationInfo; systemId: string } | null> {
  const { keyword } = input;
  const [info] = await db
    .select({
      channelAccountId: conversations.channelAccountId,
      assignedUserId: conversations.assignedUserId,
      contactName: contacts.displayName,
      channelName: channelAccounts.displayName,
    })
    .from(conversations)
    .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(conversations.id, conversationId));
  if (!info) return null;

  const now = deps.ctx.now();
  const systemId = await db.transaction(async (tx) => {
    const [system] = await tx
      .insert(messages)
      .values({
        conversationId,
        channelAccountId: info.channelAccountId,
        senderType: 'system',
        text: notifyStaffSystemText(keyword),
        attachments: [],
        status: 'sent',
        aiRunId: input.aiRunId ?? null,
        raw: notifyStaffRaw(keyword),
        sentAt: now,
      })
      .returning({ id: messages.id });
    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(eq(conversations.id, conversationId));
    return system!.id;
  });
  return { info, systemId };
}
