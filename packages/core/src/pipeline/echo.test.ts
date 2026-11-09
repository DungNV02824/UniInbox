import { describe, expect, it } from 'vitest';
import { isOwnEcho, ownEchoMessageId } from './echo';

const deps = { ownAppIds: { messenger: '1517776481860111' } };
const echo = (raw: unknown, direction: 'in' | 'out' = 'out') => ({
  direction,
  channelType: 'messenger' as const,
  raw,
});

describe('isOwnEcho', () => {
  it('app_id (dạng số trong JSON) trùng META_APP_ID => tin của hệ thống', () => {
    expect(isOwnEcho(echo({ message: { is_echo: true, app_id: 1517776481860111 } }), deps)).toBe(true);
    expect(isOwnEcho(echo({ message: { is_echo: true, app_id: '1517776481860111' } }), deps)).toBe(true);
  });

  it('echo từ Business Suite / app khác => không phải của mình', () => {
    expect(isOwnEcho(echo({ message: { is_echo: true, app_id: 263902037430900 } }), deps)).toBe(false);
    // Có metadata nhưng app_id khác: app_id là căn cứ chính.
    expect(
      isOwnEcho(echo({ message: { is_echo: true, app_id: 263902037430900, metadata: 'dezon-inbox' } }), deps),
    ).toBe(false);
  });

  it('không có app_id thì dựa vào metadata của hệ thống', () => {
    expect(isOwnEcho(echo({ message: { is_echo: true, metadata: 'dezon-inbox' } }), deps)).toBe(true);
    expect(isOwnEcho(echo({ message: { is_echo: true } }), deps)).toBe(false);
    const id = '0b6f1c1e-6a51-4f53-9a0e-1f5b8c2d3e4f';
    expect(isOwnEcho(echo({ message: { is_echo: true, metadata: `dezon-inbox:${id}` } }), deps)).toBe(true);
  });

  it('ownEchoMessageId: chỉ nhận uuid hợp lệ trong metadata', () => {
    const id = '0b6f1c1e-6a51-4f53-9a0e-1f5b8c2d3e4f';
    expect(ownEchoMessageId({ message: { metadata: `dezon-inbox:${id}` } })).toBe(id);
    expect(ownEchoMessageId({ message: { metadata: 'dezon-inbox' } })).toBeUndefined();
    expect(ownEchoMessageId({ message: { metadata: 'dezon-inbox:1; drop table' } })).toBeUndefined();
    expect(ownEchoMessageId({ message: { metadata: `khac:${id}` } })).toBeUndefined();
    expect(ownEchoMessageId(null)).toBeUndefined();
  });

  it('tin khách (direction in) không bao giờ là echo', () => {
    expect(isOwnEcho(echo({ message: { app_id: 1517776481860111 } }, 'in'), deps)).toBe(false);
  });

  it('chưa cấu hình app id hoặc raw lạ => false', () => {
    expect(isOwnEcho(echo({ message: { app_id: 1517776481860111 } }), { ownAppIds: {} })).toBe(false);
    expect(isOwnEcho(echo(null), deps)).toBe(false);
    expect(isOwnEcho(echo('chuỗi'), deps)).toBe(false);
  });
});
