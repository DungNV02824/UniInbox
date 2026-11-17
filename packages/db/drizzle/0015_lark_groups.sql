CREATE TABLE "lark_group_chatbots" (
	"lark_group_id" uuid NOT NULL,
	"chatbot_id" uuid NOT NULL,
	CONSTRAINT "lark_group_chatbots_lark_group_id_chatbot_id_pk" PRIMARY KEY("lark_group_id","chatbot_id")
);
--> statement-breakpoint
CREATE TABLE "lark_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"webhook_url" text NOT NULL,
	"secret_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lark_group_chatbots" ADD CONSTRAINT "lark_group_chatbots_lark_group_id_lark_groups_id_fk" FOREIGN KEY ("lark_group_id") REFERENCES "public"."lark_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lark_group_chatbots" ADD CONSTRAINT "lark_group_chatbots_chatbot_id_chatbots_id_fk" FOREIGN KEY ("chatbot_id") REFERENCES "public"."chatbots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lark_group_chatbots_chatbot_idx" ON "lark_group_chatbots" USING btree ("chatbot_id");