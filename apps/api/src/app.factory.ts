import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule, type AppOverrides } from './app.module';
import { BODY_TOO_LARGE_MESSAGE_KEY } from './common/all-exceptions.filter';
import { type AppConfig, loadAppConfig } from './config';
import {
  WEBHOOK_BODY_LIMIT_BYTES,
  WEBHOOK_PATH_PREFIX,
} from './modules/connectors/messenger/messenger.constants';
import {
  CHATBOT_TEST_BODY_LIMIT_BYTES,
  CHATBOT_TEST_BODY_TOO_LARGE_MESSAGE,
  CHATBOT_TEST_ROUTE_URLS,
} from './modules/chatbots/chatbot-test.constants';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter';

export type { AppOverrides } from './app.module';

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[\w-]{1,100}$/;

/** Dùng x-request-id từ proxy nếu hợp lệ, ngược lại sinh UUID. */
function genReqId(req: { headers: IncomingHttpHeaders }): string {
  const header = req.headers[REQUEST_ID_HEADER];
  return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
}

/**
 * Dựng app (đã init, sẵn sàng cho `app.inject()` trong test hoặc `listen()`).
 * Env được đọc + validate đúng một lần ở đây.
 */
export async function createApp(
  config: AppConfig = loadAppConfig(),
  overrides: AppOverrides = {},
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config, overrides),
    new FastifyAdapter({ trustProxy: true, requestIdHeader: false, genReqId }),
    // rawBody: webhook cần đúng byte gốc để kiểm chữ ký (req.rawBody).
    { bufferLogs: true, rawBody: true },
  );
  app.useLogger(app.get(Logger));
  // Socket.IO + Redis adapter: phải gắn TRƯỚC app.init().
  app.useWebSocketAdapter(new RedisIoAdapter(app, config));

  const fastify = app.getHttpAdapter().getInstance();
  // Webhook có thể gom nhiều sự kiện: nới giới hạn body riêng cho /webhooks/* (route khác giữ mặc định 1MB).
  // "Chat thử" kèm ảnh base64: nới riêng hai route chạy thử (xem CHATBOT_TEST_BODY_LIMIT_BYTES).
  fastify.addHook('onRoute', (route) => {
    if (route.url.startsWith(WEBHOOK_PATH_PREFIX)) route.bodyLimit = WEBHOOK_BODY_LIMIT_BYTES;
    if (CHATBOT_TEST_ROUTE_URLS.has(route.url)) {
      route.bodyLimit = CHATBOT_TEST_BODY_LIMIT_BYTES;
      route.config = Object.assign({}, route.config, {
        [BODY_TOO_LARGE_MESSAGE_KEY]: CHATBOT_TEST_BODY_TOO_LARGE_MESSAGE,
      });
    }
  });

  await app.register(fastifyHelmet);
  await app.register(fastifyCors, {
    // Trình duyệt gửi Origin không có dấu / cuối hay path: chỉ so khớp phần origin của APP_URL.
    origin: new URL(config.APP_URL).origin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.MEDIA_MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10, fieldSize: 10_000 },
  });

  // Trả request id cho client để đối chiếu log.
  fastify.addHook('onRequest', (request, reply, done) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });

  await app.init();
  await fastify.ready();
  return app;
}
