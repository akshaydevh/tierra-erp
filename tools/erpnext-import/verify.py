"""Compare ERPNext with the SAP backup: document counts in the window, monthly A/R invoice totals, stock on hand."""
from collections import defaultdict

import psycopg
from psycopg.rows import dict_row

from erp import Erp
from importer import CUTOVER, SAP_PG, WINDOW_START


def log(msg):
    print(msg, flush=True)


def run():
    erp = Erp()
    pg = psycopg.connect(SAP_PG, row_factory=dict_row)
    q = lambda sql, *a: pg.execute(sql, a or None).fetchall()  # noqa: E731
    failed = 0

    log("counts (SAP window, not cancelled -> ERPNext submitted with custom_sap_ref)")
    for table, doctype, prefix in [("ordr", "Sales Order", "ORDR"), ("opor", "Purchase Order", "OPOR"),
                                   ("opdn", "Purchase Receipt", "OPDN"), ("oinv", "Sales Invoice", "OINV"),
                                   ("opch", "Purchase Invoice", "OPCH")]:
        sap = q(f"SELECT count(*) AS n FROM sap.{table} WHERE canceled = 'N' AND docdate BETWEEN %s AND %s",
                WINDOW_START, CUTOVER)[0]["n"]
        got = len(erp.get_list(doctype, filters=[["docstatus", "=", 1], ["custom_sap_ref", "like", f"{prefix}:%"]],
                               fields=["name"]))
        ok = got >= sap * 0.98
        failed += not ok
        log(f"  {'ok  ' if ok else 'FAIL'} {doctype:18} SAP {sap:5}  ERPNext {got:5}")
    sap_pay = q("SELECT (SELECT count(*) FROM sap.orct WHERE canceled = 'N' AND docdate BETWEEN %s AND %s) + "
                "(SELECT count(*) FROM sap.ovpm WHERE canceled = 'N' AND docdate BETWEEN %s AND %s) AS n",
                WINDOW_START, CUTOVER, WINDOW_START, CUTOVER)[0]["n"]
    got_pay = sum(len(erp.get_list(dt, filters=[["docstatus", "=", 1], ["custom_sap_ref", "like", f"{p}:%"]], fields=["name"]))
                  for dt in ("Payment Entry", "Journal Entry") for p in ("ORCT", "OVPM"))
    ok = got_pay >= sap_pay * 0.98
    failed += not ok
    log(f"  {'ok  ' if ok else 'FAIL'} {'Payments':18} SAP {sap_pay:5}  ERPNext {got_pay:5}")

    log("A/R invoice totals by month")
    sap = {r["m"]: float(r["t"]) for r in q(
        "SELECT to_char(docdate, 'YYYY-MM') AS m, sum(doctotal) AS t FROM sap.oinv WHERE canceled = 'N' "
        "AND docdate BETWEEN %s AND %s GROUP BY 1", WINDOW_START, CUTOVER)}
    got = defaultdict(float)
    for r in erp.get_list("Sales Invoice", filters=[["docstatus", "=", 1], ["custom_sap_ref", "like", "OINV:%"]],
                          fields=["posting_date", "grand_total"]):
        got[r["posting_date"][:7]] += float(r["grand_total"])
    for m in sorted(sap):
        ok = abs(sap[m] - got[m]) <= 1.0 * 400
        failed += not ok
        log(f"  {'ok  ' if ok else 'FAIL'} {m}  SAP {sap[m]:16,.2f}  ERPNext {got[m]:16,.2f}")

    log("stock on hand after the cut-over reconciliation")
    whs = {w["name"]: w["custom_sap_ref"] for w in erp.get_list("Warehouse", fields=["name", "custom_sap_ref"])}
    got = {(b["item_code"], whs.get(b["warehouse"])): float(b["actual_qty"])
           for b in erp.get_list("Bin", fields=["item_code", "warehouse", "actual_qty"])}
    stock_items = {i["name"] for i in erp.get_list("Item", filters=[["is_stock_item", "=", 1]], fields=["name"])}
    bad = 0
    rows = q("SELECT itemcode, whscode, onhand FROM sap.oitw WHERE onhand <> 0")
    for r in rows:
        if r["itemcode"] in stock_items and abs(got.get((r["itemcode"], r["whscode"]), 0.0) - float(r["onhand"])) > 1e-6:
            bad += 1
    failed += bad > 0
    log(f"  {'ok  ' if not bad else 'FAIL'} {len(rows) - bad} of {len(rows)} item/warehouse quantities agree")
    log("all hard gates pass" if not failed else f"{failed} gate(s) failed")
    return 1 if failed else 0
