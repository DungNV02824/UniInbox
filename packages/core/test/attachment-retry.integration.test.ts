// Test tích hợp tự tải lại tệp tin đến bị hỏng (storage_key ''): Postgres thật (Testcontainers), fetch/kho giả.
import { conversations, messages, type ChannelAccount, type Conversation, type Db } from '@dezon/db';
import type { MessageAttachment } from '@dezon/shared';
import { DrizzleQueryError, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessageDto } from '../src/inbox/queries';
import { processInboundMessage } from '../src/pipeline/inbound';
import {
  ATTACHMENT_RETRY_MAX_ATTEMPTS,
  ATTACHMENT_RETRY_MAX_FREE_STORE_ERRORS,
  retryFailedAttachments,
  type AttachmentRetryDeps,
} from '../src/pipeline/attachment-retry';
import type { PipelineDeps } from '../src/pipeline/types';
import type { RealtimePublisher } from '../src/realtime';
import { createMemoryStorage, type MemoryStorage } from './helpers/memory-storage';
import {
  addMessage,
  createChannel,
  createConversation,
  makeCtx,
  startTestDb,
  type TestDb,
} from './inbox-fixtures';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const OK_URL = 'https://cdn.test/ok.jpg';
const OK2_URL = 'https://cdn.test/ok2.jpg';
const DOWN_URL = 'https://cdn.test/down.jpg';
const GONE_URL = 'https://cdn.test/gone.jpg';
/** https://cdn.test/status/<mã> ⇒ CDN trả mã đó. */
const statusUrl = (status: number) => `https://cdn.test/status/${status}`;

let t: TestDb;
let db: Db;
let channel: ChannelAccount;
let jpeg: Buffer;
let storage: MemoryStorage;
let published: { rooms: string[]; event: string; payload: unknown }[];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let hook: ReturnType<typeof vi.fn<NonNullable<PipelineDeps['onCustomerMessageStored']>>>;
let deps: AttachmentRetryDeps & Pick<PipelineDeps, 'onCustomerMessageStored'>;

function respond(url: string): Response {
  if (url === OK_URL || url === OK2_URL) {
    return new Response(new Uint8Array(jpeg), { headers: { 'content-type': 'image/jpeg' } });
  }
  if (url === GONE_URL) return new Response('gone', { status: 404 });
  const status = /\/status\/(\d{3})$/.exec(url)?.[1];
  if (status) return new Response('x', { status: Number(status) });
  return new Response('busy', { status: 503 });
}

const failed = (url: string, extra: Partial<MessageAttachment> = {}): MessageAttachment => ({
  type: 'image',
  storage_key: '',
  mime: 'image/jpeg',
  original_url: url,
  ...extra,
});

async function conversationWith(sentAt: Date, savedAt: Date): Promise<Conversation> {
  return createConversation(db, {
    channel,
    lastMessageAt: sentAt,
    lastCustomerMessageAt: sentAt,
    createdAt: savedAt,
    updatedAt: savedAt,
  });
}

/** Tin khách có tệp hỏng; `savedAt` = lúc lưu tin (created_at, mặc định = sentAt như tin webhook). */
async function failedMessage(
  attachments: MessageAttachment[],
  sentAt = new Date(Date.now() - MINUTE),
  savedAt = sentAt,
) {
  const conv = await conversationWith(sentAt, savedAt);
  const id = await addMessage(db, conv, {
    sentAt,
    createdAt: savedAt,
    updatedAt: savedAt,
    text: 'Ảnh mẫu nhà em',
    attachments,
  });
  return { id, conv };
}

async function attachmentsOf(id: string): Promise<MessageAttachment[]> {
  const [row] = await db.select({ a: messages.attachments }).from(messages).where(eq(messages.id, id));
  return row!.a;
}

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
  channel = await createChannel(db);
  jpeg = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#36c' } })
    .jpeg()
    .toBuffer();
});

afterAll(async () => {
  await t?.stop();
});

beforeEach(async () => {
  // Quét là toàn cục ⇒ mỗi test bắt đầu với bảng tin trống.
  await db.delete(messages);
  storage = createMemoryStorage();
  published = [];
  fetchMock = vi.fn<typeof fetch>(async (input) => respond(String(input)));
  hook = vi.fn(async () => undefined);
  const publisher: RealtimePublisher = {
    emit: (rooms, event, payload) => published.push({ rooms, event, payload }),
  };
  deps = {
    storage,
    publisher,
    ctx: makeCtx(),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    maxMediaBytes: 25 * 1024 * 1024,
    fetch: fetchMock,
    onCustomerMessageStored: hook,
  };
});

describe('retryFailedAttachments', () => {
  it('tải lại thành công: thay phần tử hỏng bằng tệp đã lưu, phát message.updated, không đụng chatbot', async () => {
    const { id, conv } = await failedMessage([failed(OK_URL, { name: 'nha-mau.jpg' })]);
    const before = await db.select().from(messages).where(eq(messages.id, id));

    const result = await retryFailedAttachments(db, deps);

    expect(result).toMatchObject({ candidates: 1, messages: 1, repaired: 1, failed: 0, exhausted: 0 });
    const [att] = await attachmentsOf(id);
    expect(att!.storage_key).toMatch(/^media\/\d{4}\/\d{2}\/.+\.jpg$/);
    expect(storage.objects.has(att!.storage_key)).toBe(true);
    expect(att).toMatchObject({
      type: 'image',
      mime: 'image/jpeg',
      width: 1600,
      height: 800,
      original_url: OK_URL,
    });
    expect(att!.name).toBe('nha-mau.jpg');
    expect(att).not.toHaveProperty('retry_count');
    expect(att).not.toHaveProperty('last_retry_at');

    const [after] = await db.select().from(messages).where(eq(messages.id, id));
    expect(after).toMatchObject({
      text: before[0]!.text,
      status: before[0]!.status,
      sentAt: before[0]!.sentAt,
    });

    expect(published.map((p) => p.event)).toEqual(['message.updated']);
    expect(published[0]!.rooms.sort()).toEqual(['pool:unassigned', 'role:admin']);
    const payload = published[0]!.payload as {
      message: { id: string; attachments: { url: string | null }[] };
    };
    expect(payload.message.id).toBe(id);
    expect(payload.message.attachments[0]!.url).toBe(`https://signed.test/${att!.storage_key}`);
    // Chỉ ghi kho: không gọi hook chatbot, không đổi hội thoại.
    expect(hook).not.toHaveBeenCalled();
    const [convAfter] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(convAfter).toMatchObject({ unreadCount: conv.unreadCount, lastMessageAt: conv.lastMessageAt });

    // Lượt sau không còn gì để làm.
    fetchMock.mockClear();
    expect(await retryFailedAttachments(db, deps)).toMatchObject({ candidates: 0, messages: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('một trong hai tệp: tệp được thay, tệp còn lỗi tăng retry_count, DTO báo "đang tải lại"', async () => {
    const now = new Date();
    const { id } = await failedMessage([
      failed(OK_URL),
      failed(DOWN_URL, { type: 'video', mime: 'video/mp4' }),
    ]);

    const result = await retryFailedAttachments(db, deps, { now });

    expect(result).toMatchObject({ messages: 1, repaired: 1, failed: 1, exhausted: 0 });
    const [first, second] = await attachmentsOf(id);
    expect(first!.storage_key).not.toBe('');
    expect(second).toEqual({
      type: 'video',
      storage_key: '',
      mime: 'video/mp4',
      original_url: DOWN_URL,
      retry_count: 1,
      last_retry_at: now.toISOString(),
    });
    expect(published.map((p) => p.event)).toEqual(['message.updated']);

    const dto = await getMessageDto(db, id, makeCtx());
    expect(dto.attachments[0]!.url).not.toBeNull();
    expect(dto.attachments[0]).not.toHaveProperty('retrying');
    expect(dto.attachments[1]).toMatchObject({ url: null, retrying: true });
  });

  it('vẫn lỗi: backoff 2^n phút giữa các lần, không phát realtime', async () => {
    const base = new Date();
    const { id } = await failedMessage([failed(DOWN_URL)]);

    expect(await retryFailedAttachments(db, deps, { now: base })).toMatchObject({ messages: 1, failed: 1 });
    expect((await attachmentsOf(id))[0]!.retry_count).toBe(1);

    // retry_count 1 ⇒ chờ 2 phút.
    fetchMock.mockClear();
    const early = new Date(base.getTime() + MINUTE + 59_000);
    expect(await retryFailedAttachments(db, deps, { now: early })).toMatchObject({ candidates: 0 });
    expect(fetchMock).not.toHaveBeenCalled();

    const second = new Date(base.getTime() + 2 * MINUTE);
    expect(await retryFailedAttachments(db, deps, { now: second })).toMatchObject({ messages: 1, failed: 1 });
    expect(await attachmentsOf(id)).toEqual([
      failed(DOWN_URL, { retry_count: 2, last_retry_at: second.toISOString() }),
    ]);

    // retry_count 2 ⇒ chờ 4 phút.
    const tooSoon = new Date(second.getTime() + 3 * MINUTE);
    expect(await retryFailedAttachments(db, deps, { now: tooSoon })).toMatchObject({ candidates: 0 });
    const third = new Date(second.getTime() + 4 * MINUTE);
    expect(await retryFailedAttachments(db, deps, { now: third })).toMatchObject({ messages: 1 });
    expect((await attachmentsOf(id))[0]!.retry_count).toBe(3);
    expect(published).toHaveLength(0);
  });

  it('CDN trả 404 (link hết hạn): đánh dấu bỏ hẳn, không thử lại, DTO không còn "đang tải lại"', async () => {
    const now = new Date();
    const { id } = await failedMessage([failed(GONE_URL)]);

    expect(await retryFailedAttachments(db, deps, { now })).toMatchObject({ messages: 1, exhausted: 1 });
    expect(await attachmentsOf(id)).toEqual([
      failed(GONE_URL, { retry_count: 1, last_retry_at: now.toISOString(), retry_exhausted: true }),
    ]);
    // Giao diện đổi nhãn ⇒ có phát message.updated.
    expect(published.map((p) => p.event)).toEqual(['message.updated']);

    fetchMock.mockClear();
    const later = new Date(now.getTime() + DAY);
    expect(await retryFailedAttachments(db, deps, { now: later })).toMatchObject({ candidates: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    const dto = await getMessageDto(db, id, makeCtx());
    expect(dto.attachments[0]).toMatchObject({ url: null });
    expect(dto.attachments[0]).not.toHaveProperty('retrying');
  });

  it('tệp vượt giới hạn dung lượng là lỗi vĩnh viễn', async () => {
    const { id } = await failedMessage([failed(OK_URL)]);
    expect(await retryFailedAttachments(db, { ...deps, maxMediaBytes: 100 })).toMatchObject({ exhausted: 1 });
    expect((await attachmentsOf(id))[0]!.retry_exhausted).toBe(true);
  });

  it.each([403, 404, 410])('CDN trả %i ⇒ bỏ hẳn ngay lần đầu', async (status) => {
    const { id } = await failedMessage([failed(statusUrl(status))]);
    expect(await retryFailedAttachments(db, deps)).toMatchObject({ messages: 1, exhausted: 1, failed: 0 });
    expect((await attachmentsOf(id))[0]).toMatchObject({ retry_count: 1, retry_exhausted: true });
  });

  it.each([429, 500, 503])('CDN trả %i ⇒ tạm thời: tăng retry_count, chưa bỏ hẳn', async (status) => {
    const { id } = await failedMessage([failed(statusUrl(status))]);
    expect(await retryFailedAttachments(db, deps)).toMatchObject({ messages: 1, failed: 1, exhausted: 0 });
    const [att] = await attachmentsOf(id);
    expect(att).toMatchObject({ retry_count: 1 });
    expect(att).not.toHaveProperty('retry_exhausted');
  });

  it('hết lượt: lần thứ MAX vẫn lỗi ⇒ bỏ hẳn; đã đủ MAX lần thì không lấy nữa', async () => {
    const longAgo = new Date(Date.now() - 6 * 60 * MINUTE).toISOString();
    const last = await failedMessage([
      failed(DOWN_URL, { retry_count: ATTACHMENT_RETRY_MAX_ATTEMPTS - 1, last_retry_at: longAgo }),
    ]);
    const done = await failedMessage([
      failed(OK_URL, { retry_count: ATTACHMENT_RETRY_MAX_ATTEMPTS, last_retry_at: longAgo }),
    ]);

    const result = await retryFailedAttachments(db, deps);

    expect(result).toMatchObject({ candidates: 1, messages: 1, exhausted: 1, repaired: 0 });
    expect((await attachmentsOf(last.id))[0]).toMatchObject({
      retry_count: ATTACHMENT_RETRY_MAX_ATTEMPTS,
      retry_exhausted: true,
    });
    // Tin đã đủ lượt (worker cũ chết giữa chừng chẳng hạn) không bị đụng tới.
    expect(await attachmentsOf(done.id)).toEqual([
      failed(OK_URL, { retry_count: ATTACHMENT_RETRY_MAX_ATTEMPTS, last_retry_at: longAgo }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('nơi khác đã sửa tệp trong lúc tải: không đè, xóa tệp vừa lưu; tệp còn hỏng vẫn được thay', async () => {
    const { id } = await failedMessage([failed(OK_URL), failed(OK2_URL)]);
    const fixedByOther: MessageAttachment = {
      type: 'image',
      storage_key: 'media/2026/11/other.jpg',
      mime: 'image/jpeg',
      original_url: OK_URL,
    };
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === OK_URL) {
        // Giữa lúc nhận lượt và lúc ghi kết quả, một tiến trình khác đã sửa phần tử đầu.
        const current = await attachmentsOf(id);
        await db
          .update(messages)
          .set({ attachments: [fixedByOther, current[1]!] })
          .where(eq(messages.id, id));
      }
      return respond(url);
    });

    const result = await retryFailedAttachments(db, deps);

    expect(result).toMatchObject({ messages: 1, repaired: 1, superseded: 1 });
    const [first, second] = await attachmentsOf(id);
    expect(first).toEqual(fixedByOther);
    expect(second!.storage_key).toMatch(/^media\//);
    expect(second!.original_url).toBe(OK2_URL);
    // Chỉ còn tệp của phần tử thứ hai trong kho (tệp thừa của phần tử đầu đã xóa).
    expect([...storage.objects.keys()]).toEqual([second!.storage_key]);
  });

  it('đồng bộ lịch sử: tin gửi 10 ngày trước nhưng vừa lưu (link CDN mới) vẫn được tải lại', async () => {
    const sentAt = new Date(Date.now() - 10 * DAY);
    const { id } = await failedMessage([failed(OK_URL)], sentAt, new Date());
    expect((await getMessageDto(db, id, makeCtx())).attachments[0]).toMatchObject({
      url: null,
      retrying: true,
    });

    expect(await retryFailedAttachments(db, deps)).toMatchObject({ candidates: 1, repaired: 1 });
    expect((await attachmentsOf(id))[0]!.storage_key).toMatch(/^media\//);
  });

  it('chỉ tin trong cửa sổ 3 ngày; tin cũ hơn không tải và DTO không báo "đang tải lại"', async () => {
    const old = await failedMessage([failed(OK_URL)], new Date(Date.now() - 4 * DAY));
    const recent = await failedMessage([failed(OK2_URL)], new Date(Date.now() - 2 * DAY));

    const result = await retryFailedAttachments(db, deps);

    expect(result).toMatchObject({ candidates: 1, repaired: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(OK2_URL);
    expect(await attachmentsOf(old.id)).toEqual([failed(OK_URL)]);
    expect((await attachmentsOf(recent.id))[0]!.storage_key).not.toBe('');
    const dto = await getMessageDto(db, old.id, makeCtx());
    expect(dto.attachments[0]).not.toHaveProperty('retrying');
  });

  it('kho lỗi khi ghi: không tính lượt, dừng lượt quét (không dội kho đang hỏng)', async () => {
    const now = new Date();
    const a = await failedMessage([failed(OK_URL)], new Date(Date.now() - MINUTE));
    const b = await failedMessage([failed(OK2_URL)], new Date(Date.now() - 2 * MINUTE));
    const broken: MemoryStorage = {
      ...storage,
      put: async () => {
        throw new Error('We encountered an internal error, please try again.');
      },
    };

    const result = await retryFailedAttachments(db, { ...deps, storage: broken }, { now, concurrency: 1 });

    expect(result).toMatchObject({
      candidates: 2,
      messages: 1,
      storageErrors: 1,
      stoppedOnStorageError: true,
      repaired: 0,
    });
    // Tin mới nhất được thử trước; lượt không bị tính, chỉ ghi mốc thử.
    expect(await attachmentsOf(a.id)).toEqual([
      failed(OK_URL, { retry_count: 0, last_retry_at: now.toISOString(), store_error_count: 1 }),
    ]);
    expect(await attachmentsOf(b.id)).toEqual([failed(OK2_URL)]);

    // Kho hồi phục: lượt sau sửa được cả hai (b chưa thử lần nào ⇒ đứng trước).
    const later = new Date(now.getTime() + 2 * MINUTE);
    expect(await retryFailedAttachments(db, deps, { now: later })).toMatchObject({ repaired: 2 });
  });

  it('thứ tự: tệp chưa thử (tin mới nhất) trước, rồi tệp thử lâu nhất trước', async () => {
    const now = new Date();
    const tried = await failedMessage(
      [
        failed(OK_URL, {
          retry_count: 1,
          last_retry_at: new Date(now.getTime() - 10 * MINUTE).toISOString(),
        }),
      ],
      new Date(now.getTime() - MINUTE),
    );
    const older = await failedMessage([failed(OK_URL)], new Date(now.getTime() - 60 * MINUTE));
    const newer = await failedMessage([failed(OK_URL)], new Date(now.getTime() - 30 * MINUTE));

    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      published = [];
      await retryFailedAttachments(db, deps, { now, batchSize: 1 });
      order.push((published[0]!.payload as { message: { id: string } }).message.id);
    }
    expect(order).toEqual([newer.id, older.id, tried.id]);
  });

  it('kho luôn từ chối một tệp: quá số lần miễn phí thì tính lượt như lỗi thường, tới trần thì bỏ hẳn', async () => {
    const now = new Date();
    const longAgo = new Date(now.getTime() - 6 * 60 * MINUTE).toISOString();
    const free = ATTACHMENT_RETRY_MAX_FREE_STORE_ERRORS;
    const counted = await failedMessage([
      failed(OK_URL, { retry_count: 0, last_retry_at: longAgo, store_error_count: free }),
    ]);
    const last = await failedMessage([
      failed(OK2_URL, {
        retry_count: ATTACHMENT_RETRY_MAX_ATTEMPTS - 1,
        last_retry_at: longAgo,
        store_error_count: free,
      }),
    ]);
    const broken: MemoryStorage = {
      ...storage,
      put: async () => {
        throw new Error('EntityTooLarge');
      },
    };

    const result = await retryFailedAttachments(db, { ...deps, storage: broken }, { now, concurrency: 2 });

    expect(result).toMatchObject({
      messages: 2,
      storageErrors: 2,
      exhausted: 1,
      stoppedOnStorageError: true,
    });
    expect(await attachmentsOf(counted.id)).toEqual([
      failed(OK_URL, { retry_count: 1, last_retry_at: now.toISOString(), store_error_count: free + 1 }),
    ]);
    expect(await attachmentsOf(last.id)).toEqual([
      failed(OK2_URL, {
        retry_count: ATTACHMENT_RETRY_MAX_ATTEMPTS,
        last_retry_at: now.toISOString(),
        store_error_count: free + 1,
        retry_exhausted: true,
      }),
    ]);
  });

  it('lệnh ghi kho treo: hết hạn ⇒ lỗi kho (không tính lượt), lượt quét vẫn kết thúc', async () => {
    const { id } = await failedMessage([failed(OK_URL)]);
    const hung: MemoryStorage = { ...storage, put: () => new Promise<void>(() => undefined) };

    const result = await retryFailedAttachments(db, { ...deps, storage: hung }, { storeTimeoutMs: 50 });

    expect(result).toMatchObject({ messages: 1, storageErrors: 1, stoppedOnStorageError: true });
    expect((await attachmentsOf(id))[0]).toMatchObject({
      storage_key: '',
      retry_count: 0,
      store_error_count: 1,
    });
  });

  it('đồng hồ đọc lại lúc nhận lượt: last_retry_at = giờ nhận lượt, không phải giờ bắt đầu lượt quét', async () => {
    const start = new Date();
    const later = new Date(start.getTime() + 5 * MINUTE);
    const { id } = await failedMessage([failed(DOWN_URL)]);
    let calls = 0;
    const ctx = makeCtx({ now: () => (calls++ === 0 ? start : later) });

    expect(await retryFailedAttachments(db, { ...deps, ctx })).toMatchObject({ messages: 1, failed: 1 });
    expect((await attachmentsOf(id))[0]).toMatchObject({
      retry_count: 1,
      last_retry_at: later.toISOString(),
    });
  });

  it('ghi kết quả lỗi DB: log không lộ params (URL CDN có token), tệp vừa lưu bị xóa', async () => {
    const { id } = await failedMessage([failed(`${OK_URL}?oh=SECRET&oe=1`)]);
    fetchMock.mockImplementation(async () => respond(OK_URL));
    const warn = vi.fn();
    let transactions = 0;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (...args: Parameters<Db['transaction']>) => {
            // Lần 1 = nhận lượt; lần 2 = ghi kết quả ⇒ lỗi như Postgres khởi động lại giữa chừng.
            if (++transactions === 2) {
              throw new DrizzleQueryError(
                'update "messages" set "attachments" = $1 where "messages"."id" = $2',
                [JSON.stringify([failed(`${OK_URL}?oh=SECRET&oe=1`)]), id],
                Object.assign(new Error('terminating connection due to administrator command'), {
                  code: '57P01',
                }),
              );
            }
            return target.transaction(...args);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    await retryFailedAttachments(flaky, { ...deps, logger: { ...deps.logger, warn, debug: warn } });

    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('https://');
    expect(logged).not.toContain('SECRET');
    expect(logged).toContain('57P01');
    expect(storage.objects.size).toBe(0);
  });

  it('tin đang bị worker khác khóa thì bỏ qua (SKIP LOCKED)', async () => {
    const { id } = await failedMessage([failed(OK_URL)]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: messages.id }).from(messages).where(eq(messages.id, id)).for('update');
      locked();
      await held;
    });
    await isLocked;
    try {
      expect(await retryFailedAttachments(db, deps)).toMatchObject({ candidates: 1, messages: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      release();
      await holder;
    }
    expect(await retryFailedAttachments(db, deps)).toMatchObject({ messages: 1, repaired: 1 });
  });

  it('signal đã hủy ⇒ không nhận tin nào', async () => {
    await failedMessage([failed(OK_URL)]);
    const controller = new AbortController();
    controller.abort();
    expect(await retryFailedAttachments(db, deps, { signal: controller.signal })).toMatchObject({
      candidates: 1,
      messages: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('luồng nhận + đồng bộ lưu tệp hỏng ⇒ tự tải lại', () => {
  it.each(['webhook', 'sync-backfill'] as const)(
    'tin %s lưu lúc kho hỏng (storage_key "") được tải lại khi kho hồi phục, không lên lịch chatbot',
    async (source) => {
      const broken: MemoryStorage = {
        ...storage,
        put: async () => {
          throw new Error('We encountered an internal error, please try again.');
        },
      };
      const inboundDeps: PipelineDeps = {
        ...deps,
        storage: broken,
        connectors: {},
        cipher: { encryptJson: (v) => JSON.stringify(v), decryptJson: <T>(s: string) => JSON.parse(s) as T },
        ownAppIds: {},
        onCustomerMessageStored: hook,
      };
      const externalMessageId = `m_${source}_${Date.now()}`;
      await processInboundMessage(
        db,
        inboundDeps,
        {
          channelAccountId: channel.id,
          channelType: 'messenger',
          externalUserId: `psid-${source}`,
          externalMessageId,
          direction: 'in',
          senderType: 'customer',
          attachments: [{ url: OK_URL, type: 'image' }],
          sentAt: new Date(Date.now() - MINUTE),
          raw: {},
        },
        { source },
      );
      const [row] = await db
        .select({ id: messages.id, a: messages.attachments })
        .from(messages)
        .where(eq(messages.externalMessageId, externalMessageId));
      expect(row!.a).toEqual([
        { type: 'image', storage_key: '', mime: 'application/octet-stream', original_url: OK_URL },
      ]);
      expect((await getMessageDto(db, row!.id, makeCtx())).attachments[0]).toMatchObject({
        url: null,
        retrying: true,
      });
      hook.mockClear();
      published = [];

      expect(await retryFailedAttachments(db, deps)).toMatchObject({ repaired: 1 });
      const [att] = await attachmentsOf(row!.id);
      // Cùng xử lý mime/kích thước như lúc nhận: mime theo Content-Type, ảnh resize ≤ 1600px.
      expect(att).toMatchObject({
        type: 'image',
        mime: 'image/jpeg',
        width: 1600,
        height: 800,
        original_url: OK_URL,
      });
      expect(storage.objects.has(att!.storage_key)).toBe(true);
      expect(hook).not.toHaveBeenCalled();
      expect(published.map((p) => p.event)).toEqual(['message.updated']);
    },
  );
});
