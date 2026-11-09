import type { AuthUser } from '@dezon/shared';
import { createParamDecorator, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { HttpRequest } from '../../../common/http.types';

/** User đã đăng nhập (do JwtAuthGuard gắn vào request). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<HttpRequest>().user;
  if (!user) throw new UnauthorizedException('Vui lòng đăng nhập');
  return user;
});
