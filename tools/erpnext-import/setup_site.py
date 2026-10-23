"""One-time ERPNext setup for the hackathon build: company, fiscal years, settings, custom fields, accounts, the
service user and the read-only MariaDB user. Every step is safe to run again."""
import os
import secrets
import subprocess
from pathlib import Path

from erp import Erp, ErpError

COMPANY = os.environ.get("ERP_COMPANY", "Tierra Food India")
ABBR = os.environ.get("ERP_COMPANY_ABBR", "TFI")
ADMIN_PASSWORD = os.environ.get("ERPNEXT_ADMIN_PASSWORD", "tierra-local-admin")
MARIADB_ROOT_PASSWORD = os.environ.get("MARIADB_ROOT_PASSWORD", "tierra-local-root")
SERVICE_USER = "tierra-service@tierra.local"
ENV_FILE = Path(os.environ.get("ERPNEXT_ENV_FILE", Path.home() / "tierra-data" / "erpnext.local.env"))
COMPOSE = Path(__file__).resolve().parents[2] / "erpnext" / "compose.yml"

# SAP's journal starts 2024-03-31 (FY 2023-24); fiscal years run April to March.
FISCAL_YEARS = [(y, f"{y}-04-01", f"{y + 1}-03-31") for y in range(2023, 2027)]

SERVICE_ROLES = ["Sales Manager", "Sales User", "Sales Master Manager", "Purchase Manager", "Purchase User",
                 "Purchase Master Manager", "Stock Manager", "Stock User", "Accounts Manager", "Accounts User",
                 "Item Manager", "Manufacturing Manager", "System Manager"]

TXN_DOCTYPES = ["Sales Order", "Sales Invoice", "Purchase Order", "Purchase Receipt", "Purchase Invoice",
                "Payment Entry", "Journal Entry", "Stock Reconciliation"]

# (doctype, fieldname, fieldtype, label, insert_after)
CUSTOM_FIELDS = (
    [(dt, "custom_sap_ref", "Data", "SAP Ref", None) for dt in
     ["Item", "Item Group", "Warehouse", "Customer", "Supplier", "Customer Group", "Supplier Group", "Address",
      "BOM", "Account"] + TXN_DOCTYPES]
    + [(dt, "custom_sap_docnum", "Int", "SAP Doc Num", "custom_sap_ref") for dt in TXN_DOCTYPES]
    + [(dt, "custom_sap_series_name", "Data", "SAP Series", "custom_sap_docnum") for dt in TXN_DOCTYPES]
    + [(dt, "custom_sap_created", "Datetime", "SAP Created At", "custom_sap_series_name") for dt in TXN_DOCTYPES]
    + [(dt, "custom_numatcard", "Data", "Party Reference", "custom_sap_created") for dt in TXN_DOCTYPES]
    + [(dt, "custom_tierra_user", "Data", "Tierra User", "custom_numatcard") for dt in TXN_DOCTYPES]
    + [("Sales Order", "custom_tierra_ref", "Data", "Tierra Order Ref", "custom_tierra_user")]
    + [(dt, "custom_sap_group_code", "Int", "SAP Group Code", "custom_sap_ref")
       for dt in ["Item Group", "Customer Group", "Supplier Group"]]
    + [("Item", f, t, l, "custom_sap_ref") for f, t, l in [
        ("custom_npu", "Float", "Pieces per Carton"),
        ("custom_itmctg", "Data", "SAP Item Category"),
        ("custom_taxrate", "Data", "GST Rate"),
        ("custom_hsn", "Data", "HSN Code"),
        ("custom_sap_uom", "Data", "SAP Unit"),
        ("custom_batch_managed", "Check", "Batch Managed in SAP"),
        ("custom_frozen", "Check", "Frozen in SAP"),
        ("custom_evalsystem", "Data", "SAP Valuation Method"),
    ]]
    + [(dt, f, t, l, "custom_sap_ref") for dt in ["Customer", "Supplier"] for f, t, l in [
        ("custom_phone1", "Data", "Phone"),
        ("custom_cellular", "Data", "Mobile"),
        ("custom_email", "Data", "Email"),
        ("custom_city", "Data", "City"),
        ("custom_state", "Data", "State"),
        ("custom_zipcode", "Data", "Zip Code"),
        ("custom_billtodef", "Data", "Default Bill-to"),
        ("custom_shiptodef", "Data", "Default Ship-to"),
        ("custom_frozen", "Check", "Frozen in SAP"),
        ("custom_sap_created", "Date", "SAP Created On"),
    ]]
    + [("Address", f, t, l, "custom_sap_ref") for f, t, l in [
        ("custom_sap_address_name", "Data", "SAP Address Name"),
        ("custom_gstin", "Data", "GSTIN"),
        ("custom_street", "Data", "Street"),
        ("custom_block", "Data", "Block"),
        ("custom_building", "Data", "Building"),
        ("custom_address2", "Data", "Address 2"),
        ("custom_address3", "Data", "Address 3"),
        ("custom_linenum", "Int", "SAP Line"),
    ]]
)


BATCH_DOCTYPE = "SAP Batch"
BATCH_MOVEMENT_DOCTYPE = "SAP Batch Movement"

# SAP's batches as a record of their own: ERPNext's Batch needs batch tracking on the item, which ERPNext refuses
# to switch on for items that already have stock transactions, and would then ask for a batch on every delivery.
# (fieldname, fieldtype, label, options, in_list_view)
BATCH_MOVEMENT_FIELDS = [
    ("log_entry", "Int", "SAP Log Entry", None, 0),
    ("kind", "Data", "Movement", None, 1),
    ("doc_no", "Data", "Document", None, 1),
    ("doc_date", "Date", "Date", None, 1),
    ("party_code", "Data", "Party Code", None, 0),
    ("party_name", "Data", "Party", None, 1),
    ("whs_code", "Data", "Warehouse", None, 0),
    ("qty", "Float", "Quantity", None, 1),
    ("production_order", "Data", "Production Order", None, 0),
    ("production_entry", "Int", "Production Order Entry", None, 0),
]
BATCH_FIELDS = [
    ("batch_no", "Data", "Batch No", None, 1),
    ("item_code", "Link", "Item", "Item", 1),
    ("item_name", "Data", "Item Name", None, 0),
    ("in_date", "Date", "Received On", None, 1),
    ("mnf_date", "Date", "Manufactured On", None, 0),
    ("exp_date", "Date", "Expires On", None, 0),
    ("qty_in", "Float", "Quantity In", None, 0),
    ("qty_out", "Float", "Quantity Out", None, 0),
    ("on_hand", "Float", "On Hand at Cut-over", None, 1),
    ("warehouses", "Small Text", "Stock by Warehouse", None, 0),
    ("custom_sap_ref", "Data", "SAP Ref", None, 0),
    ("movements", "Table", "Movements", BATCH_MOVEMENT_DOCTYPE, 0),
]


def log(msg):
    print(msg, flush=True)


def admin():
    erp = Erp(api_key="", api_secret="")
    erp.login("Administrator", ADMIN_PASSWORD)
    return erp


def setup_wizard(erp):
    done = erp.get_list("Company", fields=["name"])
    if any(c["name"] == COMPANY for c in done):
        log(f"company {COMPANY} exists")
        return
    log("running the setup wizard ...")
    erp.call("frappe.desk.page.setup_wizard.setup_wizard.setup_complete", args={
        "language": "English", "country": "India", "timezone": "Asia/Kolkata", "currency": "INR",
        "company_name": COMPANY, "company_abbr": ABBR, "chart_of_accounts": "Standard",
        "fy_start_date": "2026-04-01", "fy_end_date": "2027-03-31", "setup_demo": 0,
    })
    log("setup wizard done")


def fiscal_years(erp):
    have = {r["name"] for r in erp.get_list("Fiscal Year", fields=["name"])}
    have_dates = {r["year_start_date"] for r in erp.get_list("Fiscal Year", fields=["year_start_date"])}
    for y, start, end in FISCAL_YEARS:
        name = f"{y}-{y + 1}"
        if name in have or start in have_dates:
            continue
        erp.insert({"doctype": "Fiscal Year", "year": name, "year_start_date": start, "year_end_date": end,
                    "companies": [{"company": COMPANY}]})
        log(f"fiscal year {name}")


def settings(erp):
    erp.set_single("Stock Settings", {
        "allow_negative_stock": 1, "valuation_method": "Moving Average", "over_delivery_receipt_allowance": 100,
        "allow_to_edit_stock_uom_qty_for_sales": 1, "allow_to_edit_stock_uom_qty_for_purchase": 1,
        "auto_insert_price_list_rate_if_missing": 0,
    })
    erp.set_single("Accounts Settings", {"over_billing_allowance": 100})
    erp.set_single("Selling Settings", {"cust_master_name": "Naming Series", "so_required": "No", "dn_required": "No",
                                        "allow_multiple_items": 1, "allow_against_multiple_purchase_orders": 1})
    erp.set_single("Buying Settings", {"supp_master_name": "Naming Series", "po_required": "No", "pr_required": "No",
                                       "allow_multiple_items": 1})
    # quantities are fractional (kg, litres, and SAP keys pieces with decimals too)
    for u in erp.get_list("UOM", filters=[["must_be_whole_number", "=", 1]], fields=["name"]):
        erp.update("UOM", u["name"], {"must_be_whole_number": 0})
    log("settings done")


def custom_fields(erp):
    have = {(r["dt"], r["fieldname"]) for r in erp.get_list("Custom Field", fields=["dt", "fieldname"])}
    for dt, fieldname, fieldtype, label, after in CUSTOM_FIELDS:
        if (dt, fieldname) in have:
            continue
        doc = {"doctype": "Custom Field", "dt": dt, "fieldname": fieldname, "label": label, "fieldtype": fieldtype,
               "read_only": 1 if fieldname in ("custom_sap_ref", "custom_tierra_user", "custom_tierra_ref") else 0,
               "no_copy": 1 if fieldname in ("custom_sap_ref", "custom_tierra_ref") else 0,
               "search_index": 1 if fieldname in ("custom_sap_ref", "custom_tierra_ref") else 0}
        if after:
            doc["insert_after"] = after
        erp.insert(doc)
        have.add((dt, fieldname))
    log(f"custom fields: {len(CUSTOM_FIELDS)}")


def _doctype_fields(fields):
    out = []
    for fieldname, fieldtype, label, options, in_list in fields:
        f = {"fieldname": fieldname, "fieldtype": fieldtype, "label": label, "in_list_view": in_list,
             "read_only": 1 if fieldtype != "Table" else 0}
        if options:
            f["options"] = options
        if fieldname in ("batch_no", "custom_sap_ref", "item_code"):
            f["search_index"] = 1
            f["in_standard_filter"] = 1 if fieldname != "custom_sap_ref" else 0
        out.append(f)
    return out


def batch_doctypes(erp):
    """The SAP Batch record and its movement rows (custom DocTypes, no developer mode needed). Safe to run again.
    Needs System Manager: the service user has it, so the importer calls this too."""
    if not erp.exists("DocType", BATCH_MOVEMENT_DOCTYPE):
        erp.insert({"doctype": "DocType", "name": BATCH_MOVEMENT_DOCTYPE, "module": "Stock", "custom": 1,
                    "istable": 1, "editable_grid": 0, "fields": _doctype_fields(BATCH_MOVEMENT_FIELDS)})
        log(f"doctype {BATCH_MOVEMENT_DOCTYPE}")
    if not erp.exists("DocType", BATCH_DOCTYPE):
        erp.insert({"doctype": "DocType", "name": BATCH_DOCTYPE, "module": "Stock", "custom": 1,
                    "autoname": "hash", "title_field": "batch_no", "show_title_field_in_link": 1,
                    "search_fields": "batch_no,item_code,item_name", "sort_field": "in_date", "sort_order": "DESC",
                    "fields": _doctype_fields(BATCH_FIELDS),
                    "permissions": [
                        {"role": "System Manager", "read": 1, "write": 1, "create": 1, "delete": 1},
                        {"role": "Stock Manager", "read": 1, "write": 1, "create": 1},
                        {"role": "Stock User", "read": 1},
                    ]})
        log(f"doctype {BATCH_DOCTYPE}")


def account(erp, name, parent, **kw):
    full = f"{name} - {ABBR}"
    if not erp.exists("Account", full):
        erp.insert({"doctype": "Account", "account_name": name, "parent_account": parent, "company": COMPANY, **kw})
    return full


def accounts(erp):
    taxes = erp.get_value("Account", [["account_name", "=", "Duties and Taxes"], ["company", "=", COMPANY]])
    account(erp, "Output GST", taxes, account_type="Tax")
    account(erp, "Input GST", taxes, account_type="Tax")
    # groups for the SAP GL accounts that payments post to (by SAP GroupMask)
    roots = {r["root_type"]: r["name"] for r in erp.get_list(
        "Account", filters=[["company", "=", COMPANY], ["is_group", "=", 1], ["parent_account", "in", ["", None]]],
        fields=["name", "root_type"])}
    if not roots:
        roots = {r["root_type"]: r["name"] for r in erp.get_list(
            "Account", filters=[["company", "=", COMPANY], ["is_group", "=", 1], ["lft", "=", 1]],
            fields=["name", "root_type"])}
    for root_type, parent in roots.items():
        account(erp, f"SAP {root_type} Accounts", parent, is_group=1)
    log(f"accounts done ({', '.join(roots)})")


def service_user(erp):
    if not erp.exists("User", SERVICE_USER):
        erp.insert({"doctype": "User", "email": SERVICE_USER, "first_name": "Tierra", "last_name": "Service",
                    "user_type": "System User", "send_welcome_email": 0})
    user = erp.get_doc("User", SERVICE_USER)
    have = {r["role"] for r in user.get("roles", [])}
    if not set(SERVICE_ROLES) <= have:
        erp.update("User", SERVICE_USER, {"roles": [{"role": r} for r in sorted(have | set(SERVICE_ROLES))]})
    env = read_env()
    if env.get("ERPNEXT_API_KEY") and env.get("ERPNEXT_API_SECRET"):
        log(f"service user keys already in {ENV_FILE}")
        return env
    secret = erp.call("frappe.core.doctype.user.user.generate_keys", user=SERVICE_USER)["api_secret"]
    key = erp.get_doc("User", SERVICE_USER)["api_key"]
    env.update({"ERPNEXT_API_KEY": key, "ERPNEXT_API_SECRET": secret})
    write_env(env)
    log(f"service user keys written to {ENV_FILE}")
    return env


def compose(*args, stdin=None):
    return subprocess.run(["docker", "compose", "-f", str(COMPOSE), *args], input=stdin, text=True,
                          capture_output=True, check=True).stdout


def readonly_db_user():
    env = read_env()
    site_db = compose("exec", "-T", "backend", "sh", "-c",
                      "cd sites && python3 -c \"import json;print(json.load(open('"
                      + os.environ.get("ERPNEXT_SITE", "erp.localhost") + "/site_config.json'))['db_name'])\"").strip()
    password = env.get("ERP_DB_PASSWORD") or secrets.token_urlsafe(18)
    sql = (f"CREATE USER IF NOT EXISTS 'tierra_ro'@'%' IDENTIFIED BY '{password}';\n"
           f"ALTER USER 'tierra_ro'@'%' IDENTIFIED BY '{password}';\n"
           f"GRANT SELECT ON `{site_db}`.* TO 'tierra_ro'@'%';\nFLUSH PRIVILEGES;\n")
    compose("exec", "-T", "db", "mariadb", "-uroot", f"-p{MARIADB_ROOT_PASSWORD}", stdin=sql)
    env.update({"ERP_SITE_DB": site_db, "ERP_DB_PASSWORD": password,
                "ERP_DB_URL": f"mysql://tierra_ro:{password}@127.0.0.1:3307/{site_db}"})
    write_env(env)
    log(f"read-only MariaDB user tierra_ro on {site_db}")


def read_env():
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'")
    return env


def write_env(env):
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    base = {"ERPNEXT_URL": os.environ.get("ERPNEXT_URL", "http://127.0.0.1:8080"),
            "ERPNEXT_SITE": os.environ.get("ERPNEXT_SITE", "erp.localhost"),
            "ERP_COMPANY": COMPANY, "ERP_COMPANY_ABBR": ABBR}
    merged = {**base, **env}
    ENV_FILE.write_text("# ERPNext keys for the local hackathon build. Never commit.\n"
                        + "".join(f"{k}='{v}'\n" for k, v in merged.items()))
    ENV_FILE.chmod(0o600)


def run():
    erp = admin()
    setup_wizard(erp)
    erp = admin()
    fiscal_years(erp)
    settings(erp)
    custom_fields(erp)
    batch_doctypes(erp)
    accounts(erp)
    service_user(erp)
    if os.environ.get("ERPNEXT_SKIP_DB_USER") == "1":
        # a hosted ERPNext (Railway): its MariaDB is private; the read-only user is made from inside the network
        log("skipped the read-only MariaDB user (ERPNEXT_SKIP_DB_USER=1)")
    else:
        readonly_db_user()
    log("setup complete")
