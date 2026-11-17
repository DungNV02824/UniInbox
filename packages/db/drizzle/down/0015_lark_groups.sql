-- Migration ngược của 0015_lark_groups (mất các nhóm Lark theo chatbot; nhóm chung app_settings.lark giữ nguyên).
DROP TABLE IF EXISTS "lark_group_chatbots";
DROP TABLE IF EXISTS "lark_groups";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0015 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794886143642;
  END IF;
END $$;
