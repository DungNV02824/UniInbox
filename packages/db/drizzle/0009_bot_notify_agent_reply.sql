ALTER TABLE "chatbots" ADD COLUMN "notify_keywords" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "chatbots" ADD COLUMN "agent_reply_mode" text DEFAULT 'pause' NOT NULL;--> statement-breakpoint
ALTER TABLE "chatbots" ADD COLUMN "agent_pause_minutes" integer;--> statement-breakpoint
ALTER TABLE "chatbots" ADD COLUMN "handoff_reminder_min" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chatbots" ADD CONSTRAINT "chatbots_agent_reply_mode_check" CHECK ("chatbots"."agent_reply_mode" IN ('continue', 'pause', 'stop'));--> statement-breakpoint
ALTER TABLE "chatbots" ADD CONSTRAINT "chatbots_agent_pause_minutes_check" CHECK ("chatbots"."agent_pause_minutes" IS NULL OR "chatbots"."agent_pause_minutes" BETWEEN 1 AND 1440);--> statement-breakpoint
ALTER TABLE "chatbots" ADD CONSTRAINT "chatbots_handoff_reminder_min_check" CHECK ("chatbots"."handoff_reminder_min" BETWEEN 0 AND 1440);