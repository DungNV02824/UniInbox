import { Logger } from 'nestjs-pino';
import { createApp } from './app.factory';
import { APP_CONFIG, type AppConfig } from './config';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  app.enableShutdownHooks();
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  app.get(Logger).log(`API đang chạy tại http://localhost:${config.API_PORT}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  console.error('[api] Khởi động thất bại:', error);
  process.exit(1);
});
