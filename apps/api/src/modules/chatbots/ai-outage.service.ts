import {
  AI_AUTO_RESUME_JOB_NAME,
  AI_MANUAL_PROBE_ATTEMPTS,
  AI_MANUAL_RESUME_JOB_ID,
  type AiAutoResumeJobData,
  countAiOutageWaiting,
  countAiOutageWaitingByModel,
  getAiSettings,
  type InboxContext,
  listAiMissedReplies,
  type LlmClient,
  probeLlm,
  putAiSettings,
} from '@dezon/core';
import type { Db } from '@dezon/db';
import type { AiOutageResumeResponse, AiOutageStatus, AuthUser } from '@dezon/shared';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { withTimeout } from '../../common/with-timeout';
import { APP_CONFIG, type AppConfig } from '../../config';
import { LLM_CLIENT } from '../../infra/ai/ai.constants';
import { DB } from '../../infra/db/db.constants';
import { INBOX_CONTEXT } from '../../infra/inbox/inbox.constants';
import { AI_REPLY_QUEUE, ENQUEUE_TIMEOUT_MS } from '../../infra/queue/queue.constants';

export const AI_OUTAGE_NOT_CONFIGURED_MESSAGE = 'Chưa cấu hình GEMINI_API_KEY';
export const AI_OUTAGE_NOTHING_TO_DO_MESSAGE =
  'AI đang bật và không có hội thoại nào đang chờ bot trả lời lại';
export const AI_OUTAGE_ADMIN_ONLY_MESSAGE = 'Chỉ quản trị viên bật lại được AI toàn hệ thống';
export const AI_OUTAGE_STILL_DOWN_PREFIX = 'AI vẫn chưa hoạt động lại: ';
export const AI_OUTAGE_ENQUEUE_FAILED_MESSAGE =
  'Chưa đẩy được yêu cầu cho máy xử lý nền (Redis lỗi) — vui lòng bấm lại sau ít phút';

/** Tối đa ký tự của lỗi gốc khi không nhận ra loại lỗi. */
const RAW_ERROR_MAX_CHARS = 160;

/**
 * Lỗi gọi thử AI (chữ lỗi của LlmError: "Gemini HTTP <status>: …", "Hết thời gian chờ AI…", "Lỗi gọi Gemini: …") ⇒
 * câu ngắn cho nhân viên. Hết tiền / hạn mức ⇒ "hết hạn mức / chưa nạp tiền Gemini".
 */
export function describeAiProbeError(error: string): string {
  const status = Number(/Gemini HTTP (\d{3})/.exec(error)?.[1] ?? NaN);
  if (status === 402 || /billing|prepay|credit|quota|payment|RESOURCE_EXHAUSTED/i.test(error)) {
    return 'hết hạn mức / chưa nạp tiền Gemini';
  }
  if (status === 429) return 'Gemini đang quá tải, thử lại sau ít phút';
  if (/Hết thời gian chờ/i.test(error)) return 'Gemini phản hồi quá chậm (hết thời gian chờ)';
  if (status === 401 || status === 403 || /api[ _-]?key/i.test(error)) {
    return 'khóa API Gemini không hợp lệ hoặc không đủ quyền';
  }
  if (status === 404) return 'không tìm thấy model Gemini đang cấu hình';
  if (status === 503 || /high demand|overloaded|UNAVAILABLE/i.test(error)) {
    return 'Google đang quá tải model này (lỗi 503) — thử lại sau ít phút hoặc đổi Model của bot';
  }
  if (status >= 500) return 'máy chủ Gemini đang lỗi';
  if (/fetch failed|network|socket|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(error)) {
    return 'không kết nối được tới Gemini';
  }
  const raw = error.trim().replace(/\s+/g, ' ');
  return raw.length > RAW_ERROR_MAX_CHARS
    ? `${raw.slice(0, RAW_ERROR_MAX_CHARS - 1)}…`
    : raw || 'lỗi không rõ';
}

/**
 * Nút "Bật lại AI" (hợp đồng AiOutageStatus / AiOutageResumeResponse của @dezon/shared): bật lại AI cho toàn hệ thống —
 * công tắc AI chung, hội thoại "Cần người" vì lỗi AI, hội thoại bị bỏ sót. Việc nặng do worker làm (job
 * AI_AUTO_RESUME_JOB_NAME với data.manual); API chỉ kiểm, gọi thử AI, bật công tắc và đẩy job.
 */
@Injectable()
export class AiOutageService {
  private readonly logger = new Logger(AiOutageService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(INBOX_CONTEXT) private readonly ctx: InboxContext,
    @Inject(AI_REPLY_QUEUE) private readonly aiReply: Queue<AiAutoResumeJobData>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient | null,
  ) {}

  async status(): Promise<AiOutageStatus> {
    const now = this.ctx.now();
    const [settings, waiting, missed] = await Promise.all([
      getAiSettings(this.db),
      countAiOutageWaiting(this.db, now),
      listAiMissedReplies(this.db, this.ctx, now),
    ]);
    return { aiEnabled: settings.enabled, waiting, missed: missed.items.length };
  }

  /**
   * Thứ tự kiểm (hợp đồng): thiếu GEMINI_API_KEY ⇒ 503; công tắc bật và waiting = missed = 0 ⇒ 409; công tắc tắt mà
   * không phải admin ⇒ 403; gọi thử AI (mọi model của bot đang chờ + bị bỏ sót; không có ⇒ model mặc định) hỏng ⇒
   * 409 kèm lỗi, KHÔNG bật công tắc; được ⇒ bật công tắc nếu tắt (putAiSettings — cùng hàm và audit 'settings.ai' như
   * PUT /settings/ai; không có cache/broadcast nào khác cần làm) rồi đẩy job (jobId cố định — bấm liên tiếp khi job còn
   * chờ ⇒ không xếp hai lần). Redis lỗi ⇒ 503 (công tắc đã bật thì giữ nguyên).
   */
  async resume(user: AuthUser): Promise<AiOutageResumeResponse> {
    const llm = this.llm;
    if (!llm) throw new ServiceUnavailableException(AI_OUTAGE_NOT_CONFIGURED_MESSAGE);
    const now = this.ctx.now();
    const [settings, waiting, waitingByModel, missed] = await Promise.all([
      getAiSettings(this.db),
      countAiOutageWaiting(this.db, now),
      countAiOutageWaitingByModel(this.db, now),
      listAiMissedReplies(this.db, this.ctx, now),
    ]);
    const missedCount = missed.items.length;
    if (settings.enabled && waiting === 0 && missedCount === 0) {
      throw new ConflictException(AI_OUTAGE_NOTHING_TO_DO_MESSAGE);
    }
    if (!settings.enabled && user.role !== 'admin') {
      throw new ForbiddenException(AI_OUTAGE_ADMIN_ONLY_MESSAGE);
    }

    const defaultModel = this.config.GEMINI_MODEL;
    // Số hội thoại (chờ vì lỗi AI + bị bỏ sót) theo model thật sự dùng.
    const convsByModel = new Map<string, number>();
    const addConvs = (model: string | null, n: number) => {
      const m = model ?? defaultModel;
      convsByModel.set(m, (convsByModel.get(m) ?? 0) + n);
    };
    for (const w of waitingByModel) addConvs(w.model, w.conversations);
    for (const m of missed.items) addConvs(m.model, 1);
    const models = [...convsByModel.keys()];
    if (models.length === 0) models.push(defaultModel);
    // Gọi thử từng model tối đa AI_MANUAL_PROBE_ATTEMPTS lần (503 quá tải thường chập chờn).
    const probes = await Promise.all(
      models.map(async (model) => ({
        model,
        probe: await probeLlm(llm, model, undefined, AI_MANUAL_PROBE_ATTEMPTS),
      })),
    );
    const okModels = probes.filter((p) => p.probe.ok).map((p) => p.model);
    const stillDown = probes.flatMap((p) =>
      p.probe.ok
        ? []
        : [
            {
              model: p.model,
              reason: describeAiProbeError(p.probe.error),
              conversations: convsByModel.get(p.model) ?? 0,
            },
          ],
    );
    if (okModels.length === 0) {
      const first = probes.find((p) => !p.probe.ok);
      this.logger.warn(
        { models, err: first && !first.probe.ok ? first.probe.error : undefined, userId: user.id },
        'Bật lại AI: gọi thử AI vẫn lỗi',
      );
      throw new ConflictException(
        `${AI_OUTAGE_STILL_DOWN_PREFIX}${stillDown[0]?.reason ?? 'lỗi không rõ'} (${models.join(', ')})`,
      );
    }
    if (stillDown.length > 0) {
      this.logger.warn({ stillDown, okModels, userId: user.id }, 'Bật lại AI: một số model vẫn lỗi');
    }

    let enabledNow = false;
    if (!settings.enabled) {
      await putAiSettings(this.db, user.id, { enabled: true });
      enabledNow = true;
    }

    try {
      await withTimeout(
        this.aiReply.add(
          AI_AUTO_RESUME_JOB_NAME,
          { manual: true, actorUserId: user.id, okModels },
          {
            jobId: AI_MANUAL_RESUME_JOB_ID,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          },
        ),
        ENQUEUE_TIMEOUT_MS,
        'Đẩy job bật lại AI',
      );
    } catch (error) {
      this.logger.warn({ err: error, userId: user.id, enabledNow }, 'Bật lại AI: không đẩy được job');
      throw new ServiceUnavailableException(AI_OUTAGE_ENQUEUE_FAILED_MESSAGE);
    }
    this.logger.log({ userId: user.id, enabledNow, waiting, missed: missedCount }, 'Bật lại AI: đã đẩy job');
    return {
      enabledNow,
      waiting,
      missed: missedCount,
      queued: true,
      ...(stillDown.length > 0 ? { stillDown } : {}),
    };
  }
}
