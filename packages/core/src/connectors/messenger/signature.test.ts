import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMessengerConnector, verifyMessengerChallenge, verifyMessengerSignature } from './index';

const SECRET = 'app-secret-test';
// Body có ký tự đã escape unicode như Meta gửi — HMAC phải tính trên đúng bytes nhận được.
const RAW = Buffer.from(
  '{"object":"page","entry":[{"id":"1","messaging":[{"message":{"text":"Ch\\u00e0o"}}]}]}',
);
const sign = (body: Buffer, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifyMessengerSignature', () => {
  it('chữ ký đúng => true (kể cả hex viết hoa)', () => {
    expect(verifyMessengerSignature(RAW, sign(RAW), SECRET)).toBe(true);
    expect(verifyMessengerSignature(RAW, `sha256=${sign(RAW).slice(7).toUpperCase()}`, SECRET)).toBe(true);
  });

  it('chữ ký sai / secret sai / body bị sửa => false', () => {
    expect(verifyMessengerSignature(RAW, sign(RAW, 'other'), SECRET)).toBe(false);
    expect(verifyMessengerSignature(Buffer.from(RAW.toString().replace('1', '2')), sign(RAW), SECRET)).toBe(
      false,
    );
  });

  it('hash trên JSON đã parse lại (bỏ escape) KHÔNG khớp', () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(RAW.toString())));
    expect(verifyMessengerSignature(RAW, sign(reserialized), SECRET)).toBe(false);
  });

  it('thiếu header / sai tiền tố / độ dài khác / không phải hex => false', () => {
    const hex = sign(RAW).slice(7);
    expect(verifyMessengerSignature(RAW, undefined, SECRET)).toBe(false);
    expect(verifyMessengerSignature(RAW, '', SECRET)).toBe(false);
    expect(verifyMessengerSignature(RAW, hex, SECRET)).toBe(false);
    expect(verifyMessengerSignature(RAW, `sha1=${hex}`, SECRET)).toBe(false);
    expect(verifyMessengerSignature(RAW, `sha256=${hex.slice(0, 40)}`, SECRET)).toBe(false);
    expect(verifyMessengerSignature(RAW, `sha256=${hex}00`, SECRET)).toBe(false);
    expect(verifyMessengerSignature(RAW, `sha256=${'z'.repeat(64)}`, SECRET)).toBe(false);
  });

  it('appSecret rỗng => false', () => {
    expect(verifyMessengerSignature(RAW, sign(RAW, ''), '')).toBe(false);
  });
});

describe('connector.verifyWebhook', () => {
  const connector = createMessengerConnector({
    appId: '1',
    appSecret: SECRET,
    graphBaseUrl: 'https://graph.test',
    graphVersion: 'v26.0',
  });

  it('đọc header x-hub-signature-256 không phân biệt hoa thường', () => {
    expect(connector.verifyWebhook({ headers: { 'x-hub-signature-256': sign(RAW) }, rawBody: RAW })).toBe(
      true,
    );
    expect(connector.verifyWebhook({ headers: { 'X-Hub-Signature-256': sign(RAW) }, rawBody: RAW })).toBe(
      true,
    );
    expect(connector.verifyWebhook({ headers: { 'x-hub-signature-256': [sign(RAW)] }, rawBody: RAW })).toBe(
      true,
    );
  });

  it('thiếu header => false', () => {
    expect(connector.verifyWebhook({ headers: {}, rawBody: RAW })).toBe(false);
  });
});

describe('verifyMessengerChallenge', () => {
  const q = (mode: unknown, token: unknown, challenge: unknown = '1158201444') => ({
    'hub.mode': mode,
    'hub.verify_token': token,
    'hub.challenge': challenge,
  });

  it('mode=subscribe + token khớp => trả challenge', () => {
    expect(verifyMessengerChallenge(q('subscribe', 'mytoken'), 'mytoken')).toBe('1158201444');
  });

  it('token sai / độ dài khác / mode khác / thiếu challenge => null', () => {
    expect(verifyMessengerChallenge(q('subscribe', 'wrong!!'), 'mytoken')).toBeNull();
    expect(verifyMessengerChallenge(q('subscribe', 'mytoken-long'), 'mytoken')).toBeNull();
    expect(verifyMessengerChallenge(q('unsubscribe', 'mytoken'), 'mytoken')).toBeNull();
    expect(
      verifyMessengerChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'mytoken' }, 'mytoken'),
    ).toBeNull();
    expect(verifyMessengerChallenge({}, 'mytoken')).toBeNull();
  });

  it('verify token cấu hình rỗng => luôn null', () => {
    expect(verifyMessengerChallenge(q('subscribe', ''), '')).toBeNull();
  });
});
