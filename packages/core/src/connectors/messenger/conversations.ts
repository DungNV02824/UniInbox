// Đọc hội thoại Messenger qua Conversations API (docs/research/messenger-platform.md §13).
// CHỈ GET. Token ở header Authorization + appsecret_proof; phân trang bằng cursors.after
// (KHÔNG gọi thẳng paging.next). Graph bỏ qua tham số `since` trên cả hai edge => lọc phía mình:
// kết quả sắp mới nhất trước, gặp mục cũ hơn `since` thì dừng.
import type { MessengerConfig } from './config';
import { mapReadError, networkReadError } from './errors';
import { GraphNetworkError, graphRequest, type GraphResponse } from './graph';
import { appSecretProof } from './oauth';

export const MESSENGER_CONVERSATION_FIELDS = 'id,updated_time,message_count,participants';
export const MESSENGER_THREAD_MESSAGE_FIELDS =
  'id,message,from,to,created_time,' +
  'attachments{id,mime_type,name,file_url,image_data{url,width,height},video_data{url}},' +
  'sticker,shares{link,name}';

/** Người tham gia / người gửi (PSID của khách, hoặc id Page). */
export interface GraphPerson {
  id: string;
  name?: string;
}

export interface MessengerConversation {
  /** "t_..." */
  id: string;
  updatedTime: Date;
  messageCount: number | null;
  participants: GraphPerson[];
}

export interface MessengerThreadAttachment {
  id?: string;
  mimeType?: string;
  name?: string;
  fileUrl?: string;
  image?: { url: string; width?: number; height?: number };
  videoUrl?: string;
}

export interface MessengerThreadMessage {
  /** "m_..." — trùng mid của webhook và message_id của Send API. */
  id: string;
  text?: string;
  from: GraphPerson;
  to: GraphPerson[];
  createdTime: Date;
  attachments: MessengerThreadAttachment[];
  /** URL ảnh nhãn dán. */
  sticker?: string;
  shares: { link?: string; name?: string }[];
}

export interface ListOptions {
  /** Bỏ mục cũ hơn mốc này và không phân trang tiếp. */
  since?: Date;
  limit: number;
  after?: string;
}

export interface ListPage<T> {
  items: T[];
  /** Cursor trang sau; null = hết (hoặc đã gặp mục cũ hơn `since`). */
  after: string | null;
}

export interface MessengerConversationsReader {
  listConversations(
    token: string,
    pageId: string,
    opts: ListOptions,
  ): Promise<ListPage<MessengerConversation>>;
  listMessages(
    token: string,
    conversationId: string,
    opts: ListOptions,
  ): Promise<ListPage<MessengerThreadMessage>>;
}

// ---------- parse ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;

/** "2026-11-05T15:00:20+0000" -> Date (chuẩn hóa offset +0000 thành +00:00 cho chắc). */
export function parseGraphTime(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const t = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(t) ? new Date(t) : undefined;
}

function dataList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return isObj(value) && Array.isArray(value.data) ? value.data : [];
}

function person(value: unknown): GraphPerson | undefined {
  if (!isObj(value)) return undefined;
  const id = typeof value.id === 'number' ? String(value.id) : str(value.id);
  if (!id) return undefined;
  const name = str(value.name)?.trim();
  return name ? { id, name } : { id };
}

function parseConversation(raw: unknown): MessengerConversation | undefined {
  if (!isObj(raw)) return undefined;
  const id = str(raw.id);
  const updatedTime = parseGraphTime(raw.updated_time);
  if (!id || !updatedTime) return undefined;
  const participants = dataList(raw.participants)
    .map(person)
    .filter((p): p is GraphPerson => !!p);
  const count = raw.message_count;
  return {
    id,
    updatedTime,
    messageCount: typeof count === 'number' && Number.isFinite(count) ? count : null,
    participants,
  };
}

function parseAttachment(raw: unknown): MessengerThreadAttachment | undefined {
  if (!isObj(raw)) return undefined;
  const att: MessengerThreadAttachment = {};
  const id = str(raw.id);
  const mimeType = str(raw.mime_type);
  const name = str(raw.name);
  const fileUrl = str(raw.file_url);
  if (id) att.id = id;
  if (mimeType) att.mimeType = mimeType;
  if (name) att.name = name;
  if (fileUrl) att.fileUrl = fileUrl;
  if (isObj(raw.image_data) && str(raw.image_data.url)) {
    const width = num(raw.image_data.width);
    const height = num(raw.image_data.height);
    att.image = {
      url: str(raw.image_data.url)!,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    };
  }
  if (isObj(raw.video_data) && str(raw.video_data.url)) att.videoUrl = str(raw.video_data.url)!;
  return att;
}

function parseThreadMessage(raw: unknown): MessengerThreadMessage | undefined {
  if (!isObj(raw)) return undefined;
  const id = str(raw.id);
  const from = person(raw.from);
  const createdTime = parseGraphTime(raw.created_time);
  if (!id || !from || !createdTime) return undefined;
  const text = typeof raw.message === 'string' ? raw.message : undefined;
  const sticker = str(raw.sticker);
  return {
    id,
    from,
    to: dataList(raw.to)
      .map(person)
      .filter((p): p is GraphPerson => !!p),
    createdTime,
    attachments: dataList(raw.attachments)
      .map(parseAttachment)
      .filter((a): a is MessengerThreadAttachment => !!a),
    shares: dataList(raw.shares)
      .filter(isObj)
      .map((s) => ({
        ...(str(s.link) ? { link: str(s.link)! } : {}),
        ...(str(s.name) ? { name: str(s.name)! } : {}),
      })),
    ...(text !== undefined ? { text } : {}),
    ...(sticker ? { sticker } : {}),
  };
}

// ---------- gọi Graph ----------

function nextCursor(data: Record<string, unknown>): string | null {
  const paging = data.paging;
  if (!isObj(paging) || !paging.next) return null; // không có `next` => trang cuối
  return isObj(paging.cursors) ? (str(paging.cursors.after) ?? null) : null;
}

async function get(
  config: MessengerConfig,
  token: string,
  path: string,
  query: Record<string, string>,
): Promise<Record<string, unknown>> {
  let res: GraphResponse;
  try {
    res = await graphRequest(config, {
      method: 'GET',
      path,
      token,
      query: { ...query, appsecret_proof: appSecretProof(token, config.appSecret) },
    });
  } catch (err) {
    if (err instanceof GraphNetworkError) throw networkReadError(err.timeout);
    throw err;
  }
  if (!res.ok) throw mapReadError(res.status, res.error);
  return res.data;
}

/** Lấy một trang rồi cắt theo `since` (danh sách sắp mới nhất trước). */
async function listPage<T>(
  config: MessengerConfig,
  token: string,
  path: string,
  query: Record<string, string>,
  opts: ListOptions,
  parse: (raw: unknown) => T | undefined,
  timeOf: (item: T) => Date,
): Promise<ListPage<T>> {
  const q: Record<string, string> = { ...query, limit: String(opts.limit) };
  if (opts.after) q.after = opts.after;
  const data = await get(config, token, path, q);
  const items: T[] = [];
  for (const raw of dataList(data.data)) {
    const item = parse(raw);
    if (!item) continue;
    if (opts.since && timeOf(item).getTime() < opts.since.getTime()) {
      return { items, after: null };
    }
    items.push(item);
  }
  return { items, after: nextCursor(data) };
}

export function createConversationsReader(config: MessengerConfig): MessengerConversationsReader {
  return {
    listConversations(token, pageId, opts) {
      return listPage(
        config,
        token,
        `${encodeURIComponent(pageId)}/conversations`,
        { platform: 'messenger', fields: MESSENGER_CONVERSATION_FIELDS },
        opts,
        parseConversation,
        (c) => c.updatedTime,
      );
    },
    listMessages(token, conversationId, opts) {
      return listPage(
        config,
        token,
        `${encodeURIComponent(conversationId)}/messages`,
        { fields: MESSENGER_THREAD_MESSAGE_FIELDS },
        opts,
        parseThreadMessage,
        (m) => m.createdTime,
      );
    },
  };
}
