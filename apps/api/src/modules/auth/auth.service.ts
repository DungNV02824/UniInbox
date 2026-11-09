import { randomUUID } from 'node:crypto';
import { type Db, hashPassword, users, verifyPassword } from '@dezon/db';
import type { AuthUser, LoginRequest, LoginResponse } from '@dezon/shared';
import { Inject, Injectable, type OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB } from '../../infra/db/db.constants';
import { INVALID_CREDENTIALS_MESSAGE, SESSION_INVALID_MESSAGE } from './auth.constants';
import { TokenService } from './token.service';

/** Kết quả đăng nhập/refresh: body trả về + refresh token (đặt vào cookie). */
export interface IssuedSession {
  response: LoginResponse;
  refreshToken: string;
}

const authUserColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  isActive: users.isActive,
};

@Injectable()
export class AuthService implements OnModuleInit {
  /** Hash giả để verify khi email không tồn tại => thời gian phản hồi tương đương. */
  private dummyHash = '';

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokens: TokenService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await hashPassword(randomUUID());
  }

  async login(input: LoginRequest): Promise<IssuedSession> {
    const [user] = await this.db
      .select({ ...authUserColumns, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);

    if (!user) {
      await verifyPassword(this.dummyHash, input.password);
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }
    const passwordOk = await verifyPassword(user.passwordHash, input.password);
    if (!passwordOk || !user.isActive) throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    return this.issue(toAuthUser(user));
  }

  async refresh(refreshToken: string): Promise<IssuedSession> {
    const payload = await this.tokens.verifyRefresh(refreshToken);
    const user = await this.findActiveUser(payload.sub);
    if (!user) throw new UnauthorizedException(SESSION_INVALID_MESSAGE);
    return this.issue(user);
  }

  /** User còn tồn tại và đang hoạt động (role lấy mới từ DB), ngược lại null. */
  async findActiveUser(id: string): Promise<AuthUser | null> {
    const [user] = await this.db.select(authUserColumns).from(users).where(eq(users.id, id)).limit(1);
    return user?.isActive ? toAuthUser(user) : null;
  }

  private async issue(user: AuthUser): Promise<IssuedSession> {
    const [accessToken, refreshToken] = await Promise.all([
      this.tokens.signAccess(user),
      this.tokens.signRefresh(user.id),
    ]);
    return {
      response: { accessToken, accessTokenExpiresIn: this.tokens.accessTtlSeconds, user },
      refreshToken,
    };
  }
}

function toAuthUser(row: AuthUser): AuthUser {
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}
