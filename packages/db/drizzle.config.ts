import { loadRootEnv } from '@dezon/shared/server';
import { defineConfig } from 'drizzle-kit';

loadRootEnv();

// `generate` không cần kết nối DB; chỉ `migrate`/`studio`/`push` mới dùng url.
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
});
