import { Module } from '@nestjs/common';
import { AiOutageController } from './ai-outage.controller';
import { AiOutageService } from './ai-outage.service';
import { ChatbotModelsService } from './chatbot-models.service';
import { ChatbotReengageService } from './chatbot-reengage.service';
import { ChatbotTestService } from './chatbot-test.service';
import { ChatbotsController } from './chatbots.controller';
import { ChatbotsService } from './chatbots.service';
import { ConversationAiController } from './conversation-ai.controller';
import { ConversationAiService } from './conversation-ai.service';

/** Chatbot AI: CRUD bot, chạy thử, danh sách model, tái chăm sóc khách bị bỏ sót, bot/handoff trên hội thoại, nút "Bật lại AI". */
@Module({
  controllers: [ChatbotsController, ConversationAiController, AiOutageController],
  providers: [
    ChatbotsService,
    ChatbotTestService,
    ChatbotModelsService,
    ConversationAiService,
    ChatbotReengageService,
    AiOutageService,
  ],
})
export class ChatbotsModule {}
