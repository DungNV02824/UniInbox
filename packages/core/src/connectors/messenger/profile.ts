// User Profile API (docs/research/messenger-platform.md §8). Lỗi => ném Error để pipeline bỏ qua.
import type { ResolvedChannelAccount } from '../types';
import type { MessengerConfig } from './config';
import { graphErrorCode, graphRequest } from './graph';
import { pageTokenOf } from './send';

const PROFILE_FIELDS = 'first_name,last_name,name,profile_pic';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export async function fetchMessengerProfile(
  config: MessengerConfig,
  account: ResolvedChannelAccount,
  psid: string,
): Promise<{ name?: string; avatarUrl?: string }> {
  const token = pageTokenOf(account);
  const res = await graphRequest(config, {
    method: 'GET',
    path: encodeURIComponent(psid),
    token,
    query: { fields: PROFILE_FIELDS },
  });
  if (!res.ok) {
    // Thiếu Advanced Access, khách từ quảng cáo chưa trả lời, tài khoản tạo bằng SĐT (2018218)...
    throw new Error(`Không lấy được hồ sơ khách Messenger (mã ${graphErrorCode(res.status, res.error)})`);
  }
  // "If the app is unable to access the person's profile, an empty object is returned."
  const fullName = [str(res.data.first_name), str(res.data.last_name)].filter(Boolean).join(' ');
  const name = str(res.data.name) ?? str(fullName);
  const avatarUrl = str(res.data.profile_pic);
  return { ...(name ? { name } : {}), ...(avatarUrl ? { avatarUrl } : {}) };
}
