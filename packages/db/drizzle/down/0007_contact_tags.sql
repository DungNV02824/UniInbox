-- Migration ngược của 0007_contact_tags (mất danh sách nhãn và màu; nhãn trên contacts.tags vẫn giữ nguyên).
DROP TABLE IF EXISTS "contact_tags";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0007 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794238364602;
  END IF;
END $$;
