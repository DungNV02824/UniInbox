-- Migration ngược của 0004_chatbots (MẤT dữ liệu chatbot, app_settings và việc gắn bot vào hội thoại/kênh/ai_runs).
ALTER TABLE "ai_runs" DROP CONSTRAINT IF EXISTS "ai_runs_chatbot_id_chatbots_id_fk";
ALTER TABLE "ai_runs" DROP COLUMN IF EXISTS "chatbot_id";
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_chatbot_id_chatbots_id_fk";
DROP INDEX IF EXISTS "conversations_chatbot_id_idx";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "chatbot_id";
ALTER TABLE "channel_accounts" DROP CONSTRAINT IF EXISTS "channel_accounts_default_chatbot_id_chatbots_id_fk";
ALTER TABLE "channel_accounts" DROP COLUMN IF EXISTS "default_chatbot_id";
DROP TABLE IF EXISTS "app_settings";
DROP TABLE IF EXISTS "chatbots";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0004 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794193981395;
  END IF;
END $$;
