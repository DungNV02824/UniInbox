-- Migration ngược của 0012_contact_capture (mất cấu hình "Thu thập thông tin" của bot và các trường khách bot đã điền).
ALTER TABLE "contacts" DROP COLUMN IF EXISTS "profile_fields";
ALTER TABLE "contacts" DROP COLUMN IF EXISTS "phone_source";
ALTER TABLE "chatbots" DROP COLUMN IF EXISTS "capture";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0012 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794649105290;
  END IF;
END $$;
