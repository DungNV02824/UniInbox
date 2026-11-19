import type { AiOutageResumeResponse, AiOutageStatus, AuthUser } from '@dezon/shared';
import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AiOutageService } from './ai-outage.service';

/**
 * Nút "Bật lại AI" — mọi nhân viên đã đăng nhập (JwtAuthGuard toàn cục, không @Roles). Bật công tắc AI chung (khi đang
 * tắt) chỉ admin — service kiểm (403).
 */
@Controller('ai')
export class AiOutageController {
  constructor(private readonly outage: AiOutageService) {}

  /** { aiEnabled, waiting, missed } cho banner / nút. */
  @Get('outage')
  status(): Promise<AiOutageStatus> {
    return this.outage.status();
  }

  /** 503 thiếu key; 409 không có gì để làm / AI vẫn lỗi; 403 công tắc tắt mà không phải admin. */
  @Post('outage/resume')
  @HttpCode(HttpStatus.OK)
  resume(@CurrentUser() user: AuthUser): Promise<AiOutageResumeResponse> {
    return this.outage.resume(user);
  }
}
