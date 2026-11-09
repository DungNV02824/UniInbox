import type { AuthUser, UserRole } from '@dezon/shared';
import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

const user = (role: UserRole): AuthUser => ({ id: 'u1', email: 'a@dezon.vn', name: 'A', role });

/** ExecutionContext giả với metadata @Roles gắn trên handler. */
function contextFor(roles: UserRole[] | undefined, requestUser?: AuthUser): ExecutionContext {
  const handler = () => undefined;
  if (roles) Reflect.defineMetadata(ROLES_KEY, roles, handler);
  class TestController {}
  return {
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({ getRequest: () => ({ user: requestUser }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('route không gắn @Roles => cho qua', () => {
    expect(guard.canActivate(contextFor(undefined, user('agent')))).toBe(true);
  });

  it('đúng vai trò => cho qua', () => {
    expect(guard.canActivate(contextFor(['admin'], user('admin')))).toBe(true);
    expect(guard.canActivate(contextFor(['admin', 'agent'], user('agent')))).toBe(true);
  });

  it('sai vai trò => 403', () => {
    expect(() => guard.canActivate(contextFor(['admin'], user('agent')))).toThrow(ForbiddenException);
  });

  it('chưa có user trên request => 403', () => {
    expect(() => guard.canActivate(contextFor(['admin']))).toThrow(ForbiddenException);
  });
});
