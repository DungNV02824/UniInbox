import {
  type AuthUser,
  type LoginRequest,
  type LoginResponse,
  loginRequestSchema,
  REFRESH_TOKEN_COOKIE,
} from '@dezon/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import type { HttpReply, HttpRequest } from '../../common/http.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { APP_CONFIG, type AppConfig } from '../../config';
import { LOGIN_REQUIRED_MESSAGE } from './auth.constants';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { clearRefreshCookie, setRefreshCookie } from './refresh-cookie';
import { TokenService } from './token.service';

/** Client không phải trình duyệt có thể gửi refresh token trong body thay vì cookie. */
const refreshBodySchema = z.object({ refreshToken: z.string().min(1).max(4096).optional() }).optional();
type RefreshBody = z.infer<typeof refreshBodySchema>;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Res({ passthrough: true }) reply: HttpReply,
  ): Promise<LoginResponse> {
    const session = await this.auth.login(body);
    setRefreshCookie(reply, session.refreshToken, this.tokens.refreshTtlSeconds, this.config);
    return session.response;
  }

  /** Cấp access token mới và xoay vòng refresh token (cookie). */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: HttpRequest,
    @Body(new ZodValidationPipe(refreshBodySchema)) body: RefreshBody,
    @Res({ passthrough: true }) reply: HttpReply,
  ): Promise<LoginResponse> {
    const token = request.cookies?.[REFRESH_TOKEN_COOKIE] ?? body?.refreshToken;
    if (!token) throw new UnauthorizedException(LOGIN_REQUIRED_MESSAGE);
    try {
      const session = await this.auth.refresh(token);
      setRefreshCookie(reply, session.refreshToken, this.tokens.refreshTtlSeconds, this.config);
      return session.response;
    } catch (error) {
      // Chỉ xóa cookie khi token thật sự không hợp lệ; lỗi DB/hạ tầng tạm thời không làm mất phiên.
      if (error instanceof UnauthorizedException) clearRefreshCookie(reply, this.config);
      throw error;
    }
  }

  /** Public để vẫn đăng xuất được khi access token đã hết hạn. */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) reply: HttpReply): void {
    clearRefreshCookie(reply, this.config);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
