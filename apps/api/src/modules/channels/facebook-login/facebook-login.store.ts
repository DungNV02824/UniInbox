// Lưu tạm trong Redis: state OAuth (10 phút, dùng 1 lần) và phiên chọn Trang (15 phút, Page token đã mã hóa).
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../../infra/redis/redis.constants';

export const FB_STATE_TTL_SEC = 10 * 60;
export const FB_SESSION_TTL_SEC = 15 * 60;

const stateKey = (state: string) => `fb-login:state:${state}`;
const sessionKey = (id: string) => `fb-login:session:${id}`;

export interface StoredFacebookPage {
  id: string;
  name: string;
  pictureUrl: string | null;
  tasks: string[] | null;
  /** Page Access Token mã hóa (AES-GCM, AAD gắn với phiên + page). */
  tokenEnc: string;
}

export interface StoredFacebookSession {
  userId: string;
  fbUser: { id: string; name: string };
  pages: StoredFacebookPage[];
  expiresAt: string;
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

@Injectable()
export class FacebookLoginStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async saveState(state: string, userId: string): Promise<void> {
    await this.redis.set(stateKey(state), JSON.stringify({ userId }), 'EX', FB_STATE_TTL_SEC);
  }

  /** Lấy và xóa ngay (GETDEL) => state chỉ dùng được một lần. */
  async consumeState(state: string): Promise<{ userId: string } | null> {
    const value = parse<{ userId?: unknown }>(await this.redis.getdel(stateKey(state)));
    return typeof value?.userId === 'string' ? { userId: value.userId } : null;
  }

  async saveSession(id: string, session: StoredFacebookSession): Promise<void> {
    await this.redis.set(sessionKey(id), JSON.stringify(session), 'EX', FB_SESSION_TTL_SEC);
  }

  getSession(id: string): Promise<StoredFacebookSession | null> {
    return this.redis.get(sessionKey(id)).then((raw) => parse<StoredFacebookSession>(raw));
  }

  /** true nếu chính lần gọi này xóa được phiên (chống dùng song song hai lần). */
  async deleteSession(id: string): Promise<boolean> {
    return (await this.redis.del(sessionKey(id))) === 1;
  }
}
