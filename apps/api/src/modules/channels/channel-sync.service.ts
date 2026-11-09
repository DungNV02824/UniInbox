// Xếp lịch đồng bộ lịch sử hội thoại (queue `channel-sync`, worker xử lý bằng syncMessengerAccount).
import {
  CHANNEL_SYNC_JOB_NAME,
  type ChannelSyncJobData,
  channelSyncJobId,
  InboxNotFoundError,
  listChannels,
  writeSyncState,
} from '@dezon/core';
import { channelAccounts, type Db } from '@dezon/db';
import type { ChannelAccountDto } from '@dezon/shared';
import { ConflictException, Inject, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { withTimeout } from '../../common/with-timeout';
import { APP_CONFIG, type AppConfig } from '../../config';
import { DB } from '../../infra/db/db.constants';
import { CHANNEL_SYNC_QUEUE, ENQUEUE_TIMEOUT_MS } from '../../infra/queue/queue.constants';

/**
 * jobId cố định theo kênh => không chạy chồng 2 lần đồng bộ lịch sử. Xóa job khi xong/lỗi hẳn để
 * lần bấm "Đồng bộ lịch sử" sau đẩy được job mới (BullMQ bỏ qua add() nếu jobId còn tồn tại).
 */
const BACKFILL_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: true,
};

/** Trạng thái job BullMQ coi là "đang đồng bộ" (chờ, chờ thử lại, đang chạy). */
const PENDING_STATES = new Set(['waiting', 'delayed', 'prioritized', 'waiting-children', 'active']);

const CHANNEL_NOT_FOUND = 'Không tìm thấy kênh';
const ENQUEUE_FAILED = 'Không xếp lịch được đồng bộ lịch sử, vui lòng bấm "Đồng bộ lịch sử" để thử lại';

const errText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : 'không rõ');

@Injectable()
export class ChannelSyncService {
  private readonly logger = new Logger(ChannelSyncService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(CHANNEL_SYNC_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Sau khi kết nối Page thành công: tự đẩy job đồng bộ lịch sử. Không bao giờ ném lỗi (kết nối
   * đã xong, đồng bộ lỗi chỉ ghi vào sync.lastError). Trả DTO đọc lại (kèm sync mới).
   */
  async afterConnect(channel: ChannelAccountDto): Promise<ChannelAccountDto> {
    try {
      await this.enqueueBackfill(channel.id, this.config.MESSENGER_HISTORY_DAYS);
    } catch (err) {
      this.logger.warn(`Không đẩy được job đồng bộ lịch sử cho kênh ${channel.id}: ${errText(err)}`);
      await this.markEnqueueFailed(channel.id);
    }
    return (await this.findDto(channel.id).catch(() => null)) ?? channel;
  }

  /**
   * POST /channels/:id/sync: 404 nếu không có kênh; 422 nếu không phải Messenger hoặc chưa kết nối;
   * 409 nếu đang có job đồng bộ lịch sử chờ/chạy. Ngược lại đẩy job và trả DTO.
   */
  async requestBackfill(id: string, days?: number): Promise<ChannelAccountDto> {
    const [row] = await this.db
      .select({ type: channelAccounts.type, status: channelAccounts.status })
      .from(channelAccounts)
      .where(eq(channelAccounts.id, id));
    if (!row) throw new InboxNotFoundError(CHANNEL_NOT_FOUND);
    if (row.type !== 'messenger') {
      throw new UnprocessableEntityException('Chỉ đồng bộ lịch sử được cho kênh Facebook Messenger');
    }
    if (row.status !== 'connected') {
      throw new UnprocessableEntityException('Kênh chưa kết nối, hãy kết nối lại trước khi đồng bộ');
    }
    await this.enqueueBackfill(id, days ?? this.config.MESSENGER_HISTORY_DAYS, { rejectIfPending: true });
    const dto = await this.findDto(id);
    if (!dto) throw new InboxNotFoundError(CHANNEL_NOT_FOUND);
    return dto;
  }

  private async enqueueBackfill(
    channelAccountId: string,
    days: number,
    opts: { rejectIfPending?: boolean } = {},
  ): Promise<void> {
    const jobId = channelSyncJobId(channelAccountId, 'backfill');
    const existing = await withTimeout(this.queue.getJob(jobId), ENQUEUE_TIMEOUT_MS, 'Đọc job đồng bộ');
    if (existing) {
      const state = await existing.getState();
      if (PENDING_STATES.has(state)) {
        if (opts.rejectIfPending) throw new ConflictException('Kênh đang đồng bộ lịch sử, vui lòng chờ');
        // Kết nối lại khi đang đồng bộ: giữ job cũ.
        return this.markRunning(channelAccountId);
      }
      // Job cũ đã xong/lỗi mà còn lưu (cấu hình khác): xóa để add() không bị bỏ qua.
      await existing.remove();
    }
    const data: ChannelSyncJobData = { channelAccountId, mode: 'backfill', days };
    // Ghi "đang đồng bộ" TRƯỚC khi đẩy job: worker có thể chạy xong (ghi backfillRunning=false)
    // trước khi add() trả về, ghi sau sẽ làm cờ kẹt ở true.
    await this.markRunning(channelAccountId);
    try {
      await withTimeout(
        this.queue.add(CHANNEL_SYNC_JOB_NAME, data, { ...BACKFILL_JOB_OPTIONS, jobId }),
        ENQUEUE_TIMEOUT_MS,
        'Đẩy job đồng bộ',
      );
    } catch (err) {
      await this.markEnqueueFailed(channelAccountId);
      throw err;
    }
  }

  /** Lỗi ghi trạng thái không làm hỏng yêu cầu (job đã nằm trong hàng đợi). */
  private async markRunning(channelAccountId: string): Promise<void> {
    try {
      await writeSyncState(this.db, channelAccountId, { backfillRunning: true });
    } catch (err) {
      this.logger.warn(`Không ghi được trạng thái đồng bộ của kênh ${channelAccountId}: ${errText(err)}`);
    }
  }

  private async markEnqueueFailed(channelAccountId: string): Promise<void> {
    try {
      await writeSyncState(this.db, channelAccountId, {
        backfillRunning: false,
        lastError: ENQUEUE_FAILED,
        lastErrorAt: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.warn(`Không ghi được lỗi đồng bộ của kênh ${channelAccountId}: ${errText(err)}`);
    }
  }

  private async findDto(id: string): Promise<ChannelAccountDto | null> {
    return (await listChannels(this.db)).find((c) => c.id === id) ?? null;
  }
}
