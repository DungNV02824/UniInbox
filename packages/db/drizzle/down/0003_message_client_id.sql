-- Migration ngược của 0003_message_client_id (mất cột client_id; chỉ là khóa chống gửi trùng).
DROP INDEX IF EXISTS "messages_conversation_client_id_idx";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "client_id";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0003 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1793852663238;
  END IF;
END $$;
