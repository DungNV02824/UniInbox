-- Giai đoạn 0: bật pgvector trước khi tạo bất kỳ cột vector nào (mục 5, 9).
-- gen_random_uuid() có sẵn trong Postgres >= 13 nên không cần pgcrypto.
CREATE EXTENSION IF NOT EXISTS vector;
