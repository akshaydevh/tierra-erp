-- Costing (P7, sap-fin.md §5). SAP holds MATERIAL cost only: production orders carry no resource lines, and the
-- labour / power / water / consumable "overhead" items (material_role 'overhead') are issued to production as quantities
-- at zero value. So every cost below is material cost; labour and overheads are not in SAP and are never estimated here.
--
-- Finished goods are told by erp.items.material_role = 'fg' (an FG… code, or the item category FG), never by
-- OITB.U_Type: most FG sit in the generic "Items" group, which is what breaks SAP's own CCS daily P&L procedure.

-- Per production order: what was issued to it, what came back that is not its product (returns), and the product
-- received. material_cost = issued - returned; cost_per_pc = material_cost / pieces received. Closed orders balance:
-- SAP values the receipt at the issued cost.
CREATE MATERIALIZED VIEW erp.production_costs AS
WITH mv AS (
  SELECT m.production_doc_entry AS doc_entry, m.kind, m.item_code, m.material_role, m.qty, m.value, m.doc_date
  FROM erp.production_movements m
  WHERE m.production_doc_entry IS NOT NULL AND NOT m.cancelled
),
agg AS (
  SELECT mv.doc_entry,
         sum(mv.qty) FILTER (WHERE mv.kind = 'receipt' AND mv.item_code = w.itemcode) AS produced_qty,
         sum(mv.value) FILTER (WHERE mv.kind = 'receipt' AND mv.item_code = w.itemcode) AS produced_value,
         min(mv.doc_date) FILTER (WHERE mv.kind = 'receipt' AND mv.item_code = w.itemcode) AS first_receipt,
         max(mv.doc_date) FILTER (WHERE mv.kind = 'receipt' AND mv.item_code = w.itemcode) AS last_receipt,
         sum(mv.value) FILTER (WHERE mv.kind = 'issue') AS issued_value,
         sum(mv.value) FILTER (WHERE mv.kind = 'receipt' AND mv.item_code <> w.itemcode) AS returned_value,
         sum(mv.value) FILTER (WHERE mv.kind = 'issue' AND mv.material_role = 'raw_banana') AS banana_value,
         sum(mv.value) FILTER (WHERE mv.kind = 'issue' AND mv.material_role = 'raw_cassava') AS cassava_value,
         sum(mv.value) FILTER (WHERE mv.kind = 'issue' AND mv.material_role = 'oil') AS oil_value,
         sum(mv.value) FILTER (WHERE mv.kind = 'issue' AND mv.material_role = 'laminate') AS laminate_value,
         sum(mv.value) FILTER (WHERE mv.kind = 'issue' AND mv.material_role = 'carton') AS carton_value,
         sum(mv.value) FILTER (WHERE mv.kind = 'issue' AND mv.material_role = 'seasoning') AS seasoning_value,
         sum(mv.value) FILTER (WHERE mv.kind = 'issue' AND mv.material_role = 'consumable') AS consumable_value,
         sum(mv.value) FILTER (WHERE mv.kind = 'issue' AND mv.material_role = 'fg') AS fg_reused_value,
         sum(mv.value) FILTER (WHERE mv.kind = 'issue' AND coalesce(mv.material_role, 'other')
                                     NOT IN ('raw_banana', 'raw_cassava', 'oil', 'laminate', 'carton', 'seasoning',
                                             'consumable', 'fg', 'overhead')) AS other_value,
         sum(mv.qty) FILTER (WHERE mv.kind = 'issue' AND mv.material_role = 'overhead') AS overhead_qty
  FROM mv JOIN sap.owor w ON w.docentry = mv.doc_entry
  GROUP BY mv.doc_entry
)
SELECT o.doc_entry, o.doc_no, o.doc_num, o.item_code, o.item_name, i.material_role, o.type, o.status,
       o.post_date, o.close_date, o.card_code, o.customer_name, o.planned_qty, o.completed_qty,
       i.pack_grams,
       coalesce(a.produced_qty, 0) AS produced_qty,
       round(coalesce(a.produced_value, 0), 2) AS produced_value,
       a.first_receipt, a.last_receipt,
       round(coalesce(a.issued_value, 0), 2) AS issued_value,
       round(coalesce(a.returned_value, 0), 2) AS returned_value,
       round(coalesce(a.issued_value, 0) - coalesce(a.returned_value, 0), 2) AS material_cost,
       round((coalesce(a.issued_value, 0) - coalesce(a.returned_value, 0)) / nullif(a.produced_qty, 0), 4) AS cost_per_pc,
       round(a.produced_qty * i.pack_grams / 1000, 3) AS produced_kg,
       round((coalesce(a.issued_value, 0) - coalesce(a.returned_value, 0)) / nullif(a.produced_qty * i.pack_grams / 1000, 0), 2) AS cost_per_kg,
       round(coalesce(a.banana_value, 0), 2) AS banana_value,
       round(coalesce(a.cassava_value, 0), 2) AS cassava_value,
       round(coalesce(a.oil_value, 0), 2) AS oil_value,
       round(coalesce(a.laminate_value, 0), 2) AS laminate_value,
       round(coalesce(a.carton_value, 0), 2) AS carton_value,
       round(coalesce(a.seasoning_value, 0), 2) AS seasoning_value,
       round(coalesce(a.consumable_value, 0), 2) AS consumable_value,
       round(coalesce(a.fg_reused_value, 0), 2) AS fg_reused_value,
       round(coalesce(a.other_value, 0), 2) AS other_value,
       coalesce(a.overhead_qty, 0) AS overhead_qty
FROM erp.production_orders o
LEFT JOIN agg a ON a.doc_entry = o.doc_entry
LEFT JOIN erp.items i ON i.item_code = o.item_code;

CREATE UNIQUE INDEX production_costs_doc_entry_idx ON erp.production_costs (doc_entry);
CREATE INDEX production_costs_item_idx ON erp.production_costs (item_code, last_receipt);

-- Finished goods made per month and SKU: receipts of an order's own product (standard orders; a disassembly gives
-- materials back, not product), at the value SAP posted. value / qty is the SKU's material cost per piece that month.
CREATE MATERIALIZED VIEW erp.fg_cost_monthly AS
SELECT date_trunc('month', m.doc_date)::date AS month,
       m.item_code,
       min(m.item_name) AS item_name,
       min(i.pack_grams) AS pack_grams,
       sum(m.qty) AS produced_qty,
       round(sum(m.value), 2) AS produced_value,
       round(sum(m.qty) * min(i.pack_grams) / 1000, 3) AS produced_kg,
       count(DISTINCT m.production_doc_entry) AS orders
FROM erp.production_movements m
JOIN sap.owor w ON w.docentry = m.production_doc_entry AND w.itemcode = m.item_code AND w.type <> 'D'
LEFT JOIN erp.items i ON i.item_code = m.item_code
WHERE m.kind = 'receipt' AND NOT m.cancelled AND m.material_role = 'fg'
GROUP BY 1, 2;

CREATE UNIQUE INDEX fg_cost_monthly_key ON erp.fg_cost_monthly (month, item_code);

-- What was sold per month, SKU and customer card: invoice lines of finished goods (material_role fg) on invoices that were not
-- cancelled, at the line total before GST, against SAP's cost of goods sold at invoice (INV1.StockPrice x quantity).
-- group_key is the customer's PAN (branch cards together), else the card. Credit notes are not netted.
CREATE MATERIALIZED VIEW erp.sku_margin_monthly AS
SELECT date_trunc('month', h.docdate)::date AS month,
       l.itemcode AS item_code,
       min(coalesce(i.item_name, l.dscription)) AS item_name,
       min(i.pack_grams) AS pack_grams,
       h.cardcode AS card_code,
       min(h.cardname) AS card_name,
       coalesce(min(g.pan), h.cardcode) AS group_key,
       sum(l.quantity) AS qty,
       round(sum(l.linetotal), 2) AS revenue,
       round(sum(l.quantity * coalesce(l.stockprice, 0)), 2) AS cogs,
       round(sum(l.quantity) * min(i.pack_grams) / 1000, 3) AS kg,
       count(DISTINCT h.docentry) AS invoices
FROM sap.inv1 l
JOIN sap.oinv h ON h.docentry = l.docentry
JOIN erp.items i ON i.item_code = l.itemcode AND i.material_role = 'fg'
LEFT JOIN erp.party_gstins g ON g.card_code = h.cardcode
WHERE h.canceled = 'N'
GROUP BY 1, 2, h.cardcode;

CREATE INDEX sku_margin_monthly_month_idx ON erp.sku_margin_monthly (month);
CREATE INDEX sku_margin_monthly_item_idx ON erp.sku_margin_monthly (item_code, month);

-- Materials issued to production per month by material role, less what came back to stock from production orders
-- (returns of material, not product). Overhead items (labour, power, water) carry quantities only: value 0 in SAP.
CREATE MATERIALIZED VIEW erp.material_mix_monthly AS
SELECT date_trunc('month', m.doc_date)::date AS month,
       coalesce(m.material_role, 'other') AS material_role,
       round(sum(m.value) FILTER (WHERE m.kind = 'issue'), 2) AS issued_value,
       round(coalesce(sum(m.value) FILTER (WHERE m.kind = 'receipt'), 0), 2) AS returned_value,
       round(coalesce(sum(m.value) FILTER (WHERE m.kind = 'issue'), 0) - coalesce(sum(m.value) FILTER (WHERE m.kind = 'receipt'), 0), 2) AS net_value,
       sum(m.qty) FILTER (WHERE m.kind = 'issue' AND m.uom = 'kg') AS issued_kg,
       sum(m.qty) FILTER (WHERE m.kind = 'issue') AS issued_qty,
       count(*) FILTER (WHERE m.kind = 'issue') AS lines
FROM erp.production_movements m
JOIN sap.owor w ON w.docentry = m.production_doc_entry
WHERE NOT m.cancelled AND (m.kind = 'issue' OR m.item_code <> w.itemcode)
GROUP BY 1, 2;

CREATE UNIQUE INDEX material_mix_monthly_key ON erp.material_mix_monthly (month, material_role);

-- Stock value from the valuation layers (OIVL/IVL1): what is left of each layer, per item and warehouse. Right for every
-- valuation method (OITW.AvgPrice is 0 for batch items and understates FIFO ones). Customer-supplied stock is at 0.
CREATE MATERIALIZED VIEW erp.stock_valuation AS
SELECT o.itemcode AS item_code,
       min(i.item_name) AS item_name,
       min(i.material_role) AS material_role,
       min(i.group_name) AS group_name,
       min(i.valuation_method) AS valuation_method,
       o.loccode AS whs_code,
       sum(l.layerinqty - l.layeroutq) AS qty,
       round(sum(l.transvalue), 2) AS value,
       bool_or(coalesce(w.customer_supplied, false)) AS customer_supplied
FROM sap.ivl1 l
JOIN sap.oivl o ON o.transseq = l.transseq
LEFT JOIN erp.items i ON i.item_code = o.itemcode
LEFT JOIN erp.item_ownership w ON w.item_code = o.itemcode
GROUP BY o.itemcode, o.loccode
HAVING sum(l.layerinqty - l.layeroutq) <> 0 OR round(sum(l.transvalue), 2) <> 0;

CREATE UNIQUE INDEX stock_valuation_key ON erp.stock_valuation (item_code, whs_code);

-- The GL accounts costing and payroll read, found by their names in the chart of accounts (no account codes here):
--   wip_variance     Work in Progress Variance (production orders closing at a value other than the issues)
--   wip              postable accounts under the "Work in Progress" heading of Inventories
--   inventory        other postable accounts under Inventories (raw materials, finished goods, stock in hand ...)
--   salary_expense   "Salary and allowances" accounts (the monthly salary journal entry)
--   employer_contribution  employer PF / ESI
--   staff_cost_other the other accounts under the Salary and Allowances heading (bonus, gratuity, employee PF / ESI)
--   salary_payable   Salary (& wages) payable, what salary payments clear
CREATE VIEW erp.cost_gl_accounts AS
WITH a AS (
  SELECT a.acctcode, a.acctname, a.postable,
         btrim(regexp_replace(a.acctname, '\s*\(TRA\)\s*$', '')) AS name,
         btrim(f.acctname) AS parent, btrim(g.acctname) AS grandparent
  FROM sap.oact a
  LEFT JOIN sap.oact f ON f.acctcode = a.fathernum
  LEFT JOIN sap.oact g ON g.acctcode = f.fathernum
),
k AS (
  SELECT acctcode, name,
         CASE
           WHEN name ILIKE 'work in progress variance%' OR name ILIKE 'wip variance%'
                OR parent ILIKE 'work in progress variance%' THEN 'wip_variance'
           WHEN parent ILIKE 'work in progress' AND grandparent ILIKE 'inventor%' THEN 'wip'
           WHEN parent ILIKE 'inventories' OR grandparent ILIKE 'inventories' THEN 'inventory'
           WHEN name ILIKE 'salary and allowances%' THEN 'salary_expense'
           WHEN name ILIKE 'employer contribution%' THEN 'employer_contribution'
           WHEN parent ILIKE 'salary and allowances%' THEN 'staff_cost_other'
           WHEN name ILIKE 'salary%payable%' THEN 'salary_payable'
         END AS kind
  FROM a WHERE postable = 'Y'
)
SELECT acctcode AS gl_code, name AS account_name, kind FROM k WHERE kind IS NOT NULL;

-- Those accounts' journal lines per month (RefDate).
CREATE VIEW erp.cost_gl_monthly AS
SELECT date_trunc('month', j.refdate)::date AS month,
       a.gl_code, a.account_name, a.kind,
       round(sum(j.debit), 2) AS debit,
       round(sum(j.credit), 2) AS credit,
       round(sum(j.debit - j.credit), 2) AS net,
       count(*) AS lines
FROM erp.cost_gl_accounts a
JOIN sap.jdt1 j ON j.account = a.gl_code
GROUP BY 1, 2, 3, 4;

-- The WIP variance account by month: positive = production orders closed at less than was issued to them.
CREATE VIEW erp.wip_variance_monthly AS
SELECT month, gl_code, account_name, debit, credit, net, lines
FROM erp.cost_gl_monthly WHERE kind = 'wip_variance';
