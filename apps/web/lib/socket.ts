// Kết nối Socket.IO của hộp thư (hợp đồng: @dezon/shared/realtime). Không phụ thuộc React.
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { SOCKET_PATH, type ClientToServerEvents, type ServerToClientEvents } from '@dezon/shared';

export type InboxSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
export type SocketFactory = (url: string, opts: Partial<ManagerOptions & SocketOptions>) => InboxSocket;

export interface RealtimeOptions {
  url: string;
  /** Access token hiện tại (đọc lại ở MỖI lần bắt tay nên luôn dùng token mới nhất). */
  getToken: () => string | null;
  /** Xin token mới bằng cookie refresh; null = hết phiên. */
  refreshToken: () => Promise<string | null>;
  /** Lắng nghe thay đổi phiên (đăng nhập, refresh, đăng xuất). */
  subscribeSession: (listener: (user: unknown) => void) => () => void;
  handlers: Partial<ServerToClientEvents>;
  /**
   * Gọi MỖI lần bắt tay thành công (kể cả lần đầu): tải lại dữ liệu đã có để không sót tin phát ra
   * trước khi socket vào phòng (lần đầu) hoặc trong lúc rớt kết nối.
   */
  onResync: () => void;
  onStatusChange?: (connected: boolean) => void;
  createSocket?: SocketFactory;
}

const MAX_AUTH_RETRY_DELAY_MS = 30_000;

/**
 * Mở một kết nối socket và trả về hàm đóng.
 * - Token lấy qua callback `auth` nên mọi lần kết nối lại đều dùng token mới nhất; token được refresh
 *   trong lúc đang kết nối thì KHÔNG cắt kết nối (tránh hở tin), lần bắt tay sau tự dùng token mới.
 * - Máy chủ từ chối khi bắt tay (token hết hạn...) hoặc chủ động ngắt: socket.io không tự thử lại,
 *   nên ta refresh token rồi kết nối lại (lùi dần 0s, 2s, 4s... tối đa 30s).
 * - Lỗi mạng: socket.io tự kết nối lại; mỗi lần kết nối được (kể cả lần đầu) thì gọi onResync.
 */
export function startRealtime(opts: RealtimeOptions): () => void {
  const create: SocketFactory = opts.createSocket ?? ((url, o) => io(url, o) as InboxSocket);
  const socket = create(opts.url, {
    path: SOCKET_PATH,
    autoConnect: false,
    reconnectionDelayMax: 10_000,
    auth: (cb: (data: object) => void) => cb({ token: opts.getToken() ?? '' }),
  });

  let stopped = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (!stopped && !socket.active) socket.connect();
  };

  function recoverAuth(): void {
    if (stopped || retryTimer) return;
    const delay = attempt === 0 ? 0 : Math.min(MAX_AUTH_RETRY_DELAY_MS, 1000 * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(async () => {
      retryTimer = undefined;
      let token: string | null;
      try {
        token = await opts.refreshToken();
      } catch {
        // Lỗi mạng/5xx khi refresh: phiên vẫn còn, thử lại với token đang có.
        token = opts.getToken();
      }
      if (stopped || !token) return; // hết phiên: AuthProvider tự chuyển về trang đăng nhập
      connect();
    }, delay);
  }

  for (const [event, handler] of Object.entries(opts.handlers)) {
    if (handler) socket.on(event as keyof ServerToClientEvents, handler as never);
  }

  socket.on('connect', () => {
    attempt = 0;
    opts.onStatusChange?.(true);
    opts.onResync();
  });

  socket.on('disconnect', (reason) => {
    opts.onStatusChange?.(false);
    if (reason === 'io server disconnect') recoverAuth();
  });

  socket.on('connect_error', () => {
    opts.onStatusChange?.(false);
    // socket.active = false nghĩa là máy chủ từ chối (middleware xác thực) → không tự thử lại.
    if (!socket.active) recoverAuth();
  });

  const unsubscribe = opts.subscribeSession((user) => {
    if (!user) {
      socket.disconnect();
      return;
    }
    connect();
  });

  if (opts.getToken()) connect();
  else recoverAuth();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    unsubscribe();
    socket.removeAllListeners();
    socket.disconnect();
  };
}
