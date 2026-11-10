import {
  type AuthUser,
  type ContactTagDto,
  type CreateContactTagRequest,
  createContactTagSchema,
  type DeleteContactTagResponse,
  type ReorderContactTagsRequest,
  reorderContactTagsSchema,
  type UpdateContactTagRequest,
  updateContactTagSchema,
} from '@dezon/shared';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { UuidParam } from '../../common/params';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ContactTagsService } from './contact-tags.service';

/** Danh sách nhãn khách hàng: mọi nhân viên xem (ô chọn nhãn); admin tạo/sửa/sắp xếp/xóa. */
@Controller('contact-tags')
export class ContactTagsController {
  constructor(private readonly tags: ContactTagsService) {}

  @Get()
  list(): Promise<ContactTagDto[]> {
    return this.tags.list();
  }

  @Roles('admin')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createContactTagSchema)) body: CreateContactTagRequest,
  ): Promise<ContactTagDto> {
    return this.tags.create(user.id, body);
  }

  /** Khai báo trước ':id' cho dễ đọc (khác method nên không đụng PATCH/DELETE ':id'). Trả danh sách mới. */
  @Roles('admin')
  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  reorder(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(reorderContactTagsSchema)) body: ReorderContactTagsRequest,
  ): Promise<ContactTagDto[]> {
    return this.tags.reorder(user.id, body.ids);
  }

  @Roles('admin')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @UuidParam() id: string,
    @Body(new ZodValidationPipe(updateContactTagSchema)) body: UpdateContactTagRequest,
  ): Promise<ContactTagDto> {
    return this.tags.update(user.id, id, body);
  }

  @Roles('admin')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: AuthUser, @UuidParam() id: string): Promise<DeleteContactTagResponse> {
    return this.tags.remove(user.id, id);
  }
}
