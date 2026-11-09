import { Redis, type RedisOptions } from 'ioredis';

/**
 * Tạo kết nối Redis cho BullMQ.
 * BullMQ bắt buộc maxRetriesPerRequest = null (lệnh chặn BRPOPLPUSH/BZPOPMIN không được timeout).
 */
export function createRedisConnection(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Thử kết nối lại với độ trễ tăng dần, tối đa 5s.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    ...options,
  });
}

/** Đóng kết nối nhẹ nhàng; chưa/mất kết nối thì ngắt hẳn (QUIT lúc đó sẽ nằm chờ mãi trong hàng đợi offline). */
export async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status === 'end') return;
  if (redis.status !== 'ready') {
    redis.disconnect();
    return;
  }
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

/**
 * Chờ Redis trả lời PING trong `timeoutMs`. Với maxRetriesPerRequest = null, lệnh sẽ chờ vô hạn
 * khi Redis chưa lên, nên cần giới hạn để worker thoát với mã lỗi thay vì treo khi khởi động.
 */
export async function waitForRedis(redis: Redis, timeoutMs: number): Promise<void> {
  let lastError: Error | undefined;
  // Giữ lỗi kết nối gần nhất (tránh ioredis in "Unhandled error event" liên tục).
  const onError = (error: Error): void => {
    lastError = error;
  };
  redis.on('error', onError);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = lastError ? `: ${lastError.message}` : '';
      reject(new Error(`Không kết nối được Redis sau ${timeoutMs / 1000}s${reason}`));
    }, timeoutMs);
  });
  try {
    await Promise.race([redis.ping(), timeout]);
  } finally {
    clearTimeout(timer);
    redis.off('error', onError);
  }
}
