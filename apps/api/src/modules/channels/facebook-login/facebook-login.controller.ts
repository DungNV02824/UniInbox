import {
  type AuthUser,
  type ConnectFacebookPagesRequest,
  type ConnectFacebookPagesResult,
  connectFacebookPagesSchema,
  type FacebookLoginSessionDto,
  type FacebookLoginStartResponse,
} from '@dezon/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import type { HttpReply } from '../../../common/http.types';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { type FacebookCallbackQuery, FacebookLoginService } from './facebook-login.service';

/** Kết nối Fanpage bằng Facebook Login: start → (facebook.com) → callback → chọn Trang → connect. */
@Controller('channels/messenger/oauth')
export class FacebookLoginController {
  constructor(private readonly service: FacebookLoginService) {}

  @Roles('admin')
  @Post('start')
  @HttpCode(HttpStatus.OK)
  start(@CurrentUser() user: AuthUser): Promise<FacebookLoginStartResponse> {
    return this.service.start(user.id);
  }

  /** Facebook chuyển trình duyệt về đây (không có JWT): xác thực bằng state dùng một lần. */
  @Public()
  @Get('callback')
  async callback(@Query() query: FacebookCallbackQuery, @Res() reply: HttpReply): Promise<void> {
    const location = await this.service.handleCallback(query);
    reply.status(HttpStatus.FOUND).header('location', location).header('cache-control', 'no-store').send();
  }

  @Roles('admin')
  @Get('sessions/:sessionId')
  session(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
  ): Promise<FacebookLoginSessionDto> {
    return this.service.getSession(user.id, sessionId);
  }

  @Roles('admin')
  @Post('sessions/:sessionId/connect')
  @HttpCode(HttpStatus.OK)
  connect(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(connectFacebookPagesSchema)) body: ConnectFacebookPagesRequest,
  ): Promise<ConnectFacebookPagesResult> {
    return this.service.connect(user.id, sessionId, body.pageIds);
  }
}
