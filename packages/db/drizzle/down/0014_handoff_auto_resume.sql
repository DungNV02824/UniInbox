-- Migration ngược của 0014_handoff_auto_resume (mất cờ "tự trả lại cho bot khi AI hồi phục").
ALTER TABLE "handoffs" DROP COLUMN IF EXISTS "auto_resume";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0014 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794725463386;
  END IF;
END $$;
