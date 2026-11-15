// Tool của bot: thuộc tính `captured` ("Thu thập thông tin") + parse lỏng (thuần, không DB).
import { DEFAULT_CAPTURE_CONFIG, DEFAULT_PROJECT_LOG_CONFIG, type CaptureConfig } from '@dezon/shared';
import { describe, expect, it } from 'vitest';
import {
  buildChatbotTools,
  CHATBOT_TOOLS,
  escalateArgsSchema,
  FOLLOWUP_TOOLS,
  noReplyArgsSchema,
  normalizeCapturedArg,
  normalizeProjectLogsArg,
  replyArgsSchema,
  STAFF_REJECT_TOOLS,
} from './tools';

const capture: CaptureConfig = {
  enabled: true,
  fields: [
    ...DEFAULT_CAPTURE_CONFIG.fields,
    { key: 'khu_vuc', label: 'Khu vực', hint: 'Tỉnh/thành', enabled: true },
    { key: 'ngan_sach', label: 'Ngân sách', hint: '', enabled: false },
  ],
  phoneTag: null,
  projectLog: DEFAULT_PROJECT_LOG_CONFIG,
};

type Params = { properties: Record<string, { type?: string; properties?: Record<string, unknown> }> };
const paramsOf = (tools: ReturnType<typeof buildChatbotTools>, name: string) =>
  tools.find((t) => t.name === name)!.parameters as unknown as Params & { required: string[] };

describe('buildChatbotTools — captured', () => {
  it('tắt thu thập ⇒ đúng CHATBOT_TOOLS (không có captured)', () => {
    expect(buildChatbotTools({ escalateWhenUnsure: true })).toBe(CHATBOT_TOOLS);
    expect(buildChatbotTools({ escalateWhenUnsure: true, capture: DEFAULT_CAPTURE_CONFIG })).toBe(
      CHATBOT_TOOLS,
    );
    const unsureOff = buildChatbotTools({ escalateWhenUnsure: false, capture: DEFAULT_CAPTURE_CONFIG });
    for (const t of unsureOff) expect(paramsOf(unsureOff, t.name).properties.captured).toBeUndefined();
    // Bật nhưng mọi trường tắt ⇒ như tắt.
    const noFields = { ...capture, fields: capture.fields.map((f) => ({ ...f, enabled: false })) };
    expect(buildChatbotTools({ escalateWhenUnsure: true, capture: noFields })).toBe(CHATBOT_TOOLS);
  });

  it('bật ⇒ reply / escalate / no_reply có captured (một chuỗi mỗi trường bật, mô tả = nhãn + gợi ý), không bắt buộc', () => {
    for (const unsure of [true, false]) {
      const tools = buildChatbotTools({ escalateWhenUnsure: unsure, capture });
      for (const name of ['reply', 'escalate', 'no_reply']) {
        const params = paramsOf(tools, name);
        const captured = params.properties.captured!;
        expect(captured.type).toBe('object');
        expect(captured.properties).toEqual({
          phone: { type: 'string', description: 'SĐT: Số điện thoại khách tự gõ trong chat.' },
          need: {
            type: 'string',
            description: 'Nhu cầu: Tóm tắt ngắn nhu cầu của khách (cần gì, quy mô, khu vực nếu có).',
          },
          khu_vuc: { type: 'string', description: 'Khu vực: Tỉnh/thành' },
        });
        expect(params.required).not.toContain('captured');
      }
      // escalateWhenUnsure=false vẫn bỏ lý do "không chắc".
      const reasons = (paramsOf(tools, 'escalate').properties.reason_code as { enum: string[] }).enum;
      expect(reasons.includes('low_confidence')).toBe(unsure);
    }
    // Không đổi hằng gốc / tool lượt "Không đạt".
    expect(paramsOf(CHATBOT_TOOLS, 'reply').properties.captured).toBeUndefined();
    expect(STAFF_REJECT_TOOLS.map((t) => t.name)).toEqual(['reply']);
    expect(paramsOf(STAFF_REJECT_TOOLS, 'reply').properties.captured).toBeUndefined();
    // Lượt "Khách không bị bỏ sót": reply + no_reply (được phép không nhắn), không escalate, không captured.
    expect(FOLLOWUP_TOOLS.map((t) => t.name)).toEqual(['reply', 'no_reply']);
    expect(JSON.stringify(FOLLOWUP_TOOLS)).not.toContain('captured');
  });
});

describe('captured — parse lỏng (không bao giờ làm hỏng lời gọi tool)', () => {
  it('normalizeCapturedArg: bỏ khóa sai, giá trị không phải chuỗi, rỗng; gộp khoảng trắng; cắt độ dài', () => {
    expect(
      normalizeCapturedArg({
        phone: ' 0912 345 678 ',
        need: 'Xây nhà\n 2 tầng  ',
        empty: '   ',
        num: 912345678,
        obj: { a: 1 },
        'Bad-Key': 'x',
        khu_vuc: 'Hà Nội',
      }),
    ).toEqual({ phone: '0912 345 678', need: 'Xây nhà 2 tầng', khu_vuc: 'Hà Nội' });
    for (const v of [undefined, null, 'chuỗi', 42, ['a'], {}, { a: '' }])
      expect(normalizeCapturedArg(v)).toBeUndefined();
    expect(Array.from(normalizeCapturedArg({ need: 'a'.repeat(5000) })!.need!)).toHaveLength(1000);
  });

  it('reply / escalate / no_reply: captured sai dạng vẫn parse được args', () => {
    const reply = replyArgsSchema.safeParse({ messages: ['Dạ'], confidence: 0.9, captured: 'rác' });
    expect(reply.success && reply.data.captured).toBeUndefined();
    expect(reply.success).toBe(true);
    const ok = replyArgsSchema.parse({ messages: ['Dạ'], confidence: 0.9, captured: { need: 'Sơn nhà' } });
    expect(ok.captured).toEqual({ need: 'Sơn nhà' });
    expect(replyArgsSchema.parse({ messages: ['Dạ'], confidence: 0.9 }).captured).toBeUndefined();
    const esc = escalateArgsSchema.parse({
      reason_code: 'human_request',
      summary_for_agent: 'x',
      captured: { phone: 912, need: 'Báo giá' },
    });
    expect(esc.captured).toEqual({ need: 'Báo giá' });
    expect(noReplyArgsSchema.parse({ reason: 'ok', captured: [1, 2] }).captured).toBeUndefined();
    expect(noReplyArgsSchema.parse({ reason: 'ok', captured: { phone: '0912345678' } }).captured).toEqual({
      phone: '0912345678',
    });
  });
});

describe('buildChatbotTools — project_logs (Nhật ký công trình)', () => {
  const projectLog = {
    enabled: true,
    fields: [
      ...DEFAULT_PROJECT_LOG_CONFIG.fields.map((f) => (f.key === 'ngay_chup' ? { ...f, enabled: false } : f)),
      { key: 'hang_muc', label: 'Hạng mục', hint: 'Phần việc đang thi công', enabled: true },
    ],
  };
  const logOn: CaptureConfig = { ...DEFAULT_CAPTURE_CONFIG, projectLog };

  it('tắt / không trường nào bật ⇒ không có project_logs (vẫn đúng CHATBOT_TOOLS)', () => {
    expect(buildChatbotTools({ escalateWhenUnsure: true, capture: DEFAULT_CAPTURE_CONFIG })).toBe(
      CHATBOT_TOOLS,
    );
    const noFields: CaptureConfig = {
      ...logOn,
      projectLog: { ...projectLog, fields: projectLog.fields.map((f) => ({ ...f, enabled: false })) },
    };
    expect(buildChatbotTools({ escalateWhenUnsure: true, capture: noFields })).toBe(CHATBOT_TOOLS);
    // Thu thập bật, nhật ký tắt ⇒ có captured, không có project_logs.
    const tools = buildChatbotTools({ escalateWhenUnsure: true, capture });
    for (const t of tools) expect(paramsOf(tools, t.name).properties.project_logs).toBeUndefined();
  });

  it('bật (độc lập với capture.enabled) ⇒ CHỈ reply / escalate có project_logs: mảng object, mỗi trường bật một chuỗi', () => {
    for (const unsure of [true, false]) {
      const tools = buildChatbotTools({ escalateWhenUnsure: unsure, capture: logOn });
      for (const name of ['reply', 'escalate']) {
        const params = paramsOf(tools, name);
        const prop = params.properties.project_logs as unknown as {
          type: string;
          maxItems: number;
          description: string;
          items: { type: string; properties: Record<string, unknown> };
        };
        expect(prop.type).toBe('array');
        expect(prop.maxItems).toBe(5);
        expect(prop.description).toContain('Nhật ký công trình');
        expect(prop.items.type).toBe('object');
        expect(prop.items.properties).toEqual({
          dia_chi: {
            type: 'string',
            description: 'Địa chỉ công trình: Địa chỉ công trình (đọc từ ảnh Timemark hoặc tin nhắn).',
          },
          nha_thau: {
            type: 'string',
            description: 'Nhà thầu: Tên nhà thầu / công ty thi công trên biển báo.',
          },
          sdt_nha_thau: {
            type: 'string',
            description: 'SĐT nhà thầu: Số điện thoại nhà thầu trên biển báo.',
          },
          hang_muc: { type: 'string', description: 'Hạng mục: Phần việc đang thi công' },
        });
        expect(params.required).not.toContain('project_logs');
        // Capture tắt ⇒ không có captured.
        expect(params.properties.captured).toBeUndefined();
      }
      expect(paramsOf(tools, 'no_reply').properties.project_logs).toBeUndefined();
    }
    // Cả hai cùng bật.
    const both = buildChatbotTools({ escalateWhenUnsure: true, capture: { ...capture, projectLog } });
    expect(paramsOf(both, 'reply').properties.captured).toBeDefined();
    expect(paramsOf(both, 'reply').properties.project_logs).toBeDefined();
    expect(paramsOf(both, 'no_reply').properties.project_logs).toBeUndefined();
    // Hằng gốc / lượt "Không đạt" không đổi.
    expect(paramsOf(CHATBOT_TOOLS, 'reply').properties.project_logs).toBeUndefined();
    expect(paramsOf(STAFF_REJECT_TOOLS, 'reply').properties.project_logs).toBeUndefined();
  });

  it('khai báo chỉ dùng từ khóa JSON Schema quen thuộc (type/description/properties/items/maxItems)', () => {
    const tools = buildChatbotTools({ escalateWhenUnsure: true, capture: logOn });
    const allowed = new Set(['type', 'description', 'properties', 'items', 'maxItems']);
    const walk = (node: Record<string, unknown>) => {
      for (const k of Object.keys(node)) expect(allowed.has(k)).toBe(true);
      if (node.items) walk(node.items as Record<string, unknown>);
      for (const child of Object.values((node.properties ?? {}) as Record<string, Record<string, unknown>>))
        walk(child);
    };
    walk(paramsOf(tools, 'reply').properties.project_logs as unknown as Record<string, unknown>);
  });
});

describe('project_logs — parse lỏng', () => {
  it('normalizeProjectLogsArg: bỏ phần tử sai dạng / rỗng, khóa sai, giá trị không phải chuỗi; tối đa 5 phần tử', () => {
    expect(
      normalizeProjectLogsArg([
        {
          dia_chi: ' 252 Đ. Nguyễn Thái Bình\n Q.1 ',
          nha_thau: 'TVL',
          sdt_nha_thau: 937549534,
          'Bad-Key': 'x',
        },
        'rác',
        null,
        { dia_chi: '   ' },
        { ngay_chup: '09/11/2026' },
      ]),
    ).toEqual([{ dia_chi: '252 Đ. Nguyễn Thái Bình Q.1', nha_thau: 'TVL' }, { ngay_chup: '09/11/2026' }]);
    // Object đơn ⇒ một phần tử.
    expect(normalizeProjectLogsArg({ dia_chi: 'A' })).toEqual([{ dia_chi: 'A' }]);
    for (const v of [undefined, null, 'chuỗi', 42, [], [{}], [null, 'x']])
      expect(normalizeProjectLogsArg(v)).toBeUndefined();
    const many = Array.from({ length: 8 }, (_, i) => ({ dia_chi: `Số ${i}` }));
    expect(normalizeProjectLogsArg(many)).toHaveLength(5);
  });

  it('reply / escalate: project_logs sai dạng vẫn parse được args', () => {
    const bad = replyArgsSchema.safeParse({ messages: ['Dạ'], confidence: 0.9, project_logs: 'rác' });
    expect(bad.success).toBe(true);
    expect(bad.success && bad.data.project_logs).toBeUndefined();
    expect(
      replyArgsSchema.parse({ messages: ['Dạ'], confidence: 0.9, project_logs: [{ dia_chi: 'A' }] })
        .project_logs,
    ).toEqual([{ dia_chi: 'A' }]);
    expect(
      escalateArgsSchema.parse({
        reason_code: 'human_request',
        summary_for_agent: 'x',
        project_logs: [{ nha_thau: 'TVL', x: 1 }],
      }).project_logs,
    ).toEqual([{ nha_thau: 'TVL' }]);
    // no_reply không nhận project_logs (bị bỏ qua).
    expect(noReplyArgsSchema.parse({ reason: 'ok', project_logs: [{ dia_chi: 'A' }] })).toEqual({
      reason: 'ok',
    });
  });
});
