CREATE TABLE "project_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"chatbot_id" uuid,
	"ai_run_id" uuid,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message_ids" uuid[] DEFAULT '{}' NOT NULL,
	"anchor_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_logs" ADD CONSTRAINT "project_logs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_logs" ADD CONSTRAINT "project_logs_chatbot_id_chatbots_id_fk" FOREIGN KEY ("chatbot_id") REFERENCES "public"."chatbots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_logs" ADD CONSTRAINT "project_logs_ai_run_id_ai_runs_id_fk" FOREIGN KEY ("ai_run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_logs_conversation_created_idx" ON "project_logs" USING btree ("conversation_id","created_at");