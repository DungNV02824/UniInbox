// Chỉ báo "đang soạn tin" của chatbot: realtime 'ai.typing' cho hộp thư + sender_action trên nền tảng (Messenger
// hiện dấu ba chấm cho khách). Mọi bước là việc phụ: KHÔNG chặn, KHÔNG làm hỏng lượt trả lời; lỗi chỉ log debug
// (không kèm token/nội dung).
import { randomUUID } from 'node:crypto';
import type { Db } from '@dezon/db';
import type { ChannelType } from '@dezon/shared';
import { loadResolvedAccount, type CredentialsCipher } from '../channels/service';
import type {
  ChannelConnector,
  ChannelRecipient,
  ResolvedChannelAccount,
  SenderAction,
} from '../connectors/types';
import type { PipelineLogger } from '../pipeline/types';
import { roomsForConversation, type RealtimePublisher } from '../realtime';
import { errorText } from './delivery';

/**
 * Facebook tự tắt typing sau ~20 s; lượt LLM (kể cả thử lại) có thể lâu hơn ⇒ gửi lại typing_on theo chu kỳ này
 * cho tới khi kết thúc.
 */
export const TYPING_REFRESH_MS = 15_000;

/**
 * Khóa Redis "job nào đang giữ chỉ báo" của hội thoại. Hai khe job `ai-<conv>` / `ai-<conv>-next` có thể chạy
 * chồng nhau: job mới ghi token của nó khi bắt đầu; job cũ kết thúc sau (vd. bị hủy vì khách nhắn thêm) thấy
 * token đã đổi ⇒ KHÔNG phát typing:false / typing_off (job mới vẫn đang soạn).
 */
export const aiTypingOwnerKey = (conversationId: string) => `ai-typing:${conversationId}`;
/** TTL khóa chủ sở hữu (rộng hơn mọi lượt LLM; khóa hết hạn/trống ⇒ coi như không job nào khác giữ). */
export const AI_TYPING_OWNER_TTL_MS = 10 * 60_000;

/** Tập con ioredis (cùng hình với DebounceRedis của runtime). */
export interface AiTypingRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

export interface AiTypingDeps {
  publisher: RealtimePublisher;
  cipher: CredentialsCipher;
  logger: PipelineLogger;
  connectors?: Partial<Record<ChannelType, ChannelConnector>>;
  /** Thiếu ⇒ không theo dõi chủ sở hữu (job luôn tự tắt chỉ báo của mình). */
  redis?: AiTypingRedis;
}

export interface AiTypingTarget {
  conversationId: string;
  assignedUserId: string | null;
  channelType: ChannelType;
  channelAccountId: string;
  /** PSID của khách (contact_identities.external_user_id); null ⇒ chỉ phát realtime. */
  externalUserId: string | null;
  chatbotName: string | null;
}

export interface AiTypingSession {
  /**
   * Kết thúc (gọi một lần, trong finally; không bao giờ ném): bỏ các mark_seen/typing_on CHƯA bắt đầu gửi (để
   * không đến sau tin bot). Nếu job này còn giữ chỉ báo (không có job mới hơn ghi đè aiTypingOwnerKey): phát
   * 'ai.typing' typing:false và gửi 'typing_off' khi KHÔNG có bong bóng bot nào sắp gửi (tin của Page tự tắt
   * dấu ba chấm trên Messenger).
   */
  stop(opts: { botReplyQueued: boolean }): Promise<void>;
  /** Chờ các sender_action đã xếp hàng xong (chỉ dùng cho test / tắt worker). */
  idle(): Promise<void>;
}

/** Gửi sender_action nối tiếp nhau (typing_off không được vượt lên trước typing_on). */
export interface SenderActionQueue {
  push(action: SenderAction): void;
  /** Bỏ các 'typing_on' / 'mark_seen' đã xếp hàng nhưng CHƯA bắt đầu gửi ('typing_off' vẫn gửi). */
  cancelPending(): void;
  idle(): Promise<void>;
}

/**
 * Hàng đợi sender_action fire-and-forget cho một khách. Connector không có sendSenderAction / không có PSID ⇒
 * null. Tài khoản kênh (giải mã credentials) chỉ tải một lần, khi có action đầu tiên.
 */
export function createSenderActionQueue(
  db: Db,
  deps: Pick<AiTypingDeps, 'cipher' | 'logger' | 'connectors'>,
  target: Pick<AiTypingTarget, 'conversationId' | 'channelType' | 'channelAccountId' | 'externalUserId'>,
  preloadedAccount?: ResolvedChannelAccount,
  /** Kiểm ngay trước khi gửi (false ⇒ bỏ action này). Thiếu ⇒ luôn gửi. */
  shouldSend?: (action: SenderAction) => Promise<boolean>,
): SenderActionQueue | null {
  const connector = deps.connectors?.[target.channelType];
  const send = connector?.sendSenderAction?.bind(connector);
  if (!send || !target.externalUserId) return null;
  const to: ChannelRecipient = { externalUserId: target.externalUserId };
  let account: Promise<ResolvedChannelAccount | null> | undefined = preloadedAccount
    ? Promise.resolve(preloadedAccount)
    : undefined;
  let chain: Promise<void> = Promise.resolve();
  const queued = new Set<{ action: SenderAction; dropped: boolean }>();
  return {
    push(action) {
      account ??= loadResolvedAccount(db, deps.cipher, target.channelAccountId);
      const pending = account;
      const entry = { action, dropped: false };
      queued.add(entry);
      chain = chain
        .then(async () => {
          const resolved = await pending;
          queued.delete(entry);
          if (!resolved || entry.dropped) return;
          if (shouldSend && !(await shouldSend(action))) return;
          await send(resolved, to, action);
        })
        .catch((error: unknown) => {
          queued.delete(entry);
          deps.logger.debug(
            { conversationId: target.conversationId, action, err: errorText(error) },
            'Không gửi được chỉ báo đang soạn tin',
          );
        });
    },
    cancelPending() {
      for (const entry of queued) if (entry.action !== 'typing_off') entry.dropped = true;
    },
    idle: () => chain,
  };
}

/**
 * Bắt đầu chỉ báo "đang soạn tin" (gọi khi lượt chatbot đã qua hết điều kiện chạy và có quyền gửi — Messenger
 * cũng chặn sender_action ngoài cửa sổ 24 h): nhận quyền giữ chỉ báo (aiTypingOwnerKey), phát realtime
 * typing:true, fire-and-forget mark_seen + typing_on trên nền tảng (song song với tải lịch sử/ảnh/LLM), gửi lại
 * typing_on mỗi TYPING_REFRESH_MS khi còn giữ chỉ báo.
 */
export function startAiTyping(db: Db, deps: AiTypingDeps, target: AiTypingTarget): AiTypingSession {
  const debug = (error: unknown, msg: string) =>
    deps.logger.debug({ conversationId: target.conversationId, err: errorText(error) }, msg);
  const emit = (typing: boolean) => emitAiTyping(deps, target, typing);

  let stopped = false;
  let stopping: Promise<void> | undefined;

  // Ghi token (đè token của job cũ còn chạy) TRƯỚC khi phát typing:true, để job cũ kết thúc sau đó thấy token đã
  // đổi. Lỗi Redis ⇒ vẫn phát (chỉ mất khả năng nhường cho job mới).
  const redis = deps.redis;
  const key = aiTypingOwnerKey(target.conversationId);
  const token = randomUUID();
  let claimed: Promise<void> = Promise.resolve();
  if (redis) {
    claimed = redis
      .set(key, token, 'PX', AI_TYPING_OWNER_TTL_MS)
      .then(
        () => undefined,
        (error: unknown) => debug(error, 'Không ghi được khóa chỉ báo đang soạn tin'),
      )
      .then(() => emit(true));
  } else {
    emit(true);
  }
  /** Còn giữ chỉ báo? Khóa trống/hết hạn ⇒ có; lỗi Redis ⇒ có (thà tắt còn hơn treo dấu ba chấm). */
  const owns = async (): Promise<boolean> => {
    if (!redis) return true;
    try {
      const current = await redis.get(key);
      return current === null || current === token;
    } catch (error) {
      debug(error, 'Không đọc được khóa chỉ báo đang soạn tin');
      return true;
    }
  };

  const actions = createSenderActionQueue(db, deps, target);
  let timer: ReturnType<typeof setInterval> | undefined;
  if (actions) {
    actions.push('mark_seen');
    actions.push('typing_on');
    timer = setInterval(() => {
      // Job mới hơn đã giữ chỉ báo ⇒ không làm mới (typing_on của job cũ có thể đến sau tin của job mới).
      void owns().then((mine) => {
        if (mine && !stopped) actions.push('typing_on');
      });
    }, TYPING_REFRESH_MS);
    timer.unref?.();
  }

  return {
    stop({ botReplyQueued }) {
      if (stopping) return stopping;
      stopped = true;
      if (timer) clearInterval(timer);
      // typing_on/mark_seen chưa gửi có thể đến SAU tin bot (dấu ba chấm treo ~20 s) ⇒ bỏ.
      actions?.cancelPending();
      stopping = (async () => {
        await claimed;
        if (!(await owns())) return; // Job mới hơn đang soạn: để nó tự tắt.
        if (redis) {
          await redis.del(key).catch((error: unknown) => debug(error, 'Không xóa được khóa chỉ báo'));
        }
        emit(false);
        if (actions && !botReplyQueued) actions.push('typing_off');
      })();
      return stopping;
    },
    idle: async () => {
      await claimed;
      await stopping;
      await actions?.idle();
    },
  };
}

// ---------- Chỉ báo sớm (ngay khi tin khách đến, trước debounce) ----------

/**
 * Token khóa chủ sở hữu do hook tin khách ghi (chỉ báo sớm, chưa có job nào chạy). Job ghi đè bằng token của nó
 * khi bắt đầu soạn; job bị 'skipped' thấy token còn tiền tố này ⇒ tự tắt chỉ báo sớm (releaseEarlyAiTyping).
 */
export const EARLY_TYPING_TOKEN_PREFIX = 'early:';

export interface EarlyAiTyping {
  /** false ⇒ không bật (job khác đang giữ chỉ báo, hoặc lỗi Redis). */
  started: boolean;
  /** Chờ các sender_action đã xếp hàng xong (test). */
  idle(): Promise<void>;
}

/**
 * Bật chỉ báo "đang soạn tin" NGAY khi tin khách được lưu (gọi sau khi đã lên lịch job và đã kiểm bot có quyền
 * gửi), để khách không phải nhìn khoảng trống bằng độ trễ gom tin. Nhận khóa chủ sở hữu bằng SET NX (KHÔNG cướp
 * chỉ báo của job đang soạn), phát realtime typing:true, fire-and-forget mark_seen + typing_on. typing_on chỉ gửi
 * nếu khóa vẫn là token sớm này (job đã nhận/kết thúc ⇒ bỏ, để không đến sau tin bot). Tắt: job ghi đè khóa rồi
 * tự tắt trong finally; job 'skipped' gọi releaseEarlyAiTyping. Không bao giờ ném.
 */
export async function startEarlyAiTyping(
  db: Db,
  deps: AiTypingDeps & { redis: AiTypingRedis },
  target: AiTypingTarget,
  ttlMs: number = AI_TYPING_OWNER_TTL_MS,
): Promise<EarlyAiTyping> {
  const key = aiTypingOwnerKey(target.conversationId);
  const token = `${EARLY_TYPING_TOKEN_PREFIX}${randomUUID()}`;
  const notStarted: EarlyAiTyping = { started: false, idle: () => Promise.resolve() };
  try {
    const claimed = await deps.redis.set(key, token, 'PX', Math.max(1_000, Math.round(ttlMs)), 'NX');
    if (claimed === null) return notStarted;
  } catch (error) {
    deps.logger.debug(
      { conversationId: target.conversationId, err: errorText(error) },
      'Không ghi được khóa chỉ báo đang soạn tin (sớm)',
    );
    return notStarted;
  }
  emitAiTyping(deps, target, true);
  const stillMine = async (): Promise<boolean> => {
    try {
      return (await deps.redis.get(key)) === token;
    } catch {
      return false;
    }
  };
  const actions = createSenderActionQueue(db, deps, target, undefined, (action) =>
    action === 'typing_on' ? stillMine() : Promise.resolve(true),
  );
  actions?.push('mark_seen');
  actions?.push('typing_on');
  return { started: true, idle: () => actions?.idle() ?? Promise.resolve() };
}

/**
 * Job 'skipped' (AI tắt, không có tin mới, không được chạy): nếu khóa còn là token chỉ báo sớm (chưa job nào
 * nhận) ⇒ xóa khóa, phát typing:false, gửi typing_off (fire-and-forget). Không bao giờ ném.
 */
export async function releaseEarlyAiTyping(
  db: Db,
  deps: AiTypingDeps & { redis: AiTypingRedis },
  target: AiTypingTarget,
): Promise<boolean> {
  const key = aiTypingOwnerKey(target.conversationId);
  try {
    const current = await deps.redis.get(key);
    if (!current?.startsWith(EARLY_TYPING_TOKEN_PREFIX)) return false;
    await deps.redis.del(key);
  } catch (error) {
    deps.logger.debug(
      { conversationId: target.conversationId, err: errorText(error) },
      'Không tắt được chỉ báo đang soạn tin (sớm)',
    );
    return false;
  }
  emitAiTyping(deps, target, false);
  createSenderActionQueue(db, deps, target)?.push('typing_off');
  return true;
}

function emitAiTyping(
  deps: Pick<AiTypingDeps, 'publisher' | 'logger'>,
  target: AiTypingTarget,
  typing: boolean,
): void {
  try {
    deps.publisher.emit(roomsForConversation({ assignedUserId: target.assignedUserId }), 'ai.typing', {
      conversationId: target.conversationId,
      typing,
      chatbotName: target.chatbotName,
    });
  } catch (error) {
    deps.logger.debug(
      { conversationId: target.conversationId, err: errorText(error) },
      'Không phát được ai.typing',
    );
  }
}
