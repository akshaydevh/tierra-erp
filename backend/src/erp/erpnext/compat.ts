import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SapSql } from '../../sap/db'

/**
 * The `sap` schema as views over the ERPNext mirror (mirror.ts). Each view has exactly the columns and types of the
 * SAP table it stands for (test/sap-schema.sql, generated from the SAP backup), so the erp views
 * (tools/sap-import/sql/erp) and the few queries that read sap.* run unchanged. A column ERPNext has no counterpart
 * for is NULL; a SAP table ERPNext does not model (production, batches, e-invoices, SAP approvals) is an empty view.
 */

const BACKEND = join(__dirname, '..', '..', '..')
export const SAP_SCHEMA_FILE = join(BACKEND, 'test', 'sap-schema.sql')
export const ERP_SQL_DIR = join(BACKEND, '..', 'tools', 'sap-import', 'sql', 'erp')
export const ATT_SQL_FILE = join(BACKEND, '..', 'tools', 'sap-import', 'sql', 'att.sql')
export const HR_SQL_FILE = join(BACKEND, '..', 'tools', 'sap-import', 'sql', 'hr.sql')

type Spec = { from: string; cols: Record<string, string> }

/** Helpers the views share. Party, warehouse and account keys stay SAP's codes for imported records. */
const HELPERS = `
CREATE FUNCTION erpnext.id(dt text, nm text) RETURNS bigint LANGUAGE sql STABLE
RETURN (SELECT id FROM erpnext._ids WHERE doctype = dt AND name = nm);

CREATE FUNCTION erpnext.card(ptype text, pname text) RETURNS text LANGUAGE sql STABLE
RETURN CASE ptype
  WHEN 'Customer' THEN (SELECT coalesce(custom_sap_ref, name) FROM erpnext."tabCustomer" WHERE name = pname)
  WHEN 'Supplier' THEN (SELECT coalesce(custom_sap_ref, name) FROM erpnext."tabSupplier" WHERE name = pname)
END;

CREATE FUNCTION erpnext.whs(wname text) RETURNS text LANGUAGE sql STABLE
RETURN (SELECT coalesce(custom_sap_ref, warehouse_name) FROM erpnext."tabWarehouse" WHERE name = wname);

CREATE FUNCTION erpnext.acct(aname text) RETURNS text LANGUAGE sql STABLE
RETURN (SELECT coalesce(nullif(account_number, ''), name) FROM erpnext."tabAccount" WHERE name = aname);

-- SAP's number for an imported document, else the running number at the end of the ERPNext name
CREATE FUNCTION erpnext.docnum(nm text, sap_num bigint) RETURNS integer LANGUAGE sql IMMUTABLE
RETURN coalesce(nullif(sap_num, 0), (substring(nm FROM '(\\d+)$'))::integer);

-- SAP's series name for an imported document, else the ERPNext naming series ("SAL-ORD-2026")
CREATE FUNCTION erpnext.series_name(nm text, sap_series text) RETURNS text LANGUAGE sql IMMUTABLE
RETURN coalesce(sap_series, regexp_replace(nm, '-?\\d+$', ''));

CREATE FUNCTION erpnext.hhmmss(t timestamp) RETURNS integer LANGUAGE sql IMMUTABLE
RETURN (extract(hour FROM t) * 10000 + extract(minute FROM t) * 100 + floor(extract(second FROM t)))::integer;

CREATE FUNCTION erpnext.taxrate(code text) RETURNS numeric LANGUAGE sql STABLE
RETURN (SELECT CASE WHEN custom_taxrate ~ '^\\d+(\\.\\d+)?$' THEN custom_taxrate::numeric END
        FROM erpnext."tabItem" WHERE name = code);

-- SAP object codes for the journal (OJDT.TransType)
CREATE FUNCTION erpnext.transtype(vt text, vn text) RETURNS text LANGUAGE sql STABLE
RETURN CASE vt
  WHEN 'Sales Invoice' THEN (SELECT CASE WHEN is_return = 1 THEN '14' ELSE '13' END FROM erpnext."tabSales Invoice" WHERE name = vn)
  WHEN 'Purchase Invoice' THEN (SELECT CASE WHEN is_return = 1 THEN '19' ELSE '18' END FROM erpnext."tabPurchase Invoice" WHERE name = vn)
  WHEN 'Purchase Receipt' THEN '20'
  WHEN 'Payment Entry' THEN (SELECT CASE WHEN payment_type = 'Receive' THEN '24' ELSE '46' END FROM erpnext."tabPayment Entry" WHERE name = vn)
  WHEN 'Journal Entry' THEN (SELECT CASE WHEN custom_sap_ref LIKE 'ORCT:%' THEN '24' WHEN custom_sap_ref LIKE 'OVPM:%' THEN '46' ELSE '30' END
                             FROM erpnext."tabJournal Entry" WHERE name = vn)
  WHEN 'Stock Reconciliation' THEN '162'
  ELSE '30'
END;

-- every document's tax: the GST rows (SAP VatSum), not the round-off row the importer adds
CREATE VIEW erpnext.doc_vat AS
SELECT parenttype, parent, sum(tax_amount) FILTER (WHERE account_head LIKE 'Output GST%' OR account_head LIKE 'Input GST%') AS vat
FROM (SELECT parenttype, parent, account_head, tax_amount FROM erpnext."tabSales Taxes and Charges"
      UNION ALL SELECT parenttype, parent, account_head, tax_amount FROM erpnext."tabPurchase Taxes and Charges") t
GROUP BY parenttype, parent;

-- incoming (24) and outgoing (46) payments: Payment Entries, and the Journal Entries imported from SAP account
-- payments (DocType A). The bank side decides cash vs transfer.
CREATE VIEW erpnext.pay_src AS
SELECT CASE p.payment_type WHEN 'Receive' THEN '24' ELSE '46' END AS objtype,
       erpnext.id('Payment Entry', p.name) AS docentry,
       erpnext.docnum(p.name, p.custom_sap_docnum) AS docnum,
       erpnext.series_name(p.name, p.custom_sap_series_name) AS series_name,
       CASE p.party_type WHEN 'Customer' THEN 'C' WHEN 'Supplier' THEN 'S' ELSE 'A' END AS doctype,
       CASE WHEN p.docstatus = 2 THEN 'Y' ELSE 'N' END AS canceled,
       p.posting_date AS docdate,
       erpnext.card(p.party_type, p.party) AS cardcode,
       p.party_name AS cardname,
       erpnext.acct(CASE p.payment_type WHEN 'Receive' THEN p.paid_to ELSE p.paid_from END) AS bank_code,
       (SELECT account_type FROM erpnext."tabAccount" WHERE name = CASE p.payment_type WHEN 'Receive' THEN p.paid_to ELSE p.paid_from END) AS bank_type,
       CASE WHEN p.unallocated_amount > 0 THEN 'Y' ELSE 'N' END AS paynodoc,
       p.unallocated_amount AS nodocsum,
       p.paid_amount AS doctotal,
       p.remarks AS comments,
       erpnext.id('GL', 'Payment Entry/' || p.name) AS transid,
       coalesce(p.custom_sap_created, p.creation) AS created,
       p.modified,
       p.reference_no AS trsfrref
FROM erpnext."tabPayment Entry" p WHERE p.docstatus IN (1, 2)
UNION ALL
SELECT CASE WHEN j.custom_sap_ref LIKE 'ORCT:%' THEN '24' ELSE '46' END,
       erpnext.id('Journal Entry', j.name),
       erpnext.docnum(j.name, j.custom_sap_docnum),
       erpnext.series_name(j.name, j.custom_sap_series_name),
       'A',
       CASE WHEN j.docstatus = 2 THEN 'Y' ELSE 'N' END,
       j.posting_date,
       o.code, o.account_name,
       b.code, b.account_type,
       'N', 0, j.total_debit, j.user_remark,
       erpnext.id('GL', 'Journal Entry/' || j.name),
       coalesce(j.custom_sap_created, j.creation), j.modified, j.cheque_no
FROM erpnext."tabJournal Entry" j
LEFT JOIN LATERAL (SELECT erpnext.acct(a.account) AS code, ac.account_type FROM erpnext."tabJournal Entry Account" a
                   JOIN erpnext."tabAccount" ac ON ac.name = a.account
                   WHERE a.parent = j.name AND ac.account_type IN ('Bank', 'Cash') ORDER BY a.idx LIMIT 1) b ON true
LEFT JOIN LATERAL (SELECT erpnext.acct(a.account) AS code, ac.account_name FROM erpnext."tabJournal Entry Account" a
                   JOIN erpnext."tabAccount" ac ON ac.name = a.account
                   WHERE a.parent = j.name AND coalesce(ac.account_type, '') NOT IN ('Bank', 'Cash') ORDER BY a.idx LIMIT 1) o ON true
WHERE j.docstatus IN (1, 2) AND (j.custom_sap_ref LIKE 'ORCT:%' OR j.custom_sap_ref LIKE 'OVPM:%');

-- the GL account lines of account payments (RCT4 / VPM4)
CREATE VIEW erpnext.pay_acct_lines AS
SELECT CASE WHEN j.custom_sap_ref LIKE 'ORCT:%' THEN '24' ELSE '46' END AS objtype,
       erpnext.id('Journal Entry', j.name) AS docnum, a.idx AS lineid, erpnext.acct(a.account) AS acctcode,
       a.debit + a.credit AS sumapplied, ac.account_name AS acctname
FROM erpnext."tabJournal Entry" j
JOIN erpnext."tabJournal Entry Account" a ON a.parent = j.name
JOIN erpnext."tabAccount" ac ON ac.name = a.account
WHERE j.docstatus = 1 AND (j.custom_sap_ref LIKE 'ORCT:%' OR j.custom_sap_ref LIKE 'OVPM:%')
  AND coalesce(ac.account_type, '') NOT IN ('Bank', 'Cash');

-- the invoices a payment is matched to (RCT2 / VPM2)
CREATE VIEW erpnext.pay_doc_lines AS
SELECT CASE p.payment_type WHEN 'Receive' THEN '24' ELSE '46' END AS objtype,
       erpnext.id('Payment Entry', p.name) AS docnum, erpnext.id(r.reference_doctype, r.reference_name) AS docentry,
       r.allocated_amount AS sumapplied,
       CASE r.reference_doctype WHEN 'Sales Invoice' THEN '13' WHEN 'Purchase Invoice' THEN '18' ELSE '30' END AS doc_objtype
FROM erpnext."tabPayment Entry" p JOIN erpnext."tabPayment Entry Reference" r ON r.parent = p.name
WHERE p.docstatus = 1;

-- journal lines with SAP's keys: one transaction per ERPNext voucher
CREATE VIEW erpnext.gl AS
SELECT erpnext.id('GL', g.voucher_type || '/' || g.voucher_no) AS transid,
       (row_number() OVER (PARTITION BY g.voucher_type, g.voucher_no ORDER BY g.creation, g.name) - 1)::integer AS line_id,
       erpnext.acct(g.account) AS account,
       CASE WHEN g.party IS NOT NULL AND g.party <> '' THEN erpnext.card(g.party_type, g.party) ELSE erpnext.acct(g.account) END AS shortname,
       g.debit, g.credit, g.posting_date, g.due_date, g.voucher_type, g.voucher_no, g.remarks, g.creation,
       erpnext.transtype(g.voucher_type, g.voucher_no) AS transtype,
       erpnext.id(g.voucher_type, g.voucher_no) AS createdby,
       c.contra
FROM erpnext."tabGL Entry" g
LEFT JOIN LATERAL (
  SELECT CASE WHEN o.party IS NOT NULL AND o.party <> '' THEN erpnext.card(o.party_type, o.party) ELSE erpnext.acct(o.account) END AS contra
  FROM erpnext."tabGL Entry" o
  WHERE o.voucher_no = g.voucher_no AND o.voucher_type = g.voucher_type AND o.account <> g.account
    AND sign(o.debit - o.credit) <> sign(g.debit - g.credit)
  ORDER BY abs(o.debit - o.credit) DESC LIMIT 1) c ON true;

CREATE VIEW erpnext.series AS
SELECT DISTINCT hashtext(s)::integer AS series, s AS seriesname FROM (
  SELECT erpnext.series_name(name, custom_sap_series_name) AS s FROM erpnext."tabSales Order"
  UNION SELECT erpnext.series_name(name, custom_sap_series_name) FROM erpnext."tabSales Invoice"
  UNION SELECT erpnext.series_name(name, custom_sap_series_name) FROM erpnext."tabPurchase Order"
  UNION SELECT erpnext.series_name(name, custom_sap_series_name) FROM erpnext."tabPurchase Receipt"
  UNION SELECT erpnext.series_name(name, custom_sap_series_name) FROM erpnext."tabPurchase Invoice"
  UNION SELECT series_name FROM erpnext.pay_src) x
WHERE s IS NOT NULL;
`

/** Columns every marketing document header shares (ORDR, OINV, OPOR, OPDN, OPCH). */
function header(doctype: string, extra: Record<string, string>): Record<string, string> {
  return {
    docentry: `erpnext.id('${doctype}', h.name)`,
    docnum: 'erpnext.docnum(h.name, h.custom_sap_docnum)',
    series: 'hashtext(erpnext.series_name(h.name, h.custom_sap_series_name))',
    doctype: "'I'",
    canceled: "CASE WHEN h.docstatus = 2 THEN 'Y' ELSE 'N' END",
    vatsum: 'coalesce(t.vat, 0)',
    doctotal: 'h.grand_total',
    comments: 'h.remarks',
    createdate: 'coalesce(h.custom_sap_created, h.creation)::date',
    createts: 'erpnext.hhmmss(coalesce(h.custom_sap_created, h.creation))',
    updatedate: 'h.modified::date',
    wddstatus: "'-'",
    ...extra,
  }
}

const headFrom = (table: string, where = '') =>
  `erpnext."${table}" h LEFT JOIN erpnext.doc_vat t ON t.parenttype = '${table.slice(3)}' AND t.parent = h.name
   WHERE h.docstatus IN (1, 2)${where}`

const PAY_HEAD: Record<string, string> = {
  docentry: 's.docentry',
  docnum: 's.docnum',
  series: 'hashtext(s.series_name)',
  objtype: 's.objtype',
  doctype: 's.doctype',
  canceled: 's.canceled',
  docdate: 's.docdate',
  docduedate: 's.docdate',
  taxdate: 's.docdate',
  cardcode: 's.cardcode',
  cardname: 's.cardname',
  cashacct: "CASE WHEN s.bank_type = 'Cash' THEN s.bank_code END",
  cashsum: "CASE WHEN s.bank_type = 'Cash' THEN s.doctotal ELSE 0 END",
  trsfracct: "CASE WHEN s.bank_type <> 'Cash' THEN s.bank_code END",
  trsfrsum: "CASE WHEN s.bank_type <> 'Cash' THEN s.doctotal ELSE 0 END",
  trsfrref: 's.trsfrref',
  paynodoc: 's.paynodoc',
  nodocsum: 's.nodocsum',
  doctotal: 's.doctotal',
  comments: 's.comments',
  transid: 's.transid',
  createdate: 's.created::date',
  createts: 'erpnext.hhmmss(s.created)',
  updatedate: 's.modified::date',
}

export const COMPAT: Record<string, Spec> = {
  _import: {
    from: `(SELECT 'backup' AS key, 'ERPNext' AS value
            UNION ALL SELECT 'imported_at', (SELECT synced_at::text FROM erpnext._sync WHERE id = 1)
            UNION ALL SELECT 'data_as_of', (SELECT greatest(
              (SELECT max(transaction_date) FROM erpnext."tabSales Order" WHERE docstatus = 1),
              (SELECT max(posting_date) FROM erpnext."tabSales Invoice" WHERE docstatus = 1),
              (SELECT max(posting_date) FROM erpnext."tabPurchase Receipt" WHERE docstatus = 1))::text)) s`,
    cols: { key: 's.key', value: 's.value' },
  },
  oitb: {
    from: `erpnext."tabItem Group" g WHERE g.custom_sap_group_code > 0`,
    cols: { itmsgrpcod: 'g.custom_sap_group_code', itmsgrpnam: 'g.item_group_name', createdate: 'g.creation::date' },
  },
  ochp: {
    from: `(SELECT DISTINCT custom_hsn FROM erpnext."tabItem" WHERE custom_hsn IS NOT NULL) h`,
    cols: { absentry: 'hashtext(h.custom_hsn)', chapter: 'h.custom_hsn' },
  },
  oitm: {
    from: `erpnext."tabItem" i
           LEFT JOIN erpnext."tabItem Group" g ON g.name = i.item_group
           LEFT JOIN LATERAL (SELECT default_warehouse FROM erpnext."tabItem Default" x
                              WHERE x.parent = i.name ORDER BY x.default_warehouse IS NULL, x.idx LIMIT 1) d ON true`,
    cols: {
      itemcode: 'i.item_code',
      itemname: 'i.item_name',
      itmsgrpcod: 'nullif(g.custom_sap_group_code, 0)',
      itemtype: "'I'",
      invntitem: "CASE WHEN i.is_stock_item = 1 THEN 'Y' ELSE 'N' END",
      sellitem: "CASE WHEN i.is_sales_item = 1 THEN 'Y' ELSE 'N' END",
      prchseitem: "CASE WHEN i.is_purchase_item = 1 THEN 'Y' ELSE 'N' END",
      invntryuom: 'coalesce(i.custom_sap_uom, i.stock_uom)',
      evalsystem: "coalesce(i.custom_evalsystem, 'A')",
      treetype: `CASE WHEN EXISTS (SELECT 1 FROM erpnext."tabBOM" b WHERE b.item = i.name AND b.is_default = 1
                                   AND b.docstatus = 1) THEN 'P' ELSE 'N' END`,
      manbtchnum: "CASE WHEN i.custom_batch_managed = 1 THEN 'Y' ELSE 'N' END",
      dfltwh: 'erpnext.whs(d.default_warehouse)',
      chapterid: 'CASE WHEN i.custom_hsn IS NOT NULL THEN hashtext(i.custom_hsn) END',
      frozenfor: "CASE WHEN i.custom_frozen = 1 OR i.disabled = 1 THEN 'Y' ELSE 'N' END",
      u_npu: 'i.custom_npu',
      u_itmctg: 'i.custom_itmctg',
      u_taxrate: 'i.custom_taxrate',
      createdate: 'i.creation::date',
      updatedate: 'i.modified::date',
    },
  },
  owhs: {
    from: `erpnext."tabWarehouse" w WHERE w.is_group = 0`,
    cols: { whscode: 'coalesce(w.custom_sap_ref, w.warehouse_name)', whsname: 'w.warehouse_name', inactive: "'N'", locked: "'N'" },
  },
  oitw: {
    from: `erpnext."tabBin" b`,
    cols: {
      itemcode: 'b.item_code',
      whscode: 'erpnext.whs(b.warehouse)',
      onhand: 'b.actual_qty',
      iscommited: 'b.reserved_qty',
      onorder: 'b.ordered_qty',
      avgprice: 'b.valuation_rate',
      stockvalue: 'b.stock_value',
    },
  },
  ocrg: {
    from: `(SELECT custom_sap_group_code AS code, customer_group_name AS nm, 'C' AS t FROM erpnext."tabCustomer Group"
            UNION ALL SELECT custom_sap_group_code, supplier_group_name, 'S' FROM erpnext."tabSupplier Group") g
           WHERE g.code > 0`,
    cols: { groupcode: 'g.code', groupname: 'g.nm', grouptype: 'g.t' },
  },
  ocrd: {
    from: `(SELECT 'C' AS cardtype, 'Customer' AS ptype, c.name, c.customer_name AS cardname, c.custom_sap_ref, g.custom_sap_group_code AS groupcode,
                   c.custom_phone1, c.custom_cellular, c.custom_email, c.custom_city, c.custom_state, c.custom_zipcode,
                   c.custom_billtodef, c.custom_shiptodef, c.custom_frozen, c.disabled, c.custom_sap_created, c.creation, c.modified
            FROM erpnext."tabCustomer" c LEFT JOIN erpnext."tabCustomer Group" g ON g.name = c.customer_group
            UNION ALL
            SELECT 'S', 'Supplier', s.name, s.supplier_name, s.custom_sap_ref, g.custom_sap_group_code,
                   s.custom_phone1, s.custom_cellular, s.custom_email, s.custom_city, s.custom_state, s.custom_zipcode,
                   s.custom_billtodef, s.custom_shiptodef, s.custom_frozen, s.disabled, s.custom_sap_created, s.creation, s.modified
            FROM erpnext."tabSupplier" s LEFT JOIN erpnext."tabSupplier Group" g ON g.name = s.supplier_group) p
           LEFT JOIN (SELECT party_type, party, sum(debit - credit) AS bal FROM erpnext."tabGL Entry"
                      WHERE party IS NOT NULL GROUP BY party_type, party) b ON b.party_type = p.ptype AND b.party = p.name`,
    cols: {
      cardcode: 'coalesce(p.custom_sap_ref, p.name)',
      cardname: 'p.cardname',
      cardtype: 'p.cardtype',
      groupcode: 'nullif(p.groupcode, 0)',
      zipcode: 'p.custom_zipcode',
      city: 'p.custom_city',
      state1: 'p.custom_state',
      phone1: 'p.custom_phone1',
      cellular: 'p.custom_cellular',
      e_mail: 'p.custom_email',
      shiptodef: 'p.custom_shiptodef',
      billtodef: 'p.custom_billtodef',
      balance: 'coalesce(b.bal, 0)',
      frozenfor: "CASE WHEN p.custom_frozen = 1 OR p.disabled = 1 THEN 'Y' ELSE 'N' END",
      validfor: "'Y'",
      createdate: 'coalesce(p.custom_sap_created, p.creation::date)',
      createts: 'erpnext.hhmmss(p.creation)',
      updatedate: 'p.modified::date',
    },
  },
  crd1: {
    from: `erpnext."tabAddress" a
           JOIN erpnext."tabDynamic Link" l ON l.parent = a.name AND l.link_doctype IN ('Customer', 'Supplier')`,
    cols: {
      address: 'coalesce(a.custom_sap_address_name, a.address_title)',
      cardcode: 'erpnext.card(l.link_doctype, l.link_name)',
      street: 'CASE WHEN a.custom_sap_ref IS NULL THEN a.address_line1 ELSE a.custom_street END',
      block: 'a.custom_block',
      zipcode: 'a.pincode',
      city: 'a.city',
      state: 'a.state',
      linenum: 'coalesce(nullif(a.custom_linenum, 0), a.idx)',
      building: 'a.custom_building',
      adrestype: "CASE a.address_type WHEN 'Billing' THEN 'B' ELSE 'S' END",
      address2: 'CASE WHEN a.custom_sap_ref IS NULL THEN a.address_line2 ELSE a.custom_address2 END',
      address3: 'a.custom_address3',
      gstregnno: 'a.custom_gstin',
      createdate: 'a.creation::date',
    },
  },
  oitt: {
    from: `erpnext."tabBOM" b WHERE b.docstatus = 1 AND b.is_default = 1 AND b.is_active = 1`,
    cols: {
      code: 'b.item',
      treetype: "'P'",
      qauntity: 'b.quantity',
      createdate: 'b.creation::date',
      createts: 'erpnext.hhmmss(b.creation)',
    },
  },
  itt1: {
    from: `erpnext."tabBOM Item" l JOIN erpnext."tabBOM" b ON b.name = l.parent
           WHERE b.docstatus = 1 AND b.is_default = 1 AND b.is_active = 1`,
    cols: {
      father: 'b.item',
      childnum: 'l.idx - 1',
      visorder: 'l.idx - 1',
      code: 'l.item_code',
      quantity: 'l.qty',
      warehouse: 'erpnext.whs(l.source_warehouse)',
      price: 'l.rate',
      issuemthd: "'M'",
      uom: 'l.uom',
      type: '4',
      itemname: 'l.item_name',
    },
  },
  ordr: {
    from: headFrom('tabSales Order'),
    cols: header('Sales Order', {
      objtype: "'17'",
      docstatus: "CASE WHEN h.status IN ('Closed', 'Completed') THEN 'C' ELSE 'O' END",
      docdate: 'h.transaction_date',
      docduedate: 'h.delivery_date',
      taxdate: 'coalesce(h.po_date, h.transaction_date)',
      cardcode: "erpnext.card('Customer', h.customer)",
      cardname: 'h.customer_name',
      numatcard: 'h.po_no',
      shiptocode: 'h.shipping_address_name',
      comments: 'NULL',
      // a Tierra order (TSO) approved in Tierra before it was posted
      wddstatus: "CASE WHEN h.custom_tierra_ref IS NOT NULL THEN 'A' ELSE '-' END",
    }),
  },
  rdr1: {
    from: `erpnext."tabSales Order Item" l JOIN erpnext."tabSales Order" h ON h.name = l.parent AND h.docstatus IN (1, 2)
           LEFT JOIN LATERAL (SELECT si.parent FROM erpnext."tabSales Invoice Item" si
                              JOIN erpnext."tabSales Invoice" s ON s.name = si.parent AND s.docstatus = 1
                              WHERE si.so_detail = l.name ORDER BY s.posting_date LIMIT 1) inv ON true`,
    cols: {
      docentry: "erpnext.id('Sales Order', h.name)",
      linenum: 'l.idx - 1',
      visorder: 'l.idx - 1',
      objtype: "'17'",
      basetype: '-1',
      targettype: 'CASE WHEN inv.parent IS NOT NULL THEN 13 ELSE -1 END',
      trgetentry: "erpnext.id('Sales Invoice', inv.parent)",
      linestatus:
        "CASE WHEN h.status IN ('Closed', 'Completed') OR h.docstatus = 2 OR l.delivered_qty >= l.qty THEN 'C' ELSE 'O' END",
      itemcode: "nullif(l.item_code, 'SAP-SERVICE')",
      dscription: 'l.item_name',
      quantity: 'l.qty',
      openqty:
        "CASE WHEN h.status IN ('Closed', 'Completed') OR h.docstatus = 2 THEN 0 ELSE greatest(l.qty - l.delivered_qty, 0) END",
      delivrdqty: 'l.delivered_qty',
      unitmsr: 'l.uom',
      numpermsr: '1',
      price: 'l.rate',
      linetotal: 'l.amount',
      vatprcnt: 'erpnext.taxrate(l.item_code)',
      whscode: 'erpnext.whs(l.warehouse)',
      docdate: 'h.transaction_date',
      shipdate: 'l.delivery_date',
    },
  },
  oinv: {
    from: headFrom('tabSales Invoice', " AND coalesce(h.is_opening, 'No') = 'No' AND h.is_return = 0"),
    cols: header('Sales Invoice', {
      objtype: "'13'",
      docstatus: "CASE WHEN h.outstanding_amount <= 0 THEN 'C' ELSE 'O' END",
      docdate: 'h.posting_date',
      docduedate: 'h.due_date',
      taxdate: 'h.posting_date',
      cardcode: "erpnext.card('Customer', h.customer)",
      cardname: 'h.customer_name',
      numatcard: 'h.po_no',
      shiptocode: 'h.shipping_address_name',
      paidtodate: 'h.grand_total - h.outstanding_amount',
      // posting_time is MariaDB TIME, copied as text (HH:MM:SS)
      doctime: "split_part(h.posting_time, ':', 1)::integer * 100 + split_part(h.posting_time, ':', 2)::integer",
    }),
  },
  inv1: {
    from: `erpnext."tabSales Invoice Item" l
           JOIN erpnext."tabSales Invoice" h ON h.name = l.parent AND h.docstatus IN (1, 2)
             AND coalesce(h.is_opening, 'No') = 'No' AND h.is_return = 0
           LEFT JOIN erpnext."tabSales Order Item" so ON so.name = l.so_detail`,
    cols: {
      docentry: "erpnext.id('Sales Invoice', h.name)",
      linenum: 'l.idx - 1',
      visorder: 'l.idx - 1',
      objtype: "'13'",
      basetype: 'CASE WHEN l.sales_order IS NOT NULL THEN 17 ELSE -1 END',
      baseentry: "erpnext.id('Sales Order', l.sales_order)",
      baseline: 'so.idx - 1',
      targettype: '-1',
      linestatus: "'C'",
      itemcode: "nullif(l.item_code, 'SAP-SERVICE')",
      dscription: 'l.item_name',
      quantity: 'l.qty',
      openqty: '0',
      unitmsr: 'l.uom',
      numpermsr: '1',
      price: 'l.rate',
      linetotal: 'l.amount',
      vatprcnt: 'erpnext.taxrate(l.item_code)',
      stockprice: 'l.incoming_rate',
      whscode: 'erpnext.whs(l.warehouse)',
      acctcode: 'erpnext.acct(l.income_account)',
      docdate: 'h.posting_date',
    },
  },
  opor: {
    from: headFrom('tabPurchase Order'),
    cols: header('Purchase Order', {
      objtype: "'22'",
      docstatus: "CASE WHEN h.status IN ('Closed', 'Completed') THEN 'C' ELSE 'O' END",
      docdate: 'h.transaction_date',
      docduedate: 'h.schedule_date',
      taxdate: 'h.transaction_date',
      cardcode: "erpnext.card('Supplier', h.supplier)",
      cardname: 'h.supplier_name',
      numatcard: 'h.custom_numatcard',
      comments: 'NULL',
    }),
  },
  por1: {
    from: `erpnext."tabPurchase Order Item" l JOIN erpnext."tabPurchase Order" h ON h.name = l.parent AND h.docstatus IN (1, 2)`,
    cols: {
      docentry: "erpnext.id('Purchase Order', h.name)",
      linenum: 'l.idx - 1',
      visorder: 'l.idx - 1',
      objtype: "'22'",
      basetype: '-1',
      linestatus:
        "CASE WHEN h.status IN ('Closed', 'Completed') OR h.docstatus = 2 OR l.received_qty >= l.qty THEN 'C' ELSE 'O' END",
      itemcode: "nullif(l.item_code, 'SAP-SERVICE')",
      dscription: 'l.item_name',
      quantity: 'l.qty',
      openqty:
        "CASE WHEN h.status IN ('Closed', 'Completed') OR h.docstatus = 2 THEN 0 ELSE greatest(l.qty - l.received_qty, 0) END",
      unitmsr: 'l.uom',
      price: 'l.rate',
      linetotal: 'l.amount',
      opensum:
        "CASE WHEN h.status IN ('Closed', 'Completed') OR h.docstatus = 2 THEN 0 ELSE greatest(l.qty - l.received_qty, 0) * l.rate END",
      vatprcnt: 'erpnext.taxrate(l.item_code)',
      whscode: 'erpnext.whs(l.warehouse)',
      docdate: 'h.transaction_date',
      shipdate: 'l.schedule_date',
    },
  },
  opdn: {
    from: headFrom('tabPurchase Receipt'),
    cols: header('Purchase Receipt', {
      objtype: "'20'",
      docstatus: "CASE WHEN h.per_billed >= 100 OR h.status IN ('Completed', 'Closed') THEN 'C' ELSE 'O' END",
      docdate: 'h.posting_date',
      docduedate: 'h.posting_date',
      taxdate: 'h.posting_date',
      cardcode: "erpnext.card('Supplier', h.supplier)",
      cardname: 'h.supplier_name',
      numatcard: 'coalesce(h.supplier_delivery_note, h.custom_numatcard)',
      // posting_time is MariaDB TIME, copied as text (HH:MM:SS)
      doctime: "split_part(h.posting_time, ':', 1)::integer * 100 + split_part(h.posting_time, ':', 2)::integer",
    }),
  },
  pdn1: {
    from: `erpnext."tabPurchase Receipt Item" l
           JOIN erpnext."tabPurchase Receipt" h ON h.name = l.parent AND h.docstatus IN (1, 2)
           LEFT JOIN erpnext."tabPurchase Order Item" po ON po.name = l.purchase_order_item`,
    cols: {
      docentry: "erpnext.id('Purchase Receipt', h.name)",
      linenum: 'l.idx - 1',
      visorder: 'l.idx - 1',
      objtype: "'20'",
      basetype: 'CASE WHEN l.purchase_order IS NOT NULL THEN 22 ELSE -1 END',
      baseentry: "erpnext.id('Purchase Order', l.purchase_order)",
      baseline: 'po.idx - 1',
      linestatus: "CASE WHEN coalesce(l.billed_amt, 0) >= l.amount THEN 'C' ELSE 'O' END",
      itemcode: "nullif(l.item_code, 'SAP-SERVICE')",
      dscription: 'l.item_name',
      quantity: 'l.qty',
      openqty: 'CASE WHEN l.amount > 0 THEN l.qty * greatest(1 - coalesce(l.billed_amt, 0) / l.amount, 0) ELSE 0 END',
      unitmsr: 'l.uom',
      price: 'l.rate',
      linetotal: 'l.amount',
      opensum: 'greatest(l.amount - coalesce(l.billed_amt, 0), 0)',
      vatprcnt: 'erpnext.taxrate(l.item_code)',
      whscode: 'erpnext.whs(l.warehouse)',
      docdate: 'h.posting_date',
    },
  },
  opch: {
    from: headFrom('tabPurchase Invoice', " AND coalesce(h.is_opening, 'No') = 'No' AND h.is_return = 0"),
    cols: header('Purchase Invoice', {
      objtype: "'18'",
      docstatus: "CASE WHEN h.outstanding_amount <= 0 THEN 'C' ELSE 'O' END",
      docdate: 'h.posting_date',
      docduedate: 'h.due_date',
      taxdate: 'h.posting_date',
      cardcode: "erpnext.card('Supplier', h.supplier)",
      cardname: 'h.supplier_name',
      numatcard: 'h.bill_no',
      paidtodate: 'h.grand_total - h.outstanding_amount',
    }),
  },
  orct: { from: `erpnext.pay_src s WHERE s.objtype = '24'`, cols: PAY_HEAD },
  ovpm: { from: `erpnext.pay_src s WHERE s.objtype = '46'`, cols: PAY_HEAD },
  rct2: {
    from: `erpnext.pay_doc_lines d WHERE d.objtype = '24'`,
    cols: { docnum: 'd.docnum', docentry: 'd.docentry', sumapplied: 'd.sumapplied', objtype: 'd.doc_objtype' },
  },
  vpm2: {
    from: `erpnext.pay_doc_lines d WHERE d.objtype = '46'`,
    cols: { docnum: 'd.docnum', docentry: 'd.docentry', sumapplied: 'd.sumapplied', objtype: 'd.doc_objtype' },
  },
  rct4: {
    from: `erpnext.pay_acct_lines a WHERE a.objtype = '24'`,
    cols: { docnum: 'a.docnum', lineid: 'a.lineid', acctcode: 'a.acctcode', sumapplied: 'a.sumapplied', acctname: 'a.acctname', objtype: "'24'" },
  },
  vpm4: {
    from: `erpnext.pay_acct_lines a WHERE a.objtype = '46'`,
    cols: { docnum: 'a.docnum', lineid: 'a.lineid', acctcode: 'a.acctcode', sumapplied: 'a.sumapplied', acctname: 'a.acctname', objtype: "'46'" },
  },
  oact: {
    from: `erpnext."tabAccount" a LEFT JOIN erpnext."tabAccount" p ON p.name = a.parent_account`,
    cols: {
      acctcode: 'erpnext.acct(a.name)',
      acctname: 'a.account_name',
      formatcode: 'erpnext.acct(a.name)',
      fathernum: 'erpnext.acct(p.name)',
      postable: "CASE WHEN a.is_group = 1 THEN 'N' ELSE 'Y' END",
      groupmask:
        "CASE a.root_type WHEN 'Asset' THEN 1 WHEN 'Liability' THEN 2 WHEN 'Equity' THEN 3 WHEN 'Income' THEN 4 ELSE 5 END",
      finanse: "CASE WHEN a.account_type IN ('Bank', 'Cash') THEN 'Y' ELSE 'N' END",
      frozenfor: "CASE WHEN a.freeze_account = 'Yes' OR a.disabled = 1 THEN 'Y' ELSE 'N' END",
      createdate: 'a.creation::date',
      updatedate: 'a.modified::date',
    },
  },
  jdt1: {
    from: `erpnext.gl g`,
    cols: {
      transid: 'g.transid',
      line_id: 'g.line_id',
      account: 'g.account',
      shortname: 'g.shortname',
      contraact: 'g.contra',
      debit: 'g.debit',
      credit: 'g.credit',
      refdate: 'g.posting_date',
      duedate: 'g.due_date',
      transtype: 'g.transtype',
      createdby: 'g.createdby',
      baseref: 'g.voucher_no',
      ref1: 'g.voucher_no',
      linememo: 'g.remarks',
    },
  },
  ojdt: {
    from: `(SELECT transid, transtype, voucher_no, createdby, min(posting_date) AS refdate, max(due_date) AS duedate,
                   max(remarks) AS memo, sum(debit) AS total, min(creation) AS created
            FROM erpnext.gl GROUP BY transid, transtype, voucher_no, createdby) o`,
    cols: {
      transid: 'o.transid',
      transtype: 'o.transtype',
      baseref: 'o.voucher_no',
      createdby: 'o.createdby',
      refdate: 'o.refdate',
      duedate: 'o.duedate',
      memo: 'o.memo',
      ref1: 'o.voucher_no',
      loctotal: 'o.total',
      number: 'o.transid',
      createdate: 'o.created::date',
      createtime: "(extract(hour FROM o.created) * 100 + extract(minute FROM o.created))::integer",
    },
  },
  nnm1: {
    from: `erpnext.series s`,
    cols: { series: 's.series', seriesname: 's.seriesname' },
  },
}

/** {table: [[column, type], ...]} from the generated SAP DDL. */
export function sapTables(ddl = readFileSync(SAP_SCHEMA_FILE, 'utf8')): Map<string, Array<[string, string]>> {
  const tables = new Map<string, Array<[string, string]>>()
  for (const m of ddl.matchAll(/CREATE TABLE sap\.(\w+) \(([\s\S]*?)\);/g)) {
    const cols: Array<[string, string]> = []
    for (const part of m[2].split(/,\s*\n|\n/)) {
      const c = /^\s*"?([a-z0-9_]+)"? ([a-z]+(?:\(\d+,\d+\))?)/i.exec(part)
      if (c && !/^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)$/i.test(c[1])) cols.push([c[1], c[2]])
    }
    // the one-line table: key text PRIMARY KEY, value text NOT NULL
    if (m[1] === '_import') cols.splice(0, cols.length, ['key', 'text'], ['value', 'text'])
    tables.set(m[1], cols)
  }
  return tables
}

/** The CREATE VIEW for one SAP table: every DDL column, mapped or NULL, cast to the DDL type. */
export function compatView(table: string, cols: Array<[string, string]>, spec: Spec | undefined): string {
  for (const key of Object.keys(spec?.cols ?? {})) {
    if (!cols.some(([c]) => c === key)) throw new Error(`compat sap.${table}: SAP has no column ${key}`)
  }
  const select = cols
    .map(([c, type]) => {
      const expr = spec?.cols[c]
      return `${expr ? `(${expr})` : 'NULL'}::${type} AS "${c}"`
    })
    .join(',\n  ')
  return `CREATE VIEW sap."${table}" AS SELECT\n  ${select}\nFROM ${spec ? spec.from : '(SELECT 1) empty WHERE false'};`
}

/**
 * Rebuilds the read model over the mirror in one transaction: helpers in erpnext, sap as compat views, then the erp
 * views from tools/sap-import/sql/erp (and empty att / hr schemas when the database has none).
 */
export async function applyCompat(sql: SapSql): Promise<void> {
  const tables = sapTables()
  const erpFiles = readdirSync(ERP_SQL_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  await sql.begin(async (tx) => {
    // the drops below cascade over ~120 objects; their NOTICEs are noise
    await tx.unsafe(`set local client_min_messages = warning`)
    await tx.unsafe(`drop schema if exists erp cascade; drop schema if exists sap cascade;`)
    for (const fn of ['id', 'card', 'whs', 'acct', 'docnum', 'series_name', 'hhmmss', 'taxrate', 'transtype']) {
      await tx.unsafe(`drop function if exists erpnext.${fn} cascade`)
    }
    for (const view of ['series', 'gl', 'pay_doc_lines', 'pay_acct_lines', 'pay_src', 'doc_vat']) {
      await tx.unsafe(`drop view if exists erpnext.${view} cascade`)
    }
    await tx.unsafe(HELPERS)
    await tx.unsafe(`create schema sap`)
    for (const [table, cols] of tables) await tx.unsafe(compatView(table, cols, COMPAT[table]))
    const [{ has_att }] = await tx`select to_regnamespace('att') is not null as has_att`
    if (!has_att) await tx.unsafe(readFileSync(ATT_SQL_FILE, 'utf8'))
    const [{ has_hr }] = await tx`select to_regnamespace('hr') is not null as has_hr`
    if (!has_hr) await tx.unsafe(readFileSync(HR_SQL_FILE, 'utf8').replaceAll('{s}', 'hr'))
    await tx.unsafe(`create schema erp`)
    for (const file of erpFiles) await tx.unsafe(readFileSync(join(ERP_SQL_DIR, file), 'utf8'))
  })
}
