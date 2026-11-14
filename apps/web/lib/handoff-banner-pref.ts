// Ẩn/hiện banner "Cần người" trong khung chat: lựa chọn của người dùng, nhớ trên trình duyệt này (localStorage) và
// dùng chung cho mọi hội thoại. Kho thuần (không phụ thuộc React) để test; React đọc qua useSyncExternalStore.
import { useSyncExternalStore } from 'react';

export const HANDOFF_BANNER_COLLAPSED_KEY = 'dezon:handoff-banner-collapsed';

type Listener = () => void;

/** Kho nhỏ: giá trị trong bộ nhớ + đọc/ghi localStorage (bị chặn/không có ⇒ chỉ nhớ trong phiên). */
export function createHandoffBannerPref(storage: () => Storage | null) {
  let cached: boolean | null = null;
  const listeners = new Set<Listener>();

  function read(): boolean {
    if (cached !== null) return cached;
    try {
      cached = storage()?.getItem(HANDOFF_BANNER_COLLAPSED_KEY) === '1';
    } catch {
      cached = false;
    }
    return cached;
  }

  function set(collapsed: boolean): void {
    cached = collapsed;
    try {
      const s = storage();
      if (collapsed) s?.setItem(HANDOFF_BANNER_COLLAPSED_KEY, '1');
      else s?.removeItem(HANDOFF_BANNER_COLLAPSED_KEY);
    } catch {
      // bỏ qua: vẫn nhớ trong bộ nhớ của phiên
    }
    listeners.forEach((l) => l());
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { read, set, subscribe };
}

const pref = createHandoffBannerPref(() => (typeof window === 'undefined' ? null : window.localStorage));

/** [đang ẩn, đặt ẩn/hiện]. Server render luôn "hiện" (không đọc được localStorage). */
export function useHandoffBannerCollapsed(): [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(pref.subscribe, pref.read, () => false);
  return [collapsed, pref.set];
}
