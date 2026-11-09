import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/** Bỏ qua JwtAuthGuard (mặc định mọi route đều cần đăng nhập). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
