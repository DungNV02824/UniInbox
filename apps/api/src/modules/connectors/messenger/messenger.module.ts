import type { MessengerGraphApi, MessengerLoginApi } from '@dezon/core';
import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { createLazyGraphApi, createLazyLoginApi, MessengerConfigService } from './messenger-config.service';
import { MESSENGER_GRAPH_API, MESSENGER_LOGIN_API } from './messenger.constants';
import { MessengerWebhookController } from './messenger-webhook.controller';

@Global()
@Module({})
export class MessengerModule {
  /** `graph`, `login` (test): thay Graph API / Facebook Login thật. */
  static forRoot(graph?: MessengerGraphApi, login?: MessengerLoginApi): DynamicModule {
    const graphProvider: Provider = graph
      ? { provide: MESSENGER_GRAPH_API, useValue: graph }
      : { provide: MESSENGER_GRAPH_API, inject: [MessengerConfigService], useFactory: createLazyGraphApi };
    const loginProvider: Provider = login
      ? { provide: MESSENGER_LOGIN_API, useValue: login }
      : { provide: MESSENGER_LOGIN_API, inject: [MessengerConfigService], useFactory: createLazyLoginApi };
    return {
      module: MessengerModule,
      global: true,
      controllers: [MessengerWebhookController],
      providers: [MessengerConfigService, graphProvider, loginProvider],
      exports: [MESSENGER_GRAPH_API, MESSENGER_LOGIN_API, MessengerConfigService],
    };
  }
}
