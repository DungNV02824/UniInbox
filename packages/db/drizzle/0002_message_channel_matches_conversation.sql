ALTER TABLE "conversations" ADD CONSTRAINT "conversations_id_channel_account_unique" UNIQUE("id","channel_account_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_channel_account_fk" FOREIGN KEY ("conversation_id","channel_account_id") REFERENCES "public"."conversations"("id","channel_account_id") ON DELETE cascade ON UPDATE no action;
