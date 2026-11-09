'use client';

import { useEffect, useState } from 'react';

/** Thời điểm hiện tại (ms), tự cập nhật sau mỗi `intervalMs` để đồng hồ/giờ tương đối chạy. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** true khi tab đang hiển thị (dùng để chỉ đánh dấu đã đọc khi nhân viên thật sự nhìn thấy). */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}
