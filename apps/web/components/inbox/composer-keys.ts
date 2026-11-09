import { useSyncExternalStore } from 'react';

const COARSE_QUERY = '(pointer: coarse)';

/**
 * Enter có gửi tin không. Bàn phím điện thoại không có Shift+Enter nên trên màn hình cảm ứng
 * Enter luôn xuống dòng, gửi bằng nút Gửi. isComposing: đang gõ dấu bằng bộ gõ (IME) thì không gửi.
 */
export function enterSends(
  e: { key: string; shiftKey: boolean; isComposing: boolean },
  coarse: boolean,
): boolean {
  return !coarse && e.key === 'Enter' && !e.shiftKey && !e.isComposing;
}

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(COARSE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** true khi con trỏ chính là cảm ứng (điện thoại, máy tính bảng). Server render: false. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(COARSE_QUERY).matches,
    () => false,
  );
}
