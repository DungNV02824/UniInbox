import type { UserRole } from '@dezon/shared';
import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'auth:roles';

/** Chỉ cho phép các vai trò được liệt kê (kiểm tra bởi RolesGuard). */
export const Roles = (...roles: [UserRole, ...UserRole[]]) => SetMetadata(ROLES_KEY, roles);
