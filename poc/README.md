# LINE Worker POC

Proves three things against the standalone LINE worker container in this repo:

1. **Login with QR**
2. **Login with email / password**
3. **Messages from a target group actually reach a destination server** (shown as raw JSON)

The stack is `redis` + the `worker` (built from `../Dockerfile`) + a tiny `poc-app` (Bun) that is
both the **login proxy** and the **webhook sink** the worker forwards to.

```
browser ──> poc-app :8080 ──(Basic auth)──> worker :3000   (login: QR / password)
              ▲                                  │
              └──────── /ingest <── WEBHOOK_URL ─┘          (forwarded group messages)
```

## Run

```bash
cd poc
cp .env.example .env      # set HTTP_API_KEY; leave WATCH_CHAT_IDS empty for now
docker compose up --build
```

Open <http://localhost:8080>. The header dot turns green when the worker is reachable.

## Test 1 — QR login

Click **เริ่ม QR login**. A QR image appears (the worker returns a QR *URL*; the POC renders it).
Scan it in the LINE app, enter the **PIN** shown on the page if prompted → state reaches `ready`
with your profile name. Session is saved to Redis, so restarts don't re-login.

## Test 2 — email / password login

Start from a fresh session (`docker compose down -v` first if already logged in). Enter email +
password → submit → enter the PIN if 2FA is required → `ready`. Wrong credentials show as `error`.

## Test 3 — group message → destination (raw JSON)

The worker only forwards chats listed in `WATCH_CHAT_IDS`, and there's no live "add watch" endpoint,
so you set the target group once:

1. Log in (test 1 or 2).
2. Send a message in the target group.
3. Find its chat id (starts with `c`): `docker compose logs worker | grep -i chatid`
   or look in `../logs` (RAW_OP_LOG is on, so even un-watched chats are captured).
4. Put it in `.env`: `WATCH_CHAT_IDS=c<...>` (comma-separate multiple).
5. `docker compose up -d` to apply.
6. Send another message in that group → it appears in the **section 3** feed with the full raw
   `ForwardedMessage` JSON (`messageId`, `chatId`, `chatName`, `text`, `raw`, …). That is the proof
   it reached the destination server.

## ONIX simulator

poc-app also stands in as the **ONIX destination server**. The worker's onix-client POSTs watched
**bank-OA** messages to `POST /admin-api/AdminAgent/org/global/action/NotifyLineMessage/{agentId}`
(Basic auth `api:ONIX_API_KEY`, header `Onix-Application-Type`, body `{sourceType, sourceKey,
sourceLabel, title, text}`). The sim records each call and shows it in **section 4** with an
`auth ✓/✗` flag. Enabled by the `ONIX_*` env in the compose file.

ONIX only fires for watched **OA** chats (from `BANK_OA_HANDLES`), so a real test needs an actual
bank-OA message. To self-test the sim endpoint without one:

```bash
curl -s -X POST \
  "http://localhost:8080/admin-api/AdminAgent/org/global/action/NotifyLineMessage/00000000-0000-0000-0000-000000000001" \
  -H "Content-Type: application/json" \
  -H "Onix-Application-Type: backend" \
  -H "Authorization: Basic $(printf 'api:apikey' | base64)" \
  -d '{"sourceType":"NOTIFICATION","sourceKey":"jp.naver.line.android","sourceLabel":"LINE","title":"Krungthai Connext","text":"เงินเข้า 23.25 บาท"}'
# → appears in section 4 with auth ✓
```

## Notes

- `HTTP_API_KEY` is shared: the worker requires it on `/login/*`, poc-app sends it. It never reaches
  the browser (poc-app proxies).
- No `API_BASE_URL` → the worker runs fully standalone (Redis session, no Central API).
- Sanity: `curl localhost:8080/api/health`, `curl localhost:8080/api/messages`.
- To hit the worker's login API directly, uncomment the `3000:3000` ports line in the compose file.
