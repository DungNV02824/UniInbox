-- Migration ngược của 0013_project_logs (mất toàn bộ Nhật ký công trình).
DROP TABLE IF EXISTS "project_logs";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0013 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794675084786;
  END IF;
END $$;
