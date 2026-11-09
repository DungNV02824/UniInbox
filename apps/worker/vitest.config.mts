import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Test tích hợp kéo image Docker (Testcontainers) lần đầu có thể chậm.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    env: { NODE_ENV: 'test' },
  },
});
