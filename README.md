# Tierra CRM

Preview of Tierra Food India’s order desk. Customer purchase orders live in this app’s Postgres database. SAP is not connected.

## Layout

- `frontend` — Next.js
- `backend` — Hono, Drizzle, Postgres
- `whatsapp/evolution` — patched Evolution API image copied from DODO

## Local preview

```sh
docker compose up -d postgres
```

In one terminal:

```sh
cd backend && cp .env.example .env && npm install && npm run dev
```

In another:

```sh
cd frontend && cp .env.example .env && npm install && npm run dev
```

The API listens on port 3002 and seeds the database on first boot. The site is http://localhost:3000.

Preview password for every account: `tierra-dev`

| Email | Role |
| --- | --- |
| alex.thomas@tierra.test | Admin, can connect WhatsApp |
| joshy@tierra.test | Admin, can connect WhatsApp |
| anju@tierra.test | Office, can read orders and inventory |

Banana chips 80g is seeded at 40 pouches on hand with an open order for 100, so available stock is −60. A WhatsApp PDF that asks for that item is refused.

## WhatsApp

Evolution is optional for the pages above. To link a phone:

```sh
docker compose up -d redis evolution
```

The first image build clones Evolution and applies the four patches. It takes a while.

Point the API at it with `EVOLUTION_URL=http://localhost:8081`. From inside Docker the webhook URL must be reachable by Evolution. Compose sets `EVOLUTION_WEBHOOK_URL=http://api:3002`. When the API runs on the host instead, set `EVOLUTION_WEBHOOK_URL=http://host.docker.internal:3002`.

An admin opens Settings, starts pairing, and scans the QR. Personal chats are watched. A PDF is read with `PO_EXTRACT_API_KEY` (OpenAI-compatible chat completions). The agent matches the customer and lines to the seeded masters, compares quantities with available stock, and either creates an open order or replies on that chat. Group messages are ignored.

QR pairing on a real phone is a manual check.

## Tests

```sh
cd backend && npm test
```
