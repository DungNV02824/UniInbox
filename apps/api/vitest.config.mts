import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC thay esbuild để sinh decorator metadata cho DI của NestJS.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.e2e.test.ts'],
    environment: 'node',
    // Testcontainers kéo image Docker lần đầu có thể chậm.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    // NODE_ENV=test => loadRootEnv() không đọc file .env ở gốc repo.
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  },
});
