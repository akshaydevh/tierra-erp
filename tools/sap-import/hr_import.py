"""`run.py hr`: the HR spreadsheets -> schema `hr` (sql/hr.sql). Payroll and attendance are not in SAP.

Reads every .xlsx / .xlsm in --dir and recognises each workbook by its sheets and headers, never by a fixed cell:

  voyon_attendance  the Voyon punch report: the employee master (TF codes, department, designation, reporting officer)
                    and one day's punch status
  voyon_payroll     the Voyon payroll export for a month (approved / earned components, PF, ESI, net) with its totals row
  leave             the Voyon leave-request report
  register          the salary register: one Salary-* sheet per category (net per person, a totals row) and the ATTN
                    sheet (a code per person per day, with the sheet's own COUNTIF columns)
  temp_sheet        the temporary workers' wages sheet (factory block and sales-promotion block, names only)
  peeling           the peeling register: kg per worker per day, the incentive per day and the incentive summary

Anything else (the labour-cost matrix) is skipped and listed. The files are untrusted input: they are opened with
openpyxl in read-only mode for their cached values; macros and formulas are never run.

Every figure is gated against the workbook's own totals before anything is written (see `gates`); the real expected
figures for a given month live in ~/tierra-data/gates.local.yaml (`hr_checks`), never in the repo. The same people carry
a Voyon code (TF…) and a register code (T… / TFL…); the joins that names cannot make live in ~/tierra-data/hr-joins.yaml.
"""
import calendar
import collections
import json
import re
import unicodedata
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

import openpyxl
import psycopg
import yaml

HERE = Path(__file__).resolve().parent
HR_SQL = HERE / "sql" / "hr.sql"
TOLERANCE = Decimal("1")  # rupees: sheets round per line, totals rows do not

MONTHS = {m.lower(): i for i, m in enumerate(calendar.month_name) if m}
MONTHS.update({m.lower(): i for i, m in enumerate(calendar.month_abbr) if m})
REGISTER_CODE = re.compile(r"^(?:TFL|T)\d+$", re.I)
VOYON_CODE = re.compile(r"^TF\d+$", re.I)
ATTENDANCE_CODES = {"P": "P", "OD": "OD", "EL": "EL", "LWP": "LWP", "CL": "CL", "C/OFF": "C/off", "C-OFF": "C/off",
                    "ESIC": "ESIC", "PH": "PH", "W/OFF": "W/OFF", "W-OFF": "W/OFF", "WOFF": "W/OFF", "OFFDAY": "Offday"}


class HrError(Exception):
    pass


def log(msg=""):
    print(msg, flush=True)


# --------------------------------------------------------------------------- cells

def num(value):
    """A cell as Decimal, or None: numbers, "1,23,456.00" text; not booleans, errors (#REF!) or other text."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str):
        s = value.strip().replace(",", "")
        if re.fullmatch(r"-?\d+(?:\.\d+)?", s):
            return Decimal(s)
    return None


def money(value):
    n = num(value)
    return Decimal(0) if n is None else n.quantize(Decimal("0.01"))


def text(value):
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    s = str(value).strip()
    return s or None


def label(value):
    """A header cell for matching: lower case, no spaces."""
    s = text(value)
    return re.sub(r"\s+", "", s.lower()) if s else ""


def name_key(value):
    s = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z]+", " ", s).split())


def loose_key(value):
    """Spelling drift between the files: initials, 'h' (Zarina / Zharina), doubled letters, word order."""
    words = [w for w in name_key(value).split() if len(w) > 1]
    words = [re.sub(r"(.)\1+", r"\1", w.replace("h", "")) for w in words]
    return " ".join(sorted(words))


def compact_key(value):
    """Words run together and y/i drift: 'Velora Kumari P' = 'Velorakumari P', 'Quenly G' = 'Quenli G'."""
    words = [w for w in name_key(value).split() if len(w) > 1]
    return re.sub(r"(.)\1+", r"\1", "".join(words).replace("h", "").replace("y", "i"))


def as_date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    s = text(value)
    if not s:
        return None
    m = re.fullmatch(r"(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})", s)
    if m:
        d, mo, y = (int(x) for x in m.groups())
        y = y + 2000 if y < 100 else y
        try:
            return date(y, mo, d)
        except ValueError:
            return None
    return None


def month_in(textual):
    """'SALARY REGISTER June 2026', '... June 26- Peeling', 'hr-payroll-voyon-2026-06' -> date(2026, 6, 1)."""
    s = str(textual or "")
    m = re.search(r"(20\d\d)[-_](0[1-9]|1[0-2])(?!\d)", s)
    if m:
        return date(int(m[1]), int(m[2]), 1)
    for word, y in re.findall(r"\b([A-Za-z]{3,9})\b\D{0,3}(\d{2,4})\b", s):
        if word.lower() in MONTHS:
            y = int(y)
            return date(y + 2000 if y < 100 else y, MONTHS[word.lower()], 1)
    return None


# --------------------------------------------------------------------------- workbooks

class Book:
    """A workbook's sheets as lists of rows (cached values only)."""

    def __init__(self, path):
        self.path = Path(path)
        try:
            self.wb = openpyxl.load_workbook(self.path, read_only=True, data_only=True, keep_links=False)
        except Exception as e:  # noqa: BLE001 - a broken file is reported, not fatal
            raise HrError(f"{self.path.name}: cannot read ({e.__class__.__name__}: {e})")
        self.names = list(self.wb.sheetnames)
        self._rows = {}

    def rows(self, sheet, max_row=None):
        key = (sheet, max_row)
        if key not in self._rows:
            ws = self.wb[sheet]
            self._rows[key] = [list(r) for r in ws.iter_rows(values_only=True, max_row=max_row)]
        return self._rows[key]

    def head(self, sheet, n=12):
        return self.rows(sheet, max_row=n)

    def close(self):
        self.wb.close()


def find_row(rows, *labels, limit=15):
    """Index of the first row (within `limit`) that has every label (header cells compared without spaces/case)."""
    want = [label(x) for x in labels]
    for i, row in enumerate(rows[:limit]):
        have = {label(c) for c in row}
        if all(w in have for w in want):
            return i
    return None


def classify(book):
    names = book.names
    if any(n.strip().upper().startswith("ATTN") for n in names) or any(n.lower().startswith("salary-") for n in names):
        return "register"
    if any(n.strip().lower() == "peeling banana" for n in names):
        return "peeling"
    first = book.head(names[0])
    if find_row(first, "Employee ID", "Check In") is not None:
        return "voyon_attendance"
    if find_row(first, "Employee ID", "Net Salary") is not None:
        return "voyon_payroll"
    if find_row(first, "Employee ID", "Leave Type") is not None:
        return "leave"
    if find_row(first, "Name", "Days", "Wages") is not None:
        return "temp_sheet"
    return None


def columns(row):
    return {label(c): i for i, c in reversed(list(enumerate(row))) if label(c)}


def cell(row, i):
    return row[i] if i is not None and i < len(row) else None


# --------------------------------------------------------------------------- parsers

def parse_voyon_attendance(book):
    sheet = book.names[0]
    rows = book.rows(sheet)
    h = find_row(rows, "Employee ID", "Check In")
    col = columns(rows[h])
    out = []
    for row in rows[h + 1:]:
        code = text(cell(row, col.get("employeeid")))
        if not code:
            continue
        if not VOYON_CODE.match(code):
            raise HrError(f"{book.path.name}: employee code {code!r} is not a Voyon code")
        out.append(dict(code=code.upper(), name=text(cell(row, col.get("employeename"))) or code,
                        department=text(cell(row, col.get("department"))),
                        designation=text(cell(row, col.get("designation"))),
                        reporting_officer=text(cell(row, col.get("reportingofficer"))),
                        punch_in=text(cell(row, col.get("checkin"))), punch_out=text(cell(row, col.get("checkout"))),
                        status=text(cell(row, col.get("status")))))
    return out


VOYON_FIELDS = {
    "basicpay(a)": "basic", "da(a)": "da", "hra(a)": "hra", "conveyanceallowance(a)": "conveyance",
    "specialallowance(a)": "special", "gross(a)": "gross_fixed", "gross(e)": "gross_earned",
    "performanceincentive(va)": "performance_incentive", "peelingincentive(va)": "peeling_incentive",
    "offdaywork(va)": "off_day_work", "attendanceincentive(va)": "attendance_incentive",
    "totalearning": "total_earning", "lop(vd)": "lop", "tds(vd)": "tds", "salaryadvance(vd)": "advance",
    "pf(sd)": "pf", "esi(sd)": "esi", "totaldeductionwithoutlop": "total_deductions", "netsalary": "net",
}


def parse_voyon_payroll(book, month):
    sheet = book.names[0]
    rows = book.rows(sheet)
    h = find_row(rows, "Employee ID", "Net Salary")
    head = rows[h]
    col = columns(head)
    numeric = [i for i, c in enumerate(head) if label(c) and label(c) not in
               ("employeeid", "employee", "businessunit", "department", "designation", "category", "remarks")]
    lines, totals = [], None
    for r, row in enumerate(rows[h + 1:], h + 2):
        code = text(cell(row, col["employeeid"]))
        if not code:
            if any(num(cell(row, i)) is not None for i in numeric):
                totals = {label(head[i]): num(cell(row, i)) for i in numeric}
                break
            continue
        line = dict(code=code.upper(), name=text(cell(row, col.get("employee"))) or code,
                    department=text(cell(row, col.get("department"))),
                    designation=text(cell(row, col.get("designation"))),
                    voyon_category=text(cell(row, col.get("category"))),
                    days_paid=num(cell(row, col.get("paydays"))), unpaid_days=num(cell(row, col.get("unpaiddays"))))
        other_earn = other_ded = Decimal(0)
        for i in numeric:
            key = label(head[i])
            field = VOYON_FIELDS.get(key)
            if field:
                line[field] = money(cell(row, i))
            elif key.endswith("(va)"):
                other_earn += money(cell(row, i))
            elif key.endswith("(vd)") or key.endswith("(sd)"):
                other_ded += money(cell(row, i))
        line["other_earnings"] = other_earn
        line["other_deductions"] = other_ded
        line["category"] = line["department"] or "Unassigned"
        line["column_values"] = {label(head[i]): num(cell(row, i)) for i in numeric}
        lines.append(line)
    if "netsalary" not in col:
        raise HrError(f"{book.path.name}: no Net Salary column")
    return dict(kind="voyon_payroll", month=month, file=book.path.name, lines=lines, totals=totals or {},
                labels={label(head[i]): text(head[i]) for i in numeric})


def parse_leave(book):
    sheet = book.names[0]
    rows = book.rows(sheet)
    h = find_row(rows, "Employee ID", "Leave Type")
    col = columns(rows[h])
    out = []
    for row in rows[h + 1:]:
        code = text(cell(row, col["employeeid"]))
        kind = text(cell(row, col["leavetype"]))
        if not code or not kind:
            continue
        stamp = cell(row, col.get("transactiondate"))
        out.append(dict(code=code.upper(), name=text(cell(row, col.get("employee"))), leave_type=kind,
                        requested_at=stamp if isinstance(stamp, datetime) else None,
                        from_date=as_date(cell(row, col.get("fromdate"))), to_date=as_date(cell(row, col.get("todate"))),
                        days=num(cell(row, col.get("numberofleaveday(s)"))),
                        reason=text(cell(row, col.get("reasonforleave"))),
                        requested_by=(text(cell(row, col.get("requestedby"))) or "").upper() or None,
                        status=text(cell(row, col.get("status")))))
    return out


def register_category(sheet):
    s = sheet.lower()
    for word, key in (("office", "office_admin"), ("peeling", "peeling"), ("production", "production"),
                      ("promotion", "sales_promotion")):
        if word in s:
            return key
    return re.sub(r"[^a-z]+", "_", s.replace("salary-", "")).strip("_") or "other"


def register_field(key):
    """The payroll_lines field a register column feeds, or None."""
    if key.startswith("no.ofdayspaid") or key == "dayspaid":
        return "days_paid"
    exact = {"basic": "basic", "da": "da", "hra": "hra", "conveyance": "conveyance", "grosssalary": "gross_fixed",
             "grossactual": "gross_earned", "offdaywork": "off_day_work", "overtime": "overtime",
             "totalremuneration": "total_earning", "esi": "esi", "tds": "tds", "salaryadvance": "advance",
             "totaldeductions": "total_deductions", "netsalary": "net"}
    if key in exact:
        return exact[key]
    if key.startswith("spl") and "incentive" not in key:
        return "special"
    if key.startswith("pf"):
        return "pf"
    if "after" in key:  # "Salary After Statutory Deductions": an intermediate, not a component
        return None
    if "attendance" in key:
        return "attendance_incentive"
    if "performance" in key:
        return "performance_incentive"
    if "peeling" in key:
        return "peeling_incentive"
    if "production" in key:
        return "production_incentive"
    if "incentive" in key or key.startswith("arrear"):
        return "other_earnings"
    if key in ("pt", "canteenexpenses", "mobiledeductions", "otherdeductions") or key.startswith("deduction"):
        return "other_deductions"
    return None


def parse_register_sheet(book, sheet):
    rows = book.rows(sheet)
    h = find_row(rows, "Emp Code")
    if h is None:
        raise HrError(f"{book.path.name} / {sheet}: no 'Emp Code' header")
    head, sub = rows[h], rows[h + 1] if h + 1 < len(rows) else []
    width = max(len(head), len(sub))
    labels = [label(cell(sub, i)) or label(cell(head, i)) for i in range(width)]
    net_col = next((i for i, k in enumerate(labels) if k == "netsalary"), None)
    if net_col is None:
        raise HrError(f"{book.path.name} / {sheet}: no NET SALARY column")
    code_col = next(i for i in range(width) if label(cell(head, i)) == "empcode")
    name_col = next((i for i in range(width) if label(cell(head, i)) == "employeename"), code_col + 1)
    fields, used = {}, set()
    for i in range(net_col + 1):
        f = register_field(labels[i])
        if not f or i in (code_col, name_col):
            continue
        if f in ("other_earnings", "other_deductions", "peeling_incentive", "production_incentive",
                 "attendance_incentive", "performance_incentive"):
            fields.setdefault(f, []).append(i)
        elif f not in used:
            fields[f] = [i]
            used.add(f)
    desig_col = next((i for i in range(width) if label(cell(head, i)) == "designation"), None)
    doj_col = next((i for i in range(width) if label(cell(head, i)) == "doj"), None)
    lines, broken, total = [], [], None
    for r, row in enumerate(rows[h + 2:], h + 3):
        code = text(cell(row, code_col))
        if code and REGISTER_CODE.match(code):
            line = dict(code=code.upper(), name=text(cell(row, name_col)) or code, sheet=sheet, row=r,
                        designation=text(cell(row, desig_col)), date_of_joining=as_date(cell(row, doj_col)))
            for f, cols in fields.items():
                if f == "days_paid":
                    line[f] = num(cell(row, cols[0]))
                else:
                    line[f] = sum((money(cell(row, i)) for i in cols), Decimal(0))
            lines.append(line)
        elif code:
            broken.append(dict(code=code, row=r, net=money(cell(row, net_col))))
        elif lines and num(cell(row, net_col)) is not None:
            total = num(cell(row, net_col))
            break
    title = " ".join(str(c) for r in rows[:h] for c in r if isinstance(c, str))
    return dict(sheet=sheet, category=register_category(sheet), lines=lines, broken=broken, total_net=total,
                month=month_in(title))


def parse_attn(book, sheet):
    rows = book.rows(sheet)
    h = find_row(rows, "Emp. Code")
    if h is None:
        raise HrError(f"{book.path.name} / {sheet}: no 'Emp. Code' header")
    month = next((as_date(c) for r in rows[:h] for c in r if isinstance(c, (datetime, date))), None)
    if month is None:
        raise HrError(f"{book.path.name} / {sheet}: no month date above the grid")
    month = month.replace(day=1)
    head = rows[h]
    code_col = next(i for i, c in enumerate(head) if label(c) == "emp.code")
    name_col = next((i for i, c in enumerate(head) if label(c) == "nameofemployee"), code_col + 1)
    days = {}
    for i, c in enumerate(head):
        n = num(c)
        if i > name_col and n is not None and n == int(n) and 1 <= n <= 31 and int(n) not in days.values():
            days[i] = int(n)
    last_day = calendar.monthrange(month.year, month.month)[1]
    summary = {k: i for i, c in enumerate(head) for k in [label(c)] if k and i > max(days, default=0)}
    out, problems = [], []
    for r, row in enumerate(rows[h + 1:], h + 2):
        code = text(cell(row, code_col))
        if not code or not REGISTER_CODE.match(code):
            continue
        marks = {}
        for i, d in days.items():
            raw = text(cell(row, i))
            if not raw:
                continue
            if d > last_day:
                problems.append(f"{code}: a code on day {d} of a {last_day}-day month")
                continue
            marks[month.replace(day=d)] = ATTENDANCE_CODES.get(raw.upper().replace(" ", ""), raw)
        counts = collections.Counter(marks.values())
        checks = [("no.ofworkingdays", counts["P"] + counts["Offday"]), ("cl", counts["CL"]), ("el", counts["EL"]),
                  ("ph", counts["PH"]), ("w/off", counts["W/OFF"]), ("lwp", counts["LWP"] + counts["ESIC"]),
                  ("offdays", counts["Offday"])]
        for key, mine in checks:
            theirs = num(cell(row, summary.get(key)))
            if theirs is not None and theirs != mine:
                problems.append(f"{code} {key}: grid {mine}, sheet {theirs}")
        out.append(dict(code=code.upper(), name=text(cell(row, name_col)) or code, marks=marks))
    return dict(month=month, rows=out, problems=problems)


def parse_register(book):
    sheets = [s for s in book.names if s.lower().startswith("salary-") or "promotion" in s.lower()]
    attn = [s for s in book.names if s.strip().upper().startswith("ATTN")]
    out = dict(kind="register", file=book.path.name, sheets=[parse_register_sheet(book, s) for s in sheets],
               attn=[parse_attn(book, s) for s in attn])
    return out


TEMP_FIELDS = {"days": "days_paid", "wages": "gross_earned", "peelingincentive": "peeling_incentive",
               "attendanceinentive": "attendance_incentive", "attendanceincentive": "attendance_incentive",
               "attendancebaseincentive": "attendance_incentive", "total": "total_earning", "esi": "esi",
               "adv": "advance", "advance": "advance", "net": "net"}


def parse_temp_sheet(book, month):
    sheet = book.names[0]
    rows = book.rows(sheet)
    h = find_row(rows, "Days", "Wages")
    head = rows[h]
    day_cols = [i for i, c in enumerate(head) if label(c) == "days"]
    blocks = []
    for n, dcol in enumerate(day_cols):
        end = day_cols[n + 1] if n + 1 < len(day_cols) else len(head)
        fields = {}
        for i in range(dcol, end):
            f = TEMP_FIELDS.get(label(head[i]))
            if f and f not in fields.values():
                fields[i] = f
        name_col = dcol - 1
        tag = " ".join(str(c) for r in rows[: h + 1] for c in r[max(0, name_col - 2): dcol] if isinstance(c, str))
        block = "sales_promotion_temp" if "promotion" in tag.lower() else "temporary"
        people, last = [], None
        for r in range(h + 1, len(rows)):
            row = rows[r]
            nm = cell(row, name_col)
            if isinstance(nm, str) and nm.strip() and not re.fullmatch(r"\d+", nm.strip()) and "*" not in nm:
                line = dict(name=nm.strip(), row=r + 1, category=block)
                for i, f in fields.items():
                    line[f] = num(cell(row, i)) if f == "days_paid" else money(cell(row, i))
                people.append(line)
                last = r
        totals = {}
        if last is not None:
            for i, f in fields.items():
                for r in range(last + 1, min(last + 4, len(rows))):
                    v = num(cell(rows[r], i))
                    if v is not None:
                        totals[f] = v
                        break
        blocks.append(dict(block=block, lines=people, totals=totals))
    return dict(kind="temp_sheet", month=month, file=book.path.name, blocks=blocks)


def slab_incentive(kg, worker_class):
    """The peeling register's slabs (payroll-artifacts-deep-dive.md §4): permanent 161-200 kg x 0.25, 201-500 kg x 0.75;
    everyone else from 150 kg x 0.75."""
    if worker_class == "permanent":
        if Decimal(161) <= kg <= Decimal(200):
            return kg * Decimal("0.25")
        if Decimal(201) <= kg <= Decimal(500):
            return kg * Decimal("0.75")
        return Decimal(0)
    return kg * Decimal("0.75") if kg >= Decimal(150) else Decimal(0)


def date_columns(rows, limit=8):
    for i, row in enumerate(rows[:limit]):
        cols = {j: as_date(c) for j, c in enumerate(row) if isinstance(c, (datetime, date))}
        if len(cols) >= 2:
            return i, cols
    return None, {}


def parse_peeling(book):
    sheet = next(s for s in book.names if s.strip().lower() == "peeling banana")
    rows = book.rows(sheet)
    d_row, dates = date_columns(rows)
    if d_row is None:
        raise HrError(f"{book.path.name} / {sheet}: no row of dates")
    workers = []
    for r in range(d_row + 1, len(rows)):
        nm = text(cell(rows[r], 0))
        if not nm:
            continue
        if nm.lower().startswith("total"):
            break
        kg = {d: num(cell(rows[r], j)) for j, d in dates.items()}
        workers.append(dict(row=r + 1, name=nm, kg={d: v for d, v in kg.items() if v}))
    month = min(dates.values()).replace(day=1)

    # classes from the incentive summary: temporary names in one column, permanent in another, each with a total
    classes, summary = {}, {}
    summ = next((s for s in book.names if s.strip().lower() == "incentive summary"), None)
    if summ:
        srows = book.rows(summ)
        for j, c in enumerate(srows[0] if srows else []):
            k = label(c)
            cls = "temporary" if k.startswith("tempor") else "permanent" if k.startswith("perman") else None
            if not cls:
                continue
            for r in range(1, len(srows)):
                nm = text(cell(srows[r], j))
                if nm and nm.lower() == "total":
                    summary[cls] = num(cell(srows[r], j + 1))
                    break
                if nm:
                    classes.setdefault(name_key(nm), cls)
                elif num(cell(srows[r], j + 1)) is not None and r > 2 and cls not in summary and \
                        not text(cell(srows[r + 1] if r + 1 < len(srows) else [], j)):
                    summary[cls] = num(cell(srows[r], j + 1))
                    break
    for w in workers:
        w["class"] = classes.get(name_key(w["name"]), "group" if summ else "unknown")

    # the incentive per day, from the Incentive sheet when its rows line up with the register's
    inc = next((s for s in book.names if s.strip().lower() == "incentive"), None)
    source, rule_misses = "slabs", 0
    if inc:
        irows = book.rows(inc)
        i_row, idates = date_columns(irows)
        named = [(r, text(cell(irows[r], 0))) for r in range((i_row or 0) + 1, len(irows))
                 if text(cell(irows[r], 0)) and not text(cell(irows[r], 0)).lower().startswith("total")]
        if i_row is not None and len(named) >= len(workers) and \
                all(name_key(n) == name_key(w["name"]) for (_, n), w in zip(named, workers)):
            source = "incentive sheet"
            by_date = {d: j for j, d in idates.items()}
            for (r, _), w in zip(named, workers):
                w["incentive"] = {d: money(cell(irows[r], by_date[d])) if d in by_date else Decimal(0) for d in w["kg"]}
    for w in workers:
        rule = {d: slab_incentive(kg, w["class"]).quantize(Decimal("0.01")) for d, kg in w["kg"].items()}
        if "incentive" not in w:
            w["incentive"] = rule
        rule_misses += sum(1 for d in w["kg"] if abs(rule[d] - w["incentive"][d]) > Decimal("0.05"))
    return dict(kind="peeling", file=book.path.name, month=month, workers=workers, summary=summary,
                source=source, rule_misses=rule_misses)


# --------------------------------------------------------------------------- the people

def load_joins(path):
    p = Path(path).expanduser()
    if not p.exists():
        return None, {}
    with open(p, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    pairs = {}
    for entry in data.get("joins") or []:
        v, r = str(entry.get("voyon", "")).strip().upper(), str(entry.get("register", "")).strip().upper()
        if v and r:
            pairs[r] = v
    return p, pairs


class People:
    """Builds hr.employees and hr.temp_workers and resolves every code / name in the files to an id."""

    def __init__(self, joins):
        self.joins = joins
        self.emp = {}            # employee_id -> row
        self.by_register = {}    # register code -> employee_id
        self.unmatched_register = []
        self.join_methods = collections.Counter()
        self.temps = {}          # (block, name_key) -> row

    def add_voyon(self, code, name, source, **fields):
        row = self.emp.get(code)
        if row is None:
            row = self.emp[code] = dict(employee_id=code, name=name, name_key=name_key(name), code_voyon=code,
                                        code_register=None, department=None, designation=None,
                                        reporting_officer=None, reporting_officer_id=None, category=None,
                                        employment="permanent", date_of_joining=None, on_voyon_payroll=False,
                                        punch_status=None, punch_in=None, punch_out=None, matched_by=None, sources=[])
        for k, v in fields.items():
            if v is not None and row.get(k) in (None, False):
                row[k] = v
        if source not in row["sources"]:
            row["sources"].append(source)
        return row

    def _unique(self, key_fn, name):
        k = key_fn(name)
        hits = [e for e in self.emp.values() if e["code_voyon"] and not e["code_register"] and key_fn(e["name"]) == k]
        return hits[0] if len(hits) == 1 else None

    def add_register(self, code, name, source, **fields):
        if code in self.by_register:
            row = self.emp[self.by_register[code]]
        else:
            row, method = None, None
            target = self.joins.get(code)
            if target and target in self.emp and not self.emp[target]["code_register"]:
                row, method = self.emp[target], "joins_file"
            if row is None:
                row, method = self._unique(name_key, name), "name"
            if row is None:
                row, method = self._unique(loose_key, name), "loose_name"
            if row is None:
                row, method = self._unique(compact_key, name), "loose_name"
            if row is None:
                method = None
                row = self.emp[code] = dict(employee_id=code, name=name, name_key=name_key(name), code_voyon=None,
                                            code_register=code, department=None, designation=None,
                                            reporting_officer=None, reporting_officer_id=None, category=None,
                                            employment="permanent", date_of_joining=None, on_voyon_payroll=False,
                                            punch_status=None, punch_in=None, punch_out=None, matched_by=None,
                                            sources=[])
                self.unmatched_register.append((code, name))
            row["code_register"] = code
            row["matched_by"] = method
            self.join_methods[method or "register only"] += 1
            self.by_register[code] = row["employee_id"]
        for k, v in fields.items():
            if v is not None and row.get(k) is None:
                row[k] = v
        if source not in row["sources"]:
            row["sources"].append(source)
        return row["employee_id"]

    def resolve_officers(self):
        by_name = collections.defaultdict(list)
        for e in self.emp.values():
            if e["code_voyon"]:
                by_name[e["name_key"]].append(e["employee_id"])
        for e in self.emp.values():
            if e["reporting_officer"]:
                hits = by_name.get(name_key(e["reporting_officer"]), [])
                e["reporting_officer_id"] = hits[0] if len(hits) == 1 else None

    def temp(self, block, name):
        key = (block, name_key(name))
        if key not in self.temps:
            exact = [e for e in self.emp.values() if e["name_key"] == key[1]]
            self.temps[key] = dict(worker_id=f"TMP-{len(self.temps) + 1:03d}", name=name, name_key=key[1], block=block,
                                   employee_id=exact[0]["employee_id"] if len(exact) == 1 else None)
        return self.temps[key]["worker_id"]

    def peeler(self, name, worker_class):
        """A peeling-register name -> one employee / temp worker id, or None when it is not exactly one person."""
        k, lk = name_key(name), loose_key(name)
        if worker_class == "temporary":
            hits = [t["worker_id"] for t in self.temps.values() if t["name_key"] == k]
            if len(hits) == 1:
                return hits[0]
        pool = [e for e in self.emp.values() if worker_class != "permanent" or e["category"] in (None, "peeling", "production")]
        for fn, key in ((lambda e: e["name_key"], k), (lambda e: loose_key(e["name"]), lk),
                        (lambda e: compact_key(e["name"]), compact_key(name))):
            hits = [e["employee_id"] for e in pool if fn(e) == key]
            if len(hits) == 1:
                return hits[0]
        return None


# --------------------------------------------------------------------------- build

def build(args):
    """Reads the folder; returns (dataset, report lines, gate results). Nothing is written."""
    folder = Path(args.dir).expanduser()
    if not folder.is_dir():
        raise HrError(f"--dir {folder}: not a folder")
    files = sorted(p for p in folder.iterdir() if p.is_file() and not p.name.startswith("~$")
                   and p.suffix.lower() in (".xlsx", ".xlsm"))
    if not files:
        raise HrError(f"--dir {folder}: no .xlsx / .xlsm files")
    joins_path, joins = load_joins(args.joins)
    parsed = collections.defaultdict(list)
    skipped = []
    for p in files:
        book = Book(p)
        try:
            kind = classify(book)
            fallback = month_in(p.stem) or (date.fromisoformat(args.month + "-01") if args.month else None)
            if kind is None:
                skipped.append((p.name, f"not a recognised HR export (sheets: {', '.join(book.names[:4])})"))
            elif kind == "voyon_attendance":
                parsed[kind].append(dict(file=p.name, rows=parse_voyon_attendance(book)))
            elif kind == "voyon_payroll":
                if not fallback:
                    raise HrError(f"{p.name}: no month in the file name; pass --month YYYY-MM")
                parsed[kind].append(parse_voyon_payroll(book, fallback))
            elif kind == "leave":
                parsed[kind].append(dict(file=p.name, rows=parse_leave(book)))
            elif kind == "register":
                parsed[kind].append(parse_register(book))
            elif kind == "temp_sheet":
                if not fallback:
                    raise HrError(f"{p.name}: no month in the file name; pass --month YYYY-MM")
                parsed[kind].append(parse_temp_sheet(book, fallback))
            elif kind == "peeling":
                parsed[kind].append(parse_peeling(book))
        finally:
            book.close()

    people = People(joins)
    gates = []  # (name, kind, ok, detail)
    for att in parsed["voyon_attendance"]:
        codes = collections.Counter(r["code"] for r in att["rows"])
        dup = [c for c, n in codes.items() if n > 1]
        gates.append((f"Voyon master codes unique ({att['file']})", "hard", not dup,
                      f"{len(codes)} employees" + (f"; repeated {dup}" if dup else "")))
        for r in att["rows"]:
            people.add_voyon(r["code"], r["name"], "voyon_master", department=r["department"],
                             designation=r["designation"], reporting_officer=r["reporting_officer"],
                             punch_status=r["status"], punch_in=r["punch_in"], punch_out=r["punch_out"])

    runs, lines = [], []

    def add_run(run_id, month, source, file, run_lines):
        if any(r["run_id"] == run_id for r in runs):
            raise HrError(f"two files give the {source} payroll of {month:%Y-%m}")
        total = lambda f: sum((l.get(f) or Decimal(0) for l in run_lines), Decimal(0))  # noqa: E731
        runs.append(dict(run_id=run_id, month=month, source=source, file_name=file, headcount=len(run_lines),
                         gross_earned=total("gross_earned"), total_earning=total("total_earning"),
                         deductions=total("total_deductions"), net=total("net")))
        for n, l in enumerate(run_lines, 1):
            lines.append(dict(l, run_id=run_id, line_no=n))

    for pay in parsed["voyon_payroll"]:
        for l in pay["lines"]:
            people.add_voyon(l["code"], l["name"], "voyon_payroll", department=l["department"],
                             designation=l["designation"], on_voyon_payroll=True)
            l["employee_id"] = l["code"]
        bad = []
        for key, expected in pay["totals"].items():
            if expected is None:
                continue
            got = sum((l["column_values"].get(key) or Decimal(0) for l in pay["lines"]), Decimal(0))
            if abs(got - expected) > TOLERANCE:
                bad.append(f"{pay['labels'].get(key, key)} {got} vs {expected}")
        net_total = pay["totals"].get("netsalary")
        gates.append((f"Voyon {pay['month']:%Y-%m}: every column adds up to the file's totals row", "hard",
                      bool(pay["totals"]) and not bad,
                      (f"{len(pay['totals'])} columns, net {net_total:,.2f}" if not bad else "; ".join(bad[:4]))
                      if pay["totals"] else "no totals row"))
        off = [l["code"] for l in pay["lines"]
               if abs(l.get("total_earning", 0) - l.get("total_deductions", 0) - l.get("net", 0)) > TOLERANCE]
        gates.append((f"Voyon {pay['month']:%Y-%m}: net = earnings - deductions per line", "soft", not off,
                      f"{len(pay['lines']) - len(off)}/{len(pay['lines'])}" + (f"; off {off[:5]}" if off else "")))
        add_run(f"voyon-{pay['month']:%Y-%m}", pay["month"], "voyon", pay["file"], pay["lines"])

    attendance = []
    attn_counts = {}
    for reg in parsed["register"]:
        month = next((a["month"] for a in reg["attn"]), None) or next((s["month"] for s in reg["sheets"] if s["month"]), None)
        if month is None:
            raise HrError(f"{reg['file']}: no month on the ATTN sheet or the Salary sheets' titles")
        reg_lines = []
        for sh in reg["sheets"]:
            if sh["month"] and sh["month"] != month:
                gates.append((f"register {sh['sheet']}: title month", "soft", False,
                              f"title says {sh['month']:%Y-%m}, attendance sheet {month:%Y-%m}"))
            codes = collections.Counter(l["code"] for l in sh["lines"])
            dup = [c for c, n in codes.items() if n > 1]
            got = sum((l.get("net", Decimal(0)) for l in sh["lines"]), Decimal(0)) + sum((b["net"] for b in sh["broken"]), Decimal(0))
            ok = sh["total_net"] is not None and abs(got - sh["total_net"]) <= TOLERANCE and not dup \
                and not any(b["net"] for b in sh["broken"])
            detail = f"{len(sh['lines'])} people, net {got:,.2f}"
            if sh["total_net"] is None:
                detail += "; no totals row"
            elif abs(got - sh["total_net"]) > TOLERANCE:
                detail += f" vs totals row {sh['total_net']:,.2f}"
            if sh["broken"]:
                detail += f"; {len(sh['broken'])} row(s) with a broken code ({', '.join(b['code'] for b in sh['broken'])})"
                if any(b["net"] for b in sh["broken"]):
                    detail += " carrying pay"
            if dup:
                detail += f"; codes twice {dup}"
            gates.append((f"register {month:%Y-%m} {sh['sheet'].strip()}: net = totals row", "hard", ok, detail))
            for l in sh["lines"]:
                l["employee_id"] = people.add_register(l["code"], l["name"], "register", category=sh["category"],
                                                       date_of_joining=l["date_of_joining"],
                                                       designation=l["designation"])
                l["category"] = sh["category"]
                if l.get("total_deductions") in (None, Decimal(0)) and l.get("total_earning"):
                    l["total_deductions"] = max(l["total_earning"] - l.get("net", Decimal(0)), Decimal(0)).quantize(Decimal("0.01"))
                reg_lines.append(l)
        if reg_lines:
            add_run(f"register-{month:%Y-%m}", month, "register", reg["file"], reg_lines)
        for a in reg["attn"]:
            counts = collections.Counter()
            for row in a["rows"]:
                emp = people.add_register(row["code"], row["name"], "attendance")
                for d, code in row["marks"].items():
                    attendance.append(dict(employee_id=emp, code_register=row["code"], work_date=d, code=code))
                    counts[code] += 1
            attn_counts[a["month"]] = counts
            unknown = sorted(c for c in counts if c not in ATTENDANCE_CODES.values())
            gates.append((f"attendance {a['month']:%Y-%m}: grid = the sheet's own day counts", "hard", not a["problems"],
                          f"{len(a['rows'])} people, " + ", ".join(f"{k} {v}" for k, v in counts.most_common())
                          + (f"; {len(a['problems'])} mismatches: {a['problems'][:3]}" if a["problems"] else "")))
            gates.append((f"attendance {a['month']:%Y-%m}: known codes", "soft", not unknown,
                          "all codes known" if not unknown else f"unknown {unknown}"))

    for tmp in parsed["temp_sheet"]:
        tl = []
        for b in tmp["blocks"]:
            bad = []
            for f, expected in b["totals"].items():
                got = sum((l.get(f) or Decimal(0) for l in b["lines"]), Decimal(0))
                if abs(got - expected) > TOLERANCE:
                    bad.append(f"{f} {got} vs {expected}")
            gates.append((f"temporary sheet {tmp['month']:%Y-%m} {b['block']}: columns = totals", "hard",
                          bool(b["totals"]) and not bad,
                          (f"{len(b['lines'])} people, {len(b['totals'])} totals checked" if not bad else "; ".join(bad))
                          if b["totals"] else "no totals found"))
            for l in b["lines"]:
                l["employee_id"] = people.temp(b["block"], l["name"])
                l["total_deductions"] = (l.get("esi") or Decimal(0)) + (l.get("advance") or Decimal(0))
                tl.append(l)
        add_run(f"temp_sheet-{tmp['month']:%Y-%m}", tmp["month"], "temp_sheet", tmp["file"], tl)

    leaves = []
    for lv in parsed["leave"]:
        for r in lv["rows"]:
            r["employee_id"] = r["code"] if r["code"] in people.emp else None
            leaves.append(r)
    if leaves:
        missing = sorted({r["code"] for r in leaves if not r["employee_id"]})
        gates.append(("leave requests: every code on the Voyon master", "soft", not missing,
                      f"{len(leaves)} requests" + (f"; unknown codes {missing}" if missing else "")))

    peeling = []
    for pl in parsed["peeling"]:
        by_class = collections.defaultdict(Decimal)
        for w in pl["workers"]:
            eid = people.peeler(w["name"], w["class"])
            for d, kg in w["kg"].items():
                inc = w["incentive"].get(d, Decimal(0))
                by_class[w["class"]] += inc
                peeling.append(dict(month=pl["month"], row_no=w["row"], worker_name=w["name"], name_key=name_key(w["name"]),
                                    worker_class=w["class"], employee_id=eid, work_date=d, kg=kg, incentive=inc))
        for cls, expected in pl["summary"].items():
            got = by_class.get(cls, Decimal(0))
            gates.append((f"peeling {pl['month']:%Y-%m} {cls} incentive = the summary sheet", "hard",
                          expected is not None and abs(got - expected) <= TOLERANCE, f"{got:,.2f} vs {expected:,.2f}"))
        if not pl["summary"]:
            gates.append((f"peeling {pl['month']:%Y-%m}: incentive summary", "soft", False, "no summary sheet to check"))
        gates.append((f"peeling {pl['month']:%Y-%m}: the slab rule reproduces the incentive sheet", "soft",
                      pl["rule_misses"] == 0, f"{pl['rule_misses']} worker-days differ (incentive from the {pl['source']})"))

    people.resolve_officers()
    dataset = dict(employees=list(people.emp.values()), temp_workers=list(people.temps.values()), runs=runs, lines=lines,
                   attendance=attendance, leaves=leaves, peeling=peeling)
    no_emp = [l for l in lines if not l.get("employee_id")]
    gates.append(("every payroll line names one person", "hard", not no_emp, f"{len(lines)} lines"
                  + (f"; {len(no_emp)} without" if no_emp else "")))

    report = []
    report.append(f"folder {folder}: {len(files)} workbooks")
    for kind, items in sorted(parsed.items()):
        for it in items:
            report.append(f"  {kind:<17} {it['file']}")
    for name, why in skipped:
        report.append(f"  skipped           {name}: {why}")
    report.append(f"joins file: {joins_path or 'none'} ({len(joins)} register -> Voyon pairs)")
    emp = dataset["employees"]
    report.append(f"employees {len(emp)}: Voyon master {sum(1 for e in emp if 'voyon_master' in e['sources'])}, "
                  f"on Voyon payroll {sum(1 for e in emp if e['on_voyon_payroll'])}, with a register code "
                  f"{sum(1 for e in emp if e['code_register'])} (joined: "
                  + ", ".join(f"{k} {v}" for k, v in people.join_methods.most_common()) + ")")
    if people.unmatched_register:
        report.append(f"  register codes with no Voyon code: {len(people.unmatched_register)} "
                      f"({', '.join(c for c, _ in people.unmatched_register[:12])}"
                      f"{' ...' if len(people.unmatched_register) > 12 else ''}) - add pairs to the joins file if they are on Voyon")
    report.append(f"temporary workers {len(people.temps)}")
    for run in runs:
        cats = collections.defaultdict(lambda: [0, Decimal(0)])
        for l in lines:
            if l["run_id"] == run["run_id"]:
                cats[l["category"]][0] += 1
                cats[l["category"]][1] += l.get("net") or Decimal(0)
        report.append(f"payroll {run['run_id']}: {run['headcount']} people, earned {run['total_earning']:,.2f}, "
                      f"net {run['net']:,.2f}  (" + "; ".join(f"{k} {n}: {v:,.0f}" for k, (n, v) in sorted(cats.items())) + ")")
    for m, counts in attn_counts.items():
        report.append(f"attendance {m:%Y-%m}: " + ", ".join(f"{k} {v}" for k, v in counts.most_common()))
    if leaves:
        report.append(f"leave requests {len(leaves)}: "
                      + ", ".join(f"{k} {v}" for k, v in collections.Counter(r["leave_type"] for r in leaves).most_common())
                      + "; " + ", ".join(f"{k} {v}" for k, v in collections.Counter(r["status"] for r in leaves).most_common()))
    for pl in parsed["peeling"]:
        kg = collections.defaultdict(Decimal)
        inc = collections.defaultdict(Decimal)
        for p in peeling:
            if p["month"] == pl["month"]:
                kg[p["worker_class"]] += p["kg"]
                inc[p["worker_class"]] += p["incentive"]
        linked = sum(1 for w in pl["workers"] if people.peeler(w["name"], w["class"]))
        report.append(f"peeling {pl['month']:%Y-%m}: {len(pl['workers'])} rows ({linked} linked to a person), "
                      + "; ".join(f"{c} {kg[c]:,.0f} kg, incentive {inc[c]:,.2f}" for c in sorted(kg)))
    return dataset, report, gates


# --------------------------------------------------------------------------- write

def copy_rows(cur, table, cols, rows):
    with cur.copy(f"COPY {table} ({', '.join(cols)}) FROM STDIN") as cp:
        for r in rows:
            cp.write_row(tuple(r.get(c) for c in cols))


LINE_COLS = ["run_id", "line_no", "employee_id", "code", "name", "category", "department", "designation", "days_paid",
             "unpaid_days", "basic", "da", "hra", "conveyance", "special", "gross_fixed", "gross_earned", "off_day_work",
             "overtime", "attendance_incentive", "performance_incentive", "peeling_incentive", "production_incentive",
             "other_earnings", "total_earning", "lop", "pf", "esi", "tds", "advance", "other_deductions",
             "total_deductions", "net"]


def write(pg, schema, ds, info):
    pg.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
    pg.execute(HR_SQL.read_text(encoding="utf-8").replace("{s}", schema))
    with pg.cursor() as cur:
        copy_rows(cur, f"{schema}.employees",
                  ["employee_id", "name", "name_key", "code_voyon", "code_register", "department", "designation",
                   "reporting_officer_id", "category", "employment", "date_of_joining", "on_voyon_payroll",
                   "punch_status", "punch_in", "punch_out", "matched_by", "sources"], ds["employees"])
        copy_rows(cur, f"{schema}.temp_workers", ["worker_id", "name", "name_key", "block", "employee_id"], ds["temp_workers"])
        copy_rows(cur, f"{schema}.attendance_days", ["employee_id", "code_register", "work_date", "code"], ds["attendance"])
        copy_rows(cur, f"{schema}.leave_requests",
                  ["request_no", "employee_id", "code_voyon", "employee_name", "requested_at", "leave_type", "from_date",
                   "to_date", "days", "reason", "requested_by", "status"],
                  [dict(r, request_no=i, code_voyon=r["code"], employee_name=r["name"]) for i, r in enumerate(ds["leaves"], 1)])
        copy_rows(cur, f"{schema}.payroll_runs",
                  ["run_id", "month", "source", "file_name", "headcount", "gross_earned", "total_earning", "deductions", "net"],
                  ds["runs"])
        copy_rows(cur, f"{schema}.payroll_lines", LINE_COLS,
                  [{c: (l.get(c) if l.get(c) is not None else (Decimal(0) if c in LINE_COLS[10:] else None)) for c in LINE_COLS}
                   for l in ds["lines"]])
        copy_rows(cur, f"{schema}.peeling_output",
                  ["month", "row_no", "worker_name", "name_key", "worker_class", "employee_id", "work_date", "kg", "incentive"],
                  ds["peeling"])
        cur.executemany(f"INSERT INTO {schema}._import (key, value) VALUES (%s, %s)", list(info.items()))


def print_gates(results):
    w = max(len(r[0]) for r in results)
    log(f"\n{'gate':<{w}}  kind  result  detail")
    log(f"{'-' * w}  ----  ------  ------")
    for name, kind, ok, detail in results:
        status = "skip" if ok is None else "pass" if ok else ("FAIL" if kind == "hard" else "warn")
        log(f"{name:<{w}}  {kind:<4}  {status:<6}  {detail}")


def data_checks(pg, schema, gates_file):
    """`hr_checks` from the local gates file: [{name, sql (with {s} for the schema), expect}], the real figures."""
    p = Path(gates_file).expanduser()
    if not p.exists():
        return [("hr data checks", "hard", None, "no gates file")]
    cfg = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    checks = cfg.get("hr_checks") or []
    if not checks:
        return [("hr data checks", "hard", None, "no hr_checks in the gates file")]
    out = []
    for c in checks:
        try:
            row = pg.execute(c["sql"].replace("{s}", schema)).fetchone()
            expect = c["expect"] if isinstance(c["expect"], list) else [c["expect"]]
            ok = row is not None and len(row) == len(expect) and all(
                (abs(Decimal(str(a)) - Decimal(str(e))) <= Decimal("0.005")) if isinstance(a, (int, float, Decimal))
                and not isinstance(a, bool) else str(a) == str(e) for a, e in zip(row, expect))
            out.append((f"hr: {c['name']}", "hard", ok, ", ".join(map(str, row)) if row else "no row"))
        except (psycopg.Error, KeyError, InvalidOperation) as e:
            out.append((f"hr: {c.get('name', '?')}", "hard", False, f"error: {str(e).strip().splitlines()[0]}"))
    return out


def run(args):
    dataset, report, gates = build(args)
    log("\n".join(report))
    if args.dry_run:
        print_gates(gates)
        log("\n--dry-run: nothing written")
        return 1 if any(ok is False and kind == "hard" for _, kind, ok, _ in gates) else 0
    info = {
        "folder": str(Path(args.dir).expanduser()),
        "imported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "months": json.dumps(sorted({f"{r['month']:%Y-%m}" for r in dataset["runs"]})),
        "runs": json.dumps([r["run_id"] for r in dataset["runs"]]),
    }
    with psycopg.connect(args.pg, autocommit=True) as pg:
        with pg.transaction():
            write(pg, "hr_next", dataset, info)
        gates += data_checks(pg, "hr_next", args.gates)
        print_gates(gates)
        if any(ok is False and kind == "hard" for _, kind, ok, _ in gates):
            log("\nHARD GATE FAILED: hr left untouched; hr_next kept for inspection.")
            return 1
        with pg.transaction():
            pg.execute("DROP SCHEMA IF EXISTS hr CASCADE")
            pg.execute("ALTER SCHEMA hr_next RENAME TO hr")
        pg.execute("ANALYZE hr.payroll_lines")
        size = pg.execute("SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) FROM pg_class c "
                          "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'hr' AND c.relkind = 'r'").fetchone()[0]
        log(f"\nswapped in hr ({size})")
    return 0
