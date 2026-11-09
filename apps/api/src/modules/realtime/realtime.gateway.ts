import {
  type AuthUser,
  type ClientToServerEvents,
  ROOM_ADMINS,
  ROOM_UNASSIGNED,
  type ServerToClientEvents,
  userRoom,
} from '@dezon/shared';
import { Logger } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { TokenService } from '../auth/token.service';

/** Lỗi handshake mà client (web) nhận diện để refresh token rồi nối lại. */
export const SOCKET_UNAUTHORIZED = 'unauthorized';

export interface SocketData {
  user: AuthUser;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- không dùng sự kiện giữa các server
type InterServerEvents = {};
export type RealtimeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
type RealtimeSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** Phòng của một nhân viên theo quyền xem (Giai đoạn 1A). */
export function roomsForUser(user: Pick<AuthUser, 'id' | 'role'>): string[] {
  return user.role === 'admin' ? [ROOM_ADMINS] : [userRoom(user.id), ROOM_UNASSIGNED];
}

/**
 * Socket.IO: xác thực access JWT lúc handshake (`auth.token`), sai => từ chối kết nối.
 * Client không gửi sự kiện nào; server tự cho socket vào phòng theo quyền.
 * Path/CORS do RedisIoAdapter đặt.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayInit<RealtimeServer>, OnGatewayConnection<RealtimeSocket> {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server?: RealtimeServer;

  constructor(
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
  ) {}

  afterInit(server: RealtimeServer): void {
    server.use((socket, next) => {
      this.authenticate(socket).then(
        (user) => {
          socket.data.user = user;
          next();
        },
        () => next(new Error(SOCKET_UNAUTHORIZED)),
      );
    });
  }

  async handleConnection(socket: RealtimeSocket): Promise<void> {
    const user = socket.data.user;
    if (!user) {
      socket.disconnect(true);
      return;
    }
    await socket.join(roomsForUser(user));
    this.logger.debug(`Socket ${socket.id} của user ${user.id} đã kết nối`);
  }

  private async authenticate(socket: RealtimeSocket): Promise<AuthUser> {
    const token: unknown = (socket.handshake.auth as Record<string, unknown> | undefined)?.token;
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
      throw new Error('Thiếu token');
    }
    const payload = await this.tokens.verifyAccess(token);
    const user = await this.auth.findActiveUser(payload.sub);
    if (!user) throw new Error('User không hoạt động');
    return user;
  }
}
