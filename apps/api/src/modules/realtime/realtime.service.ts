import type { RealtimePublisher } from '@dezon/core';
import type { ServerToClientEvents } from '@dezon/shared';
import { Injectable, Logger } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

/** Phát sự kiện tới các phòng (qua Redis adapter nên tới cả client nối vào instance khác). */
@Injectable()
export class RealtimeService implements RealtimePublisher {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(private readonly gateway: RealtimeGateway) {}

  emit<E extends keyof ServerToClientEvents>(
    rooms: string[],
    event: E,
    payload: Parameters<ServerToClientEvents[E]>[0],
  ): void {
    const server = this.gateway.server;
    if (!server || rooms.length === 0) return;
    try {
      // Kiểu tổng quát của socket.io không suy được từ E => ép kiểu ở đây (đã kiểm ở chữ ký hàm).
      (server.to(rooms).emit as (ev: string, data: unknown) => boolean)(event, payload);
    } catch (error) {
      // Lỗi phát realtime không được làm hỏng request.
      this.logger.warn(
        `Phát sự kiện ${event} lỗi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
