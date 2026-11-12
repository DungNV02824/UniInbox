// Đọc dữ liệu cho một lượt chatbot: tin khách chưa xử lý, lịch sử, ảnh.
//
// "Chưa xử lý" (loadPendingMessages) = tin KHÁCH thỏa cả ba:
// 1. gửi trong PENDING_MAX_AGE_HOURS giờ gần đây (sent_at) — không trả lời "tồn đọng" cũ khi bật lại AI/bot
//    (riêng lượt "Tái chăm sóc" admin bấm nới tới N ngày — LoadPendingOptions.maxAgeHours, xem reengage.ts);
// 2. tạo SAU mốc = greatest(tin kích hoạt mới nhất của lần chạy gần nhất có trigger − PENDING_RACE_SLACK_SEC,
//    tin nhân viên cuối KHÔNG phải echo tự động của Page, lần "trả lại cho AI" gần nhất — handoffs.resolved_at:
//    tin khách nhắn trong lúc chờ người coi như nhân viên đã xử lý; bỏ qua handoff mà bot vẫn trả lời suốt lúc chờ
//    người — bot 'continue', xem HandoffSystemRaw);
// 3. KHÔNG nằm trong trigger_message_ids của bất kỳ ai_runs nào của hội thoại.
// Điều 3 + độ trễ PENDING_RACE_SLACK_SEC xử lý thứ tự commit: created_at = lúc transaction lưu tin BẮT ĐẦU, nên
// tin commit muộn có thể có created_at nhỏ hơn tin kích hoạt của lần chạy trước — so mốc thuần sẽ bỏ sót mãi.
// Lần chạy bị hủy (chống đua) ghi trigger rỗng nên không đẩy mốc: lần chạy lại thấy đủ tin. So sánh created_at
// hoàn toàn trong SQL, không qua Date của JS (mất micro giây).
import { aiRuns, handoffs, messages, users } from '@dezon/db';
import { HANDOFF_REASON_LABELS, type HandoffReasonCode, type MessageAttachment } from '@dezon/shared';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { DbLike } from '../inbox/read-model';
import { readObjectLimited } from '../media/storage';
import type { MediaStorage } from '../media/types';
import { notAutomatedEcho } from '../pipeline/automation-echo';
import type { PipelineLogger } from '../pipeline/types';
import { errorText } from './delivery';
import { NOTIFY_STAFF_SYSTEM_PREFIX } from './notify-staff';
import {
  CHATBOT_HISTORY_LIMIT,
  CHATBOT_MAX_IMAGE_BYTES,
  CHATBOT_MAX_IMAGES,
  CHATBOT_MAX_IMAGES_TOTAL_BYTES,
  isPromptImageMime,
  normalizeImageMime,
} from './prompt';
import type { ChatHistoryItem, PromptImage, PromptImageSkipReason } from './types';

// Giới hạn ảnh nằm ở prompt.ts (prompt áp lại cho đường "Chat thử"); xuất lại cho mã/test cũ import từ đây.
export { CHATBOT_MAX_IMAGE_BYTES, CHATBOT_MAX_IMAGES_TOTAL_BYTES };

/** Chỉ tin khách gửi trong chừng này giờ mới được coi là chưa xử lý (khớp cửa sổ 24 giờ của Messenger). */
export const PENDING_MAX_AGE_HOURS = 24;
/** Lùi mốc "tin kích hoạt mới nhất" chừng này giây để bắt tin commit muộn (xem đầu tệp). */
export const PENDING_RACE_SLACK_SEC = 120;

export interface PendingMessage {
  id: string;
  text: string | null;
  attachments: MessageAttachment[];
  /** Giờ gửi (prompt ghi "Ảnh k/N — thuộc tin lúc HH:MM:SS …"). Tùy chọn để fixture cũ vẫn hợp lệ. */
  sentAt?: Date;
  /** Lúc lưu (created_at) — khóa phụ khi trùng sent_at, giống thứ tự dòng hội thoại (loadTurnHistory). */
  createdAt?: Date;
}

/**
 * Mốc tin nhân viên cuối (không tính echo tự động của Page) của hội thoại `conv` (tham số, hoặc cột của truy vấn
 * ngoài như `${conversations.id}`) — dùng chung cho loadPendingMessages và quét "Tái chăm sóc" (reengage.ts).
 */
export function lastAgentMessageAtSql(conv: SQL | string): SQL {
  return sql`(select max(a.created_at) from ${messages} a
    where a.conversation_id = ${conv} and a.sender_type = 'agent' and ${notAutomatedEcho(sql`a.raw`)})`;
}

/**
 * Mốc "trả lại cho AI" gần nhất (handoffs.resolved_at): nhân viên đã lo các tin trước đó (kể cả xử lý ngoài hệ thống,
 * không nhắn gì) — TRỪ handoff mà bot vẫn trả lời suốt lúc chờ người (aiHandoffMode 'continue': tin system của handoff
 * có dấu handoffBotContinues và không bị dừng giữa chừng — handoffBotStopped): tin khách chưa xử lý lúc bấm là việc
 * của bot (đang/sắp trả lời).
 */
export function lastResolvedHandoffAtSql(conv: SQL | string): SQL {
  return sql`(select max(h.resolved_at) from ${handoffs} h where h.conversation_id = ${conv}
    and not (
      exists (select 1 from ${messages} s where s.conversation_id = ${conv} and s.sender_type = 'system'
        and s.raw -> 'handoffBotContinues' ->> 'handoffId' = h.id::text)
      and not exists (select 1 from ${messages} s where s.conversation_id = ${conv} and s.sender_type = 'system'
        and s.raw -> 'handoffBotStopped' ->> 'handoffId' = h.id::text)
    ))`;
}

/**
 * Mốc "tin kích hoạt mới nhất của lần chạy gần nhất có trigger − PENDING_RACE_SLACK_SEC" dạng truy vấn con — để quét
 * nhiều hội thoại trong một câu (reengage.ts). loadPendingMessages tính CÙNG mốc theo hai bước (đọc lần chạy trước).
 */
export function lastTriggerWatermarkSql(conv: SQL | string): SQL {
  return sql`((select max(w.created_at) from ${messages} w where w.id = any(coalesce((
      select r.trigger_message_ids from ${aiRuns} r
      where r.conversation_id = ${conv} and cardinality(r.trigger_message_ids) > 0
      order by r.created_at desc, r.id desc limit 1
    ), '{}'::uuid[]))) - make_interval(secs => ${PENDING_RACE_SLACK_SEC}))`;
}

export interface LoadPendingOptions {
  /**
   * Tuổi tối đa (giờ, theo sent_at) của tin khách chưa xử lý. Mặc định PENDING_MAX_AGE_HOURS (24). Chỉ lượt "Tái
   * chăm sóc" (AiReplyJobData.reengage) nới ra tới N ngày; mọi điều kiện khác giữ nguyên.
   */
  maxAgeHours?: number;
}

/**
 * Tin khách chưa xử lý, tăng dần theo created_at (mốc chống đua); ảnh/prompt xếp lại theo (sent_at, created_at,
 * id) — xem orderPendingBySentAt.
 */
export async function loadPendingMessages(
  db: DbLike,
  conversationId: string,
  options: LoadPendingOptions = {},
): Promise<PendingMessage[]> {
  const maxAgeHours = options.maxAgeHours ?? PENDING_MAX_AGE_HOURS;
  const [run] = await db
    .select({ ids: aiRuns.triggerMessageIds })
    .from(aiRuns)
    .where(and(eq(aiRuns.conversationId, conversationId), sql`cardinality(${aiRuns.triggerMessageIds}) > 0`))
    .orderBy(desc(aiRuns.createdAt), desc(aiRuns.id))
    .limit(1);
  const trig = run?.ids ?? [];
  const watermark =
    trig.length > 0
      ? sql`((select max(w.created_at) from ${messages} w where w.id in (${sql.join(
          trig.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})) - make_interval(secs => ${PENDING_RACE_SLACK_SEC}))`
      : sql`null::timestamptz`;
  const lastAgent = lastAgentMessageAtSql(conversationId);
  const lastResolved = lastResolvedHandoffAtSql(conversationId);
  return db
    .select({
      id: messages.id,
      text: messages.text,
      attachments: messages.attachments,
      sentAt: messages.sentAt,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.senderType, 'customer'),
        sql`${messages.sentAt} > now() - make_interval(hours => ${maxAgeHours})`,
        sql`${messages.createdAt} > coalesce(greatest(${watermark}, ${lastAgent}, ${lastResolved}), '-infinity'::timestamptz)`,
        sql`not exists (select 1 from ${aiRuns} r
          where r.conversation_id = ${conversationId} and ${messages.id} = any(r.trigger_message_ids))`,
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

/** Có tin nhân viên (không tính echo tự động của Page) tạo sau tin khách `messageId` không. */
export async function hasAgentMessageAfter(
  db: DbLike,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.senderType, 'agent'),
        notAutomatedEcho(messages.raw),
        sql`${messages.createdAt} >= (select m.created_at from ${messages} m where m.id = ${messageId})`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

export interface TurnHistory {
  history: ChatHistoryItem[];
  newMessages: ChatHistoryItem[];
}

/** Dòng [Hệ thống] khi hội thoại được chuyển cho nhân viên. */
export const handoffCreatedMarker = (reasonCode: HandoffReasonCode): string =>
  `Hội thoại đã được chuyển cho nhân viên (lý do: ${HANDOFF_REASON_LABELS[reasonCode]}).`;
/** Dòng [Hệ thống] khi nhân viên bấm "Đã xong, trả lại cho AI". */
export const HANDOFF_RESOLVED_MARKER =
  'Nhân viên đã xử lý xong các yêu cầu trước đó và trả hội thoại lại cho bot. Chỉ xử lý yêu cầu MỚI từ đây.';
/** Số handoff gần nhất đưa vào lịch sử. */
const HISTORY_HANDOFF_LIMIT = 5;

/**
 * Tin system "Đã báo nhân viên …" THẬT do notifyStaffKeyword ghi: có dấu raw.notifyStaff, hoặc (tin cũ trước khi có
 * dấu) text bắt đầu bằng NOTIFY_STAFF_SYSTEM_PREFIX. Chỉ tin sender_type 'system' (hệ thống ghi, khách không giả được).
 */
const isNotifyStaffSystem = sql`(${messages.raw} -> 'notifyStaff' is not null or starts_with(${messages.text}, ${NOTIFY_STAFF_SYSTEM_PREFIX}))`;

/**
 * CHATBOT_HISTORY_LIMIT tin cuối (bỏ tin system, TRỪ tin "Đã báo nhân viên …" của notifyStaffKeyword), chia thành
 * lịch sử + tin mới (thuộc `pendingIds`). Tin "Đã báo nhân viên" thành dòng role 'system' (staffNotified: true) ⇒
 * lượt sau model biết nhân viên ĐÃ được báo thật (được nói "em đã báo nhân viên", quy tắc 7) mà không chuyển người.
 * Lịch sử chèn thêm dòng role 'system' theo thời gian từ bảng handoffs (lúc chuyển người + lúc "trả lại cho
 * AI") để model biết yêu cầu cũ đã được nhân viên xử lý (không escalate lại vì yêu cầu cũ).
 */
export async function loadTurnHistory(
  db: DbLike,
  conversationId: string,
  pending: ReadonlySet<string> | readonly PendingMessage[],
): Promise<TurnHistory> {
  // Truyền cả tin chưa xử lý (không chỉ id) ⇒ tin mới có ảnh được gắn imageRange "ảnh a–b" khớp loadPromptImages.
  const pendingIds: ReadonlySet<string> =
    pending instanceof Set ? pending : new Set((pending as readonly PendingMessage[]).map((m) => m.id));
  const imageRanges =
    pending instanceof Set ? null : pendingImageRanges(pending as readonly PendingMessage[]);
  const rows = await db
    .select({
      id: messages.id,
      senderType: messages.senderType,
      text: messages.text,
      attachments: messages.attachments,
      sentAt: messages.sentAt,
      agentName: users.name,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderUserId))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        sql`(${messages.senderType} <> 'system' or ${isNotifyStaffSystem})`,
      ),
    )
    // Cùng khóa với orderPendingBySentAt (sent_at, created_at, id) ⇒ "Ảnh k/N" khớp thứ tự dòng tin.
    .orderBy(desc(messages.sentAt), desc(messages.createdAt), desc(messages.id))
    .limit(CHATBOT_HISTORY_LIMIT);
  rows.reverse();

  // Mốc handoff trong khoảng lịch sử đã tải (đủ giới hạn ⇒ chỉ lấy mốc từ tin cũ nhất trở đi). Handoff CÒN MỞ luôn
  // được lấy (kể cả tạo trước khoảng đó): bot aiHandoffMode 'continue' cần biết hội thoại đang chờ nhân viên.
  const since = rows.length >= CHATBOT_HISTORY_LIMIT ? rows[0]?.sentAt : undefined;
  const handoffRows = await db
    .select({
      reasonCode: handoffs.reasonCode,
      createdAt: handoffs.createdAt,
      resolvedAt: handoffs.resolvedAt,
    })
    .from(handoffs)
    .where(
      and(
        eq(handoffs.conversationId, conversationId),
        since
          ? sql`(${handoffs.resolvedAt} is null or coalesce(${handoffs.resolvedAt}, ${handoffs.createdAt}) >= ${since.toISOString()}::timestamptz)`
          : undefined,
      ),
    )
    .orderBy(desc(handoffs.createdAt))
    .limit(HISTORY_HANDOFF_LIMIT);
  const markers: ChatHistoryItem[] = [];
  for (const h of handoffRows) {
    const open = h.resolvedAt === null;
    if (!since || h.createdAt >= since || open) {
      markers.push({
        role: 'system',
        text: handoffCreatedMarker(h.reasonCode),
        sentAt: h.createdAt,
        ...(open ? { handoffOpen: true } : {}),
      });
    }
    if (h.resolvedAt) markers.push({ role: 'system', text: HANDOFF_RESOLVED_MARKER, sentAt: h.resolvedAt });
  }
  markers.sort((a, b) => a.sentAt!.getTime() - b.sentAt!.getTime());

  const out: TurnHistory = { history: [], newMessages: [] };
  let mi = 0;
  for (const r of rows) {
    while (mi < markers.length && markers[mi]!.sentAt! <= r.sentAt && !pendingIds.has(r.id)) {
      out.history.push(markers[mi++]!);
    }
    if (r.senderType === 'system') {
      // Chỉ còn tin "Đã báo nhân viên" (lọc ở truy vấn); không bao giờ là tin mới của lượt.
      out.history.push({ role: 'system', text: r.text, sentAt: r.sentAt, staffNotified: true });
      continue;
    }
    const role = r.senderType === 'customer' ? 'customer' : r.senderType === 'bot' ? 'bot' : 'agent';
    const imageRange = pendingIds.has(r.id) ? imageRanges?.get(r.id) : undefined;
    const item: ChatHistoryItem = {
      role,
      text: r.text,
      attachmentCount: r.attachments.length,
      sentAt: r.sentAt,
      ...(role === 'agent' ? { agentName: r.agentName } : {}),
      ...(imageRange ? { imageRange } : {}),
    };
    (pendingIds.has(r.id) ? out.newMessages : out.history).push(item);
  }
  // Mốc sau tin cuối của lịch sử (vd. vừa "trả lại cho AI" rồi khách mới nhắn) vẫn thuộc lịch sử.
  while (mi < markers.length) out.history.push(markers[mi++]!);
  return out;
}

/** Tệp đính kèm tính là "ảnh khách gửi" (đánh số "Ảnh k/N"): mọi type 'image', kể cả tải hỏng (storage_key ''). */
function isImageAttachment(a: MessageAttachment): boolean {
  return a.type === 'image';
}

/** Dung lượng đã lưu (storeMedia ghi `size` vào jsonb; không có trong schema) — để loại ảnh trước khi tải. */
function storedSize(a: MessageAttachment): number | null {
  const size = (a as { size?: unknown }).size;
  return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : null;
}

/**
 * Tin chưa xử lý theo (sent_at, created_at, id) — CÙNG khóa với dòng hội thoại (loadTurnHistory) — để "Ảnh k/N"
 * và "tin thứ m trong lượt này" khớp thứ tự các dòng "[gửi N ảnh/tệp]". (loadPendingMessages xếp theo
 * created_at, có thể khác khi tin có tệp lớn tải về lâu hơn rồi mới insert.) Thiếu sent_at ở bất kỳ tin nào ⇒
 * giữ nguyên thứ tự. (id uuid: so chuỗi hex chữ thường = so byte như Postgres.)
 */
export function orderPendingBySentAt<T extends Pick<PendingMessage, 'id' | 'sentAt' | 'createdAt'>>(
  pending: readonly T[],
): T[] {
  if (pending.some((m) => !m.sentAt)) return [...pending];
  return [...pending].sort((a, b) => {
    const diff = a.sentAt!.getTime() - b.sentAt!.getTime();
    if (diff !== 0) return diff;
    if (a.createdAt && b.createdAt) {
      const created = a.createdAt.getTime() - b.createdAt.getTime();
      if (created !== 0) return created;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Vị trí ảnh (1-based, khớp loadPromptImages) đầu/cuối của từng tin chưa xử lý có ảnh, theo id tin. */
export function pendingImageRanges(
  pending: readonly PendingMessage[],
): Map<string, { first: number; last: number }> {
  const out = new Map<string, { first: number; last: number }>();
  let next = 1;
  for (const m of orderPendingBySentAt(pending)) {
    const n = m.attachments.filter(isImageAttachment).length;
    if (n > 0) out.set(m.id, { first: next, last: next + n - 1 });
    next += n;
  }
  return out;
}

/**
 * MỌI ảnh (type 'image') trong tin khách chưa xử lý (đã giới hạn PENDING_MAX_AGE_HOURS) theo thứ tự (sent_at,
 * created_at, id) — tin cũ ⇒ mới, trong một tin theo thứ tự đính kèm — để prompt đánh số "Ảnh k/N" đúng số ảnh
 * khách gửi (xem PromptImage), khớp imageRange của loadTurnHistory và "[gửi N ảnh/tệp]"; mỗi ảnh mang
 * `messageIndex` (thứ tự tin trong lượt) + `sentAt` để nhãn chỉ rõ ảnh thuộc tin nào. Ảnh cũ hơn
 * CHATBOT_MAX_IMAGES ảnh cuối ⇒ skipped 'limit'. Trong cửa sổ, xét MỚI ⇒ CŨ, TRƯỚC khi tải (dựa vào metadata):
 * tải hỏng lúc nhận (storage_key '') ⇒ 'unavailable' (vẫn giữ chỗ trong đánh số), định dạng model không đọc
 * được (gif, svg…) ⇒ 'unsupported', `size` đã lưu > CHATBOT_MAX_IMAGE_BYTES ⇒ 'too_large', cộng `size` vào thì
 * vượt CHATBOT_MAX_IMAGES_TOTAL_BYTES ⇒ 'over_total' (ảnh mới được ưu tiên) — các ảnh này KHÔNG đọc từ kho. Chỉ
 * tải (song song, qua stream, dừng ngay khi vượt CHATBOT_MAX_IMAGE_BYTES ⇒ 'too_large') các ảnh còn lại; sau khi
 * tải kiểm lại theo dung lượng thật (không tải được / rỗng ⇒ 'unavailable', vượt tổng ⇒ 'over_total'). Khớp
 * planPromptImages (prompt áp lại).
 */
export async function loadPromptImages(
  storage: MediaStorage,
  pending: readonly PendingMessage[],
  logger: PipelineLogger,
): Promise<PromptImage[]> {
  const all = orderPendingBySentAt(pending).flatMap((m, index) =>
    m.attachments.filter(isImageAttachment).map((a) => ({
      a,
      mime: normalizeImageMime(a.mime ?? ''),
      sentAt: m.sentAt,
      messageIndex: index + 1,
    })),
  );
  const out: PromptImage[] = all.map(({ mime, sentAt, messageIndex }) => ({
    mime,
    data: '',
    ...(sentAt ? { sentAt } : {}),
    messageIndex,
  }));
  const windowStart = Math.max(0, all.length - CHATBOT_MAX_IMAGES);
  for (let i = 0; i < windowStart; i++) out[i]!.skipped = 'limit';

  // 1. Loại trước khi tải, MỚI ⇒ CŨ, theo metadata (không đọc ảnh sẽ bị bỏ — HEIC/GIF thô tới 25 MB).
  const toLoad: number[] = [];
  let reserved = 0;
  for (let i = all.length - 1; i >= windowStart; i--) {
    const { a, mime } = all[i]!;
    const size = storedSize(a);
    let skipped: PromptImageSkipReason | undefined;
    if (!a.storage_key) skipped = 'unavailable';
    else if (!isPromptImageMime(mime)) skipped = 'unsupported';
    else if (size !== null && size > CHATBOT_MAX_IMAGE_BYTES) skipped = 'too_large';
    else if (size !== null && reserved + size > CHATBOT_MAX_IMAGES_TOTAL_BYTES) skipped = 'over_total';
    if (skipped) out[i]!.skipped = skipped;
    else {
      reserved += size ?? 0;
      toLoad.push(i);
    }
  }

  // 2. Tải song song các ảnh còn lại (bớt độ trễ trước lời gọi LLM); mỗi ảnh đọc tối đa CHATBOT_MAX_IMAGE_BYTES
  //    (metadata thiếu/sai cũng không giữ cả tệp lớn trong bộ nhớ).
  const loaded = new Map<number, Buffer | 'too_large' | null>();
  await Promise.all(
    toLoad.map((i) =>
      readObjectLimited(storage, all[i]!.a.storage_key, CHATBOT_MAX_IMAGE_BYTES).then(
        (data) => void loaded.set(i, data ?? 'too_large'),
        (error: unknown) => {
          logger.warn({ err: errorText(error) }, 'Không tải được ảnh khách cho chatbot');
          loaded.set(i, null);
        },
      ),
    ),
  );

  // 3. Kiểm lại theo dung lượng thật, MỚI ⇒ CŨ.
  let total = 0;
  for (const i of toLoad) {
    const img = out[i]!;
    const data = loaded.get(i);
    if (data === 'too_large') img.skipped = 'too_large';
    else if (!data || data.length === 0) img.skipped = 'unavailable';
    else if (total + data.length > CHATBOT_MAX_IMAGES_TOTAL_BYTES) img.skipped = 'over_total';
    else {
      total += data.length;
      img.data = data.toString('base64');
    }
  }
  return out;
}
