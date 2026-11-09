import { z } from 'zod';
import { USER_ROLES } from './enums';

/** Tên cookie httpOnly chứa refresh token. */
export const REFRESH_TOKEN_COOKIE = 'dz_refresh';

export const loginRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ message: 'Email không hợp lệ' }).max(254)),
  password: z.string().min(1, 'Vui lòng nhập mật khẩu').max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authUserSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  name: z.string(),
  role: z.enum(USER_ROLES),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string().min(1),
  /** Thời hạn access token, tính bằng giây */
  accessTokenExpiresIn: z.number().int().positive(),
  user: authUserSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshResponseSchema = loginResponseSchema;
export type RefreshResponse = LoginResponse;
