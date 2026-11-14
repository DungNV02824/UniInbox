// Ô "Ghi chú" của khách tách trường (SĐT, Nhu cầu, trường bot thu thập, Ghi chú khác). Hàm thuần để test.
import {
  CAPTURE_BUILTIN_LABELS,
  type CaptureFieldRef,
  type ContactDetail,
  type ContactProfileFieldDto,
  type UpdateContactRequest,
} from '@dezon/shared';

export type ProfileSource = 'ai' | 'user' | null;

export interface ContactNoteField {
  key: string;
  label: string;
  value: string;
  source: ProfileSource;
}

/** Chú thích của dấu "AI" cạnh trường bot tự điền. */
export const AI_FIELD_TOOLTIP = 'Bot tự điền — sửa tay thì bot sẽ không ghi đè';

const NEED_KEY = 'need';
const PHONE_KEY = 'phone';

/**
 * Các trường hiển thị trong mục Ghi chú: Nhu cầu luôn có (trống nếu chưa điền); rồi các trường bot đang gắn cấu hình
 * thu thập (`captureFields` = ChatbotRef.captureFields, theo thứ tự cấu hình, tên theo cấu hình — trống nếu AI chưa
 * điền, vẫn sửa được); rồi các trường đã có giá trị mà bot không cấu hình (bot khác / trường đã bỏ) theo thứ tự máy
 * chủ trả. 'phone'/'need' trong captureFields bỏ qua (SĐT và Nhu cầu có ô riêng). An toàn khi máy chủ cũ chưa gửi
 * `profileFields` / `captureFields`.
 */
export function contactNoteFields(
  contact: Pick<ContactDetail, 'profileFields'>,
  captureFields?: readonly CaptureFieldRef[] | null,
): {
  need: ContactNoteField;
  others: ContactNoteField[];
} {
  const list: ContactProfileFieldDto[] = (
    Array.isArray(contact.profileFields) ? contact.profileFields : []
  ).filter((f): f is ContactProfileFieldDto => !!f && typeof f.key === 'string');
  const byKey = new Map<string, ContactProfileFieldDto>();
  for (const f of list) if (!byKey.has(f.key)) byKey.set(f.key, f);
  const toField = (f: ContactProfileFieldDto): ContactNoteField => ({
    key: f.key,
    label: f.label?.trim() || f.key,
    value: f.value ?? '',
    source: f.source === 'ai' || f.source === 'user' ? f.source : null,
  });
  const needDto = byKey.get(NEED_KEY);
  const need: ContactNoteField = needDto
    ? { ...toField(needDto), label: CAPTURE_BUILTIN_LABELS.need }
    : { key: NEED_KEY, label: CAPTURE_BUILTIN_LABELS.need, value: '', source: null };
  const seen = new Set<string>([NEED_KEY]);
  const others: ContactNoteField[] = [];
  for (const c of Array.isArray(captureFields) ? captureFields : []) {
    if (!c || typeof c.key !== 'string' || c.key === PHONE_KEY || seen.has(c.key)) continue;
    seen.add(c.key);
    const dto = byKey.get(c.key);
    const label = c.label?.trim() || dto?.label?.trim() || c.key;
    others.push(dto ? { ...toField(dto), label } : { key: c.key, label, value: '', source: null });
  }
  for (const f of list) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    others.push(toField(f));
  }
  return { need, others };
}

/** Body PATCH /contacts/:id khi nhân viên sửa một trường (rỗng ⇒ null = xóa). */
export function profileFieldUpdate(field: Pick<ContactNoteField, 'key' | 'label'>, value: string) {
  const v = value.trim();
  return {
    profileFields: [{ key: field.key, label: field.label, value: v ? v : null }],
  } satisfies UpdateContactRequest;
}

export function phoneUpdate(value: string) {
  const v = value.trim();
  return { phone: v ? v : null } satisfies UpdateContactRequest;
}

/**
 * Áp body PATCH lên hồ sơ đang có khi máy chủ không trả hồ sơ đầy đủ: nhân viên sửa ⇒ nguồn 'user';
 * giá trị rỗng ⇒ xóa trường. `now` = ISO.
 */
export function applyContactUpdate(
  contact: ContactDetail,
  body: UpdateContactRequest,
  now: string,
): ContactDetail {
  const next: ContactDetail = {
    ...contact,
    ...(body.displayName !== undefined && { displayName: body.displayName }),
    ...(body.notes !== undefined && { notes: body.notes }),
    ...(body.tags !== undefined && { tags: body.tags }),
  };
  if (body.phone !== undefined) {
    const phone = body.phone?.trim() || null;
    next.phone = phone;
    next.phoneSource = phone ? 'user' : null;
  }
  if (body.profileFields !== undefined) {
    let fields = Array.isArray(contact.profileFields) ? [...contact.profileFields] : [];
    for (const patch of body.profileFields) {
      const value = patch.value?.trim() ?? '';
      const i = fields.findIndex((f) => f.key === patch.key);
      if (!value) {
        fields = fields.filter((f) => f.key !== patch.key);
        continue;
      }
      // Như máy chủ: tên gửi lên ?? tên đang có ?? tên mặc định.
      const label =
        patch.label?.trim() ||
        fields[i]?.label ||
        (patch.key === NEED_KEY ? CAPTURE_BUILTIN_LABELS.need : patch.key);
      const updated: ContactProfileFieldDto = {
        key: patch.key,
        label,
        value,
        source: 'user',
        updatedAt: now,
      };
      if (i >= 0) fields[i] = updated;
      else if (patch.key === NEED_KEY) fields.unshift(updated);
      else fields.push(updated);
    }
    next.profileFields = fields;
  }
  return next;
}
