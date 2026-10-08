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

Postgres is now 18. If you still have the old Postgres 16 volume, drop it first with `docker compose down -v`. This deletes the local data.

In one terminal:

```sh
cd backend && cp .env.example .env && npm install && npm run dev
```

In another:

```sh
cd frontend && cp .env.example .env && npm install && npm run dev
```

The API listens on port 3002. With `SEED_DEMO=1` (set in `.env.example` and in compose) it seeds an empty database on first boot. Production never sets it, so production never seeds. The site is http://localhost:3000.

Preview password for every account: `tierra-dev`, or `SEED_PASSWORD` when set.

| Email | Role |
| --- | --- |
| alex.thomas@tierra.test | Admin, the only one. Can connect WhatsApp and change roles |
| joshy@tierra.test | Manager, owns procurement |
| anju@tierra.test | Office, can read orders and inventory |

There is one admin at a time. Making someone else admin moves Alex to manager.

To change a password on a live database:

```sh
cd backend && npm run set-password -- <email> <password>
```

Banana chips 80g is seeded at 40 pouches on hand with an open order for 100, so available stock is −60. A WhatsApp PDF that asks for that item is refused.

The inventory page is customer material stock. Each seeded customer holds their own laminate, seasoning, and cartons.

## WhatsApp

Evolution is optional for the pages above. To link a phone:

```sh
docker compose up -d redis evolution
```

The first image build clones Evolution and applies the four patches. It takes a while.

Point the API at it with `EVOLUTION_URL=http://localhost:8081`. From inside Docker the webhook URL must be reachable by Evolution. Compose sets `EVOLUTION_WEBHOOK_URL=http://api:3002`. When the API runs on the host instead, set `EVOLUTION_WEBHOOK_URL=http://host.docker.internal:3002`.

An admin opens Settings, starts pairing, and scans the QR. The connected account is Tierra Bot, the purchase-order agent.

On a personal chat, and in Message Yourself, Tierra Bot reacts with 👀 and then replies. Replies are written with `OPENAI_API_KEY` (OpenAI chat completions, `OPENAI_MODEL`). Message Yourself, a mentioned group message, and an operations question can use the live dashboard: command centre, customers, orders with lines, and inventory. Other nav modules have no records yet. A bare greeting does not dump those figures. Text never creates an order.

A PDF on a personal chat, in Message Yourself, or in a group message that mentions Tierra Bot is read with the same OpenAI key. Tierra Bot matches the customer and lines to the seeded masters, compares quantities with available stock, and either creates an open order or replies on that chat. Group messages that do not mention Tierra Bot are ignored.

`TYPESAFE_API_KEY` is Jev, via the TypeSafe SDK. Jev chooses whether a text message is a dashboard question, a conversation, a request that still needs a PDF, or nothing to do. A PDF does not go through Jev. Without the key, PDFs still intake and text replies say Tierra Bot cannot decide yet.

Tasks go to a role, not a person. Every new task is sent on WhatsApp to whoever holds that role. They finish it by replying *done* to the message or reacting 👍 to it, and the person who raised it is told.

Send `test pdf` to Tierra Bot from a linked account to get a one-page test PDF back. It checks fonts, the ₹ sign and Indian number formatting.

`WHATSAPP_BOT_MODE` is `personal` by default: the bot runs on someone's own phone, as today. Set it to `dedicated` when the bot has its own number. Then every message the bot's phone sends is treated as the bot's own.

QR pairing on a real phone is a manual check.

## Tests

```sh
cd backend && npm test
```

The Postgres tests start a real Postgres 18 in Docker and skip when Docker is not running:

```sh
cd backend && npm run test:pg
```
