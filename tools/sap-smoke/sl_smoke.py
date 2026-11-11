#!/usr/bin/env python3
"""SAP Business One Service Layer smoke test. Python 3.9+, standard library only.

Read-only by default. Shows whether the server is reachable, whether login works, and which of
the objects Tierra needs can be read. Every response is saved under --out (outside the repo:
SAP data is never committed).

  python3 sl_smoke.py --url https://192.168.1.10:50000 --db TIERRA_TEST --user integ01

The password comes from SL_PASSWORD or a prompt, never from the command line.

  --write   also creates one Sales Order and cancels it (or deletes the draft if approval
            catches it). Refused unless --confirm-db repeats the company name, and refused
            for any company whose name contains PRD.
"""
from __future__ import annotations

import argparse
import datetime as dt
import getpass
import json
import os
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MARKER = 'TIERRA-SL-SMOKE'

# (label, path with query). Kept small: three rows are enough to prove the read and see the shape.
READS = [
    ('items', "Items?$top=3&$select=ItemCode,ItemName,ItemsGroupCode,ManageBatchNumbers"),
    ('customers', "BusinessPartners?$top=3&$select=CardCode,CardName&$filter=CardType eq 'cCustomer'"),
    ('suppliers', "BusinessPartners?$top=3&$select=CardCode,CardName&$filter=CardType eq 'cSupplier'"),
    ('sales_orders', 'Orders?$top=3&$orderby=DocEntry desc'),
    ('ar_invoices', 'Invoices?$top=3&$orderby=DocEntry desc'),
    ('purchase_orders', 'PurchaseOrders?$top=3&$orderby=DocEntry desc'),
    ('goods_receipt_po', 'PurchaseDeliveryNotes?$top=3&$orderby=DocEntry desc'),
    ('ap_invoices', 'PurchaseInvoices?$top=3&$orderby=DocEntry desc'),
    ('production_orders', 'ProductionOrders?$top=3&$orderby=AbsoluteEntry desc'),
    ('goods_issue', 'InventoryGenExits?$top=3&$orderby=DocEntry desc'),
    ('receipt_from_production', 'InventoryGenEntries?$top=3&$orderby=DocEntry desc'),
    ('batches', 'BatchNumberDetails?$top=3&$orderby=DocEntry desc'),
    ('incoming_payments', 'IncomingPayments?$top=3&$orderby=DocEntry desc'),
    ('outgoing_payments', 'VendorPayments?$top=3&$orderby=DocEntry desc'),
    ('drafts', 'Drafts?$top=3&$orderby=DocEntry desc'),
    ('approval_requests', 'ApprovalRequests?$top=3&$orderby=Code desc'),
    ('warehouses', 'Warehouses?$top=10&$select=WarehouseCode,WarehouseName'),
    ('users', 'Users?$top=20&$select=InternalKey,UserCode,UserName'),
    # CCS add-on tables. These only answer if the table is exposed to Service Layer.
    ('ccs_einvoice', 'U_CCS_EOINV?$top=3'),
    ('ccs_ewaybill', 'U_CCS_EOEWB?$top=3'),
]


class Client:
    def __init__(self, base: str, verify_tls: bool, timeout: float):
        self.base = base.rstrip('/')
        if not self.base.endswith('/b1s/v1') and not self.base.endswith('/b1s/v2'):
            self.base += '/b1s/v1'
        self.timeout = timeout
        self.cookies: dict[str, str] = {}
        ctx = ssl.create_default_context()
        if not verify_tls:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))

    def call(self, method: str, path: str, body: dict | None = None):
        """Returns (status, parsed-or-text, milliseconds). Never raises on an HTTP error status."""
        url = self.base + '/' + urllib.parse.quote(path, safe="/?&=$(),'")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header('Content-Type', 'application/json')
        if self.cookies:
            req.add_header('Cookie', '; '.join(f'{k}={v}' for k, v in self.cookies.items()))
        started = time.monotonic()
        try:
            with self.opener.open(req, timeout=self.timeout) as res:
                status, raw, headers = res.status, res.read(), res.headers
        except urllib.error.HTTPError as err:
            status, raw, headers = err.code, err.read(), err.headers
        ms = round((time.monotonic() - started) * 1000)
        for line in headers.get_all('Set-Cookie') or []:
            name, _, rest = line.partition('=')
            self.cookies[name.strip()] = rest.split(';', 1)[0]
        text = raw.decode('utf-8', 'replace')
        try:
            return status, json.loads(text) if text else None, ms
        except json.JSONDecodeError:
            return status, text, ms


def sl_error(payload) -> str:
    """The message out of a Service Layer error body, whatever shape it came in."""
    if isinstance(payload, dict):
        err = payload.get('error', payload)
        msg = err.get('message') if isinstance(err, dict) else None
        if isinstance(msg, dict):
            msg = msg.get('value')
        code = err.get('code') if isinstance(err, dict) else None
        return f'{code}: {msg}' if msg else json.dumps(payload)[:300]
    return str(payload)[:300]


def probe(base: str, timeout: float) -> bool:
    """Plain TCP check first, so 'cannot reach the server' is told apart from 'login refused'."""
    parts = urllib.parse.urlsplit(base)
    host, port = parts.hostname, parts.port or (443 if parts.scheme == 'https' else 80)
    print(f'[net] {host}:{port} ... ', end='', flush=True)
    try:
        addr = socket.gethostbyname(host)
    except socket.gaierror as err:
        print(f'NAME DOES NOT RESOLVE ({err}). Use the IP address, or fix DNS/hosts.')
        return False
    try:
        with socket.create_connection((addr, port), timeout=timeout):
            print(f'open ({addr})')
            return True
    except socket.timeout:
        print(f'TIMEOUT to {addr}. Wrong subnet/VLAN, or a firewall is dropping the port.')
    except ConnectionRefusedError:
        print(f'REFUSED by {addr}. Host is up but nothing listens on {port}: Service Layer '
              'stopped, or it is on another port (try 50001, 50002, or ask CCS).')
    except OSError as err:
        print(f'FAILED ({err})')
    return False


def save(out: Path, name: str, payload) -> None:
    path = out / name
    if isinstance(payload, str):
        path.write_text(payload, encoding='utf-8')
    else:
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding='utf-8')


def rows_of(payload) -> list:
    return payload.get('value', []) if isinstance(payload, dict) else []


def write_test(client: Client, out: Path, card: str | None, item: str | None) -> bool:
    print('\n[write] creating one Sales Order, then removing it')
    if not card:
        _, p, _ = client.call('GET', "BusinessPartners?$top=1&$select=CardCode&$filter=CardType eq 'cCustomer' and Valid eq 'tYES'")
        card = (rows_of(p) or [{}])[0].get('CardCode')
    if not item:
        _, p, _ = client.call('GET', "Items?$top=1&$select=ItemCode&$filter=SalesItem eq 'tYES' and Valid eq 'tYES'")
        item = (rows_of(p) or [{}])[0].get('ItemCode')
    if not card or not item:
        print('  SKIP: could not find a customer and an item; pass --card and --item')
        return False

    stamp = f'{MARKER} {dt.datetime.now():%Y%m%d-%H%M%S}'
    order = {
        'CardCode': card,
        'DocDueDate': dt.date.today().isoformat(),
        'Comments': f'{stamp} - integration test, safe to delete',
        'DocumentLines': [{'ItemCode': item, 'Quantity': 1, 'UnitPrice': 1}],
    }
    status, payload, ms = client.call('POST', 'Orders', order)
    save(out, 'write_order_response.json', payload)
    if status in (200, 201) and isinstance(payload, dict) and payload.get('DocEntry'):
        entry = payload['DocEntry']
        print(f'  created Sales Order DocEntry={entry} DocNum={payload.get("DocNum")} ({ms} ms); no approval caught it')
        status, payload, _ = client.call('POST', f'Orders({entry})/Cancel')
        if status == 204:
            print('  cancelled it. Write path works end to end.')
            return True
        print(f'  CANCEL FAILED ({status}) {sl_error(payload)}')
        print(f'  >>> cancel Sales Order DocEntry={entry} by hand in SAP')
        return False

    print(f'  POST /Orders answered {status}: {sl_error(payload)}')
    # With an approval template in force the order is parked as a draft and the call reports an error.
    status, payload, _ = client.call('GET', f"Drafts?$top=5&$orderby=DocEntry desc&$select=DocEntry,Comments&$filter=startswith(Comments,'{stamp}')")
    drafts = rows_of(payload)
    if not drafts:
        print('  no draft carrying our marker was found, so nothing was created.')
        print('  Read the message above: missing permission, licence, or a required field.')
        return False
    ok = True
    for draft in drafts:
        entry = draft['DocEntry']
        print(f'  the order was parked as draft DocEntry={entry}: the approval procedure caught it')
        status, payload, _ = client.call('DELETE', f'Drafts({entry})')
        if status == 204:
            print('  draft removed.')
        else:
            ok = False
            print(f'  COULD NOT REMOVE THE DRAFT ({status}) {sl_error(payload)}')
            print(f'  >>> remove draft DocEntry={entry} by hand in SAP (Comments starts with {MARKER})')
    print('  Finding: writes through Service Layer go into the SAP approval flow as drafts.')
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description='SAP B1 Service Layer smoke test (read-only unless --write)')
    ap.add_argument('--url', required=True, help='e.g. https://192.168.1.10:50000')
    ap.add_argument('--db', required=True, help='company database (the TEST company)')
    ap.add_argument('--user', required=True)
    ap.add_argument('--out', default=str(Path.home() / 'tierra-data' / 'sl-smoke'))
    ap.add_argument('--verify-tls', action='store_true', help='check the certificate (default: accept self-signed)')
    ap.add_argument('--timeout', type=float, default=20)
    ap.add_argument('--no-metadata', action='store_true', help='skip the (large) $metadata download')
    ap.add_argument('--write', action='store_true', help='create and remove one Sales Order')
    ap.add_argument('--confirm-db', help='repeat the company name to allow --write')
    ap.add_argument('--card', help='customer code for the write test')
    ap.add_argument('--item', help='item code for the write test')
    args = ap.parse_args()

    if args.write:
        if 'PRD' in args.db.upper():
            print(f'Refusing --write: "{args.db}" looks like the production company.')
            return 2
        if args.confirm_db != args.db:
            print(f'Refusing --write: add --confirm-db {args.db} to confirm this is the test company.')
            return 2

    out = Path(args.out).expanduser() / f'{dt.datetime.now():%Y%m%d-%H%M%S}-{args.db}'
    out.mkdir(parents=True, exist_ok=True)

    if not probe(args.url, min(args.timeout, 8)):
        return 1

    password = os.environ.get('SL_PASSWORD') or getpass.getpass(f'Password for {args.user}: ')
    client = Client(args.url, args.verify_tls, args.timeout)

    print(f'[login] {client.base} company={args.db} user={args.user} ... ', end='', flush=True)
    try:
        status, payload, ms = client.call('POST', 'Login', {'CompanyDB': args.db, 'UserName': args.user, 'Password': password})
    except ssl.SSLCertVerificationError as err:
        print(f'CERTIFICATE REJECTED ({err.reason}). Self-signed: run without --verify-tls.')
        return 1
    except ssl.SSLError as err:
        print(f'TLS FAILED ({err}). Is the port plain http? Try http:// in --url.')
        return 1
    except (urllib.error.URLError, OSError) as err:
        print(f'FAILED ({err})')
        return 1
    if status != 200:
        print(f'REFUSED ({status}) {sl_error(payload)}')
        print('  Wrong company name, wrong password, user locked, or no licence assigned to the user.')
        return 1
    print(f'ok ({ms} ms), version {payload.get("Version")}, session timeout {payload.get("SessionTimeout")} min')
    summary = {'url': client.base, 'db': args.db, 'user': args.user, 'version': payload.get('Version'),
               'session_timeout_min': payload.get('SessionTimeout'), 'login_ms': ms, 'reads': {}}

    failed = 0
    try:
        print('\n[read]')
        for label, path in READS:
            status, payload, ms = client.call('GET', path)
            save(out, f'{label}.json', payload)
            rows = rows_of(payload)
            if status == 200:
                first = rows[0] if rows else {}
                udfs = sorted(k for k in first if k.startswith('U_'))
                note = f'{len(rows)} rows, {len(first)} fields' + (f', {len(udfs)} UDFs' if udfs else '')
                print(f'  ok    {label:<24} {ms:>5} ms  {note}')
                summary['reads'][label] = {'ok': True, 'ms': ms, 'rows': len(rows), 'udfs': udfs}
            else:
                failed += 1
                print(f'  FAIL  {label:<24} {ms:>5} ms  {status} {sl_error(payload)}')
                summary['reads'][label] = {'ok': False, 'ms': ms, 'status': status, 'error': sl_error(payload)}

        if not args.no_metadata:
            print('\n[metadata] ', end='', flush=True)
            status, payload, ms = client.call('GET', '$metadata')
            if status == 200 and isinstance(payload, str):
                save(out, 'metadata.xml', payload)
                print(f'saved, {len(payload) // 1024} KB ({ms} ms)')
            else:
                print(f'FAILED ({status}) {sl_error(payload)}')

        if args.write:
            summary['write_ok'] = write_test(client, out, args.card, args.item)
    finally:
        client.call('POST', 'Logout')
        save(out, 'summary.json', summary)

    print(f'\nSaved to {out}')
    print(f'{len(READS) - failed}/{len(READS)} reads ok' + ('' if not failed else ' (the ccs_* ones failing only means those tables are not exposed)'))
    return 0 if failed <= 2 else 1


if __name__ == '__main__':
    sys.exit(main())
