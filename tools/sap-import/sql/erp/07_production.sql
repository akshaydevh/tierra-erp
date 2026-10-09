-- Production orders (OWOR), their components (WOR1) and bills of materials (OITT/ITT1).
-- Production never links to a sales order in SAP (OriginType always manual); the customer is OWOR.CardCode.

-- Value issued to / received from each production order: goods issues and receipts based on it (BaseType 202),
-- at the stock price SAP posted. Closed orders balance to within a few rupees.
CREATE VIEW erp.production_values AS
SELECT baseentry AS doc_entry, sum(issued) AS issued_value, sum(received) AS received_value
FROM (SELECT baseentry, quantity * stockprice AS issued, 0 AS received FROM sap.ige1 WHERE basetype = 202
      UNION ALL
      SELECT baseentry, 0, quantity * stockprice FROM sap.ign1 WHERE basetype = 202) v
GROUP BY baseentry;

CREATE VIEW erp.production_orders AS
SELECT w.docentry AS doc_entry,
       erp.doc_no(n.seriesname, w.docnum) AS doc_no,
       w.docnum AS doc_num,
       w.itemcode AS item_code,
       w.prodname AS item_name,
       -- disassembly = repack / rework: the FG is issued and its materials received back
       CASE w.type WHEN 'D' THEN 'disassembly' ELSE 'standard' END AS type,
       CASE w.status WHEN 'P' THEN 'planned' WHEN 'R' THEN 'released' WHEN 'L' THEN 'closed' WHEN 'C' THEN 'cancelled' END AS status,
       w.plannedqty AS planned_qty,
       w.cmpltqty AS completed_qty,
       w.postdate AS post_date,
       w.startdate AS start_date,
       w.duedate AS due_date,
       w.closedate AS close_date,
       w.cardcode AS card_code,
       coalesce(c.cardname, w.u_cardname) AS customer_name,
       -- CSP = customer stock production, IHSP = in-house stock production
       nullif(w.u_potype, '') AS stock_type,
       round(coalesce(v.issued_value, 0), 2) AS issued_value,
       round(coalesce(v.received_value, 0), 2) AS received_value,
       w.comments,
       w.uom,
       w.warehouse AS whs_code,
       w.rlsdate AS release_date,
       erp.sap_ts(w.createdate, w.createts) AS created_at
FROM sap.owor w
LEFT JOIN sap.nnm1 n ON n.series = w.series
LEFT JOIN sap.ocrd c ON c.cardcode = w.cardcode
LEFT JOIN erp.production_values v ON v.doc_entry = w.docentry;

CREATE VIEW erp.production_components AS
WITH issued AS (
  SELECT baseentry, baseline, sum(quantity * stockprice) AS issued_value
  FROM sap.ige1 WHERE basetype = 202 GROUP BY baseentry, baseline
)
SELECT c.docentry AS doc_entry,
       c.linenum AS line_num,
       c.itemcode AS item_code,
       coalesce(i.item_name, c.itemname) AS item_name,
       i.material_role,
       c.plannedqty AS planned_qty,
       c.issuedqty AS issued_qty,
       i.uom,
       CASE c.issuetype WHEN 'B' THEN 'backflush' ELSE 'manual' END AS issue_method,
       round(coalesce(s.issued_value, 0), 2) AS issued_value,
       c.warehouse AS whs_code,
       c.visorder AS sort_order
FROM sap.wor1 c
LEFT JOIN erp.items i ON i.item_code = c.itemcode
LEFT JOIN issued s ON s.baseentry = c.docentry AND s.baseline = c.linenum;

-- BOM lines per FG. Quantities are per basis (10,000 pcs for most BOMs); qty_per_unit is per finished piece.
-- is_placeholder flags BOMs keyed with a dummy banana or flavour quantity (1 or less per 1,000+ pcs);
-- the requirement check must not trust those lines.
CREATE VIEW erp.bom_lines AS
SELECT t.father AS fg_item_code,
       h.qauntity AS basis_qty,
       t.childnum AS line_num,
       t.code AS component_code,
       i.item_name AS component_name,
       i.material_role,
       i.uom,
       t.quantity AS qty_per_basis,
       round(t.quantity / nullif(h.qauntity, 0), 8) AS qty_per_unit,
       CASE t.issuemthd WHEN 'B' THEN 'backflush' ELSE 'manual' END AS issue_method,
       coalesce(h.qauntity >= 1000 AND t.quantity <= 1
                AND (i.material_role IN ('raw_banana', 'raw_cassava')
                     OR (i.material_role = 'seasoning' AND i.item_name ILIKE 'flav%')), false) AS is_placeholder,
       t.warehouse AS whs_code,
       t.price
FROM sap.itt1 t
JOIN sap.oitt h ON h.code = t.father
LEFT JOIN erp.items i ON i.item_code = t.code;
