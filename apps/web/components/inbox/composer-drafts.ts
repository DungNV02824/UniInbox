/**
 * Bản nháp ô soạn theo (người dùng, hội thoại), giữ trong bộ nhớ khi chuyển qua lại giữa các hội thoại.
 * Khóa theo người dùng + xóa khi đăng xuất: máy dùng chung không lộ nháp của người trước.
 */
const drafts = new Map<string, string>();

function key(userId: string | undefined, conversationId: string): string {
  return `${userId ?? 'anon'}:${conversationId}`;
}

export function getDraft(userId: string | undefined, conversationId: string): string {
  return drafts.get(key(userId, conversationId)) ?? '';
}

export function setDraft(userId: string | undefined, conversationId: string, text: string): void {
  if (text) drafts.set(key(userId, conversationId), text);
  else drafts.delete(key(userId, conversationId));
}

/** Gọi khi đăng xuất. */
export function clearDrafts(): void {
  drafts.clear();
}
