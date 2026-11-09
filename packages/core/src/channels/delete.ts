// Xóa hẳn một kênh đã ngắt kết nối cùng toàn bộ dữ liệu hội thoại của kênh (trang admin Kênh).
import {
  auditLogs,
  channelAccounts,
  contactIdentities,
  contacts,
  conversations,
  messages,
  type Db,
} from '@dezon/db';
import type { DeleteChannelRequest, DeleteChannelResult } from '@dezon/shared';
import { and, count, eq, ne, sql } from 'drizzle-orm';
import { ChannelDeleteConflictError, InboxNotFoundError, InboxValidationError } from '../inbox/errors';
import type { MediaStorage } from '../media/types';
import type { PipelineLogger } from '../pipeline/types';

export const CHANNEL_DELETE_CONNECTED_MESSAGE = 'Hãy ngắt kết nối kênh trước khi xóa';
export const CHANNEL_DELETE_NAME_MISMATCH_MESSAGE = 'Tên kênh xác nhận không khớp';

/** Số lệnh xóa S3 chạy song song khi dọn tệp sau khi xóa kênh. */
const STORAGE_DELETE_CONCURRENCY = 16;
/** Lỗi S3 liên tiếp quá ngưỡng này thì dừng dọn (S3 chết: không treo request vì hàng nghìn lệnh lỗi). */
const STORAGE_DELETE_MAX_CONSECUTIVE_FAILURES = 5;

export interface DeleteChannelDeps {
  /** null = chưa cấu hình S3: bỏ qua bước dọn tệp (ghi cảnh báo). */
  storage: MediaStorage | null;
  actorUserId: string;
  logger?: Pick<PipelineLogger, 'warn' | 'info'>;
}

const errorMessage = (err: unknown) => (err instanceof Error && err.message ? err.message : String(err));

/** avatar_url lưu storage key S3; URL http(s) (dữ liệu cũ/ngoài) thì không phải tệp của mình. */
/**
 * So khớp tên xác nhận: bỏ khoảng trắng đầu/cuối và chuẩn hóa Unicode NFC (bộ gõ tiếng Việt có thể sinh
 * chữ tổ hợp NFD trông y hệt nhưng khác byte). Vẫn phân biệt hoa thường và dấu. Web dùng cùng quy tắc.
 */
export const normalizeConfirmName = (v: string) => v.normalize('NFC').trim();

const isStorageKey = (v: string | null | undefined): v is string =>
  typeof v === 'string' && v.trim().length > 0 && !/^https?:\/\//i.test(v);

/**
 * Xóa kênh (chỉ khi KHÔNG ở trạng thái 'connected') trong MỘT transaction:
 * khóa dòng kênh → kiểm tra trạng thái/tên xác nhận → gom storage key media của tin → xóa tin, xóa khách
 * chỉ có trên kênh này (kéo theo danh tính/hội thoại của họ), xóa hội thoại và danh tính còn lại của kênh →
 * ghi audit_logs → xóa channel_accounts. Sau khi commit mới xóa tệp S3 (best-effort, lỗi chỉ ghi log).
 *
 * Ném InboxNotFoundError (404), ChannelDeleteConflictError (409, kênh đang kết nối — kiểm tra TRƯỚC tên),
 * InboxValidationError (400, tên xác nhận không khớp sau khi trim + NFC).
 */
export async function deleteChannel(
  db: Db,
  deps: DeleteChannelDeps,
  id: string,
  input: DeleteChannelRequest,
): Promise<DeleteChannelResult> {
  const confirmName = normalizeConfirmName(input.confirmName);

  const { result, storageKeys } = await db.transaction(async (tx) => {
    // Khóa dòng kênh: webhook/đồng bộ ghi danh tính/hội thoại/tin mới (FK tới kênh) phải chờ tới khi xong.
    const [channel] = await tx
      .select({
        id: channelAccounts.id,
        type: channelAccounts.type,
        externalId: channelAccounts.externalId,
        displayName: channelAccounts.displayName,
        status: channelAccounts.status,
      })
      .from(channelAccounts)
      .where(eq(channelAccounts.id, id))
      .for('update');
    if (!channel) throw new InboxNotFoundError('Không tìm thấy kênh');
    // Thứ tự cố ý: trạng thái trước tên. Kênh đang kết nối luôn trả 409 (kể cả khi gõ sai tên) để admin
    // biết ngay điều thực sự chặn việc xóa là phải ngắt kết nối trước (xem docs/DECISIONS.md).
    if (channel.status === 'connected')
      throw new ChannelDeleteConflictError(CHANNEL_DELETE_CONNECTED_MESSAGE);
    if (confirmName !== normalizeConfirmName(channel.displayName)) {
      throw new InboxValidationError(CHANNEL_DELETE_NAME_MISMATCH_MESSAGE);
    }

    // Storage key của tệp đính kèm (bỏ key rỗng = media tải về lỗi).
    const mediaRows = await tx.execute<{ key: string }>(sql`
      SELECT DISTINCT a.elem ->> 'storage_key' AS key
      FROM ${messages} m
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(m.attachments) = 'array' THEN m.attachments ELSE '[]'::jsonb END
      ) AS a(elem)
      WHERE m.channel_account_id = ${id}
        AND jsonb_typeof(a.elem) = 'object'
        AND coalesce(a.elem ->> 'storage_key', '') <> ''
    `);
    const mediaKeys = mediaRows.rows.map((r) => r.key).filter(isStorageKey);

    const [convCount] = await tx
      .select({ n: count() })
      .from(conversations)
      .where(eq(conversations.channelAccountId, id));

    const deletedMessages = await tx.delete(messages).where(eq(messages.channelAccountId, id));

    // Khách chỉ có mặt trên kênh này (không còn danh tính / hội thoại ở kênh khác) => xóa luôn khách;
    // CASCADE kéo theo danh tính, hội thoại, customer_memories của họ.
    const deletedContacts = await tx
      .delete(contacts)
      .where(
        and(
          sql`${contacts.id} IN (
            SELECT ${contactIdentities.contactId} FROM ${contactIdentities}
            WHERE ${contactIdentities.channelAccountId} = ${id}
            UNION
            SELECT ${conversations.contactId} FROM ${conversations}
            WHERE ${conversations.channelAccountId} = ${id}
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${contactIdentities} ci
            WHERE ci.contact_id = ${contacts.id} AND ci.channel_account_id <> ${id}
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${conversations} cv
            WHERE cv.contact_id = ${contacts.id} AND cv.channel_account_id <> ${id}
          )`,
        ),
      )
      .returning({ id: contacts.id, avatarUrl: contacts.avatarUrl });

    // Phần còn lại của kênh: hội thoại/danh tính của khách vẫn còn ở kênh khác.
    await tx.delete(conversations).where(eq(conversations.channelAccountId, id));
    await tx.delete(contactIdentities).where(eq(contactIdentities.channelAccountId, id));

    const counts = {
      conversations: convCount?.n ?? 0,
      messages: deletedMessages.rowCount ?? 0,
      contacts: deletedContacts.length,
    };
    await tx.insert(auditLogs).values({
      userId: deps.actorUserId,
      action: 'channel.delete',
      entity: 'channel_account',
      entityId: id,
      data: {
        type: channel.type,
        externalId: channel.externalId,
        displayName: channel.displayName,
        counts,
      },
    });

    const removed = await tx
      .delete(channelAccounts)
      .where(and(eq(channelAccounts.id, id), ne(channelAccounts.status, 'connected')));
    if (!removed.rowCount) throw new InboxNotFoundError('Không tìm thấy kênh');

    const avatarKeys = deletedContacts.map((c) => c.avatarUrl).filter(isStorageKey);
    return {
      result: { deleted: true as const, ...counts },
      storageKeys: [...new Set([...mediaKeys, ...avatarKeys])],
    };
  });

  await removeStoredFiles(deps, id, storageKeys);
  return result;
}

/** Xóa tệp S3 sau khi xóa kênh: best-effort, không bao giờ ném lỗi. */
async function removeStoredFiles(deps: DeleteChannelDeps, channelAccountId: string, keys: string[]) {
  if (keys.length === 0) return;
  const { storage, logger } = deps;
  if (!storage) {
    logger?.warn(
      { channelAccountId, files: keys.length },
      'Chưa cấu hình S3: không xóa được tệp của kênh đã xóa',
    );
    return;
  }
  let next = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let aborted = false;
  const worker = async () => {
    while (!aborted && next < keys.length) {
      const key = keys[next++]!;
      try {
        await storage.delete(key);
        consecutiveFailures = 0;
      } catch (err) {
        failed++;
        consecutiveFailures++;
        logger?.warn({ channelAccountId, key, err: errorMessage(err) }, 'Không xóa được tệp của kênh đã xóa');
        if (consecutiveFailures >= STORAGE_DELETE_MAX_CONSECUTIVE_FAILURES) aborted = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(STORAGE_DELETE_CONCURRENCY, keys.length) }, () => worker()),
  );
  if (aborted) {
    logger?.warn(
      { channelAccountId, files: keys.length, failed, skipped: keys.length - next },
      'Dừng xóa tệp của kênh đã xóa vì S3 lỗi liên tiếp',
    );
  } else {
    logger?.info({ channelAccountId, files: keys.length, failed }, 'Đã dọn tệp của kênh đã xóa');
  }
}
