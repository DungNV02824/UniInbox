// toChatbotConfig: ghép bot đã lưu với bản nháp "Chat thử" (thuần, không DB).
import { describe, expect, it } from 'vitest';
import { toChatbotConfig } from './config';

const row = {
  id: 'bot-1',
  name: 'Tư vấn',
  instructions: 'Thân thiện',
  knowledge: 'Bảo hành 5 năm',
  examples: [],
  handoffKeywords: ['gặp nhân viên'],
  notifyKeywords: ['bảo hành'],
  handoffMessage: null,
  model: null,
  temperature: 0.4,
  escalateWhenUnsure: true,
  responseSpeed: 'balanced' as const,
};

describe('toChatbotConfig', () => {
  it('lấy responseSpeed của bot đã lưu', () => {
    expect(toChatbotConfig(row)).toMatchObject({ id: 'bot-1', responseSpeed: 'balanced' });
  });

  it('draft ghi đè responseSpeed (và các trường khác); draft không có ⇒ giữ bản đã lưu', () => {
    expect(toChatbotConfig(row, { responseSpeed: 'thorough' }).responseSpeed).toBe('thorough');
    expect(toChatbotConfig(row, { name: 'Nháp' })).toMatchObject({ name: 'Nháp', responseSpeed: 'balanced' });
  });

  it('notifyKeywords: lấy bản đã lưu; draft ghi đè (kể cả mảng rỗng)', () => {
    expect(toChatbotConfig(row).notifyKeywords).toEqual(['bảo hành']);
    expect(toChatbotConfig(row, { notifyKeywords: ['đơn gấp'] }).notifyKeywords).toEqual(['đơn gấp']);
    expect(toChatbotConfig(row, { notifyKeywords: [] }).notifyKeywords).toEqual([]);
    expect(toChatbotConfig(row, { name: 'Nháp' }).notifyKeywords).toEqual(['bảo hành']);
  });
});
