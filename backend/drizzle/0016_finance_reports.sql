-- P6: the Payments page and the daily report.
-- gl_labels: the word the daily report prints for a payment to a GL account ("Gas" for the industrial gas account);
--   prefer_payee prints the payee named in the payment memo instead ("Paid to <name> for ...") when there is one.
-- bank_line_reattributions: a bank journal line shown on another day's report than its posting date (a receipt the
--   bank credited on the 15th but SAP dated the 14th). report_date is the day it counts on, for balances too.
-- daily_report_inputs: what SAP does not have, entered by the office (or QA) per day: manpower by category, the gate
--   estimate of banana / cassava received, the production / packing / cartoning flags when they override SAP's,
--   remarks per inward item, notes.
-- daily_reports: every generated report, versioned per day, with the payload it printed and its PDF.
-- app_settings: small admin settings (daily_report.outwards_basis, daily_report.cutoff).
CREATE TABLE "gl_labels" (
	"gl_code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"prefer_payee" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "bank_line_reattributions" (
	"trans_id" integer NOT NULL,
	"line_id" integer NOT NULL,
	"report_date" date NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_line_reattributions_trans_id_line_id_pk" PRIMARY KEY("trans_id","line_id")
);--> statement-breakpoint
ALTER TABLE "bank_line_reattributions" ADD CONSTRAINT "bank_line_reattributions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "daily_report_inputs" (
	"report_date" date PRIMARY KEY NOT NULL,
	"production_run" boolean,
	"packing_run" boolean,
	"cartoning_run" boolean,
	"manpower" jsonb,
	"banana_kg_estimate" numeric(12, 2),
	"cassava_kg_estimate" numeric(12, 2),
	"inward_remarks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"entered_by" text,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "daily_report_inputs" ADD CONSTRAINT "daily_report_inputs_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "daily_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"report_date" date NOT NULL,
	"version" integer NOT NULL,
	"basis" text NOT NULL,
	"data_as_of" date,
	"payload" jsonb NOT NULL,
	"document_id" text,
	"generated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_reports_basis_check" CHECK ("daily_reports"."basis" in ('created_window', 'doc_date', 'ewb_date'))
);--> statement-breakpoint
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_document_id_order_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."order_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_reports_date_version" ON "daily_reports" USING btree ("report_date","version");--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
