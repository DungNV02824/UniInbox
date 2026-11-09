import { useEffect, useRef, type RefObject } from 'react';

/**
 * Đóng popover khi bấm ra ngoài (các phần tử trong `refs` được coi là "bên trong") hoặc nhấn Esc.
 * `onClose(true)` khi đóng bằng Esc để nơi gọi trả focus về nút mở.
 */
export function useDismiss(
  open: boolean,
  onClose: (byKeyboard: boolean) => void,
  refs: readonly RefObject<HTMLElement | null>[],
) {
  const latest = useRef({ onClose, refs });
  useEffect(() => {
    latest.current = { onClose, refs };
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && latest.current.refs.some((r) => r.current?.contains(target))) return;
      latest.current.onClose(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        latest.current.onClose(true);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
}
