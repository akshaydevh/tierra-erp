-- P2: who a WhatsApp group speaks for. A party group is one customer as Tierra sees it: its PANs (characters 3-12 of
-- the bill-to GSTIN, so every branch card of the company) and/or individual SAP card codes. A value belongs to at
-- most one party group. A WhatsApp group mapped to a party group answers only about that party's documents.
CREATE TABLE "party_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"alias" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_groups_name_unique" UNIQUE("name")
);--> statement-breakpoint
CREATE TABLE "party_group_members" (
	"party_group_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "party_group_members_kind_value_pk" PRIMARY KEY("kind","value"),
	CONSTRAINT "party_group_members_kind_check" CHECK ("party_group_members"."kind" in ('pan', 'card_code'))
);--> statement-breakpoint
ALTER TABLE "party_group_members" ADD CONSTRAINT "party_group_members_party_group_id_party_groups_id_fk" FOREIGN KEY ("party_group_id") REFERENCES "public"."party_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "party_group_members_group" ON "party_group_members" USING btree ("party_group_id");--> statement-breakpoint
CREATE TABLE "wa_groups" (
	"jid" text PRIMARY KEY NOT NULL,
	"subject" text,
	"party_group_id" text,
	"send_so" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_party_group_id_party_groups_id_fk" FOREIGN KEY ("party_group_id") REFERENCES "public"."party_groups"("id") ON DELETE set null ON UPDATE no action;
