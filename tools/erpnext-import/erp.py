"""A small ERPNext (Frappe) REST client: token auth for the service user, a login session for Administrator."""
import json
import os
import random
import time

import requests


class ErpError(Exception):
    def __init__(self, status, message, exc_type=None):
        super().__init__(f"{status} {exc_type or ''} {message}".strip())
        self.status = status
        self.message = message
        self.exc_type = exc_type


def _message(resp):
    """ERPNext puts the human message in _server_messages (a JSON list of JSON objects) or exception."""
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:500], None
    exc_type = body.get("exc_type")
    msgs = []
    if body.get("_server_messages"):
        try:
            for raw in json.loads(body["_server_messages"]):
                try:
                    msgs.append(json.loads(raw).get("message", raw))
                except (ValueError, AttributeError):
                    msgs.append(str(raw))
        except ValueError:
            pass
    if not msgs and body.get("exception"):
        msgs.append(body["exception"])
    if not msgs and body.get("message"):
        msgs.append(str(body["message"]))
    return " | ".join(str(m) for m in msgs if m)[:1000] or resp.text[:500], exc_type


class Erp:
    def __init__(self, url=None, site=None, api_key=None, api_secret=None):
        self.url = (url or os.environ.get("ERPNEXT_URL", "http://127.0.0.1:8080")).rstrip("/")
        self.site = site or os.environ.get("ERPNEXT_SITE", "erp.localhost")
        self.s = requests.Session()
        # the nginx container picks the site by Host header
        self.s.headers["Host"] = self.site
        self.s.headers["Accept"] = "application/json"
        key = api_key or os.environ.get("ERPNEXT_API_KEY")
        secret = api_secret or os.environ.get("ERPNEXT_API_SECRET")
        if key and secret:
            self.s.headers["Authorization"] = f"token {key}:{secret}"

    def login(self, user, password):
        self.s.headers.pop("Authorization", None)
        self._req("POST", "/api/method/login", data={"usr": user, "pwd": password})

    def _req(self, method, path, retries=8, **kw):
        for attempt in range(retries):
            try:
                resp = self.s.request(method, self.url + path, timeout=300, **kw)
            except requests.RequestException as e:
                if attempt == retries - 1:
                    raise ErpError(0, str(e))
                time.sleep(2 * (attempt + 1))
                continue
            # 417 = validation error, 409 = duplicate, 404 = missing; retry only on server/lock trouble
            if resp.status_code in (502, 503, 504) or (
                resp.status_code == 500 and "QueryDeadlockError" in resp.text) or (
                resp.status_code == 500 and "Lock wait timeout" in resp.text):
                if attempt < retries - 1:
                    time.sleep(1 + attempt + random.random() * 2)
                    continue
            if resp.status_code >= 400:
                msg, exc_type = _message(resp)
                raise ErpError(resp.status_code, msg, exc_type)
            return resp.json() if resp.content else {}

    # ------------------------------------------------------------------ resources

    def get_list(self, doctype, filters=None, fields=None, limit=0, order_by=None):
        params = {"limit_page_length": limit or 100000}
        if filters is not None:
            params["filters"] = json.dumps(filters)
        if fields:
            params["fields"] = json.dumps(fields)
        if order_by:
            params["order_by"] = order_by
        return self._req("GET", f"/api/resource/{doctype}", params=params)["data"]

    def get_doc(self, doctype, name):
        return self._req("GET", f"/api/resource/{doctype}/{requests.utils.quote(name, safe='')}")["data"]

    def exists(self, doctype, name):
        try:
            self.get_doc(doctype, name)
            return True
        except ErpError as e:
            if e.status == 404:
                return False
            raise

    def insert(self, doc):
        """Insert one document; docstatus 1 in the payload inserts and submits in one call."""
        return self._req("POST", f"/api/resource/{doc['doctype']}", json=doc)["data"]

    def update(self, doctype, name, values):
        return self._req("PUT", f"/api/resource/{doctype}/{requests.utils.quote(name, safe='')}", json=values)["data"]

    def call(self, method, **kwargs):
        return self._req("POST", f"/api/method/{method}", json=kwargs).get("message")

    def get_value(self, doctype, filters, fieldname="name"):
        rows = self.get_list(doctype, filters=filters, fields=[fieldname], limit=1)
        return rows[0][fieldname] if rows else None

    def set_single(self, doctype, values):
        return self.update(doctype, doctype, values)
