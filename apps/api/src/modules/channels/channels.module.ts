import { Module } from '@nestjs/common';
import { ChannelSyncService } from './channel-sync.service';
import { ChannelsController } from './channels.controller';
import { FacebookLoginController } from './facebook-login/facebook-login.controller';
import { FacebookLoginService } from './facebook-login/facebook-login.service';
import { FacebookLoginStore } from './facebook-login/facebook-login.store';

@Module({
  controllers: [ChannelsController, FacebookLoginController],
  providers: [ChannelSyncService, FacebookLoginService, FacebookLoginStore],
})
export class ChannelsModule {}
