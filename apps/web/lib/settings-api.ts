// Gọi API "Cài đặt" (admin): giờ làm việc, Lark, công tắc AI tổng.
import type { AiSettings, BusinessHours, LarkSettingsDto, UpdateLarkSettingsRequest } from '@dezon/shared';
import { api } from '@/lib/api';

export const settingsKeys = {
  businessHours: ['settings', 'business-hours'] as const,
  lark: ['settings', 'lark'] as const,
  ai: ['settings', 'ai'] as const,
};

export const settingsApi = {
  getBusinessHours() {
    return api.request<BusinessHours>('/settings/business-hours');
  },
  putBusinessHours(body: BusinessHours) {
    return api.request<BusinessHours>('/settings/business-hours', { method: 'PUT', body });
  },
  getLark() {
    return api.request<LarkSettingsDto>('/settings/lark');
  },
  putLark(body: UpdateLarkSettingsRequest) {
    return api.request<LarkSettingsDto>('/settings/lark', { method: 'PUT', body });
  },
  /** Gửi thẻ thử tới webhook Lark ĐÃ LƯU. */
  testLark() {
    return api.request<unknown>('/settings/lark/test', { method: 'POST' });
  },
  getAi() {
    return api.request<AiSettings>('/settings/ai');
  },
  putAi(body: AiSettings) {
    return api.request<AiSettings>('/settings/ai', { method: 'PUT', body });
  },
};

/** Trạng thái ô secret Lark (chỉ ghi): giữ nguyên / đặt mới / xóa. */
export type LarkSecretState = { mode: 'keep' } | { mode: 'set'; value: string } | { mode: 'clear' };

export interface LarkFormValues {
  webhookUrl: string;
  secret: LarkSecretState;
}

/** Form → body PUT /settings/lark: URL rỗng = null; secret giữ nguyên thì không gửi trường. */
export function buildLarkRequest(form: LarkFormValues): UpdateLarkSettingsRequest {
  const url = form.webhookUrl.trim();
  const body: UpdateLarkSettingsRequest = { webhookUrl: url ? url : null };
  if (form.secret.mode === 'clear') body.secret = null;
  else if (form.secret.mode === 'set' && form.secret.value.trim()) body.secret = form.secret.value.trim();
  // 'set' nhưng ô trống = coi như giữ nguyên (xóa secret phải bấm nút "Xóa").
  return body;
}

/** Có gì khác so với cấu hình đã lưu không. */
export function isLarkDirty(form: LarkFormValues, saved: LarkSettingsDto | undefined): boolean {
  if (form.webhookUrl.trim() !== (saved?.webhookUrl ?? '')) return true;
  if (form.secret.mode === 'clear') return !!saved?.hasSecret;
  if (form.secret.mode === 'set') return form.secret.value.trim().length > 0;
  return false;
}
