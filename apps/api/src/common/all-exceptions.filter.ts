import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { domainErrorStatus } from './domain-errors';
import { redactUrl } from './logger';
import type { HttpReply, HttpRequest } from './http.types';
import type { ValidationIssue } from './zod-validation.pipe';

/** Định dạng lỗi thống nhất trả về client. Không bao giờ chứa stack trace. */
export interface ErrorBody {
  statusCode: number;
  message: string;
  errors?: ValidationIssue[];
}

const INTERNAL_MESSAGE = 'Lỗi hệ thống, vui lòng thử lại sau';

/**
 * Fastify từ chối body vượt bodyLimit của route (413, FST_ERR_CTP_BODY_TOO_LARGE). Nest bọc lỗi này thành
 * HttpException(413) giữ nguyên câu tiếng Anh của Fastify ⇒ nhận ra theo câu đó (hoặc theo `code` nếu lỗi
 * Fastify tới thẳng) rồi thay bằng tiếng Việt.
 */
const BODY_TOO_LARGE_CODE = 'FST_ERR_CTP_BODY_TOO_LARGE';
const FASTIFY_BODY_TOO_LARGE_TEXT = 'Request body is too large';
const BODY_TOO_LARGE_MESSAGE = 'Dữ liệu gửi lên quá lớn';
/**
 * Khóa trong route config (Fastify) chứa thông điệp 413 riêng của route — gắn ở hook onRoute (app.factory),
 * vd. "Chat thử" kèm ảnh. Không có ⇒ BODY_TOO_LARGE_MESSAGE.
 */
export const BODY_TOO_LARGE_MESSAGE_KEY = 'bodyTooLargeMessage';

function bodyTooLargeMessage(request: HttpRequest): string {
  const config = (request as { routeOptions?: { config?: Record<string, unknown> } }).routeOptions?.config;
  const custom = config?.[BODY_TOO_LARGE_MESSAGE_KEY];
  return typeof custom === 'string' ? custom : BODY_TOO_LARGE_MESSAGE;
}

function isBodyTooLarge(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) return false;
  if ((exception as { code?: unknown }).code === BODY_TOO_LARGE_CODE) return true;
  return (
    exception instanceof HttpException &&
    exception.getStatus() === HttpStatus.PAYLOAD_TOO_LARGE &&
    exception.getResponse() === FASTIFY_BODY_TOO_LARGE_TEXT
  );
}

function fromHttpException(exception: HttpException): ErrorBody {
  const statusCode = exception.getStatus();
  const response = exception.getResponse();
  if (typeof response === 'string') return { statusCode, message: response };
  const { message, errors } = response as { message?: unknown; errors?: unknown };
  const text = Array.isArray(message)
    ? message.join('; ')
    : typeof message === 'string'
      ? message
      : exception.message;
  return Array.isArray(errors)
    ? { statusCode, message: text, errors: errors as ValidationIssue[] }
    : { statusCode, message: text };
}

/** Lỗi của chính Fastify (JSON hỏng, sai content-type...) có `statusCode` 4xx. */
function clientErrorStatus(exception: unknown): number | null {
  if (typeof exception !== 'object' || exception === null) return null;
  const status = (exception as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    // Filter toàn cục cũng nhận lỗi từ gateway WebSocket: chỉ ghi log (không có reply HTTP).
    if (host.getType() !== 'http') {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error({ err }, 'Lỗi không xử lý được (ws)');
      return;
    }
    const http = host.switchToHttp();
    const reply = http.getResponse<HttpReply>();
    const request = http.getRequest<HttpRequest>();
    const body = this.toBody(exception, request);
    reply.status(body.statusCode).send(body);
  }

  private toBody(exception: unknown, request: HttpRequest): ErrorBody {
    if (isBodyTooLarge(exception)) {
      return { statusCode: HttpStatus.PAYLOAD_TOO_LARGE, message: bodyTooLargeMessage(request) };
    }
    if (exception instanceof HttpException) {
      const body = fromHttpException(exception);
      if (body.statusCode >= 500) this.logError(exception, request);
      return body;
    }
    const domainStatus = domainErrorStatus(exception);
    if (domainStatus !== null && exception instanceof Error) {
      return { statusCode: domainStatus, message: exception.message };
    }
    const status = clientErrorStatus(exception);
    if (status !== null) {
      const message = exception instanceof Error ? exception.message : 'Yêu cầu không hợp lệ';
      return { statusCode: status, message };
    }
    this.logError(exception, request);
    return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: INTERNAL_MESSAGE };
  }

  private logError(exception: unknown, request: HttpRequest): void {
    const err = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error({ err, method: request.method, url: redactUrl(request.url) }, 'Lỗi không xử lý được');
  }
}
