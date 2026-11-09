// Đồng bộ một kênh Messenger qua Conversations API (docs/research/messenger-platform.md §13).
import { channelAccounts, type Db } from '@dezon/db';
import { eq } from 'drizzle-orm';
import { loadResolvedAccount } from '../channels/service';
import {
  messengerConversationsOf,
  threadMessageToInbound,
  type MessengerConversation,
  type MessengerConversationsReader,
  type MessengerThreadMessage,
} from '../connectors/messenger';
import { pageTokenOf } from '../connectors/messenger/send';
import { PermanentSendError, TransientSendError } from '../connectors/types';
import { emitConversationUpdated, errorMessage } from '../pipeline/helpers';
import { applyParticipantName } from '../pipeline/identity';
import { processInboundMessage } from '../pipeline/inbound';
import type { InboundSource, PipelineDeps } from '../pipeline/types';
import { findConversationId, settleImportedConversation } from './imported';
import { pauseAfter } from './pause';
import { writeSyncState } from './state';
import type { SyncOptions, SyncResult } from './types';

export const DEFAULT_BACKFILL_DAYS = 30;
export const DEFAULT_MAX_CONVERSATIONS = 500;
export const DEFAULT_MAX_MESSAGES_PER_CONVERSATION = 200;
/** Incremental lùi lại 2 phút so với lần đồng bộ trước (đồng hồ lệch, tin ghi muộn). */
export const INCREMENTAL_OVERLAP_MS = 2 * 60_000;
/** Incremental khi chưa từng đồng bộ: 1 ngày gần nhất. */
export const INCREMENTAL_FIRST_WINDOW_MS = 24 * 60 * 60_000;
/**
 * Backfill: tin sau lần đồng bộ trước (vd. token hết hạn rồi kết nối lại) là tin bị lỡ => xử lý như tin mới,
 * nhưng tối đa 7 ngày gần nhất (quá 7 ngày Messenger không cho trả lời nữa).
 */
export const BACKFILL_MISSED_MAX_MS = 7 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const CONVERSATIONS_PAGE = 50;
const MESSAGES_PAGE = 100;

export const MSG_SYNC_NOT_CONFIGURED = 'Máy chủ chưa cấu hình kết nối Messenger, không đồng bộ được';
export const MSG_SYNC_FAILED = 'Đồng bộ hội thoại thất bại do lỗi hệ thống, sẽ thử lại sau';

const EMPTY: SyncResult = { conversations: 0, messagesStored: 0, messagesSkipped: 0 };

export interface SyncPlan {
  backfill: boolean;
  /** Đọc hội thoại/tin cập nhật từ mốc này. */
  since: Date;
  /** Tin tạo từ mốc này trở đi là tin MỚI (xử lý như webhook); trước mốc là lịch sử (chỉ backfill). */
  newSince: Date;
  maxConversations: number;
  maxMessages: number;
}

export function planOf(opts: SyncOptions, lastSyncedAt: string | null, now: Date): SyncPlan {
  const maxConversations = opts.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;
  const maxMessages = opts.maxMessagesPerConversation ?? DEFAULT_MAX_MESSAGES_PER_CONVERSATION;
  const parsed = lastSyncedAt ? Date.parse(lastSyncedAt) : NaN;
  const last = Number.isFinite(parsed) ? Math.min(parsed, now.getTime()) : null;
  if (opts.mode === 'backfill') {
    const days = opts.days ?? DEFAULT_BACKFILL_DAYS;
    // Chưa từng đồng bộ: chỉ tin đến trong lúc chạy là "mới". Đã từng: tin sau lần trước là tin bị lỡ.
    const newSince = Math.max(
      (last ?? now.getTime()) - INCREMENTAL_OVERLAP_MS,
      now.getTime() - BACKFILL_MISSED_MAX_MS,
    );
    return {
      backfill: true,
      since: new Date(now.getTime() - days * DAY_MS),
      newSince: new Date(newSince),
      maxConversations,
      maxMessages,
    };
  }
  const since =
    last !== null
      ? new Date(last - INCREMENTAL_OVERLAP_MS)
      : new Date(now.getTime() - INCREMENTAL_FIRST_WINDOW_MS);
  return { backfill: false, since, newSince: since, maxConversations, maxMessages };
}

const sourceOf = (plan: SyncPlan, m: MessengerThreadMessage): InboundSource =>
  plan.backfill && m.createdTime.getTime() < plan.newSince.getTime() ? 'sync-backfill' : 'sync-incremental';

interface Collected<T> {
  items: T[];
  /** Dừng vì chạm giới hạn an toàn trong khi Graph còn dữ liệu trong khoảng đồng bộ. */
  truncated: boolean;
}

type PageReader<T> = (
  after: string | undefined,
  limit: number,
) => Promise<{ items: T[]; after: string | null }>;

/** Đọc lần lượt các trang (cursor `after`) tới khi hết hoặc đủ `max` mục. */
async function collectPages<T>(read: PageReader<T>, pageSize: number, max: number): Promise<Collected<T>> {
  const items: T[] = [];
  let after: string | undefined;
  let truncated = false;
  do {
    const room = max - items.length;
    const page = await read(after, Math.min(pageSize, room));
    if (page.items.length > room) truncated = true;
    items.push(...page.items.slice(0, room));
    after = page.after ?? undefined;
  } while (after && items.length < max);
  return { items, truncated: truncated || after !== undefined };
}

const collectConversations = (
  reader: MessengerConversationsReader,
  token: string,
  pageId: string,
  plan: SyncPlan,
): Promise<Collected<MessengerConversation>> =>
  collectPages(
    (after, limit) =>
      reader.listConversations(token, pageId, { since: plan.since, limit, ...(after ? { after } : {}) }),
    CONVERSATIONS_PAGE,
    plan.maxConversations,
  );

/** Tin trong khoảng đồng bộ, CŨ NHẤT trước (Graph trả mới nhất trước). */
async function collectMessages(
  reader: MessengerConversationsReader,
  token: string,
  conversationId: string,
  plan: SyncPlan,
): Promise<Collected<MessengerThreadMessage>> {
  const collected = await collectPages(
    (after, limit) =>
      reader.listMessages(token, conversationId, { since: plan.since, limit, ...(after ? { after } : {}) }),
    MESSAGES_PAGE,
    plan.maxMessages,
  );
  collected.items.sort((a, b) => a.createdTime.getTime() - b.createdTime.getTime());
  return collected;
}

/** Lỗi gắn với cả kênh (token hỏng, Facebook tạm lỗi/giới hạn tần suất) => dừng cả lần đồng bộ. */
function isFatal(error: unknown): boolean {
  if (error instanceof PermanentSendError) return error.credentialsInvalid;
  return true;
}

function userMessage(error: unknown): string {
  return error instanceof PermanentSendError || error instanceof TransientSendError
    ? error.message
    : MSG_SYNC_FAILED;
}

/**
 * Đồng bộ một kênh Messenger: đọc GET /{page}/conversations?platform=messenger (+ messages) bằng Page token,
 * chuyển mỗi tin thành NormalizedInboundMessage rồi đưa qua luồng tin đến (chống trùng theo
 * external_message_id).
 * - backfill: N ngày gần nhất. Tin cũ hơn mốc (lần đồng bộ trước - 2 phút, hoặc lúc chạy - 2 phút nếu chưa
 *   từng đồng bộ; tối đa 7 ngày) là lịch sử: không tăng unread, không mở lại hội thoại. Tin sau mốc là tin
 *   bị lỡ => như webhook. Hội thoại MỚI chỉ có lịch sử đã xử lý được đặt 'resolved'.
 * - incremental: từ lastSyncedAt - 2 phút, xử lý như webhook.
 * Cập nhật channel_accounts.settings.sync; token hỏng => kênh 'expired'; giới hạn tần suất / thiếu quyền =>
 * tạm dừng đồng bộ định kỳ (pausedUntil). Lỗi được ném lại (PermanentSendError = không nên thử lại).
 */
export async function syncMessengerAccount(
  db: Db,
  deps: PipelineDeps,
  channelAccountId: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const now = (opts.now ?? deps.ctx.now)();
  const backfill = opts.mode === 'backfill';
  const [row] = await db
    .select({
      type: channelAccounts.type,
      status: channelAccounts.status,
      externalId: channelAccounts.externalId,
      settings: channelAccounts.settings,
    })
    .from(channelAccounts)
    .where(eq(channelAccounts.id, channelAccountId))
    .limit(1);
  const log = { channelAccountId, mode: opts.mode };
  // Kênh đã bị xóa khi job còn trong hàng đợi: bỏ qua (không thử lại vô ích).
  if (!row) {
    deps.logger.info(log, 'Kênh không còn tồn tại, bỏ qua đồng bộ');
    return EMPTY;
  }
  if (row.type !== 'messenger') throw new Error('Không tìm thấy kênh Messenger cần đồng bộ');

  // Kênh đã ngắt / hết hạn: không gọi Meta (kết nối lại sẽ đồng bộ lịch sử lại).
  if (row.status !== 'connected') {
    deps.logger.info({ ...log, status: row.status }, 'Kênh không ở trạng thái kết nối, bỏ qua đồng bộ');
    if (backfill) await writeSyncState(db, channelAccountId, { backfillRunning: false });
    return EMPTY;
  }

  const result: SyncResult = { conversations: 0, messagesStored: 0, messagesSkipped: 0 };
  let skippedConversations = 0;
  let truncated = false;
  try {
    const reader = messengerConversationsOf(deps.connectors.messenger);
    if (!reader) throw new PermanentSendError(MSG_SYNC_NOT_CONFIGURED, false, 'no_connector');
    const account = await loadResolvedAccount(db, deps.cipher, channelAccountId);
    if (!account) throw new PermanentSendError('Kênh chưa có thông tin xác thực', true, 'missing_token');
    const token = pageTokenOf(account);
    const sync = row.settings?.sync as { lastSyncedAt?: unknown } | undefined;
    const lastSyncedAt = typeof sync?.lastSyncedAt === 'string' ? sync.lastSyncedAt : null;
    const plan = planOf(opts, lastSyncedAt, now);

    const list = await collectConversations(reader, token, row.externalId, plan);
    truncated = list.truncated;
    for (const conv of list.items) {
      const customer = conv.participants.find((p) => p.id !== row.externalId);
      if (!customer) continue;
      try {
        const msgs = await collectMessages(reader, token, conv.id, plan);
        truncated ||= msgs.truncated;
        const isNew = backfill && (await findConversationId(db, channelAccountId, customer.id)) === null;
        let stored = 0;
        let lastConversation: { id: string; assignedUserId: string | null } | undefined;
        for (const m of msgs.items) {
          const normalized = threadMessageToInbound(m, {
            channelAccountId,
            pageId: row.externalId,
            conversationId: conv.id,
            customer,
          });
          if (!normalized) continue;
          const r = await processInboundMessage(db, deps, normalized, { source: sourceOf(plan, m) });
          if (r.stored) {
            stored++;
            lastConversation = r.conversation ?? lastConversation;
          } else result.messagesSkipped++;
        }
        result.conversations++;
        result.messagesStored += stored;
        // Tin đã về qua webhook trước (không có tên do thiếu quyền đọc hồ sơ): lấy tên từ participants.
        const renamed = await applyParticipantName(db, deps, {
          channelAccountId,
          channelType: 'messenger',
          externalUserId: customer.id,
          name: customer.name,
        });
        if (renamed && !(backfill && lastConversation)) await emitConversationUpdated(db, deps, renamed);
        if (backfill && lastConversation) {
          if (isNew) await settleImportedConversation(db, lastConversation.id, now);
          // Đồng bộ lịch sử: phát một conversation.updated cho mỗi hội thoại có tin mới.
          await emitConversationUpdated(db, deps, lastConversation);
        }
      } catch (error) {
        if (isFatal(error)) throw error;
        skippedConversations++;
        deps.logger.warn({ ...log, err: errorMessage(error) }, 'Không đồng bộ được một hội thoại, bỏ qua');
      }
    }

    const at = now.toISOString();
    await writeSyncState(db, channelAccountId, {
      lastSyncedAt: at,
      pausedUntil: null,
      ...(skippedConversations > 0
        ? { lastError: `Không đồng bộ được ${skippedConversations} hội thoại`, lastErrorAt: at }
        : { lastError: null, lastErrorAt: null }),
      ...(backfill
        ? {
            lastBackfillAt: at,
            backfillDays: opts.days ?? DEFAULT_BACKFILL_DAYS,
            backfillRunning: false,
            backfillConversations: result.conversations,
            backfillMessagesStored: result.messagesStored,
            backfillTruncated: truncated,
          }
        : {}),
    });
    if (truncated) {
      deps.logger.warn(
        { ...log, maxConversations: plan.maxConversations, maxMessages: plan.maxMessages },
        'Đồng bộ chạm giới hạn an toàn, một phần lịch sử cũ chưa được kéo về',
      );
    }
    // Đồng bộ định kỳ không có gì mới (phần lớn các lần, mỗi phút) => debug để log không bị ngập.
    const quiet = !backfill && result.messagesStored === 0 && skippedConversations === 0;
    deps.logger[quiet ? 'debug' : 'info'](
      { ...log, ...result, skippedConversations, truncated },
      'Đồng bộ hội thoại xong',
    );
    return truncated ? { ...result, truncated } : result;
  } catch (error) {
    const message = userMessage(error);
    const pause = pauseAfter(error);
    const failedAt = deps.ctx.now();
    deps.logger.error(
      { ...log, err: errorMessage(error), ...(pause ? { pauseMinutes: pause / 60_000 } : {}) },
      'Đồng bộ hội thoại thất bại',
    );
    if (error instanceof PermanentSendError && error.credentialsInvalid) {
      await db
        .update(channelAccounts)
        .set({ status: 'expired', lastError: message })
        .where(eq(channelAccounts.id, channelAccountId));
    }
    await writeSyncState(db, channelAccountId, {
      lastError: message,
      lastErrorAt: failedAt.toISOString(),
      ...(pause ? { pausedUntil: new Date(failedAt.getTime() + pause).toISOString() } : {}),
      ...(backfill ? { backfillRunning: false } : {}),
    });
    throw error;
  }
}
