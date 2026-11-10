import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ContactConversationsBroadcaster } from './contact-conversations-broadcaster';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

@Global()
@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway, RealtimeService, ContactConversationsBroadcaster],
  exports: [RealtimeService, ContactConversationsBroadcaster],
})
export class RealtimeModule {}
