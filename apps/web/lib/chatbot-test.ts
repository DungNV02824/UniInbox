// Khung "Chat thử": dựng hội thoại gửi lên API và ghép kết quả của bot. Hàm thuần để test.
import {
  CHATBOT_LIMITS,
  CHATBOT_TEST_IMAGE_MIMES,
  HANDOFF_REASON_LABELS,
  base64DecodedBytes,
  type ChatbotTestImageMime,
  type ChatbotTestRequest,
  type ChatbotTestResult,
} from '@dezon/shared';

/** Ảnh đính kèm tin khách khi chat thử (đã thu nhỏ + nén JPEG ở trình duyệt). */
export interface TestImage {
  id: string;
  mimeType: ChatbotTestImageMime;
  /** base64, không có tiền tố `data:`. */
  data: string;
  /** Tên tệp gốc (chỉ để hiện tooltip). */
  name?: string;
}

export type TestEntry =
  | { id: string; kind: 'customer'; text: string; images?: TestImage[] }
  | { id: string; kind: 'bot'; text: string }
  /** Kết quả một lượt chạy (quyết định, thời gian, model) — không gửi lại lên API. */
  | { id: string; kind: 'outcome'; result: ChatbotTestResult }
  /** Lỗi gọi API (mạng, 4xx/5xx) — không gửi lại lên API. */
  | { id: string; kind: 'failure'; message: string };

let seq = 0;
export function newEntryId(): string {
  seq += 1;
  return `t-${seq}`;
}

type TestMessage = ChatbotTestRequest['messages'][number];

/** Trần của `imageCount` (khớp schema chung: số nguyên 0..100). */
const IMAGE_COUNT_MAX = 100;

interface PreparedMessage {
  role: 'customer' | 'bot';
  text: string;
  /** Ảnh gửi được (đúng định dạng, ≤ 4 MB), đúng thứ tự, tối đa `testImagesMax` ảnh mới nhất của tin. */
  images: TestImage[];
  /** Số ảnh khách đã gửi trong tin (kể cả ảnh hỏng) — để lịch sử ghi đúng "[gửi N ảnh/tệp]". */
  imageCount: number;
}

/** Giữ `n` phần tử cuối (mới nhất), đúng thứ tự. */
function lastN<T>(items: readonly T[], n: number): T[] {
  return n <= 0 ? [] : items.slice(Math.max(0, items.length - n));
}

/** Tin khách/bot sẽ gửi lên API: bỏ dòng trống, cắt độ dài, giữ ≤ 30 tin gần nhất, bắt đầu bằng tin khách. */
function prepareMessages(entries: readonly TestEntry[]): PreparedMessage[] {
  const messages: PreparedMessage[] = [];
  for (const e of entries) {
    if (e.kind !== 'customer' && e.kind !== 'bot') continue;
    const all = e.kind === 'customer' ? (e.images ?? []) : [];
    const images = lastN(
      all.filter((img) => imageIsSendable(img)),
      CHATBOT_LIMITS.testImagesMax,
    );
    const imageCount = Math.min(all.length, IMAGE_COUNT_MAX);
    const text = e.text.trim().slice(0, CHATBOT_LIMITS.testTextMax);
    if (!text && imageCount === 0) continue;
    messages.push({ role: e.kind, text, images, imageCount });
  }
  const recent = messages.slice(-CHATBOT_LIMITS.testMessagesMax);
  const firstCustomer = recent.findIndex((m) => m.role === 'customer');
  return firstCustomer < 0 ? [] : recent.slice(firstCustomer);
}

/** Vị trí bắt đầu chuỗi tin khách ở cuối danh sách (sau tin bot gần nhất). */
function trailingCustomerStart(messages: readonly PreparedMessage[]): number {
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.role === 'customer') start -= 1;
  return start;
}

/**
 * Chia ngân sách `testImagesMax` ảnh cho chuỗi tin khách cuối (lượt bot sắp trả lời), ưu tiên ảnh mới nhất:
 * duyệt từ tin mới nhất về cũ; tin bị cắt dở giữ các ảnh cuối của tin (đúng thứ tự).
 */
function trailingImages(messages: readonly PreparedMessage[]): Map<number, TestImage[]> {
  const kept = new Map<number, TestImage[]>();
  let budget: number = CHATBOT_LIMITS.testImagesMax;
  for (let i = messages.length - 1; i >= trailingCustomerStart(messages) && budget > 0; i -= 1) {
    const imgs = lastN(messages[i]!.images, budget);
    if (imgs.length > 0) kept.set(i, imgs);
    budget -= imgs.length;
  }
  return kept;
}

function toRequest(recent: readonly PreparedMessage[]): ChatbotTestRequest['messages'] {
  const kept = trailingImages(recent);
  return recent.map((m, i): TestMessage => {
    if (m.role !== 'customer' || m.imageCount === 0) return { role: m.role, text: m.text };
    const imgs = kept.get(i) ?? [];
    return {
      role: m.role,
      text: m.text,
      ...(imgs.length > 0 ? { images: imgs.map((img) => ({ mimeType: img.mimeType, data: img.data })) } : {}),
      // Không gửi đủ ảnh (lượt cũ / quá 10 ảnh / ảnh hỏng) => báo đúng số ảnh khách đã gửi.
      ...(imgs.length < m.imageCount ? { imageCount: m.imageCount } : {}),
    };
  });
}

/**
 * Hội thoại gửi lên API: chỉ tin khách/bot, bỏ dòng trống, cắt độ dài tối đa, giữ tối đa N tin gần nhất
 * (API giới hạn 30) và luôn bắt đầu bằng tin khách.
 *
 * Ảnh giống luồng thật: chỉ chuỗi tin khách cuối (sau tin bot gần nhất — lượt bot sắp trả lời) gửi kèm dữ
 * liệu ảnh, tổng tối đa `testImagesMax` (ưu tiên ảnh mới nhất). Tin cũ hơn KHÔNG gửi lại ảnh, chỉ gửi
 * `imageCount` để lịch sử ghi đúng "[gửi N ảnh/tệp]". Tin nào không gửi đủ ảnh (bị cắt bớt / ảnh hỏng) cũng
 * kèm `imageCount` = số ảnh thật. Tin chỉ có ảnh để `text` trống. Tin rơi khỏi 30 tin gần nhất mất luôn.
 */
export function buildTestMessages(entries: readonly TestEntry[]): ChatbotTestRequest['messages'] {
  return toRequest(prepareMessages(entries));
}

/**
 * Ảnh của lượt gần nhất (chuỗi tin khách cuối cùng, tính đúng như lúc gửi lượt đó): khách gửi `total` ảnh,
 * bot thực sự nhận `sent` ảnh. Dùng cho dòng nhắc "Bot chỉ xem N ảnh gần nhất".
 */
export function lastTurnImageStats(entries: readonly TestEntry[]): { total: number; sent: number } {
  // Dựng lại request của lượt đó: hội thoại tới tin khách cuối cùng.
  let end = entries.length;
  while (end > 0 && entries[end - 1]!.kind !== 'customer') end -= 1;
  const recent = prepareMessages(entries.slice(0, end));
  let total = 0;
  for (const m of recent.slice(trailingCustomerStart(recent))) total += m.imageCount;
  return { total, sent: countSentImages(toRequest(recent)) };
}

// ---------- Ảnh ----------

export { base64DecodedBytes };

/** Ảnh đủ điều kiện gửi: đúng định dạng, có dữ liệu, không quá `testImageMaxBytes` sau giải mã. */
export function imageIsSendable(img: Pick<TestImage, 'mimeType' | 'data'>): boolean {
  if (!(CHATBOT_TEST_IMAGE_MIMES as readonly string[]).includes(img.mimeType)) return false;
  const bytes = base64DecodedBytes(img.data);
  return bytes > 0 && bytes <= CHATBOT_LIMITS.testImageMaxBytes;
}

/** Tệp gốc lớn hơn mức này thì không cố thu nhỏ (tránh treo trình duyệt). */
export const TEST_IMAGE_SOURCE_MAX_BYTES = 30 * 1024 * 1024;

/** Cạnh dài tối đa sau khi thu nhỏ, chất lượng JPEG. */
export const TEST_IMAGE_MAX_SIDE = 1600;
export const TEST_IMAGE_QUALITY = 0.85;

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toLocaleString('vi-VN', { maximumFractionDigits: 0 })} MB`;
}

/** Kiểm tra tệp chọn/dán/kéo vào trước khi thu nhỏ. null = hợp lệ; ngược lại là câu báo lỗi tiếng Việt. */
export function checkImageFile(file: { name?: string; type: string; size: number }): string | null {
  const label = file.name ? `“${file.name}”` : 'Tệp này';
  if (!file.type.startsWith('image/'))
    return `${label} không phải là ảnh. Chỉ đính kèm được tệp ảnh (JPG, PNG…).`;
  if (file.size <= 0) return `${label} bị rỗng, vui lòng chọn ảnh khác.`;
  if (file.size > TEST_IMAGE_SOURCE_MAX_BYTES)
    return `${label} quá lớn (tối đa ${formatMb(TEST_IMAGE_SOURCE_MAX_BYTES)}). Vui lòng chọn ảnh nhỏ hơn.`;
  return null;
}

/** Câu báo khi ảnh đã nén vẫn vượt giới hạn gửi. */
export function imageTooLargeMessage(name?: string): string {
  return `${name ? `“${name}”` : 'Ảnh'} vẫn quá lớn sau khi nén (tối đa ${formatMb(
    CHATBOT_LIMITS.testImageMaxBytes,
  )}). Vui lòng chọn ảnh khác.`;
}

/** Kích thước sau khi thu nhỏ để cạnh dài không quá `maxSide` (không phóng to ảnh nhỏ). */
export function fitWithin(
  width: number,
  height: number,
  maxSide = TEST_IMAGE_MAX_SIDE,
): {
  width: number;
  height: number;
} {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const long = Math.max(width, height);
  if (long <= maxSide) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxSide / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Thêm ảnh vào hàng chờ của tin sắp gửi, tối đa `testImagesMax`.
 * Trả về danh sách mới + số ảnh bị bỏ vì quá giới hạn.
 */
export function addPendingImages(
  current: readonly TestImage[],
  incoming: readonly TestImage[],
  max: number = CHATBOT_LIMITS.testImagesMax,
): { images: TestImage[]; dropped: number } {
  const room = Math.max(0, max - current.length);
  return { images: [...current, ...incoming.slice(0, room)], dropped: Math.max(0, incoming.length - room) };
}

/** "Chỉ đính kèm tối đa 10 ảnh mỗi tin — đã bỏ 2 ảnh." */
export function tooManyImagesMessage(dropped: number): string {
  return `Mỗi tin chỉ đính kèm tối đa ${CHATBOT_LIMITS.testImagesMax} ảnh — đã bỏ ${dropped} ảnh.`;
}

/** Ảnh sẽ hiện được trong <img>. */
export function imageSrc(img: Pick<TestImage, 'mimeType' | 'data'>): string {
  return `data:${img.mimeType};base64,${img.data}`;
}

/** Số ảnh thực sự được gửi cho bot ở lượt tới (sau giới hạn 30 tin + tổng 10 ảnh). */
export function countSentImages(messages: ChatbotTestRequest['messages']): number {
  return messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
}

/**
 * Ghép kết quả: mỗi tin khách nhận được (trả lời, hoặc tin bot gửi khi chuyển người) thành một bong bóng bot
 * — lượt sau được gửi lại lên API với role 'bot' — rồi một dòng kết quả (badge/thời gian/model).
 */
export function appendResult(
  entries: readonly TestEntry[],
  result: ChatbotTestResult,
  makeId: () => string = newEntryId,
): TestEntry[] {
  const bubbles: TestEntry[] = customerFacingMessages(result).map((text) => ({
    id: makeId(),
    kind: 'bot' as const,
    text,
  }));
  return [...entries, ...bubbles, { id: makeId(), kind: 'outcome', result }];
}

/**
 * Tin khách thực sự nhận được: 'reply' => các bong bóng trả lời; 'escalate' => tin bot gửi khi chuyển người
 * (`messages`, có thể rỗng); 'no_reply' / lỗi => không có gì.
 */
export function customerFacingMessages(result: ChatbotTestResult): string[] {
  if (result.decision !== 'reply' && result.decision !== 'escalate') return [];
  return (result.messages ?? []).map((t) => t.trim()).filter(Boolean);
}

export interface OutcomeView {
  tone: 'reply' | 'handoff' | 'silent' | 'error';
  /** Dòng chính của badge; null với 'reply' (chỉ hiện thời gian + model). */
  title: string | null;
  detail: string | null;
  /** Ghi chú phụ màu xám dưới badge (vd. chuyển người mà khách không nhận tin nào). */
  note: string | null;
}

export const HANDOFF_NO_MESSAGE_NOTE = 'Khách không nhận tin nào (chưa đặt Tin nhắn khi chuyển người)';

/** "Chuyển người thật: <lý do> — <tóm tắt>", "Không trả lời: <lý do>", lỗi... */
export function describeOutcome(result: ChatbotTestResult): OutcomeView {
  switch (result.decision) {
    case 'reply':
      return {
        tone: 'reply',
        title: customerFacingMessages(result).length > 0 ? null : 'Bot không có nội dung trả lời',
        detail: null,
        note: null,
      };
    case 'escalate': {
      const reason = result.reasonCode ? HANDOFF_REASON_LABELS[result.reasonCode] : 'Lý do khác';
      return {
        tone: 'handoff',
        title: `Chuyển người thật: ${reason}`,
        detail: result.summary?.trim() || null,
        note: customerFacingMessages(result).length > 0 ? null : HANDOFF_NO_MESSAGE_NOTE,
      };
    }
    case 'no_reply':
      return {
        tone: 'silent',
        title: `Không trả lời${result.reason?.trim() ? `: ${result.reason.trim()}` : ''}`,
        detail: null,
        note: 'Khách không nhận tin nào',
      };
    default:
      return {
        tone: 'error',
        title: 'Bot gặp lỗi khi trả lời',
        detail: result.reason?.trim() || null,
        note: null,
      };
  }
}

/** 850 => "850 ms"; 1234 => "1,2 giây". */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} giây`;
}

/** "1,2 giây · gemini-2.5-flash · 1.234 token". */
export function outcomeMeta(result: ChatbotTestResult): string {
  const parts = [formatLatency(result.latencyMs), result.model];
  if (result.usage) {
    const total = result.usage.inputTokens + result.usage.outputTokens;
    if (total > 0) parts.push(`${total.toLocaleString('vi-VN')} token`);
  }
  return parts.filter(Boolean).join(' · ');
}

/** Số tin trong hội thoại thử đã chạm giới hạn gửi lên API chưa (để nhắc "Làm mới"). */
export function transcriptIsLong(entries: readonly TestEntry[]): boolean {
  return (
    entries.filter((e) => e.kind === 'customer' || e.kind === 'bot').length >= CHATBOT_LIMITS.testMessagesMax
  );
}
