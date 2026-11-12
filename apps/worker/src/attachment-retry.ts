// Tự tải lại tệp tin đến bị hỏng lúc nhận (kho S3 tạm hỏng, CDN chập chờn): chạy một lần lúc khởi động rồi định kỳ.
import {
  retryFailedAttachments,
  safeErrorMessage,
  type AttachmentRetryDeps,
  type AttachmentRetryResult,
  type PipelineLogger,
} from '@dezon/core';
import type { Db } from '@dezon/db';

/** Chu kỳ quét tệp hỏng (backoff từng tệp tính riêng trong core: 2, 4, 8 … phút). */
export const ATTACHMENT_RETRY_INTERVAL_MS = 2 * 60_000;
/**
 * Một lượt chạy quá chừng này coi như treo (lệnh nào đó không bao giờ xong): báo nó ngừng nhận tin mới và cho lượt
 * mới chạy — một lượt treo không chặn mãi các lượt sau (chỉ hồi phục khi khởi động lại worker). Lượt bình thường
 * (50 tin, 3 song song, tải 30s + ghi kho 90s mỗi tệp) xong trong vài phút.
 */
export const ATTACHMENT_RETRY_MAX_RUN_MS = 15 * 60_000;
/** Lúc tắt worker: đợi lượt đang chạy tối đa chừng này. */
const STOP_MAX_WAIT_MS = 5_000;

export interface AttachmentRetryLoop {
  /** Một lượt quét; đang có lượt chạy (cùng tiến trình, chưa quá hạn) ⇒ bỏ qua, trả null. */
  run: () => Promise<AttachmentRetryResult | null>;
  /**
   * Dừng hẹn giờ, báo lượt đang chạy ngừng nhận tin mới và đợi nó xong (tối đa maxWaitMs — tin đang tải dở đã
   * được tính lượt, lần sau thử lại).
   */
  stop: (maxWaitMs?: number) => Promise<void>;
}

export interface AttachmentRetryLoopOptions {
  intervalMs?: number;
  maxRunMs?: number;
  retry?: typeof retryFailedAttachments;
}

interface RunningRun {
  promise: Promise<AttachmentRetryResult | null>;
  startedAt: number;
  controller: AbortController;
}

/**
 * Giống startBotOutboundSweeper: setInterval (unref), không chạy chồng trong một tiến trình; nhiều worker cùng chạy
 * thì core tự tránh trùng (khóa dòng SKIP LOCKED + "nhận lượt" ghi last_retry_at trước khi tải). Chạy ngay một lượt
 * lúc khởi động (không chặn). Chỉ log số lượng — không log nội dung tin, tên khách hay URL (URL CDN có token).
 * Lỗi chỉ log warn.
 */
export function startAttachmentRetry(
  db: Db,
  deps: AttachmentRetryDeps,
  logger: Pick<PipelineLogger, 'info' | 'warn' | 'debug'>,
  options: AttachmentRetryLoopOptions = {},
): AttachmentRetryLoop {
  const intervalMs = options.intervalMs ?? ATTACHMENT_RETRY_INTERVAL_MS;
  const maxRunMs = options.maxRunMs ?? ATTACHMENT_RETRY_MAX_RUN_MS;
  const retry = options.retry ?? retryFailedAttachments;
  let stopped = false;
  let current: RunningRun | null = null;

  const runOnce = async (signal: AbortSignal): Promise<AttachmentRetryResult | null> => {
    try {
      const result = await retry(db, deps, { signal });
      if (result.messages > 0 || result.stoppedOnStorageError) {
        logger.info({ ...result }, 'Tải lại tệp đính kèm hỏng');
      } else {
        logger.debug({ candidates: result.candidates }, 'Tải lại tệp đính kèm hỏng: không có gì');
      }
      return result;
    } catch (error) {
      logger.warn({ err: safeErrorMessage(error) }, 'Tải lại tệp đính kèm lỗi');
      return null;
    }
  };

  const run = (): Promise<AttachmentRetryResult | null> => {
    if (stopped) return Promise.resolve(null);
    if (current) {
      const runningMs = Date.now() - current.startedAt;
      if (runningMs < maxRunMs) return Promise.resolve(null);
      // Lượt cũ treo: bảo nó ngừng nhận tin mới, bỏ mặc nó (core an toàn khi chạy chồng nhờ khóa dòng).
      logger.warn({ runningMs }, 'Lượt tải lại tệp đính kèm chạy quá lâu, chạy lượt mới');
      current.controller.abort();
      current = null;
    }
    const controller = new AbortController();
    const entry: RunningRun = {
      startedAt: Date.now(),
      controller,
      promise: runOnce(controller.signal).finally(() => {
        if (current === entry) current = null;
      }),
    };
    current = entry;
    return entry.promise;
  };

  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  void run();

  return {
    run,
    stop: async (maxWaitMs = STOP_MAX_WAIT_MS) => {
      stopped = true;
      clearInterval(timer);
      const running = current;
      if (!running) return;
      running.controller.abort();
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        running.promise,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, maxWaitMs);
          timeout.unref();
        }),
      ]);
      clearTimeout(timeout);
    },
  };
}
