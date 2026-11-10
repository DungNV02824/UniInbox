CREATE TABLE "chatbots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"knowledge" text DEFAULT '' NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"handoff_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"handoff_message" text,
	"model" text,
	"temperature" real DEFAULT 0.4 NOT NULL,
	"reply_delay_sec" integer DEFAULT 10 NOT NULL,
	"max_wait_sec" integer DEFAULT 45 NOT NULL,
	"max_replies_per_hour" integer DEFAULT 20 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chatbots_name_length" CHECK (char_length("chatbots"."name") BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD COLUMN "default_chatbot_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "chatbot_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "chatbot_id" uuid;--> statement-breakpoint
ALTER TABLE "chatbots" ADD CONSTRAINT "chatbots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chatbots_name_unique" ON "chatbots" USING btree ("name");--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_default_chatbot_id_chatbots_id_fk" FOREIGN KEY ("default_chatbot_id") REFERENCES "public"."chatbots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_chatbot_id_chatbots_id_fk" FOREIGN KEY ("chatbot_id") REFERENCES "public"."chatbots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_chatbot_id_chatbots_id_fk" FOREIGN KEY ("chatbot_id") REFERENCES "public"."chatbots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_chatbot_id_idx" ON "conversations" USING btree ("chatbot_id");