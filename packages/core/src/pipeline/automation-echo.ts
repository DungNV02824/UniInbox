// Echo "tự động" của Page: Trả lời nhanh (Instant Reply), Tin nhắn vắng mặt (Away message) của Business
// Suite hoặc công cụ tự động khác. Meta gửi chúng như echo bình thường (app_id = Hộp thư Page hoặc app khác),
// KHÔNG có dấu hiệu nào đáng tin để phân biệt với nhân viên thật (docs/research/messenger-platform.md §10).
// Heuristic (docs/DECISIONS.md): echo (không phải của hệ thống) gửi trong AUTOMATION_ECHO_WINDOW_SEC giây SAU
// một tin khách (so theo sent_at — đồng hồ của Meta) ⇒ coi là tự động: KHÔNG tạm dừng AI, KHÔNG tính là
// "nhân viên đã trả lời" khi chatbot xác định tin chưa xử lý. Đánh dấu raw.automatedEcho = true.
// Hai thứ tự đến đều xử lý được (hàng đợi inbound chạy song song nên echo có thể được lưu TRƯỚC tin khách):
// - echo đến sau tin khách: phân loại ngay khi lưu echo;
// - echo đến trước: khi lưu tin khách, đánh dấu lại các echo trong cửa sổ và gỡ pause mà echo đó đã đặt
//   (raw.aiPauseUntil, chỉ khi pause hiện tại vẫn đúng bằng giá trị echo đặt — không có ai kéo dài sau đó — và
//   không có tin nhân viên thật nào sau echo). Giá trị có thể là mốc "dừng hẳn" (AI_PAUSED_INDEFINITELY_ISO) khi
//   bot đặt agent_reply_mode 'stop'; 'continue' không đặt pause nên không có gì để gỡ.
// Quảng cáo Click-to-Messenger (2026-11-12): lời chào của quảng cáo có sent_at TRƯỚC tin khách ⇒ echo gửi trong
// AD_GREETING_ECHO_WINDOW_SEC giây TRƯỚC tin khách cũng là tự động, NHƯNG chỉ ở lúc khách vào từ quảng cáo (tin khách
// đó mang referral ADS, hoặc có echo "… đã trả lời một quảng cáo." quanh đó) — KHÔNG dựa vào window_source 'ads' của
// cả hội thoại (giữ 'ads' mãi ⇒ tin nhân viên thật về sau bị coi là tự động). Áp cả ba thứ tự đến (echo / tin khách /
// echo thông báo lưu sau cùng). Hai job inbound của cùng hội thoại phân loại lần lượt
// (lockConversationEchoClassification). repairAdGreetingEchoes sửa các hội thoại đã bị kẹt TRƯỚC bản sửa.
import { conversations, messages } from '@dezon/db';
import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { DbLike } from '../inbox/read-model';

/** Echo trong khoảng này (giây) sau một tin khách ⇒ coi là tin tự động của Page. */
export const AUTOMATION_ECHO_WINDOW_SEC = 15;
/** Khóa đánh dấu trong messages.raw. */
export const AUTOMATED_ECHO_RAW_KEY = 'automatedEcho';
/** Khóa trong messages.raw: thời điểm pause AI mà echo này đặt (để gỡ nếu sau đó được phân loại tự động). */
export const ECHO_PAUSE_RAW_KEY = 'aiPauseUntil';
/**
 * Quảng cáo Click-to-Messenger: Meta (app "Meta Business Suite") gửi echo "<Tên> đã trả lời một quảng cáo." và lời
 * chào (mẫu tin chào của quảng cáo) với sent_at TRƯỚC hoặc BẰNG tin khách (thường là quick reply trong cùng giây),
 * nhưng webhook echo lại tới SAU. Echo nền tảng gửi trong chừng này giây TRƯỚC một tin khách VÀO TỪ QUẢNG CÁO (tin
 * mang referral ADS, hoặc có echo "… đã trả lời một quảng cáo." quanh đó) ⇒ cũng là tin tự động (adGreetingSql).
 * Tin nhân viên thật về sau trong hội thoại quảng cáo (tin khách không mang referral) vẫn làm dừng bot như thường.
 */
export const AD_GREETING_ECHO_WINDOW_SEC = 60;
/** Câu Meta tự chèn khi khách bấm quảng cáo (chữ thường; tiếng Việt + tiếng Anh). */
export const AD_REPLY_NOTICE_PATTERNS = ['đã trả lời một quảng cáo', 'replied to an ad'] as const;
/** Repair lúc worker khởi động: chỉ xét echo trong chừng này ngày gần đây. */
export const AD_GREETING_REPAIR_DAYS = 7;
/**
 * Repair chỉ xét echo gửi TRƯỚC mốc này (sau ngày deploy bản sửa 2026-11-12, chừa vài ngày trễ deploy): echo sau đó đã
 * được đường sống phân loại bằng đúng điều kiện này ⇒ repair không đụng; quá mốc + AD_GREETING_REPAIR_DAYS ngày thì
 * repair không còn làm gì (chạy mỗi lần khởi động vẫn vô hại).
 */
export const AD_GREETING_REPAIR_BEFORE = new Date('2026-11-16T00:00:00Z');
/** Không gian khóa advisory (số 32 bit) của bước phân loại echo — tránh trùng khóa advisory khác. */
const ECHO_LOCK_NAMESPACE = 0x4543484f; // 'ECHO'

/** Text là câu "… đã trả lời một quảng cáo." của Meta. */
export function isAdReplyNoticeText(text: string | null | undefined): boolean {
  const lower = text?.toLowerCase() ?? '';
  return AD_REPLY_NOTICE_PATTERNS.some((p) => lower.includes(p));
}

/** Điều kiện SQL "không phải echo tự động" cho cột raw (dùng được với alias, ví dụ sql`m.raw`). */
export const notAutomatedEcho = (raw: SQLWrapper) =>
  sql`coalesce((${raw}) ->> 'automatedEcho', '') <> 'true'`;

const iso = (d: Date) => d.toISOString();

/** raw của echo kèm cờ automatedEcho (raw không phải object ⇒ bọc trong { original }). */
export function withAutomatedFlag(raw: unknown): Record<string, unknown> {
  const base =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : raw === null || raw === undefined
        ? {}
        : { original: raw };
  return { ...base, [AUTOMATED_ECHO_RAW_KEY]: true };
}

/** Echo không phải của hệ thống (mọi echo từ nền tảng): sender 'agent', không sender_user_id, không raw.outbound. */
const platformEchoSql = (alias: string) =>
  sql`${sql.raw(alias)}.sender_type = 'agent' and ${sql.raw(alias)}.sender_user_id is null
    and (${sql.raw(alias)}.raw -> 'outbound') is null`;

/** Điều kiện SQL: `text` chứa câu "đã trả lời một quảng cáo" của Meta (so chữ thường). */
const adReplyNoticeSql = (text: SQLWrapper) =>
  sql`(${sql.join(
    AD_REPLY_NOTICE_PATTERNS.map((p) => sql`strpos(lower(coalesce(${text}, '')), ${p}) > 0`),
    sql` or `,
  )})`;

const ts = (d: Date) => sql`${iso(d)}::timestamptz`;
const secs = (n: number) => sql`make_interval(secs => ${n})`;

/**
 * Điều kiện SQL: raw (event gốc của Meta, parse.ts giữ nguyên) của tin khách mang referral.source = ADS — ở
 * referral của event, message.referral (tin đầu từ quảng cáo) hoặc postback.referral (bấm nút Bắt đầu / CTA).
 */
const adReferralSql = (raw: SQLWrapper) =>
  sql`'ADS' in (upper((${raw}) -> 'referral' ->> 'source'), upper((${raw}) -> 'message' -> 'referral' ->> 'source'),
    upper((${raw}) -> 'postback' -> 'referral' ->> 'source'))`;

/** Có echo nền tảng "… đã trả lời một quảng cáo." của hội thoại `conv` gửi trong [from, to]. */
const adNoticeNearSql = (conv: SQLWrapper | string, from: SQLWrapper, to: SQLWrapper) =>
  sql`exists (select 1 from ${messages} an where an.conversation_id = ${conv} and ${platformEchoSql('an')}
    and an.sent_at between ${from} and ${to} and ${adReplyNoticeSql(sql`an.text`)})`;

/**
 * Điều kiện SQL "echo gửi lúc `echoAt` là lời chào của quảng cáo": có tin khách gửi trong [echoAt, echoAt +
 * AD_GREETING_ECHO_WINDOW_SEC] VÀ khách vào từ quảng cáo ngay lúc đó — tin khách ấy mang referral ADS, HOẶC có echo
 * "… đã trả lời một quảng cáo." trong [echoAt − cửa sổ, echoAt + cửa sổ] (khách đã có hội thoại cũ: Meta gửi referral
 * bằng sự kiện messaging_referrals đứng riêng — chưa xử lý — nên tin khách không mang referral). `isNotice`: chính
 * echo đang xét là câu thông báo (echo chưa lưu nên adNoticeNearSql chưa thấy nó).
 */
const adGreetingSql = (conv: SQLWrapper | string, echoAt: SQLWrapper, isNotice = false) => {
  const window = secs(AD_GREETING_ECHO_WINDOW_SEC);
  const notice = isNotice
    ? sql`true`
    : adNoticeNearSql(conv, sql`${echoAt} - ${window}`, sql`${echoAt} + ${window}`);
  return sql`exists (select 1 from ${messages} c where c.conversation_id = ${conv} and c.sender_type = 'customer'
    and c.sent_at between ${echoAt} and ${echoAt} + ${window}
    and (${adReferralSql(sql`c.raw`)} or ${notice}))`;
};

/**
 * Echo nền tảng sắp lưu (echo đến SAU tin khách) có phải tin tự động không:
 * - có tin khách gửi trong [sentAt − AUTOMATION_ECHO_WINDOW_SEC, sentAt] (Trả lời nhanh / vắng mặt), HOẶC
 * - là lời chào của quảng cáo (adGreetingSql: tin khách từ quảng cáo gửi trong [sentAt, sentAt + 60 giây]).
 */
export async function isLikelyAutomatedEcho(
  db: DbLike,
  conversationId: string,
  sentAt: Date,
  text?: string | null,
): Promise<boolean> {
  const from = new Date(sentAt.getTime() - AUTOMATION_ECHO_WINDOW_SEC * 1000);
  const result = await db.execute<{ automated: boolean }>(sql`select (
    exists (select 1 from ${messages} c where c.conversation_id = ${conversationId}
      and c.sender_type = 'customer' and c.sent_at between ${ts(from)} and ${ts(sentAt)})
    or ${adGreetingSql(conversationId, ts(sentAt), isAdReplyNoticeText(text))}) as automated`);
  return result.rows[0]?.automated === true;
}

/**
 * Khóa giao dịch theo hội thoại cho bước phân loại echo trong storeInboundMessage: tin khách và echo của cùng hội
 * thoại xử lý song song (hai job inbound) phải lần lượt, nếu không mỗi bên đều không thấy bên kia (chưa commit) ⇒
 * echo tự động bị coi là nhân viên thật. Khóa advisory (không phải khóa dòng) để không đụng thứ tự khóa của job AI.
 */
export async function lockConversationEchoClassification(db: DbLike, conversationId: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(${ECHO_LOCK_NAMESPACE}, hashtext(${conversationId}))`);
}

/** Echo vừa đặt pause AI = `until` (pause sau cập nhật đúng bằng giá trị của nó) ⇒ ghi vào raw để gỡ sau. */
export async function recordEchoPause(db: DbLike, messageId: string, until: Date): Promise<void> {
  await db
    .update(messages)
    .set({
      raw: sql`(case when jsonb_typeof(${messages.raw}) = 'object' then ${messages.raw} else '{}'::jsonb end)
        || jsonb_build_object(${ECHO_PAUSE_RAW_KEY}::text, ${iso(until)}::text)`,
    })
    .where(eq(messages.id, messageId));
}

/** raw sau khi gắn cờ automatedEcho (SQL; raw không phải object ⇒ bọc trong { original }). */
const automatedRawSql = () => sql`(case when jsonb_typeof(${messages.raw}) = 'object' then ${messages.raw}
    when ${messages.raw} is null then '{}'::jsonb
    else jsonb_build_object('original', ${messages.raw}) end)
  || jsonb_build_object(${AUTOMATED_ECHO_RAW_KEY}::text, true)`;

/** Echo vừa được đánh dấu tự động: hội thoại, mốc pause nó đã đặt (nếu có), giờ gửi. */
interface MarkedEcho {
  conversationId: string;
  pauseUntil: string | null;
  sentAt: Date;
}

/**
 * Gỡ pause AI mà các echo (vừa được đánh dấu tự động) đã đặt: chỉ khi pause hiện tại vẫn đúng bằng giá trị echo đặt
 * VÀ không có tin nhân viên thật nào (không phải echo tự động) từ lúc echo gửi: mốc "dừng hẳn" (agent_reply_mode
 * 'stop') luôn cùng một giá trị nên so bằng nhau chưa đủ để biết echo còn "sở hữu" nó — nhân viên khác nhắn sau đó
 * cũng muốn bot dừng. Gọi SAU khi đã đánh dấu (các echo cùng đợt không bị tính là nhân viên). Trả số hội thoại đã gỡ.
 */
async function releaseEchoPauses(db: DbLike, marked: readonly MarkedEcho[]): Promise<number> {
  let released = 0;
  for (const { conversationId, pauseUntil, sentAt } of marked) {
    if (!pauseUntil) continue;
    const rows = await db
      .update(conversations)
      .set({ aiPausedUntil: null })
      .where(
        and(
          eq(conversations.id, conversationId),
          sql`${conversations.aiPausedUntil} = ${pauseUntil}::timestamptz`,
          sql`not exists (select 1 from ${messages} a
            where a.conversation_id = ${conversationId} and a.sender_type = 'agent'
              and ${notAutomatedEcho(sql`a.raw`)} and a.sent_at >= ${iso(sentAt)}::timestamptz)`,
        ),
      )
      .returning({ id: conversations.id });
    released += rows.length;
  }
  return released;
}

/** Điều kiện SQL: echo từ nền tảng (cột của bảng messages trong UPDATE) chưa được đánh dấu tự động. */
const unmarkedPlatformEchoSql = () =>
  and(
    eq(messages.senderType, 'agent'),
    sql`${messages.senderUserId} is null`,
    sql`(${messages.raw} -> 'outbound') is null`,
    notAutomatedEcho(messages.raw),
  );

/** Đánh dấu automatedEcho các echo nền tảng (chưa đánh dấu) thỏa `where`, rồi gỡ pause chúng đã đặt. */
async function markEchoes(db: DbLike, where: SQL | undefined) {
  const marked = await db
    .update(messages)
    .set({ raw: automatedRawSql() })
    .where(and(unmarkedPlatformEchoSql(), where))
    .returning({
      conversationId: messages.conversationId,
      pauseUntil: sql<string | null>`${messages.raw} ->> ${ECHO_PAUSE_RAW_KEY}::text`,
      sentAt: messages.sentAt,
    });
  const pausesReleased = await releaseEchoPauses(db, marked);
  return { marked, pausesReleased };
}

/**
 * Gọi khi lưu tin KHÁCH (echo đến trước; tin khách đã insert trong cùng transaction): đánh dấu automatedEcho các echo
 * từ nền tảng (sender 'agent', không có sender_user_id, không phải tin hệ thống gửi — raw.outbound null) gửi trong
 * [sentAt, sentAt + cửa sổ] — hoặc gửi trong [sentAt − AD_GREETING_ECHO_WINDOW_SEC, sentAt] và là lời chào quảng cáo
 * (adGreetingSql: tin khách từ quảng cáo ngay sau echo); gỡ pause AI mà các echo đó đã đặt (releaseEchoPauses). Trả
 * số echo đã đánh dấu. Tin khách này tự lên lịch chatbot sau commit (onCustomerMessageStored) nên không cần hẹn thêm.
 */
export async function reclassifyEchoesAfterCustomer(
  db: DbLike,
  conversationId: string,
  customerSentAt: Date,
): Promise<number> {
  const to = new Date(customerSentAt.getTime() + AUTOMATION_ECHO_WINDOW_SEC * 1000);
  const adFrom = new Date(customerSentAt.getTime() - AD_GREETING_ECHO_WINDOW_SEC * 1000);
  const { marked } = await markEchoes(
    db,
    and(
      eq(messages.conversationId, conversationId),
      sql`(${messages.sentAt} between ${ts(customerSentAt)} and ${ts(to)}
        or (${messages.sentAt} between ${ts(adFrom)} and ${ts(customerSentAt)}
          and ${adGreetingSql(conversationId, sql`${messages.sentAt}`)}))`,
    ),
  );
  return marked.length;
}

/**
 * Gọi khi vừa lưu echo "… đã trả lời một quảng cáo." (echo thông báo có thể tới SAU cả lời chào lẫn tin khách — khi
 * đó lời chào lúc lưu chưa thấy thông báo nên bị coi là nhân viên): đánh dấu lại các echo lời chào quanh nó
 * (adGreetingSql) và gỡ pause chúng đặt. Trả số echo đã đánh dấu — > 0 thì nơi gọi hẹn chatbot sau commit (tin khách
 * đã lên lịch trước đó có thể bị chặn/hủy bởi pause của lời chào).
 */
export async function reclassifyEchoesNearAdNotice(
  db: DbLike,
  conversationId: string,
  noticeSentAt: Date,
): Promise<number> {
  const from = new Date(noticeSentAt.getTime() - AD_GREETING_ECHO_WINDOW_SEC * 1000);
  const to = new Date(noticeSentAt.getTime() + AD_GREETING_ECHO_WINDOW_SEC * 1000);
  const { marked } = await markEchoes(
    db,
    and(
      eq(messages.conversationId, conversationId),
      sql`${messages.sentAt} between ${ts(from)} and ${ts(to)}`,
      adGreetingSql(conversationId, sql`${messages.sentAt}`),
    ),
  );
  return marked.length;
}

export interface AdGreetingRepairResult {
  /** Số echo được đánh dấu tự động. */
  echoes: number;
  /** Số hội thoại có echo được đánh dấu. */
  conversations: number;
  /** Số hội thoại được gỡ pause do echo đó đặt. */
  pausesReleased: number;
}

/**
 * Sửa (idempotent) các hội thoại bị kẹt TRƯỚC bản sửa lời chào quảng cáo: echo nền tảng gửi trong [now − `days` ngày,
 * `before`) (mốc cố định AD_GREETING_REPAIR_BEFORE ⇒ không đụng echo đường sống đã phân loại), chưa đánh dấu tự động,
 * là lời chào quảng cáo (adGreetingSql — cùng điều kiện với đường sống, KHÔNG dựa vào window_source hiện tại của hội
 * thoại) ⇒ đánh dấu automatedEcho + gỡ pause echo đã đặt (cùng điều kiện an toàn). KHÔNG gửi gì, KHÔNG lên lịch bot:
 * tin khách chỉ hết bị "cắt" khỏi danh sách chưa xử lý ⇒ "Tiếp tục AI" / chọn lại bot / tin khách kế tiếp sẽ trả lời
 * như thường. Chạy lại không đổi gì (đã đánh dấu thì bỏ).
 */
export async function repairAdGreetingEchoes(
  db: DbLike,
  {
    days = AD_GREETING_REPAIR_DAYS,
    now = new Date(),
    before = AD_GREETING_REPAIR_BEFORE,
  }: { days?: number; now?: Date; before?: Date } = {},
): Promise<AdGreetingRepairResult> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  if (since >= before) return { echoes: 0, conversations: 0, pausesReleased: 0 };
  const { marked, pausesReleased } = await markEchoes(
    db,
    and(
      sql`${messages.sentAt} >= ${ts(since)}`,
      sql`${messages.sentAt} < ${ts(before)}`,
      adGreetingSql(sql`${messages.conversationId}`, sql`${messages.sentAt}`),
    ),
  );
  return {
    echoes: marked.length,
    conversations: new Set(marked.map((m) => m.conversationId)).size,
    pausesReleased,
  };
}
