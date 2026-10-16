-- Masters: job roles (Production head, Accountant, QC and stores, ...) that the admin adds from the Masters page.
-- Each carries the access level (manager or office) its holders get; admin stays a single account set from Settings.
-- users.job_role_id: the person's job role, if any. Deleting a role leaves its holders without one.
CREATE TABLE "job_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"access_role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_roles_access_role_check" CHECK ("job_roles"."access_role" in ('manager', 'office'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "job_roles_name_unique" ON "job_roles" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "job_role_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_job_role_id_job_roles_id_fk" FOREIGN KEY ("job_role_id") REFERENCES "public"."job_roles"("id") ON DELETE set null ON UPDATE no action;
