// Graph API cho trang admin Kênh: kiểm Page token, đăng ký/huỷ webhook của Page (§9 tài liệu research).
import type { MessengerConfig, MessengerGraphApi } from './config';
import {
  GraphNetworkError,
  graphErrorCode,
  graphRequest,
  type GraphRequest,
  type GraphResponse,
} from './graph';

/** Các field hợp lệ theo reference subscribed_apps (reactions/edits chưa dùng ở 1A nên không đăng ký). */
export const MESSENGER_SUBSCRIBED_FIELDS = [
  'messages',
  'message_echoes',
  'message_deliveries',
  'message_reads',
  'messaging_referrals',
  'messaging_postbacks',
  'standby',
  'messaging_handovers',
] as const;

export const MSG_PAGE_TOKEN_INVALID = 'Page Access Token không hợp lệ hoặc đã hết hạn';
export const MSG_NOT_PAGE_TOKEN = 'Token này không phải của Fanpage — hãy dùng Page Access Token';

type Action = 'check' | 'subscribe' | 'unsubscribe';

const ACTION_LABEL: Record<Action, string> = {
  check: 'Không kiểm tra được token với Facebook',
  subscribe: 'Không đăng ký được webhook cho Fanpage',
  unsubscribe: 'Không huỷ được đăng ký webhook của Fanpage',
};

function adminError(action: Action, res: Extract<GraphResponse, { ok: false }>): Error {
  const { code: errCode, message } = res.error;
  const code = graphErrorCode(res.status, res.error);
  if (errCode === 190 || errCode === 102) return new Error(`${MSG_PAGE_TOKEN_INVALID} (mã ${code})`);
  // /me?fields=...,category bằng token người dùng => "nonexisting field (category) on node type (User)".
  if (action === 'check' && errCode === 100 && /node type \((User|Application)\)/i.test(message ?? '')) {
    return new Error(MSG_NOT_PAGE_TOKEN);
  }
  // 10 và dải 200-299: lỗi quyền.
  if (errCode === 10 || (errCode !== undefined && errCode >= 200 && errCode < 300)) {
    return new Error(
      `${ACTION_LABEL[action]}: token thiếu quyền (cần pages_messaging, pages_manage_metadata, pages_show_list) (mã ${code})`,
    );
  }
  return new Error(`${ACTION_LABEL[action]} (mã ${code})`);
}

async function call(config: MessengerConfig, action: Action, req: GraphRequest) {
  if (!req.token.trim()) throw new Error(MSG_PAGE_TOKEN_INVALID);
  let res: GraphResponse;
  try {
    res = await graphRequest(config, req);
  } catch (err) {
    if (err instanceof GraphNetworkError)
      throw new Error('Không kết nối được tới Facebook, vui lòng thử lại');
    throw err;
  }
  if (!res.ok) throw adminError(action, res);
  return res.data;
}

function isSuccess(data: Record<string, unknown>): boolean {
  return data.success === true || data.success === 'true';
}

export function createGraphApi(config: MessengerConfig): MessengerGraphApi {
  return {
    async getPage(pageAccessToken) {
      // `category` chỉ có ở node Page => phân biệt Page token với User token.
      const data = await call(config, 'check', {
        method: 'GET',
        path: 'me',
        token: pageAccessToken,
        query: { fields: 'id,name,category' },
      });
      const id = data.id;
      const name = data.name;
      if (typeof id !== 'string' || typeof name !== 'string' || data.category === undefined) {
        throw new Error(MSG_NOT_PAGE_TOKEN);
      }
      return { id, name };
    },

    async subscribeApp(pageId, pageAccessToken) {
      const data = await call(config, 'subscribe', {
        method: 'POST',
        path: `${encodeURIComponent(pageId)}/subscribed_apps`,
        token: pageAccessToken,
        body: { subscribed_fields: MESSENGER_SUBSCRIBED_FIELDS.join(',') },
      });
      if (!isSuccess(data)) throw new Error(ACTION_LABEL.subscribe);
    },

    async unsubscribeApp(pageId, pageAccessToken) {
      const data = await call(config, 'unsubscribe', {
        method: 'DELETE',
        path: `${encodeURIComponent(pageId)}/subscribed_apps`,
        token: pageAccessToken,
      });
      if (!isSuccess(data)) throw new Error(ACTION_LABEL.unsubscribe);
    },
  };
}
