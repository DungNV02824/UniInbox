import { describe, expect, it } from 'vitest';
import { buildLarkRequest, isLarkDirty } from './settings-api';

describe('buildLarkRequest', () => {
  it('URL rỗng => null; giữ secret => không gửi trường secret', () => {
    expect(buildLarkRequest({ webhookUrl: '  ', secret: { mode: 'keep' } })).toEqual({ webhookUrl: null });
  });

  it('đặt secret mới (trim) / xóa secret / ô secret trống = giữ', () => {
    expect(
      buildLarkRequest({
        webhookUrl: ' https://open.larksuite.com/x ',
        secret: { mode: 'set', value: ' s ' },
      }),
    ).toEqual({ webhookUrl: 'https://open.larksuite.com/x', secret: 's' });
    expect(buildLarkRequest({ webhookUrl: '', secret: { mode: 'clear' } })).toEqual({
      webhookUrl: null,
      secret: null,
    });
    expect(buildLarkRequest({ webhookUrl: '', secret: { mode: 'set', value: '' } })).toEqual({
      webhookUrl: null,
    });
  });
});

describe('isLarkDirty', () => {
  const saved = { webhookUrl: 'https://a.example/hook', hasSecret: true };
  it('so với cấu hình đã lưu', () => {
    expect(isLarkDirty({ webhookUrl: 'https://a.example/hook', secret: { mode: 'keep' } }, saved)).toBe(
      false,
    );
    expect(isLarkDirty({ webhookUrl: 'https://b.example/hook', secret: { mode: 'keep' } }, saved)).toBe(true);
    expect(isLarkDirty({ webhookUrl: 'https://a.example/hook', secret: { mode: 'clear' } }, saved)).toBe(
      true,
    );
    expect(
      isLarkDirty({ webhookUrl: 'https://a.example/hook', secret: { mode: 'set', value: '' } }, saved),
    ).toBe(false);
    expect(
      isLarkDirty({ webhookUrl: 'https://a.example/hook', secret: { mode: 'set', value: 'x' } }, saved),
    ).toBe(true);
  });
});
