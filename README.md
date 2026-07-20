# rlbotline Worker

The **LINE selfbot container** extracted from the rlbotline SaaS platform as a
standalone, deployable service. One worker process = **one LINE account** in one
isolated container. The worker is stateless on disk — all persistence
(sessions, admins, blacklists, watched chats, …) lives in the **Central API**,
which the worker reaches over HTTP (`/state/*`, `/webhooks/*`, `/ws/sync`).

> This repo is a copy of the worker module from the main monorepo. It talks to a
> Central API instance you point it at via `API_BASE_URL`; it does **not** bundle
> the API or the web dashboard.

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

## Quick start

```bash
cp .env.example .env      # fill in API_BASE_URL, INSTANCE_TOKEN, INSTANCE_ID,
                          # and either LINE_EMAIL/LINE_PASSWORD or nothing (QR)
bun install
bun run dev               # or: bun run start
```

### Docker

```bash
docker compose up --build -d
docker compose logs -f worker   # watch here for the QR URL / PIN on first login
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
| `PROXY_URL` | Per-instance proxy (anti-ban) |
| `PIN_WAIT_TIMEOUT_MS` | How long to wait for the 2FA PIN before parking |

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
src/
  core/       LINE client, event router, state client, sync, webhook, rate limiter, …
  features/   anti-unsend, tagall, welcome/goodbye, sub-admin, anti-kick/link/spam, sync, watch, …
  index.ts    worker bootstrap + lifecycle
  types.ts    shared types (WorkerConfig, records, LINE op types)
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
