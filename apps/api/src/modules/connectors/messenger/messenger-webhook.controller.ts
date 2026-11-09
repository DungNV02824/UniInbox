import {
  INBOUND_JOB_NAME,
  type InboundJobData,
  verifyMessengerChallenge,
  verifyMessengerSignature,
} from '@dezon/core';
import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import type { HttpReply, HttpRequest } from '../../../common/http.types';
import { withTimeout } from '../../../common/with-timeout';
import { ENQUEUE_TIMEOUT_MS, INBOUND_QUEUE } from '../../../infra/queue/queue.constants';
import { Public } from '../../auth/decorators/public.decorator';
import { MessengerConfigService } from './messenger-config.service';
import { WEBHOOK_ACK } from './messenger.constants';

/** Có rawBody nhờ NestFactory.create(..., { rawBody: true }). */
type WebhookRequest = HttpRequest & { rawBody?: Buffer; body?: unknown };

/** Khớp QUEUE_JOB_OPTIONS inbound của worker. */
const INBOUND_JOB_OPTIONS: JobsOptions = { attempts: 5, backoff: { type: 'exponential', delay: 2_000 } };

const isPageEvent = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && (body as { object?: unknown }).object === 'page';

/**
 * Webhook Messenger: chỉ kiểm chữ ký rồi đẩy job `inbound`, trả 200 ngay (< 1 giây, mục 6.1).
 * Không xử lý hay ghi log nội dung tin ở đây.
 */
@Public()
@Controller('webhooks/messenger')
export class MessengerWebhookController {
  constructor(
    private readonly meta: MessengerConfigService,
    @Inject(INBOUND_QUEUE) private readonly inbound: Queue<InboundJobData>,
  ) {}

  /** Meta xác minh URL webhook: trả lại hub.challenge dạng text/plain. */
  @Get()
  verify(@Query() query: Record<string, unknown>, @Res({ passthrough: true }) reply: HttpReply): string {
    const challenge = verifyMessengerChallenge(query, this.meta.verifyToken());
    if (challenge === null) throw new ForbiddenException('Xác minh webhook thất bại');
    reply.header('content-type', 'text/plain; charset=utf-8');
    return challenge;
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: WebhookRequest,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Res({ passthrough: true }) reply: HttpReply,
  ): Promise<string> {
    const secret = this.meta.appSecret();
    if (!request.rawBody || !verifyMessengerSignature(request.rawBody, signature, secret)) {
      throw new UnauthorizedException('Chữ ký webhook không hợp lệ');
    }
    reply.header('content-type', 'text/plain; charset=utf-8');
    if (!isPageEvent(request.body)) return WEBHOOK_ACK;

    const data: InboundJobData = {
      channelType: 'messenger',
      payload: request.body,
      receivedAt: new Date().toISOString(),
    };
    // Redis lỗi => ném lỗi => 500, Meta sẽ gửi lại.
    await withTimeout(
      this.inbound.add(INBOUND_JOB_NAME, data, INBOUND_JOB_OPTIONS),
      ENQUEUE_TIMEOUT_MS,
      'Đẩy job inbound',
    );
    return WEBHOOK_ACK;
  }
}
