import {
  type AuthUser,
  type ChatbotDto,
  type ChatbotSummary,
  type ChatbotTestRequest,
  type ChatbotTestResult,
  chatbotTestMessagesSchema,
  chatbotTestSchema,
  type CreateChatbotRequest,
  createChatbotSchema,
  type UpdateChatbotRequest,
  updateChatbotSchema,
} from '@dezon/shared';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { UuidParam } from '../../common/params';
import { toViewer } from '../../common/viewer';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { type ChatbotModelsResponse, ChatbotModelsService } from './chatbot-models.service';
import { ChatbotTestService } from './chatbot-test.service';
import { type DeleteChatbotResponse, ChatbotsService } from './chatbots.service';

/**
 * POST /chatbots/test-draft: chạy thử bot chưa lưu (draft đầy đủ như khi tạo). Tin khách được kèm ảnh base64
 * như /chatbots/:id/test (body tới CHATBOT_TEST_BODY_LIMIT_BYTES — nới ở app.factory).
 */
const testDraftSchema = z.object({
  draft: createChatbotSchema,
  messages: chatbotTestMessagesSchema,
});
type TestDraftRequest = z.infer<typeof testDraftSchema>;

/** Chatbot AI: mọi nhân viên xem danh sách (ô chọn bot); admin tạo/sửa/xóa/chạy thử. */
@Controller('chatbots')
export class ChatbotsController {
  constructor(
    private readonly chatbots: ChatbotsService,
    private readonly tester: ChatbotTestService,
    private readonly models: ChatbotModelsService,
  ) {}

  /** Agent chỉ thấy bot đang bật; admin thấy cả bot tắt. */
  @Get()
  list(@CurrentUser() user: AuthUser): Promise<ChatbotSummary[]> {
    return this.chatbots.list(toViewer(user));
  }

  /** Model Gemini chọn được (cache 1 giờ; lỗi/thiếu key ⇒ chỉ GEMINI_MODEL). */
  @Roles('admin')
  @Get('models')
  listModels(): Promise<ChatbotModelsResponse> {
    return this.models.list();
  }

  @Roles('admin')
  @Post('test-draft')
  @HttpCode(HttpStatus.OK)
  testDraft(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(testDraftSchema)) body: TestDraftRequest,
  ): Promise<ChatbotTestResult> {
    return this.tester.testDraft(user.id, body.draft, body.messages);
  }

  @Roles('admin')
  @Get(':id')
  get(@UuidParam() id: string): Promise<ChatbotDto> {
    return this.chatbots.get(id);
  }

  @Roles('admin')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createChatbotSchema)) body: CreateChatbotRequest,
  ): Promise<ChatbotDto> {
    return this.chatbots.create(user.id, body);
  }

  @Roles('admin')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @UuidParam() id: string,
    @Body(new ZodValidationPipe(updateChatbotSchema)) body: UpdateChatbotRequest,
  ): Promise<ChatbotDto> {
    return this.chatbots.update(user.id, id, body);
  }

  /** Hội thoại đang gắn bot ⇒ gỡ bot (ai_mode 'off'), phát conversation.updated. */
  @Roles('admin')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: AuthUser, @UuidParam() id: string): Promise<DeleteChatbotResponse> {
    return this.chatbots.remove(user.id, id);
  }

  /**
   * "Chat thử" bot đã lưu (draft tùy chọn ghi đè các trường chưa lưu). Không gửi tin, không ghi DB. Tin khách
   * được kèm ảnh base64 (≤ CHATBOT_LIMITS.testImagesMax); body tới CHATBOT_TEST_BODY_LIMIT_BYTES.
   */
  @Roles('admin')
  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  test(
    @CurrentUser() user: AuthUser,
    @UuidParam() id: string,
    @Body(new ZodValidationPipe(chatbotTestSchema)) body: ChatbotTestRequest,
  ): Promise<ChatbotTestResult> {
    return this.tester.testSaved(user.id, id, body);
  }
}
