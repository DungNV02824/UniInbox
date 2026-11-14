import { describe, expect, it, vi } from 'vitest';
import { HANDOFF_BANNER_COLLAPSED_KEY, createHandoffBannerPref } from './handoff-banner-pref';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe('ẩn/hiện banner "Cần người"', () => {
  it('mặc định hiện; ẩn ⇒ lưu "1", hiện lại ⇒ xóa khóa; báo người nghe', () => {
    const storage = memoryStorage();
    const pref = createHandoffBannerPref(() => storage);
    const listener = vi.fn();
    pref.subscribe(listener);
    expect(pref.read()).toBe(false);
    pref.set(true);
    expect(pref.read()).toBe(true);
    expect(storage.getItem(HANDOFF_BANNER_COLLAPSED_KEY)).toBe('1');
    pref.set(false);
    expect(storage.getItem(HANDOFF_BANNER_COLLAPSED_KEY)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('đọc lại lựa chọn đã lưu (tải lại trang)', () => {
    const storage = memoryStorage();
    storage.setItem(HANDOFF_BANNER_COLLAPSED_KEY, '1');
    expect(createHandoffBannerPref(() => storage).read()).toBe(true);
  });

  it('localStorage bị chặn ⇒ không lỗi, vẫn nhớ trong phiên', () => {
    const blocked = () => {
      throw new Error('SecurityError');
    };
    const pref = createHandoffBannerPref(blocked as () => Storage);
    expect(pref.read()).toBe(false);
    pref.set(true);
    expect(pref.read()).toBe(true);
  });
});
