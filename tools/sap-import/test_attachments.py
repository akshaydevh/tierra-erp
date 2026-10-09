"""Tests for `run.py attachments` (synthetic data only).

  .venv/bin/python -I test_attachments.py        (from tools/sap-import)

The end-to-end test needs a Postgres it may create a scratch database on: set SAP_TEST_PG to a URL whose user can
CREATE DATABASE (the docker-compose one: postgres://tierra:tierra@localhost:5432/tierra). Without it, it is skipped.
It builds the backend's synthetic SAP fixture (backend/test/*.sql + sql/att.sql + sql/erp), adds attachment pointers,
writes small synthetic PDFs / PNGs and runs the command against an fs store.
"""
import importlib.util
import os
import shutil
import tempfile
import types
import unittest
import uuid
from datetime import date
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("sap_import_run", HERE / "run.py")
run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run)

BACKEND_TEST = HERE.parent.parent / "backend" / "test"


def make_pdf(lines):
    """A one-page PDF whose text layer is `lines` (Helvetica), small enough to write by hand."""
    def esc(s):
        return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    body = "BT /F1 10 Tf 40 800 Td 12 TL " + " ".join(f"({esc(l)}) Tj T*" for l in lines) + " ET"
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(body)} >>\nstream\n{body}\nendstream",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


class PureFunctions(unittest.TestCase):
    def test_print_names(self):
        m = run.PRINT_NAME.match("AR Invoice [Approved]_20260331_150000.pdf")
        self.assertEqual((m["kind"], m["docnum"], m["d"]), ("AR Invoice [Approved]", None, "20260331"))
        m = run.PRINT_NAME.match("Incoming Payments_369_20260818_171323.pdf")
        self.assertEqual((m["kind"], m["docnum"]), ("Incoming Payments", "369"))
        self.assertIsNone(run.PRINT_NAME.match("900000000001.pdf"))

    def test_kinds_and_keys(self):
        self.assertEqual(run.file_kind("GSTZENQRabc.png"), "einvoice_qr")
        self.assertEqual(run.file_kind("123456789012.pdf"), "ewaybill")
        self.assertEqual(run.file_kind("AR Invoice_20260331_150000.pdf"), "sap_print")
        self.assertEqual(run.file_kind("banana28.9.pdf"), "attachment")
        info = types.SimpleNamespace(sha="ab" * 32, ext=".PDF".lower())
        self.assertEqual(run.storage_key(info), f"sap/ab/ab/{'ab' * 32}.pdf")
        info.ext = ".weird ext"
        self.assertTrue(run.storage_key(info).endswith(".bin"))

    def test_values_dates_excerpts(self):
        self.assertEqual(run.money("5,54,645.00"), Decimal("554645.00"))
        self.assertEqual(run.date_from(("31", "03", "2026")), date(2026, 3, 31))
        self.assertIsNone(run.date_from(("31", "02", "2026")))
        self.assertEqual(run.excerpt("a \n\n  b\x00"), "a b")
        self.assertEqual(len(run.excerpt("x" * 5000)), run.EXCERPT_LIMIT)

    def test_strongest_link_wins(self):
        f = types.SimpleNamespace(sha="f" * 64)
        mk = lambda method: dict(file=f, sap_object="13", doc_entry=1, doc_no="TF/1", card_code=None, doc_date=None,
                                 role="ewaybill", link_method=method, confidence="exact")
        kept = run.dedupe_links([mk("ccs_eoewb"), mk("atc1")])
        self.assertEqual([l["link_method"] for l in kept], ["atc1"])


@unittest.skipUnless(os.environ.get("SAP_TEST_PG"), "set SAP_TEST_PG to run the end-to-end attachments test")
class EndToEnd(unittest.TestCase):
    def setUp(self):
        import psycopg
        self.admin = os.environ["SAP_TEST_PG"]
        self.db = f"att_test_{uuid.uuid4().hex[:8]}"
        with psycopg.connect(self.admin, autocommit=True) as pg:
            pg.execute(f'CREATE DATABASE "{self.db}"')
        base, _, _ = self.admin.rpartition("/")
        self.url = f"{base}/{self.db}"
        with psycopg.connect(self.url, autocommit=True) as pg:
            pg.execute((BACKEND_TEST / "sap-schema.sql").read_text())
            pg.execute(run.ATT_SQL.read_text())
            pg.execute("CREATE SCHEMA erp")
            for f in run.erp_files():
                pg.execute(f.read_text())
            pg.execute((BACKEND_TEST / "sap-fixture.synthetic.sql").read_text())
            pg.execute("SELECT erp.refresh()")
            # attachment pointers the fixture does not have: GRN 502 -> ATC1 900 (one file here, one missing),
            # invoice 201 -> its QR and its e-way bill, a draft-only pointer that must be ignored
            pg.execute("INSERT INTO sap.atc1 (absentry, line, filename, fileext) VALUES (900, 1, 'Gamma Bill', 'PDF'),"
                       " (900, 2, 'not-in-folder', 'pdf'), (901, 1, 'draft-only', 'pdf')")
            pg.execute("UPDATE sap.opdn SET atcentry = 900 WHERE docentry = 502")
            pg.execute("UPDATE sap.ccs_eoinv SET u_qrpath = 'C:\\SAP\\Attachments\\GSTZENQRtest201.png' WHERE docentry = 2")
            pg.execute("UPDATE sap.ccs_eoewb SET u_ewbno = '900201000001' WHERE docentry = 1")
        self.tmp = Path(tempfile.mkdtemp(prefix="att-test-"))
        folder = self.tmp / "archive" / "Attachments" / "Ewaybill"
        folder.mkdir(parents=True)
        (self.tmp / "archive" / "Attachments" / "GSTZENQRtest201.png").write_bytes(b"\x89PNG\r\n\x1a\nqr")
        (folder / "gamma bill.pdf").write_bytes(make_pdf(["Supplier bill INV-88", "Total 36,000.00"]))
        (folder / "900201000001.pdf").write_bytes(make_pdf(["e-Way Bill", "Document Number: TF/25-26/1"]))
        (folder / "draft-only.pdf").write_bytes(make_pdf(["draft"]))
        (folder / "AR Invoice [Approved]_20260331_150500.pdf").write_bytes(
            make_pdf(["Invoice No : TF/25-26/1", "Invoice Date : 31/03/2026", "Net Value 5,250.00"]))
        # a batch print of two invoices of two customers: linked to both, but as internal 'supporting' only
        (folder / "AR Invoice_20260331_160700.pdf").write_bytes(make_pdf([
            "Invoice No : TF/25-26/1", "Invoice Date : 31/03/2026", "Net Value 5,250.00",
            "Invoice No : TF/25-26/3", "Invoice Date : 31/03/2026", "Net Value 1,050.00"]))
        (folder / "AR Invoice_20260331_150600.pdf").write_bytes(
            make_pdf(["Invoice No : TF/25-26/3", "Invoice Date : 31/03/2026", "Net Value 9,999.00"]))
        (folder / "AR Invoice - Cancellation_20260331_151000.pdf").write_bytes(
            make_pdf(["Invoice No : TFC-25/1", "Invoice Date : 31/03/2026", "Net Value 4,200.00"]))
        (folder / "Purchase Order_20260331_090000.pdf").write_bytes(
            make_pdf(["PO No : 1", "PO Date : 15/03/2026", "Net Value 11,800.00"]))
        (folder / "Journal Entry_20260331_090000.pdf").write_bytes(make_pdf(["No: 1/"]))
        self.store = self.tmp / "store"

    def tearDown(self):
        import psycopg
        shutil.rmtree(self.tmp, ignore_errors=True)
        with psycopg.connect(self.admin, autocommit=True) as pg:
            pg.execute(f'DROP DATABASE IF EXISTS "{self.db}" WITH (FORCE)')

    def args(self, **over):
        a = types.SimpleNamespace(dir=[str(self.tmp / "archive")], pg=self.url, store=f"fs:{self.store}", workers=2,
                                  dry_run=False)
        a.__dict__.update(over)
        return a

    def test_links_uploads_and_replaces(self):
        import psycopg
        self.assertEqual(run.attachments(self.args(dry_run=True)), 0)
        self.assertFalse(self.store.exists())
        self.assertEqual(run.attachments(self.args()), 0)
        with psycopg.connect(self.url) as pg:
            links = sorted(pg.execute("SELECT f.file_name, l.sap_object, l.doc_entry, l.doc_no, l.role, l.link_method,"
                                      " l.confidence FROM att.links l JOIN att.files f USING (sha256)").fetchall())
            self.assertEqual(links, [
                ("900201000001.pdf", "13", 201, "TF/25-26/1", "ewaybill", "ccs_eoewb", "exact"),
                ("AR Invoice - Cancellation_20260331_151000.pdf", "13", 203, "TFC-25/1", "invoice_pdf", "content_doc_no", "content"),
                ("AR Invoice [Approved]_20260331_150500.pdf", "13", 201, "TF/25-26/1", "invoice_pdf", "content_doc_no", "content"),
                ("AR Invoice_20260331_160700.pdf", "13", 201, "TF/25-26/1", "supporting", "content_doc_no", "content"),
                ("AR Invoice_20260331_160700.pdf", "13", 204, "TF/25-26/3", "supporting", "content_doc_no", "content"),
                ("GSTZENQRtest201.png", "13", 201, "TF/25-26/1", "einvoice_qr", "ccs_eoinv", "exact"),
                ("Purchase Order_20260331_090000.pdf", "22", 401, "PO/25-26/1", "po_pdf", "content_doc_no", "content"),
                ("gamma bill.pdf", "20", 502, "GR/25-26/2", "supporting", "atc1", "exact"),
            ])
            files = {r[0]: r[1:] for r in pg.execute(
                "SELECT file_name, mime, kind, source, storage_key, text_excerpt FROM att.files").fetchall()}
            self.assertEqual(files["GSTZENQRtest201.png"][:3], ("image/png", "einvoice_qr", "sap_ccs"))
            self.assertIn("Net Value 5,250.00", files["AR Invoice [Approved]_20260331_150500.pdf"][4])
            for _, _, _, key, _ in files.values():
                self.assertTrue((self.store / key).is_file(), key)
            # the wrong value, the journal entry and the draft-only file were not kept
            self.assertNotIn("AR Invoice_20260331_150600.pdf", files)
            self.assertNotIn("Journal Entry_20260331_090000.pdf", files)
            self.assertNotIn("draft-only.pdf", files)
            view = pg.execute("SELECT doc_type, card_name FROM erp.document_files WHERE file_name = 'gamma bill.pdf'").fetchone()
            self.assertEqual(view, ("grn", "Gamma Packaging Co"))
        # a second run finds every key in the store and replaces the rows with the same ones
        self.assertEqual(run.attachments(self.args()), 0)
        with psycopg.connect(self.url) as pg:
            self.assertEqual(pg.execute("SELECT count(*) FROM att.links").fetchone()[0], 8)

    def test_rejects_a_bad_store(self):
        with self.assertRaises(run.ImportError_):
            run.attachments(self.args(store="ftp:x"))


if __name__ == "__main__":
    unittest.main()
