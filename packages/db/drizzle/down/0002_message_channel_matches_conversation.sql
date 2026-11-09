-- Migration ngược của 0002_message_channel_matches_conversation (không mất dữ liệu).
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_conversation_channel_account_fk";
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_id_channel_account_unique";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0002 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1793787345202;
  END IF;
END $$;
