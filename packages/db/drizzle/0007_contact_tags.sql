CREATE TABLE "contact_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'blue' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_tags_color_check" CHECK ("contact_tags"."color" IN ('gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'))
);
--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_tags_name_lower_unique" ON "contact_tags" USING btree (lower("name"));--> statement-breakpoint
-- Seed: mỗi nhãn khác nhau đang có trên khách (không phân biệt hoa thường, giữ cách viết gặp đầu tiên theo
-- khách tạo sớm nhất rồi vị trí trong mảng), màu 'blue', sort_order theo tên.
INSERT INTO "contact_tags" ("name", "sort_order")
SELECT d."name", (row_number() OVER (ORDER BY lower(d."name"), d."name") - 1)::int
FROM (
  SELECT DISTINCT ON (lower(btrim(t."tag"))) btrim(t."tag") AS "name"
  FROM "contacts" c
  CROSS JOIN LATERAL unnest(c."tags") WITH ORDINALITY AS t("tag", "pos")
  WHERE btrim(t."tag") <> ''
  ORDER BY lower(btrim(t."tag")), c."created_at", c."id", t."pos"
) d;
