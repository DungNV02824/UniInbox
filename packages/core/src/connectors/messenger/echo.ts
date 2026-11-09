// Phân loại tin echo theo message.app_id (docs/research/messenger-platform.md §10).

/**
 * app_id của Hộp thư Page / Meta Business Suite và Hộp thư Instagram (Conversation Routing).
 * Thêm '26390203743090' (14 chữ số) vì trang tài liệu message_echoes in thiếu số 0 cuối — chấp nhận cả hai.
 */
export const PAGE_INBOX_APP_IDS: readonly string[] = [
  '263902037430900',
  '1217981644879628',
  '26390203743090',
];

export type MessengerEchoSource = 'own' | 'page_inbox' | 'other_app';

/** app_id trong raw (event gốc): Meta có khi gửi dạng số, chuẩn hóa về chuỗi. */
export function messengerEchoAppId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const message = (raw as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return undefined;
  const appId = (message as { app_id?: unknown }).app_id;
  if (typeof appId === 'string' && appId.trim() !== '') return appId.trim();
  if (typeof appId === 'number' && Number.isFinite(appId)) return String(appId);
  return undefined;
}

/**
 * 'own' = tin app của mình gửi qua Send API; 'page_inbox' = người gửi từ Hộp thư Page/Business Suite;
 * 'other_app' = công cụ khác (chatbot, CRM) hoặc thiếu app_id.
 */
export function messengerEchoSource(raw: unknown, ownAppId: string): MessengerEchoSource {
  const appId = messengerEchoAppId(raw);
  if (!appId) return 'other_app';
  if (ownAppId && appId === String(ownAppId).trim()) return 'own';
  if (PAGE_INBOX_APP_IDS.includes(appId)) return 'page_inbox';
  return 'other_app';
}
