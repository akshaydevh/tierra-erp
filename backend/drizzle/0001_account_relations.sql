CREATE TABLE "account_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"phone_number" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_relations_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "account_relations_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
ALTER TABLE "account_relations" ADD CONSTRAINT "account_relations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;