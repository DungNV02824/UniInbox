import type { UserRole } from '@dezon/shared';
import type { UrlSigner } from '../media/types';
import type { PolicyOptions } from '../policy';

/** Người đang thao tác (lấy từ JWT). */
export interface Viewer {
  id: string;
  role: UserRole;
}

/** Phụ thuộc chung của phần đọc/ghi hộp thư. */
export interface InboxContext {
  signUrl: UrlSigner;
  now: () => Date;
  policy: PolicyOptions;
  /**
   * AI_PAUSE_AFTER_AGENT_MIN: nhân viên gửi tin (hệ thống hoặc echo Business Suite) vào hội thoại có
   * chatbot ⇒ ai_paused_until = now + số phút này (pauseAiAfterAgentMessage). Thiếu ⇒ 30.
   */
  aiPauseAfterAgentMin?: number;
}
