-- Migration ngược của 0001_init_schema. CẢNH BÁO: xóa toàn bộ dữ liệu nghiệp vụ.
-- Chỉ dùng cho dev/test hoặc khi rollback ngay sau deploy lỗi (quy tắc 7: không xóa dữ liệu hội thoại khi migrate).
DROP TABLE IF EXISTS "audit_logs" CASCADE;
DROP TABLE IF EXISTS "catalog_items" CASCADE;
DROP TABLE IF EXISTS "style_examples" CASCADE;
DROP TABLE IF EXISTS "knowledge_chunks" CASCADE;
DROP TABLE IF EXISTS "knowledge_documents" CASCADE;
DROP TABLE IF EXISTS "customer_memories" CASCADE;
DROP TABLE IF EXISTS "handoffs" CASCADE;
DROP TABLE IF EXISTS "messages" CASCADE;
DROP TABLE IF EXISTS "ai_suggestions" CASCADE;
DROP TABLE IF EXISTS "ai_runs" CASCADE;
DROP TABLE IF EXISTS "conversations" CASCADE;
DROP TABLE IF EXISTS "contact_identities" CASCADE;
DROP TABLE IF EXISTS "contacts" CASCADE;
DROP TABLE IF EXISTS "channel_accounts" CASCADE;
DROP TABLE IF EXISTS "users" CASCADE;
DROP TYPE IF EXISTS "public"."window_source";
DROP TYPE IF EXISTS "public"."user_role";
DROP TYPE IF EXISTS "public"."sender_type";
DROP TYPE IF EXISTS "public"."message_status";
DROP TYPE IF EXISTS "public"."knowledge_source_type";
DROP TYPE IF EXISTS "public"."handoff_reason_code";
DROP TYPE IF EXISTS "public"."conversation_status";
DROP TYPE IF EXISTS "public"."channel_type";
DROP TYPE IF EXISTS "public"."channel_account_status";
DROP TYPE IF EXISTS "public"."ai_suggestion_status";
DROP TYPE IF EXISTS "public"."ai_run_decision";
DROP TYPE IF EXISTS "public"."ai_mode";
-- Gỡ dòng nhật ký để `db:migrate` chạy lại 0001 (created_at = "when" trong meta/_journal.json).
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1793783923866;
  END IF;
END $$;
