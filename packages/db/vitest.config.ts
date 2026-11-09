import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Testcontainers cần thời gian kéo image và khởi động Postgres.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // Các file test dùng chung một container mỗi file; chạy tuần tự cho ổn định trên máy dev.
    fileParallelism: false,
  },
});
