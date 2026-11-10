import {
  ChannelDeleteConflictError,
  ChatbotNameConflictError,
  ContactTagConflictError,
  InboxForbiddenError,
  InboxNotFoundError,
  InboxValidationError,
  LarkNotifyError,
  SendNotAllowedError,
} from '@dezon/core';
import { HttpStatus } from '@nestjs/common';

/** Lỗi nghiệp vụ của @dezon/core => mã HTTP. `message` của lỗi là tiếng Việt, trả thẳng cho client. */
export function domainErrorStatus(exception: unknown): number | null {
  if (exception instanceof InboxNotFoundError) return HttpStatus.NOT_FOUND;
  if (exception instanceof InboxForbiddenError) return HttpStatus.FORBIDDEN;
  if (exception instanceof SendNotAllowedError) return HttpStatus.UNPROCESSABLE_ENTITY;
  if (exception instanceof InboxValidationError) return HttpStatus.BAD_REQUEST;
  if (exception instanceof ChannelDeleteConflictError) return HttpStatus.CONFLICT;
  if (exception instanceof ChatbotNameConflictError) return HttpStatus.CONFLICT;
  if (exception instanceof ContactTagConflictError) return HttpStatus.CONFLICT;
  // Webhook Lark từ chối / không tới được: lỗi ở dịch vụ bên ngoài, thông điệp tiếng Việt không chứa secret.
  if (exception instanceof LarkNotifyError) return HttpStatus.BAD_GATEWAY;
  return null;
}
