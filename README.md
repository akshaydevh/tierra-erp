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

In production (`NODE_ENV=production`, set by the Dockerfile) the API will not start until `EVOLUTION_API_KEY` and `EVOLUTION_WEBHOOK_SECRET` are set to private values. Compose runs the API with `NODE_ENV=development`.

Preview password for every account: `tierra-dev`, or `SEED_PASSWORD` when set.

| Email | Role |
| --- | --- |
| alex.thomas@tierra.test | Admin, the only one. Can connect WhatsApp and change roles |
| joshy@tierra.test | Manager, owns procurement |
| anju@tierra.test | Office, can read orders and inventory |

There is one admin at a time. Making someone else admin moves Alex to manager.

To change a password on a live database (the password is read from `NEW_PASSWORD`, or typed when asked; never put it on the command line, where shell history keeps it):

```sh
cd backend && npm run set-password -- <email>
```

To create the first admin on an empty database (refused once an admin exists):

```sh
cd backend && npm run create-admin -- <email> "<name>"
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

On a personal chat, and in Message Yourself, Tierra Bot reacts with 👀 and then replies. Replies come from `OPENAI_API_KEY` with tool calling (`OPENAI_AGENT_MODEL`, falling back to `OPENAI_MODEL`). The tools read the imported SAP data: sales orders, customer POs, invoices and e-way bills, stock, BOMs, production, purchasing, approvals and tasks. Every figure comes from a tool and is as of the SAP backup date.

Who sees what is decided by the server, not the model. A linked Tierra account in a DM or on the desk gets every tool its role allows. A WhatsApp group linked to a customer only ever sees that customer's orders, invoices and dispatches, even when Alex writes there. An unlinked group or an unknown number gets no data; an unlinked group gets one line and the office gets a task to link it. In groups Tierra Bot answers when it is mentioned or when someone replies to one of its messages.

A PDF that looks like a purchase order is read, matched to the customer and its items, and checked against stock and the BOM. A PO that passes becomes a Tierra sales order (`TSO/26-27/0001`, numbered per financial year). The manager gets a procurement task (make, expedite), and the admin gets one approval message: the SO PDF with a summary, then the internal availability annex. The admin approves with 👍 (✅, 👌) on it, a reply like *approve* or *ok*, or "approve TSO/26-27/0001", and can ask questions about it in the same chat. The customer copy goes to the customer's mapped WhatsApp group 60 seconds later, at most once; *stop* in that window cancels it. "send back: <note>" sends it to the office to revise, and the next version comes back for approval. A PO that fails the check is held: the manager gets the shortage list, records arrivals with "received 20 kg TRPMLMTBB", and replies *done* to recheck. Customer-supplied material is never bought; the manager asks the customer. My Day and Approvals in the dashboard show the same tasks and decisions. The SO PDF prints the bank lines in `COMPANY_BANK`.

Any OpenAI model works for either setting. Reasoning models (the GPT-5 family, e.g. `gpt-5.6-terra` for the agent and `gpt-5.6-luna` for the PO reader, and the o-series) get `reasoning_effort` instead of a temperature: `OPENAI_AGENT_REASONING_EFFORT` and `OPENAI_REASONING_EFFORT`, default `low`. From GPT-5.4 on, agent turns that offer tools always send `none`, because Chat Completions requires it.

When Alex answers a pending sales order in his own words, `TYPESAFE_API_KEY` (TypeSafe) decides whether it approves, sends it back, or is a question. The reply must still contain an approval word, and anything unclear counts as a question. Without the key the OpenAI model makes that call.

`npm run eval` (backend) asks the real model a set of questions kept outside the repo in `~/tierra-data/evals/cases.real.yaml` and reports pass or fail. It needs `OPENAI_API_KEY`.

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
