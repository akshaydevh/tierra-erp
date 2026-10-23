#!/usr/bin/env python3
"""SAP B1 backup -> ERPNext, for the hackathon build (branch hackathon/erpnext).

  python -I run.py setup                      company, fiscal years, settings, custom fields, users
  python -I run.py import [--only STEP,...]   masters, openings, the import window, the stock reconciliation
  python -I run.py verify                     compare ERPNext with SAP (counts, sales totals, stock)

The source is the typed `sap` schema the SAP importer (tools/sap-import) already loaded into Postgres (SAP_PG).
Keys for ERPNext come from ~/tierra-data/erpnext.local.env, which `setup` writes. See README.md.
"""
import argparse
import os
import sys
from pathlib import Path

# -I keeps the script folder off sys.path; the modules beside this file are ours
sys.path.insert(0, str(Path(__file__).resolve().parent))

from setup_site import ENV_FILE, read_env


def main():
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["setup", "import", "verify"])
    p.add_argument("--only", help="comma-separated import steps")
    p.add_argument("--workers", type=int, default=4)
    a = p.parse_args()
    for k, v in read_env().items():
        os.environ.setdefault(k, v)
    if a.command == "setup":
        import setup_site
        setup_site.run()
    elif a.command == "import":
        import importer
        importer.run(only=a.only.split(",") if a.only else None, workers=a.workers)
    else:
        import verify
        sys.exit(verify.run())


if __name__ == "__main__":
    main()
