ALTER TABLE "handoffs" ADD COLUMN "auto_resume" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Hội thoại đang kẹt "Cần người" vì lỗi phía AI từ trước (vd. 11/11 Gemini HTTP 402 hết tiền nạp trước, 12/11 hết thời
-- gian chờ): đánh dấu tự trả lại cho bot. Chỉ handoff ĐANG MỞ do AI tạo, tóm tắt là lỗi gọi AI DẠNG "AI ngừng hoạt
-- động" (như isLlmOutageErrorText: hết thời gian chờ, HTTP 401/402/408/429/5xx, 400/403 nói về tài khoản/khóa API,
-- lỗi mạng) và KHÔNG có yêu cầu thật nối thêm ("\n+ …" — bot 'continue' báo thêm, cần người). 400 khác, 404, nội dung
-- bị chặn, lỗi không xác định ⇒ giữ nguyên (nhân viên xử lý).
UPDATE "handoffs" SET "auto_resume" = true
  WHERE "resolved_at" IS NULL AND "created_by" = 'ai'
    AND strpos("summary", E'\n+ ') = 0
    AND (
      "summary" LIKE 'Lỗi gọi AI: Hết thời gian chờ AI%'
      OR "summary" ~ '^Lỗi gọi AI: Gemini HTTP (401|402|408|429|5[0-9][0-9]):'
      OR "summary" ~* '^Lỗi gọi AI: Gemini HTTP 403: .*(billing|prepay|credit|quota|payment|api[ _-]?key|permission|unauthori[sz]ed|unauthenticated|suspended|denied)'
      OR "summary" ~* '^Lỗi gọi AI: Gemini HTTP 400: .*(api[ _-]?key|billing|prepay|credit|quota)'
      OR "summary" ~* '^Lỗi gọi AI: Lỗi gọi Gemini: .*(fetch failed|network|socket|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|aborted)'
    );
