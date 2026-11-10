'use client';

import { useEffect, useRef } from 'react';

export const UNSAVED_MESSAGE = 'Bạn có thay đổi chưa lưu. Rời trang và bỏ các thay đổi này?';

/**
 * Cảnh báo khi rời trang lúc còn thay đổi chưa lưu:
 * - tải lại/đóng tab: hộp thoại `beforeunload` của trình duyệt;
 * - bấm link nội bộ (thanh điều hướng, nút quay lại...): hỏi xác nhận trước khi Next chuyển trang.
 * Nút Back của trình duyệt chưa chặn được (App Router không có API chặn điều hướng).
 */
export function useUnsavedGuard(dirty: boolean, message = UNSAVED_MESSAGE) {
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    }
    // Pha capture ở window chạy trước onClick của <Link> (React lắng nghe ở root).
    function onClick(e: MouseEvent) {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download') || anchor.dataset.skipUnsavedGuard !== undefined) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('click', onClick, true);
    };
  }, [message]);
}
