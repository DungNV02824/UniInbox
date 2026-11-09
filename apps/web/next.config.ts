import { resolve } from 'node:path';
import type { NextConfig } from 'next';
import { loadRootEnv } from '@dezon/shared/server';

// Nạp <repo>/.env (nếu có, không ghi đè biến đã có) để NEXT_PUBLIC_* được biết lúc build/dev.
loadRootEnv();

const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // Cho file tracing của standalone thấy cả monorepo (packages/shared).
  outputFileTracingRoot: resolve(__dirname, '../..'),
  // Inline giá trị (kể cả mặc định) vào bundle trình duyệt lúc build.
  env: {
    NEXT_PUBLIC_API_URL: apiUrl,
  },
};

export default nextConfig;
