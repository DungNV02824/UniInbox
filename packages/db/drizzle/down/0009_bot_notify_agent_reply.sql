-- Migration ngược của 0009_bot_notify_agent_reply (mất từ khóa "báo nhân viên, bot vẫn trả lời", cách xử lý khi
-- nhân viên nhắn và cài đặt nhắc lại theo từng bot).
ALTER TABLE "chatbots" DROP CONSTRAINT IF EXISTS "chatbots_handoff_reminder_min_check";
ALTER TABLE "chatbots" DROP CONSTRAINT IF EXISTS "chatbots_agent_pause_minutes_check";
ALTER TABLE "chatbots" DROP CONSTRAINT IF EXISTS "chatbots_agent_reply_mode_check";
ALTER TABLE "chatbots" DROP COLUMN IF EXISTS "handoff_reminder_min";
ALTER TABLE "chatbots" DROP COLUMN IF EXISTS "agent_pause_minutes";
ALTER TABLE "chatbots" DROP COLUMN IF EXISTS "agent_reply_mode";
ALTER TABLE "chatbots" DROP COLUMN IF EXISTS "notify_keywords";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0009 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794416712847;
  END IF;
END $$;
