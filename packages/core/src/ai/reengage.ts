// "Tái chăm sóc khách bị bỏ sót" (admin, POST /chatbots/:id/reengage/preview|start): quét các hội thoại ĐANG GẮN bot
// có khách bị bỏ sót trong N ngày gần nhất rồi cho bot trả lời LẦN LƯỢT (job ai-reply riêng, giãn cách).
//
// Phạm vi (một câu SQL cho cả preview lẫn kiểm lại lúc "Bắt đầu"):
// - conversations.chatbot_id = bot, ai_mode 'auto', bot is_active; không pending_human (trừ bot aiHandoffMode
//   'continue' — pendingHumanAllowsBot); không 'resolved' (tin khách luôn mở lại hội thoại đã xử lý — inbound — nên
//   "đã xử lý mà tin cuối là của khách" = nhân viên đóng SAU tin đó, ví dụ đã gọi điện/Zalo); không đang tạm dừng
//   (ai_paused_until null hoặc đã qua);
// - tin khách cuối (last_customer_message_at) trong N ngày và đã cũ hơn REENGAGE_MIN_WAIT_MINUTES (tin vừa đến thì
//   luồng debounce thường đang lo — không chen lời xin lỗi "trả lời muộn");
// - tin cuối không tính system là của khách (khách đang chờ — như needsChatbotKick);
// - còn tin khách CHƯA XỬ LÝ theo đúng quy tắc loadPendingMessages (sau mốc greatest(tin kích hoạt − 120 s, tin nhân
//   viên cuối, "trả lại cho AI"), không nằm trong ai_runs) nhưng tuổi tối đa N ngày thay vì PENDING_MAX_AGE_HOURS.
//   Tin khách trước tin nhân viên cuối vẫn coi như nhân viên đã lo.
// Kênh không cho bot gửi (botCanSendWith: Messenger quá 24 giờ / quảng cáo quá 7 ngày, Zalo OA quá hạn, kênh mất kết
// nối) ⇒ outsideWindow (kèm lý do) để nhân viên tự xử lý; bot KHÔNG BAO GIỜ gửi.
// Chi phí token: mỗi hội thoại eligible ≈ 1 lần gọi AI; "Bắt đầu" tối đa REENGAGE_LIMITS.maxPerRun, giãn
// REENGAGE_LIMITS.spacingSec giây theo hàng CHUNG (ReengageQueue.reserveSlot — mọi lần bấm, mọi bot, mọi admin nối
// tiếp nhau, không chạy song song); audit 'chatbot.reengage' chỉ ghi số đếm (không nội dung tin).
import {
  auditLogs,
  channelAccounts,
  chatbots,
  contacts,
  conversations,
  messages,
  aiRuns,
  type Db,
} from '@dezon/db';
import {
  REENGAGE_LIMITS,
  type ReengageConversationItem,
  type ReengagePreview,
  type ReengageStartResult,
} from '@dezon/shared';
import { and, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { InboxNotFoundError, InboxValidationError } from '../inbox/errors';
import type { InboxContext } from '../inbox/types';
import { aiReengageJobId, type AiReplyJobData } from '../jobs';
import { notAutomatedEcho } from '../pipeline/automation-echo';
import { firstCustomerMessageAtSql } from '../pipeline/window-anchor';
import { botCanSendWith } from './delivery';
import { getAiSettings } from './settings';
import { lastAgentMessageAtSql, lastResolvedHandoffAtSql, lastTriggerWatermarkSql } from './turn-input';

/** Tin khách cuối mới hơn chừng này phút ⇒ chưa tính là "bị bỏ sót" (luồng debounce thường đang lo). */
export const REENGAGE_MIN_WAIT_MINUTES = 5;
/** Số hội thoại tối đa đọc mỗi lần quét (đủ cho hai danh sách previewMaxItems; vượt ⇒ truncated). */
export const REENGAGE_SCAN_LIMIT = 1000;
/** Độ dài tối đa của trích tin khách cuối (ReengageConversationItem.lastCustomerText). */
export const REENGAGE_TEXT_EXCERPT_CHARS = 120;
/**
 * Biên an toàn (phút) trước lúc khung gửi của kênh đóng (CanSendResult.expiresAt): job chạy trễ hơn lịch (worker bận,
 * debounce, gọi AI, giãn bong bóng) vẫn phải gửi kịp. Khung đóng trước "lúc chạy dự kiến + biên" ⇒ không xếp hàng,
 * trả về outsideWindow để nhân viên tự trả lời (job bị chặn vì hết khung thì không báo ai).
 */
export const REENGAGE_SEND_MARGIN_MINUTES = 3;
const REENGAGE_SEND_MARGIN_MS = REENGAGE_SEND_MARGIN_MINUTES * 60_000;
const CLOSING_SOON_REASON = `Khung gửi tin của kênh sắp đóng (còn dưới ${REENGAGE_SEND_MARGIN_MINUTES} phút) — nhân viên nên trả lời ngay`;
const CLOSES_BEFORE_TURN_REASON =
  'Khung gửi tin của kênh sẽ đóng trước lượt của bot trong hàng chờ — nhân viên nên trả lời ngay';

const CHATBOT_NOT_FOUND = 'Không tìm thấy chatbot';

interface ReengageBot {
  id: string;
  isActive: boolean;
  aiHandoffMode: string;
}

async function loadBot(db: Db, chatbotId: string): Promise<ReengageBot> {
  const [bot] = await db
    .select({ id: chatbots.id, isActive: chatbots.isActive, aiHandoffMode: chatbots.aiHandoffMode })
    .from(chatbots)
    .where(eq(chatbots.id, chatbotId));
  if (!bot) throw new InboxNotFoundError(CHATBOT_NOT_FOUND);
  return bot;
}

/** Bot tắt / AI tổng tắt ⇒ không có gì để bot trả lời: báo rõ (400) thay vì trả danh sách rỗng khó hiểu. */
async function assertBotCanRun(db: Db, bot: ReengageBot): Promise<void> {
  if (!bot.isActive)
    throw new InboxValidationError('Chatbot đang tắt, hãy bật bot trước khi tái chăm sóc khách');
  if (!(await getAiSettings(db)).enabled) {
    throw new InboxValidationError('AI tổng đang tắt (Cài đặt), hãy bật lại trước khi tái chăm sóc khách');
  }
}

function assertDays(days: number): void {
  if (!Number.isInteger(days) || days < REENGAGE_LIMITS.daysMin || days > REENGAGE_LIMITS.daysMax) {
    throw new InboxValidationError(
      `Số ngày phải từ ${REENGAGE_LIMITS.daysMin} đến ${REENGAGE_LIMITS.daysMax}`,
    );
  }
}

/** Số tin khách chưa xử lý của hội thoại (cột ngoài) trong `days` ngày — CÙNG quy tắc loadPendingMessages. */
function waitingMessagesSql(days: number): SQL<number> {
  const conv = sql`${conversations.id}`;
  return sql<number>`(select count(*)::int from ${messages} pm
    where pm.conversation_id = ${conv} and pm.sender_type = 'customer'
      and pm.sent_at > now() - make_interval(hours => ${days * 24})
      and pm.created_at > coalesce(greatest(${lastTriggerWatermarkSql(conv)}, ${lastAgentMessageAtSql(conv)},
        ${lastResolvedHandoffAtSql(conv)}), '-infinity'::timestamptz)
      and not exists (select 1 from ${aiRuns} r
        where r.conversation_id = ${conv} and pm.id = any(r.trigger_message_ids)))`.mapWith(Number);
}

/**
 * Người gửi tin cuối — cùng thứ tự với needsChatbotKick. Bỏ tin system và echo TỰ ĐỘNG của Page (Trả lời nhanh / Tin
 * vắng mặt — raw.automatedEcho): như loadPendingMessages, chúng không phải "nhân viên đã trả lời" nên khách chỉ nhận
 * tin vắng mặt vẫn là khách bị bỏ sót. Tin khách/bot không bao giờ mang cờ này.
 */
const lastSenderSql = sql<string | null>`(select m.sender_type from ${messages} m
  where m.conversation_id = ${conversations.id} and m.sender_type <> 'system'
    and ${notAutomatedEcho(sql`m.raw`)}
  order by m.sent_at desc, m.id desc limit 1)`;

/** Đầu tin khách cuối (đã cắt trong SQL để không kéo cả tin dài). */
const lastCustomerTextSql = sql<string | null>`(select left(m.text, ${REENGAGE_TEXT_EXCERPT_CHARS * 2})
  from ${messages} m where m.conversation_id = ${conversations.id} and m.sender_type = 'customer'
  order by m.sent_at desc, m.id desc limit 1)`;

/** Gộp khoảng trắng, cắt ≤ REENGAGE_TEXT_EXCERPT_CHARS ký tự (kèm '…'); rỗng ⇒ null (tin chỉ có tệp). */
export function reengageTextExcerpt(text: string | null | undefined): string | null {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  if (chars.length <= REENGAGE_TEXT_EXCERPT_CHARS) return flat;
  return `${chars
    .slice(0, REENGAGE_TEXT_EXCERPT_CHARS - 1)
    .join('')
    .trimEnd()}…`;
}

/** Dòng eligible kèm lúc khung gửi của kênh đóng (null = không giới hạn, ví dụ Zalo cá nhân). */
interface EligibleScanItem {
  item: ReengageConversationItem;
  expiresAt: Date | null;
}

interface ScanResult {
  eligible: EligibleScanItem[];
  outsideWindow: ReengageConversationItem[];
  /** Số hội thoại đọc được vượt REENGAGE_SCAN_LIMIT. */
  overflow: boolean;
}

/** Tham số giữ khe trong hàng giãn cách chung (ReengageQueue.reserveSlot). Mọi mốc là epoch ms. */
export interface ReengageSlotRequest {
  nowMs: number;
  spacingMs: number;
  /** Khe muộn nhất còn chấp nhận (khung gửi đóng − biên an toàn); null = không giới hạn. */
  latestMs: number | null;
}

/**
 * Hàng đợi job tái chăm sóc (API cài bằng BullMQ — core không phụ thuộc bullmq). Job bị xóa khi xong/lỗi hẳn nên
 * "còn job" = còn chờ/đang chạy.
 */
export interface ReengageQueue {
  /** Trong các hội thoại này, hội thoại nào còn job aiReengageJobId đang chờ/chạy. */
  pending(conversationIds: readonly string[]): Promise<ReadonlySet<string>>;
  /**
   * Giữ (nguyên tử) khe chạy kế tiếp trong hàng giãn cách CHUNG của mọi lượt tái chăm sóc (mọi lần bấm, mọi bot, mọi
   * admin): khe = max(nowMs, khe kế tiếp đang lưu). Khe > latestMs ⇒ không giữ, trả null. Giữ ⇒ khe kế tiếp =
   * khe + spacingMs. Nhờ vậy lần bấm sau (sau "Kiểm tra lại", hay bấm lại sau lỗi giữa chừng) nối tiếp sau các job còn
   * chờ thay vì chạy song song. Khe đã giữ mà không đẩy được job (trùng/lỗi) chỉ để lại một khoảng trống.
   */
  reserveSlot(request: ReengageSlotRequest): Promise<number | null>;
  /** Đẩy một job; false ⇒ đã có job cùng jobId (BullMQ không thêm gì — ví dụ hai admin cùng bấm). */
  enqueue(job: ReengageJob): Promise<boolean>;
}

/** Quét phạm vi "khách bị bỏ sót" (đầu tệp) của bot, phân loại theo quyền gửi của bot. `onlyIds` ⇒ chỉ các id đó. */
async function scanMissedConversations(
  db: Db,
  ctx: InboxContext,
  bot: ReengageBot,
  days: number,
  onlyIds?: readonly string[],
): Promise<ScanResult> {
  const waiting = waitingMessagesSql(days);
  const rows = await db
    .select({
      id: conversations.id,
      contactName: contacts.displayName,
      channelName: channelAccounts.displayName,
      channelType: channelAccounts.type,
      channelStatus: channelAccounts.status,
      windowSource: conversations.windowSource,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      firstCustomerAt: sql<Date | null>`case when ${conversations.windowSource} = 'ads'
        then ${firstCustomerMessageAtSql(sql`${conversations.id}`)} end`.mapWith(messages.sentAt),
      waiting,
      lastCustomerText: lastCustomerTextSql,
    })
    .from(conversations)
    .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(
      and(
        eq(conversations.chatbotId, bot.id),
        eq(conversations.aiMode, 'auto'),
        // Chờ người ⇒ bot dừng — trừ bot 'continue' (pendingHumanAllowsBot).
        bot.aiHandoffMode === 'continue' ? undefined : ne(conversations.status, 'pending_human'),
        // Nhân viên đã đánh dấu "Đã xử lý" sau tin khách cuối (tin khách mới luôn mở lại) ⇒ coi như đã lo.
        ne(conversations.status, 'resolved'),
        sql`(${conversations.aiPausedUntil} is null or ${conversations.aiPausedUntil} <= now())`,
        sql`${conversations.lastCustomerMessageAt} > now() - make_interval(days => ${days})`,
        sql`${conversations.lastCustomerMessageAt} <= now() - make_interval(mins => ${REENGAGE_MIN_WAIT_MINUTES})`,
        onlyIds ? inArray(conversations.id, [...onlyIds]) : undefined,
        sql`${lastSenderSql} = 'customer'`,
        sql`${waiting} > 0`,
      ),
    )
    .orderBy(desc(conversations.lastCustomerMessageAt), desc(conversations.id))
    .limit(REENGAGE_SCAN_LIMIT + 1);

  const now = ctx.now().getTime();
  const out: ScanResult = { eligible: [], outsideWindow: [], overflow: rows.length > REENGAGE_SCAN_LIMIT };
  for (const row of rows.slice(0, REENGAGE_SCAN_LIMIT)) {
    if (!row.lastCustomerMessageAt) continue; // không xảy ra (điều kiện SQL) — giữ kiểu chặt
    const item: ReengageConversationItem = {
      conversationId: row.id,
      contactName: row.contactName,
      channelName: row.channelName,
      channelType: row.channelType,
      lastCustomerMessageAt: row.lastCustomerMessageAt.toISOString(),
      waitingMessages: row.waiting,
      lastCustomerText: reengageTextExcerpt(row.lastCustomerText),
    };
    const send = botCanSendWith(row, row.firstCustomerAt, ctx);
    if (!send.allowed) {
      out.outsideWindow.push({ ...item, reason: send.reason ?? 'Kênh không cho bot gửi tin lúc này' });
    } else if (send.expiresAt && send.expiresAt.getTime() < now + REENGAGE_SEND_MARGIN_MS) {
      out.outsideWindow.push({ ...item, reason: CLOSING_SOON_REASON });
    } else {
      out.eligible.push({ item, expiresAt: send.expiresAt });
    }
  }
  return out;
}

/**
 * POST /chatbots/:id/reengage/preview (admin): danh sách khách bị bỏ sót trong `days` ngày — `eligible` (bot sẽ trả
 * lời; số dòng ≈ số lần gọi AI) và `outsideWindow` (kênh không cho bot gửi hoặc khung sắp đóng, kèm lý do). Khách đã có
 * job tái chăm sóc đang chờ (lần bấm trước) ⇒ không vào eligible mà đếm ở alreadyQueued, để "Kiểm tra lại" chuyển sang
 * khách tiếp theo. Mỗi danh sách tối đa REENGAGE_LIMITS.previewMaxItems dòng (mới nhất trước); cắt bớt ⇒ truncated.
 * Không ghi DB, không gọi AI. Bot không có ⇒ InboxNotFoundError; bot tắt / AI tổng tắt / days sai ⇒
 * InboxValidationError.
 */
export async function previewChatbotReengage(
  db: Db,
  ctx: InboxContext,
  chatbotId: string,
  days: number,
  queue: Pick<ReengageQueue, 'pending'>,
): Promise<ReengagePreview> {
  assertDays(days);
  const bot = await loadBot(db, chatbotId);
  await assertBotCanRun(db, bot);
  const scan = await scanMissedConversations(db, ctx, bot, days);
  const pending =
    scan.eligible.length > 0
      ? await queue.pending(scan.eligible.map((e) => e.item.conversationId))
      : new Set<string>();
  const eligible = scan.eligible.filter((e) => !pending.has(e.item.conversationId)).map((e) => e.item);
  const max = REENGAGE_LIMITS.previewMaxItems;
  return {
    days,
    eligible: eligible.slice(0, max),
    outsideWindow: scan.outsideWindow.slice(0, max),
    alreadyQueued: scan.eligible.length - eligible.length,
    truncated: scan.overflow || eligible.length > max || scan.outsideWindow.length > max,
  };
}

/** Một job ai-reply "Tái chăm sóc" cần đẩy (API đẩy bằng BullMQ — core không phụ thuộc bullmq). */
export interface ReengageJob {
  /** aiReengageJobId(conversationId) — khe riêng, không đè job debounce/đánh thức. */
  jobId: string;
  conversationId: string;
  /** Khe đã giữ (reserveSlot) − lúc bấm: nối tiếp sau các lượt tái chăm sóc còn chờ, cách nhau spacingSec. */
  delayMs: number;
  data: AiReplyJobData;
}

export interface StartReengageInput {
  actorUserId: string;
  chatbotId: string;
  days: number;
  conversationIds: readonly string[];
  /** "Quy tắc chăm sóc" gõ tay cho lần bấm này (reengageGuidanceText chuẩn hóa); trống ⇒ không có. */
  rules?: string;
  /** "Nội dung chăm sóc lại" gõ tay cho lần bấm này; trống ⇒ không có. */
  content?: string;
}

/**
 * Chuẩn hóa ô chỉ dẫn gõ tay (Quy tắc chăm sóc / Nội dung chăm sóc lại): không phải chuỗi / chỉ khoảng trắng ⇒
 * undefined; còn lại trim và cắt ≤ REENGAGE_LIMITS.guidanceMaxChars ký tự. Dùng cả lúc xếp job lẫn lúc worker đọc
 * job (dữ liệu job lạ cũng không phình prompt).
 */
export function reengageGuidanceText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length <= REENGAGE_LIMITS.guidanceMaxChars
    ? text
    : chars.slice(0, REENGAGE_LIMITS.guidanceMaxChars).join('').trimEnd();
}

/**
 * POST /chatbots/:id/reengage/start (admin). Kiểm lại TỪNG id phía server bằng chính câu quét của preview: chỉ id còn
 * thuộc `eligible` mới được xếp hàng (đã có người/bot trả lời, gỡ bot… ⇒ skipped; khung gửi đã đóng ⇒ skipped và trả
 * về outsideWindow). Bỏ id trùng, tối đa REENGAGE_LIMITS.maxPerRun.
 * - Id đã có job tái chăm sóc đang chờ (lần bấm trước / admin khác) ⇒ alreadyQueued, không xếp thêm.
 * - Thứ tự hàng: khung gửi đóng sớm nhất trước (expiresAt tăng dần; kênh không giới hạn như Zalo cá nhân xếp cuối;
 *   cùng mốc giữ thứ tự gửi lên). Mỗi job giữ một khe trong hàng giãn cách CHUNG (queue.reserveSlot): khe đầu =
 *   max(lúc bấm, sau job tái chăm sóc cuối còn chờ của MỌI lần bấm/bot/admin), các khe cách nhau spacingSec giây;
 *   delay = khe − lúc bấm. Khung đóng trước khe + REENGAGE_SEND_MARGIN_MINUTES ⇒ không xếp (job sẽ bị chặn mà không
 *   ai biết), trả về outsideWindow.
 * - jobId aiReengageJobId(conv), data { conversationId, scheduledAt, reengage: { pendingMaxAgeHours: days × 24,
 *   chatbotId } }. queue.enqueue trả false (job cùng jobId vừa có) ⇒ alreadyQueued.
 * - estimatedMinutes = phút tới khi job cuối của lần này chạy xong khe (tính cả hàng còn chờ từ trước);
 *   startsInMinutes = phút tới job đầu tiên (> 0 khi lần này nối sau các lượt còn chờ).
 * Audit 'chatbot.reengage' { days, requested, queued, alreadyQueued, skipped } (không nội dung tin). Lỗi đẩy job ⇒ ném
 * (đã đẩy thì bấm lại cũng không trùng; lần bấm lại nối tiếp sau các job đã đẩy).
 */
export async function startChatbotReengage(
  db: Db,
  ctx: InboxContext,
  input: StartReengageInput,
  queue: ReengageQueue,
): Promise<ReengageStartResult> {
  assertDays(input.days);
  const bot = await loadBot(db, input.chatbotId);
  await assertBotCanRun(db, bot);
  const ids = [...new Set(input.conversationIds)].slice(0, REENGAGE_LIMITS.maxPerRun);
  const scan = ids.length > 0 ? await scanMissedConversations(db, ctx, bot, input.days, ids) : null;
  const order = new Map(ids.map((id, i) => [id, i]));
  const byRequestOrder = (a: string, b: string) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  const pending =
    scan && scan.eligible.length > 0
      ? await queue.pending(scan.eligible.map((e) => e.item.conversationId))
      : new Set<string>();
  const candidates = (scan?.eligible ?? [])
    .filter((e) => !pending.has(e.item.conversationId))
    .sort(
      (a, b) =>
        (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity) ||
        byRequestOrder(a.item.conversationId, b.item.conversationId),
    );
  const outsideWindow = [...(scan?.outsideWindow ?? [])].sort((a, b) =>
    byRequestOrder(a.conversationId, b.conversationId),
  );

  const spacingSec = REENGAGE_LIMITS.spacingSec;
  const spacingMs = spacingSec * 1000;
  const now = ctx.now();
  const nowMs = now.getTime();
  const scheduledAt = now.toISOString();
  const rules = reengageGuidanceText(input.rules);
  const content = reengageGuidanceText(input.content);
  let queued = 0;
  let alreadyQueued = pending.size;
  let firstSlotMs: number | null = null;
  let lastSlotMs: number | null = null;
  for (const { item, expiresAt } of candidates) {
    const slotMs = await queue.reserveSlot({
      nowMs,
      spacingMs,
      latestMs: expiresAt ? expiresAt.getTime() - REENGAGE_SEND_MARGIN_MS : null,
    });
    if (slotMs === null) {
      outsideWindow.push({ ...item, reason: CLOSES_BEFORE_TURN_REASON });
      continue;
    }
    const added = await queue.enqueue({
      jobId: aiReengageJobId(item.conversationId),
      conversationId: item.conversationId,
      delayMs: Math.max(0, slotMs - nowMs),
      data: {
        conversationId: item.conversationId,
        scheduledAt,
        reengage: {
          pendingMaxAgeHours: input.days * 24,
          chatbotId: bot.id,
          ...(rules ? { rules } : {}),
          ...(content ? { content } : {}),
        },
      },
    });
    if (!added) {
      alreadyQueued++;
      continue;
    }
    queued++;
    firstSlotMs ??= slotMs;
    lastSlotMs = slotMs;
  }

  const minutesUntil = (ms: number) => Math.max(0, Math.ceil((ms - nowMs) / 60_000));
  const result: ReengageStartResult = {
    queued,
    alreadyQueued,
    skipped: ids.length - queued - alreadyQueued,
    outsideWindow,
    spacingSec,
    estimatedMinutes: lastSlotMs === null ? 0 : minutesUntil(lastSlotMs + spacingMs),
    startsInMinutes: firstSlotMs === null ? 0 : minutesUntil(firstSlotMs),
  };
  await db.insert(auditLogs).values({
    userId: input.actorUserId,
    action: 'chatbot.reengage',
    entity: 'chatbot',
    entityId: bot.id,
    // Chỉ ghi có/không và độ dài chỉ dẫn gõ tay — không ghi nội dung.
    data: {
      days: input.days,
      requested: ids.length,
      queued,
      alreadyQueued,
      skipped: result.skipped,
      rulesChars: rules ? Array.from(rules).length : 0,
      contentChars: content ? Array.from(content).length : 0,
    },
  });
  return result;
}
