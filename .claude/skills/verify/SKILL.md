---
name: verify
description: Build, run, and drive the rlbotline dev stack (worker + Central API + Next dashboard) to observe a change actually working. Use when verifying any change under src/, packages/api/, or packages/web/.
---

# Verify rlbotline

Three separately-deployed services. Verify at the surface the change reaches:
worker (`src/`) → LINE ops; API (`packages/api/`) → HTTP; dashboard (`packages/web/`) → pixels.

## Bring up the stack

```bash
docker compose -f docker-compose.dev.yml up -d --build api    # :3001 (host) → 3000 (container)
BUILD_REF="$(git rev-parse --abbrev-ref HEAD)@$(git rev-parse --short HEAD)" \
  docker compose -f docker-compose.dev.yml up -d --build web  # :4000
```

Postgres: container `rlbotline-postgres-dev`, user/pass `rlbot`/`rlbot`, db `rlbotline`.

```bash
docker exec rlbotline-postgres-dev psql -U rlbot -d rlbotline -c "SELECT ..."
```

**Migrations apply on API boot** — rebuild/restart `api` and read the log to confirm:

```bash
docker logs --tail 20 rlbotline-api-dev 2>&1 | tail -20   # look for "migration applied"
```

`docker logs` output is summarized by an rtk hook; append `| tail -N` to see raw JSON lines.

## Auth — log in, never forge

The dev root account is seeded from `docker-compose.dev.yml` defaults (committed, not a secret):
`admin01` / `dev-root-change-me`.

```bash
curl -s -X POST http://localhost:3001/auth/login -H "Content-Type: application/json" \
  -d '{"username":"admin01","password":"dev-root-change-me"}'   # → { user, token }
# then: -H "Authorization: Bearer $TOKEN"
```

**Do not mint a JWT from the container's `JWT_SECRET`** — that's credential forging and the
auto-mode classifier blocks it (correctly). Use the login endpoint above.

## Drive the dashboard (GUI changes)

No Playwright installed. Use system Chrome over CDP:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --remote-debugging-port=9333 \
  --user-data-dir="$(mktemp -d)" --no-first-run --window-size=1280,800 about:blank &
curl -s http://localhost:9333/json/version   # confirm up
```

Then connect to `webSocketDebuggerUrl` from `/json/list` and use `Runtime.evaluate` /
`Page.navigate` / `Page.captureScreenshot`. Kill with `pkill -f "remote-debugging-port=9333"`.

**Auth state is `localStorage` (`token`, `user`)** — seed it via `Runtime.evaluate`.
To exercise the expired-session path, seed a *bogus* token: no real credential needed, the
API answers 401 and `SessionGuard` raises its dialog.

Next inlines `NEXT_PUBLIC_*` **at build time**, so the build-ref badge only appears if the
image was built with `--build-arg NEXT_PUBLIC_BUILD_REF=...`. It will NOT be in the container's
runtime env — check the bundle instead:
`docker exec rlbotline-web-dev sh -c 'grep -rl "<ref>" /app/.next/static'`.

Client pages are still server-rendered, so `curl -s http://localhost:4000/dashboard | grep ...`
is a fast way to confirm static header/shell markup without a browser.

## Worker

The worker is the hard one: it needs a live LINE session, and rebuilding it forces a re-login
(QR). **Don't rebuild the worker just to verify an unrelated change** — you'll knock the
account's session over.

Watch for `NOT_AUTHORIZED_DEVICE / AUTHENTICATION_DIVESTED_BY_OTHER_DEVICE` in worker logs: it
means two containers share one `INSTANCE_ID` and are fighting over the same LINE account (dev
compose reusing a prod `INSTANCE_ID` does this). The poll loop dies while `bots.status` still
reads `running`.

## Clean up

Delete rows you inserted, and drop the test toggles/admins you created. Use throwaway ids
(`u1111...`, `c9999...`) rather than touching real chats — enabling a real toggle changes what
the bot does in a live LINE group.
