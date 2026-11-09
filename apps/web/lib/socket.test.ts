import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRealtime, type InboxSocket, type SocketFactory } from './socket';

/** Socket giả: ghi lại handler, mô phỏng connect/active như socket.io-client. */
class FakeSocket {
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  active = false;
  connected = false;
  connectCalls = 0;
  authTokens: string[] = [];
  constructor(readonly opts: { auth: (cb: (d: { token: string }) => void) => void }) {}
  on(event: string, fn: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
  connect() {
    this.connectCalls += 1;
    this.active = true;
    this.opts.auth((d) => this.authTokens.push(d.token));
    return this;
  }
  disconnect() {
    this.active = false;
    this.connected = false;
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  /** Bắt tay thành công. */
  accept() {
    this.connected = true;
    this.emit('connect');
  }
  /** Máy chủ từ chối khi bắt tay (middleware) → socket ngừng hẳn. */
  reject() {
    this.active = false;
    this.emit('connect_error', new Error('unauthorized'));
  }
}

function setup(
  token: { value: string | null },
  refresh = vi.fn(async (): Promise<string | null> => 'new-token'),
) {
  let fake!: FakeSocket;
  const factory: SocketFactory = (_url, opts) => {
    fake = new FakeSocket(opts as never);
    return fake as unknown as InboxSocket;
  };
  let sessionListener: (user: unknown) => void = () => {};
  const onResync = vi.fn();
  const onCreated = vi.fn();
  const stop = startRealtime({
    url: 'http://api.test',
    getToken: () => token.value,
    refreshToken: refresh,
    subscribeSession: (l) => {
      sessionListener = l;
      return () => {};
    },
    handlers: { 'message.created': onCreated },
    onResync,
    createSocket: factory,
  });
  return { fake, stop, onResync, onCreated, refresh, session: (u: unknown) => sessionListener(u) };
}

describe('startRealtime', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('kết nối ngay bằng access token hiện tại và chuyển sự kiện tới handler', () => {
    const { fake, onCreated } = setup({ value: 't1' });
    expect(fake.connectCalls).toBe(1);
    expect(fake.authTokens).toEqual(['t1']);
    fake.accept();
    fake.emit('message.created', { x: 1 });
    expect(onCreated).toHaveBeenCalledWith({ x: 1 });
  });

  it('bị từ chối khi bắt tay (token hết hạn) → refresh rồi kết nối lại với token mới', async () => {
    const token = { value: 'old' as string | null };
    const refresh = vi.fn(async () => {
      token.value = 'new';
      return 'new';
    });
    const { fake } = setup(token, refresh);
    fake.reject();
    await vi.runOnlyPendingTimersAsync();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fake.authTokens).toEqual(['old', 'new']);
  });

  it('refresh trả null (hết phiên) → không kết nối lại', async () => {
    const { fake } = setup(
      { value: 'old' },
      vi.fn(async () => null),
    );
    fake.reject();
    await vi.runOnlyPendingTimersAsync();
    expect(fake.connectCalls).toBe(1);
  });

  it('gọi onResync ở lần kết nối đầu (sự kiện trước khi vào phòng) và mỗi lần nối lại sau khi rớt mạng', () => {
    const { fake, onResync } = setup({ value: 't' });
    expect(onResync).not.toHaveBeenCalled();
    fake.accept();
    expect(onResync).toHaveBeenCalledTimes(1);
    fake.emit('disconnect', 'transport close');
    fake.accept();
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it('đăng xuất → ngắt; refresh token khi đang kết nối → không cắt kết nối', () => {
    const { fake, session } = setup({ value: 't' });
    fake.accept();
    session({ id: 'u' });
    expect(fake.connectCalls).toBe(1);
    session(null);
    expect(fake.active).toBe(false);
    session({ id: 'u' });
    expect(fake.connectCalls).toBe(2);
  });

  it('lùi dần khi bị từ chối liên tiếp', async () => {
    const refresh = vi.fn(async () => 'x');
    const { fake } = setup({ value: 'x' }, refresh);
    fake.reject();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    fake.reject();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('dừng: gỡ listener, ngắt socket, hủy hẹn giờ', async () => {
    const refresh = vi.fn(async () => 'x');
    const { fake, stop } = setup({ value: 'x' }, refresh);
    fake.reject();
    stop();
    await vi.runOnlyPendingTimersAsync();
    expect(refresh).not.toHaveBeenCalled();
    expect(fake.active).toBe(false);
    expect(fake.handlers.size).toBe(0);
  });
});
