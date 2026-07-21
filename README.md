# rlbotline Worker

The **LINE selfbot container** extracted from the rlbotline SaaS platform as a
standalone, deployable service. One worker process = **one LINE account** in one
isolated container. The worker is stateless on disk — all persistence
(sessions, admins, blacklists, watched chats, …) lives in the **Central API**,
which the worker reaches over HTTP (`/state/*`, `/webhooks/*`, `/ws/sync`).

> This repo is a copy of the worker module from the main monorepo. It talks to a
> Central API instance (the "central web" / webhook server) you point it at via
> `API_BASE_URL`; it does **not** bundle the API or the web dashboard.

**สิ่งที่ worker ทำ:**

1. **ติดตาม LINE OA ธนาคาร** (`@scbconnect`, `@krungthaiconnext`, `@kbanklive`) แล้ว **forward ข้อความ
   ไปยัง onix** (destination server) ผ่าน endpoint `NotifyLineMessage` — ดู [.docs/forwarding.md](.docs/forwarding.md)
2. เปิดให้ **user app ล็อกอิน LINE** ทั้งแบบ **QR** และ **email/password** ผ่าน central web — ดู
   [.docs/login.md](.docs/login.md)

📐 **สถาปัตยกรรมทั้งหมดอยู่ใน [.docs/](.docs/)** — เริ่มที่ [.docs/architecture.md](.docs/architecture.md)

## Login

The worker authenticates with LINE using the first method that has what it needs:

1. **Auth token** — `LINE_AUTH_TOKEN`, or a token persisted in the Central API session.
2. **Email / password** — provided **directly to the worker** via `LINE_EMAIL` +
   `LINE_PASSWORD`, or from the Central API session. The session value wins when both exist.
3. **QR code** — used when there is no token and no email/password. The QR URL is
   printed to the worker logs (`QR login URL received — scan to log in`) and also
   reported to the Central API, so you can scan it from either place.

A 2FA **PIN challenge** may follow email/QR login; the PIN is logged and reported
to the Central API. If the PIN isn't completed within `PIN_WAIT_TIMEOUT_MS`, the
worker parks itself and must be restarted for a fresh PIN.

> **Anti-ban:** never run multiple bots behind the same host IP. Give each worker
> a unique `PROXY_URL`, and keep loop delays intact (Tag All, sweeps, etc.).

## Requirements

- **Bun** (runs the TypeScript directly — no build step). Docker image uses `oven/bun:1-slim`.
- A reachable **central web / Central API** at `API_BASE_URL` exposing `/state/*`, `/webhooks/*`, `/ws/sync`.
- Required env: **`API_BASE_URL`**, **`INSTANCE_TOKEN`**, **`INSTANCE_ID`**.
- For onix forwarding (optional): **`ONIX_API_URL`** + **`ONIX_AGENT_ID`** + **`ONIX_API_KEY`** (see below).
- A LINE account to log in as — via token / email+password / QR (see [Login](#login)).

## Quick start

```bash
cp .env.example .env      # fill in API_BASE_URL, INSTANCE_TOKEN, INSTANCE_ID,
                          # onix vars (ONIX_API_URL/ONIX_AGENT_ID/ONIX_API_KEY),
                          # and either LINE_EMAIL/LINE_PASSWORD or nothing (QR)
bun install
bun run dev               # or: bun run start
```

### Docker

Runs as a **standalone app container** — maps **port 3000** (the inbound HTTP API) and sets
**no resource limits** (it runs on its own, not as a fleet-managed worker).

```bash
docker compose up --build -d
docker compose logs -f worker   # watch here for login / status
curl http://localhost:3000/health
```

## Configuration

All configuration is via environment variables — see [.env.example](.env.example)
for the full list. Key ones:

| Var | Purpose |
| --- | --- |
| `API_BASE_URL` | Central API base URL (state, webhooks, sync hub) |
| `INSTANCE_TOKEN` | Per-bot bearer token for `/state/*` (secret) |
| `INSTANCE_ID` | Unique id for this bot instance |
| `LINE_EMAIL` / `LINE_PASSWORD` | Standalone email/password login (optional) |
| `LINE_AUTH_TOKEN` | Optional pre-issued auth token |
| `ONIX_API_URL` | onix base URL — enables onix forwarding when set (with agent id + key) |
| `ONIX_AGENT_ID` | onix agent UUID that receives `NotifyLineMessage` |
| `ONIX_API_USER` / `ONIX_API_KEY` | Basic auth for onix (default user `api`; key is the password) |
| `ONIX_ORG` / `ONIX_APPLICATION_TYPE` | onix path org segment (`global`) / `Onix-Application-Type` header (`backend`) |
| `BANK_OA_HANDLES` | LINE @handles to follow + watch (default: the 3 bank OAs) |
| `HTTP_PORT` | Inbound HTTP API port — login + health (default `3000`; `0` disables) |
| `HTTP_API_USER` / `HTTP_API_KEY` | Basic auth for `/login/*` (default user `api`; unset key = unauthenticated) |
| `PROXY_URL` | Per-instance proxy (anti-ban) |
| `PIN_WAIT_TIMEOUT_MS` | How long to wait for the 2FA PIN before parking |

### HTTP API (standalone login)

The container exposes an HTTP server on `HTTP_PORT` (default 3000) so a caller can drive login
directly — no central controller needed:

```bash
curl -u api:$HTTP_API_KEY -X POST http://localhost:3000/login/qr        # → { qrUrl }
curl -u api:$HTTP_API_KEY http://localhost:3000/login/status            # poll for pincode / ready
curl -u api:$HTTP_API_KEY -X POST http://localhost:3000/login/password \
  -H 'Content-Type: application/json' -d '{"email":"...","password":"..."}'
```

With `HTTP_PORT` enabled and no token/credentials, the worker waits for one of these calls instead
of auto-starting QR at boot. Full flow: [.docs/login.md](.docs/login.md).

### Forwarding to onix

Watched **bank OA** messages are POSTed to onix's `NotifyLineMessage` with Basic auth
(`api:<key>`). onix forwarding is **off** unless `ONIX_API_URL` + `ONIX_AGENT_ID` + `ONIX_API_KEY`
are all set. Full contract (endpoint, headers, payload mapping): [.docs/forwarding.md](.docs/forwarding.md).

### Login via the central web

The central web triggers login over the sync hub (RPC `login_qr` / `login_password`); the worker
reports the QR URL / PIN / result back as webhook events (`qrcode`, `pincode`, `ready`, `error`).
Flow + event payloads: [.docs/login.md](.docs/login.md).

## Scripts

```bash
bun run dev         # watch-mode worker
bun run start       # run the worker once
bun run typecheck   # bunx tsc --noEmit
bun run test        # bun test scripts/test-units.test.ts
bun run verify      # typecheck + test
```

## Layout

```
.docs/        architecture, forwarding (bank OA → onix), login flow
src/
  core/       LINE client, event router, state client, sync, webhook, forwarder, onix-client, http-server, login-state, rate limiter, …
  features/   anti-unsend, tagall, welcome/goodbye, sub-admin, anti-kick/link/spam, sync, watch, intercept, …
  index.ts    worker bootstrap + lifecycle + sync-hub RPC handlers (incl. login_qr/login_password)
  types.ts    shared types (WorkerConfig, OnixConfig, records, LINE op types)
scripts/
  worker-entrypoint.sh   Docker entrypoint (optional INSTANCE_TOKEN rotation)
  test-units.test.ts     unit + login-retry tests
  test-login.ts          standalone login smoke tool
.claude/
  agents/     sub-agent roster (architect, developers, test, doc-sync, reviewers, debugger)
  skills/     dev-loop, frontend-design, linejs, verify
```

## Stack

- **Runtime:** Bun (TypeScript, run directly — no build step)
- **LINE library:** `@evex/linejs`
- **State:** none locally — HTTP to the Central API
