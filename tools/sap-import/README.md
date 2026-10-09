# SAP importer

Loads a SAP Business One backup (parquet export) into Postgres, and SAP's attachment files into a file store:

- `sap`: typed, column-curated copies of about 60 SAP tables (`sap.ordr`, `sap.rdr1`, `sap.ccs_eoinv` for
  `@CCS_EOINV`, ...). Column names are the SAP names lower-cased. `sap._import` records the backup name,
  import time, `data_as_of` (latest CreateDate on SO/invoice/GRN/production order) and per-table row counts.
- `erp`: views over `sap` only (`sql/erp/NN_*.sql`, applied in order). The backend reads nothing else. They
  are dropped and recreated on every import.

- `hr`: payroll and attendance from the HR spreadsheets (Voyon exports, the salary register, the temporary workers'
  sheet, the peeling register), written by `run.py hr`. SAP has none of it. Its own schema, replaced whole on each run.

- `att`: SAP attachment files (invoice prints, e-way bills, e-invoice QR images, vendor bills ...) and the documents
  they belong to, written by `run.py attachments`. Its own schema: the `sap` swap never touches it. The file bytes
  live in a file store (a local folder or an S3-compatible bucket), not in Postgres.

SAP data never goes in git: the backup lives outside the repo, and nothing here writes data files.

## Run locally

```sh
cd tools/sap-import
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# load a backup folder into the docker-compose Postgres
.venv/bin/python -I run.py sap --backup ~/tierra-data/sap_backup_<date> \
    --pg postgres://tierra:tierra@localhost:5432/tierra

.venv/bin/python -I run.py verify --pg postgres://tierra:tierra@localhost:5432/tierra

# regenerate the schema used by the backend tests (no data)
.venv/bin/python -I run.py ddl --out ../../backend/test/sap-schema.sql

# rebuild only the erp views over the sap already loaded (after editing sql/erp; one transaction)
.venv/bin/python -I run.py erp --pg postgres://tierra:tierra@localhost:5432/tierra
```

`--backup` defaults to `SAP_BACKUP`, else the newest `~/tierra-data/sap_backup_*`; `--pg` to `SAP_PG`, else the
local URL above; `--gates` (on `sap` and `verify`) to `SAP_GATES`, else `~/tierra-data/gates.local.yaml`. Run Python with `-I`: the
backup is untrusted input and is only ever read through duckdb.

What `sap` does:

1. Reads `tables.yaml` and the backup's `metadata/table_columns.csv.gz` (real HANA types). The parquet stores
   decimals and dates as text, so every non-text column is checked first; a non-empty value that does not
   cast fails the run and names the table, column and value. INTEGER/SMALLINT become integer/smallint,
   DECIMAL numeric(19,6), TIMESTAMP date (SAP stores midnight; a time of day fails the run unless the
   column is declared `timestamp` under `types:`), text stays text, `''` becomes NULL for non-text.
2. Loads every table into a fresh schema `sap_next` (COPY), adds primary keys and indexes, writes
   `sap_next._import`.
3. Runs the hard gates against `sap_next`. Any failure stops here: `sap` and `erp` are untouched and
   `sap_next` is kept for inspection. `--no-swap` also stops here, on purpose.
4. In one transaction: drop `erp` and `sap`, rename `sap_next` to `sap`, create `erp` from `sql/erp/*.sql`.
   An error in a view file rolls the whole swap back.
5. Prints the soft gates (warnings) and the schema sizes.

Re-running is safe: every run rebuilds both schemas from the backup.

### Gates

Structural gates (hard, always run, hold for any backup): row counts equal the parquet counts; OIVL movements
sum to OITW on-hand for every non-zero item/warehouse pair; OBTQ batch quantities equal OITW for batch items;
JDT1 debits equal credits; OCRD.Balance equals the JDT1 sum per business partner (cards rolled into a payment
consolidation parent must net to zero against it).

Data gates compare against expected figures of one particular backup: bank GL closings on a date, a traced
SO -> invoice -> e-way bill chain, issued vs received value of one production order, the expected placeholder-BOM
range, and (in `verify`) spot checks of erp view values. Those figures are real business data, so they are
**not in the repo**: they live in a local YAML file, `~/tierra-data/gates.local.yaml` by default (`--gates PATH`).
`gates.example.yaml` shows the keys with made-up values. Without the file the data gates print `skip` and do
not fail; a section left out of the file is skipped the same way.

Soft gates (warn only): laminates without a unit, business partners without a GSTIN.

`verify` re-runs all of these on `sap`, checks that every `erp` contract view exists with its columns and has
rows, and times the list-page queries (each must answer in under 300 ms).

## Attachments

```sh
# after `run.py sap`: link the extracted attachments folder(s) to documents and copy the linked files
.venv/bin/python -I run.py attachments --dir ~/tierra-data/sap_attachments_<date> \
    --pg postgres://tierra:tierra@localhost:5432/tierra --store fs:../../backend/data/files
```

- `--dir` is an extracted attachments folder (repeat it for several archives; a name found in two is taken from
  `Ewaybill/` first). Its files are untrusted: they are hashed, read with `pdftotext` (poppler-utils, a separate
  process with a 30 s timeout) and copied, nothing else.
- `--store fs:<dir>` copies into a local folder (the backend's `FILE_STORE=fs:./data/files`, git-ignored);
  `--store s3` uploads to an S3-compatible bucket from `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY` (path-style; needs `boto3`, in requirements.txt). Default: `FILE_STORE`, else the backend's

For a Railway bucket also set `S3_URL_STYLE=virtual-host` (Railway buckets use virtual-host style URLs; `railway bucket credentials --bucket <name>` shows the endpoint, bucket name and keys). The backend reads the same variable.
  `data/files`.
- `--dry-run` links and prints the coverage report only.

Only files that belong to an imported, posted document are kept ("only required"); the rest are counted in the
report as skipped, with the reason. A file belongs to a document in one of three ways:

1. **ATC1**: the document's `AtcEntry` (OINV, ORIN, ORDR, OPCH, ORPC, OPDN, OPOR, ORCT, OVPM, OJDT, OCRD) points at ATC1
   rows whose `FileName.FileExt` is matched on the lower-cased base name (`trgtPath` is ignored). Drafts (ODRF,
   OPDF) and the archive tables are skipped. Role `ewaybill` for a 12-digit PDF on an invoice, else `supporting`.
2. **The e-invoice add-on**: `@CCS_EOINV.U_QRPATH` (successful rows) gives the invoice's or credit note's QR png
   (`einvoice_qr`), `@CCS_EOEWB.U_EWBNO` + `.pdf` the invoice's e-way bill (`ewaybill`).
3. **SAP print exports** (`AR Invoice[ [Approved]| - Cancellation]_YYYYMMDD_HHMMSS.pdf`, Credit Note, Debit Note,
   AP Invoice, Purchase Order, Sales Order, `Incoming Payments_<DocNum>_...`): the number printed inside (or the
   DocNum in the name) must name exactly one document (the printed date breaks ties) and the printed net value (a
   receipt's amount) must equal its DocTotal. Roles `invoice_pdf`, `credit_note_pdf`, `po_pdf`, `receipt_pdf` ...

Each run: hash every file; link; upload the linked ones under content-addressed keys `sap/ab/cd/<sha256>.<ext>`
(resumable: a key already in the store with the same size is skipped); then, in one transaction, replace the rows of
`att.files` (one per distinct file: key, name, MIME type, size, kind, a 2 KB pdftotext excerpt, print time) and
`att.links` (file, SAP object type, DocEntry, printed number, card, date, role, method, confidence). The backend
reads them through `erp.document_files`. `att` and its tables are created (empty) by the erp step too
(`sql/att.sql`), so the views compile before the first attachments run.

The report lists files hashed, files linked by object / role / method, files skipped and why, and what was uploaded.

## HR files (payroll, attendance, leave, peeling)

```sh
.venv/bin/python -I run.py hr --dir "../../Reference/source-docs/hr" \
    --pg postgres://tierra:tierra@localhost:5432/tierra [--joins ~/tierra-data/hr-joins.yaml] [--dry-run]
```

Reads every `.xlsx` / `.xlsm` in `--dir` (git-ignored reference data; never commit them) and recognises each by its
sheets and headers, not by its name: the Voyon punch report (employee master: TF codes, department, designation,
reporting officer), the Voyon payroll export (needs `YYYY-MM` in the file name, or `--month`), the Voyon leave report,
the salary register (`Salary-*` sheets: one category each; the `ATTN` sheet: a code per person per day), the temporary
workers' wages sheet (factory and sales-promotion blocks; month from the file name) and the peeling register (kg per
worker per day, the incentive sheet and its summary). Anything else (the labour-cost matrix) is listed as skipped.
openpyxl opens them read-only for their cached values; macros and formulas never run.

Schema `hr` (`sql/hr.sql`): `employees` (one row per person: Voyon code and register code joined, department,
category), `temp_workers`, `attendance_days`, `leave_requests`, `payroll_runs` / `payroll_lines` (one run per source and
month: `voyon`, `register`, `temp_sheet`; Voyon and the register are the same permanent staff, never add them),
`peeling_output`, `_import`.

The same person has a Voyon code (TF…) and a register code (T… / TFL…). Names join most of them (exact, then spelling
drift: initials, h, y/i, words run together); the rest come from a local file, `~/tierra-data/hr-joins.yaml`
(`--joins`, never in the repo):

```yaml
joins:
  - {register: T999, voyon: TF999}   # made-up codes: the real pairs stay in ~/tierra-data
```

Gates (hard; a failure keeps `hr` as it was and leaves `hr_next` to inspect): every numeric column of the Voyon payroll
adds up to the file's totals row; each salary-register sheet's nets add up to its totals row (a row with a broken
`#REF!` code may not carry pay); the attendance grid's codes per person equal the sheet's own count columns; the
temporary sheet's columns equal its totals; the peeling incentive per class equals the summary sheet; every payroll line
names one person. Data checks with the real figures (headcount, June totals, code counts) go in the local gates file
under `hr_checks` (`{s}` is the schema being checked); without it they print `skip`. `verify` checks the `hr` tables
when the schema exists.

The backend reads `hr` for `/payroll` and the agent's payroll tools, admin only; the schema is optional (the page
says "HR data not imported yet" without it).

## Changing what is loaded

- New column: add it to the table's list in `tables.yaml` (or to a shared `column_sets` list), re-run
  `sap`, then `ddl` so the backend tests see it.
- New view: add `sql/erp/NN_name.sql`; views may read `sap.*` and earlier `erp.*` objects only. `run.py erp` applies
  it to an existing import without reloading the backup; add its columns to `ERP_CONTRACT` in `run.py` (and a speed
  probe to `LIST_QUERIES` if a page lists it).

### Finance views (P6, `sql/erp/12_finance.sql`)

- `bank_accounts`: the GL accounts SAP flags as cash accounts (`OACT.Finanse`), bank or cash by the account or its
  parent heading, a short name (first word of a bank's name), the house bank (`DSC1`) highlighted on the daily report.
  Nothing is hard-coded: another backup with other banks works the same.
- `bank_lines`: every journal line on those accounts with its contra (another bank = transfer, a card, a GL account),
  the payment that posted it and its memo. Balances are sums of these by posting date (`RefDate`).
- `payments` (ORCT + OVPM with RCT2/RCT4, VPM2/VPM4), `payment_requests` (OWDD object 46 -> OPDF drafts),
  `bp_balances` (journal balance per card, PAN group), `ar_ap_ageing` (materialized: PAN-level FIFO as of the data
  date, buckets not_due / 1_30 / 31_60 / 61_90 / 91_180 / over_180), `invoices_outwards`, `production_movements`
  (OIGE/OIGN lines), `journal_entries` / `journal_lines`.
- The daily report's labels and corrections are app tables (backend migration 0016), not SAP: `gl_labels` (the word
  printed for a payment to a GL account), `bank_line_reattributions` (a line counted on another day), `party_aliases`,
  `app_settings` (`daily_report.outwards_basis`, `daily_report.cutoff`, `daily_report.known_differences`). Their real
  rows live in a local seed (`~/tierra-data/seed-p6.sql`), never in the repo; restore them on the remote with
  `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f seed-p6.sql` after the backend has migrated.

### Costing views (P7, `sql/erp/13_costing.sql`)

SAP holds material cost only (no resource lines on production orders; labour, power and water are issued at ₹0), so
these are material costs: `production_costs` (per production order: issued, returned, received, cost per piece / kg, by
material role), `fg_cost_monthly` (finished goods made per month and SKU at SAP's receipt value), `sku_margin_monthly`
(finished-goods invoice lines vs INV1.StockPrice COGS per SKU, card and month), `material_mix_monthly`, `stock_valuation`
(what is left of the valuation layers per item and warehouse), `cost_gl_accounts` / `cost_gl_monthly` (WIP variance,
inventories and salary accounts found by name) and `wip_variance_monthly`. Finished goods are `erp.items.material_role =
'fg'` (FG… codes), never OITB.U_Type.

## Loading the remote (Railway) database

The remote is never loaded from parquet. Import locally, then ship the four schemas:

```sh
# locally, after a clean `run.py sap` + `run.py attachments` + `run.py hr` + `run.py verify`
pg_dump -Fc -n sap -n erp -n att -n hr -d postgres://tierra:tierra@localhost:5432/tierra -f sap-erp.dump
```

The remote volume is small, so do not restore over the old copy in one transaction (old and new would sit on
disk together). Two steps instead:

1. Check free space. The restore peaks at about twice the `sap` + `erp` size that `verify` prints (the tables
   and indexes plus the WAL written for them; roughly 250 MB for a 115 MB import) on top of what the database
   already uses: `select pg_size_pretty(pg_database_size(current_database()))` against the volume size in
   Railway. Not enough room: stop here.
2. Drop the old copy in its own transaction, then restore. Between the two the app answers "SAP data not
   imported yet" (503 on the SAP pages); tasks, WhatsApp and sign-in keep working.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -c 'DROP SCHEMA IF EXISTS erp CASCADE' -c 'DROP SCHEMA IF EXISTS sap CASCADE' \
    -c 'DROP SCHEMA IF EXISTS att CASCADE' -c 'DROP SCHEMA IF EXISTS hr CASCADE'
pg_restore --single-transaction --no-owner --no-privileges -d "$DATABASE_URL" sap-erp.dump
```

### Attachment files for the remote

The dump carries `att` (which file belongs to which document) but not the bytes. Upload those to the bucket the
backend reads (`FILE_STORE=s3` plus the `S3_*` variables on the backend service) with the same command, pointed at
the bucket. `--pg` may be the local database (only `sap`/`erp` are read, and `att` is rewritten with the same rows)
or the remote one:

```sh
export S3_ENDPOINT=https://<bucket endpoint> S3_BUCKET=<bucket> S3_REGION=auto \
       S3_ACCESS_KEY_ID=<key id> S3_SECRET_ACCESS_KEY=<secret>
.venv/bin/python -I run.py attachments --dir ~/tierra-data/sap_attachments_<date> \
    --pg postgres://tierra:tierra@localhost:5432/tierra --store s3
```

Re-running is safe and cheap: keys already in the bucket are skipped. Upload before (or together with) the restore,
so no link points at a file the bucket does not have yet; the backend answers "missing from storage" until then.

`hr` can also be loaded straight into the remote (`run.py hr --pg "$DATABASE_URL"`; it builds `hr_next` there, gates it
and swaps it in), or restored alone from a dump of `-n hr`. It is small (well under 1 MB) and holds personal pay data:
keep the dump file off shared drives and delete it after the restore.

`*.dump` is git-ignored. The app's own tables live in `public` and are not touched. The `erp` helper
functions use SQL-standard bodies, so the remote needs Postgres 14 or later.
