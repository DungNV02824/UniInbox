import type { MessageDto } from '@dezon/shared';

/**
 * Số tin của khách mới thêm vào cuối danh sách sau tin `prevLastId` (tin cuối lần trước).
 * Không tìm thấy tin cũ (đổi hội thoại, tải lại trang đầu) → 0 để không báo nhầm.
 */
export function countNewCustomerMessages(
  prevLastId: string | undefined,
  messages: readonly Pick<MessageDto, 'id' | 'senderType'>[],
): number {
  if (!prevLastId) return 0;
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.id === prevLastId) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return 0;
  return messages.slice(idx + 1).filter((m) => m.senderType === 'customer').length;
}
