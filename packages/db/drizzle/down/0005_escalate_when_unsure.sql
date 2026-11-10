-- Migration ngược của 0005_escalate_when_unsure (mất cài đặt "Khi bot không chắc chắn" của từng bot).
ALTER TABLE "chatbots" DROP COLUMN IF EXISTS "escalate_when_unsure";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0005 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794208040708;
  END IF;
END $$;
