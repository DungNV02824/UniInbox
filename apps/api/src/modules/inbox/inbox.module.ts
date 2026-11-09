import { Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller';
import { ConversationsController } from './conversations.controller';
import { InboxService } from './inbox.service';

@Module({ controllers: [ConversationsController, ContactsController], providers: [InboxService] })
export class InboxModule {}
