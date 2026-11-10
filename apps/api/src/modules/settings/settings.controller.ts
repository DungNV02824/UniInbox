import {
  type AiSettings,
  aiSettingsSchema,
  type AuthUser,
  type BusinessHours,
  businessHoursSchema,
  type LarkSettingsDto,
  type UpdateLarkSettingsRequest,
  updateLarkSettingsSchema,
} from '@dezon/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { SettingsService } from './settings.service';

/** Cài đặt chung — chỉ admin. Secret Lark không bao giờ trả ra (chỉ `hasSecret`). */
@Roles('admin')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('business-hours')
  getBusinessHours(): Promise<BusinessHours> {
    return this.settings.getBusinessHours();
  }

  @Put('business-hours')
  putBusinessHours(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(businessHoursSchema)) body: BusinessHours,
  ): Promise<BusinessHours> {
    return this.settings.putBusinessHours(user.id, body);
  }

  @Get('lark')
  getLark(): Promise<LarkSettingsDto> {
    return this.settings.getLark();
  }

  @Put('lark')
  putLark(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(updateLarkSettingsSchema)) body: UpdateLarkSettingsRequest,
  ): Promise<LarkSettingsDto> {
    return this.settings.putLark(user.id, body);
  }

  /** Gửi thẻ thử tới webhook Lark. 400 nếu chưa cấu hình, 502 nếu Lark từ chối. */
  @Post('lark/test')
  @HttpCode(HttpStatus.OK)
  testLark(): Promise<{ ok: true }> {
    return this.settings.testLark();
  }

  @Get('ai')
  getAi(): Promise<AiSettings> {
    return this.settings.getAi();
  }

  @Put('ai')
  putAi(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(aiSettingsSchema)) body: AiSettings,
  ): Promise<AiSettings> {
    return this.settings.putAi(user.id, body);
  }
}
