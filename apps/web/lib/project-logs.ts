// "Nhật ký công trình" ở khung Thông tin khách: hiển thị một dòng, tin cần cuộn tới, cập nhật cache khi xóa.
// Hàm thuần để test.
import type { ConversationDetail, ProjectLogDto, ProjectLogFieldDto } from '@dezon/shared';

/** Khóa trường làm tiêu đề dòng (địa chỉ công trình). */
export const PROJECT_LOG_TITLE_KEY = 'dia_chi';

/**
 * Tin của lượt gửi ảnh nằm trước lúc ghi nhật ký; tải ngược quá mốc này (tính từ lúc ghi) mà chưa thấy tin cần tới
 * ⇒ coi như đã bị xóa, thôi tải thêm.
 */
export const PROJECT_LOG_JUMP_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export interface ProjectLogView {
  /** Địa chỉ công trình (null = chưa có ⇒ dùng tiêu đề chung). */
  title: string | null;
  /** Các trường còn lại có giá trị, theo thứ tự cấu hình lúc ghi. */
  lines: ProjectLogFieldDto[];
}

/** Địa chỉ (nếu có) làm tiêu đề, các trường còn lại có giá trị thành dòng "nhãn: giá trị". */
export function projectLogView(log: Pick<ProjectLogDto, 'fields'>): ProjectLogView {
  const fields = (log.fields ?? [])
    .map((f) => ({ ...f, label: (f.label ?? '').trim() || f.key, value: (f.value ?? '').trim() }))
    .filter((f) => f.value);
  const titleField = fields.find((f) => f.key === PROJECT_LOG_TITLE_KEY);
  return {
    title: titleField?.value ?? null,
    lines: fields.filter((f) => f !== titleField),
  };
}

export interface ProjectLogJumpTarget {
  anchorId: string | null;
  highlightIds: string[];
  /** ISO — xem PROJECT_LOG_JUMP_WINDOW_MS. */
  notBefore: string | null;
}

/** Tin để cuộn tới: tin neo (không có ⇒ tin đầu tiên còn thấy trong messageIds), làm nổi mọi tin của lượt. */
export function projectLogJumpTarget(
  log: Pick<ProjectLogDto, 'anchorMessageId' | 'messageIds' | 'createdAt'>,
): ProjectLogJumpTarget {
  const created = Date.parse(log.createdAt);
  return {
    anchorId: log.anchorMessageId || null,
    highlightIds: [...new Set((log.messageIds ?? []).filter(Boolean))],
    notBefore: Number.isFinite(created) ? new Date(created - PROJECT_LOG_JUMP_WINDOW_MS).toISOString() : null,
  };
}

/** Dòng nhật ký có tin nào để cuộn tới không. */
export function canJumpToProjectLog(log: Pick<ProjectLogDto, 'anchorMessageId' | 'messageIds'>): boolean {
  return !!log.anchorMessageId || (log.messageIds ?? []).some(Boolean);
}

/** Bỏ một dòng khỏi chi tiết hội thoại trong cache (xóa lạc quan). Không có ⇒ trả về đúng `detail`. */
export function withoutProjectLog(
  detail: ConversationDetail | undefined,
  logId: string,
): ConversationDetail | undefined {
  if (!detail?.projectLogs?.some((l) => l.id === logId)) return detail;
  return { ...detail, projectLogs: detail.projectLogs.filter((l) => l.id !== logId) };
}

/** Phản hồi DELETE là danh sách nhật ký mới (máy chủ có thể trả 204 không nội dung). */
export function looksLikeProjectLogs(value: unknown): value is ProjectLogDto[] {
  return (
    Array.isArray(value) &&
    value.every((v) => !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string')
  );
}
