-- Finance: bank and cash accounts, the lines on them, incoming / outgoing payments, payment approvals, business-
-- partner balances and their ageing, and the helpers the daily report reads (invoices by dispatch time,
-- production issues / receipts). See Reference/research/2026-10-08-survey/sap-fin.md and daily-report.md.
--
-- Rules that hold throughout:
-- - Balances come from the journal (JDT1 debit - credit), never from document open flags (DocStatus / PaidToDate are
--   wrong in this company's SAP: receipts are booked on account and rarely matched to invoices).
-- - Payments are keyed on DocEntry; DocNum restarts every financial year. A payment's lines (RCT2/RCT4, VPM2/VPM4)
--   carry the payment's DocEntry in their DocNum column.
-- - Bank lines are dated by the journal's RefDate (the posting date), not by when they were keyed in.

-- Cash and bank accounts: the GL accounts SAP flags as cash accounts (OACT.Finanse = 'Y'). A bank when the account
-- or its parent heading says "bank", else cash. short_name: the first word of a bank's name (SBI, HDFC, ICICI),
-- "Cash <place>" for cash. house_bank: the account behind SAP's house bank (DSC1), printed
-- highlighted on the daily report.
CREATE VIEW erp.bank_accounts AS
WITH a AS (
  SELECT a.acctcode, a.acctname, a.formatcode,
         CASE WHEN a.acctname ILIKE '%bank%' OR p.acctname ILIKE '%bank%' THEN 'bank' ELSE 'cash' END AS kind,
         a.frozenfor = 'Y' AS inactive
  FROM sap.oact a
  LEFT JOIN sap.oact p ON p.acctcode = a.fathernum
  WHERE a.finanse = 'Y' AND a.postable = 'Y'
), named AS (
  SELECT a.*,
         CASE WHEN kind = 'bank' THEN upper(coalesce(substring(acctname FROM '^[A-Za-z]+'), acctname))
              ELSE coalesce('Cash ' || substring(acctname FROM '(?i)cash\W*([A-Za-z]+)'),
                            btrim(regexp_replace(acctname, '\s*\([^)]*\)\s*$', ''))) END AS base_name
  FROM a
)
SELECT acctcode AS gl_code,
       acctname AS gl_name,
       formatcode AS format_code,
       kind,
       -- two banks with the same first word keep apart by their code
       CASE WHEN count(*) OVER (PARTITION BY base_name) > 1 THEN base_name || ' ' || right(coalesce(formatcode, acctcode), 6)
            ELSE base_name END AS short_name,
       EXISTS (SELECT 1 FROM sap.dsc1 d WHERE d.glaccount = named.acctcode) AS house_bank,
       NOT inactive AS active,
       row_number() OVER (ORDER BY kind = 'cash', formatcode, acctcode)::integer AS display_order
FROM named;

-- Every journal line on a cash or bank account. amount = debit - credit (money in is positive).
-- contra_kind: bank (an inter-bank transfer: the other side is another cash/bank account), card (a customer or
-- supplier) or gl (an account payment, a journal entry). payment_*: the incoming (TransType 24) or outgoing (46)
-- payment that posted the line, whose memo usually says what it was for. A cancelled payment keeps both its entry
-- and the reversal (is_reversal; reverses_trans_id is the entry it cancels), so the day's lines always add up to the
-- balance movement. SAP posts the reversal in the same column as the original with a negative amount.
CREATE VIEW erp.bank_lines AS
SELECT j.transid AS trans_id,
       j.line_id,
       j.account AS gl_code,
       b.short_name AS bank,
       b.kind AS account_kind,
       j.refdate AS ref_date,
       erp.sap_ts_hhmm(o.createdate, o.createtime) AS created_at,
       j.debit,
       j.credit,
       j.debit - j.credit AS amount,
       j.contraact AS contra_code,
       CASE WHEN cb.gl_code IS NOT NULL THEN 'bank' WHEN c.cardcode IS NOT NULL THEN 'card' ELSE 'gl' END AS contra_kind,
       cb.short_name AS contra_bank,
       c.cardcode AS card_code,
       coalesce(c.cardname, ca.acctname) AS contra_name,
       j.transtype AS trans_type,
       CASE WHEN j.transtype IN ('24', '46') THEN j.createdby END AS payment_doc_entry,
       coalesce(r.doctype, v.doctype) AS payment_type,
       coalesce(nullif(btrim(coalesce(r.comments, v.comments)), ''), nullif(btrim(coalesce(r.jrnlmemo, v.jrnlmemo)), '')) AS payment_memo,
       coalesce(r.canceled, v.canceled) = 'Y' AS payment_cancelled,
       -- an account payment's purpose GL (its largest account line); for 'A' payments SAP also keeps it in CardCode
       CASE WHEN coalesce(r.doctype, v.doctype) = 'A' THEN coalesce(pl.purpose_gl, r.cardcode, v.cardcode) END AS purpose_gl,
       nullif(btrim(j.linememo), '') AS memo,
       nullif(btrim(o.memo), '') AS je_memo,
       j.baseref AS source_no,
       o.stornototr IS NOT NULL AS is_reversal,
       o.stornototr AS reverses_trans_id
FROM sap.jdt1 j
JOIN erp.bank_accounts b ON b.gl_code = j.account
JOIN sap.ojdt o ON o.transid = j.transid
LEFT JOIN erp.bank_accounts cb ON cb.gl_code = j.contraact
LEFT JOIN sap.ocrd c ON c.cardcode = j.contraact
LEFT JOIN sap.oact ca ON ca.acctcode = j.contraact
LEFT JOIN sap.orct r ON j.transtype = '24' AND r.docentry = j.createdby
LEFT JOIN sap.ovpm v ON j.transtype = '46' AND v.docentry = j.createdby
LEFT JOIN LATERAL (
  SELECT x.acctcode AS purpose_gl
  FROM (SELECT acctcode, sumapplied, lineid FROM sap.rct4 WHERE j.transtype = '24' AND docnum = j.createdby
        UNION ALL
        SELECT acctcode, sumapplied, lineid FROM sap.vpm4 WHERE j.transtype = '46' AND docnum = j.createdby) x
  ORDER BY x.sumapplied DESC, x.lineid
  LIMIT 1
) pl ON true;

-- Incoming (ORCT) and outgoing (OVPM) payments. kind: customer / supplier (CardCode is the business partner) or
-- account (paid straight to a GL account: salary, GST, loans, expenses; CardCode then holds that account).
-- transfer: an account payment whose purpose is another cash/bank account. purpose_gl: an account payment's account
-- (its largest RCT4/VPM4 line). on_account: the part not applied to any invoice (most receipts here). applied: the
-- part matched to invoices (RCT2/VPM2).
CREATE VIEW erp.payments AS
WITH acct AS (
  SELECT '24' AS sap_object, docnum AS doc_entry, (array_agg(acctcode ORDER BY sumapplied DESC, lineid))[1] AS purpose_gl,
         count(*) AS account_lines
  FROM sap.rct4 GROUP BY docnum
  UNION ALL
  SELECT '46', docnum, (array_agg(acctcode ORDER BY sumapplied DESC, lineid))[1], count(*)
  FROM sap.vpm4 GROUP BY docnum
), applied AS (
  SELECT '24' AS sap_object, docnum AS doc_entry, sum(sumapplied) AS applied, count(*) AS invoices FROM sap.rct2 GROUP BY docnum
  UNION ALL
  SELECT '46', docnum, sum(sumapplied), count(*) FROM sap.vpm2 GROUP BY docnum
), p AS (
  SELECT 'in' AS direction, '24' AS sap_object, docentry, docnum, series, doctype, canceled, docdate, cardcode, cardname,
         cashacct, trsfracct, doctotal, paynodoc, nodocsum, comments, jrnlmemo, transid, createdate, createts, trsfrref
  FROM sap.orct
  UNION ALL
  SELECT 'out', '46', docentry, docnum, series, doctype, canceled, docdate, cardcode, cardname,
         cashacct, trsfracct, doctotal, paynodoc, nodocsum, comments, jrnlmemo, transid, createdate, createts, trsfrref
  FROM sap.ovpm
)
SELECT p.direction,
       p.sap_object,
       p.docentry AS doc_entry,
       p.docnum AS doc_num,
       erp.doc_no(n.seriesname, p.docnum) AS doc_no,
       p.docdate AS doc_date,
       erp.sap_ts(p.createdate, p.createts) AS created_at,
       CASE p.doctype WHEN 'C' THEN 'customer' WHEN 'S' THEN 'supplier' ELSE 'account' END AS kind,
       CASE WHEN p.doctype IN ('C', 'S') THEN p.cardcode END AS card_code,
       CASE WHEN p.doctype IN ('C', 'S') THEN p.cardname END AS card_name,
       coalesce(nullif(p.trsfracct, ''), nullif(p.cashacct, '')) AS bank_gl,
       b.short_name AS bank,
       p.doctotal AS amount,
       CASE WHEN p.paynodoc = 'Y' THEN p.nodocsum ELSE 0 END AS on_account,
       coalesce(ap.applied, 0) AS applied,
       CASE WHEN p.doctype = 'A' THEN coalesce(a.purpose_gl, p.cardcode) END AS purpose_gl,
       CASE WHEN p.doctype = 'A' THEN pa.acctname END AS purpose_name,
       p.doctype = 'A' AND tb.gl_code IS NOT NULL AS transfer,
       coalesce(nullif(btrim(p.comments), ''), nullif(btrim(p.jrnlmemo), '')) AS memo,
       p.canceled = 'Y' AS cancelled,
       p.transid AS trans_id,
       nullif(btrim(p.trsfrref), '') AS bank_ref
FROM p
LEFT JOIN sap.nnm1 n ON n.series = p.series
LEFT JOIN acct a ON a.sap_object = p.sap_object AND a.doc_entry = p.docentry
LEFT JOIN applied ap ON ap.sap_object = p.sap_object AND ap.doc_entry = p.docentry
LEFT JOIN erp.bank_accounts b ON b.gl_code = coalesce(nullif(p.trsfracct, ''), nullif(p.cashacct, ''))
LEFT JOIN sap.oact pa ON pa.acctcode = CASE WHEN p.doctype = 'A' THEN coalesce(a.purpose_gl, p.cardcode) END
LEFT JOIN erp.bank_accounts tb ON tb.gl_code = CASE WHEN p.doctype = 'A' THEN coalesce(a.purpose_gl, p.cardcode) END;

-- Outgoing payments through SAP's approval (OWDD object 46 -> the payment draft OPDF, and once approved the payment
-- OVPM). status: pending (waiting), approved, rejected. Amount, party, memo and purpose come from the draft.
CREATE VIEW erp.payment_requests AS
WITH acct AS (
  SELECT docnum AS draft_entry, (array_agg(acctcode ORDER BY sumapplied DESC, lineid))[1] AS purpose_gl
  FROM sap.pdf4 GROUP BY docnum
)
SELECT w.wddcode AS request_id,
       w.draftentry AS draft_entry,
       w.docentry AS payment_doc_entry,
       CASE w.status WHEN 'Y' THEN 'approved' WHEN 'N' THEN 'rejected' ELSE 'pending' END AS status,
       d.docdate AS doc_date,
       erp.sap_ts_hhmm(w.createdate, w.createtime) AS requested_at,
       CASE WHEN s.status IN ('Y', 'N') THEN erp.sap_ts_hhmm(s.updatedate, s.updatetime) END AS decided_at,
       uo.u_name AS originator,
       ua.u_name AS approver,
       CASE d.doctype WHEN 'C' THEN 'customer' WHEN 'S' THEN 'supplier' ELSE 'account' END AS kind,
       CASE WHEN d.doctype IN ('C', 'S') THEN d.cardcode END AS card_code,
       CASE WHEN d.doctype IN ('C', 'S') THEN d.cardname END AS card_name,
       b.short_name AS bank,
       d.doctotal AS amount,
       CASE WHEN d.doctype = 'A' THEN coalesce(a.purpose_gl, d.cardcode) END AS purpose_gl,
       CASE WHEN d.doctype = 'A' THEN pa.acctname END AS purpose_name,
       coalesce(nullif(btrim(d.comments), ''), nullif(btrim(d.jrnlmemo), '')) AS memo,
       coalesce(nullif(s.remarks, ''), nullif(w.remarks, '')) AS remarks
FROM sap.owdd w
LEFT JOIN sap.opdf d ON d.docentry = w.draftentry
LEFT JOIN sap.wdd1 s ON s.wddcode = w.wddcode
LEFT JOIN sap.ousr uo ON uo.userid = w.usersign
LEFT JOIN sap.ousr ua ON ua.userid = s.userid
LEFT JOIN acct a ON a.draft_entry = d.docentry
LEFT JOIN sap.oact pa ON pa.acctcode = CASE WHEN d.doctype = 'A' THEN coalesce(a.purpose_gl, d.cardcode) END
LEFT JOIN erp.bank_accounts b ON b.gl_code = coalesce(nullif(d.trsfracct, ''), nullif(d.cashacct, ''))
WHERE w.objtype = '46';

-- Business-partner balances from the journal (equal to OCRD.Balance, except that a card under SAP's payment
-- consolidation keeps its own lines here while OCRD shows them on the parent). balance is debit - credit; owed is
-- what the party owes Tierra (customers) or Tierra owes the party (suppliers), so it is positive in the normal case.
-- group_key: the PAN, so branch cards of one company net together (receipts often land on one branch while the
-- invoices sit on another); else the card itself.
CREATE VIEW erp.bp_balances AS
WITH j AS (
  SELECT shortname, sum(debit - credit) AS balance, max(refdate) AS last_moved, count(*) AS lines
  FROM sap.jdt1 GROUP BY shortname
)
SELECT c.cardcode AS card_code,
       c.cardname AS card_name,
       CASE c.cardtype WHEN 'C' THEN 'customer' WHEN 'S' THEN 'supplier' ELSE 'lead' END AS card_type,
       g.pan,
       coalesce(g.pan, c.cardcode) AS group_key,
       round(coalesce(j.balance, 0), 2) AS balance,
       round(coalesce(j.balance, 0) * CASE WHEN c.cardtype = 'S' THEN -1 ELSE 1 END, 2) AS owed,
       c.balance AS sap_balance,
       j.last_moved,
       coalesce(j.lines, 0) AS lines
FROM sap.ocrd c
LEFT JOIN j ON j.shortname = c.cardcode
LEFT JOIN erp.party_gstins g ON g.card_code = c.cardcode;

-- Receivables and payables ageing as of the data date, FIFO at PAN-group level (sap-fin.md §2.4): a group's net
-- balance (customers and suppliers apart) is taken to be made of its newest documents that raised it (invoices,
-- debit lines), newest first, until the balance is used up; older documents count as paid. Groups whose net is zero
-- or in the party's favour (an advance) have no rows. One row per journal line the balance is allocated to; amount is
-- the part of it still open. days_overdue counts from the line's due date (its posting date when SAP has none).
-- A cancelled entry and its reversal (OJDT.StornoToTr) net to nothing: they count in the balance but never carry an
-- ageing row (a reversal of a receipt would otherwise look like the newest invoice).
-- bucket: not_due | 1_30 | 31_60 | 61_90 | 91_180 | over_180.
-- Materialized: it walks the whole journal once per import (the data date only changes with an import).
CREATE MATERIALIZED VIEW erp.ar_ap_ageing AS
WITH asof AS (
  SELECT data_as_of FROM erp.import_info
), reversed AS (
  SELECT transid FROM sap.ojdt WHERE stornototr IS NOT NULL
  UNION
  SELECT stornototr FROM sap.ojdt WHERE stornototr IS NOT NULL
), lines AS (
  SELECT c.cardcode, c.cardtype, coalesce(g.pan, c.cardcode) AS group_key,
         j.transid, j.line_id, j.refdate, coalesce(j.duedate, j.refdate) AS due_date, j.transtype, j.createdby,
         (j.debit - j.credit) * CASE WHEN c.cardtype = 'S' THEN -1 ELSE 1 END AS amt,
         j.transid IN (SELECT transid FROM reversed) AS reversed
  FROM sap.jdt1 j
  JOIN sap.ocrd c ON c.cardcode = j.shortname AND c.cardtype IN ('C', 'S')
  LEFT JOIN erp.party_gstins g ON g.card_code = c.cardcode
), grp AS (
  SELECT cardtype, group_key, sum(amt) AS balance FROM lines GROUP BY cardtype, group_key
), inc AS (
  SELECT l.*, g.balance,
         sum(l.amt) OVER (PARTITION BY l.cardtype, l.group_key
                          ORDER BY l.refdate DESC, l.transid DESC, l.line_id DESC) AS cum
  FROM lines l
  JOIN grp g ON g.cardtype = l.cardtype AND g.group_key = l.group_key
  WHERE l.amt > 0 AND g.balance >= 1 AND NOT l.reversed
), alloc AS (
  SELECT inc.*, least(amt, balance - (cum - amt)) AS open_amount, (SELECT data_as_of FROM asof) - due_date AS days_overdue
  FROM inc
  WHERE cum - amt < balance
)
SELECT CASE a.cardtype WHEN 'C' THEN 'receivable' ELSE 'payable' END AS side,
       a.group_key,
       a.cardcode AS card_code,
       a.transid AS trans_id,
       a.line_id,
       a.refdate AS ref_date,
       a.due_date,
       a.days_overdue,
       CASE WHEN a.days_overdue <= 0 THEN 'not_due'
            WHEN a.days_overdue <= 30 THEN '1_30'
            WHEN a.days_overdue <= 60 THEN '31_60'
            WHEN a.days_overdue <= 90 THEN '61_90'
            WHEN a.days_overdue <= 180 THEN '91_180'
            ELSE 'over_180' END AS bucket,
       round(a.open_amount, 2) AS amount,
       a.transtype AS trans_type,
       d.doc_no
FROM alloc a
LEFT JOIN erp.documents d ON d.sap_object = a.transtype AND d.doc_entry = a.createdby AND NOT d.is_cancellation;

CREATE INDEX ar_ap_ageing_group_idx ON erp.ar_ap_ageing (side, group_key);
CREATE INDEX ar_ap_ageing_card_idx ON erp.ar_ap_ageing (card_code);

-- A/R invoices that went out: not cancelled, not a cancellation mirror. The daily report's outwards block picks them
-- by one of three dates (the setting daily_report.outwards_basis): created_at against the evening cut-off
-- (created_window), doc_date, or the e-way bill's date (ewb_date; an invoice without one, e.g. under the e-way bill
-- limit, falls back to its doc_date).
CREATE VIEW erp.invoices_outwards AS
SELECT i.doc_entry,
       i.doc_no,
       i.doc_date,
       i.created_at,
       i.ewb_no,
       i.ewb_at,
       CASE WHEN e.ewb_cancelled THEN NULL ELSE e.ewb_date END AS ewb_date,
       i.card_code,
       i.card_name,
       i.total,
       i.tax_total
FROM erp.invoices i
LEFT JOIN erp.ewaybill_latest e ON e.base_entry = i.doc_entry
WHERE NOT i.cancelled AND NOT i.is_cancellation;

-- Goods issues (OIGE) and receipts (OIGN) line by line, with the production order they were posted against
-- (BaseType 202) and the item's material role. The daily report reads a day's issues of laminate / cartons
-- (packing / cartoning) and receipts of finished goods (production).
CREATE VIEW erp.production_movements AS
SELECT 'issue' AS kind,
       h.docentry AS doc_entry,
       erp.doc_no(n.seriesname, h.docnum) AS doc_no,
       h.docdate AS doc_date,
       erp.sap_ts(h.createdate, h.createts) AS created_at,
       l.linenum AS line_num,
       CASE WHEN l.basetype = 202 THEN l.baseentry END AS production_doc_entry,
       l.itemcode AS item_code,
       coalesce(i.item_name, l.dscription) AS item_name,
       i.material_role,
       l.quantity AS qty,
       i.uom,
       round(l.quantity * coalesce(l.stockprice, 0), 2) AS value,
       h.canceled <> 'N' AS cancelled
FROM sap.oige h
JOIN sap.ige1 l ON l.docentry = h.docentry
LEFT JOIN sap.nnm1 n ON n.series = h.series
LEFT JOIN erp.items i ON i.item_code = l.itemcode
UNION ALL
SELECT 'receipt',
       h.docentry,
       erp.doc_no(n.seriesname, h.docnum),
       h.docdate,
       erp.sap_ts(h.createdate, h.createts),
       l.linenum,
       CASE WHEN l.basetype = 202 THEN l.baseentry END,
       l.itemcode,
       coalesce(i.item_name, l.dscription),
       i.material_role,
       l.quantity,
       i.uom,
       round(l.quantity * coalesce(l.stockprice, 0), 2),
       h.canceled <> 'N'
FROM sap.oign h
JOIN sap.ign1 l ON l.docentry = h.docentry
LEFT JOIN sap.nnm1 n ON n.series = h.series
LEFT JOIN erp.items i ON i.item_code = l.itemcode;

-- Journal entries (OJDT) with their total and number, for "find the JE for ..." questions.
CREATE VIEW erp.journal_entries AS
SELECT o.transid AS trans_id,
       erp.doc_no(n.seriesname, o.number) AS doc_no,
       o.number AS doc_num,
       o.transtype AS trans_type,
       o.refdate AS ref_date,
       erp.sap_ts_hhmm(o.createdate, o.createtime) AS created_at,
       nullif(btrim(o.memo), '') AS memo,
       nullif(btrim(o.ref1), '') AS ref1,
       nullif(btrim(o.ref2), '') AS ref2,
       o.loctotal AS total,
       o.stornototr AS reverses_trans_id,
       u.u_name AS created_by
FROM sap.ojdt o
LEFT JOIN sap.nnm1 n ON n.series = o.series
LEFT JOIN sap.ousr u ON u.userid = o.usersign;

CREATE VIEW erp.journal_lines AS
SELECT j.transid AS trans_id,
       j.line_id,
       j.account AS gl_code,
       coalesce(c.cardname, a.acctname) AS account_name,
       CASE WHEN c.cardcode IS NOT NULL THEN j.shortname END AS card_code,
       j.debit,
       j.credit,
       nullif(btrim(j.linememo), '') AS memo,
       j.refdate AS ref_date
FROM sap.jdt1 j
LEFT JOIN sap.oact a ON a.acctcode = j.account
LEFT JOIN sap.ocrd c ON c.cardcode = j.shortname;
