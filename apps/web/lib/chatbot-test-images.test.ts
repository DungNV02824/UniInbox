import { chatbotTestSchema } from '@dezon/shared';
import { describe, expect, it } from 'vitest';
import {
  addPendingImages,
  base64DecodedBytes,
  buildTestMessages,
  checkImageFile,
  countSentImages,
  fitWithin,
  imageIsSendable,
  imageSrc,
  lastTurnImageStats,
  tooManyImagesMessage,
  type TestEntry,
  type TestImage,
} from './chatbot-test';

let imgSeq = 0;
function img(data = 'aGVsbG8=', mimeType: TestImage['mimeType'] = 'image/jpeg'): TestImage {
  imgSeq += 1;
  return { id: `img${imgSeq}`, mimeType, data };
}
function imgs(n: number, tag = 'x'): TestImage[] {
  return Array.from({ length: n }, (_, i) => img(btoa(`${tag}${i}`)));
}

describe('buildTestMessages — ảnh', () => {
  it('ảnh chỉ đi kèm tin khách, dạng {mimeType, data} không tiền tố, đúng thứ tự', () => {
    const a = img(btoa('a'));
    const b = img(btoa('b'), 'image/png');
    const entries: TestEntry[] = [
      { id: '1', kind: 'customer', text: 'Chào em' },
      { id: '2', kind: 'bot', text: 'Dạ em chào anh/chị ạ' },
      { id: '3', kind: 'customer', text: 'Ảnh công trình', images: [a, b] },
    ];
    expect(buildTestMessages(entries)).toEqual([
      { role: 'customer', text: 'Chào em' },
      { role: 'bot', text: 'Dạ em chào anh/chị ạ' },
      {
        role: 'customer',
        text: 'Ảnh công trình',
        images: [
          { mimeType: 'image/jpeg', data: btoa('a') },
          { mimeType: 'image/png', data: btoa('b') },
        ],
      },
    ]);
  });

  it('tin chỉ có ảnh (không chữ) => text rỗng + ảnh (core tự ghi "[gửi N ảnh/tệp]")', () => {
    const msgs = buildTestMessages([{ id: '1', kind: 'customer', text: '  ', images: imgs(3) }]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('');
    expect(msgs[0]!.images).toHaveLength(3);
    expect(chatbotTestSchema.safeParse({ messages: msgs }).success).toBe(true);
  });

  it('tin không ảnh không có trường images', () => {
    const msgs = buildTestMessages([{ id: '1', kind: 'customer', text: 'hi', images: [] }]);
    expect(msgs[0]).toEqual({ role: 'customer', text: 'hi' });
  });

  it('tin trước tin bot không gửi lại ảnh, chỉ gửi imageCount đúng số ảnh (không cắt dở)', () => {
    // Lượt 1: 6 ảnh, bot trả lời; lượt 2: 5 ảnh. Lịch sử phải ghi đúng 6 ảnh, lượt 2 đủ 5 ảnh.
    const old = imgs(6, 'old');
    const recent = imgs(5, 'new');
    const msgs = buildTestMessages([
      { id: '1', kind: 'customer', text: 'lô 1', images: old },
      { id: '2', kind: 'bot', text: 'ok' },
      { id: '3', kind: 'customer', text: 'lô 2', images: recent },
    ]);
    expect(msgs[0]).toEqual({ role: 'customer', text: 'lô 1', imageCount: 6 });
    expect(msgs[2]).toEqual({
      role: 'customer',
      text: 'lô 2',
      images: recent.map((i) => ({ mimeType: i.mimeType, data: i.data })),
    });
    expect(countSentImages(msgs)).toBe(5);
    expect(chatbotTestSchema.safeParse({ messages: msgs }).success).toBe(true);
  });

  it('tin chỉ có ảnh ở lượt cũ: text rỗng + imageCount, vẫn qua schema', () => {
    const msgs = buildTestMessages([
      { id: '1', kind: 'customer', text: '', images: imgs(7) },
      { id: '2', kind: 'bot', text: 'Dạ anh/chị bổ sung giúp em tên công trình ạ' },
      { id: '3', kind: 'customer', text: 'Công trình Nhà ông Ba' },
    ]);
    expect(msgs[0]).toEqual({ role: 'customer', text: '', imageCount: 7 });
    expect(msgs[2]).toEqual({ role: 'customer', text: 'Công trình Nhà ông Ba' });
    expect(countSentImages(msgs)).toBe(0);
    expect(chatbotTestSchema.safeParse({ messages: msgs }).success).toBe(true);
  });

  it('tin cũ không lấy mất ngân sách ảnh của lượt hiện tại (10 ảnh mới đều được gửi)', () => {
    const msgs = buildTestMessages([
      { id: '1', kind: 'customer', text: 'cũ', images: imgs(8) },
      { id: '2', kind: 'bot', text: 'ok' },
      { id: '3', kind: 'customer', text: 'mới', images: imgs(10) },
    ]);
    expect(msgs[0]).toEqual({ role: 'customer', text: 'cũ', imageCount: 8 });
    expect(msgs[2]!.images).toHaveLength(10);
    expect(msgs[2]!.imageCount).toBeUndefined();
    expect(chatbotTestSchema.safeParse({ messages: msgs }).success).toBe(true);
  });

  it('chuỗi tin khách cuối quá 10 ảnh: ưu tiên ảnh mới nhất, tin bị cắt dở vẫn báo đúng imageCount', () => {
    const a = imgs(2, 'a');
    const b = imgs(3, 'b');
    const c = imgs(7, 'c');
    const msgs = buildTestMessages([
      { id: '1', kind: 'customer', text: 'a', images: a },
      { id: '2', kind: 'customer', text: '', images: b },
      { id: '3', kind: 'customer', text: 'c', images: c },
    ]);
    expect(msgs[0]).toEqual({ role: 'customer', text: 'a', imageCount: 2 });
    expect(msgs[1]).toEqual({
      role: 'customer',
      text: '',
      images: b.map((i) => ({ mimeType: i.mimeType, data: i.data })),
    });
    expect(msgs[2]!.images).toHaveLength(7);
    expect(countSentImages(msgs)).toBe(10);
    expect(chatbotTestSchema.safeParse({ messages: msgs }).success).toBe(true);
  });

  it('cắt dở một tin trong chuỗi cuối: giữ các ảnh mới nhất của tin (đúng thứ tự) + imageCount = số ảnh thật', () => {
    const a = imgs(5, 'a');
    const b = imgs(8, 'b');
    const msgs = buildTestMessages([
      { id: '1', kind: 'customer', text: 'a', images: a },
      { id: '2', kind: 'customer', text: 'b', images: b },
    ]);
    expect(msgs[0]).toEqual({
      role: 'customer',
      text: 'a',
      images: a.slice(3).map((i) => ({ mimeType: i.mimeType, data: i.data })),
      imageCount: 5,
    });
    expect(msgs[1]).toEqual({
      role: 'customer',
      text: 'b',
      images: b.map((i) => ({ mimeType: i.mimeType, data: i.data })),
    });
    expect(countSentImages(msgs)).toBe(10);
    expect(chatbotTestSchema.safeParse({ messages: msgs }).success).toBe(true);
  });

  it('hết ngân sách ảnh: tin cũ hơn trong chuỗi cuối chỉ gửi imageCount (không có images rỗng)', () => {
    const msgs = buildTestMessages([
      { id: '1', kind: 'customer', text: '', images: imgs(4, 'a') },
      { id: '2', kind: 'customer', text: 'b', images: imgs(10, 'b') },
    ]);
    expect(msgs[0]).toEqual({ role: 'customer', text: '', imageCount: 4 });
    expect(msgs[1]!.images).toHaveLength(10);
    expect(msgs[1]!.imageCount).toBeUndefined();
    expect(chatbotTestSchema.safeParse({ messages: msgs }).success).toBe(true);
  });

  it('mọi tin có imageCount đều khớp đúng số ảnh khách đã gửi', () => {
    const entries: TestEntry[] = [
      { id: '1', kind: 'customer', text: '', images: imgs(3) },
      { id: '2', kind: 'bot', text: 'ok' },
      { id: '3', kind: 'customer', text: 'x', images: imgs(6) },
      { id: '4', kind: 'customer', text: '', images: imgs(9) },
    ];
    const msgs = buildTestMessages(entries);
    const real = [3, 0, 6, 9];
    msgs.forEach((m, i) => {
      const reported = m.imageCount ?? m.images?.length ?? 0;
      expect(reported).toBe(real[i]);
    });
    expect(countSentImages(msgs)).toBe(10);
  });

  it('lượt hiện tại kết thúc bằng tin bot: không gửi ảnh nào', () => {
    const msgs = buildTestMessages([
      { id: '1', kind: 'customer', text: 'x', images: imgs(3) },
      { id: '2', kind: 'bot', text: 'ok' },
    ]);
    expect(msgs[0]).toEqual({ role: 'customer', text: 'x', imageCount: 3 });
    expect(countSentImages(msgs)).toBe(0);
  });

  it('request dựng ra luôn qua được schema chung (10 ảnh JPEG thật cỡ ~1 MB)', () => {
    const big = btoa('y'.repeat(1024 * 1024));
    const entries: TestEntry[] = [
      { id: '1', kind: 'customer', text: 'Công trình A', images: Array.from({ length: 6 }, () => img(big)) },
      { id: '2', kind: 'bot', text: 'Dạ em nhận rồi ạ' },
      { id: '3', kind: 'customer', text: '', images: Array.from({ length: 8 }, () => img(big)) },
    ];
    const msgs = buildTestMessages(entries);
    expect(countSentImages(msgs)).toBe(8);
    expect(msgs[0]).toEqual({ role: 'customer', text: 'Công trình A', imageCount: 6 });
    expect(chatbotTestSchema.safeParse({ messages: msgs }).success).toBe(true);
  });

  it('request 10 ảnh ~1 MB trong cùng lượt qua được schema chung', () => {
    const big = btoa('y'.repeat(1024 * 1024));
    const msgs = buildTestMessages([
      { id: '1', kind: 'customer', text: '', images: Array.from({ length: 10 }, () => img(big)) },
    ]);
    expect(countSentImages(msgs)).toBe(10);
    expect(chatbotTestSchema.safeParse({ messages: msgs }).success).toBe(true);
  });

  it('một tin quá 10 ảnh bị cắt còn 10', () => {
    const msgs = buildTestMessages([{ id: '1', kind: 'customer', text: 'x', images: imgs(12) }]);
    expect(msgs[0]!.images).toHaveLength(10);
  });

  it('tin rơi khỏi 30 tin gần nhất mất luôn ảnh', () => {
    const entries: TestEntry[] = [
      { id: 'first', kind: 'customer', text: 'ảnh đầu', images: imgs(2, 'first') },
    ];
    for (let i = 0; i < 15; i += 1) {
      entries.push({ id: `b${i}`, kind: 'bot', text: `đáp ${i}` });
      entries.push({ id: `c${i}`, kind: 'customer', text: `hỏi ${i}` });
    }
    const msgs = buildTestMessages(entries);
    expect(msgs.length).toBeLessThanOrEqual(30);
    expect(msgs.some((m) => m.text === 'ảnh đầu')).toBe(false);
    expect(countSentImages(msgs)).toBe(0);
  });

  it('bỏ ảnh hỏng (rỗng, sai định dạng, quá 4 MB) nhưng imageCount vẫn đúng số ảnh khách gửi', () => {
    const big = img('A'.repeat(Math.ceil(((4 * 1024 * 1024 + 10) * 4) / 3)));
    const bad = { ...img(), mimeType: 'image/bmp' } as unknown as TestImage;
    const ok = img(btoa('ok'));
    const msgs = buildTestMessages([
      { id: '1', kind: 'customer', text: 'x', images: [big, bad, img(''), ok] },
    ]);
    expect(msgs[0]).toEqual({
      role: 'customer',
      text: 'x',
      images: [{ mimeType: 'image/jpeg', data: btoa('ok') }],
      imageCount: 4,
    });
    expect(chatbotTestSchema.safeParse({ messages: msgs }).success).toBe(true);
  });

  it('tin chỉ có ảnh hỏng ở lượt hiện tại: text rỗng + imageCount, không có images', () => {
    const msgs = buildTestMessages([{ id: '1', kind: 'customer', text: '', images: [img('')] }]);
    expect(msgs[0]).toEqual({ role: 'customer', text: '', imageCount: 1 });
    expect(chatbotTestSchema.safeParse({ messages: msgs }).success).toBe(true);
  });

  it('ảnh trên tin bot bị bỏ qua', () => {
    const entries = [
      { id: '1', kind: 'customer', text: 'hi' },
      { id: '2', kind: 'bot', text: 'x', images: imgs(1) },
    ] as unknown as TestEntry[];
    expect(buildTestMessages(entries)[1]).toEqual({ role: 'bot', text: 'x' });
  });
});

describe('lastTurnImageStats', () => {
  it('chỉ tính ảnh của lượt gần nhất, không tính ảnh các lượt cũ', () => {
    const entries: TestEntry[] = [
      { id: '1', kind: 'customer', text: 'lô 1', images: imgs(6) },
      { id: '2', kind: 'bot', text: 'ok' },
      { id: '3', kind: 'customer', text: 'lô 2', images: imgs(5) },
    ];
    expect(lastTurnImageStats(entries)).toEqual({ total: 5, sent: 5 });
    // Sau khi bot trả lời lượt 2 vẫn báo về lượt 2.
    const after: TestEntry[] = [...entries, { id: '4', kind: 'bot', text: 'Dạ em nhận rồi ạ' }];
    expect(lastTurnImageStats(after)).toEqual({ total: 5, sent: 5 });
  });

  it('lượt có quá 10 ảnh (nhiều tin khách liên tiếp) => sent = 10', () => {
    const entries: TestEntry[] = [
      { id: '1', kind: 'customer', text: '', images: imgs(6) },
      { id: '2', kind: 'customer', text: '', images: imgs(7) },
      { id: '3', kind: 'bot', text: 'ok' },
      { id: '4', kind: 'outcome', result: { decision: 'reply', latencyMs: 1, model: 'm' } },
    ];
    expect(lastTurnImageStats(entries)).toEqual({ total: 13, sent: 10 });
  });

  it('sent chỉ đếm ảnh thực sự gửi (bỏ ảnh hỏng), khớp countSentImages của request', () => {
    const entries: TestEntry[] = [
      { id: '1', kind: 'customer', text: '', images: [...imgs(3), img('')] },
      { id: '2', kind: 'customer', text: '', images: imgs(8) },
    ];
    expect(lastTurnImageStats(entries)).toEqual({ total: 12, sent: 10 });
    expect(countSentImages(buildTestMessages(entries))).toBe(10);
    const broken: TestEntry[] = [{ id: '1', kind: 'customer', text: '', images: [img(''), ...imgs(2)] }];
    expect(lastTurnImageStats(broken)).toEqual({ total: 3, sent: 2 });
  });

  it('sau chuyển người (bot gửi tin) vẫn báo đúng lượt vừa chạy', () => {
    const entries: TestEntry[] = [
      { id: '1', kind: 'customer', text: '', images: imgs(12) },
      { id: '2', kind: 'bot', text: 'Dạ em chuyển nhân viên hỗ trợ ạ' },
      {
        id: '3',
        kind: 'outcome',
        result: {
          decision: 'escalate',
          messages: ['Dạ em chuyển nhân viên hỗ trợ ạ'],
          latencyMs: 1,
          model: 'm',
        },
      },
    ];
    expect(lastTurnImageStats(entries)).toEqual({ total: 12, sent: 10 });
  });

  it('không có ảnh => 0/0', () => {
    expect(lastTurnImageStats([])).toEqual({ total: 0, sent: 0 });
    expect(lastTurnImageStats([{ id: '1', kind: 'customer', text: 'hi' }])).toEqual({ total: 0, sent: 0 });
  });
});

describe('kiểm tra ảnh', () => {
  it('base64DecodedBytes', () => {
    expect(base64DecodedBytes('')).toBe(0);
    expect(base64DecodedBytes(btoa('a'))).toBe(1);
    expect(base64DecodedBytes(btoa('ab'))).toBe(2);
    expect(base64DecodedBytes(btoa('abc'))).toBe(3);
    expect(base64DecodedBytes(btoa('x'.repeat(1000)))).toBe(1000);
  });

  it('imageIsSendable: giới hạn 4 MB sau giải mã', () => {
    const at = 'A'.repeat(((4 * 1024 * 1024) / 3) * 4 + 4);
    expect(base64DecodedBytes(at)).toBeGreaterThan(4 * 1024 * 1024);
    expect(imageIsSendable({ mimeType: 'image/jpeg', data: at })).toBe(false);
    expect(imageIsSendable({ mimeType: 'image/jpeg', data: 'A'.repeat(4 * 1024 * 1024) })).toBe(true);
    expect(imageIsSendable({ mimeType: 'image/jpeg', data: '' })).toBe(false);
  });

  it('checkImageFile: báo lỗi tiếng Việt cho tệp không phải ảnh / quá lớn / rỗng', () => {
    expect(checkImageFile({ name: 'a.jpg', type: 'image/jpeg', size: 2_000_000 })).toBeNull();
    expect(checkImageFile({ name: 'hd.pdf', type: 'application/pdf', size: 1000 })).toMatch(
      /không phải là ảnh/,
    );
    expect(checkImageFile({ name: 'x.png', type: 'image/png', size: 0 })).toMatch(/rỗng/);
    expect(checkImageFile({ name: 'to.jpg', type: 'image/jpeg', size: 31 * 1024 * 1024 })).toMatch(/quá lớn/);
    expect(checkImageFile({ type: '', size: 10 })).toMatch(/^Tệp này không phải là ảnh/);
  });

  it('fitWithin: cạnh dài ≤ 1600, giữ tỉ lệ, không phóng to', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10000, 10)).toEqual({ width: 1600, height: 2 });
    expect(fitWithin(0, 100)).toEqual({ width: 0, height: 0 });
  });

  it('addPendingImages: tối đa 10, báo số ảnh bị bỏ', () => {
    const r1 = addPendingImages(imgs(7), imgs(5));
    expect(r1.images).toHaveLength(10);
    expect(r1.dropped).toBe(2);
    const r2 = addPendingImages([], imgs(3));
    expect(r2.dropped).toBe(0);
    expect(r2.images).toHaveLength(3);
    expect(tooManyImagesMessage(2)).toBe('Mỗi tin chỉ đính kèm tối đa 10 ảnh — đã bỏ 2 ảnh.');
  });

  it('imageSrc tạo data URL', () => {
    expect(imageSrc({ mimeType: 'image/png', data: 'QQ==' })).toBe('data:image/png;base64,QQ==');
  });
});
