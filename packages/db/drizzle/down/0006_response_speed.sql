-- Migration ngược của 0006_response_speed (mất cài đặt "Tốc độ trả lời" của từng bot).
ALTER TABLE "chatbots" DROP CONSTRAINT IF EXISTS "chatbots_response_speed_check";
ALTER TABLE "chatbots" DROP COLUMN IF EXISTS "response_speed";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0006 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794212092807;
  END IF;
END $$;
