-- Migration ngược của 0000_enable_extensions. Chạy SAU down/0001_init_schema.sql.
DROP EXTENSION IF EXISTS vector;
-- Đây là migration đầu tiên: xóa luôn bảng nhật ký của drizzle để DB trở về trạng thái trống.
DROP SCHEMA IF EXISTS drizzle CASCADE;
