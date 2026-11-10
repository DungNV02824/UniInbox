// Khởi tạo phụ thuộc của pipeline inbound/outbound cho worker: DB, S3, cipher, connector, realtime.
import {
  createMessengerConnector,
  createS3Storage,
  maybeScheduleChatbotReply,
  type ChannelConnector,
  type MediaStorage,
  type PipelineDeps,
  type RealtimePublisher,
} from '@dezon/core';
import { createDb, type Db } from '@dezon/db';
import type { ChannelType } from '@dezon/shared';
import { decryptJson, encryptJson, parseEncryptionKey, type Env } from '@dezon/shared/server';
import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';
import {
  createAiRuntime,
  createCustomerMessageHook,
  startBotOutboundSweeper,
  type AiRuntime,
} from './ai/runtime';
import { INBOUND_MAX_MEDIA_BYTES } from './config';
import type { Logger } from './logger';
import { closeRedis, createRedisConnection } from './redis';

export interface PipelineRuntime {
  db: Db;
  deps: PipelineDeps;
  /** Chatbot AI: deps cho job ai-reply; enabled = có GEMINI_API_KEY. */
  ai: AiRuntime;
  close: () => Promise<void>;
}

/** RealtimePublisher qua Redis: API (Socket.IO + redis-adapter cùng Redis) chuyển tới client. */
export function createRedisPublisher(redis: Redis): RealtimePublisher {
  const emitter = new Emitter(redis);
  return {
    emit(rooms, event, payload) {
      if (rooms.length === 0) return;
      emitter.to(rooms).emit(event, payload);
    },
  };
}

function createStorage(env: Env): MediaStorage {
  const { S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = env;
  if (!S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    throw new Error('Thiếu cấu hình S3 (S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY) cho worker');
  }
  return createS3Storage({
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    ...(env.S3_PUBLIC_ENDPOINT ? { publicEndpoint: env.S3_PUBLIC_ENDPOINT } : {}),
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    signedUrlTtlSec: env.MEDIA_SIGNED_URL_TTL_SEC,
  });
}

/** Chỉ tạo connector Messenger khi đủ META_APP_ID / META_APP_SECRET / META_GRAPH_VERSION. */
export function createConnectors(env: Env, logger: Logger): Partial<Record<ChannelType, ChannelConnector>> {
  const connectors: Partial<Record<ChannelType, ChannelConnector>> = {};
  if (env.META_APP_ID && env.META_APP_SECRET && env.META_GRAPH_VERSION) {
    connectors.messenger = createMessengerConnector({
      appId: env.META_APP_ID,
      appSecret: env.META_APP_SECRET,
      graphBaseUrl: env.META_GRAPH_BASE_URL,
      graphVersion: env.META_GRAPH_VERSION,
    });
  } else {
    logger.warn(
      'Thiếu META_APP_ID/META_APP_SECRET/META_GRAPH_VERSION: worker không xử lý được Messenger (tin đến, gửi tin, đồng bộ hội thoại tắt)',
    );
  }
  return connectors;
}

export function createPipelineRuntime(env: Env, logger: Logger): PipelineRuntime {
  const key = parseEncryptionKey(env.ENCRYPTION_KEY);
  const storage = createStorage(env);
  // Không có listener 'error', pool ném lỗi khi kết nối rảnh bị ngắt (Postgres restart) => worker chết.
  const handle = createDb(env.DATABASE_URL, {
    onError: (error) => logger.error({ err: error }, 'Lỗi kết nối Postgres'),
  });
  // Kết nối riêng cho emitter (chỉ PUBLISH).
  const redis = createRedisConnection(env.REDIS_URL, { connectionName: 'dezon-worker:realtime' });
  redis.on('error', (error) => logger.warn({ err: error }, 'Lỗi kết nối Redis (realtime)'));

  const deps: PipelineDeps = {
    connectors: createConnectors(env, logger),
    storage,
    cipher: {
      encryptJson: (value) => encryptJson(value, key),
      decryptJson: <T>(payload: string) => decryptJson<T>(payload, key),
    },
    publisher: createRedisPublisher(redis),
    ctx: {
      signUrl: (storageKey) => storage.signedUrl(storageKey),
      now: () => new Date(),
      policy: {
        metaHumanAgentEnabled: env.META_HUMAN_AGENT_ENABLED,
        zaloOaAllowPaidBot: env.ZALO_OA_ALLOW_PAID_BOT,
      },
      aiPauseAfterAgentMin: env.AI_PAUSE_AFTER_AGENT_MIN,
    },
    logger,
    maxMediaBytes: INBOUND_MAX_MEDIA_BYTES,
    ownAppIds: env.META_APP_ID ? { messenger: env.META_APP_ID } : {},
  };

  const ai = createAiRuntime(env, deps, logger.child({ component: 'ai' }));
  if (ai.enabled) {
    // Chỉ lên lịch khi có LLM: không có key thì không tạo job ai-reply thừa.
    deps.onCustomerMessageStored = createCustomerMessageHook(
      handle.db,
      ai.deps.redis,
      ai.deps.scheduler,
      logger,
      maybeScheduleChatbotReply,
      ai.deps,
    );
  }

  // Tin bot 'queued' bị bỏ rơi (worker chết giữa commit và enqueue) ⇒ xếp hàng lại định kỳ.
  const sweeper = startBotOutboundSweeper(handle.db, ai.deps.scheduler, logger.child({ component: 'ai' }));

  return {
    db: handle.db,
    deps,
    ai,
    close: async () => {
      sweeper.stop();
      await Promise.allSettled([handle.close(), closeRedis(redis), ai.close()]);
    },
  };
}
