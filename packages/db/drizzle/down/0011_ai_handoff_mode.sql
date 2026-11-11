-- Migration ngược của 0011_ai_handoff_mode (mất lựa chọn "Khi AI tự chuyển người thật" của từng bot).
ALTER TABLE "chatbots" DROP CONSTRAINT IF EXISTS "chatbots_ai_handoff_mode_check";
ALTER TABLE "chatbots" DROP COLUMN IF EXISTS "ai_handoff_mode";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0011 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794422800294;
  END IF;
END $$;
