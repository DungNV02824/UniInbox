import type { UserRole } from '@dezon/shared';
import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { HttpRequest } from '../../../common/http.types';
import { FORBIDDEN_MESSAGE } from '../auth.constants';
import { ROLES_KEY } from '../decorators/roles.decorator';

/** Kiểm tra @Roles(...). Chạy sau JwtAuthGuard nên request.user đã có. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;

    const user = context.switchToHttp().getRequest<HttpRequest>().user;
    if (!user || !roles.includes(user.role)) throw new ForbiddenException(FORBIDDEN_MESSAGE);
    return true;
  }
}
