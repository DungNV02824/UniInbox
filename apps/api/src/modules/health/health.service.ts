import type { Db } from '@dezon/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { withTimeout } from '../../common/with-timeout';
import { DB } from '../../infra/db/db.constants';
import { REDIS } from '../../infra/redis/redis.constants';

export type CheckStatus = 'up' | 'down';

export interface HealthResult {
  status: 'ok' | 'error';
  checks: { db: CheckStatus; redis: CheckStatus };
}

const CHECK_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthResult> {
    const [db, redis] = await Promise.all([
      this.probe('db', () => this.db.execute(sql`select 1`)),
      this.probe('redis', () => this.redis.ping()),
    ]);
    return { status: db === 'up' && redis === 'up' ? 'ok' : 'error', checks: { db, redis } };
  }

  private async probe(name: string, fn: () => Promise<unknown>): Promise<CheckStatus> {
    try {
      await withTimeout(fn(), CHECK_TIMEOUT_MS, name);
      return 'up';
    } catch (error) {
      this.logger.warn(`Healthcheck ${name} lỗi: ${error instanceof Error ? error.message : String(error)}`);
      return 'down';
    }
  }
}
