"""Import the SAP backup (already typed in Postgres schema `sap`) into ERPNext through the REST API.

Order: masters -> openings (party ledgers and bank balances before the window) -> the import window (SO, PO, then
GRNs and A/R invoices in date order, A/P invoices, payments) -> closing SAP-closed orders -> one stock
reconciliation on the cut-over date so stock equals SAP's OITW -> SAP's batches and their movements as SAP Batch
records (the find_batch tool). Every record carries custom_sap_ref; a record
ERPNext already has is never made again, so a re-run continues where the last one stopped.
"""
import json
import os
import threading
import traceback
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from erp import Erp, ErpError
from setup_site import BATCH_DOCTYPE, batch_doctypes

SAP_PG = os.environ.get("SAP_PG", "postgres://tierra:tierra@localhost:5432/tierra")
COMPANY = os.environ.get("ERP_COMPANY", "Tierra Food India")
ABBR = os.environ.get("ERP_COMPANY_ABBR", "TFI")
CUTOVER = date.fromisoformat(os.environ.get("IMPORT_CUTOVER", "2026-10-07"))
WINDOW_START = date.fromisoformat(os.environ.get("IMPORT_WINDOW_START", "2026-07-08"))
VAR = Path(__file__).resolve().parents[2] / "var" / "erpnext-import"
ERRORS = VAR / "import-errors.jsonl"

SERVICE_ITEM = "SAP-SERVICE"
OPENING_ITEM = "SAP-OPENING"
DEBTORS = f"Debtors - {ABBR}"
CREDITORS = f"Creditors - {ABBR}"
TEMP_OPENING = f"Temporary Opening - {ABBR}"
OUTPUT_GST = f"Output GST - {ABBR}"
INPUT_GST = f"Input GST - {ABBR}"
ROUND_OFF = f"Round Off - {ABBR}"
COST_CENTER = f"Main - {ABBR}"

STEPS = ["uoms", "item_groups", "warehouses", "items", "party_groups", "parties", "addresses", "boms",
         "accounts", "openings", "sales_orders", "purchase_orders", "stock_docs", "ap_invoices", "payments",
         "close_orders", "stock_reco", "batches"]

# SAP free-text units -> ERPNext UOM names (the raw text stays on the item as custom_sap_uom)
UOM_MAP = {"kg": "Kg", "kgs": "Kg", "nos": "Nos", "no": "Nos", "pcs": "Pcs", "pc": "Pcs", "ltr": "Litre",
           "l": "Litre", "litre": "Litre", "kwh": "Kilowatt-Hour", "kl": "KL", "ucg": "UCG", "ucn": "UCN"}

_lock = threading.Lock()
_account_lock = threading.Lock()
_err_lock = threading.Lock()


def log(msg):
    print(msg, flush=True)


def uom_of(raw):
    key = (raw or "").strip(" .").lower()
    return UOM_MAP.get(key, key.title() if key else "Nos")


def num(x):
    return float(x) if x is not None else 0.0


def ts(d, hhmmss):
    """SAP date + CreateTS (HHMMSS) -> 'YYYY-MM-DD HH:MM:SS'."""
    if d is None:
        return None
    t = int(hhmmss or 0)
    return f"{d.isoformat()} {t // 10000:02d}:{t // 100 % 100:02d}:{t % 100:02d}"


def hhmm(doctime):
    t = int(doctime or 0)
    return f"{min(t // 100, 23):02d}:{t % 100:02d}:00"


def record_error(step, ref, err):
    VAR.mkdir(parents=True, exist_ok=True)
    with _err_lock, ERRORS.open("a") as f:
        f.write(json.dumps({"at": datetime.now().isoformat(timespec="seconds"), "step": step, "ref": ref,
                            "error": str(err)[:2000]}) + "\n")


class Ctx:
    def __init__(self, workers):
        self.erp = Erp()
        self.pg = psycopg.connect(SAP_PG, row_factory=dict_row)
        self.workers = workers
        self.refs = {}       # doctype -> {sap_ref: name}
        self.known_lock = threading.RLock()
        self.lines = {}      # sap_ref -> [child name by SAP LineNum]
        self.accounts = {}   # SAP AcctCode -> ERPNext account name
        self.series = {r["series"]: r["seriesname"] for r in self.q("SELECT series, seriesname FROM sap.nnm1")}

    def q(self, sql, *args):
        with self.pg.cursor() as cur:
            cur.execute(sql, args or None)
            return cur.fetchall()

    def known(self, doctype):
        """{custom_sap_ref: name} for a doctype, read once per run."""
        with self.known_lock:
            if doctype not in self.refs:
                rows = self.erp.get_list(doctype, filters=[["custom_sap_ref", "is", "set"]],
                                         fields=["name", "custom_sap_ref"])
                self.refs[doctype] = {r["custom_sap_ref"]: r["name"] for r in rows}
            return self.refs[doctype]

    def ref(self, doctype, sap_ref):
        return self.known(doctype).get(sap_ref)

    def insert(self, step, sap_ref, doc, keep_lines=None):
        """Insert unless ERPNext has the sap_ref; returns the name or None (error logged)."""
        doctype = doc["doctype"]
        have = self.known(doctype)
        if sap_ref in have:
            return have[sap_ref]
        doc["custom_sap_ref"] = sap_ref
        try:
            out = self.erp.insert(doc)
        except ErpError as e:
            record_error(step, sap_ref, e)
            return None
        with _lock:
            have[sap_ref] = out["name"]
            if keep_lines is not None:
                self.lines[sap_ref] = dict(zip(keep_lines, [i["name"] for i in sorted(out["items"], key=lambda i: i["idx"])]))
        return out["name"]

    def child(self, doctype, sap_ref, linenum):
        """ERPNext child-row name of an imported document's SAP line (None when not imported)."""
        if sap_ref not in self.lines:
            name = self.ref(doctype, sap_ref)
            if not name:
                return None
            doc = self.erp.get_doc(doctype, name)
            # lines were sent in LineNum order; custom_sap_line is not stored, so rebuild from the source order
            linenums = self.doc_linenums(sap_ref)
            with _lock:
                self.lines[sap_ref] = dict(zip(linenums, [i["name"] for i in sorted(doc["items"], key=lambda i: i["idx"])]))
        return self.lines[sap_ref].get(linenum)

    def doc_linenums(self, sap_ref):
        table, entry = sap_ref.split(":")
        lines = {"ORDR": "rdr1", "OPOR": "por1", "OPDN": "pdn1", "OINV": "inv1"}[table]
        return [r["linenum"] for r in self.q(
            f"SELECT linenum FROM sap.{lines} WHERE docentry = %s AND quantity > 0 ORDER BY linenum", int(entry))]

    def parallel(self, step, items, fn):
        done = errors = 0
        with ThreadPoolExecutor(self.workers) as ex:
            futs = [ex.submit(fn, it) for it in items]
            for f in as_completed(futs):
                try:
                    if f.result() is None:
                        errors += 1
                    else:
                        done += 1
                except Exception as e:  # noqa: BLE001 - keep going, log the record
                    errors += 1
                    record_error(step, "?", f"{e}\n{traceback.format_exc()[-800:]}")
        log(f"  {step}: {done} ok, {errors} failed (of {len(items)})")

    def doc_fields(self, h, table):
        """The custom fields every imported transaction carries."""
        return {
            "custom_sap_docnum": h["docnum"],
            "custom_sap_series_name": self.series.get(h.get("series")),
            "custom_sap_created": ts(h.get("createdate"), h.get("createts")),
            "custom_numatcard": (h.get("numatcard") or "").strip() or None,
            "company": COMPANY,
        }


# --------------------------------------------------------------------------- masters

def step_uoms(c):
    raw = {r["u"] for r in c.q("SELECT DISTINCT invntryuom AS u FROM sap.oitm")}
    raw |= {r["u"] for r in c.q("SELECT DISTINCT unitmsr AS u FROM sap.rdr1 UNION SELECT DISTINCT unitmsr FROM sap.inv1")}
    names = {uom_of(u) for u in raw}
    have = {u["name"].lower(): u for u in c.erp.get_list("UOM", fields=["name", "must_be_whole_number"])}
    for n in sorted(names):
        if n.lower() not in have:
            c.erp.insert({"doctype": "UOM", "uom_name": n, "must_be_whole_number": 0})
        elif have[n.lower()]["must_be_whole_number"]:
            c.erp.update("UOM", have[n.lower()]["name"], {"must_be_whole_number": 0})
    log(f"  uoms: {sorted(names)}")


def step_item_groups(c):
    have = {g["name"]: g for g in c.erp.get_list("Item Group", fields=["name", "custom_sap_group_code"])}
    for g in c.q("SELECT itmsgrpcod, itmsgrpnam FROM sap.oitb ORDER BY itmsgrpcod"):
        if c.ref("Item Group", str(g["itmsgrpcod"])):
            continue
        name = g["itmsgrpnam"].strip()
        if name in have:
            name = f"{name} ({g['itmsgrpcod']})"
        c.insert("item_groups", str(g["itmsgrpcod"]), {
            "doctype": "Item Group", "item_group_name": name, "parent_item_group": "All Item Groups",
            "custom_sap_group_code": g["itmsgrpcod"]})
    log(f"  item groups: {len(c.known('Item Group'))}")


def step_warehouses(c):
    for w in c.q("SELECT whscode, whsname FROM sap.owhs ORDER BY whscode"):
        c.insert("warehouses", w["whscode"], {"doctype": "Warehouse", "warehouse_name": w["whsname"].strip(),
                                              "parent_warehouse": f"All Warehouses - {ABBR}", "company": COMPANY})
    log(f"  warehouses: {c.known('Warehouse')}")


def whs(c, code):
    return c.ref("Warehouse", code) or c.ref("Warehouse", "01")


def step_items(c):
    groups = c.known("Item Group")
    rows = c.q("""SELECT i.*, h.chapter FROM sap.oitm i LEFT JOIN sap.ochp h ON h.absentry = i.chapterid
                  ORDER BY i.itemcode""")

    def one(i):
        doc = {
            "doctype": "Item", "item_code": i["itemcode"], "item_name": (i["itemname"] or i["itemcode"])[:140],
            "description": i["itemname"] or i["itemcode"],
            "item_group": groups.get(str(i["itmsgrpcod"]), "All Item Groups"),
            "stock_uom": uom_of(i["invntryuom"]),
            "is_stock_item": 1 if i["invntitem"] == "Y" else 0,
            "is_purchase_item": 1 if i["prchseitem"] == "Y" else 0,
            "is_sales_item": 1 if i["sellitem"] == "Y" else 0,
            "include_item_in_manufacturing": 1,
            "item_defaults": [{"company": COMPANY, "default_warehouse": whs(c, i["dfltwh"])}] if i["dfltwh"] else [],
            "custom_npu": num(i.get("u_npu")),
            "custom_itmctg": i.get("u_itmctg"),
            "custom_taxrate": i.get("u_taxrate"),
            "custom_hsn": (i.get("chapter") or "").strip() or None,
            "custom_sap_uom": i["invntryuom"],
            "custom_batch_managed": 1 if i["manbtchnum"] == "Y" else 0,
            "custom_frozen": 1 if i["frozenfor"] == "Y" else 0,
            "custom_evalsystem": i["evalsystem"],
        }
        return c.insert("items", i["itemcode"], doc)

    c.parallel("items", rows, one)
    for code, name, group in [(SERVICE_ITEM, "Service (SAP document without an item)", "Services"),
                              (OPENING_ITEM, "Opening balance", "Services")]:
        c.insert("items", code, {"doctype": "Item", "item_code": code, "item_name": name, "item_group": group,
                                 "stock_uom": "Nos", "is_stock_item": 0, "is_purchase_item": 1, "is_sales_item": 1})


def step_party_groups(c):
    for g in c.q("SELECT groupcode, groupname, grouptype FROM sap.ocrg ORDER BY groupcode"):
        if g["grouptype"] == "C":
            c.insert("party_groups", str(g["groupcode"]), {
                "doctype": "Customer Group", "customer_group_name": g["groupname"],
                "parent_customer_group": "All Customer Groups", "custom_sap_group_code": g["groupcode"]})
        else:
            c.insert("party_groups", str(g["groupcode"]), {
                "doctype": "Supplier Group", "supplier_group_name": g["groupname"],
                "parent_supplier_group": "All Supplier Groups", "custom_sap_group_code": g["groupcode"]})


def step_parties(c):
    cgroups, sgroups = c.known("Customer Group"), c.known("Supplier Group")
    rows = c.q("SELECT * FROM sap.ocrd WHERE cardtype IN ('C', 'S') ORDER BY cardcode")

    def one(p):
        common = {
            "custom_phone1": p["phone1"], "custom_cellular": p["cellular"], "custom_email": p["e_mail"],
            "custom_city": p["city"], "custom_state": p["state1"], "custom_zipcode": p["zipcode"],
            "custom_billtodef": p["billtodef"], "custom_shiptodef": p["shiptodef"],
            "custom_frozen": 1 if p["frozenfor"] == "Y" else 0,
            "custom_sap_created": p["createdate"].isoformat() if p["createdate"] else None,
        }
        if p["cardtype"] == "C":
            return c.insert("parties", p["cardcode"], {
                "doctype": "Customer", "customer_name": p["cardname"], "customer_type": "Company",
                "customer_group": cgroups.get(str(p["groupcode"]), "All Customer Groups"),
                "territory": "All Territories", **common})
        return c.insert("parties", p["cardcode"], {
            "doctype": "Supplier", "supplier_name": p["cardname"], "supplier_type": "Company",
            "supplier_group": sgroups.get(str(p["groupcode"]), "All Supplier Groups"), **common})

    c.parallel("parties", rows, one)


def party(c, cardcode):
    """(party_type, name) of a SAP card."""
    n = c.ref("Customer", cardcode)
    if n:
        return "Customer", n
    n = c.ref("Supplier", cardcode)
    return ("Supplier", n) if n else (None, None)


def step_addresses(c):
    rows = c.q("""SELECT a.*, c.cardname, c.cardtype FROM sap.crd1 a JOIN sap.ocrd c ON c.cardcode = a.cardcode
                  WHERE c.cardtype IN ('C', 'S') ORDER BY a.cardcode, a.adrestype, a.linenum""")

    def one(a):
        ptype, pname = party(c, a["cardcode"])
        if not pname:
            record_error("addresses", a["cardcode"], "party not imported")
            return None
        line1 = ", ".join(x.strip() for x in [a["building"], a["street"], a["block"]] if x and x.strip()) or a["address"] or "-"
        return c.insert("addresses", f"{a['cardcode']}|{a['adrestype']}|{a['address']}", {
            "doctype": "Address", "address_title": a["cardname"][:140],
            "address_type": "Billing" if a["adrestype"] == "B" else "Shipping",
            "address_line1": line1[:240],
            "address_line2": ", ".join(x.strip() for x in [a["address2"], a["address3"]] if x and x.strip())[:240] or None,
            "city": (a["city"] or "-").strip() or "-", "state": a["state"], "pincode": a["zipcode"], "country": "India",
            "links": [{"link_doctype": ptype, "link_name": pname}],
            "custom_sap_address_name": a["address"], "custom_gstin": a["gstregnno"],
            "custom_street": a["street"], "custom_block": a["block"], "custom_building": a["building"],
            "custom_address2": a["address2"], "custom_address3": a["address3"], "custom_linenum": a["linenum"],
        })

    c.parallel("addresses", rows, one)


def step_boms(c):
    items = c.known("Item")
    heads = c.q("SELECT code, qauntity, treetype FROM sap.oitt ORDER BY code")
    lines = defaultdict(list)
    for l in c.q("SELECT * FROM sap.itt1 ORDER BY father, childnum"):
        lines[l["father"]].append(l)

    def one(h):
        rows = [{"item_code": l["code"], "qty": num(l["quantity"]), "rate": num(l["price"]),
                 "source_warehouse": whs(c, l["warehouse"]) if l["warehouse"] else None}
                for l in lines[h["code"]] if l["code"] in items and l["code"] != h["code"] and num(l["quantity"]) > 0]
        if h["code"] not in items or not rows:
            record_error("boms", h["code"], "no item or no usable lines")
            return None
        return c.insert("boms", h["code"], {
            "doctype": "BOM", "item": h["code"], "quantity": num(h["qauntity"]) or 1, "company": COMPANY,
            "is_active": 1, "is_default": 1, "rm_cost_as_per": "Valuation Rate", "allow_same_item_multiple_times": 1,
            "items": rows, "docstatus": 1})

    c.parallel("boms", heads, one)


# --------------------------------------------------------------------------- accounts

GROUP_ROOT = {1: "Asset", 2: "Liability", 3: "Equity", 4: "Income"}


def sap_account(c, acctcode):
    """The ERPNext account for a SAP GL code, made on first use (bank/cash under Bank Accounts / Cash In Hand)."""
    if not acctcode:
        return None
    with _account_lock:
        return _sap_account(c, acctcode)


def _sap_account(c, acctcode):
    if acctcode in c.accounts:
        return c.accounts[acctcode]
    name = c.ref("Account", acctcode)
    if not name:
        rows = c.q("SELECT a.*, p.acctname AS parent_name FROM sap.oact a LEFT JOIN sap.oact p ON p.acctcode = a.fathernum "
                   "WHERE a.acctcode = %s", acctcode)
        if not rows:
            return None
        a = rows[0]
        if a["finanse"] == "Y":
            bank = "bank" in (a["acctname"] or "").lower() or "bank" in (a["parent_name"] or "").lower()
            parent = f"Bank Accounts - {ABBR}" if bank else f"Cash In Hand - {ABBR}"
            extra = {"account_type": "Bank" if bank else "Cash"}
        else:
            parent = f"SAP {GROUP_ROOT.get(a['groupmask'], 'Expense')} Accounts - {ABBR}"
            extra = {}
        name = c.insert("accounts", acctcode, {
            "doctype": "Account", "account_name": (a["acctname"] or acctcode)[:120], "account_number": acctcode,
            "parent_account": parent, "company": COMPANY, **extra})
    if name:
        c.accounts[acctcode] = name
    return name


def step_accounts(c):
    for a in c.q("SELECT acctcode FROM sap.oact WHERE finanse = 'Y' AND postable = 'Y' ORDER BY acctcode"):
        sap_account(c, a["acctcode"])
    log(f"  bank/cash accounts: {len(c.accounts)}")


# --------------------------------------------------------------------------- openings

def step_openings(c):
    """Party ledgers and bank balances before the window, from SAP's journal (JDT1), like erp.ar_ap_ageing:
    a card's balance is made of its newest documents that raised it; each becomes an opening invoice on its own
    date. An advance (balance in the party's favour) becomes one opening journal entry."""
    before = WINDOW_START - timedelta(days=1)
    lines = c.q("""
      SELECT c.cardcode, c.cardtype, j.transid, j.line_id, j.refdate, coalesce(j.duedate, j.refdate) AS duedate,
             (j.debit - j.credit) * CASE WHEN c.cardtype = 'S' THEN -1 ELSE 1 END AS amt
      FROM sap.jdt1 j JOIN sap.ocrd c ON c.cardcode = j.shortname AND c.cardtype IN ('C', 'S')
      WHERE j.refdate < %s
      ORDER BY c.cardcode, j.refdate DESC, j.transid DESC, j.line_id DESC""", WINDOW_START)
    by_card = defaultdict(list)
    for l in lines:
        by_card[(l["cardcode"], l["cardtype"])].append(l)
    jobs = []
    for (card, ctype), ls in by_card.items():
        balance = sum(num(l["amt"]) for l in ls)
        if balance >= 1:
            left = balance
            for l in ls:
                if num(l["amt"]) <= 0:
                    continue
                part = min(num(l["amt"]), left)
                jobs.append(("invoice", card, ctype, l, round(part, 2)))
                left -= part
                if left < 0.005:
                    break
        elif balance <= -1:
            jobs.append(("advance", card, ctype, None, round(-balance, 2)))

    def one(job):
        kind, card, ctype, l, amount = job
        ptype, pname = party(c, card)
        if not pname:
            return None
        if kind == "invoice":
            ref = f"OPEN:{card}:{l['transid']}:{l['line_id']}"
            post = l["refdate"].isoformat()
            due = max(l["duedate"], l["refdate"]).isoformat()
            if ctype == "C":
                return c.insert("openings", ref, {
                    "doctype": "Sales Invoice", "customer": pname, "is_opening": "Yes", "posting_date": post,
                    "set_posting_time": 1, "due_date": due, "company": COMPANY, "disable_rounded_total": 1,
                    "items": [{"item_code": OPENING_ITEM, "qty": 1, "rate": amount, "income_account": TEMP_OPENING,
                               "cost_center": COST_CENTER}],
                    "custom_numatcard": f"SAP journal {l['transid']}", "docstatus": 1})
            return c.insert("openings", ref, {
                "doctype": "Purchase Invoice", "supplier": pname, "is_opening": "Yes", "posting_date": post,
                "set_posting_time": 1, "due_date": due, "bill_date": post, "company": COMPANY, "disable_rounded_total": 1,
                "items": [{"item_code": OPENING_ITEM, "qty": 1, "rate": amount, "expense_account": TEMP_OPENING,
                           "cost_center": COST_CENTER}],
                "custom_numatcard": f"SAP journal {l['transid']}", "docstatus": 1})
        # advance: customer credit / supplier debit against Temporary Opening
        acct = DEBTORS if ptype == "Customer" else CREDITORS
        party_side = {"account": acct, "party_type": ptype, "party": pname}
        if ptype == "Customer":
            party_side["credit_in_account_currency"] = amount
            other = {"account": TEMP_OPENING, "debit_in_account_currency": amount, "cost_center": COST_CENTER}
        else:
            party_side["debit_in_account_currency"] = amount
            other = {"account": TEMP_OPENING, "credit_in_account_currency": amount, "cost_center": COST_CENTER}
        return c.insert("openings", f"OPEN:{card}:advance", {
            "doctype": "Journal Entry", "voucher_type": "Opening Entry", "is_opening": "Yes",
            "posting_date": before.isoformat(), "company": COMPANY, "accounts": [party_side, other],
            "user_remark": "SAP balance in the party's favour before the import window", "docstatus": 1})

    log(f"  party openings: {len(jobs)} documents for {len(by_card)} cards")
    c.parallel("openings", jobs, one)

    banks = c.q("""SELECT j.account, sum(j.debit - j.credit) AS bal FROM sap.jdt1 j
                   JOIN sap.oact a ON a.acctcode = j.account AND a.finanse = 'Y'
                   WHERE j.refdate < %s GROUP BY j.account HAVING abs(sum(j.debit - j.credit)) >= 0.01""", WINDOW_START)
    rows, total = [], 0.0
    for b in banks:
        acct = sap_account(c, b["account"])
        bal = round(num(b["bal"]), 2)
        total += bal
        rows.append({"account": acct, "debit_in_account_currency": bal} if bal > 0
                    else {"account": acct, "credit_in_account_currency": -bal})
    if rows:
        rows.append({"account": TEMP_OPENING, "cost_center": COST_CENTER,
                     **({"credit_in_account_currency": round(total, 2)} if total > 0
                        else {"debit_in_account_currency": round(-total, 2)})})
        c.insert("openings", "OPEN:banks", {
            "doctype": "Journal Entry", "voucher_type": "Opening Entry", "is_opening": "Yes",
            "posting_date": before.isoformat(), "company": COMPANY, "accounts": rows,
            "user_remark": "SAP bank and cash balances before the import window", "docstatus": 1})
    log(f"  bank openings: {len(rows) - 1 if rows else 0} accounts")


# --------------------------------------------------------------------------- the import window

def window_docs(c, head, lines):
    heads = c.q(f"SELECT * FROM sap.{head} WHERE canceled = 'N' AND docdate BETWEEN %s AND %s "
                f"ORDER BY docdate, doctime, docentry", WINDOW_START, CUTOVER)
    ls = defaultdict(list)
    for l in c.q(f"SELECT l.* FROM sap.{lines} l JOIN sap.{head} h ON h.docentry = l.docentry "
                 f"WHERE h.canceled = 'N' AND h.docdate BETWEEN %s AND %s AND l.quantity > 0 "
                 f"ORDER BY l.docentry, l.linenum", WINDOW_START, CUTOVER):
        ls[l["docentry"]].append(l)
    return heads, ls


def item_row(c, l, *, warehouse=True, account=None):
    items = c.known("Item")
    code = l["itemcode"] if l["itemcode"] in items else SERVICE_ITEM
    qty = num(l["quantity"]) * (num(l.get("numpermsr")) or 1)
    row = {"item_code": code, "qty": qty, "rate": round(num(l["linetotal"]) / qty, 6) if qty else 0,
           "description": l["dscription"] or code, "conversion_factor": 1, "cost_center": COST_CENTER}
    if code == SERVICE_ITEM:
        row["item_name"] = (l["dscription"] or "Service")[:140]
    if warehouse and code != SERVICE_ITEM:
        row["warehouse"] = whs(c, l["whscode"])
    if account and code == SERVICE_ITEM and l.get("acctcode"):
        row[account] = sap_account(c, l["acctcode"])
    return row


def taxes(h, rows, account, kind):
    """One Actual tax row with SAP's VatSum, plus a Round Off row so the total equals SAP's DocTotal."""
    net = sum(r["qty"] * r["rate"] for r in rows)
    vat = round(num(h["vatsum"]), 2)
    diff = round(num(h["doctotal"]) - net - vat, 2)
    out = []
    if vat:
        out.append({"charge_type": "Actual", "account_head": account, "description": "GST (from SAP)",
                    "tax_amount": vat, "cost_center": COST_CENTER, **kind})
    if abs(diff) >= 0.01:
        out.append({"charge_type": "Actual", "account_head": ROUND_OFF, "description": "Discount, freight, rounding (SAP)",
                    "tax_amount": diff, "cost_center": COST_CENTER, **kind})
    return out


def step_sales_orders(c):
    heads, lines = window_docs(c, "ordr", "rdr1")

    def one(h):
        ptype, cust = party(c, h["cardcode"])
        ls = lines[h["docentry"]]
        if ptype != "Customer" or not ls:
            record_error("sales_orders", f"ORDR:{h['docentry']}", "no customer or no lines")
            return None
        due = max(h["docduedate"] or h["docdate"], h["docdate"]).isoformat()
        rows = []
        for l in ls:
            r = item_row(c, l)
            r["delivery_date"] = max(l["shipdate"] or h["docduedate"] or h["docdate"], h["docdate"]).isoformat()
            rows.append(r)
        doc = {"doctype": "Sales Order", "customer": cust, "transaction_date": h["docdate"].isoformat(),
               "delivery_date": due, "po_no": (h["numatcard"] or "").strip() or None,
               "po_date": h["taxdate"].isoformat() if h["taxdate"] else None, "disable_rounded_total": 1,
               "items": rows, "taxes": taxes(h, rows, OUTPUT_GST, {}), "remarks": h["comments"],
               **c.doc_fields(h, "ordr"), "docstatus": 1}
        return c.insert("sales_orders", f"ORDR:{h['docentry']}", doc, keep_lines=[l["linenum"] for l in ls])

    c.parallel("sales_orders", heads, one)


def step_purchase_orders(c):
    heads, lines = window_docs(c, "opor", "por1")

    def one(h):
        ptype, sup = party(c, h["cardcode"])
        ls = lines[h["docentry"]]
        if ptype != "Supplier" or not ls:
            record_error("purchase_orders", f"OPOR:{h['docentry']}", "no supplier or no lines")
            return None
        rows = []
        for l in ls:
            r = item_row(c, l)
            r["schedule_date"] = max(l["shipdate"] or h["docduedate"] or h["docdate"], h["docdate"]).isoformat()
            rows.append(r)
        doc = {"doctype": "Purchase Order", "supplier": sup, "transaction_date": h["docdate"].isoformat(),
               "schedule_date": max(h["docduedate"] or h["docdate"], h["docdate"]).isoformat(),
               "disable_rounded_total": 1, "items": rows,
               "taxes": taxes(h, rows, INPUT_GST, {"category": "Total", "add_deduct_tax": "Add"}),
               "remarks": h["comments"], **c.doc_fields(h, "opor"), "docstatus": 1}
        return c.insert("purchase_orders", f"OPOR:{h['docentry']}", doc, keep_lines=[l["linenum"] for l in ls])

    c.parallel("purchase_orders", heads, one)


def grn_doc(c, h, ls, link=True):
    ptype, sup = party(c, h["cardcode"])
    if ptype != "Supplier":
        return None
    rows = []
    for l in ls:
        r = item_row(c, l)
        if num(l["linetotal"]) == 0:
            r["allow_zero_valuation_rate"] = 1
        if link and l["basetype"] == 22 and l["baseentry"]:
            po_ref = f"OPOR:{l['baseentry']}"
            po = c.ref("Purchase Order", po_ref)
            detail = po and c.child("Purchase Order", po_ref, l["baseline"])
            if detail:
                r["purchase_order"], r["purchase_order_item"] = po, detail
        rows.append(r)
    return {"doctype": "Purchase Receipt", "supplier": sup, "posting_date": h["docdate"].isoformat(),
            "posting_time": hhmm(h["doctime"]), "set_posting_time": 1, "disable_rounded_total": 1,
            "supplier_delivery_note": (h["numatcard"] or "").strip()[:140] or None, "items": rows,
            "taxes": taxes(h, rows, INPUT_GST, {"category": "Total", "add_deduct_tax": "Add"}),
            "remarks": h["comments"], **c.doc_fields(h, "opdn"), "docstatus": 1}


def invoice_doc(c, h, ls, link=True):
    ptype, cust = party(c, h["cardcode"])
    if ptype != "Customer":
        return None
    rows = []
    for l in ls:
        r = item_row(c, l)
        r["allow_zero_valuation_rate"] = 1
        if link and l["basetype"] == 17 and l["baseentry"]:
            so_ref = f"ORDR:{l['baseentry']}"
            so = c.ref("Sales Order", so_ref)
            detail = so and c.child("Sales Order", so_ref, l["baseline"])
            if detail:
                r["sales_order"], r["so_detail"] = so, detail
        rows.append(r)
    return {"doctype": "Sales Invoice", "customer": cust, "posting_date": h["docdate"].isoformat(),
            "posting_time": hhmm(h["doctime"]), "set_posting_time": 1,
            "due_date": max(h["docduedate"] or h["docdate"], h["docdate"]).isoformat(), "update_stock": 1,
            "po_no": (h["numatcard"] or "").strip() or None, "disable_rounded_total": 1, "items": rows,
            "taxes": taxes(h, rows, OUTPUT_GST, {}), "remarks": h["comments"], **c.doc_fields(h, "oinv"),
            "docstatus": 1}


def step_stock_docs(c):
    """GRNs and A/R invoices move stock: one queue in SAP posting order, one at a time (a backdated stock entry
    would make ERPNext repost every later one)."""
    grns, grn_lines = window_docs(c, "opdn", "pdn1")
    invs, inv_lines = window_docs(c, "oinv", "inv1")
    queue = [("OPDN", h, grn_lines[h["docentry"]]) for h in grns] + [("OINV", h, inv_lines[h["docentry"]]) for h in invs]
    queue.sort(key=lambda x: (x[1]["docdate"], int(x[1]["doctime"] or 0), x[0], x[1]["docentry"]))
    ok = failed = 0
    for i, (table, h, ls) in enumerate(queue):
        ref = f"{table}:{h['docentry']}"
        doctype = "Purchase Receipt" if table == "OPDN" else "Sales Invoice"
        if c.ref(doctype, ref):
            ok += 1
            continue
        build = grn_doc if table == "OPDN" else invoice_doc
        doc = build(c, h, ls) if ls else None
        if doc is None:
            record_error("stock_docs", ref, "no party or no lines")
            failed += 1
            continue
        try:
            out = c.erp.insert({**doc, "custom_sap_ref": ref})
        except ErpError as e:
            # a link to an order line ERPNext will not accept (over-billing, a closed order): post without links
            try:
                out = c.erp.insert({**build(c, h, ls, link=False), "custom_sap_ref": ref})
                record_error("stock_docs", ref, f"posted without order links: {e}")
            except ErpError as e2:
                record_error("stock_docs", ref, e2)
                failed += 1
                continue
        c.known(doctype)[ref] = out["name"]
        c.lines[ref] = dict(zip([l["linenum"] for l in ls], [x["name"] for x in sorted(out["items"], key=lambda x: x["idx"])]))
        ok += 1
        if (i + 1) % 50 == 0:
            log(f"    stock docs {i + 1}/{len(queue)}")
    log(f"  stock_docs: {ok} ok, {failed} failed (of {len(queue)})")


def step_ap_invoices(c):
    heads, lines = window_docs(c, "opch", "pch1")
    # service invoices (DocType S) have lines without an item and possibly quantity 0 in SAP: take every line
    svc = defaultdict(list)
    for l in c.q("SELECT l.* FROM sap.pch1 l JOIN sap.opch h ON h.docentry = l.docentry WHERE h.canceled = 'N' "
                 "AND h.doctype = 'S' AND h.docdate BETWEEN %s AND %s ORDER BY l.docentry, l.linenum",
                 WINDOW_START, CUTOVER):
        svc[l["docentry"]].append({**l, "quantity": l["quantity"] if num(l["quantity"]) > 0 else 1, "itemcode": None})

    def one(h):
        doc = build(h, link=True)
        if doc is None:
            return None
        ref = f"OPCH:{h['docentry']}"
        if c.ref("Purchase Invoice", ref):
            return c.ref("Purchase Invoice", ref)
        try:
            out = c.erp.insert({**doc, "custom_sap_ref": ref})
        except ErpError as e:
            # a GRN link ERPNext will not accept (rate differs from the receipt): post without links
            try:
                out = c.erp.insert({**build(h, link=False), "custom_sap_ref": ref})
                record_error("ap_invoices", ref, f"posted without receipt links: {e}")
            except ErpError as e2:
                record_error("ap_invoices", ref, e2)
                return None
        with _lock:
            c.known("Purchase Invoice")[ref] = out["name"]
        return out["name"]

    def build(h, link):
        ptype, sup = party(c, h["cardcode"])
        ls = svc[h["docentry"]] if h["doctype"] == "S" else lines[h["docentry"]]
        if ptype != "Supplier" or not ls:
            record_error("ap_invoices", f"OPCH:{h['docentry']}", "no supplier or no lines")
            return None
        rows = []
        for l in ls:
            r = item_row(c, l, warehouse=False, account="expense_account")
            if link and l["basetype"] == 20 and l["baseentry"]:
                pr_ref = f"OPDN:{l['baseentry']}"
                pr = c.ref("Purchase Receipt", pr_ref)
                detail = pr and c.child("Purchase Receipt", pr_ref, l["baseline"])
                if detail:
                    r["purchase_receipt"], r["pr_detail"] = pr, detail
            rows.append(r)
        post = h["docdate"].isoformat()
        doc = {"doctype": "Purchase Invoice", "supplier": sup, "posting_date": post, "set_posting_time": 1,
               "bill_no": (h["numatcard"] or "").strip()[:140] or None, "bill_date": post,
               "due_date": max(h["docduedate"] or h["docdate"], h["docdate"]).isoformat(), "update_stock": 0,
               "disable_rounded_total": 1, "items": rows,
               "taxes": taxes(h, rows, INPUT_GST, {"category": "Total", "add_deduct_tax": "Add"}),
               "remarks": h["comments"], **c.doc_fields(h, "opch"), "docstatus": 1}
        return doc

    c.parallel("ap_invoices", heads, one)


def step_payments(c):
    rows = []
    for table, lines_table in (("orct", "rct4"), ("ovpm", "vpm4")):
        acct_lines = defaultdict(list)
        for l in c.q(f"SELECT docnum, acctcode, sumapplied FROM sap.{lines_table} ORDER BY docnum, lineid"):
            acct_lines[l["docnum"]].append(l)
        for h in c.q(f"SELECT * FROM sap.{table} WHERE canceled = 'N' AND docdate BETWEEN %s AND %s "
                     f"ORDER BY docdate, docentry", WINDOW_START, CUTOVER):
            rows.append((table, h, acct_lines.get(h["docentry"], [])))

    def one(job):
        table, h, alines = job
        ref = f"{table.upper()}:{h['docentry']}"
        incoming = table == "orct"
        amount = round(num(h["doctotal"]), 2)
        bank = sap_account(c, h["trsfracct"] if num(h["trsfrsum"]) else None) or sap_account(c, h["cashacct"]) \
            or sap_account(c, h["trsfracct"])
        if amount <= 0 or not bank:
            record_error("payments", ref, "no amount or no bank account")
            return None
        fields = {"posting_date": h["docdate"].isoformat(), "company": COMPANY,
                  "custom_sap_docnum": h["docnum"], "custom_sap_series_name": c.series.get(h["series"]),
                  "custom_sap_created": ts(h["createdate"], h["createts"]),
                  "custom_numatcard": (h["trsfrref"] or "").strip() or None}
        memo = (h["comments"] or h["jrnlmemo"] or "").strip() or None
        if h["doctype"] in ("C", "S"):
            ptype, pname = party(c, h["cardcode"])
            if not pname:
                record_error("payments", ref, "no party")
                return None
            ledger = DEBTORS if ptype == "Customer" else CREDITORS
            return c.insert("payments", ref, {
                "doctype": "Payment Entry", "payment_type": "Receive" if incoming else "Pay",
                "party_type": ptype, "party": pname,
                "paid_from": ledger if incoming else bank, "paid_to": bank if incoming else ledger,
                "paid_amount": amount, "received_amount": amount,
                "reference_no": (h["trsfrref"] or "").strip()[:140] or f"SAP {table.upper()} {h['docnum']}",
                "reference_date": h["docdate"].isoformat(), "remarks": memo, **fields, "docstatus": 1})
        # account payment: bank against the GL lines (RCT4/VPM4), else against the card code (a GL code here)
        targets = [(sap_account(c, l["acctcode"]), round(num(l["sumapplied"]), 2)) for l in alines if l["acctcode"]]
        if not targets:
            targets = [(sap_account(c, h["cardcode"]), amount)]
        targets = [(a, v) for a, v in targets if a and v]
        if not targets:
            record_error("payments", ref, "no GL account for the account payment")
            return None
        diff = round(amount - sum(v for _, v in targets), 2)
        if diff:
            targets[0] = (targets[0][0], round(targets[0][1] + diff, 2))
        side_bank = "debit_in_account_currency" if incoming else "credit_in_account_currency"
        side_other = "credit_in_account_currency" if incoming else "debit_in_account_currency"
        accounts = [{"account": bank, side_bank: amount}] + [
            {"account": a, side_other: v, "cost_center": COST_CENTER} if v > 0
            else {"account": a, side_bank: -v, "cost_center": COST_CENTER} for a, v in targets]
        return c.insert("payments", ref, {
            "doctype": "Journal Entry", "voucher_type": "Journal Entry", "cheque_no": (h["trsfrref"] or "").strip()[:140] or None,
            "cheque_date": h["docdate"].isoformat() if (h["trsfrref"] or "").strip() else None,
            "accounts": accounts, "user_remark": memo, **fields, "docstatus": 1})

    c.parallel("payments", rows, one)


def step_close_orders(c):
    """Close the window's orders SAP shows closed (DocStatus C) that ERPNext still has open."""
    for table, doctype, method in (("ordr", "Sales Order", "erpnext.selling.doctype.sales_order.sales_order.update_status"),
                                   ("opor", "Purchase Order", "erpnext.buying.doctype.purchase_order.purchase_order.update_status")):
        closed = {f"{table.upper()}:{r['docentry']}" for r in c.q(
            f"SELECT docentry FROM sap.{table} WHERE canceled = 'N' AND docstatus = 'C' AND docdate BETWEEN %s AND %s",
            WINDOW_START, CUTOVER)}
        rows = [r for r in c.erp.get_list(doctype, filters=[["docstatus", "=", 1], ["status", "not in", ["Closed", "Completed"]]],
                                          fields=["name", "custom_sap_ref"]) if r["custom_sap_ref"] in closed]
        n = 0
        for r in rows:
            try:
                c.erp.call(method, status="Closed", name=r["name"])
                n += 1
            except ErpError as e:
                record_error("close_orders", r["name"], e)
        log(f"  closed {n} {doctype}s")


def step_stock_reco(c):
    """One reconciliation at the end of the cut-over day: every item/warehouse to SAP's OnHand (and value)."""
    ref = f"OITW:{CUTOVER.isoformat()}"
    if c.ref("Stock Reconciliation", ref):
        log("  stock reconciliation exists")
        return
    stock_items = {i["name"] for i in c.erp.get_list("Item", filters=[["is_stock_item", "=", 1]], fields=["name"])}
    sap = {(r["itemcode"], r["whscode"]): r for r in c.q("SELECT * FROM sap.oitw WHERE onhand <> 0")}
    whs_by_name = {v: k for k, v in c.known("Warehouse").items()}
    bins = {(b["item_code"], whs_by_name.get(b["warehouse"])): b for b in c.erp.get_list(
        "Bin", filters=[["actual_qty", "!=", 0]], fields=["item_code", "warehouse", "actual_qty", "valuation_rate"])}
    rows = []
    for key in sorted(set(sap) | set(bins), key=lambda k: (k[0], k[1] or "")):
        item, w = key
        if item not in stock_items or not w:
            continue
        s = sap.get(key)
        qty = num(s["onhand"]) if s else 0.0
        if s and qty > 0:
            rate = num(s["stockvalue"]) / qty if num(s["stockvalue"]) else num(s["avgprice"])
        else:
            rate = num(bins[key]["valuation_rate"]) if key in bins else 0.0
        if key in bins and abs(num(bins[key]["actual_qty"]) - qty) < 1e-9 and not s:
            continue
        rows.append({"item_code": item, "warehouse": c.ref("Warehouse", w), "qty": max(qty, 0),
                     "valuation_rate": round(max(rate, 0), 6), "allow_zero_valuation_rate": 1 if rate <= 0 else 0})
    log(f"  stock reconciliation: {len(rows)} rows")
    c.insert("stock_reco", ref, {
        "doctype": "Stock Reconciliation", "purpose": "Stock Reconciliation", "company": COMPANY,
        "posting_date": CUTOVER.isoformat(), "posting_time": "23:59:00", "set_posting_time": 1,
        "expense_account": f"Stock Adjustment - {ABBR}", "cost_center": COST_CENTER, "items": rows, "docstatus": 1})


def _iso(d):
    return d.isoformat() if d else None


def step_batches(c):
    """SAP's batches with their movements, as SAP Batch records (one per OBTN row). Read from the erp batch views
    (tools/sap-import/sql/erp/14_batches.sql): rebuild them with `tools/sap-import/run.py erp` first."""
    batch_doctypes(c.erp)
    moves = defaultdict(list)
    for m in c.q("SELECT * FROM erp.batch_movements ORDER BY batch_id, doc_date, log_entry"):
        moves[m["batch_id"]].append(m)
    rows = c.q("SELECT * FROM erp.batches ORDER BY batch_id")

    def one(b):
        return c.insert("batches", f"OBTN:{b['batch_id']}", {
            "doctype": BATCH_DOCTYPE, "batch_no": b["batch_no"], "item_code": b["item_code"],
            "item_name": b["item_name"], "in_date": _iso(b["in_date"]), "mnf_date": _iso(b["mnf_date"]),
            "exp_date": _iso(b["exp_date"]), "qty_in": num(b["qty_in"]), "qty_out": num(b["qty_out"]),
            "on_hand": num(b["on_hand"]), "warehouses": b["warehouses"],
            "movements": [{
                "log_entry": m["log_entry"], "kind": m["kind"], "doc_no": m["doc_no"], "doc_date": _iso(m["doc_date"]),
                "party_code": m["party_code"], "party_name": m["party_name"], "whs_code": m["whs_code"],
                "qty": num(m["qty"]), "production_order": m["production_order"],
                "production_entry": m["production_entry"],
            } for m in moves.get(b["batch_id"], [])],
        })

    log(f"  batches: {len(rows)} with {sum(len(v) for v in moves.values())} movements")
    c.parallel("batches", rows, one)

def run(only=None, workers=4):
    c = Ctx(workers)
    steps = only or STEPS
    for s in steps:
        if s not in STEPS:
            raise SystemExit(f"unknown step {s}; steps: {', '.join(STEPS)}")
    log(f"import window {WINDOW_START} .. {CUTOVER}; errors -> {ERRORS}")
    for s in STEPS:
        if s in steps:
            started = datetime.now()
            log(f"[{s}]")
            globals()[f"step_{s}"](c)
            log(f"  ({(datetime.now() - started).seconds}s)")
