import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../config';
import { MessengerConfigService } from './messenger-config.service';

const base = {
  META_APP_ID: 'app-id',
  META_APP_SECRET: 'app-secret',
  META_GRAPH_VERSION: 'v26.0',
  META_GRAPH_BASE_URL: 'https://graph.facebook.com',
} as unknown as AppConfig;

describe('MessengerConfigService.graphConfig', () => {
  it('truyền META_LOGIN_DIALOG_BASE_URL xuống connector (để thử Facebook Login với dialog giả lập)', () => {
    const service = new MessengerConfigService({
      ...base,
      META_LOGIN_DIALOG_BASE_URL: 'http://localhost:4900',
    });
    expect(service.graphConfig().loginDialogBaseUrl).toBe('http://localhost:4900');
  });

  it('không đặt biến => connector dùng host mặc định của Facebook', () => {
    expect(new MessengerConfigService(base).graphConfig().loginDialogBaseUrl).toBeUndefined();
  });

  it('thiếu META_APP_ID => 503', () => {
    const service = new MessengerConfigService({ ...base, META_APP_ID: undefined });
    expect(() => service.graphConfig()).toThrow(/META_APP_ID/);
  });
});
