import {
  type AiRunDto,
  type AuthUser,
  type ConversationSummary,
  type RejectHandoffRequest,
  rejectHandoffSchema,
  type SetConversationChatbotRequest,
  setConversationChatbotSchema,
} from '@dezon/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { UuidParam } from '../../common/params';
import { toViewer } from '../../common/viewer';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ConversationAiService } from './conversation-ai.service';

/** Các thao tác Chatbot AI trên hội thoại (quyền xem hội thoại do @dezon/core kiểm). */
@Controller('conversations')
export class ConversationAiController {
  constructor(private readonly ai: ConversationAiService) {}

  /** Bật một bot (ai_mode 'auto') hoặc tắt (chatbotId null). */
  @Patch(':id/chatbot')
  setChatbot(
    @CurrentUser() user: AuthUser,
    @UuidParam() id: string,
    @Body(new ZodValidationPipe(setConversationChatbotSchema)) body: SetConversationChatbotRequest,
  ): Promise<ConversationSummary> {
    return this.ai.setChatbot(toViewer(user), id, body.chatbotId);
  }

  /** "Tiếp tục AI": xóa tạm dừng sau khi nhân viên nhắn. */
  @Post(':id/ai/resume')
  @HttpCode(HttpStatus.OK)
  resume(@CurrentUser() user: AuthUser, @UuidParam() id: string): Promise<ConversationSummary> {
    return this.ai.resumeAi(toViewer(user), id);
  }

  /** "Nhận xử lý" yêu cầu chuyển người thật. */
  @Post(':id/handoff/ack')
  @HttpCode(HttpStatus.OK)
  ack(@CurrentUser() user: AuthUser, @UuidParam() id: string): Promise<ConversationSummary> {
    return this.ai.ackHandoff(toViewer(user), id);
  }

  /** "Đã xong, trả lại cho AI". */
  @Post(':id/handoff/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(@CurrentUser() user: AuthUser, @UuidParam() id: string): Promise<ConversationSummary> {
    return this.ai.resolveHandoff(toViewer(user), id);
  }

  /**
   * "Không đạt": nhân viên gõ lý do ⇒ AI (bot đang gắn) soạn 1–3 tin báo khách lần gửi chưa đạt và GỬI THẲNG.
   * Yêu cầu chuyển người giữ nguyên (không ack / resolve).
   */
  @Post(':id/handoff/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentUser() user: AuthUser,
    @UuidParam() id: string,
    @Body(new ZodValidationPipe(rejectHandoffSchema)) body: RejectHandoffRequest,
  ): Promise<ConversationSummary> {
    return this.ai.rejectHandoff(toViewer(user), id, body.reason);
  }

  /** "Nhật ký AI": 20 lần chạy gần nhất. */
  @Roles('admin')
  @Get(':id/ai-runs')
  aiRuns(@UuidParam() id: string): Promise<AiRunDto[]> {
    return this.ai.aiRuns(id);
  }
}
