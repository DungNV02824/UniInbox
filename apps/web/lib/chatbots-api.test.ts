import { describe, expect, it } from 'vitest';
import { normalizeModels } from './chatbots-api';

describe('normalizeModels', () => {
  it('nhận {defaultModel, models}', () => {
    expect(
      normalizeModels({ defaultModel: 'gemini-2.5-flash', models: ['gemini-2.5-flash', 'gemini-2.5-pro'] }),
    ).toEqual({ defaultModel: 'gemini-2.5-flash', models: ['gemini-2.5-flash', 'gemini-2.5-pro'] });
  });

  it('nhận string[], bỏ phần tử lạ và trùng', () => {
    expect(normalizeModels(['a', 1, '', 'a', 'b'])).toEqual({ defaultModel: null, models: ['a', 'b'] });
  });

  it('dữ liệu hỏng => rỗng', () => {
    expect(normalizeModels(null)).toEqual({ defaultModel: null, models: [] });
    expect(normalizeModels({ models: 'x' })).toEqual({ defaultModel: null, models: [] });
  });
});
