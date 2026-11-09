'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthUser, LoginRequest, UserRole } from '@dezon/shared';
import { api } from '@/lib/api';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: (input: LoginRequest) => Promise<AuthUser>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Quản trị viên',
  agent: 'Nhân viên',
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    const unsubscribe = api.subscribe((next) => {
      setUser(next);
      setStatus(next ? 'authenticated' : 'unauthenticated');
    });
    // Khôi phục phiên im lặng bằng cookie refresh (request đồng thời được gộp làm một).
    void api.restoreSession();
    return unsubscribe;
  }, []);

  const login = useCallback((input: LoginRequest) => api.login(input), []);
  const logout = useCallback(() => api.logout(), []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, logout }),
    [status, user, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth phải được dùng bên trong <AuthProvider>');
  return ctx;
}

/** Hiển thị children khi người dùng hiện tại có một trong các vai trò cho phép. */
export function RoleGate({ roles, children }: { roles: readonly UserRole[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) return null;
  return <>{children}</>;
}
