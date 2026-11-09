import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { HttpRequest } from '../../../common/http.types';
import { LOGIN_REQUIRED_MESSAGE, SESSION_INVALID_MESSAGE } from '../auth.constants';
import { AuthService } from '../auth.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { TokenService } from '../token.service';

/** Lấy token từ header `Authorization: Bearer <token>`. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return null;
  return token;
}

/**
 * Mặc định chặn: mọi route cần access token hợp lệ, trừ route gắn @Public().
 * User được tải lại từ DB mỗi request => khóa tài khoản / đổi vai trò có hiệu lực ngay.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException(LOGIN_REQUIRED_MESSAGE);

    const payload = await this.tokens.verifyAccess(token);
    const user = await this.auth.findActiveUser(payload.sub);
    if (!user) throw new UnauthorizedException(SESSION_INVALID_MESSAGE);
    request.user = user;
    return true;
  }
}
