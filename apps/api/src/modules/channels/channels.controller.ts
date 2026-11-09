import {
  connectMessengerPage,
  type CredentialsCipher,
  deleteChannel,
  disconnectChannel,
  listChannels,
  type MediaStorage,
  type MessengerGraphApi,
  updateChannel,
} from '@dezon/core';
import type { Db } from '@dezon/db';
import {
  type AuthUser,
  type ChannelAccountDto,
  type ConnectMessengerPageRequest,
  connectMessengerPageSchema,
  type DeleteChannelRequest,
  type DeleteChannelResult,
  deleteChannelSchema,
  type SyncChannelRequest,
  syncChannelSchema,
  type UpdateChannelRequest,
  updateChannelSchema,
} from '@dezon/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { UuidParam } from '../../common/params';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { DB } from '../../infra/db/db.constants';
import { CREDENTIALS_CIPHER } from '../../infra/inbox/inbox.constants';
import { MEDIA_STORAGE } from '../../infra/storage/storage.constants';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { MESSENGER_GRAPH_API } from '../connectors/messenger/messenger.constants';
import { ChannelSyncService } from './channel-sync.service';

/** Cho phép gọi không có body (= đồng bộ số ngày mặc định). */
const syncBodySchema = z.preprocess((v) => v ?? {}, syncChannelSchema);

/** Kênh: mọi nhân viên xem được (chip lọc); chỉ admin kết nối / sửa / ngắt kết nối / xóa. */
@Controller('channels')
export class ChannelsController {
  private readonly logger = new Logger(ChannelsController.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CREDENTIALS_CIPHER) private readonly cipher: CredentialsCipher,
    @Inject(MESSENGER_GRAPH_API) private readonly graph: MessengerGraphApi,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage | null,
    private readonly sync: ChannelSyncService,
  ) {}

  @Get()
  list(): Promise<ChannelAccountDto[]> {
    return listChannels(this.db);
  }

  @Roles('admin')
  @Post('messenger')
  @HttpCode(HttpStatus.CREATED)
  async connectMessenger(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(connectMessengerPageSchema)) body: ConnectMessengerPageRequest,
  ): Promise<ChannelAccountDto> {
    const channel = await connectMessengerPage(
      this.db,
      { graph: this.graph, cipher: this.cipher, actorUserId: user.id },
      body,
    );
    // Kết nối xong thì tự đồng bộ lịch sử (lỗi xếp lịch không làm hỏng kết nối).
    return this.sync.afterConnect(channel);
  }

  /** Đồng bộ lịch sử N ngày (mặc định MESSENGER_HISTORY_DAYS): 202, job chạy nền ở worker. */
  @Roles('admin')
  @Post(':id/sync')
  @HttpCode(HttpStatus.ACCEPTED)
  requestSync(
    @UuidParam() id: string,
    @Body(new ZodValidationPipe(syncBodySchema)) body: SyncChannelRequest,
  ): Promise<ChannelAccountDto> {
    return this.sync.requestBackfill(id, body.days);
  }

  @Roles('admin')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @UuidParam() id: string,
    @Body(new ZodValidationPipe(updateChannelSchema)) body: UpdateChannelRequest,
  ): Promise<ChannelAccountDto> {
    return updateChannel(this.db, { actorUserId: user.id }, id, body);
  }

  @Roles('admin')
  @Post(':id/disconnect')
  @HttpCode(HttpStatus.OK)
  disconnect(@CurrentUser() user: AuthUser, @UuidParam() id: string): Promise<ChannelAccountDto> {
    return disconnectChannel(this.db, { graph: this.graph, cipher: this.cipher, actorUserId: user.id }, id);
  }

  /**
   * Xóa hẳn kênh đã ngắt kết nối (hoặc hết hạn/lỗi) cùng hội thoại, tin nhắn, danh tính khách của kênh.
   * Body `{ confirmName }` phải trùng tên kênh. 409 nếu kênh đang kết nối, 400 nếu tên không khớp.
   */
  @Roles('admin')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @CurrentUser() user: AuthUser,
    @UuidParam() id: string,
    @Body(new ZodValidationPipe(deleteChannelSchema)) body: DeleteChannelRequest,
  ): Promise<DeleteChannelResult> {
    return deleteChannel(
      this.db,
      {
        storage: this.storage,
        actorUserId: user.id,
        logger: {
          info: (obj, msg) => this.logger.log(obj, msg),
          warn: (obj, msg) => this.logger.warn(obj, msg),
        },
      },
      id,
      body,
    );
  }
}
