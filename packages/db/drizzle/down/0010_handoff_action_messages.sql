-- Migration ngược của 0010_handoff_action_messages (mất tin gửi khách khi bấm hai nút banner Cần người).
ALTER TABLE "chatbots" DROP COLUMN IF EXISTS "handoff_resolve_message";
ALTER TABLE "chatbots" DROP COLUMN IF EXISTS "handoff_ack_message";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0010 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794417226600;
  END IF;
END $$;
