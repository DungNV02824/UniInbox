// Tự tải lại tệp tin đến bị hỏng lúc nhận (storage_key '' + original_url) — ví dụ kho S3 tạm hết chỗ ghi, CDN
// chập chờn. Chỉ ghi kho + sửa phần tử attachments của tin rồi phát message.updated; KHÔNG gọi chatbot, KHÔNG gửi
// gì cho khách. Worker gọi lúc khởi động và định kỳ (apps/worker/src/attachment-retry.ts).
import { conversations, messages, type Db } from '@dezon/db';
import type { MessageAttachment } from '@dezon/shared';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_MIME } from '../media/mime';
import type { StoredMedia } from '../media/types';
import {
  AttachmentStoreError,
  downloadAndStoreAttachment,
  isPermanentAttachmentError,
} from './attachment-download';
import {
  ATTACHMENT_RETRY_MAX_ATTEMPTS,
  ATTACHMENT_RETRY_MAX_BACKOFF_MIN,
  ATTACHMENT_RETRY_MAX_FREE_STORE_ERRORS,
  attachmentRetryCount,
  attachmentRetryCutoff,
  attachmentStoreErrorCount,
  isAttachmentRetryDue,
} from './attachment-retry-policy';
import { emitMessageUpdated, safeErrorMessage } from './helpers';
import type { PipelineDeps } from './types';

export {
  ATTACHMENT_RETRY_MAX_ATTEMPTS,
  ATTACHMENT_RETRY_MAX_BACKOFF_MIN,
  ATTACHMENT_RETRY_MAX_FREE_STORE_ERRORS,
  ATTACHMENT_RETRY_WINDOW_DAYS,
  attachmentRetryBackoffMs,
  isAttachmentRetryDue,
  isAttachmentRetryPending,
} from './attachment-retry-policy';
export { ATTACHMENT_STORE_TIMEOUT_MS } from './attachment-download';
export { safeErrorMessage } from './helpers';

/** Số tin tối đa mỗi lượt quét (mỗi tin thường 1–3 tệp). */
export const ATTACHMENT_RETRY_BATCH_SIZE = 50;
/** Số tin tải song song trong một lượt. */
export const ATTACHMENT_RETRY_CONCURRENCY = 3;

export type AttachmentRetryDeps = Pick<
  PipelineDeps,
  'storage' | 'maxMediaBytes' | 'fetch' | 'publisher' | 'ctx' | 'logger'
>;

export interface AttachmentRetryOptions {
  /** Cố định đồng hồ (test). Mặc định deps.ctx.now(), đọc lại lúc nhận lượt từng tin. */
  now?: Date;
  batchSize?: number;
  concurrency?: number;
  /** Dừng nhận tin mới (worker đang tắt). Tin đang tải dở vẫn chạy xong. */
  signal?: AbortSignal;
  /** Hạn mỗi lệnh ghi kho (mặc định ATTACHMENT_STORE_TIMEOUT_MS). */
  storeTimeoutMs?: number;
}

export interface AttachmentRetryResult {
  /** Tin có tệp tới lượt tải lại (sau lọc SQL). */
  candidates: number;
  /** Tin đã nhận lượt (khóa được, còn tệp tới lượt). */
  messages: number;
  /** Tệp tải lại thành công. */
  repaired: number;
  /** Tệp vẫn lỗi (tạm thời), sẽ thử lại sau backoff. */
  failed: number;
  /** Tệp bỏ hẳn lần này (link hết hạn / quá lớn / hết lượt). */
  exhausted: number;
  /**
   * Tệp lỗi do kho S3 (không tính lượt tới ATTACHMENT_RETRY_MAX_FREE_STORE_ERRORS lần mỗi tệp; dừng lượt quét để
   * không dội kho đang hỏng).
   */
  storageErrors: number;
  /** Tệp đã được nơi khác sửa trong lúc tải (bỏ kết quả, xóa tệp vừa lưu). */
  superseded: number;
  /** Lượt quét dừng sớm vì lỗi kho. */
  stoppedOnStorageError: boolean;
}

interface Claimed {
  index: number;
  attachment: MessageAttachment;
}

type Outcome =
  | { index: number; url: string; kind: 'stored'; stored: StoredMedia }
  | { index: number; url: string; kind: 'permanent' | 'transient' | 'storage'; error: string };

/**
 * Một lượt: tìm tin (gửi hoặc lưu trong ATTACHMENT_RETRY_WINDOW_DAYS ngày) có tệp hỏng tới lượt, MỚI NHẤT trước,
 * tối đa batchSize tin. Mỗi tin: (1) transaction ngắn khóa dòng (SKIP LOCKED) để "nhận lượt" — tăng retry_count, ghi
 * last_retry_at ⇒ worker khác/lượt sau không lấy trùng (backoff), worker chết giữa chừng vẫn bị tính lượt (tệp
 * làm sập worker không lặp vô hạn); (2) tải + lưu ngoài transaction; (3) transaction khóa dòng đọc lại, chỉ thay
 * phần tử CÒN hỏng và cùng original_url (không đè tệp nơi khác đã sửa), giữ thứ tự/field khác. Lỗi kho ⇒ trả lại
 * lượt (không tính, có trần mỗi tệp) và dừng nhận tin mới trong lượt quét này. Không ném (trừ lỗi truy vấn tìm tin).
 * Đồng hồ đọc lại lúc nhận lượt từng tin (lượt dài vài phút không làm hụt backoff / để worker khác lấy trùng).
 */
export async function retryFailedAttachments(
  db: Db,
  deps: AttachmentRetryDeps,
  options: AttachmentRetryOptions = {},
): Promise<AttachmentRetryResult> {
  const clock = () => options.now ?? deps.ctx.now();
  const now = clock();
  const batchSize = options.batchSize ?? ATTACHMENT_RETRY_BATCH_SIZE;
  const concurrency = Math.max(1, options.concurrency ?? ATTACHMENT_RETRY_CONCURRENCY);
  const result: AttachmentRetryResult = {
    candidates: 0,
    messages: 0,
    repaired: 0,
    failed: 0,
    exhausted: 0,
    storageErrors: 0,
    superseded: 0,
    stoppedOnStorageError: false,
  };

  const ids = await findCandidateMessageIds(db, now, batchSize);
  result.candidates = ids.length;
  let next = 0;
  const workerLoop = async () => {
    for (;;) {
      if (options.signal?.aborted || result.stoppedOnStorageError) return;
      const id = ids[next++];
      if (!id) return;
      try {
        await retryMessage(db, deps, id, clock, options.storeTimeoutMs, result);
      } catch (error) {
        // Lỗi truy vấn của drizzle chứa params (URL CDN có token) ⇒ chỉ log thông điệp đã lọc.
        deps.logger.warn({ messageId: id, err: safeErrorMessage(error) }, 'Tải lại tệp đính kèm lỗi');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, workerLoop));
  return result;
}

/**
 * Lọc bằng SQL cùng quy tắc với isAttachmentRetryDue (kiểm lại chính xác khi khóa dòng). Cửa sổ theo
 * GREATEST(sent_at, created_at) (đồng bộ lịch sử lưu tin cũ với link CDN vừa lấy). Đi từ hội thoại có hoạt động
 * trong cửa sổ (last_message_at, hoặc updated_at — mọi lần lưu tin đều cập nhật hội thoại) xuống tin của hội thoại
 * đó, lọc rẻ bằng jsonb @> trước khi bung mảng — không quét cả bảng messages mỗi 2 phút. Backoff lọc ngay ở đây để
 * tệp đang chờ không chiếm chỗ của lượt.
 * Thứ tự: tệp CHƯA thử lần nào trước (tin mới nhất trước — hội thoại đang diễn ra hồi phục trước), rồi tệp thử lâu
 * nhất trước (xoay vòng ⇒ một tệp lỗi mãi không chặn các tệp khác).
 */
async function findCandidateMessageIds(db: Db, now: Date, limit: number): Promise<string[]> {
  const cutoff = attachmentRetryCutoff(now).toISOString();
  const at = now.toISOString();
  const result = await db.execute<{ id: string }>(sql`
    SELECT m.id
    FROM ${messages} m
    JOIN ${conversations} c ON c.id = m.conversation_id
    CROSS JOIN LATERAL (
      SELECT count(*) AS n, min(t.tried_at) AS tried_at
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(m.attachments) = 'array' THEN m.attachments ELSE '[]'::jsonb END
      ) e
      CROSS JOIN LATERAL (
        SELECT
          CASE WHEN jsonb_typeof(e -> 'retry_count') = 'number'
               THEN greatest((e ->> 'retry_count')::numeric, 0) ELSE 0 END AS rc,
          CASE WHEN coalesce(e ->> 'last_retry_at', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
               THEN (e ->> 'last_retry_at')::timestamptz ELSE '-infinity'::timestamptz END AS tried_at
      ) t
      WHERE coalesce(e ->> 'storage_key', '') = ''
        AND coalesce(e ->> 'original_url', '') ~* '^https?://'
        AND coalesce(e -> 'retry_exhausted', 'false'::jsonb) <> 'true'::jsonb
        AND t.rc < ${ATTACHMENT_RETRY_MAX_ATTEMPTS}
        AND t.tried_at + make_interval(mins => least(power(2, t.rc), ${ATTACHMENT_RETRY_MAX_BACKOFF_MIN})::int)
            <= ${at}::timestamptz
    ) d
    WHERE (c.last_message_at >= ${cutoff}::timestamptz OR c.updated_at >= ${cutoff}::timestamptz)
      AND (m.sent_at >= ${cutoff}::timestamptz OR m.created_at >= ${cutoff}::timestamptz)
      AND m.attachments @> '[{"storage_key": ""}]'::jsonb
      AND d.n > 0
    ORDER BY d.tried_at ASC, m.sent_at DESC
    LIMIT ${limit}
  `);
  return result.rows.map((r) => r.id);
}

async function retryMessage(
  db: Db,
  deps: AttachmentRetryDeps,
  messageId: string,
  clock: () => Date,
  storeTimeoutMs: number | undefined,
  result: AttachmentRetryResult,
): Promise<void> {
  const claimed = await claim(db, messageId, clock());
  if (!claimed || claimed.length === 0) return;
  result.messages++;

  const outcomes = await Promise.all(
    claimed.map(async ({ index, attachment: a }): Promise<Outcome> => {
      const url = a.original_url!;
      try {
        const stored = await downloadAndStoreAttachment(
          deps,
          {
            url,
            type: a.type,
            // Lúc nhận thiếu mime thì phần tử hỏng ghi DEFAULT_MIME: truyền lại như "không có" để giống hệt luồng nhận.
            ...(a.mime && a.mime !== DEFAULT_MIME ? { mime: a.mime } : {}),
            ...(a.name ? { name: a.name } : {}),
          },
          storeTimeoutMs !== undefined ? { storeTimeoutMs } : {},
        );
        return { index, url, kind: 'stored', stored };
      } catch (error) {
        const kind =
          error instanceof AttachmentStoreError
            ? 'storage'
            : isPermanentAttachmentError(error)
              ? 'permanent'
              : 'transient';
        return { index, url, kind, error: safeErrorMessage(error) };
      }
    }),
  );
  if (outcomes.some((o) => o.kind === 'storage')) result.stoppedOnStorageError = true;

  const storedKeys = outcomes.flatMap((o) => (o.kind === 'stored' ? [o.stored.storage_key] : []));
  let applied: Awaited<ReturnType<typeof applyOutcomes>>;
  try {
    applied = await applyOutcomes(db, messageId, outcomes);
  } catch (error) {
    await deleteQuietly(deps, storedKeys);
    throw error;
  }
  await deleteQuietly(deps, applied.orphanKeys);

  result.repaired += applied.repaired;
  result.failed += applied.failed;
  result.exhausted += applied.exhausted;
  result.storageErrors += applied.storageErrors;
  result.superseded += applied.superseded;
  for (const o of outcomes) {
    if (o.kind !== 'stored') {
      deps.logger.debug({ messageId, kind: o.kind, err: o.error }, 'Tải lại tệp đính kèm chưa được');
    }
  }

  // Giao diện đổi (ảnh hiện / "Đang tải lại" → "nhờ khách gửi lại") ⇒ phát message.updated.
  if (applied.repaired > 0 || applied.exhausted > 0) {
    const [conv] = await db
      .select({ assignedUserId: conversations.assignedUserId })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(messages.id, messageId))
      .limit(1);
    if (conv) await emitMessageUpdated(db, deps, messageId, conv);
  }
}

/**
 * Nhận lượt: khóa dòng (bỏ qua nếu worker khác đang giữ), tăng retry_count + ghi last_retry_at cho tệp tới lượt.
 * `now` là giờ lúc nhận lượt (không phải lúc bắt đầu lượt quét).
 */
async function claim(db: Db, messageId: string, now: Date): Promise<Claimed[] | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ attachments: messages.attachments, sentAt: messages.sentAt, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, messageId))
      .for('update', { skipLocked: true });
    if (!row || !Array.isArray(row.attachments)) return null;
    const claimed: Claimed[] = [];
    const nextAttachments = row.attachments.map((a, index) => {
      if (!isAttachmentRetryDue(a, row, now)) return a;
      claimed.push({ index, attachment: a });
      return { ...a, retry_count: attachmentRetryCount(a) + 1, last_retry_at: now.toISOString() };
    });
    if (claimed.length === 0) return null;
    await tx.update(messages).set({ attachments: nextAttachments }).where(eq(messages.id, messageId));
    return claimed;
  });
}

async function applyOutcomes(db: Db, messageId: string, outcomes: Outcome[]) {
  return db.transaction(async (tx) => {
    const counts = { repaired: 0, failed: 0, exhausted: 0, storageErrors: 0, superseded: 0 };
    const orphanKeys: string[] = [];
    const [row] = await tx
      .select({ attachments: messages.attachments })
      .from(messages)
      .where(eq(messages.id, messageId))
      .for('update');
    const current = row && Array.isArray(row.attachments) ? [...row.attachments] : null;
    let changed = false;
    for (const o of outcomes) {
      const el = current?.[o.index];
      // Còn hỏng và cùng link ⇒ của lượt này. Khác ⇒ nơi khác đã sửa/xóa: không đè, bỏ tệp vừa lưu.
      if (!current || !el || el.storage_key || el.original_url !== o.url) {
        counts.superseded++;
        if (o.kind === 'stored') orphanKeys.push(o.stored.storage_key);
        continue;
      }
      switch (o.kind) {
        case 'stored':
          current[o.index] = o.stored;
          counts.repaired++;
          changed = true;
          break;
        case 'storage': {
          counts.storageErrors++;
          changed = true;
          const storeErrors = attachmentStoreErrorCount(el) + 1;
          if (storeErrors <= ATTACHMENT_RETRY_MAX_FREE_STORE_ERRORS) {
            // Lỗi kho của mình, không phải của link: trả lại lượt (last_retry_at vẫn giữ ⇒ có backoff ngắn).
            current[o.index] = {
              ...el,
              retry_count: Math.max(0, attachmentRetryCount(el) - 1),
              store_error_count: storeErrors,
            };
          } else if (attachmentRetryCount(el) >= ATTACHMENT_RETRY_MAX_ATTEMPTS) {
            // Hết lượt "miễn phí": kho luôn từ chối tệp này ⇒ tính như lỗi tạm thời, tới trần thì bỏ hẳn.
            current[o.index] = { ...el, store_error_count: storeErrors, retry_exhausted: true };
            counts.exhausted++;
          } else {
            current[o.index] = { ...el, store_error_count: storeErrors };
          }
          break;
        }
        case 'permanent':
          current[o.index] = { ...el, retry_exhausted: true };
          counts.exhausted++;
          changed = true;
          break;
        case 'transient':
          if (attachmentRetryCount(el) >= ATTACHMENT_RETRY_MAX_ATTEMPTS) {
            current[o.index] = { ...el, retry_exhausted: true };
            counts.exhausted++;
            changed = true;
          } else {
            counts.failed++;
          }
          break;
      }
    }
    if (current && changed) {
      await tx.update(messages).set({ attachments: current }).where(eq(messages.id, messageId));
    }
    return { ...counts, orphanKeys };
  });
}

async function deleteQuietly(deps: AttachmentRetryDeps, keys: string[]): Promise<void> {
  await Promise.allSettled(keys.map((key) => deps.storage.delete(key)));
}
