# rlbotline Worker

The **LINE selfbot container** extracted from the rlbotline SaaS platform as a
standalone, deployable service. One worker process = **one LINE account** in one
isolated container. The worker is stateless on local disk:

- The **LINE session** (auth token + linejs storage blob with E2EE keys)
  persists to **Redis** (`REDIS_HOST`, no auth) so a restart restores it instead
  of forcing a fresh login — that persistence is the anti-ban mechanism: a
  fresh login rotates the LINE Letter Sealing key, and repeated fresh logins
  from the same IP risk the account. Leave `REDIS_HOST` unset and the session
  lives in memory only (fresh login every restart, loud warning logged).
- Everything else (admins, blacklists, dynamic watched chats, auto-replies, …)
  is **optional** and lives in a **Central API** — set `API_BASE_URL` to
  connect (`/state/*`, `/webhooks/*`, `/ws/sync`); leave it unset and the
  worker runs **fully standalone**: admin/permission/blacklist/toggle features
  default to off (no state store to read from), while the message-forward path
  keeps working via `WATCH_CHAT_IDS` → `WEBHOOK_URL` and bank-OA → onix.

> This repo is a copy of the worker module from the main monorepo. `API_BASE_URL`
> is **optional** — set it to connect to a Central API instance (the "central
> web" / webhook server) for the dashboard/control-plane integration, or leave
> it unset to run a self-contained forwarding bot with Redis as the only
> persistence. This repo does **not** bundle the API, the web dashboard, or a
> Redis server.

**สิ่งที่ worker ทำ:**

1. **ติดตาม LINE OA ธนาคาร** (`@scbconnect`, `@krungthaiconnext`, `@kbanklive`) แล้ว **forward ข้อความ
   ไปยัง onix** (destination server) ผ่าน endpoint `NotifyLineMessage` — ทำงานได้แบบ standalone เต็มรูปแบบ
   ไม่ต้องมี Central API — ดู [.docs/forwarding.md](.docs/forwarding.md)
2. เปิดให้ **user app ล็อกอิน LINE** ทั้งแบบ **QR** และ **email/password** — ผ่าน **inbound HTTP API**
   (`HTTP_PORT`, ตรงกับ container เลย) หรือผ่าน **central web** (ถ้าตั้ง `API_BASE_URL`) — ดู
   [.docs/login.md](.docs/login.md)

📐 **สถาปัตยกรรมทั้งหมดอยู่ใน [.docs/](.docs/)** — เริ่มที่ [.docs/architecture.md](.docs/architecture.md)

## Login

The worker authenticates with LINE using the first method that has what it needs:

1. **Auth token** — a token persisted in **Redis** (`{REDIS_KEY_PREFIX}:auth-token`) wins
   first; falls back to the `LINE_AUTH_TOKEN` env var if no Redis token exists (or Redis
   is disabled).
2. **Email / password** — provided **directly to the worker** via `LINE_EMAIL` +
   `LINE_PASSWORD` env vars **only** — there is no session-based credential source anymore.
3. **QR code** — used when there is no token and no email/password. The QR URL is
   printed to the worker logs (`QR login URL received — scan to log in`) and also
   reported to the Central API (when configured), so you can scan it from either place.

A 2FA **PIN challenge** may follow email/QR login; the PIN is logged and reported
to the Central API. If the PIN isn't completed within `PIN_WAIT_TIMEOUT_MS`, the
worker parks itself and must be restarted for a fresh PIN.

> **Session persistence (anti-ban):** set `REDIS_HOST` so the session (auth token +
> E2EE storage) survives restarts. Without it, every restart forces a fresh login,
> which rotates the LINE Letter Sealing (E2EE) key — messages encrypted under the old
> key can no longer be decrypted — and repeated fresh logins from a datacenter IP risk
> the account getting banned. Containers sharing one LINE account (e.g. redeploys) must
> share `REDIS_KEY_PREFIX` so they restore the same session. See [.docs/login.md](.docs/login.md) §9.

> **Anti-ban:** never run multiple bots behind the same host IP. Give each worker
> a unique `PROXY_URL`, and keep loop delays intact (Tag All, sweeps, etc.).

## Requirements

- **Bun** (runs the TypeScript directly — no build step). Docker image uses `oven/bun:1-slim`.
- Required env: **`INSTANCE_ID`**. **`INSTANCE_TOKEN`** is required only when `API_BASE_URL` is set
  (`loadConfig()` enforces it conditionally); a standalone deploy (no `API_BASE_URL`) doesn't need it
  at all.
- **`API_BASE_URL`** is **optional** — set it to connect to a Central API/dashboard exposing
  `/state/*`, `/webhooks/*`, `/ws/sync`; leave it unset to run fully standalone.
- **`REDIS_HOST`** is optional but recommended — without it the LINE session is in-memory only (see
  [Login](#login) above for why that matters).
- For onix forwarding (optional): **`ONIX_API_URL`** + **`ONIX_AGENT_ID`** + **`ONIX_API_KEY`** (see below).
- For standalone generic forwarding (optional): **`WATCH_CHAT_IDS`** + **`WEBHOOK_URL`**.
- A LINE account to log in as — via token / email+password / QR (see [Login](#login)).

## Quick start

```bash
cp .env.example .env      # fill in INSTANCE_TOKEN, INSTANCE_ID, REDIS_HOST (recommended),
                          # optionally API_BASE_URL (Central API) or WATCH_CHAT_IDS + WEBHOOK_URL
                          # (standalone forwarding), onix vars (ONIX_API_URL/ONIX_AGENT_ID/ONIX_API_KEY),
                          # and either LINE_EMAIL/LINE_PASSWORD or nothing (QR)
bun install
bun run dev               # or: bun run start
```

### Docker

Runs as a **standalone app container** — maps **port 3000** (the inbound HTTP API) and sets
**no resource limits** (it runs on its own, not as a fleet-managed worker). `docker-compose.yml`
**bundles a `redis` service** (redis:7-alpine, no auth, `--appendonly yes` + a `redis-data` volume so
the session survives a full-stack restart) and wires `REDIS_HOST=redis` into the worker automatically —
no external Redis needed. Point `REDIS_HOST` elsewhere (via `.env`) only if you prefer a managed Redis.

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
| `API_BASE_URL` | Central API base URL (state, webhooks, sync hub) — **optional**; unset = standalone mode |
| `INSTANCE_TOKEN` | Per-bot bearer token for `/state/*` (secret) — required only when `API_BASE_URL` is set; not needed standalone |
| `INSTANCE_ID` | Unique id for this bot instance; also the default `REDIS_KEY_PREFIX` suffix (`rlbotline:${INSTANCE_ID}`) |
| `REDIS_HOST` | Redis host — enables session persistence (auth token + E2EE storage) across restarts; unset = in-memory session only (loud warning logged) |
| `REDIS_PORT` | Redis port (default `6379`) |
| `REDIS_KEY_PREFIX` | Namespace for session keys (`{prefix}:auth-token`, `{prefix}:storage`); default `rlbotline:${INSTANCE_ID}` — containers sharing one LINE account MUST share this |
| `WATCH_CHAT_IDS` | Comma-separated chat ids to watch + forward to `WEBHOOK_URL` in standalone mode (no Central API); seeded into the registry at boot |
| `WEBHOOK_URL` | Generic forward sink; defaults to `${API_BASE_URL}/webhooks/forward` when `API_BASE_URL` is set, otherwise `undefined` — set explicitly for standalone forwarding |
| `LINE_EMAIL` / `LINE_PASSWORD` | Standalone email/password login sent directly to the worker (optional) — the only credential source now (no session-based fallback) |
| `LINE_AUTH_TOKEN` | Optional pre-issued auth token — fallback when no token is persisted in Redis |
| `ONIX_API_URL` | onix base URL (standard path appended) or full NotifyLineMessage endpoint (used verbatim) — enables onix forwarding when set (with agent id + key) |
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
are all set. This path works **fully standalone** — it never needs `API_BASE_URL`. Full contract
(endpoint, headers, payload mapping): [.docs/forwarding.md](.docs/forwarding.md).

### Standalone generic forwarding

With no Central API, set `WATCH_CHAT_IDS` (comma-separated chat ids) to watch arbitrary
groups/rooms and forward every non-command message to `WEBHOOK_URL`. Chats are seeded into the
in-memory watched-chats registry at boot — no `/state/watched-chats` calls involved. Details:
[.docs/forwarding.md](.docs/forwarding.md) §3b.

### Login via the central web (optional)

When `API_BASE_URL` is set, the central web can trigger login over the sync hub (RPC `login_qr` /
`login_password`); the worker reports the QR URL / PIN / result back as webhook events (`qrcode`,
`pincode`, `ready`, `error`). Without a Central API, use the [HTTP API](#http-api-standalone-login)
above instead. Flow + event payloads: [.docs/login.md](.docs/login.md).

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
.docs/        architecture, forwarding (bank OA → onix + standalone), login flow
src/
  core/       LINE client, redis-client (session store), event router, state client, sync, webhook,
              forwarder, onix-client, http-server, login-state, rate limiter, …
  features/   anti-unsend, tagall, welcome/goodbye, sub-admin, anti-kick/link/spam, sync, watch, intercept, …
  index.ts    worker bootstrap + lifecycle + sync-hub RPC handlers (incl. login_qr/login_password)
  types.ts    shared types (WorkerConfig, OnixConfig, RedisConfig, records, LINE op types)
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
- **State:** LINE session → **Redis** (`REDIS_HOST`, optional but recommended — no auth); everything
  else → **Central API** over HTTP (optional, `API_BASE_URL`) or safe in-memory defaults (default-off)
  when running fully standalone
