ALTER TABLE "users" DROP CONSTRAINT "users_role_check";--> statement-breakpoint
UPDATE "users" SET "role" = 'manager' WHERE "id" = 'usr_joshy' AND "role" = 'admin';--> statement-breakpoint
UPDATE "users" SET "role" = 'manager'
WHERE "role" = 'admin'
  AND "id" <> (
    SELECT "id" FROM "users" WHERE "role" = 'admin'
    ORDER BY ("id" = 'usr_alex') DESC, "created_at" ASC
    LIMIT 1
  );--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in ('admin', 'manager', 'office'));--> statement-breakpoint
CREATE UNIQUE INDEX "users_single_admin" ON "users" USING btree ("role") WHERE "users"."role" = 'admin';--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_status_check";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" in ('todo', 'doing', 'done', 'cancelled'));--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "kind" text DEFAULT 'todo' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assignee_role" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "wa_message_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "created_via" text DEFAULT 'dashboard' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_check" CHECK ("tasks"."kind" in ('todo', 'procurement', 'approval', 'data_entry', 'customer_followup', 'review'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_role_check" CHECK ("tasks"."assignee_role" is null or "tasks"."assignee_role" in ('admin', 'manager', 'office'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_via_check" CHECK ("tasks"."created_via" in ('dashboard', 'whatsapp', 'desk', 'system'));--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_subject_kind" ON "tasks" USING btree ("subject_type", "subject_id", "kind") WHERE "tasks"."subject_type" is not null and "tasks"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "tasks_wa_message" ON "tasks" USING btree ("wa_message_id");--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD COLUMN "sender_jid" text;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD COLUMN "quoted_id" text;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD COLUMN "kind" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD COLUMN "subject_id" text;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_idempotency_key_unique" UNIQUE("idempotency_key");--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_kind_check" CHECK ("whatsapp_messages"."kind" in ('text', 'document', 'image', 'reaction', 'other'));--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_status_check" CHECK ("whatsapp_messages"."status" is null or "whatsapp_messages"."status" in ('received', 'sending', 'sent', 'uncertain', 'failed'));--> statement-breakpoint
CREATE INDEX "whatsapp_messages_subject" ON "whatsapp_messages" USING btree ("subject_type", "subject_id");--> statement-breakpoint
CREATE TABLE "wa_identities" (
	"lid" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"idempotency_key" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('queued', 'running', 'done', 'failed', 'cancelled'))
);--> statement-breakpoint
CREATE INDEX "jobs_ready" ON "jobs" USING btree ("status", "run_after");--> statement-breakpoint
CREATE TABLE "chat_context" (
	"chat_jid" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
