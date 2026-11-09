// Kết nối Fanpage bằng Facebook Login (docs/research/messenger-platform.md §12).
// KHÔNG ghi log / trả về token hay code.
import { randomBytes } from 'node:crypto';
import {
  connectMessengerPage,
  type CredentialsCipher,
  InboxNotFoundError,
  InboxValidationError,
  type MessengerGraphApi,
  type MessengerLoginApi,
  pageMessagingAccess,
} from '@dezon/core';
import { channelAccounts, type Db } from '@dezon/db';
import type {
  ConnectFacebookPageResult,
  ConnectFacebookPagesResult,
  FacebookLoginErrorCode,
  FacebookLoginSessionDto,
  FacebookLoginStartResponse,
} from '@dezon/shared';
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { CryptoService } from '../../../infra/crypto/crypto.service';
import { DB } from '../../../infra/db/db.constants';
import { CREDENTIALS_CIPHER } from '../../../infra/inbox/inbox.constants';
import { MessengerConfigService } from '../../connectors/messenger/messenger-config.service';
import { MESSENGER_GRAPH_API, MESSENGER_LOGIN_API } from '../../connectors/messenger/messenger.constants';
import { ChannelSyncService } from '../channel-sync.service';
import { FB_SESSION_TTL_SEC, FacebookLoginStore, type StoredFacebookPage } from './facebook-login.store';

export const FB_CALLBACK_PATH = '/channels/messenger/oauth/callback';
const SESSION_NOT_FOUND = 'Phiên đăng nhập Facebook không tồn tại hoặc đã hết hạn, vui lòng đăng nhập lại';
const STATE_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

export interface FacebookCallbackQuery {
  code?: unknown;
  state?: unknown;
  error?: unknown;
  error_reason?: unknown;
}

const token = (bytes: number) => randomBytes(bytes).toString('base64url');
const aadOf = (sessionId: string, pageId: string) => `fb-login:${sessionId}:${pageId}`;
const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** Lỗi đã chuẩn hóa để redirect `?fbError=`. */
class CallbackError extends Error {
  constructor(readonly code: FacebookLoginErrorCode) {
    super(code);
  }
}

@Injectable()
export class FacebookLoginService {
  private readonly logger = new Logger(FacebookLoginService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(CREDENTIALS_CIPHER) private readonly cipher: CredentialsCipher,
    @Inject(MESSENGER_GRAPH_API) private readonly graph: MessengerGraphApi,
    @Inject(MESSENGER_LOGIN_API) private readonly login: MessengerLoginApi,
    private readonly meta: MessengerConfigService,
    private readonly crypto: CryptoService,
    private readonly store: FacebookLoginStore,
    private readonly sync: ChannelSyncService,
  ) {}

  redirectUri(): string {
    return `${trimSlash(this.config.API_URL)}${FB_CALLBACK_PATH}`;
  }

  private appRedirect(params: Record<string, string>): string {
    const url = new URL(`${trimSlash(this.config.APP_URL)}/admin/channels`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  /** Tạo state (32 byte ngẫu nhiên, 10 phút) gắn với admin, trả URL dialog Facebook. */
  async start(userId: string): Promise<FacebookLoginStartResponse> {
    this.meta.graphConfig(); // thiếu cấu hình Meta => 503
    const state = token(32);
    const authorizeUrl = this.login.buildLoginUrl({
      redirectUri: this.redirectUri(),
      state,
      configId: this.meta.loginConfigId(),
    });
    await this.store.saveState(state, userId);
    return { authorizeUrl };
  }

  /** Xử lý redirect từ Facebook; luôn trả URL để 302 về trang admin Kênh. */
  async handleCallback(query: FacebookCallbackQuery): Promise<string> {
    try {
      const sessionId = await this.completeLogin(query);
      return this.appRedirect({ fbSession: sessionId });
    } catch (err) {
      const code: FacebookLoginErrorCode =
        err instanceof CallbackError
          ? err.code
          : err instanceof HttpException && err.getStatus() === HttpStatus.SERVICE_UNAVAILABLE
            ? 'not_configured'
            : 'exchange';
      // Thông điệp lỗi do code của ta tạo (không chứa token/code).
      this.logger.warn(
        `Facebook Login thất bại (${code}): ${err instanceof Error ? `${err.name}: ${err.message}` : 'không rõ'}`,
      );
      return this.appRedirect({ fbError: code });
    }
  }

  private async completeLogin(query: FacebookCallbackQuery): Promise<string> {
    const state = typeof query.state === 'string' ? query.state : '';
    const owner = STATE_PATTERN.test(state) ? await this.store.consumeState(state) : null;
    if (!owner) throw new CallbackError('state');
    if (query.error !== undefined || query.error_reason !== undefined) {
      throw new CallbackError(query.error === 'access_denied' ? 'denied' : 'unknown');
    }
    const code = typeof query.code === 'string' ? query.code : '';
    if (!code || code.length > 4000) throw new CallbackError('exchange');

    this.meta.graphConfig();
    const short = await this.login.exchangeCode(code, this.redirectUri());
    const long = await this.login.exchangeLongLivedUserToken(short.accessToken);
    const fbUser = await this.login.getMe(long.accessToken);
    const pages = await this.login.listPages(long.accessToken);

    const sessionId = token(24);
    const stored: StoredFacebookPage[] = pages.map((p) => ({
      id: p.id,
      name: p.name,
      pictureUrl: p.pictureUrl && p.pictureUrl.startsWith('https://') ? p.pictureUrl : null,
      tasks: p.tasks,
      tokenEnc: this.crypto.encrypt(p.accessToken, aadOf(sessionId, p.id)),
    }));
    await this.store.saveSession(sessionId, {
      userId: owner.userId,
      fbUser,
      pages: stored,
      expiresAt: new Date(Date.now() + FB_SESSION_TTL_SEC * 1000).toISOString(),
    });
    return sessionId;
  }

  private async ownedSession(userId: string, sessionId: string) {
    const session = SESSION_ID_PATTERN.test(sessionId) ? await this.store.getSession(sessionId) : null;
    // Phiên của admin khác: trả 404 như không tồn tại.
    if (!session || session.userId !== userId) throw new InboxNotFoundError(SESSION_NOT_FOUND);
    return session;
  }

  async getSession(userId: string, sessionId: string): Promise<FacebookLoginSessionDto> {
    const session = await this.ownedSession(userId, sessionId);
    const ids = session.pages.map((p) => p.id);
    const rows = ids.length
      ? await this.db
          .select({
            id: channelAccounts.id,
            externalId: channelAccounts.externalId,
            status: channelAccounts.status,
          })
          .from(channelAccounts)
          .where(and(eq(channelAccounts.type, 'messenger'), inArray(channelAccounts.externalId, ids)))
      : [];
    const byPage = new Map(rows.map((r) => [r.externalId, r]));
    return {
      sessionId,
      fbUser: session.fbUser,
      expiresAt: session.expiresAt,
      pages: session.pages.map((p) => {
        const row = byPage.get(p.id);
        const access = pageMessagingAccess(p.tasks);
        return {
          id: p.id,
          name: p.name,
          pictureUrl: p.pictureUrl,
          alreadyConnected: row?.status === 'connected',
          channelAccountId: row?.id ?? null,
          canMessage: access.canMessage,
          cannotMessageReason: access.reason,
        };
      }),
    };
  }

  /** Kết nối từng Trang đã chọn (lỗi Trang này không chặn Trang khác), sau đó xóa phiên. */
  async connect(userId: string, sessionId: string, pageIds: string[]): Promise<ConnectFacebookPagesResult> {
    this.meta.graphConfig();
    const session = await this.ownedSession(userId, sessionId);
    if (!(await this.store.deleteSession(sessionId))) throw new InboxNotFoundError(SESSION_NOT_FOUND);

    const results: ConnectFacebookPageResult[] = [];
    for (const pageId of [...new Set(pageIds)]) {
      const page = session.pages.find((p) => p.id === pageId);
      if (!page) {
        results.push({ pageId, ok: false, error: 'Trang không có trong phiên đăng nhập Facebook' });
        continue;
      }
      const access = pageMessagingAccess(page.tasks);
      if (!access.canMessage) {
        results.push({ pageId, ok: false, error: access.reason ?? 'Không đủ quyền trên Trang' });
        continue;
      }
      try {
        const channel = await connectMessengerPage(
          this.db,
          { graph: this.graph, cipher: this.cipher, actorUserId: userId },
          { pageAccessToken: this.crypto.decrypt(page.tokenEnc, aadOf(sessionId, page.id)) },
          {
            connectedBy: {
              provider: 'facebook_login',
              fbUserId: session.fbUser.id,
              fbUserName: session.fbUser.name,
            },
            pictureUrl: page.pictureUrl,
            expectedPageId: page.id,
          },
        );
        // Tự đồng bộ lịch sử cho Trang vừa kết nối (không bao giờ ném lỗi).
        results.push({ pageId, ok: true, channel: await this.sync.afterConnect(channel) });
      } catch (err) {
        if (err instanceof InboxValidationError) {
          results.push({ pageId, ok: false, error: err.message });
        } else {
          this.logger.warn(`Kết nối Trang ${pageId} lỗi: ${err instanceof Error ? err.name : 'không rõ'}`);
          results.push({ pageId, ok: false, error: 'Lỗi hệ thống khi kết nối Trang, vui lòng thử lại' });
        }
      }
    }
    return { results };
  }
}
