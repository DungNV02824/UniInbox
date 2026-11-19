// Chữ hiển thị cho "Áp dụng chatbot mặc định cho hội thoại đang có" (trang Quản trị → Kênh).
import type { ApplyDefaultChatbotPreview, ApplyDefaultChatbotResult } from '@dezon/shared';
import { formatCount } from '@/lib/channels-admin';

/** Có nên mở hộp thoại hỏi áp dụng cho hội thoại cũ không (chỉ khi còn hội thoại dùng bot khác). */
export function shouldOfferApply(preview: ApplyDefaultChatbotPreview | null | undefined): boolean {
  return !!preview && preview.chatbotId !== null && preview.eligible > 0;
}

/** Toast sau khi đổi chatbot mặc định. `willOffer` = sắp mở hộp thoại hỏi về hội thoại cũ. */
export function defaultBotChangedToast(
  channelName: string,
  botName: string | null | undefined,
  botId: string | null,
  willOffer = false,
): { title: string; description?: string } {
  if (!botId) {
    return {
      title: 'Đã bỏ chatbot mặc định',
      description: 'Hội thoại cũ không đổi — bật/tắt bot từng hội thoại trong hộp thư.',
    };
  }
  const title = `Hội thoại mới của "${channelName}" sẽ dùng "${botName ?? 'bot'}"`;
  if (willOffer) return { title };
  return { title, description: 'Hội thoại cũ không đổi — bật/tắt bot từng hội thoại trong hộp thư.' };
}

/** Câu hỏi chính của hộp thoại. */
export function applyPromptText(
  channelName: string,
  botName: string | null | undefined,
  eligible: number,
): string {
  return `Trang "${channelName}" đang có ${formatCount(eligible)} hội thoại dùng chatbot khác. Đổi các hội thoại này sang "${botName ?? 'bot'}"?`;
}

/** "X hội thoại đang Cần người và Y hội thoại chưa gắn bot sẽ giữ nguyên." — bỏ phần bằng 0; null khi không bỏ qua gì. */
export function applySkippedText(
  preview: Pick<ApplyDefaultChatbotPreview, 'skippedPendingHuman' | 'skippedNoBot'>,
): string | null {
  const parts: string[] = [];
  if (preview.skippedPendingHuman > 0)
    parts.push(`${formatCount(preview.skippedPendingHuman)} hội thoại đang Cần người`);
  if (preview.skippedNoBot > 0) parts.push(`${formatCount(preview.skippedNoBot)} hội thoại chưa gắn bot`);
  if (parts.length === 0) return null;
  return `${parts.join(' và ')} sẽ giữ nguyên.`;
}

export const APPLY_SAFETY_NOTE = 'Bot đang tắt ở hội thoại nào vẫn giữ tắt. Không gửi tin nào cho khách.';

/** Nhãn nút xác nhận. */
export function applyButtonLabel(eligible: number): string {
  return `Áp dụng cho ${formatCount(eligible)} hội thoại`;
}

/** Toast sau khi áp dụng xong. */
export function applyResultToast(
  result: Pick<ApplyDefaultChatbotResult, 'updated' | 'skippedPendingHuman'>,
  botName: string | null | undefined,
): { title: string; description?: string } {
  const title = `Đã đổi ${formatCount(result.updated)} hội thoại sang "${botName ?? 'bot'}"`;
  if (result.skippedPendingHuman > 0) {
    return {
      title,
      description: `${formatCount(result.skippedPendingHuman)} hội thoại đang Cần người được giữ nguyên.`,
    };
  }
  return { title };
}
