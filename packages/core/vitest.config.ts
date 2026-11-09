import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Testcontainers cần thời gian kéo image và khởi động Postgres.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // Mỗi file test tích hợp dùng một container riêng; chạy tuần tự cho ổn định trên máy dev.
    fileParallelism: false,
  },
});
