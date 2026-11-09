import {
  type AuthUser,
  type ConversationDetail,
  type ConversationSummary,
  type ListConversationsQuery,
  listConversationsQuerySchema,
  type ListMessagesQuery,
  listMessagesQuerySchema,
  type MessageDto,
  type Page,
  type SendMessageRequest,
  sendMessageSchema,
  type UpdateConversationRequest,
  updateConversationSchema,
} from '@dezon/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Query } from '@nestjs/common';
import { UuidParam } from '../../common/params';
import { toViewer } from '../../common/viewer';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { InboxService } from './inbox.service';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listConversationsQuerySchema)) query: ListConversationsQuery,
  ): Promise<Page<ConversationSummary>> {
    return this.inbox.list(toViewer(user), query);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @UuidParam() id: string): Promise<ConversationDetail> {
    return this.inbox.detail(toViewer(user), id);
  }

  @Get(':id/messages')
  messages(
    @CurrentUser() user: AuthUser,
    @UuidParam() id: string,
    @Query(new ZodValidationPipe(listMessagesQuerySchema)) query: ListMessagesQuery,
  ): Promise<Page<MessageDto>> {
    return this.inbox.messages(toViewer(user), id, query);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  send(
    @CurrentUser() user: AuthUser,
    @UuidParam() id: string,
    @Body(new ZodValidationPipe(sendMessageSchema)) body: SendMessageRequest,
  ): Promise<{ messages: MessageDto[] }> {
    return this.inbox.send(toViewer(user), id, body);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(@CurrentUser() user: AuthUser, @UuidParam() id: string): Promise<ConversationSummary> {
    return this.inbox.markRead(toViewer(user), id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @UuidParam() id: string,
    @Body(new ZodValidationPipe(updateConversationSchema)) body: UpdateConversationRequest,
  ): Promise<ConversationSummary> {
    return this.inbox.update(toViewer(user), id, body);
  }
}
