// Send API `sender_action` (typing_on / typing_off / mark_seen): chỉ báo "đang soạn tin" trên Messenger của khách.
// Gọi giống hệt gửi tin (POST /{page}/messages, token ở header Authorization), nhưng body chỉ có recipient +
// sender_action — KHÔNG kèm message/messaging_type/tag. Phản hồi thật là `{ recipient_id }` (không có message_id).
import type { ChannelRecipient, ResolvedChannelAccount, SenderAction } from '../types';
import type { MessengerConfig } from './config';
import { mapSendError, networkSendError } from './errors';
import { GraphNetworkError, graphRequest, type GraphResponse } from './graph';
import { pageTokenOf } from './send';

/** Việc phụ: chờ ngắn, không thử lại (caller nuốt lỗi). */
export const SENDER_ACTION_TIMEOUT_MS = 3_000;

export async function sendMessengerSenderAction(
  config: MessengerConfig,
  account: ResolvedChannelAccount,
  to: ChannelRecipient,
  action: SenderAction,
): Promise<void> {
  const token = pageTokenOf(account);
  let res: GraphResponse;
  try {
    res = await graphRequest(config, {
      method: 'POST',
      path: `${account.externalId}/messages`,
      token,
      body: { recipient: { id: to.externalUserId }, sender_action: action },
      timeoutMs: SENDER_ACTION_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof GraphNetworkError) throw networkSendError(err.timeout);
    throw err;
  }
  if (!res.ok) throw mapSendError(res.status, res.error);
}
