import { describe, expect, it } from 'vitest';
import type { LarkGroupDto } from '@dezon/shared';
import {
  alsoInGroupsLabel,
  buildCreateLarkGroupRequest,
  buildUpdateLarkGroupRequest,
  isLarkGroupDirty,
  LARK_GROUP_MESSAGES,
  larkGroupFormFrom,
  otherGroupsByChatbot,
  pruneUnknownChatbotIds,
  resolveGroupChatbots,
  shortenWebhook,
  sortChatbotsForPicker,
  validateCreateLarkGroup,
  validateUpdateLarkGroup,
  type LarkGroupFormValues,
} from './lark-groups';

const BOT_A = '11111111-1111-4111-8111-111111111111';
const BOT_B = '22222222-2222-4222-8222-222222222222';
const BOT_C = '33333333-3333-4333-8333-333333333333';
const URL_OK = 'https://open.larksuite.com/open-apis/bot/v2/hook/abcdef123456';

function group(over: Partial<LarkGroupDto> = {}): LarkGroupDto {
  return {
    id: 'g1',
    name: 'Sale HN',
    webhookUrl: URL_OK,
    hasSecret: false,
    chatbotIds: [BOT_A],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

function form(over: Partial<LarkGroupFormValues> = {}): LarkGroupFormValues {
  return { name: 'Sale HN', webhookUrl: URL_OK, secret: { mode: 'keep' }, chatbotIds: [BOT_A], ...over };
}

describe('larkGroupFormFrom', () => {
  it('form trống khi thêm mới; nạp nhóm đã lưu khi sửa (secret luôn "giữ nguyên")', () => {
    expect(larkGroupFormFrom(null)).toEqual({
      name: '',
      webhookUrl: '',
      secret: { mode: 'keep' },
      chatbotIds: [],
    });
    expect(larkGroupFormFrom(group({ hasSecret: true }))).toEqual(form());
  });
});

describe('buildCreateLarkGroupRequest', () => {
  it('trim, bỏ trùng bot, secret rỗng => bỏ trường', () => {
    expect(
      buildCreateLarkGroupRequest(
        form({
          name: '  A ',
          webhookUrl: ` ${URL_OK} `,
          chatbotIds: [BOT_A, BOT_A, BOT_B],
          secret: { mode: 'set', value: ' ' },
        }),
      ),
    ).toEqual({ name: 'A', webhookUrl: URL_OK, chatbotIds: [BOT_A, BOT_B] });
  });
  it('có secret => gửi secret đã trim', () => {
    expect(buildCreateLarkGroupRequest(form({ secret: { mode: 'set', value: ' s ' } })).secret).toBe('s');
  });
});

describe('buildUpdateLarkGroupRequest', () => {
  it('không đổi gì => body rỗng (thứ tự bot không tính)', () => {
    expect(
      buildUpdateLarkGroupRequest(
        form({ chatbotIds: [BOT_B, BOT_A] }),
        group({ chatbotIds: [BOT_A, BOT_B] }),
      ),
    ).toEqual({});
  });
  it('chỉ gửi trường đã đổi', () => {
    expect(buildUpdateLarkGroupRequest(form({ name: 'Mới', chatbotIds: [BOT_A, BOT_C] }), group())).toEqual({
      name: 'Mới',
      chatbotIds: [BOT_A, BOT_C],
    });
  });
  it('secret: giữ = bỏ qua; xóa = null (chỉ khi đang có); đặt mới = chuỗi', () => {
    expect(
      buildUpdateLarkGroupRequest(form({ secret: { mode: 'keep' } }), group({ hasSecret: true })),
    ).toEqual({});
    expect(
      buildUpdateLarkGroupRequest(form({ secret: { mode: 'clear' } }), group({ hasSecret: true })),
    ).toEqual({
      secret: null,
    });
    expect(
      buildUpdateLarkGroupRequest(form({ secret: { mode: 'clear' } }), group({ hasSecret: false })),
    ).toEqual({});
    expect(buildUpdateLarkGroupRequest(form({ secret: { mode: 'set', value: 'x' } }), group())).toEqual({
      secret: 'x',
    });
    expect(
      buildUpdateLarkGroupRequest(form({ secret: { mode: 'set', value: '' } }), group({ hasSecret: true })),
    ).toEqual({});
  });
});

describe('isLarkGroupDirty', () => {
  it('thêm mới: dirty khi đã nhập gì đó', () => {
    expect(isLarkGroupDirty(larkGroupFormFrom(null), null)).toBe(false);
    expect(isLarkGroupDirty({ ...larkGroupFormFrom(null), name: 'x' }, null)).toBe(true);
    expect(isLarkGroupDirty({ ...larkGroupFormFrom(null), chatbotIds: [BOT_A] }, null)).toBe(true);
  });
  it('sửa: so với nhóm đã lưu', () => {
    expect(isLarkGroupDirty(form(), group())).toBe(false);
    expect(isLarkGroupDirty(form({ webhookUrl: `${URL_OK}x` }), group())).toBe(true);
  });
});

describe('validateCreateLarkGroup', () => {
  it('hợp lệ => body', () => {
    const v = validateCreateLarkGroup(form());
    expect(v).toEqual({ ok: true, body: { name: 'Sale HN', webhookUrl: URL_OK, chatbotIds: [BOT_A] } });
  });
  it('thiếu tên + thiếu webhook => lỗi tiếng Việt từng ô', () => {
    const v = validateCreateLarkGroup(form({ name: '  ', webhookUrl: '' }));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.name).toBe(LARK_GROUP_MESSAGES.nameRequired);
      expect(v.errors.webhookUrl).toBe(LARK_GROUP_MESSAGES.webhookRequired);
    }
  });
  it('webhook http / sai định dạng / tên quá dài / secret quá dài / quá nhiều bot', () => {
    const http = validateCreateLarkGroup(form({ webhookUrl: 'http://open.larksuite.com/hook' }));
    expect(!http.ok && http.errors.webhookUrl).toBe(LARK_GROUP_MESSAGES.webhookInvalid);
    const junk = validateCreateLarkGroup(form({ webhookUrl: 'không phải url' }));
    expect(!junk.ok && junk.errors.webhookUrl).toBe(LARK_GROUP_MESSAGES.webhookInvalid);
    const longName = validateCreateLarkGroup(form({ name: 'a'.repeat(101) }));
    expect(!longName.ok && longName.errors.name).toBe(LARK_GROUP_MESSAGES.nameTooLong);
    const longSecret = validateCreateLarkGroup(form({ secret: { mode: 'set', value: 's'.repeat(201) } }));
    expect(!longSecret.ok && longSecret.errors.secret).toBe(LARK_GROUP_MESSAGES.secretTooLong);
    const ids = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const many = validateCreateLarkGroup(form({ chatbotIds: ids }));
    expect(!many.ok && many.errors.chatbotIds).toBe(LARK_GROUP_MESSAGES.tooManyBots);
  });
});

describe('validateUpdateLarkGroup', () => {
  it('không đổi gì => ok với body rỗng', () => {
    expect(validateUpdateLarkGroup(form(), group())).toEqual({ ok: true, body: {} });
  });
  it('xóa trắng tên/webhook => lỗi bắt buộc; webhook sai => lỗi định dạng', () => {
    const empty = validateUpdateLarkGroup(form({ name: '', webhookUrl: ' ' }), group());
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.errors.name).toBe(LARK_GROUP_MESSAGES.nameRequired);
      expect(empty.errors.webhookUrl).toBe(LARK_GROUP_MESSAGES.webhookRequired);
    }
    const bad = validateUpdateLarkGroup(form({ webhookUrl: 'ftp://x.y' }), group());
    expect(!bad.ok && bad.errors.webhookUrl).toBe(LARK_GROUP_MESSAGES.webhookInvalid);
  });
  it('đổi hợp lệ => body chỉ trường đổi', () => {
    expect(validateUpdateLarkGroup(form({ secret: { mode: 'clear' } }), group({ hasSecret: true }))).toEqual({
      ok: true,
      body: { secret: null },
    });
  });
});

describe('shortenWebhook', () => {
  it('host + vài ký tự cuối', () => {
    expect(shortenWebhook(URL_OK)).toBe('open.larksuite.com/…123456');
    expect(shortenWebhook(`${URL_OK}/`)).toBe('open.larksuite.com/…123456');
  });
  it('đường dẫn ngắn giữ nguyên; chỉ host', () => {
    expect(shortenWebhook('https://a.example/x')).toBe('a.example/x');
    expect(shortenWebhook('https://a.example')).toBe('a.example');
    expect(shortenWebhook('https://a.example:8443/hook/abcdefgh', 4)).toBe('a.example:8443/…efgh');
  });
  it('không phải URL => chỉ đuôi', () => {
    expect(shortenWebhook('khongphaiurl-abcdef1234')).toBe('…ef1234');
    expect(shortenWebhook('abc')).toBe('abc');
  });
});

describe('otherGroupsByChatbot / alsoInGroupsLabel', () => {
  const groups = [
    group({ id: 'g1', name: 'Sale HN', chatbotIds: [BOT_A, BOT_B] }),
    group({ id: 'g2', name: 'Sale HCM', chatbotIds: [BOT_A] }),
    group({ id: 'g3', name: 'CSKH', chatbotIds: [BOT_A, BOT_A] }),
  ];
  it('bỏ nhóm đang sửa, gom tên nhóm khác theo bot (không trùng)', () => {
    const m = otherGroupsByChatbot(groups, 'g1');
    expect(m.get(BOT_A)).toEqual(['Sale HCM', 'CSKH']);
    expect(m.has(BOT_B)).toBe(false);
    expect(otherGroupsByChatbot(groups, null).get(BOT_B)).toEqual(['Sale HN']);
  });
  it('nhãn cảnh báo', () => {
    expect(alsoInGroupsLabel(undefined)).toBeNull();
    expect(alsoInGroupsLabel([])).toBeNull();
    expect(alsoInGroupsLabel(['Sale HCM'])).toBe('cũng đang ở nhóm Sale HCM');
    expect(alsoInGroupsLabel(['A', 'B'])).toBe('cũng đang ở nhóm A, B');
  });
});

describe('sortChatbotsForPicker / resolveGroupChatbots', () => {
  const bots = [
    {
      id: BOT_A,
      name: 'Bình',
      isActive: false,
      description: null,
      conversationCount: 0,
      handoffAckLabel: null,
      handoffResolveLabel: null,
    },
    {
      id: BOT_B,
      name: 'Ánh',
      isActive: true,
      description: null,
      conversationCount: 0,
      handoffAckLabel: null,
      handoffResolveLabel: null,
    },
    {
      id: BOT_C,
      name: 'An',
      isActive: true,
      description: null,
      conversationCount: 0,
      handoffAckLabel: null,
      handoffResolveLabel: null,
    },
  ];
  it('bot bật trước, rồi theo tên', () => {
    expect(sortChatbotsForPicker(bots).map((b) => b.name)).toEqual(['An', 'Ánh', 'Bình']);
  });
  it('giữ thứ tự id, bỏ bot đã xóa và id trùng', () => {
    expect(resolveGroupChatbots([BOT_A, 'gone', BOT_B, BOT_A], bots)).toEqual([
      { id: BOT_A, name: 'Bình', isActive: false },
      { id: BOT_B, name: 'Ánh', isActive: true },
    ]);
  });
});

describe('pruneUnknownChatbotIds', () => {
  it('bỏ id bot đã xóa (không còn trong danh sách bot), giữ thứ tự, bỏ trùng', () => {
    expect(pruneUnknownChatbotIds([BOT_C, BOT_A, BOT_B, BOT_A], [{ id: BOT_A }, { id: BOT_C }])).toEqual([
      BOT_C,
      BOT_A,
    ]);
    expect(pruneUnknownChatbotIds([BOT_A], [])).toEqual([]);
    expect(pruneUnknownChatbotIds([], [{ id: BOT_A }])).toEqual([]);
  });

  it('nhóm có bot đã xóa: cắt cả form lẫn nhóm đã lưu ⇒ không "đổi" gì; bỏ chọn bot còn lại ⇒ PATCH không chứa id đã xóa', () => {
    const bots = [{ id: BOT_B }, { id: BOT_C }];
    const saved = group({ chatbotIds: [BOT_A, BOT_B] });
    const prunedSaved = { ...saved, chatbotIds: pruneUnknownChatbotIds(saved.chatbotIds, bots) };
    const f = larkGroupFormFrom(saved);
    const prunedForm = { ...f, chatbotIds: pruneUnknownChatbotIds(f.chatbotIds, bots) };
    expect(isLarkGroupDirty(prunedForm, prunedSaved)).toBe(false);
    const withC = { ...prunedForm, chatbotIds: [...prunedForm.chatbotIds, BOT_C] };
    expect(buildUpdateLarkGroupRequest(withC, prunedSaved)).toEqual({ chatbotIds: [BOT_B, BOT_C] });
  });
});
