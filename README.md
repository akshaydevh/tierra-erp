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

An admin opens Settings, starts pairing, and scans the QR. The connected account is Tierra Bot, the purchase-order agent.

On a personal chat, and in Message Yourself, Tierra Bot reacts with 👀 and then replies. Replies are written with `OPENAI_API_KEY` (OpenAI chat completions, `OPENAI_MODEL`). Message Yourself and a group message that names Tierra Bot or mentions the connected number can ask about live dashboard data: orders, customers, inventory, and the command centre. Other modules on the nav have no records yet. A customer’s personal chat still gets a reply, without those internal figures. Text never creates an order.

A PDF on a personal chat, in Message Yourself, or in a group message that mentions Tierra Bot is read with the same OpenAI key. Tierra Bot matches the customer and lines to the seeded masters, compares quantities with available stock, and either creates an open order or replies on that chat. Group messages that do not mention Tierra Bot are ignored.

`TYPESAFE_API_KEY` is Jev, via the TypeSafe SDK. Jev chooses whether a text message is a dashboard question, a conversation, a request that still needs a PDF, or nothing to do. A PDF does not go through Jev. Without the key, PDFs still intake and text replies say Tierra Bot cannot decide yet.

QR pairing on a real phone is a manual check.

## Tests

```sh
cd backend && npm test
```
