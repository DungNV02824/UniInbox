-- Migration ngược của 0008_handoff_buttons (mất tên nút tùy chỉnh và lựa chọn báo Lark khi bấm nút).
ALTER TABLE "chatbots" DROP COLUMN IF EXISTS "handoff_action_lark";
ALTER TABLE "chatbots" DROP COLUMN IF EXISTS "handoff_resolve_label";
ALTER TABLE "chatbots" DROP COLUMN IF EXISTS "handoff_ack_label";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0008 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794296454237;
  END IF;
END $$;
