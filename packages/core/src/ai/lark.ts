// Thông báo Lark qua Custom Bot webhook (interactive card), ký HMAC nếu có secret.
import { createHmac } from 'node:crypto';
import { LarkNotifyError } from './errors';
import type { LarkConfig } from './settings';

export interface HandoffCardInput {
  contactName: string;
  channelName: string;
  /** Nhãn tiếng Việt (HANDOFF_REASON_LABELS[reasonCode]). */
  reasonLabel: string;
  summary: string;
  /** `${APP_URL}/inbox/<conversationId>` */
  conversationUrl: string;
  /** Thẻ nhắc lại (chưa ai nhận sau HANDOFF_ESCALATE_AFTER_MIN). */
  reminder?: boolean;
  /** Thẻ thử từ POST /settings/lark/test. */
  test?: boolean;
}

/** Body JSON gửi tới webhook (msg_type 'interactive' + card). */
export interface LarkCardMessage {
  msg_type: 'interactive';
  card: Record<string, unknown>;
}

const LARK_MD_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '*': '&#42;',
  '~': '&#126;',
  '[': '&#91;',
  ']': '&#93;',
  _: '&#95;',
};

/** Escape ký tự đặc biệt của lark_md để tên/tóm tắt do khách/AI tạo không phá định dạng thẻ. */
export function escapeLarkMd(text: string): string {
  return text.replace(/[&<>*~[\]_]/g, (c) => LARK_MD_ESCAPES[c] ?? c);
}

function mdField(label: string, value: string, short: boolean) {
  const v = value.trim() || '—';
  return { is_short: short, text: { tag: 'lark_md', content: `**${label}:**\n${escapeLarkMd(v)}` } };
}

/**
 * Thẻ Lark: header (đỏ "🔔 Cần người xử lý" / cam "⏰ Nhắc lại: chưa ai nhận" / xanh "Thử kết nối Lark"),
 * các dòng Khách, Kênh, Lý do, Tóm tắt (lark_md, đã escape), nút "Mở hội thoại" (url = conversationUrl).
 */
export function buildHandoffLarkCard(input: HandoffCardInput): LarkCardMessage {
  const header = input.test
    ? { title: '✅ Thử kết nối Lark — Dezon Inbox', template: 'green' }
    : input.reminder
      ? { title: '⏰ Nhắc lại: chưa ai nhận hội thoại', template: 'orange' }
      : { title: '🔔 Cần người xử lý', template: 'red' };
  const elements: Record<string, unknown>[] = [
    {
      tag: 'div',
      fields: [
        mdField('Khách', input.contactName, true),
        mdField('Kênh', input.channelName, true),
        mdField('Lý do', input.reasonLabel, false),
        mdField('Tóm tắt', input.summary, false),
      ],
    },
  ];
  if (input.test) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: 'Đây là thẻ thử — cấu hình Lark đang hoạt động.' }],
    });
  }
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: 'Mở hội thoại' },
        type: input.reminder || input.test ? 'default' : 'primary',
        url: input.conversationUrl,
      },
    ],
  });
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: header.title }, template: header.template },
      elements,
    },
  };
}

export interface HandoffActionCardInput {
  /** 'ack' = nút "nhận" (vd. "Nghiệm thu"); 'resolve' = nút "xong" (vd. "Đã chuyển tiền"). */
  action: 'ack' | 'resolve';
  /** Tên nút nhân viên vừa bấm (tên riêng của bot hoặc mặc định). */
  buttonLabel: string;
  contactName: string;
  channelName: string;
  chatbotName: string;
  /** Tên nhân viên đã bấm. */
  actorName: string;
  /** Giờ bấm, đã định dạng (giờ Việt Nam). */
  at: string;
  /** Tóm tắt các yêu cầu chuyển người liên quan (vd. công trình + số ảnh + thù lao). */
  summaries: string[];
  conversationUrl: string;
}

/**
 * Thẻ Lark khi nhân viên bấm nút trên banner "Cần người" (bot bật handoffActionLark): header xanh lá
 * "✅ <tên nút>" (ack) / xanh dương "☑️ <tên nút>" (resolve), các dòng Khách, Kênh, Bot, Người bấm, Lúc,
 * Nội dung (lark_md, đã escape), nút "Mở hội thoại".
 */
export function buildHandoffActionLarkCard(input: HandoffActionCardInput): LarkCardMessage {
  const header =
    input.action === 'ack'
      ? { title: `✅ ${input.buttonLabel}`, template: 'green' }
      : { title: `☑️ ${input.buttonLabel}`, template: 'blue' };
  const content =
    input.summaries.length > 1
      ? input.summaries.map((s, i) => `${i + 1}. ${s.trim()}`).join('\n')
      : (input.summaries[0] ?? '');
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: header.title }, template: header.template },
      elements: [
        {
          tag: 'div',
          fields: [
            mdField('Khách', input.contactName, true),
            mdField('Kênh', input.channelName, true),
            mdField('Bot', input.chatbotName, true),
            mdField('Người bấm', input.actorName, true),
            mdField('Lúc', input.at, true),
            mdField('Nội dung', content, false),
          ],
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Mở hội thoại' },
              type: 'default',
              url: input.conversationUrl,
            },
          ],
        },
      ],
    },
  };
}

export interface NotifyLarkOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  /** Mặc định 10_000. */
  timeoutMs?: number;
}

/** Chữ ký Lark Custom Bot: base64(HMAC-SHA256(key = `${timestamp}\n${secret}`, message = '')). */
export function signLarkWebhook(timestampSec: number, secret: string): string {
  return createHmac('sha256', `${timestampSec}\n${secret}`).update('').digest('base64');
}

interface LarkResponseBody {
  code?: unknown;
  msg?: unknown;
  StatusCode?: unknown;
  StatusMessage?: unknown;
}

/**
 * POST JSON tới settings.webhookUrl. Có secret ⇒ thêm `timestamp` (giây) và
 * `sign` = base64(HMAC-SHA256(key = `${timestamp}\n${secret}`, message = '')) theo tài liệu Lark.
 * HTTP ≠ 2xx, body.code ≠ 0 (hoặc StatusCode ≠ 0), timeout hay lỗi mạng ⇒ LarkNotifyError
 * (tiếng Việt, không chứa secret).
 */
export async function notifyLark(
  settings: LarkConfig,
  card: LarkCardMessage,
  options?: NotifyLarkOptions,
): Promise<void> {
  const doFetch = options?.fetch ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const body: Record<string, unknown> = { ...card };
  if (settings.secret) {
    const timestamp = Math.floor((options?.now?.() ?? new Date()).getTime() / 1000);
    body.timestamp = String(timestamp);
    body.sign = signLarkWebhook(timestamp, settings.secret);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await doFetch(settings.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    if (timedOut) throw new LarkNotifyError(`Lark không phản hồi sau ${Math.round(timeoutMs / 1000)}s`);
    const reason = err instanceof Error ? err.message : String(err);
    throw new LarkNotifyError(`Không kết nối được tới Lark: ${reason.slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }

  let parsed: LarkResponseBody | null = null;
  try {
    parsed = text ? (JSON.parse(text) as LarkResponseBody) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const msg = typeof parsed?.msg === 'string' ? `: ${parsed.msg.slice(0, 200)}` : '';
    throw new LarkNotifyError(`Lark trả lỗi HTTP ${res.status}${msg}`);
  }
  const code = parsed?.code ?? parsed?.StatusCode;
  if (code !== undefined && code !== 0) {
    const rawMsg = parsed?.msg ?? parsed?.StatusMessage;
    const msg = typeof rawMsg === 'string' ? rawMsg.slice(0, 200) : 'không rõ';
    throw new LarkNotifyError(`Lark từ chối tin (mã ${String(code)}): ${msg}`);
  }
}
