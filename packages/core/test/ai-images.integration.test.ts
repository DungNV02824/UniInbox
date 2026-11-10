// Ảnh cho chatbot: thứ tự/đánh số khớp dòng tin, ảnh tải hỏng giữ chỗ, loại theo metadata TRƯỚC khi đọc kho,
// lọc định dạng, ngân sách byte. Postgres thật (Testcontainers), kho/LLM giả.
import { chatbots, type ChannelAccount, type Chatbot, type NewConversation } from '@dezon/db';
import type { MessageAttachment } from '@dezon/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHATBOT_MAX_IMAGE_BYTES } from '../src/ai/prompt';
import { processAiReplyJob } from '../src/ai/runtime';
import {
  CHATBOT_MAX_IMAGES_TOTAL_BYTES,
  loadPendingMessages,
  loadPromptImages,
  type PendingMessage,
} from '../src/ai/turn-input';
import { createAiKit, silentLogger, type AiTestKit } from './helpers/ai-fakes';
import {
  addMessage,
  createChannel,
  createConversation,
  makeCtx,
  startTestDb,
  type TestDb,
} from './inbox-fixtures';

let t: TestDb;
let channel: ChannelAccount;
let kit: AiTestKit;
const ctx = makeCtx();
const MB = 1024 * 1024;

async function createBot(): Promise<Chatbot> {
  const [bot] = await t.db
    .insert(chatbots)
    .values({ name: `Bot ${Math.random().toString(36).slice(2, 8)}` })
    .returning();
  return bot!;
}

async function botConversation(bot: Chatbot, extra: Partial<NewConversation> = {}) {
  return createConversation(t.db, {
    channel,
    contactName: 'Chị Mai',
    chatbotId: bot.id,
    aiMode: 'auto',
    lastCustomerMessageAt: new Date(),
    ...extra,
  });
}

const secAgo = (n: number) => new Date(Date.now() - n * 1000);
const contentText = (call = 0) =>
  kit.llm.calls[call]!.contents.map((c) => c.parts.map((p) => ('text' in p ? p.text : '')).join('\n')).join(
    '\n',
  );
const inline = (call = 0) =>
  kit.llm.calls[call]!.contents.flatMap((c) =>
    c.parts.flatMap((p) => ('inlineImage' in p ? [Buffer.from(p.inlineImage.data, 'base64')[0]] : [])),
  );
const img = (k: string, mime = 'image/jpeg'): MessageAttachment => ({ type: 'image', storage_key: k, mime });
const sized = (k: string, mime: string, size: number): MessageAttachment =>
  Object.assign(img(k, mime), { size });
const firstByte = (i: { data: string }) => (i.data ? Buffer.from(i.data, 'base64')[0] : null);

/** Theo dõi mọi lần đọc kho (get + getStream) theo khóa. */
function spyReads() {
  const get = vi.spyOn(kit.storage, 'get');
  const getStream = vi.spyOn(kit.storage, 'getStream');
  return {
    keys: () => [...get.mock.calls, ...getStream.mock.calls].map((c) => c[0]).sort(),
    get,
    getStream,
    restore: () => {
      get.mockRestore();
      getStream.mockRestore();
    },
  };
}

beforeAll(async () => {
  t = await startTestDb();
  channel = await createChannel(t.db, { displayName: 'Fanpage Nội Thất' });
});

afterAll(async () => {
  await t?.stop();
});

beforeEach(() => {
  kit = createAiKit(ctx);
});

describe('loadPromptImages: giới hạn, metadata, định dạng', () => {
  it('bỏ ảnh > 4 MB, tổng ≤ 13,5 MB (ưu tiên ảnh mới nhất), giữ thứ tự; object mất ⇒ unavailable', async () => {
    await kit.storage.put('big.jpg', Buffer.alloc(5 * MB, 1), 'image/jpeg');
    for (const k of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']) {
      await kit.storage.put(k, Buffer.alloc(Math.floor(3.3 * MB), k.charCodeAt(0)), 'image/jpeg');
    }
    const pending: PendingMessage[] = [
      {
        id: 'p1',
        text: null,
        attachments: ['a.jpg', 'big.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'missing.jpg'].map((k) =>
          img(k),
        ),
      },
    ];
    const images = await loadPromptImages(kit.storage, pending, silentLogger);
    expect(images.map((i) => i.skipped ?? null)).toEqual([
      'over_total', // b–e đã chiếm 13,2 MB
      'too_large', // không có `size` ⇒ đọc stream, dừng ngay khi vượt 4 MB
      null,
      null,
      null,
      null,
      'unavailable',
    ]);
    expect(images.map(firstByte)).toEqual([null, null, ...[...'bcde'].map((c) => c.charCodeAt(0)), null]);
    const total = images.reduce((n, i) => n + Buffer.from(i.data, 'base64').length, 0);
    expect(total).toBeLessThanOrEqual(CHATBOT_MAX_IMAGES_TOTAL_BYTES);
    expect(images.every((i) => i.messageIndex === 1)).toBe(true);
  });

  it('> 10 ảnh ⇒ chỉ đọc 10 ảnh MỚI NHẤT (qua stream, không get), ảnh cũ hơn "limit"; messageIndex theo tin', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `burst-${i}.jpg`);
    for (const [i, k] of keys.entries()) await kit.storage.put(k, Buffer.from([i, 1, 2, 3]), 'image/jpeg');
    const t1 = new Date('2026-11-09T08:27:00Z');
    const t2 = new Date('2026-11-09T08:28:00Z');
    const pending: PendingMessage[] = [
      { id: 'p1', text: null, attachments: keys.slice(0, 5).map((k) => img(k)), sentAt: t1 },
      {
        id: 'p2',
        text: 'Công trình 2',
        attachments: [
          ...keys.slice(5).map((k) => img(k)),
          { type: 'file', storage_key: 'x.pdf', mime: 'application/pdf' },
        ],
        sentAt: t2,
      },
    ];
    const reads = spyReads();
    try {
      const images = await loadPromptImages(kit.storage, pending, silentLogger);
      expect(images).toHaveLength(12);
      expect(images.slice(0, 2).every((i) => i.skipped === 'limit' && i.data === '')).toBe(true);
      expect(images.slice(2).map(firstByte)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(images.map((i) => i.sentAt)).toEqual([...Array(5).fill(t1), ...Array(7).fill(t2)]);
      expect(images.map((i) => i.messageIndex)).toEqual([...Array(5).fill(1), ...Array(7).fill(2)]);
      expect(reads.getStream).toHaveBeenCalledTimes(10);
      expect(reads.get).not.toHaveBeenCalled();
    } finally {
      reads.restore();
    }
  });

  it('loại theo metadata TRƯỚC khi đọc kho: quá lớn / GIF / định dạng lạ / tải hỏng / vượt tổng — không đọc các ảnh đó', async () => {
    for (const k of [
      'pre-a.jpg',
      'pre-b.jpg',
      'pre-c.jpg',
      'pre-d.jpg',
      'pre-ok.webp',
      'anim.gif',
      'huge.heic',
    ]) {
      await kit.storage.put(k, Buffer.from([k.charCodeAt(4), 1, 2]), 'image/jpeg');
    }
    const pending: PendingMessage[] = [
      {
        id: 'p1',
        text: null,
        attachments: [
          sized('pre-a.jpg', 'image/jpeg', Math.floor(3.9 * MB)), // vượt tổng theo metadata (b, c, d = 11,7 MB)
          sized('huge.heic', 'image/heic', 20 * MB), // quá lớn theo metadata — không đọc
          sized('anim.gif', 'image/gif', 2000), // GIF — Gemini không nhận
          { type: 'image', storage_key: '', mime: 'application/octet-stream' }, // tải hỏng lúc nhận
          sized('pre-b.jpg', 'image/jpeg', Math.floor(3.9 * MB)),
          sized('pre-c.jpg', 'image/jpeg', Math.floor(3.9 * MB)),
          sized('pre-d.jpg', 'image/jpeg', Math.floor(3.9 * MB)),
          { type: 'sticker', storage_key: 'st.png', mime: 'image/png' }, // sticker không tính là ảnh
          sized('pre-ok.webp', 'image/webp', 3),
        ],
      },
    ];
    const reads = spyReads();
    try {
      const images = await loadPromptImages(kit.storage, pending, silentLogger);
      expect(images.map((i) => i.skipped ?? null)).toEqual([
        'over_total',
        'too_large',
        'unsupported',
        'unavailable',
        null,
        null,
        null,
        null,
      ]);
      expect(reads.keys()).toEqual(['pre-b.jpg', 'pre-c.jpg', 'pre-d.jpg', 'pre-ok.webp']);
      expect(reads.get).not.toHaveBeenCalled();
    } finally {
      reads.restore();
    }
  });

  it('metadata thiếu nhưng tệp thật > 4 MB ⇒ dừng đọc ở giới hạn, không giữ cả tệp', async () => {
    await kit.storage.put('raw.heic', Buffer.alloc(CHATBOT_MAX_IMAGE_BYTES + 1, 9), 'image/heic');
    await kit.storage.put('ok.heic', Buffer.from([5, 5]), 'image/heic');
    const images = await loadPromptImages(
      kit.storage,
      [{ id: 'p1', text: null, attachments: [img('raw.heic', 'image/heic'), img('ok.heic', 'image/heic')] }],
      silentLogger,
    );
    expect(images.map((i) => i.skipped ?? null)).toEqual(['too_large', null]);
    expect(images[0]!.data).toBe('');
    expect(images[1]!.mime).toBe('image/heic');
  });
});

describe('ảnh cho model (job thật): thứ tự, nhãn, tải hỏng', () => {
  it('đánh số theo sent_at (như dòng tin) dù created_at ngược; nhãn ghi giờ tới giây + "tin thứ m"', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    for (const [k, b] of [
      ['ord-a1.jpg', 11],
      ['ord-a2.jpg', 12],
      ['ord-b1.jpg', 21],
    ] as const) {
      await kit.storage.put(k, Buffer.from([b, 0, 0]), 'image/jpeg');
    }
    // A gửi trước nhưng tải ảnh lâu hơn ⇒ insert (created_at) SAU B.
    await addMessage(t.db, conv, {
      text: 'Công trình A',
      attachments: [img('ord-a1.jpg'), img('ord-a2.jpg')],
      sentAt: secAgo(20),
      createdAt: secAgo(5),
    });
    await addMessage(t.db, conv, {
      text: 'Công trình B',
      attachments: [img('ord-b1.jpg')],
      sentAt: secAgo(10),
      createdAt: secAgo(15),
    });
    await processAiReplyJob(t.db, kit.deps, conv.id);
    const text = contentText();
    expect(text).toContain('Công trình A</customer_message> [gửi 2 ảnh/tệp: ảnh 1–2]');
    expect(text).toContain('Công trình B</customer_message> [gửi 1 ảnh/tệp: ảnh 3]');
    expect(text.indexOf('Công trình A')).toBeLessThan(text.indexOf('Công trình B'));
    expect(text).toMatch(/Ảnh 1\/3 — thuộc tin lúc \d\d:\d\d:\d\d \(tin thứ 1 trong lượt này\):/);
    expect(text).toMatch(/Ảnh 2\/3 — thuộc tin lúc \d\d:\d\d:\d\d \(tin thứ 1 trong lượt này\):/);
    expect(text).toMatch(/Ảnh 3\/3 — thuộc tin lúc \d\d:\d\d:\d\d \(tin thứ 2 trong lượt này\):/);
    expect(inline()).toEqual([11, 12, 21]);
  });

  it('trùng sent_at ⇒ xếp theo created_at rồi id — cả dòng tin lẫn số ảnh', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await kit.storage.put('tie-x.jpg', Buffer.from([31]), 'image/jpeg');
    await kit.storage.put('tie-y.jpg', Buffer.from([32]), 'image/jpeg');
    const sentAt = secAgo(10);
    // id của X lớn hơn Y nhưng X được lưu trước ⇒ X đứng trước (created_at quyết định, không phải id).
    await addMessage(t.db, conv, {
      id: 'ffffffff-0000-4000-8000-000000000001',
      text: 'Mẫu X',
      attachments: [img('tie-x.jpg')],
      sentAt,
      createdAt: secAgo(8),
    });
    await addMessage(t.db, conv, {
      id: '00000000-0000-4000-8000-000000000002',
      text: 'Mẫu Y',
      attachments: [img('tie-y.jpg')],
      sentAt,
      createdAt: secAgo(6),
    });
    const pending = await loadPendingMessages(t.db, conv.id);
    expect(pending.every((m) => m.createdAt instanceof Date)).toBe(true);
    await processAiReplyJob(t.db, kit.deps, conv.id);
    const text = contentText();
    expect(text.indexOf('Mẫu X</customer_message>')).toBeLessThan(text.indexOf('Mẫu Y</customer_message>'));
    expect(text).toContain('Mẫu X</customer_message> [gửi 1 ảnh/tệp: ảnh 1]');
    expect(text).toContain('Mẫu Y</customer_message> [gửi 1 ảnh/tệp: ảnh 2]');
    expect(inline()).toEqual([31, 32]);
  });

  it('ảnh tải hỏng (lúc nhận hoặc mất object) giữ chỗ "Ảnh k/N", N khớp "[gửi N ảnh/tệp]", nhờ gửi lại', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await kit.storage.put('fail-ok.jpg', Buffer.from([7, 0]), 'image/jpeg');
    await addMessage(t.db, conv, {
      text: 'Công trình C',
      attachments: [
        img('fail-ok.jpg'),
        { type: 'image', storage_key: '', mime: 'application/octet-stream' },
        img('gone.jpg'),
      ],
      sentAt: secAgo(5),
    });
    await processAiReplyJob(t.db, kit.deps, conv.id);
    const text = contentText();
    expect(text).toContain('[gửi 3 ảnh/tệp: ảnh 1–3]');
    expect(text).toMatch(/Ảnh 1\/3 — thuộc tin lúc [^\n]*\(tin thứ 1 trong lượt này\):/);
    expect(text).toMatch(
      /Ảnh 2\/3 — thuộc tin lúc [^\n]*: \[Ảnh 2\/3 không tải được — nhờ người nhắn gửi lại\]/,
    );
    expect(text).toMatch(
      /Ảnh 3\/3 — thuộc tin lúc [^\n]*: \[Ảnh 3\/3 không tải được — nhờ người nhắn gửi lại\]/,
    );
    expect(text).toContain('Có 2/3 ảnh không xem được (ảnh 2, 3): 2 ảnh không tải được.');
    expect(inline()).toEqual([7]);
  });
});
