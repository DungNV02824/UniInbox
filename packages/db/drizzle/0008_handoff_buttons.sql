ALTER TABLE "chatbots" ADD COLUMN "handoff_ack_label" text;--> statement-breakpoint
ALTER TABLE "chatbots" ADD COLUMN "handoff_resolve_label" text;--> statement-breakpoint
ALTER TABLE "chatbots" ADD COLUMN "handoff_action_lark" boolean DEFAULT false NOT NULL;