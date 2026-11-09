// Điểm vào apps/worker: nạp env, khởi động BullMQ worker, tắt êm khi nhận SIGINT/SIGTERM.
import { loadEnv, loadRootEnv, type Env } from '@dezon/shared/server';
import { startWorkerApp, type WorkerApp } from './app';
import { createLogger, type Logger } from './logger';
import { createPipelineRuntime, type PipelineRuntime } from './pipeline-runtime';
import { createProcessors } from './processors';

function readEnv(): Env {
  try {
    loadRootEnv();
    return loadEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const env = readEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });

  let runtime: PipelineRuntime | undefined;
  let app: WorkerApp;
  try {
    runtime = createPipelineRuntime(env, logger.child({ component: 'pipeline' }));
    const processors = createProcessors(runtime, {
      channelSync: {
        intervalSec: env.MESSENGER_SYNC_INTERVAL_SEC,
        historyDays: env.MESSENGER_HISTORY_DAYS,
      },
    });
    app = await startWorkerApp({ redisUrl: env.REDIS_URL, logger, processors });
  } catch (error) {
    logger.fatal({ err: error }, 'Không khởi động được worker');
    await runtime?.close();
    exitAfterFlush(logger, 1);
    return;
  }
  registerShutdown(app, runtime, logger);
}

function registerShutdown(app: WorkerApp, runtime: PipelineRuntime, logger: Logger): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Đang tắt worker...');
    app
      .close()
      .then(() => runtime.close())
      .then(() => {
        logger.info('Worker đã tắt');
        exitAfterFlush(logger, 0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Lỗi khi tắt worker');
        exitAfterFlush(logger, 1);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Đợi logger (có thể chạy transport ở worker thread) ghi xong rồi mới thoát. */
function exitAfterFlush(logger: Logger, code: number): void {
  logger.flush(() => process.exit(code));
  setTimeout(() => process.exit(code), 1_000).unref();
}

main().catch((error: unknown) => {
  console.error('Lỗi nghiêm trọng khi khởi động worker:', error);
  process.exit(1);
});
