CREATE TABLE "units" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
INSERT INTO "units" ("code", "name", "description") VALUES
	('EA', 'Each', 'One sellable pack. Base quantity on Reliance purchase orders.'),
	('CRT', 'Carton', 'Reliance carton. Pieces per carton depend on the item. On PO 5115244945, 1 CRT of 100g chips was 56 each.'),
	('C01', 'Carton', 'Reliance alternate carton code. Pieces per carton depend on the item. On PO 5115244945, 1 C01 of 500g chips was 30 each.')
ON CONFLICT ("code") DO NOTHING;
