import { randomUUID } from 'node:crypto';
import { type AuthUser, durationToSeconds, USER_ROLES } from '@dezon/shared';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config';
import { JWT_ALGORITHM, JWT_ISSUER, SESSION_INVALID_MESSAGE } from './auth.constants';

const accessPayloadSchema = z.object({
  sub: z.uuid(),
  role: z.enum(USER_ROLES),
  typ: z.literal('access'),
});
const refreshPayloadSchema = z.object({
  sub: z.uuid(),
  typ: z.literal('refresh'),
});

export type AccessTokenPayload = z.infer<typeof accessPayloadSchema>;
export type RefreshTokenPayload = z.infer<typeof refreshPayloadSchema>;

/**
 * Ký/xác minh JWT. Access và refresh dùng secret khác nhau và claim `typ` khác nhau,
 * nên token loại này không bao giờ dùng được thay cho loại kia. Thuật toán cố định HS256.
 */
@Injectable()
export class TokenService {
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.accessTtlSeconds = durationToSeconds(config.JWT_ACCESS_TTL);
    this.refreshTtlSeconds = durationToSeconds(config.JWT_REFRESH_TTL);
  }

  signAccess(user: Pick<AuthUser, 'id' | 'role'>): Promise<string> {
    const payload: AccessTokenPayload = { sub: user.id, role: user.role, typ: 'access' };
    return this.sign(payload, this.config.JWT_SECRET, this.accessTtlSeconds);
  }

  signRefresh(userId: string): Promise<string> {
    const payload: RefreshTokenPayload = { sub: userId, typ: 'refresh' };
    return this.sign(payload, this.config.JWT_REFRESH_SECRET, this.refreshTtlSeconds);
  }

  verifyAccess(token: string): Promise<AccessTokenPayload> {
    return this.verify(token, this.config.JWT_SECRET, accessPayloadSchema);
  }

  verifyRefresh(token: string): Promise<RefreshTokenPayload> {
    return this.verify(token, this.config.JWT_REFRESH_SECRET, refreshPayloadSchema);
  }

  private sign(payload: object, secret: string, expiresIn: number): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret,
      expiresIn,
      algorithm: JWT_ALGORITHM,
      issuer: JWT_ISSUER,
      // jti ngẫu nhiên: hai token ký trong cùng một giây vẫn khác nhau.
      jwtid: randomUUID(),
    });
  }

  private async verify<T extends z.ZodType>(token: string, secret: string, schema: T): Promise<z.output<T>> {
    let decoded: unknown;
    try {
      decoded = await this.jwt.verifyAsync<object>(token, {
        secret,
        algorithms: [JWT_ALGORITHM],
        issuer: JWT_ISSUER,
      });
    } catch {
      throw new UnauthorizedException(SESSION_INVALID_MESSAGE);
    }
    const parsed = schema.safeParse(decoded);
    if (!parsed.success) throw new UnauthorizedException(SESSION_INVALID_MESSAGE);
    return parsed.data;
  }
}
