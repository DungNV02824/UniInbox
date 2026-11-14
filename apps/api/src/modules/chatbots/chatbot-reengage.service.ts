import {
  AI_REPLY_JOB_NAME,
  aiReengageJobId,
  type AiReplyJobData,
  type InboxContext,
  previewChatbotReengage,
  type ReengageJob,
  type ReengageQueue,
  type ReengageSlotRequest,
  startChatbotReengage,
} from '@dezon/core';
import type { Db } from '@dezon/db';
import type { ReengagePreview, ReengageStartRequest, ReengageStartResult } from '@dezon/shared';
import { Inject, Injectable } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { withTimeout } from '../../common/with-timeout';
import { DB } from '../../infra/db/db.constants';
import { INBOX_CONTEXT } from '../../infra/inbox/inbox.constants';
import { AI_REPLY_QUEUE, ENQUEUE_TIMEOUT_MS } from '../../infra/queue/queue.constants';

/**
 * Tùy chọn job "reply" tái chăm sóc: thử lại như job ai-reply của worker (AI_REPLY_JOB_OPTIONS); xóa khi xong/lỗi hẳn
 * để lần bấm sau dùng lại được jobId cố định aiReengageJobId(conv) — job còn chờ thì BullMQ bỏ qua (không trả lời
 * hai lần khi bấm liên tiếp / hai admin cùng bấm).
 */
export const REENGAGE_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: true,
};

/**
 * Khóa Redis (trong không gian tên của queue ai-reply — obliterate cũng xóa) giữ "khe kế tiếp" (epoch ms) của hàng giãn
 * cách CHUNG mọi lượt tái chăm sóc. Không trùng khóa job: jobId tái chăm sóc luôn dạng `ai-<conv>-reengage`.
 */
export const REENGAGE_NEXT_SLOT_KEY_SUFFIX = 'reengage:next-slot';
/** Khóa khe tự hết hạn sau khe kế tiếp + chừng này (hàng trống ⇒ lần bấm sau bắt đầu ngay). */
const NEXT_SLOT_TTL_GRACE_MS = 60_000;

/**
 * Giữ nguyên tử một khe: KEYS[1] = khóa khe; ARGV = nowMs, spacingMs, latestMs (−1 = không giới hạn), graceMs.
 * Trả khe (ms) hoặc −1 khi khe > latestMs (không giữ). Số ms (~1.7e12) nằm gọn trong số thực của Lua.
 */
const RESERVE_SLOT_LUA = `
local now = tonumber(ARGV[1])
local spacing = tonumber(ARGV[2])
local latest = tonumber(ARGV[3])
local grace = tonumber(ARGV[4])
local cur = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
local slot = math.max(now, cur)
if latest >= 0 and slot > latest then return -1 end
local nextSlot = slot + spacing
redis.call('SET', KEYS[1], string.format('%.0f', nextSlot), 'PX', string.format('%.0f', nextSlot - now + grace))
return string.format('%.0f', slot)
`;
/** Tên lệnh Lua (riêng, không trùng lệnh của BullMQ). */
const RESERVE_SLOT_COMMAND = 'dezonReengageReserveSlot';
/** Client Redis đã defineCommand(RESERVE_SLOT_COMMAND). */
const slotCommandClients = new WeakSet<object>();

/** "Tái chăm sóc khách bị bỏ sót": quét (preview) và xếp hàng các lượt bot trả lời giãn cách (start). */
@Injectable()
export class ChatbotReengageService {
  private readonly queue: ReengageQueue = {
    pending: (ids) => this.pending(ids),
    reserveSlot: (request) => this.reserveSlot(request),
    enqueue: (job) => this.enqueue(job),
  };

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(INBOX_CONTEXT) private readonly ctx: InboxContext,
    @Inject(AI_REPLY_QUEUE) private readonly aiReply: Queue<AiReplyJobData>,
  ) {}

  preview(chatbotId: string, days: number): Promise<ReengagePreview> {
    return previewChatbotReengage(this.db, this.ctx, chatbotId, days, this.queue);
  }

  start(actorUserId: string, chatbotId: string, input: ReengageStartRequest): Promise<ReengageStartResult> {
    return startChatbotReengage(
      this.db,
      this.ctx,
      {
        actorUserId,
        chatbotId,
        days: input.days,
        conversationIds: input.conversationIds,
        ...(input.rules ? { rules: input.rules } : {}),
        ...(input.content ? { content: input.content } : {}),
      },
      this.queue,
    );
  }

  /**
   * Hội thoại còn job tái chăm sóc (chờ/trễ/đang chạy/chờ thử lại — job xong/lỗi hẳn bị xóa theo REENGAGE_JOB_OPTIONS
   * nên còn hash job = còn chờ). Một lượt HGETALL khóa hash job (queue.toKey(jobId)) qua pipeline cho cả danh sách
   * (preview có thể tới REENGAGE_SCAN_LIMIT hội thoại); hash rỗng ⇒ không có job.
   */
  private async pending(conversationIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (conversationIds.length === 0) return new Set();
    const client = await this.aiReply.client;
    const pipeline = client.pipeline();
    for (const id of conversationIds) pipeline.hgetall(this.aiReply.toKey(aiReengageJobId(id)));
    const replies = await withTimeout(pipeline.exec(), ENQUEUE_TIMEOUT_MS, 'Kiểm tra job tái chăm sóc');
    const out = new Set<string>();
    conversationIds.forEach((id, i) => {
      const [err, hash] = replies?.[i] ?? [null, null];
      if (err) throw err;
      if (hash && typeof hash === 'object' && Object.keys(hash).length > 0) out.add(id);
    });
    return out;
  }

  /**
   * Khe chạy kế tiếp trong hàng giãn cách chung (RESERVE_SLOT_LUA — một lệnh nguyên tử nên hai admin/hai bot bấm cùng
   * lúc vẫn nhận khe khác nhau). Lỗi Redis ⇒ ném (HTTP 500, chưa đẩy job nào cho khách này).
   */
  private async reserveSlot(request: ReengageSlotRequest): Promise<number | null> {
    const client = await this.aiReply.client;
    // Lệnh Lua đặt tên (IRedisClient của BullMQ không có eval): định nghĩa một lần cho mỗi client.
    if (!slotCommandClients.has(client)) {
      client.defineCommand(RESERVE_SLOT_COMMAND, { numberOfKeys: 1, lua: RESERVE_SLOT_LUA });
      slotCommandClients.add(client);
    }
    const reply: unknown = await withTimeout(
      client.runCommand(RESERVE_SLOT_COMMAND, [
        this.aiReply.toKey(REENGAGE_NEXT_SLOT_KEY_SUFFIX),
        Math.round(request.nowMs),
        Math.max(0, Math.round(request.spacingMs)),
        request.latestMs === null ? -1 : Math.max(0, Math.floor(request.latestMs)),
        NEXT_SLOT_TTL_GRACE_MS,
      ]),
      ENQUEUE_TIMEOUT_MS,
      'Giữ lượt tái chăm sóc',
    );
    const slot = Number(reply);
    if (!Number.isFinite(slot)) throw new Error(`Khe tái chăm sóc không hợp lệ: ${String(reply)}`);
    return slot < 0 ? null : slot;
  }

  /**
   * Đẩy job; false ⇒ đã có job cùng jobId (BullMQ trả về job cũ mà không thêm — Job trả về vẫn mang data/timestamp
   * của lần gọi này nên phải đọc lại job đã lưu để so). Lỗi Redis ⇒ ném (HTTP 500): job đã đẩy giữ jobId cố định nên
   * bấm lại không trả lời trùng.
   */
  private async enqueue(job: ReengageJob): Promise<boolean> {
    return withTimeout(
      (async () => {
        if (await this.aiReply.getJob(job.jobId)) return false;
        const added = await this.aiReply.add(AI_REPLY_JOB_NAME, job.data, {
          ...REENGAGE_JOB_OPTIONS,
          jobId: job.jobId,
          delay: Math.max(0, Math.round(job.delayMs)),
        });
        // Hai admin cùng bấm: job kia có thể vừa được thêm giữa getJob và add. Job đã chạy xong (bị xóa) ⇒ là của mình.
        const stored = await this.aiReply.getJob(job.jobId);
        return !stored || stored.timestamp === added.timestamp;
      })(),
      ENQUEUE_TIMEOUT_MS,
      'Đẩy job tái chăm sóc',
    );
  }
}
