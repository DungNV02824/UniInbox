ALTER TABLE "chatbots" ADD COLUMN "capture" jsonb;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "phone_source" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "profile_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;