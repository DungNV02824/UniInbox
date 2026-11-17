// "Nhóm Lark theo chatbot" (Cài đặt): hàm thuần cho form nhóm, rút gọn webhook, tra bot đã ở nhóm khác.
import {
  createLarkGroupSchema,
  LARK_GROUP_LIMITS,
  updateLarkGroupSchema,
  type ChatbotSummary,
  type CreateLarkGroupRequest,
  type LarkGroupDto,
  type UpdateLarkGroupRequest,
} from '@dezon/shared';
import type { LarkSecretState } from '@/lib/settings-api';

export interface LarkGroupFormValues {
  name: string;
  webhookUrl: string;
  secret: LarkSecretState;
  chatbotIds: string[];
}

export type LarkGroupFormErrors = Partial<
  Record<'name' | 'webhookUrl' | 'secret' | 'chatbotIds' | 'form', string>
>;

export const LARK_GROUP_MESSAGES = {
  nameRequired: 'Nhập tên nhóm',
  nameTooLong: `Tên nhóm tối đa ${LARK_GROUP_LIMITS.nameMax} ký tự`,
  webhookRequired: 'Nhập Webhook URL',
  webhookInvalid: 'Webhook phải là URL https hợp lệ (tối đa 500 ký tự).',
  secretTooLong: 'Secret tối đa 200 ký tự',
  tooManyBots: `Mỗi nhóm tối đa ${LARK_GROUP_LIMITS.maxChatbotsPerGroup} chatbot`,
  invalid: 'Dữ liệu chưa hợp lệ',
} as const;

/** Form trống (thêm mới) hoặc nạp từ nhóm đã lưu (sửa). Secret không bao giờ nạp — chỉ "giữ nguyên". */
export function larkGroupFormFrom(group?: LarkGroupDto | null): LarkGroupFormValues {
  return {
    name: group?.name ?? '',
    webhookUrl: group?.webhookUrl ?? '',
    secret: { mode: 'keep' },
    chatbotIds: group ? [...group.chatbotIds] : [],
  };
}

function secretField(secret: LarkSecretState): { secret?: string | null } {
  if (secret.mode === 'clear') return { secret: null };
  if (secret.mode === 'set' && secret.value.trim()) return { secret: secret.value.trim() };
  // 'set' nhưng ô trống = giữ nguyên (xóa phải bấm "Xóa secret").
  return {};
}

/** Form → body POST /settings/lark/groups. */
export function buildCreateLarkGroupRequest(form: LarkGroupFormValues): CreateLarkGroupRequest {
  const body: CreateLarkGroupRequest = {
    name: form.name.trim(),
    webhookUrl: form.webhookUrl.trim(),
    chatbotIds: [...new Set(form.chatbotIds)],
  };
  const s = secretField(form.secret);
  if (s.secret) body.secret = s.secret; // tạo mới: không có secret thì bỏ trường
  return body;
}

/** Form → body PATCH /settings/lark/groups/:id: chỉ gửi trường đã đổi; secret bỏ qua = giữ nguyên. */
export function buildUpdateLarkGroupRequest(
  form: LarkGroupFormValues,
  saved: LarkGroupDto,
): UpdateLarkGroupRequest {
  const body: UpdateLarkGroupRequest = {};
  const name = form.name.trim();
  if (name !== saved.name) body.name = name;
  const url = form.webhookUrl.trim();
  if (url !== saved.webhookUrl) body.webhookUrl = url;
  const ids = [...new Set(form.chatbotIds)];
  if (!sameIdSet(ids, saved.chatbotIds)) body.chatbotIds = ids;
  const s = secretField(form.secret);
  if (s.secret === null) {
    if (saved.hasSecret) body.secret = null;
  } else if (s.secret !== undefined) body.secret = s.secret;
  return body;
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/** Có gì khác so với nhóm đã lưu (hoặc form trống khi thêm mới) không. */
export function isLarkGroupDirty(form: LarkGroupFormValues, saved: LarkGroupDto | null): boolean {
  if (!saved) {
    return (
      form.name.trim() !== '' ||
      form.webhookUrl.trim() !== '' ||
      form.chatbotIds.length > 0 ||
      (form.secret.mode === 'set' && form.secret.value.trim() !== '')
    );
  }
  return Object.keys(buildUpdateLarkGroupRequest(form, saved)).length > 0;
}

type Validated<T> = { ok: true; body: T } | { ok: false; errors: LarkGroupFormErrors };

function mapIssues(issues: readonly { path: readonly PropertyKey[]; code: string }[]): LarkGroupFormErrors {
  const errors: LarkGroupFormErrors = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (key === 'name') {
      errors.name ??=
        issue.code === 'too_big' ? LARK_GROUP_MESSAGES.nameTooLong : LARK_GROUP_MESSAGES.nameRequired;
    } else if (key === 'webhookUrl') errors.webhookUrl ??= LARK_GROUP_MESSAGES.webhookInvalid;
    else if (key === 'secret') errors.secret ??= LARK_GROUP_MESSAGES.secretTooLong;
    else if (key === 'chatbotIds') errors.chatbotIds ??= LARK_GROUP_MESSAGES.tooManyBots;
    else errors.form ??= LARK_GROUP_MESSAGES.invalid;
  }
  return errors;
}

/** Kiểm tra form theo đúng zod schema của API, lỗi bằng tiếng Việt theo từng ô. */
export function validateCreateLarkGroup(form: LarkGroupFormValues): Validated<CreateLarkGroupRequest> {
  const body = buildCreateLarkGroupRequest(form);
  const errors: LarkGroupFormErrors = {};
  if (!body.name) errors.name = LARK_GROUP_MESSAGES.nameRequired;
  if (!body.webhookUrl) errors.webhookUrl = LARK_GROUP_MESSAGES.webhookRequired;
  const parsed = createLarkGroupSchema.safeParse(body);
  if (!parsed.success) Object.assign(errors, { ...mapIssues(parsed.error.issues), ...errors });
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, body };
}

/** Như trên cho PATCH; body rỗng (không đổi gì) vẫn hợp lệ — nơi gọi tự bỏ qua. */
export function validateUpdateLarkGroup(
  form: LarkGroupFormValues,
  saved: LarkGroupDto,
): Validated<UpdateLarkGroupRequest> {
  const body = buildUpdateLarkGroupRequest(form, saved);
  const errors: LarkGroupFormErrors = {};
  if (!form.name.trim()) errors.name = LARK_GROUP_MESSAGES.nameRequired;
  if (!form.webhookUrl.trim()) errors.webhookUrl = LARK_GROUP_MESSAGES.webhookRequired;
  if (Object.keys(body).length > 0) {
    const parsed = updateLarkGroupSchema.safeParse(body);
    if (!parsed.success) Object.assign(errors, { ...mapIssues(parsed.error.issues), ...errors });
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, body };
}

/** "open.larksuite.com/…a1b2c3" — host + vài ký tự cuối (không lộ trọn token webhook). */
export function shortenWebhook(url: string, tail = 6): string {
  const trimmed = url.trim();
  let host: string;
  try {
    host = new URL(trimmed).host;
  } catch {
    return trimmed.length > tail + 1 ? `…${trimmed.slice(-tail)}` : trimmed;
  }
  const rest = trimmed
    .replace(/^[a-z]+:\/\//i, '')
    .slice(host.length)
    .replace(/\/+$/, '');
  if (!rest || rest === '/') return host;
  return rest.length > tail ? `${host}/…${rest.slice(-tail)}` : `${host}${rest}`;
}

/** chatbotId → tên các nhóm KHÁC (khác `excludeGroupId`) đang chứa bot đó. */
export function otherGroupsByChatbot(
  groups: readonly LarkGroupDto[],
  excludeGroupId: string | null,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const g of groups) {
    if (g.id === excludeGroupId) continue;
    for (const botId of new Set(g.chatbotIds)) {
      const names = map.get(botId);
      if (names) names.push(g.name);
      else map.set(botId, [g.name]);
    }
  }
  return map;
}

/** "cũng đang ở nhóm A" / "cũng đang ở nhóm A, B". */
export function alsoInGroupsLabel(names: readonly string[] | undefined): string | null {
  if (!names || names.length === 0) return null;
  return `cũng đang ở nhóm ${names.join(', ')}`;
}

/** Bot đang bật trước, rồi theo tên (tiếng Việt). */
export function sortChatbotsForPicker(bots: readonly ChatbotSummary[]): ChatbotSummary[] {
  return [...bots].sort(
    (a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name, 'vi'),
  );
}

/** Tên bot gắn vào nhóm (giữ thứ tự `ids`); bỏ id không còn trong danh sách bot (bot đã xóa). */
export function resolveGroupChatbots(
  ids: readonly string[],
  bots: readonly Pick<ChatbotSummary, 'id' | 'name' | 'isActive'>[],
): { id: string; name: string; isActive: boolean }[] {
  const byId = new Map(bots.map((b) => [b.id, b]));
  const out: { id: string; name: string; isActive: boolean }[] = [];
  for (const id of new Set(ids)) {
    const bot = byId.get(id);
    if (bot) out.push({ id, name: bot.name, isActive: bot.isActive });
  }
  return out;
}

/**
 * Bỏ khỏi `ids` các bot không còn trong danh sách bot đã tải (bot vừa bị xóa nhưng cache nhóm còn cũ) — để dialog
 * không giữ một id ẩn không bỏ chọn được (server trả 400 "chatbot không tồn tại"). Giữ thứ tự, bỏ trùng.
 */
export function pruneUnknownChatbotIds(
  ids: readonly string[],
  bots: readonly Pick<ChatbotSummary, 'id'>[],
): string[] {
  const known = new Set(bots.map((b) => b.id));
  return [...new Set(ids)].filter((id) => known.has(id));
}
