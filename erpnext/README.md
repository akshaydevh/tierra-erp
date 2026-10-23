# Tierra on ERPNext (hackathon build, branch `hackathon/erpnext`)

The Tierra UI and agent run on top of ERPNext instead of SAP Business One. ERPNext is headless: users never see
its Desk. The SAP backup of 2026-10-07 is imported into ERPNext for the demo. Production is unchanged (SAP stays the
ERP there); never deploy this branch to the Railway project.

```
Tierra UI (Next.js :3000) ──► Tierra backend (:3002) ──► reads:  Postgres tierra_hack
WhatsApp (Evolution) ──────┘        │                         erp.* views → sap.* compat views → erpnext.* mirror
                                    │                         (mirror copied from ERPNext's MariaDB, read-only user)
                                    └──────────────────────► writes: ERPNext REST API (service user)
ERPNext v16 (:8080, MariaDB :3307) — both bound to 127.0.0.1
```

- **Reads.** `backend/src/erp/erpnext/mirror.ts` copies ~30 ERPNext tables into Postgres schema `erpnext` at boot
  and whenever ERPNext changes (checked every `ERP_SYNC_MS`, default 60 s). `compat.ts` presents them as the SAP
  tables (`sap.ordr`, `sap.oinv`, `sap.jdt1`, ...) with SAP's exact columns, so the existing `erp` views
  (`tools/sap-import/sql/erp`), queries, agent tools, reports and tests run unchanged. SAP tables ERPNext does not
  model here (production orders, batches, e-invoices, SAP approvals) are empty views.
- **Writes.** Only through the REST API. When the admin approves a TSO, `workflows/erpnext-post.ts` posts and
  submits the Sales Order in ERPNext (`custom_tierra_ref` = TSO id, so a retry never posts twice), syncs the mirror,
  and the usual link step marks the TSO `in_sap`.
- **Keys.** Imported records keep SAP's codes (`custom_sap_ref`: item codes, card codes, `ORDR:5521`); a document
  from SAP keeps its DocEntry and number, a new one gets an id from 10,000,000 and its ERPNext number.

## Run it

```bash
# 1. ERPNext (first start creates the site erp.localhost; takes a few minutes)
docker compose -f erpnext/compose.yml up -d

# 2. Company, fiscal years, settings, custom fields, service user, read-only MariaDB user.
#    Writes the keys to ~/tierra-data/erpnext.local.env (never commit it).
cd tools/erpnext-import && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -I run.py setup

# 3. SAP -> ERPNext. Reads the typed sap schema tools/sap-import already loaded (SAP_PG, default the local
#    tierra database). Re-runnable: records ERPNext has are skipped. Errors go to var/erpnext-import/.
.venv/bin/python -I run.py import
.venv/bin/python -I run.py verify

# 4. App database: a copy of the dev database's app tables, kept apart from it
docker compose exec -T postgres psql -U tierra -d postgres -c "create database tierra_hack"
docker compose exec -T postgres sh -c "pg_dump -U tierra -d tierra -n public -n hr -n att -n drizzle --no-owner | psql -q -U tierra -d tierra_hack"

# 5. Backend and frontend on it (also in .claude/launch.json)
erpnext/dev-backend.sh
erpnext/dev-frontend.sh
```

`dev-frontend.sh` sets `API_URL=http://localhost:3002`: `frontend/.env` may point at another backend.

## What the import brings over

| SAP | ERPNext | Notes |
|---|---|---|
| OITB, OITM (+OCHP HSN), units | Item Group, Item, UOM | SAP UDFs (pieces per carton, category, GST rate) as custom fields |
| OWHS | Warehouse | `custom_sap_ref` = WhsCode |
| OCRG, OCRD, CRD1 | Customer/Supplier Group, Customer, Supplier, Address | GSTIN on the address (`custom_gstin`) |
| OITT, ITT1 | BOM | submitted, default |
| JDT1 before 2026-07-08 | opening Sales/Purchase Invoices, opening Journal Entries | each card's balance as its newest documents (like `erp.ar_ap_ageing`); bank and cash balances |
| ORDR, OPOR (window) | Sales Order, Purchase Order | GST as one Actual row (SAP VatSum), a Round Off row so totals equal DocTotal |
| OPDN, OINV (window) | Purchase Receipt, Sales Invoice (update stock) | posted one by one in SAP posting order, linked to their orders |
| OPCH (window) | Purchase Invoice | service invoices on a SAP-SERVICE item and the SAP GL account |
| ORCT, OVPM (window) | Payment Entry (on account), Journal Entry for account payments | SAP books receipts on account too |
| OITW on 2026-10-07 | one Stock Reconciliation | stock equals SAP on the cut-over date |
| OBTN, OBTQ, OITL/ITL1 (all) | SAP Batch (custom DocType) with SAP Batch Movement rows | step `batches`, from `erp.batches` / `erp.batch_movements` (`tools/sap-import/sql/erp/14_batches.sql`); stock by warehouse as of the cut-over. Read by the agent's `find_batch` (a packet photo's batch code) |

Window: 2026-07-08 to 2026-10-07 (`IMPORT_WINDOW_START`, `IMPORT_CUTOVER`). Not imported: production orders and
issues/receipts, journal history, e-invoice / e-way bill tables, SAP approvals, SAP users.

Batches are records of their own, not ERPNext's Batch: that needs batch tracking on the item, which ERPNext refuses
to switch on for items with stock transactions, and would then ask for a batch on every delivery. So SAP Batch is a
snapshot of SAP's batch history: batches made after the cut-over are not in it. The step creates the two DocTypes
itself (the service user has System Manager), so on a site set up before it existed run just:

```bash
psql "$SAP_PG" -1 -f tools/sap-import/sql/erp/14_batches.sql   # or tools/sap-import/run.py erp
.venv/bin/python -I run.py import --only batches
```

The backend mirrors the two tables when the site has them (`OPTIONAL_TABLES` in `backend/src/erp/erpnext/mirror.ts`)
and swaps `erp.batches` / `erp.batch_movements` onto them at boot (`BATCH_VIEWS` in `compat.ts`): restart it after
the first batches import.
