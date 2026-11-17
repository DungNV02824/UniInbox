import {
  type AiSettings,
  aiSettingsSchema,
  type AuthUser,
  type BusinessHours,
  businessHoursSchema,
  type CreateLarkGroupRequest,
  createLarkGroupSchema,
  type LarkGroupDto,
  type LarkSettingsDto,
  type UpdateLarkGroupRequest,
  updateLarkGroupSchema,
  type UpdateLarkSettingsRequest,
  updateLarkSettingsSchema,
} from '@dezon/shared';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, Put } from '@nestjs/common';
import { UuidParam } from '../../common/params';
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

  /** Nhóm Lark theo chatbot (theo tên). Secret không trả ra (chỉ `hasSecret`). */
  @Get('lark/groups')
  listLarkGroups(): Promise<LarkGroupDto[]> {
    return this.settings.listLarkGroups();
  }

  /** 400: quá số nhóm tối đa / chatbot không tồn tại. */
  @Post('lark/groups')
  createLarkGroup(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createLarkGroupSchema)) body: CreateLarkGroupRequest,
  ): Promise<LarkGroupDto> {
    return this.settings.createLarkGroup(user.id, body);
  }

  /** `secret`: bỏ qua = giữ, null/'' = xóa. `chatbotIds` có ⇒ thay toàn bộ. 404 nếu không có nhóm. */
  @Patch('lark/groups/:id')
  updateLarkGroup(
    @CurrentUser() user: AuthUser,
    @UuidParam() id: string,
    @Body(new ZodValidationPipe(updateLarkGroupSchema)) body: UpdateLarkGroupRequest,
  ): Promise<LarkGroupDto> {
    return this.settings.updateLarkGroup(user.id, id, body);
  }

  @Delete('lark/groups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteLarkGroup(@CurrentUser() user: AuthUser, @UuidParam() id: string): Promise<void> {
    return this.settings.deleteLarkGroup(user.id, id);
  }

  /** Gửi thẻ thử tới webhook của nhóm. 404 nếu không có nhóm, 502 nếu Lark từ chối. */
  @Post('lark/groups/:id/test')
  @HttpCode(HttpStatus.OK)
  testLarkGroup(@UuidParam() id: string): Promise<{ ok: true }> {
    return this.settings.testLarkGroup(id);
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
