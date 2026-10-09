#!/usr/bin/env python3
"""Load a SAP B1 parquet backup into Postgres (schemas `sap` and `erp`).

  python -I run.py sap    --backup DIR --pg URL [--no-swap]   load, gate, swap in
  python -I run.py verify --pg URL                             re-run the gates on sap / erp
  python -I run.py ddl    --out FILE [--backup DIR]            write the sap DDL (no data)
  python -I run.py erp    --pg URL                             rebuild the erp views over the loaded sap
  python -I run.py attachments --dir DIR [--dir DIR2] --pg URL --store fs:<dir>|s3
                                                               link + upload SAP attachment files (schema att)
  python -I run.py hr     --dir DIR --pg URL [--joins FILE]    load the HR spreadsheets (schema hr)

See README.md.
"""
import argparse
import collections
import csv
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import importlib.util

import duckdb
import psycopg
import yaml

HERE = Path(__file__).resolve().parent
TABLES_YAML = HERE / "tables.yaml"
ERP_SQL_DIR = HERE / "sql" / "erp"
ATT_SQL = HERE / "sql" / "att.sql"
DATA_DIR = Path.home() / "tierra-data"
# default backup: SAP_BACKUP, else the newest ~/tierra-data/sap_backup_* folder
DEFAULT_BACKUP = os.environ.get("SAP_BACKUP") or str(max(DATA_DIR.glob("sap_backup_*"), default=DATA_DIR / "sap_backup"))
DEFAULT_GATES = os.environ.get("SAP_GATES", str(DATA_DIR / "gates.local.yaml"))
DEFAULT_PG = os.environ.get("SAP_PG", "postgres://tierra:tierra@localhost:5432/tierra")
DEFAULT_HR_JOINS = os.environ.get("HR_JOINS", str(DATA_DIR / "hr-joins.yaml"))

INT_TYPES = {"INTEGER": "integer", "SMALLINT": "smallint", "TINYINT": "smallint", "BIGINT": "bigint"}
TEXT_TYPES = {"NVARCHAR", "VARCHAR", "NCLOB", "CLOB", "TEXT", "CHAR", "NCHAR", "ALPHANUM", "SHORTTEXT"}
DATE_TYPES = {"TIMESTAMP", "SECONDDATE", "DATE"}


class ImportError_(Exception):
    pass


def log(msg):
    print(msg, flush=True)


# --------------------------------------------------------------------------- configuration

def pg_table(sap_name):
    return sap_name.lstrip("@").lower()


def qi(name):
    """Quote a Postgres identifier."""
    return '"' + name.replace('"', '""') + '"'


def load_config():
    with open(TABLES_YAML, encoding="utf-8") as f:
        return yaml.safe_load(f)["tables"]


def load_metadata(backup):
    """{TABLE_NAME: [(COLUMN_NAME, DATA_TYPE_NAME, SCALE), ...]} in column order."""
    path = Path(backup) / "metadata" / "table_columns.csv.gz"
    meta = {}
    with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        head = next(reader)
        ti, ci, di, si, pi = (head.index(h) for h in ("TABLE_NAME", "COLUMN_NAME", "DATA_TYPE_NAME", "SCALE", "POSITION"))
        for row in reader:
            meta.setdefault(row[ti], []).append((int(row[pi]), row[ci], row[di], None if row[si] == "\\N" else row[si]))
    return {t: [(c, d, s) for _, c, d, s in sorted(cols)] for t, cols in meta.items()}


def pg_type(sap_type, scale, override):
    if override:
        return override
    if sap_type in INT_TYPES:
        return INT_TYPES[sap_type]
    if sap_type == "DECIMAL":
        return "numeric(19,6)" if scale == "6" else "numeric"
    if sap_type in ("DOUBLE", "REAL"):
        return "double precision"
    if sap_type in DATE_TYPES:
        return "date"
    if sap_type in TEXT_TYPES:
        return "text"
    raise ImportError_(f"no Postgres type for SAP type {sap_type}")


def resolve_tables(config, meta):
    """Per table: list of (sap_col, pg_col, pg_type)."""
    out = {}
    for table, spec in config.items():
        if table not in meta:
            raise ImportError_(f"{table}: not in metadata/table_columns.csv.gz")
        known = {c: (d, s) for c, d, s in meta[table]}
        overrides = spec.get("types") or {}
        if spec["columns"] == "*":
            exclude = set(spec.get("exclude") or [])
            wanted = [c for c, d, _ in meta[table] if c not in exclude and d not in ("BLOB", "VARBINARY")]
        else:
            wanted = list(spec["columns"])
            missing = [c for c in wanted if c not in known]
            if missing:
                raise ImportError_(f"{table}: unknown columns {missing}")
        cols, seen = [], set()
        for c in wanted:
            name = c.lower()
            if name in seen:
                raise ImportError_(f"{table}: column {c} collides with another column when lower-cased")
            seen.add(name)
            d, s = known[c]
            cols.append((c, name, pg_type(d, s, overrides.get(c))))
        for c in list(spec.get("key") or []) + [c for ix in spec.get("indexes") or [] for c in ix]:
            if c not in wanted:
                raise ImportError_(f"{table}: key/index column {c} is not kept")
        out[table] = cols
    return out


# --------------------------------------------------------------------------- DDL

def table_ddl(schema, table, cols, spec):
    lines = [f"  {qi(name)} {typ}" for _, name, typ in cols]
    if spec.get("key"):
        lines.append(f"  PRIMARY KEY ({', '.join(qi(c.lower()) for c in spec['key'])})")
    return f"CREATE TABLE {schema}.{pg_table(table)} (\n" + ",\n".join(lines) + "\n);"


def index_ddl(schema, table, spec):
    out = []
    t = pg_table(table)
    for ix in spec.get("indexes") or []:
        cols = [c.lower() for c in ix]
        out.append(f"CREATE INDEX {t}_{'_'.join(cols)}_idx ON {schema}.{t} ({', '.join(qi(c) for c in cols)});")
    return out


IMPORT_TABLE_DDL = "CREATE TABLE {s}._import (key text PRIMARY KEY, value text NOT NULL);"


def schema_ddl(schema, config, tables):
    parts = [f"CREATE SCHEMA {schema};", ""]
    for table, spec in config.items():
        parts.append(table_ddl(schema, table, tables[table], spec))
        parts.extend(index_ddl(schema, table, spec))
        parts.append("")
    parts.append(IMPORT_TABLE_DDL.format(s=schema))
    return "\n".join(parts) + "\n"


# --------------------------------------------------------------------------- load

def select_exprs(cols):
    """duckdb select list that casts the stringly-typed parquet into the target types."""
    exprs, checks = [], []
    for sap, name, typ in cols:
        raw = f'trim(CAST({qi(sap)} AS VARCHAR))'
        val = f"nullif({raw}, '')"
        if typ == "text":
            # Postgres text cannot hold NUL
            exprs.append(f"replace(CAST({qi(sap)} AS VARCHAR), chr(0), '')")
            continue
        # Numbers pass through as their exact decimal text (Postgres parses them); the regex is the cast check.
        if typ in ("integer", "smallint", "bigint"):
            exprs.append(f"regexp_replace({val}, '\\.0*$', '')")
            checks.append((sap, f"{val} IS NOT NULL AND NOT regexp_full_match({val}, '-?[0-9]+(\\.0*)?')"))
        elif typ.startswith("numeric") or typ == "double precision":
            exprs.append(val)
            checks.append((sap, f"{val} IS NOT NULL AND NOT regexp_full_match({val}, '-?[0-9]+(\\.[0-9]*)?')"))
        elif typ == "date":
            ts = f"try_cast({val} AS TIMESTAMP)"
            exprs.append(f"CAST({ts} AS DATE)")
            # a TIMESTAMP that carries a time of day must be declared `timestamp` in tables.yaml
            checks.append((sap, f"{val} IS NOT NULL AND ({ts} IS NULL OR CAST({ts} AS TIME) <> TIME '00:00:00')"))
        elif typ == "timestamp":
            exprs.append(f"try_cast({val} AS TIMESTAMP)")
            checks.append((sap, f"{val} IS NOT NULL AND try_cast({val} AS TIMESTAMP) IS NULL"))
        else:
            raise ImportError_(f"no cast for {typ}")
    return exprs, checks


def load(args):
    t0 = time.time()
    backup = Path(args.backup).expanduser()
    parquet = backup / "parquet"
    config = load_config()
    meta = load_metadata(backup)
    tables = resolve_tables(config, meta)
    duck = duckdb.connect()
    counts = {}

    with psycopg.connect(args.pg, autocommit=True) as pg, tempfile.TemporaryDirectory(prefix="sap-import-") as tmp:
        pg.execute("DROP SCHEMA IF EXISTS sap_next CASCADE")
        pg.execute("CREATE SCHEMA sap_next")
        pg.execute(IMPORT_TABLE_DDL.format(s="sap_next"))
        for table, spec in config.items():
            src = parquet / f"{table}.parquet"
            if not src.exists():
                raise ImportError_(f"{table}: {src} not found")
            cols = tables[table]
            rel = f"read_parquet('{str(src).replace(chr(39), chr(39) * 2)}')"
            exprs, checks = select_exprs(cols)
            if checks:
                bad = duck.execute(
                    "SELECT " + ", ".join(f"count(*) FILTER (WHERE {c})" for _, c in checks) + f" FROM {rel}"
                ).fetchone()
                for (sap, cond), n in zip(checks, bad):
                    if n:
                        sample = duck.execute(f"SELECT {qi(sap)} FROM {rel} WHERE {cond} LIMIT 3").fetchall()
                        typ = next(t for s, _, t in cols if s == sap)
                        raise ImportError_(
                            f"{table}.{sap}: {n} value(s) do not cast to {typ}, e.g. {[r[0] for r in sample]}")
            n = duck.execute(f"SELECT count(*) FROM {rel}").fetchone()[0]
            out = Path(tmp) / f"{pg_table(table)}.csv"
            select = ", ".join(f"{e} AS c{i}" for i, e in enumerate(exprs))
            duck.execute(f"COPY (SELECT {select} FROM {rel}) TO '{out}' (FORMAT csv, HEADER false)")
            pg.execute(table_ddl("sap_next", table, cols, {}))
            col_list = ", ".join(qi(name) for _, name, _ in cols)
            try:
                with pg.cursor() as cur, cur.copy(f"COPY sap_next.{pg_table(table)} ({col_list}) FROM STDIN (FORMAT csv)") as cp:
                    with open(out, "rb") as f:
                        while chunk := f.read(1 << 20):
                            cp.write(chunk)
            except psycopg.Error as e:
                raise ImportError_(f"{table}: COPY failed: {str(e).strip()}")
            out.unlink()
            if spec.get("key"):
                key = ", ".join(qi(c.lower()) for c in spec["key"])
                try:
                    pg.execute(f"ALTER TABLE sap_next.{pg_table(table)} ADD PRIMARY KEY ({key})")
                except psycopg.errors.UniqueViolation as e:
                    raise ImportError_(f"{table}: duplicate key ({key}): {e.diag.message_detail}")
            for ddl in index_ddl("sap_next", table, spec):
                pg.execute(ddl)
            counts[pg_table(table)] = n
            log(f"  {table:12} {n:>8} rows  {len(cols):>3} cols")

        pg.execute("ANALYZE")
        data_as_of = pg.execute(
            "SELECT max(d) FROM (SELECT max(createdate) d FROM sap_next.ordr UNION ALL SELECT max(createdate) FROM sap_next.oinv"
            " UNION ALL SELECT max(createdate) FROM sap_next.opdn UNION ALL SELECT max(createdate) FROM sap_next.owor) x"
        ).fetchone()[0]
        info = {
            "backup": backup.name,
            "imported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "data_as_of": data_as_of.isoformat(),
            "row_counts": json.dumps(counts, sort_keys=True),
        }
        with pg.cursor() as cur:
            cur.executemany("INSERT INTO sap_next._import (key, value) VALUES (%s, %s)", list(info.items()))
        log(f"loaded {len(counts)} tables, {sum(counts.values()):,} rows in {time.time() - t0:.1f}s; data as of {data_as_of}")

        gates = load_gates(args.gates)
        results = run_hard_gates(pg, "sap_next", gates)
        print_gates(results)
        if failed(results):
            log("\nHARD GATE FAILED: sap and erp left untouched; sap_next kept for inspection.")
            return 1
        if args.no_swap:
            log("\n--no-swap: sap_next kept, sap and erp untouched.")
            return 0

        with pg.transaction():
            pg.execute("DROP SCHEMA IF EXISTS erp CASCADE")
            pg.execute("DROP SCHEMA IF EXISTS sap CASCADE")
            pg.execute("ALTER SCHEMA sap_next RENAME TO sap")
            create_erp(pg)
            erp_results = run_erp_gates(pg)
            if failed(erp_results):
                print_gates(erp_results)
                raise ImportError_("erp gate failed: swap rolled back, sap and erp untouched")
        pg.execute("ANALYZE")
        log(f"swapped in sap + erp ({len(erp_files())} view files)")
        print_gates(run_soft_gates(pg, gates))
        print_sizes(pg)
        log(f"import finished in {time.time() - t0:.1f}s")
    return 0


def erp_files():
    return sorted(ERP_SQL_DIR.glob("*.sql"))


def create_erp(pg):
    # erp.document_files reads the attachment tables; they exist (empty) until `run.py attachments` fills them
    pg.execute(ATT_SQL.read_text(encoding="utf-8"))
    pg.execute("CREATE SCHEMA erp")
    for f in erp_files():
        try:
            pg.execute(f.read_text(encoding="utf-8"))
        except psycopg.Error as e:
            raise ImportError_(f"{f.name}: {e}")


# --------------------------------------------------------------------------- gates
# Structural gates hold for any SAP backup and live here. Data gates compare against expected figures of one
# specific backup (bank closings, a traced document chain, spot-check values). Those are real business numbers,
# so they live outside the repo in a local YAML file (--gates; keys in gates.example.yaml). Without the file the
# data gates report "skip" and never fail.
#
# A gate returns (ok, detail); ok is True / False, or None for skip.

STRUCTURAL_GATES = [
    ("row counts equal parquet counts", None),  # computed in Python from _import.row_counts
    ("OIVL stock = OITW on hand (non-zero item/whs pairs)", """
        WITH l AS (SELECT itemcode, loccode AS whscode, sum(inqty - outqty) q FROM {s}.oivl GROUP BY 1, 2),
             p AS (SELECT coalesce(l.q, 0) lq, coalesce(w.onhand, 0) wq
                   FROM l FULL JOIN {s}.oitw w ON w.itemcode = l.itemcode AND w.whscode = l.whscode
                   WHERE coalesce(l.q, 0) <> 0 OR coalesce(w.onhand, 0) <> 0)
        SELECT count(*) FILTER (WHERE abs(lq - wq) > 0.0001) = 0,
               count(*) FILTER (WHERE abs(lq - wq) <= 0.0001) || '/' || count(*) FROM p"""),
    ("OBTQ batches = OITW on hand (batch items)", """
        WITH b AS (SELECT q.itemcode, q.whscode, sum(q.quantity) q FROM {s}.obtq q GROUP BY 1, 2),
             p AS (SELECT coalesce(b.q, 0) bq, coalesce(w.onhand, 0) wq
                   FROM {s}.oitw w JOIN {s}.oitm i ON i.itemcode = w.itemcode AND i.manbtchnum = 'Y'
                   FULL JOIN b ON b.itemcode = w.itemcode AND b.whscode = w.whscode
                   WHERE coalesce(b.q, 0) <> 0 OR coalesce(w.onhand, 0) <> 0)
        SELECT count(*) FILTER (WHERE abs(bq - wq) > 0.0001) = 0,
               count(*) FILTER (WHERE abs(bq - wq) <= 0.0001) || '/' || count(*) FROM p"""),
    ("JDT1 debit = credit", """
        SELECT abs(sum(debit) - sum(credit)) < 0.01, 'difference ' || round(sum(debit) - sum(credit), 2) FROM {s}.jdt1"""),
    # SAP payment consolidation: a branch card whose balance rolls up into a parent card shows OCRD.Balance 0 while
    # its JDT1 lines stay on the branch. Such cards are accepted when the parents' surplus equals the branches'
    # ledger total exactly.
    ("OCRD.Balance = JDT1 per BP", """
        WITH j AS (SELECT shortname, sum(debit - credit) b FROM {s}.jdt1 GROUP BY 1),
             p AS (SELECT c.cardcode, c.balance, coalesce(j.b, 0) jb FROM {s}.ocrd c LEFT JOIN j ON j.shortname = c.cardcode),
             m AS (SELECT * FROM p WHERE abs(balance - jb) > 0.01),
             r AS (SELECT count(*) FILTER (WHERE balance = 0) children, count(*) FILTER (WHERE balance <> 0) parents,
                          coalesce(sum(jb) FILTER (WHERE balance = 0), 0) child_total,
                          coalesce(sum(balance - jb) FILTER (WHERE balance <> 0), 0) parent_surplus FROM m)
        SELECT abs(child_total - parent_surplus) < 0.01 AND parents <= 3,
               (SELECT count(*) FROM p) - children - parents || '/' || (SELECT count(*) FROM p) || ' exact'
               || CASE WHEN children > 0 THEN '; ' || children || ' consolidated into ' || parents || ' parent card(s)'
                       || ' (net ' || round(child_total - parent_surplus, 2) || ')' ELSE '' END FROM r"""),
]


def gate_bank_closings(pg, s, cfg):
    c = cfg["bank_closings"]
    tol = Decimal(str(c.get("tolerance", 1)))
    ok, parts = True, []
    for a in c["accounts"]:
        bal = pg.execute(f"SELECT coalesce(sum(debit - credit), 0) FROM {s}.jdt1 WHERE account = %s AND refdate <= %s",
                         (a["account"], c["as_of"])).fetchone()[0]
        ok = ok and abs(bal - Decimal(str(a["expected"]))) <= tol
        parts.append(f"{a.get('label', a['account'])} {bal:.2f}")
    return ok, f"on {c['as_of']}: " + ", ".join(parts)


def gate_golden_trace(pg, s, cfg):
    t = cfg["golden_trace"]
    row = pg.execute(f"""
        SELECT count(*) FROM {s}.ordr o
        JOIN {s}.inv1 l ON l.basetype = 17 AND l.baseentry = o.docentry AND l.docentry = %(inv)s
        JOIN {s}.ccs_eoewb e ON e.u_baseentry = l.docentry::text AND e.u_ewbno = %(ewb)s
        WHERE o.docentry = %(so)s""", {"so": t["so_doc_entry"], "inv": t["invoice_doc_entry"], "ewb": str(t["ewb_no"])}).fetchone()
    return row[0] > 0, "found" if row[0] else "SO -> invoice -> e-way bill chain not found"


def gate_production_values(pg, s, cfg):
    p = cfg["production_order"]
    tol = Decimal(str(p.get("tolerance", 10)))
    n, issued, received = pg.execute(f"""
        WITH w AS (SELECT docentry FROM {s}.owor WHERE docnum = %(num)s AND itemcode = %(item)s)
        SELECT (SELECT count(*) FROM w),
               (SELECT coalesce(sum(l.quantity * l.stockprice), 0) FROM {s}.ige1 l JOIN w ON l.basetype = 202 AND l.baseentry = w.docentry),
               (SELECT coalesce(sum(l.quantity * l.stockprice), 0) FROM {s}.ign1 l JOIN w ON l.basetype = 202 AND l.baseentry = w.docentry)
        """, {"num": p["doc_num"], "item": p["item_code"]}).fetchone()
    ok = n == 1 and abs(issued - Decimal(str(p["issued"]))) <= tol and abs(received - Decimal(str(p["received"]))) <= tol
    return ok, f"issued {issued:.0f}, received {received:.0f}"


DATA_GATES = [
    ("bank GL closings", "bank_closings", gate_bank_closings),
    ("golden trace SO -> invoice -> e-way bill", "golden_trace", gate_golden_trace),
    ("production order issued ~ received", "production_order", gate_production_values),
]

# Warnings only; they read the erp views, so they run after the swap.
# Structural gates on the erp views, run inside the swap (a failure rolls it back) and by `verify`.
ERP_GATES = [
    # P2 looks documents up by number; SAP's cancellation mirrors may repeat the number they cancel.
    ("erp.documents unique (doc_type, doc_no) without mirrors", """
        WITH d AS (SELECT doc_type, doc_no, count(*) n FROM erp.documents WHERE NOT is_cancellation GROUP BY 1, 2)
        SELECT count(*) FILTER (WHERE n > 1) = 0,
               coalesce(sum(n), 0) || ' documents; ' || count(*) FILTER (WHERE n > 1) || ' numbers used twice'
               || coalesce(' (' || string_agg(doc_type || ' ' || doc_no, ', ') FILTER (WHERE n > 1) || ')', '') FROM d"""),
]


def run_erp_gates(pg):
    return [(name, "hard", *guarded(lambda: pg.execute(sql).fetchone())) for name, sql in ERP_GATES]


SOFT_GATES = [
    # att is replaced by `run.py attachments` only; after a newer `run.py sap` its links may point at documents the
    # new import no longer has. Re-run attachments when this warns.
    ("attachment links resolve to imported documents", """
        SELECT count(*) FILTER (WHERE doc_type IS NULL) = 0,
               count(*) || ' links on erp.documents objects; ' || count(*) FILTER (WHERE doc_type IS NULL) || ' unresolved'
        FROM erp.document_files WHERE sap_object IN ('13', '14', '17', '18', '19', '20', '22')"""),
    ("laminates with no unit of measure", """
        SELECT count(*) = 0, count(*) || ' laminates (' || count(*) FILTER (WHERE uom IS NOT NULL) || ' inferred kg from BOMs)'
        FROM erp.items WHERE material_role = 'laminate' AND uom_raw IS NULL"""),
    ("business partners without a GSTIN", """
        SELECT count(*) FILTER (WHERE gstin IS NULL) = 0,
               count(*) FILTER (WHERE gstin IS NULL) || ' of ' || count(*) || ' (' ||
               count(*) FILTER (WHERE gstin IS NULL AND active) || ' active)' FROM erp.parties"""),
]


def gate_placeholder_boms(pg, cfg):
    n = pg.execute("SELECT count(DISTINCT fg_item_code) FROM erp.bom_lines WHERE is_placeholder").fetchone()[0]
    r = (cfg or {}).get("placeholder_boms")
    if not r:
        return None, f"{n} BOMs (no gates file)"
    return r["min"] <= n <= r["max"], f"{n} BOMs (expected {r['min']}-{r['max']})"


def load_gates(path):
    p = Path(path).expanduser()
    if not p.exists():
        log(f"gates file {p} not found: data-specific gates will be skipped")
        return None
    with open(p, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def guarded(fn):
    try:
        return fn()
    except psycopg.Error as e:
        return False, f"error: {str(e).strip().splitlines()[0]}"
    except (KeyError, TypeError, ValueError) as e:
        return False, f"bad gates file entry: {e!r}"


def run_hard_gates(pg, schema, cfg):
    results = []
    for name, sql in STRUCTURAL_GATES:
        if sql is None:
            ok, detail = guarded(lambda: row_count_gate(pg, schema))
        else:
            ok, detail = guarded(lambda: pg.execute(sql.format(s=schema)).fetchone())
        results.append((name, "hard", bool(ok), detail))
    for name, key, fn in DATA_GATES:
        if not cfg or key not in cfg:
            results.append((name, "hard", None, "no gates file"))
        else:
            ok, detail = guarded(lambda: fn(pg, schema, cfg))
            results.append((name, "hard", bool(ok), detail))
    return results


def run_soft_gates(pg, cfg):
    results = [("placeholder BOMs", "soft", *guarded(lambda: gate_placeholder_boms(pg, cfg)))]
    for name, sql in SOFT_GATES:
        ok, detail = guarded(lambda: pg.execute(sql).fetchone())
        results.append((name, "soft", bool(ok), detail))
    return results


def run_spot_checks(pg, cfg):
    """Spot checks from the gates file: each runs `sql` and compares the first row with `expect`."""
    if not cfg or not cfg.get("spot_checks"):
        return [("spot checks", "hard", None, "no gates file")]
    results = []
    for check in cfg["spot_checks"]:
        def one():
            row = pg.execute(check["sql"]).fetchone()
            if row is None:
                return False, "no row"
            expect = check["expect"] if isinstance(check["expect"], list) else [check["expect"]]
            ok = len(row) == len(expect) and all(same_value(a, e) for a, e in zip(row, expect))
            return ok, ", ".join(str(v) for v in row) if ok else f"got {list(map(str, row))}"
        ok, detail = guarded(one)
        results.append((f"spot: {check['name']}", "hard", bool(ok), detail))
    return results


def same_value(actual, expected):
    if isinstance(actual, (int, float, Decimal)) and not isinstance(actual, bool):
        try:
            return abs(Decimal(str(actual)) - Decimal(str(expected))) <= Decimal("0.005")
        except ArithmeticError:
            return False
    return str(actual) == str(expected)


def row_count_gate(pg, schema):
    row = pg.execute(f"SELECT value FROM {schema}._import WHERE key = 'row_counts'").fetchone()
    if not row:
        return False, "no row_counts in _import"
    expected = json.loads(row[0])
    bad = []
    for t, n in expected.items():
        actual = pg.execute(f"SELECT count(*) FROM {schema}.{t}").fetchone()[0]
        if actual != n:
            bad.append(f"{t} {actual}/{n}")
    return not bad, (f"{len(expected)} tables, {sum(expected.values()):,} rows" if not bad else "; ".join(bad))


def failed(results):
    return any(ok is False and kind == "hard" for _, kind, ok, _ in results)


def print_gates(results):
    w = max(len(r[0]) for r in results)
    log(f"\n{'gate':<{w}}  kind  result  detail")
    log(f"{'-' * w}  ----  ------  ------")
    for name, kind, ok, detail in results:
        status = "skip" if ok is None else "pass" if ok else ("FAIL" if kind == "hard" else "warn")
        log(f"{name:<{w}}  {kind:<4}  {status:<6}  {detail}")


# --------------------------------------------------------------------------- verify

# The erp contract the backend reads (columns may be added, never renamed).
ERP_CONTRACT = {
    "import_info": "backup imported_at data_as_of",
    "items": "item_code item_name group_code group_name category material_role uom_raw uom uom_inferred pcs_per_carton pack_grams gst_rate batch_managed has_bom active hsn",
    "stock": "item_code whs_code on_hand committed on_order free avg_price value owner_card_code owner_name customer_supplied",
    "parties": "card_code card_name card_type group_name pan gstin city state phone mobile email balance active",
    "party_addresses": "card_code card_name card_type address_type address_name street city zip_code state gstin is_default active",
    "sales_orders": "doc_entry doc_no doc_num series_name doc_date due_date po_date created_at card_code card_name customer_po_no party_key ship_to_code total tax_total status approval_status stale line_count total_qty invoice_count created_by",
    "sales_order_lines": "doc_entry line_num item_code item_name qty open_qty price line_total tax_code tax_pct whs_code line_status invoice_doc_entry",
    "invoices": "doc_entry doc_no doc_num doc_date created_at card_code card_name customer_po_no total tax_total cancelled is_cancellation so_doc_entries ewb_no ewb_at ewb_cancelled irn irn_status ack_no ack_at",
    "invoice_lines": "doc_entry line_num item_code item_name qty price line_total base_so_doc_entry base_so_line",
    "credit_notes": "doc_entry doc_no doc_date card_code card_name total cancelled base_invoice_doc_entries",
    "purchase_orders": "doc_entry doc_no doc_date due_date card_code card_name vendor_ref total status line_count open_value",
    "purchase_order_lines": "doc_entry line_num item_code item_name qty open_qty uom price line_total line_status",
    "grns": "doc_entry doc_no doc_date created_at card_code card_name vendor_ref total cancelled free_issue",
    "grn_lines": "doc_entry line_num item_code item_name material_role qty uom price line_total free_issue base_po_doc_entry batch_no",
    "ap_invoices": "doc_entry doc_no doc_date card_code card_name vendor_ref total cancelled",
    "production_orders": "doc_entry doc_no doc_num item_code item_name type status planned_qty completed_qty post_date start_date due_date close_date card_code customer_name stock_type issued_value received_value comments",
    "production_components": "doc_entry line_num item_code item_name material_role planned_qty issued_qty uom issue_method",
    "bom_lines": "fg_item_code basis_qty line_num component_code component_name material_role uom qty_per_basis qty_per_unit issue_method is_placeholder",
    "documents": "sap_object doc_entry doc_no doc_type doc_date card_code card_name total cancelled is_cancellation",
    "approvals_hist": "doc_object doc_entry draft_entry doc_no status originator approver requested_at decided_at total",
    "document_files": "sap_object doc_entry doc_no doc_type doc_date card_code card_name total role link_method confidence"
                      " sha256 storage_key file_name mime size_bytes kind file_time",
    # P6 finance
    "bank_accounts": "gl_code gl_name format_code kind short_name house_bank active display_order",
    "bank_lines": "trans_id line_id gl_code bank account_kind ref_date created_at debit credit amount contra_code contra_kind"
                  " contra_bank card_code contra_name trans_type payment_doc_entry payment_type payment_memo payment_cancelled"
                  " purpose_gl memo je_memo source_no is_reversal reverses_trans_id",
    "payments": "direction sap_object doc_entry doc_num doc_no doc_date created_at kind card_code card_name bank_gl bank amount"
                " on_account applied purpose_gl purpose_name transfer memo cancelled trans_id",
    "payment_requests": "request_id draft_entry payment_doc_entry status doc_date requested_at decided_at originator approver kind"
                        " card_code card_name bank amount purpose_gl purpose_name memo",
    "bp_balances": "card_code card_name card_type pan group_key balance owed sap_balance last_moved lines",
    "ar_ap_ageing": "side group_key card_code trans_id line_id ref_date due_date days_overdue bucket amount trans_type doc_no",
    "invoices_outwards": "doc_entry doc_no doc_date created_at ewb_no ewb_at ewb_date card_code card_name total tax_total",
    "production_movements": "kind doc_entry doc_no doc_date created_at line_num production_doc_entry item_code item_name"
                            " material_role qty uom value cancelled",
    "journal_entries": "trans_id doc_no doc_num trans_type ref_date created_at memo ref1 ref2 total reverses_trans_id created_by",
    "journal_lines": "trans_id line_id gl_code account_name card_code debit credit memo ref_date",
    # P7 costing
    "production_costs": "doc_entry doc_no item_code item_name material_role type status card_code customer_name pack_grams produced_qty"
                        " produced_value first_receipt last_receipt issued_value returned_value material_cost cost_per_pc"
                        " produced_kg cost_per_kg banana_value oil_value laminate_value carton_value seasoning_value overhead_qty",
    "fg_cost_monthly": "month item_code item_name pack_grams produced_qty produced_value produced_kg orders",
    "sku_margin_monthly": "month item_code item_name pack_grams card_code card_name group_key qty revenue cogs kg invoices",
    "material_mix_monthly": "month material_role issued_value returned_value net_value issued_kg issued_qty lines",
    "stock_valuation": "item_code item_name material_role group_name valuation_method whs_code qty value customer_supplied",
    "cost_gl_accounts": "gl_code account_name kind",
    "cost_gl_monthly": "month gl_code account_name kind debit credit net lines",
    "wip_variance_monthly": "month gl_code account_name debit credit net lines",
}
# The hr schema the backend reads (written by `run.py hr`); checked only when it exists.
HR_CONTRACT = {
    "employees": "employee_id name code_voyon code_register department designation category employment on_voyon_payroll punch_status",
    "temp_workers": "worker_id name block employee_id",
    "attendance_days": "employee_id work_date code",
    "leave_requests": "request_no employee_id code_voyon leave_type from_date to_date days status",
    "payroll_runs": "run_id month source headcount gross_earned total_earning deductions net",
    "payroll_lines": "run_id line_no employee_id name category days_paid basic gross_earned total_earning pf esi total_deductions net",
    "peeling_output": "month worker_name worker_class employee_id work_date kg incentive",
}
# Filled by `run.py attachments`, not by `run.py sap`: may be empty.
ERP_MAY_BE_EMPTY = {"document_files"}

# Queries shaped like the backend's list pages; each must answer in < 300 ms.
LIST_QUERIES = [
    ("stock fg page", "SELECT * FROM erp.stock s JOIN erp.items i USING (item_code) WHERE i.material_role = 'fg' ORDER BY s.free LIMIT 50"),
    ("stock materials page", "SELECT * FROM erp.stock s JOIN erp.items i USING (item_code) WHERE i.material_role <> 'fg' ORDER BY i.item_code LIMIT 50"),
    ("stock materials search", "SELECT s.*, i.item_name, i.material_role, count(*) OVER () FROM erp.stock s JOIN erp.items i USING (item_code) WHERE i.material_role = 'laminate' AND (i.item_code ILIKE '%a%' OR i.item_name ILIKE '%a%') ORDER BY i.item_code LIMIT 50"),
    ("stock role counts", "SELECT i.material_role, count(*) FROM erp.stock s JOIN erp.items i USING (item_code) GROUP BY 1"),
    ("sales orders page", "SELECT * FROM erp.sales_orders WHERE status = 'open' ORDER BY doc_date DESC, doc_entry DESC LIMIT 50"),
    ("sales orders count", "SELECT count(*), count(*) FILTER (WHERE stale) FROM erp.sales_orders WHERE status = 'open'"),
    ("sales orders search", "SELECT * FROM erp.sales_orders WHERE card_name ILIKE '%ltd%' OR customer_po_no ILIKE '%1%' ORDER BY doc_date DESC LIMIT 50"),
    ("customer POs grouped", "SELECT customer_po_no, party_key, min(card_name), count(*), sum(total) FROM erp.sales_orders WHERE customer_po_no IS NOT NULL GROUP BY 1, 2 ORDER BY max(doc_date) DESC LIMIT 50"),
    ("one customer PO", "SELECT * FROM erp.sales_orders WHERE (customer_po_no, party_key) = (SELECT customer_po_no, party_key FROM erp.sales_orders WHERE customer_po_no IS NOT NULL ORDER BY doc_entry DESC LIMIT 1) ORDER BY doc_date DESC LIMIT 50"),
    ("sales order detail", "SELECT * FROM erp.sales_order_lines WHERE doc_entry = (SELECT max(doc_entry) FROM erp.sales_orders)"),
    ("sales order header", "SELECT * FROM erp.sales_orders WHERE doc_entry = (SELECT max(docentry) FROM sap.ordr)"),
    ("invoices for an SO", "SELECT * FROM erp.invoices WHERE (SELECT max(docentry) FROM sap.ordr) = ANY (so_doc_entries)"),
    ("invoice detail", "SELECT * FROM erp.invoices WHERE doc_entry = (SELECT max(docentry) FROM sap.oinv)"),
    ("invoices for a day", "SELECT * FROM erp.invoices WHERE doc_date = (SELECT data_as_of FROM erp.import_info) AND NOT cancelled AND NOT is_cancellation"),
    ("invoices per day strip", "SELECT doc_date, count(*) FROM erp.invoices WHERE doc_date > (SELECT data_as_of - 30 FROM erp.import_info) GROUP BY 1"),
    ("production page", "SELECT * FROM erp.production_orders ORDER BY post_date DESC, doc_entry DESC LIMIT 50"),
    ("production kpis", "SELECT count(*) FILTER (WHERE status IN ('planned','released')), sum(completed_qty) FILTER (WHERE post_date >= date_trunc('month', (SELECT data_as_of FROM erp.import_info))) FROM erp.production_orders"),
    ("purchase orders page", "SELECT * FROM erp.purchase_orders ORDER BY doc_date DESC, doc_entry DESC LIMIT 50"),
    ("grn detail", "SELECT * FROM erp.grn_lines WHERE doc_entry = (SELECT max(docentry) FROM sap.opdn)"),
    ("production detail", "SELECT * FROM erp.production_components WHERE doc_entry = (SELECT max(docentry) FROM sap.owor)"),
    ("grns page", "SELECT * FROM erp.grns ORDER BY doc_date DESC, doc_entry DESC LIMIT 50"),
    ("items search", "SELECT * FROM erp.items WHERE item_code ILIKE '%os%' OR item_name ILIKE '%chips%' LIMIT 50"),
    ("parties search", "SELECT * FROM erp.parties WHERE card_name ILIKE '%ltd%' LIMIT 50"),
    ("documents lookup", "SELECT * FROM erp.documents WHERE NOT is_cancellation AND doc_no = (SELECT doc_no FROM erp.sales_orders ORDER BY doc_entry DESC LIMIT 1)"),
    ("approvals for an SO", "SELECT * FROM erp.approvals_hist WHERE doc_object = '17' AND doc_entry = (SELECT max(doc_entry) FROM erp.sales_orders)"),
    ("files for two invoices", "SELECT * FROM erp.document_files WHERE (sap_object, doc_entry) IN (SELECT '13', d FROM unnest("
                               "ARRAY[(SELECT max(docentry) FROM sap.oinv), (SELECT min(docentry) FROM sap.oinv)]) d)"),
    ("one file by hash", "SELECT * FROM erp.document_files WHERE sha256 = (SELECT min(sha256) FROM att.files)"),
    # P6: the daily report and the Payments page
    ("bank position on a day", "SELECT a.gl_code, sum(l.amount) FILTER (WHERE l.ref_date < d), sum(l.debit) FILTER (WHERE l.ref_date = d),"
                               " sum(l.credit) FILTER (WHERE l.ref_date = d), sum(l.amount) FILTER (WHERE l.ref_date <= d)"
                               " FROM erp.bank_accounts a LEFT JOIN erp.bank_lines l ON l.gl_code = a.gl_code,"
                               " (SELECT data_as_of - 1 AS d FROM erp.import_info) x GROUP BY a.gl_code"),
    ("bank lines on a day", "SELECT * FROM erp.bank_lines WHERE ref_date = (SELECT data_as_of - 1 FROM erp.import_info) ORDER BY created_at"),
    ("bank book page", "SELECT *, sum(amount) OVER (ORDER BY ref_date, trans_id, line_id) FROM erp.bank_lines"
                       " WHERE gl_code = (SELECT gl_code FROM erp.bank_accounts WHERE kind = 'bank' ORDER BY display_order LIMIT 1)"
                       " AND ref_date >= (SELECT data_as_of - 31 FROM erp.import_info) ORDER BY ref_date LIMIT 100"),
    ("payments page", "SELECT * FROM erp.payments WHERE direction = 'out' AND NOT cancelled ORDER BY doc_date DESC, doc_entry DESC LIMIT 50"),
    ("payments by purpose", "SELECT purpose_gl, kind, count(*), sum(amount) FROM erp.payments WHERE direction = 'out' AND NOT cancelled"
                            " AND doc_date >= (SELECT date_trunc('month', data_as_of)::date FROM erp.import_info) GROUP BY 1, 2"),
    ("payment requests pending", "SELECT * FROM erp.payment_requests WHERE status = 'pending' ORDER BY requested_at LIMIT 50"),
    ("receivable ageing by group", "SELECT b.group_key, sum(b.owed), (SELECT sum(amount) FROM erp.ar_ap_ageing a WHERE a.group_key = b.group_key"
                                   " AND a.side = 'receivable') FROM erp.bp_balances b WHERE b.card_type = 'customer' GROUP BY 1"),
    ("party balances", "SELECT * FROM erp.bp_balances WHERE card_type = 'customer' ORDER BY owed DESC LIMIT 50"),
    ("outwards of a day", "SELECT * FROM erp.invoices_outwards WHERE created_at > ((SELECT data_as_of - 2 FROM erp.import_info) + time '19:30')"
                          " AT TIME ZONE 'Asia/Kolkata' AND created_at <= ((SELECT data_as_of - 1 FROM erp.import_info) + time '19:30')"
                          " AT TIME ZONE 'Asia/Kolkata'"),
    ("outwards month to date", "SELECT sum(total) FROM erp.invoices_outwards WHERE doc_date BETWEEN"
                               " (SELECT date_trunc('month', data_as_of)::date FROM erp.import_info) AND (SELECT data_as_of FROM erp.import_info)"),
    ("production movements of a day", "SELECT kind, material_role, count(*), sum(qty) FROM erp.production_movements"
                                      " WHERE doc_date = (SELECT data_as_of - 1 FROM erp.import_info) GROUP BY 1, 2"),
    ("journal entries search", "SELECT * FROM erp.journal_entries WHERE memo ILIKE '%salary%' ORDER BY ref_date DESC LIMIT 10"),
    # P7: the Costing page and the costing tools
    ("costing kpis of a month", "SELECT sum(produced_kg), sum(produced_value), (SELECT sum(revenue - cogs) / nullif(sum(kg), 0)"
                                " FROM erp.sku_margin_monthly WHERE month = f.month) FROM erp.fg_cost_monthly f"
                                " WHERE month = (SELECT date_trunc('month', data_as_of)::date FROM erp.import_info) GROUP BY month"),
    ("sku margin over months", "SELECT s.item_code, sum(s.qty), sum(s.revenue), sum(s.cogs), (SELECT sum(produced_value) / nullif(sum(produced_qty), 0)"
                               " FROM erp.fg_cost_monthly f WHERE f.item_code = s.item_code AND f.month >= '2026-01-01')"
                               " FROM erp.sku_margin_monthly s WHERE s.month >= '2026-01-01' GROUP BY 1 ORDER BY 3 DESC LIMIT 50"),
    ("customer margin over months", "SELECT group_key, min(card_name), sum(revenue), sum(cogs), sum(kg) FROM erp.sku_margin_monthly"
                                    " WHERE month >= '2026-01-01' GROUP BY 1 ORDER BY 3 DESC LIMIT 50"),
    ("one production order cost", "SELECT * FROM erp.production_costs WHERE doc_entry = (SELECT max(docentry) FROM sap.owor)"),
    ("production costs of an item", "SELECT * FROM erp.production_costs WHERE item_code = (SELECT itemcode FROM sap.owor"
                                    " ORDER BY docentry DESC LIMIT 1) ORDER BY last_receipt DESC NULLS LAST LIMIT 50"),
    ("material mix by month", "SELECT * FROM erp.material_mix_monthly ORDER BY month DESC, net_value DESC LIMIT 60"),
    ("stock valuation by group", "SELECT group_name, whs_code, valuation_method, sum(value), count(*) FROM erp.stock_valuation GROUP BY 1, 2, 3"),
    ("WIP variance and salary GL by month", "SELECT month, kind, sum(net) FROM erp.cost_gl_monthly GROUP BY 1, 2 ORDER BY 1 DESC LIMIT 60"),
]


def verify(args):
    with psycopg.connect(args.pg, autocommit=True) as pg:
        if not pg.execute("SELECT 1 FROM pg_namespace WHERE nspname = 'sap'").fetchone():
            log("schema sap does not exist: run `run.py sap` first")
            return 1
        gates = load_gates(args.gates)
        results = run_hard_gates(pg, "sap", gates) + run_soft_gates(pg, gates)
        results += run_erp_gates(pg) + contract_checks(pg) + hr_contract_checks(pg) + run_spot_checks(pg, gates)
        print_gates(results)
        print_sizes(pg)
        return 1 if failed(results) else 0


def rebuild_erp(args):
    """Recreates schema erp from sql/erp/*.sql over the sap already loaded, in one transaction (a failing view file
    or erp gate leaves the old erp in place). For view changes; a new backup goes through `sap`."""
    with psycopg.connect(args.pg, autocommit=True) as pg:
        if not pg.execute("SELECT 1 FROM pg_namespace WHERE nspname = 'sap'").fetchone():
            log("schema sap does not exist: run `run.py sap` first")
            return 1
        with pg.transaction():
            pg.execute("DROP SCHEMA IF EXISTS erp CASCADE")
            create_erp(pg)
            results = run_erp_gates(pg)
            if failed(results):
                print_gates(results)
                raise ImportError_("erp gate failed: rolled back, the old erp is untouched")
        pg.execute("ANALYZE")
        log(f"rebuilt erp ({len(erp_files())} view files)")
        print_sizes(pg)
        return 0


def print_sizes(pg):
    sizes = pg.execute(
        "SELECT n.nspname, pg_size_pretty(coalesce(sum(pg_total_relation_size(c.oid)) FILTER (WHERE c.relkind IN ('r', 'm')), 0))"
        " FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid WHERE n.nspname IN ('sap', 'erp', 'att', 'hr')"
        " GROUP BY 1 ORDER BY 1 DESC").fetchall()
    log("\nsize: " + ", ".join(f"{s} {v}" for s, v in sizes) +
        f", whole database {pg.execute('SELECT pg_size_pretty(pg_database_size(current_database()))').fetchone()[0]}")


def hr_contract_checks(pg):
    """The hr tables the backend reads, when `run.py hr` has loaded them (payroll is optional data)."""
    if not pg.execute("SELECT 1 FROM pg_namespace WHERE nspname = 'hr'").fetchone():
        return [("hr schema", "hard", None, "not loaded (run.py hr); the Payroll page says so")]
    results = []
    for table, cols in HR_CONTRACT.items():
        have = {r[0] for r in pg.execute(
            "SELECT attname FROM pg_attribute WHERE attrelid = to_regclass(%s) AND attnum > 0 AND NOT attisdropped", (f"hr.{table}",))}
        if not have:
            results.append((f"hr.{table}", "hard", False, "missing"))
            continue
        missing = [c for c in cols.split() if c not in have]
        n = pg.execute(f"SELECT count(*) FROM hr.{table}").fetchone()[0]
        results.append((f"hr.{table}", "hard", not missing, f"{n:,} rows" + (f"; missing columns {missing}" if missing else "")))
    return results


def contract_checks(pg):
    results = []
    for view, cols in ERP_CONTRACT.items():
        have = {r[0] for r in pg.execute(
            "SELECT attname FROM pg_attribute WHERE attrelid = to_regclass(%s) AND attnum > 0 AND NOT attisdropped", (f"erp.{view}",))}
        missing = [c for c in cols.split() if c not in have]
        if not have:
            results.append((f"erp.{view}", "hard", False, "missing"))
            continue
        n = pg.execute(f"SELECT count(*) FROM erp.{view}").fetchone()[0]
        ok = not missing and (n > 0 or view in ERP_MAY_BE_EMPTY)
        results.append((f"erp.{view}", "hard", ok, f"{n:,} rows" + (f"; missing columns {missing}" if missing else "")))
    for name, sql in LIST_QUERIES:
        try:
            pg.execute(sql).fetchall()  # warm
            t = time.perf_counter()
            pg.execute(sql).fetchall()
            ms = (time.perf_counter() - t) * 1000
            results.append((f"speed: {name}", "hard", ms < 300, f"{ms:.0f} ms"))
        except psycopg.Error as e:
            results.append((f"speed: {name}", "hard", False, f"error: {str(e).strip().splitlines()[0]}"))
    return results


# --------------------------------------------------------------------------- ddl

def ddl(args):
    config = load_config()
    tables = resolve_tables(config, load_metadata(Path(args.backup).expanduser()))
    header = (
        "-- Generated by tools/sap-import/run.py ddl from tables.yaml and the backup's column metadata.\n"
        "-- Schema only (no data): typed, column-curated copies of SAP B1 tables. Do not edit by hand.\n\n"
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(header + schema_ddl("sap", config, tables), encoding="utf-8")
    log(f"wrote {out} ({len(tables)} tables)")
    return 0


# --------------------------------------------------------------------------- attachments
# SAP attachment files -> schema att + a file store. Only files that belong to an imported, posted document are
# kept. Three ways a file belongs to a document (see Reference/research/.../attachments.md):
#   1. ATC1: the document's AtcEntry -> ATC1 rows -> FileName.FileExt, matched on the lower-cased base name;
#   2. the e-invoice add-on: @CCS_EOINV.U_QRPATH -> the QR png, @CCS_EOEWB.U_EWBNO -> <ewb no>.pdf;
#   3. SAP's own print exports (AR Invoice_YYYYMMDD_HHMMSS.pdf ...), read with pdftotext: the printed number must
#      name exactly one document and the printed net value must equal its DocTotal.
# The archive folders are untrusted input: files are only hashed, read with pdftotext (a separate process with a
# timeout) and copied, never opened as anything else.

# Posted documents that carry ATC1 pointers. Drafts (ODRF, OPDF) and archive tables (A*) are left out on purpose.
# (sap table, SAP object type, entry column, number column, date column, card column)
ATC_OBJECTS = [
    ("oinv", "13", "docentry", "docnum", "docdate", "cardcode"),
    ("orin", "14", "docentry", "docnum", "docdate", "cardcode"),
    ("ordr", "17", "docentry", "docnum", "docdate", "cardcode"),
    ("opch", "18", "docentry", "docnum", "docdate", "cardcode"),
    ("orpc", "19", "docentry", "docnum", "docdate", "cardcode"),
    ("opdn", "20", "docentry", "docnum", "docdate", "cardcode"),
    ("opor", "22", "docentry", "docnum", "docdate", "cardcode"),
    ("orct", "24", "docentry", "docnum", "docdate", "cardcode"),
    ("ovpm", "46", "docentry", "docnum", "docdate", "cardcode"),
    ("ojdt", "30", "transid", "number", "refdate", None),
]
OBJECT_NAMES = {"13": "AR invoice", "14": "AR credit note", "17": "sales order", "18": "AP invoice",
                "19": "AP credit note", "20": "goods receipt", "22": "purchase order", "24": "incoming payment",
                "46": "outgoing payment", "30": "journal entry", "2": "business partner"}

# SAP print exports: "<kind>[ [Approved]| - Cancellation][_<DocNum>]_YYYYMMDD_HHMMSS.pdf"
PRINT_NAME = re.compile(r"^(?P<kind>.+?)(?:_(?P<docnum>\d+))?_(?P<d>\d{8})_(?P<t>\d{6})\.pdf$", re.I)
# kind -> (sap table, object type, regex for the printed number, role)
PRINT_KINDS = {
    "AR Invoice": ("oinv", "13", r"Invoice No\s*:\s*(\S+)", "invoice_pdf"),
    "Credit Note": ("orin", "14", r"(?:Credit Note No|Note No|CN No|Invoice No)\s*:\s*(\S+)", "credit_note_pdf"),
    "Debit Note": ("orpc", "19", r"(?:Debit Note No|Note No|DN No|Invoice No)\s*:\s*(\S+)", "debit_note_pdf"),
    "AP Invoice": ("opch", "18", r"(?:Invoice No|Doc No|Bill No)\s*:\s*(\S+)", "ap_invoice_pdf"),
    "Purchase Order": ("opor", "22", r"PO No\s*:\s*(\S+)", "po_pdf"),
    "Sales Order": ("ordr", "17", r"(?:SO No|Order No|Sales Order No)\s*:\s*(\S+)", "so_pdf"),
    "Incoming Payments": ("orct", "24", r"No\s*:\s*-\s*(\d+)\s*-", "receipt_pdf"),
}
# Print roles a customer group may receive (backend PARTY_FILE_ROLES). A print that carries several document numbers
# (a batch print) would show a customer other customers' documents, so it is linked as internal 'supporting' instead.
CUSTOMER_PRINT_ROLES = {"invoice_pdf", "credit_note_pdf"}
PRINT_DATE = re.compile(r"(?:Invoice|PO|Doc|Order|Note|Posting)\s+Date\s*:\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})")
NET_VALUE = re.compile(r"Net Value\s+(-?[\d,]+\.\d\d)")
PAID_AMOUNT = re.compile(r"Amt\s*:\s*(-?[\d,]+\.\d\d)")
MIME = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls": "application/vnd.ms-excel", ".csv": "text/csv", ".txt": "text/plain",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
METHOD_SOURCE = {"atc1": "sap_atc1", "ccs_eoinv": "sap_ccs", "ccs_eoewb": "sap_ccs",
                 "content_doc_no": "sap_print", "filename_docnum": "sap_print"}
METHOD_RANK = {"atc1": 0, "ccs_eoewb": 1, "ccs_eoinv": 1, "content_doc_no": 2, "filename_docnum": 2}
EXCERPT_LIMIT = 2048
PDFTOTEXT_TIMEOUT = 30


class FileInfo:
    __slots__ = ("path", "name", "size", "sha", "ext", "mtime", "text")

    def __init__(self, path):
        self.path = path
        self.name = path.name
        st = path.stat()
        self.size = st.st_size
        self.mtime = st.st_mtime
        self.ext = path.suffix.lower()
        self.sha = None
        self.text = None


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def walk_archives(dirs):
    """Every regular file under the folders, by lower-cased base name. A name found twice: the copy under
    Ewaybill/ wins (SAP's own folder), then the first folder given."""
    by_name, all_files = {}, []
    for root in dirs:
        for dirpath, _, names in os.walk(root, followlinks=False):
            for n in sorted(names):
                p = Path(dirpath) / n
                if p.is_symlink() or not p.is_file():
                    continue
                info = FileInfo(p)
                all_files.append(info)
                key = n.lower()
                prev = by_name.get(key)
                if prev is None or ("ewaybill" in str(p.parent).lower() and "ewaybill" not in str(prev.path.parent).lower()):
                    by_name[key] = info
    return by_name, all_files


def pdf_text(path, first_pages=None):
    cmd = ["pdftotext", "-layout", "-q"]
    if first_pages:
        cmd += ["-l", str(first_pages)]
    cmd += ["--", str(path), "-"]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=PDFTOTEXT_TIMEOUT, check=False)
        return out.stdout.decode("utf-8", errors="replace")
    except (subprocess.TimeoutExpired, OSError):
        return ""


def excerpt(text):
    if not text:
        return None
    flat = re.sub(r"\s+", " ", text.replace("\x00", "")).strip()
    return flat[:EXCERPT_LIMIT] or None


def file_kind(name):
    low = name.lower()
    if low.startswith("gstzenqr") and low.endswith(".png"):
        return "einvoice_qr"
    if re.fullmatch(r"\d{12}\.pdf", low):
        return "ewaybill"
    if PRINT_NAME.match(name):
        return "sap_print"
    return "attachment"


def file_time(info):
    m = PRINT_NAME.match(info.name)
    if m:
        try:
            # print time in India
            local = datetime.strptime(m["d"] + m["t"], "%Y%m%d%H%M%S")
            return (local - timedelta(hours=5, minutes=30)).replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            pass
    return datetime.fromtimestamp(info.mtime, timezone.utc).isoformat(timespec="seconds")


def storage_key(info):
    ext = info.ext if re.fullmatch(r"\.[a-z0-9]{1,5}", info.ext or "") else ".bin"
    return f"sap/{info.sha[:2]}/{info.sha[2:4]}/{info.sha}{ext}"


class FsStore:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.label = f"fs:{self.root}"

    def has(self, key, size):
        p = self.root / key
        return p.is_file() and p.stat().st_size == size

    def put(self, key, path, mime):
        dest = self.root / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".part")
        shutil.copyfile(path, tmp)
        os.replace(tmp, dest)


def s3_addressing_style(url_style):
    """S3_URL_STYLE: path (default, MinIO) or virtual-host (the bucket name in the host; Railway buckets)."""
    style = (url_style or "").strip().lower()
    if style in ("", "path"):
        return "path"
    if style in ("virtual-host", "virtual"):
        return "virtual"
    raise ImportError_(f"S3_URL_STYLE must be path or virtual-host, not {url_style!r}")

class S3Store:
    """Any S3-compatible bucket (a Railway bucket, R2, MinIO): S3_ENDPOINT, S3_BUCKET, S3_REGION,
    S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY; S3_URL_STYLE path (default) or virtual-host (Railway buckets)."""

    def __init__(self):
        try:
            import boto3
            from botocore.config import Config
        except ImportError:
            raise ImportError_("--store s3 needs boto3: .venv/bin/pip install -r requirements.txt")
        missing = [v for v in ("S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY") if not os.environ.get(v)]
        if missing:
            raise ImportError_(f"--store s3: set {', '.join(missing)} (and S3_ENDPOINT / S3_REGION)")
        self.bucket = os.environ["S3_BUCKET"]
        self.client = boto3.client(
            "s3",
            endpoint_url=os.environ.get("S3_ENDPOINT") or None,
            region_name=os.environ.get("S3_REGION") or "auto",
            aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
            config=Config(s3={"addressing_style": s3_addressing_style(os.environ.get("S3_URL_STYLE"))}, retries={"max_attempts": 5}),
        )
        self.label = f"s3:{self.bucket}"
        self._errors = boto3.session.botocore.exceptions.ClientError

    def has(self, key, size):
        try:
            head = self.client.head_object(Bucket=self.bucket, Key=key)
            return head.get("ContentLength") == size
        except self._errors as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def put(self, key, path, mime):
        self.client.upload_file(str(path), self.bucket, key, ExtraArgs={"ContentType": mime})


def open_store(spec):
    if spec == "s3":
        return S3Store()
    if spec.startswith("fs:") and len(spec) > 3:
        return FsStore(spec[3:])
    raise ImportError_(f"--store must be fs:<dir> or s3, not {spec!r}")


def doc_index(pg, table, obj, entry_col, num_col, date_col, card_col):
    """Every document of one SAP table: [(entry, docnum, printed no, date, card, total, canceled)]."""
    total = "doctotal" if table not in ("ojdt",) else "loctotal"
    canceled = "canceled" if table not in ("ojdt",) else "'N'"
    card = card_col or "NULL"
    rows = pg.execute(f"""
        SELECT h.{entry_col}, h.{num_col}, erp.doc_no(n.seriesname, h.{num_col}), h.{date_col}, {card}, h.{total}, {canceled}
        FROM sap.{table} h LEFT JOIN sap.nnm1 n ON n.series = h.series""").fetchall()
    return rows


def link_attachments(pg, by_name, workers):
    """(links, stats). A link: dict(file, sap_object, doc_entry, doc_no, card_code, doc_date, role, link_method,
    confidence)."""
    links, stats = [], {"atc1_rows": 0, "atc1_found": 0, "atc1_missing": 0, "ccs_qr_rows": 0, "ccs_qr_found": 0,
                        "ccs_ewb_rows": 0, "ccs_ewb_found": 0, "print_files": 0, "print_linked": 0,
                        "print_several_docs_internal": 0, "print_rejected": collections.Counter()}

    def add(info, obj, entry, doc_no, card, date, role, method, confidence):
        links.append(dict(file=info, sap_object=obj, doc_entry=entry, doc_no=doc_no, card_code=card,
                          doc_date=date, role=role, link_method=method, confidence=confidence))

    # 1. ATC1, posted documents only
    for table, obj, entry_col, num_col, date_col, card_col in ATC_OBJECTS:
        card = f"h.{card_col}" if card_col else "NULL"
        rows = pg.execute(f"""
            SELECT h.{entry_col}, erp.doc_no(n.seriesname, h.{num_col}), {card}, h.{date_col},
                   a.filename, a.fileext
            FROM sap.{table} h
            JOIN sap.atc1 a ON a.absentry = h.atcentry
            LEFT JOIN sap.nnm1 n ON n.series = h.series
            WHERE h.atcentry IS NOT NULL AND h.atcentry <> 0""").fetchall()
        for entry, doc_no, cardcode, date, fname, fext in rows:
            stats["atc1_rows"] += 1
            name = f"{fname}.{fext}" if fext else (fname or "")
            info = by_name.get(name.lower())
            if not info:
                stats["atc1_missing"] += 1
                continue
            stats["atc1_found"] += 1
            role = "ewaybill" if obj == "13" and re.fullmatch(r"\d{12}\.pdf", info.name.lower()) else "supporting"
            add(info, obj, entry, doc_no, cardcode, date, role, "atc1", "exact")
    rows = pg.execute("""
        SELECT c.cardcode, c.createdate, a.filename, a.fileext FROM sap.ocrd c
        JOIN sap.atc1 a ON a.absentry = c.atcentry WHERE c.atcentry IS NOT NULL AND c.atcentry <> 0""").fetchall()
    for cardcode, date, fname, fext in rows:
        stats["atc1_rows"] += 1
        info = by_name.get((f"{fname}.{fext}" if fext else (fname or "")).lower())
        if not info:
            stats["atc1_missing"] += 1
            continue
        stats["atc1_found"] += 1
        add(info, "2", None, cardcode, cardcode, date, "supporting", "atc1", "exact")

    # 2. the e-invoice add-on: QR images (invoices and credit notes) and e-way bills (invoices)
    for base_type, table in (("13", "oinv"), ("14", "orin")):
        rows = pg.execute(f"""
            SELECT h.docentry, erp.doc_no(n.seriesname, h.docnum), h.cardcode, h.docdate, q.u_qrpath
            FROM sap.ccs_eoinv q
            JOIN sap.{table} h ON h.docentry = erp.int_or_null(q.u_baseentry)
            LEFT JOIN sap.nnm1 n ON n.series = h.series
            WHERE erp.int_or_null(q.u_basetype) = {int(base_type)} AND q.u_status = 'S'
              AND coalesce(q.u_qrpath, '') <> ''""").fetchall()
        for entry, doc_no, cardcode, date, qrpath in rows:
            stats["ccs_qr_rows"] += 1
            info = by_name.get(re.split(r"[\\/]", qrpath)[-1].lower())
            if info:
                stats["ccs_qr_found"] += 1
                add(info, base_type, entry, doc_no, cardcode, date, "einvoice_qr", "ccs_eoinv", "exact")
    rows = pg.execute("""
        SELECT h.docentry, erp.doc_no(n.seriesname, h.docnum), h.cardcode, h.docdate, e.u_ewbno
        FROM sap.ccs_eoewb e
        JOIN sap.oinv h ON h.docentry = erp.int_or_null(e.u_baseentry)
        LEFT JOIN sap.nnm1 n ON n.series = h.series
        WHERE erp.int_or_null(e.u_basetype) = 13 AND coalesce(e.u_ewbno, '') <> ''""").fetchall()
    for entry, doc_no, cardcode, date, ewbno in rows:
        stats["ccs_ewb_rows"] += 1
        info = by_name.get(f"{ewbno.strip()}.pdf".lower())
        if info:
            stats["ccs_ewb_found"] += 1
            add(info, "13", entry, doc_no, cardcode, date, "ewaybill", "ccs_eoewb", "exact")

    # 3. SAP print exports, matched by the number printed inside and checked against DocTotal
    prints = []
    for info in by_name.values():
        m = PRINT_NAME.match(info.name)
        if not m:
            continue
        kind = re.sub(r" \[Approved\]| - Cancellation| - Draft.*", "", m["kind"]).strip()
        if kind in PRINT_KINDS:
            prints.append((info, kind, m["docnum"], m["kind"]))
    stats["print_files"] = len(prints)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for (info, *_), text in zip(prints, pool.map(lambda p: pdf_text(p[0].path), prints)):
            info.text = text
    indexes = {}
    for info, kind, name_docnum, raw_kind in prints:
        table, obj, number_rx, role = PRINT_KINDS[kind]
        if table not in indexes:
            cfg = next(c for c in ATC_OBJECTS if c[0] == table)
            by_printed, by_num = collections.defaultdict(list), collections.defaultdict(list)
            for row in doc_index(pg, *cfg):
                if row[2]:
                    by_printed[row[2].upper()].append(row)
                by_num[str(row[1])].append(row)
            indexes[table] = (by_printed, by_num)
        by_printed, by_num = indexes[table]
        text = info.text or ""
        numbers = list(dict.fromkeys(re.findall(number_rx, text)))
        if not numbers and name_docnum:
            numbers = [name_docnum]
        if kind == "Incoming Payments" and name_docnum and name_docnum not in numbers:
            numbers.append(name_docnum)
        if not numbers:
            stats["print_rejected"]["no number in the text" if text.strip() else "no text layer"] += 1
            continue
        dates = {date_from(d) for d in PRINT_DATE.findall(text)} - {None}
        values = {money(v) for v in NET_VALUE.findall(text)}
        if kind == "Incoming Payments":
            amounts = [money(v) for v in PAID_AMOUNT.findall(text)]
            values = set(amounts) | ({sum(amounts)} if amounts else set())
        cancellation = "Cancellation" in raw_kind
        linked = False
        reason = "number not in SAP"
        several = len({n.strip().upper().rstrip(".,") for n in numbers}) > 1
        link_role = "supporting" if several and role in CUSTOMER_PRINT_ROLES else role
        for number in numbers:
            u = number.strip().upper().rstrip(".,")
            method = "content_doc_no"
            cands = list(by_printed.get(u, []))
            if not cands and re.fullmatch(r"\d{1,7}", u):
                cands = list(by_num.get(str(int(u)), []))
                method = "content_doc_no" if u in re.findall(number_rx, text) else "filename_docnum"
            if not cands:
                continue
            if len(cands) > 1 and dates:
                cands = [c for c in cands if c[3] in dates] or cands
            if len(cands) > 1:
                pref = [c for c in cands if (c[6] == "C") == cancellation]
                cands = pref or cands
            ok = [c for c in cands if c[5] is not None and any(abs(Decimal(c[5]) - v) < 1 for v in values)]
            if len(ok) != 1:
                reason = "printed value differs from DocTotal" if not ok and values else (
                    "no printed value" if not values else "number matches several documents")
                continue
            entry, _, doc_no, date, cardcode, _, _ = ok[0]
            add(info, obj, entry, doc_no, cardcode, date, link_role, method, "content")
            linked = True
        if linked:
            stats["print_linked"] += 1
            if link_role != role:
                stats["print_several_docs_internal"] += 1
        else:
            stats["print_rejected"][f"{kind}: {reason}"] += 1
    return links, stats


def date_from(parts):
    d, m, y = (int(p) for p in parts)
    try:
        return datetime(y, m, d).date()
    except ValueError:
        return None


def money(text):
    return Decimal(text.replace(",", ""))


def dedupe_links(links):
    """One link per (file, document, role); the strongest method wins (ATC1, then the add-on, then content)."""
    best = {}
    for link in sorted(links, key=lambda l: METHOD_RANK[l["link_method"]]):
        key = (link["file"].sha, link["sap_object"], link["doc_entry"], link["doc_no"] if link["doc_entry"] is None else None,
               link["role"])
        best.setdefault(key, link)
    return list(best.values())


def attachments(args):
    t0 = time.time()
    dirs = [Path(d).expanduser() for d in args.dir]
    for d in dirs:
        if not d.is_dir():
            raise ImportError_(f"--dir {d}: not a folder")
    if not shutil.which("pdftotext"):
        raise ImportError_("pdftotext not found (poppler-utils): it reads the SAP print exports")
    store = None if args.dry_run else open_store(args.store)

    log(f"walking {', '.join(str(d) for d in dirs)}")
    by_name, all_files = walk_archives(dirs)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for info, sha in zip(all_files, pool.map(lambda i: sha256_of(i.path), all_files)):
            info.sha = sha
    log(f"  {len(all_files):,} files hashed ({sum(f.size for f in all_files) / 1e6:,.1f} MB), "
        f"{len(by_name):,} distinct names, {len({f.sha for f in all_files}):,} distinct contents")

    with psycopg.connect(args.pg, autocommit=True) as pg:
        if not pg.execute("SELECT 1 FROM pg_namespace WHERE nspname = 'sap'").fetchone():
            raise ImportError_("schema sap does not exist: run `run.py sap` first")
        if not pg.execute("SELECT to_regprocedure('erp.doc_no(text, integer)')").fetchone()[0]:
            raise ImportError_("schema erp is missing: run `run.py sap` first")
        links, stats = link_attachments(pg, by_name, args.workers)
        links = dedupe_links(links)

        linked = {}
        for link in links:
            linked.setdefault(link["file"].sha, link["file"])
        # text excerpts for the linked PDFs not read yet (first two pages)
        todo = [i for i in linked.values() if i.ext == ".pdf" and i.text is None]
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for info, text in zip(todo, pool.map(lambda i: pdf_text(i.path, 2), todo)):
                info.text = text

        uploaded = skipped_present = 0
        bytes_uploaded = 0
        if store:
            log(f"uploading {len(linked):,} linked files to {store.label}")
            for n, info in enumerate(linked.values(), 1):
                key = storage_key(info)
                if store.has(key, info.size):
                    skipped_present += 1
                else:
                    store.put(key, info.path, MIME.get(info.ext, "application/octet-stream"))
                    uploaded += 1
                    bytes_uploaded += info.size
                if n % 250 == 0:
                    log(f"  {n:,}/{len(linked):,}")

        if not args.dry_run:
            source = {}
            for link in links:
                sha = link["file"].sha
                if sha not in source or METHOD_RANK[link["link_method"]] < METHOD_RANK[source[sha]]:
                    source[sha] = link["link_method"]
            with pg.transaction():
                pg.execute(ATT_SQL.read_text(encoding="utf-8"))
                pg.execute("TRUNCATE att.links, att.files")
                with pg.cursor() as cur:
                    with cur.copy("COPY att.files (sha256, storage_key, file_name, mime, size_bytes, kind, text_excerpt,"
                                  " source, file_time) FROM STDIN") as cp:
                        for sha, info in linked.items():
                            cp.write_row((sha, storage_key(info), info.name, MIME.get(info.ext, "application/octet-stream"),
                                          info.size, file_kind(info.name), excerpt(info.text),
                                          METHOD_SOURCE[source[sha]], file_time(info)))
                    with cur.copy("COPY att.links (sha256, sap_object, doc_entry, doc_no, card_code, doc_date, role,"
                                  " link_method, confidence) FROM STDIN") as cp:
                        for l in links:
                            cp.write_row((l["file"].sha, l["sap_object"], l["doc_entry"], l["doc_no"], l["card_code"],
                                          l["doc_date"], l["role"], l["link_method"], l["confidence"]))
                    info_rows = {
                        "folders": json.dumps([str(d) for d in dirs]),
                        "store": store.label,
                        "imported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "files": str(len(linked)),
                        "links": str(len(links)),
                    }
                    cur.execute("TRUNCATE att._import")
                    cur.executemany("INSERT INTO att._import (key, value) VALUES (%s, %s)", list(info_rows.items()))
            pg.execute("ANALYZE att.files")
            pg.execute("ANALYZE att.links")

    # ------------------------------------------------------------------ coverage report
    unlinked = [f for f in all_files if f.sha not in linked]
    log("\ncoverage")
    log(f"  files on disk            {len(all_files):>7,}  ({sum(f.size for f in all_files) / 1e6:,.1f} MB)")
    log(f"  linked                   {len(all_files) - len(unlinked):>7,}  "
        f"({len(linked):,} distinct contents, {sum(i.size for i in linked.values()) / 1e6:,.1f} MB to store)")
    log(f"  skipped, not linked      {len(unlinked):>7,}  ({sum(f.size for f in unlinked) / 1e6:,.1f} MB)")
    log(f"  ATC1 pointer rows (posted docs): {stats['atc1_rows']:,}; file in these folders {stats['atc1_found']:,}, "
        f"not here {stats['atc1_missing']:,}")
    log(f"  @CCS_EOINV QR rows: {stats['ccs_qr_rows']:,}; png here {stats['ccs_qr_found']:,}")
    log(f"  @CCS_EOEWB rows: {stats['ccs_ewb_rows']:,}; pdf here {stats['ccs_ewb_found']:,}")
    log(f"  SAP print exports: {stats['print_files']:,}; linked {stats['print_linked']:,}"
        f" ({stats['print_several_docs_internal']:,} carrying several document numbers, linked as internal 'supporting')")
    for reason, n in stats["print_rejected"].most_common():
        log(f"    not linked: {reason}: {n:,}")
    log("\n  links by object / role / method")
    counts = collections.Counter((l["sap_object"], l["role"], l["link_method"]) for l in links)
    docs = collections.defaultdict(set)
    for l in links:
        docs[(l["sap_object"], l["role"], l["link_method"])].add(l["doc_entry"] if l["doc_entry"] is not None else l["doc_no"])
    for (obj, role, method), n in sorted(counts.items(), key=lambda kv: (int(kv[0][0]), kv[0][1], kv[0][2])):
        log(f"    {OBJECT_NAMES.get(obj, obj):<17} {role:<16} {method:<15} {n:>6,} links  {len(docs[(obj, role, method)]):>6,} documents")
    why = collections.Counter(unlinked_reason(f, by_name) for f in unlinked)
    log("\n  skipped files by reason")
    for reason, n in why.most_common():
        log(f"    {reason:<55} {n:>6,}")
    if store:
        log(f"\nstore {store.label}: uploaded {uploaded:,} files ({bytes_uploaded / 1e6:,.1f} MB), "
            f"{skipped_present:,} already there")
    elif args.dry_run:
        log("\n--dry-run: nothing uploaded, att untouched")
    log(f"attachments finished in {time.time() - t0:.1f}s")
    return 0


def unlinked_reason(info, by_name):
    if by_name.get(info.name.lower()) is not info:
        return "same name as a file in a preferred folder"
    kind = file_kind(info.name)
    if kind == "einvoice_qr":
        return "QR image with no successful @CCS_EOINV row"
    if kind == "ewaybill":
        return "e-way bill no @CCS_EOEWB row / ATC1 pointer names"
    if kind == "sap_print":
        printed = re.sub(r" \[Approved\]| - Cancellation| - Draft.*", "", PRINT_NAME.match(info.name)["kind"]).strip()
        if printed in PRINT_KINDS and " - Draft" not in info.name:
            return "SAP print not matched to a document (see above)"
        return "SAP print of a draft, journal entry or account statement"
    return "not referenced by a posted document (ATC1)"


# --------------------------------------------------------------------------- hr

def hr(args):
    """The HR spreadsheets -> schema hr (hr_import.py). Loaded by path: `python -I` keeps this folder off sys.path."""
    spec = importlib.util.spec_from_file_location("hr_import", HERE / "hr_import.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        return module.run(args)
    except module.HrError as e:
        raise ImportError_(str(e))


# --------------------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sap", help="load a backup into sap_next, gate it, swap it in as sap + erp")
    s.add_argument("--backup", default=DEFAULT_BACKUP)
    s.add_argument("--pg", default=DEFAULT_PG)
    s.add_argument("--no-swap", action="store_true", help="keep sap_next for inspection; leave sap/erp untouched")
    s.add_argument("--gates", default=DEFAULT_GATES, help="local YAML with this backup's expected figures")
    v = sub.add_parser("verify", help="re-run the gates and erp contract checks on sap / erp")
    v.add_argument("--pg", default=DEFAULT_PG)
    v.add_argument("--gates", default=DEFAULT_GATES, help="local YAML with this backup's expected figures")
    d = sub.add_parser("ddl", help="write the sap schema DDL (no data)")
    d.add_argument("--out", required=True)
    d.add_argument("--backup", default=DEFAULT_BACKUP, help="backup whose metadata gives the column types")
    e = sub.add_parser("erp", help="rebuild the erp views over the loaded sap (after changing sql/erp)")
    e.add_argument("--pg", default=DEFAULT_PG)
    a = sub.add_parser("attachments", help="link SAP attachment files to documents, upload them, write schema att")
    a.add_argument("--dir", action="append", required=True,
                   help="an extracted attachments folder (repeat for several archives, e.g. the August one too)")
    a.add_argument("--pg", default=DEFAULT_PG)
    a.add_argument("--store", default=os.environ.get("FILE_STORE", "fs:" + str(HERE.parent.parent / "backend" / "data" / "files")),
                   help="fs:<dir> (local folder) or s3 (S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)")
    a.add_argument("--workers", type=int, default=8, help="parallel hashing / pdftotext processes")
    a.add_argument("--dry-run", action="store_true", help="link and report only: no upload, att untouched")
    h = sub.add_parser("hr", help="load the HR spreadsheets (payroll, attendance, leave, peeling) into schema hr")
    h.add_argument("--dir", required=True, help="the folder with the HR .xlsx / .xlsm exports")
    h.add_argument("--pg", default=DEFAULT_PG)
    h.add_argument("--joins", default=DEFAULT_HR_JOINS,
                   help="local YAML pairing register codes with Voyon codes (never in the repo)")
    h.add_argument("--gates", default=DEFAULT_GATES, help="local YAML whose hr_checks hold the expected real figures")
    h.add_argument("--month", help="YYYY-MM for a payroll or temporary-wages file whose name carries no month")
    h.add_argument("--dry-run", action="store_true", help="read, gate and report only; write nothing")
    args = p.parse_args()
    try:
        return {"sap": load, "verify": verify, "ddl": ddl, "erp": rebuild_erp, "attachments": attachments,
                "hr": hr}[args.cmd](args)
    except ImportError_ as e:
        log(f"\nIMPORT FAILED: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
