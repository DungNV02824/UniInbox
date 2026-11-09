'use client';

import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PublicConfig } from '@dezon/shared';
import { api } from '@/lib/api';

export type FeatureFlag = keyof PublicConfig;

/** Cấu hình công khai từ GET /config (cờ tính năng). */
export function useAppConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api.getConfig(),
    staleTime: 5 * 60 * 1000,
  });
}

/** true khi cờ đang bật. Khi chưa tải xong hoặc lỗi: coi như tắt (an toàn). */
export function useFeature(flag: FeatureFlag): boolean {
  const { data } = useAppConfig();
  return data?.[flag] === true;
}

/** Chỉ render children khi cờ tính năng bật. */
export function Feature({
  flag,
  children,
  fallback = null,
}: {
  flag: FeatureFlag;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return <>{useFeature(flag) ? children : fallback}</>;
}
