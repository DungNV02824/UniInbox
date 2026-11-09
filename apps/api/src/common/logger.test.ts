import { describe, expect, it } from 'vitest';
import { redactUrl } from './logger';

describe('redactUrl', () => {
  it('che code/state của callback Facebook, giữ tham số khác', () => {
    expect(redactUrl('/channels/messenger/oauth/callback?code=AQD123&state=abc&x=1')).toBe(
      '/channels/messenger/oauth/callback?code=[REDACTED]&state=[REDACTED]&x=1',
    );
    expect(redactUrl('/a?access_token=EAA&ok=2')).toBe('/a?access_token=[REDACTED]&ok=2');
    expect(redactUrl('/inbox?status=open')).toBe('/inbox?status=open');
  });

  it('che hub.verify_token khi Meta xác minh webhook, giữ hub.mode/hub.challenge', () => {
    expect(
      redactUrl('/webhooks/messenger?hub.mode=subscribe&hub.verify_token=s3cret&hub.challenge=123'),
    ).toBe('/webhooks/messenger?hub.mode=subscribe&hub.verify_token=[REDACTED]&hub.challenge=123');
    expect(redactUrl('/webhooks/messenger?hub%2Everify_token=s3cret&hub%2Echallenge=1')).toBe(
      '/webhooks/messenger?hub%2Everify_token=[REDACTED]&hub%2Echallenge=1',
    );
    expect(redactUrl('/webhooks/messenger?hub.verify_token=s3cret')).toBe(
      '/webhooks/messenger?hub.verify_token=[REDACTED]',
    );
  });
});
