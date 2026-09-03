# Integration Guide — เชื่อมต่อแอปเข้ากับ LINE Worker

คู่มือเชื่อมต่อแอปของคุณ (backend/frontend) เข้ากับ LINE worker container ครอบคลุม 3 เรื่อง:

1. **เชื่อมต่อ + Login** (QR / email-password) — §1
2. **Keep login session** ด้วย Redis (token ไม่หายเมื่อ restart) — §2
3. **Add + watch 3 bank OA** และ **ส่ง webhook** ไปปลายทาง (generic + ONIX) พร้อมตัวอย่างจริง — §3–4

ทุกตัวอย่างในเอกสารนี้ทดสอบจริงบนสแตก POC (`poc/docker-compose.yml`) แล้ว

```
your app ──HTTP──> worker :3000        login (QR / password), health
   ▲                   │
   │  Redis :6379 <─────┘               session persist (auth-token + storage)
   │                   │
   └── webhook <────────┘               forward ข้อความจากแชทที่ watch
       ├─ WEBHOOK_URL         (generic ForwardedMessage — ทุก watched chat)
       └─ ONIX NotifyLineMessage (เฉพาะ bank-OA ที่มี text)
```

---

## 1. เชื่อมต่อ + Login

worker เปิด HTTP API บน `HTTP_PORT` (default `3000`). Endpoint ทั้งหมด (`src/core/http-server.ts`):

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/health` | เปิด | — | `{ok, instanceId, uptimeSec, login, connection, lastSyncAgoSec}` — **503** เมื่อ `ok:false` |
| GET | `/status` | Basic | — | ใครล็อกอินอยู่ + build ที่ deploy + สถานะ session/forward/onix/watched (ดู §1.4) |
| GET | `/login/status` | Basic | — | `{ok, state, loggedIn, connection, lastSyncAgoSec, qrUrl?, pincode?, profileName?, profileMid?, error?, updatedAt}` |
| POST | `/login/qr` | Basic | — | `202 {ok, state, qrUrl?}` (รอ QR URL สูงสุด ~12s) |
| POST | `/login/password` | Basic | `{email, password}` | `202 {ok, state}` |

**Auth:** `/login/*` ใช้ HTTP Basic `api:HTTP_API_KEY` (เมื่อตั้ง `HTTP_API_KEY`); ถ้าไม่ตั้ง = เปิดโล่ง (log warning).
`/health` เปิดเสมอ.

**login state:** `idle → starting → qr_pending / pin_pending → ready` (หรือ `error`) — และ `ready → expired`
เมื่อ LINE เพิกถอน session ทีหลัง (ดู §1.5)

> ⚠️ **อย่าเช็ก `state === "ready"` เพียงอย่างเดียว** มันบอกแค่ว่า *ความพยายาม login ครั้งล่าสุด* สำเร็จ
> ให้ใช้ **`loggedIn`** ซึ่งเป็น `state === "ready" && session ยัง healthy`

### 1.1 QR login

```bash
KEY=poc-secret
# เริ่ม QR — ได้ qrUrl กลับมา (เป็น "URL string" ต้อง render เป็น QR image เอง)
curl -s -u api:$KEY -X POST http://localhost:3000/login/qr
# → {"ok":true,"state":"qr_pending","qrUrl":"https://line.me/R/au/lgn/sq/SQ...?secret=...&e2eeVersion=1"}

# poll สถานะจน state=ready (ระหว่างทางอาจได้ pincode ให้กรอกในแอป LINE)
curl -s -u api:$KEY http://localhost:3000/login/status
```

> POC (`poc/server.ts`) แปลง `qrUrl` เป็น PNG data URL ให้ (`qrDataUrl`) เพื่อให้ frontend เอาไปใส่ `<img>` ตรงๆ.
> ในแอปจริงคุณ render QR จาก `qrUrl` เอง (เช่น lib `qrcode`).

### 1.2 Email / password login

```bash
curl -s -u api:$KEY -X POST http://localhost:3000/login/password \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"secret"}'
# → 202 {"ok":true,"state":"starting"}  แล้ว poll /login/status ต่อ (2FA → pincode)
```

### 1.4 `GET /status` — ใครล็อกอิน + deploy เวอร์ชันไหน

```bash
curl -s -u api:$KEY http://localhost:3000/status
```

```jsonc
{
  "login":  { "loggedIn": true, "state": "ready",        // 1) ใครล็อกอินอยู่
              "profileName": "Onlyyou", "profileMid": "u0310fc16…",
              "awaitingScan": false, "awaitingPin": false },
  "build":  { "commitShort": "9500409", "branch": "develop",   // 2) code ที่ deploy
              "commit": "950040984bea…", "builtAt": "2026-07-25T08:05:11Z",
              "dirty": true, "version": "2.0.0" },
  "session":{ "store": "redis", "persistent": true, "keyPrefix": "rlbotline:poc-001" },
  "forward":{ "webhookUrl": "http://poc-app:8080/ingest", "configured": true, "signed": false },
  "onix":   { "enabled": true, "apiUrl": "…", "org": "global", "agentId": "…" },
  "watched":{ "total": 1, "oa": 1, "enabled": 1,
              "chats": [{ "chatId": "u4ca19114…", "chatName": "SCB Connect", "chatType": "oa" }] }
}
```

`build` มาจาก build args ที่ฝังตอน `docker build` — ต้องส่งตอน build ไม่งั้นได้ `"unknown"`:

```bash
cd poc
GIT_COMMIT=$(git rev-parse HEAD) \
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD) \
BUILD_TIME=$(date -u +%FT%TZ) \
GIT_DIRTY=$([ -n "$(git status --porcelain)" ] && echo 1 || echo 0) \
docker compose up --build -d
```

> `dirty: true` = image ถูก build ตอนที่ working tree มีของแก้ยังไม่ commit — commit ที่รายงานจึงไม่ตรงกับโค้ดจริงเป๊ะ

### 1.5 สถานะการเชื่อมต่อ LINE (`connection`) — ปลายทางต้องอ่านอันนี้

`login.state` บอกว่า *login ครั้งล่าสุดจบยังไง* ส่วน **`connection` บอกว่าตอนนี้ LINE ยังคุยกับบอทอยู่ไหม**
ค่านี้มาจาก poll loop ซึ่งเป็นส่วนเดียวของ worker ที่รู้ความจริงข้อนี้ (`src/core/session-health.ts`)

| `connection` | แปลว่า | `/health` | `loggedIn` | ปลายทางควรทำ |
|---|---|---|---|---|
| `idle` | poll loop ยังไม่เริ่ม (เพิ่งบูต / รอสแกน QR) | 200 | `false` | แสดงหน้าจอ login ตามปกติ |
| `online` | sync ล่าสุดยังสด | 200 | `true` | ปกติ |
| `degraded` | ล้มเหลวอยู่ แต่ยังไม่ถึง 3 นาที | 200 | `true` | ไม่ต้องทำอะไร (network สะดุดเป็นเรื่องปกติ) |
| `stalled` | ไม่ได้คุยกับ LINE เกิน 3 นาที (รวมกรณี `sync()` ค้างไม่ตอบ) | **503** | `false` | เตือนว่าบอทไม่รับข้อความ — worker กำลังกู้เอง (resync → restart) **ยังไม่ต้องให้ผู้ใช้ login ใหม่** |
| `expired` | LINE ปฏิเสธ session (`NOT_AUTHORIZED_DEVICE` / `AUTHENTICATION_FAILED`) | **503** | `false` | ขึ้น QR ให้ผู้ใช้ login ใหม่ |

- `expired` จะปลด `login.state` จาก `ready` เป็น `expired` ด้วย และถ้า LINE กลับมาตอบเองจะเลื่อนกลับเป็น
  `ready` อัตโนมัติ — ปลายทางไม่ต้องมี logic รีเซ็ตเอง
- `/health` เป็น endpoint เดียวที่เปลี่ยน **status code** (200 ↔ 503) — Docker HEALTHCHECK ใช้ตัวนี้
  ส่วน `/status` กับ `/login/status` ยังตอบ 200 เสมอ ให้ดูที่ `loggedIn` / `connection` ในตัว body
- **ไม่มี field เดิมถูกลบหรือเปลี่ยนความหมาย** — ของเก่าที่อ่าน `state`, `qrUrl`, `pincode`, `profileName`
  ยังทำงานเหมือนเดิม `loggedIn` / `connection` / `lastSyncAgoSec` เป็นของใหม่ที่เพิ่มเข้ามา

#### ตัวอย่าง response จริง

**A. บูตแล้ว ยังไม่ login**
```jsonc
// GET /health → 200
{ "ok": true, "instanceId": "bot-001", "uptimeSec": 3, "login": "idle",
  "connection": "idle", "lastSyncAgoSec": null }

// GET /login/status → 200
{ "ok": true, "state": "idle", "updatedAt": 0,
  "loggedIn": false, "connection": "idle", "lastSyncAgoSec": null }
```

**B. รอสแกน QR** — `/health` ยัง 200 (container ที่รอคนสแกนคือทำงานถูกแล้ว)
```jsonc
// GET /health → 200
{ "ok": true, "instanceId": "bot-001", "uptimeSec": 12, "login": "qr_pending",
  "connection": "idle", "lastSyncAgoSec": null }

// GET /login/status → 200
{ "ok": true, "state": "qr_pending", "updatedAt": 1788431084247,
  "qrUrl": "https://line.me/R/au/lgn/sq/SQ123?secret=xxx&e2eeVersion=1",
  "loggedIn": false, "connection": "idle", "lastSyncAgoSec": null }
```

**C. login แล้ว poll ปกติ**
```jsonc
// GET /health → 200
{ "ok": true, "instanceId": "bot-001", "uptimeSec": 300, "login": "ready",
  "connection": "online", "lastSyncAgoSec": 0 }

// GET /login/status → 200
{ "ok": true, "state": "ready", "updatedAt": 1788431084247,
  "profileName": "สมชาย", "profileMid": "u1f2e3d4c5b6a7988",
  "loggedIn": true, "connection": "online", "lastSyncAgoSec": 0 }

// GET /status → 200 (ตัดเฉพาะสองบล็อกแรก — ที่เหลือดู §1.4)
{
  "ok": true, "instanceId": "bot-001", "botName": "ร้านสาขา 1", "uptimeSec": 300,
  "login": {
    "loggedIn": true, "state": "ready",
    "profileName": "สมชาย", "profileMid": "u1f2e3d4c5b6a7988",
    "awaitingScan": false, "awaitingPin": false, "expired": false,
    "updatedAt": 1788431084247
  },
  "connection": {
    "state": "online", "healthy": true, "pollLoopRunning": true,
    "lastSyncOkAt": 1788431084247, "lastSyncAgoSec": 0,
    "stalledSec": 0, "consecutiveFailures": 0
  }
  // build / session / forward / onix / centralApi / watched …
}
```

**D. poll ล้มเหลว 1 รอบ** — สะดุดครั้งเดียวต้องไม่ทำให้ container ล้ม
```jsonc
// GET /health → 200
{ "ok": true, "instanceId": "bot-001", "uptimeSec": 305, "login": "ready",
  "connection": "degraded", "lastSyncAgoSec": 5 }
```

**E. เงียบเกิน 3 นาที (บอทหูหนวก แต่ session ยังไม่ตาย)**
```jsonc
// GET /health → 503
{ "ok": false, "instanceId": "bot-001", "uptimeSec": 500, "login": "ready",
  "connection": "stalled", "lastSyncAgoSec": 200,
  "error": "fetch failed: ECONNRESET" }

// GET /login/status → 200   ← state ยัง ready แต่ loggedIn=false
{ "ok": true, "state": "ready", "updatedAt": 1788431084247,
  "profileName": "สมชาย", "profileMid": "u1f2e3d4c5b6a7988",
  "loggedIn": false, "connection": "stalled", "lastSyncAgoSec": 200 }

// GET /status → 200 (บล็อก connection)
"connection": {
  "state": "stalled", "healthy": false, "pollLoopRunning": true,
  "lastSyncOkAt": 1788431084247, "lastSyncAgoSec": 200,
  "stalledSec": 200, "consecutiveFailures": 1,
  "lastError": "fetch failed: ECONNRESET"
}
```

**F. LINE เพิกถอน session — เคสที่เคยรายงานผิดว่า `ready`**
```jsonc
// GET /health → 503
{ "ok": false, "instanceId": "bot-001", "uptimeSec": 900, "login": "expired",
  "connection": "expired", "lastSyncAgoSec": 12,
  "error": "TalkException: NOT_AUTHORIZED_DEVICE" }

// GET /login/status → 200
{ "ok": true, "state": "expired", "updatedAt": 1788431084250,
  "profileName": "สมชาย", "profileMid": "u1f2e3d4c5b6a7988",
  "error": "LINE session หมดอายุ/ถูกเพิกถอน — ต้อง login ใหม่",
  "loggedIn": false, "connection": "expired", "lastSyncAgoSec": 12 }

// GET /status → 200 (สองบล็อกแรก)
"login": {
  "loggedIn": false, "state": "expired",
  "profileName": "สมชาย", "profileMid": "u1f2e3d4c5b6a7988",
  "awaitingScan": false, "awaitingPin": false, "expired": true,
  "error": "LINE session หมดอายุ/ถูกเพิกถอน — ต้อง login ใหม่",
  "updatedAt": 1788431084250
},
"connection": {
  "state": "expired", "healthy": false, "pollLoopRunning": true,
  "lastSyncOkAt": 1788431084247, "lastSyncAgoSec": 12,
  "stalledSec": 5, "consecutiveFailures": 1,
  "lastError": "TalkException: NOT_AUTHORIZED_DEVICE"
}
```

**G. LINE กลับมาตอบเอง** — ไม่ต้อง login ใหม่ ไม่ต้อง restart
```jsonc
// GET /health → 200
{ "ok": true, "instanceId": "bot-001", "uptimeSec": 960, "login": "ready",
  "connection": "online", "lastSyncAgoSec": 0 }

// GET /login/status → 200
{ "ok": true, "state": "ready", "updatedAt": 1788431084251,
  "profileName": "สมชาย", "profileMid": "u1f2e3d4c5b6a7988",
  "loggedIn": true, "connection": "online", "lastSyncAgoSec": 0 }
```

#### ตัวอย่างฝั่งปลายทาง

```ts
const s = await fetch("/login/status", { headers: auth }).then((r) => r.json());

if (s.loggedIn) {
  // ใช้งานได้ปกติ
} else if (s.state === "expired" || s.state === "error" || s.state === "idle") {
  showQrLogin();                       // ต้องให้ผู้ใช้ login ใหม่
} else if (s.connection === "stalled") {
  showWarning("บอทไม่ได้รับข้อความจาก LINE — กำลังกู้อัตโนมัติ");   // ยังไม่ต้อง login ใหม่
} else {
  showPending(s.state);                // starting / qr_pending / pin_pending
}
```

### 1.3 ผ่าน proxy ของ POC (ซ่อน API key จาก browser)

POC app (`:8080`) proxy ให้ frontend เพื่อไม่ให้ `HTTP_API_KEY` หลุดไปที่ browser:
`POST /api/login/qr`, `POST /api/login/password`, `GET /api/login/status`, `GET /api/health`.

---

## 2. Keep login session (Redis)

หลัง login สำเร็จ worker persist session ลง **Redis** เอง — restart แล้ว restore กลับ **ไม่ต้อง login ใหม่**
(การ login ใหม่บ่อยๆ จาก IP เดิมเสี่ยงโดนแบน + หมุนกุญแจ E2EE ข้อความเก่าถอดไม่ได้).

### 2.1 ตั้งค่า

```dotenv
REDIS_HOST=redis         # ว่าง = session อยู่ใน memory เท่านั้น (restart = login ใหม่ + warning)
REDIS_PORT=6379
REDIS_KEY_PREFIX=        # ว่าง → default "rlbotline:${INSTANCE_ID}"
```

ไม่มี Redis auth — ต่อด้วย `redis://host:port` เฉยๆ. container ที่ใช้ LINE account เดียวกัน (restart/redeploy)
**ต้องใช้ `REDIS_KEY_PREFIX` เดียวกัน** เพื่อ restore session เดิม.

### 2.2 Key ที่เก็บ

| Key | เนื้อหา | เขียนเมื่อ |
|---|---|---|
| `{prefix}:auth-token` | LINE auth token | ทันทีตอน login/refresh (event `update:authtoken`) |
| `{prefix}:storage` | linejs storage blob (รวม E2EE keys) | debounce 1s, flush ตอน graceful shutdown |

### 2.3 ยืนยันว่าใช้งานได้ (ทดสอบจริง)

```bash
# หลัง login สำเร็จ — เห็น 2 keys
docker compose exec redis redis-cli KEYS 'rlbotline:*'
# rlbotline:poc-001:storage
# rlbotline:poc-001:auth-token

# restart worker → restore จาก Redis (ไม่ขึ้น QR ใหม่)
docker compose restart worker
docker compose logs worker | grep -iE 'persisted auth token|Attempting login with auth token'
# Loaded persisted auth token from Redis
# Attempting login with auth token
```

Redis ใน compose ใช้ `--appendonly yes` + named volume `redis-data` → session รอด `docker compose down`
(หายเฉพาะ `docker compose down -v`).

---

## 3. Add + watch bank OA (4 official)

worker forward เฉพาะข้อความจากแชทที่อยู่ใน **watched registry** เท่านั้น. bank OA เข้า registry ได้ 2 ทาง:

### 3.1 Auto-follow ตอน boot — `BANK_OA_HANDLES`

```dotenv
BANK_OA_HANDLES=@scbconnect,@krungthaiconnext,@kbanklive
```

ตอน boot `ensureBankOaWatched()` (`src/index.ts`) จะ **idempotent** ต่อ handle: resolve `@handle` → mid
(`findContactByUserid`) → `addFriendByMid` (follow) → `addWatched({chatType:"oa"})`.
เรียกซ้ำได้ผ่าน RPC `ensure_bank_oa` (โหมด Central API).

> ⚠️ **ข้อควรระวังที่เจอจริง:** `findContactByUserid` จะ resolve ได้ต่อเมื่อ account **add OA นั้นเป็นเพื่อนไว้แล้ว**
> ถ้ายังไม่ได้ add จะขึ้น log `"Bank OA handle did not resolve to a contact"` แล้วข้าม (ไม่ watch).
> **วิธีแก้:** add OA ทั้ง 3 เป็นเพื่อนในแอป LINE ของ account นั้นก่อน แล้ว `docker compose restart worker`
> (restore session จาก Redis, ไม่ login ใหม่) — รอบนี้ resolve เจอ → follow + watch เป็น `chatType:"oa"`
> → เข้า path ONIX (§4.2) ได้.

### 3.1b Verified OA watch — `BANK_OA_MIDS` (แนะนำสำหรับ bank OA)

เพราะ §3.1 (`@handle`) resolve ไม่ได้ ใช้ **mid** ตรงๆ แทน — worker จะ **ตรวจว่า mid นั้น account add ไว้จริงไหม**
ก่อน watch (ไม่ auto-follow):

```dotenv
BANK_OA_MIDS=u4ca19114ed596ee2f4e63335ec7143fb,u8cc52e369d2bca4a5ce8c506170c712e,uce372f6ada1d1a0855973fefc2942f9a,ub2a0ffaaab7e5bdd10814ec88afe67fc
```

| ธนาคาร | @handle | mid |
|---|---|---|
| SCB | `@scbconnect` | `u4ca19114ed596ee2f4e63335ec7143fb` |
| KBank | `@kbanklive` | `u8cc52e369d2bca4a5ce8c506170c712e` |
| Krungthai | `@krungthaiconnext` | `uce372f6ada1d1a0855973fefc2942f9a` |
| GSB (ออมสิน) | `@gsbnow` | `ub2a0ffaaab7e5bdd10814ec88afe67fc` |

ตอน boot `ensureConfiguredOaWatched()` ทำ: `getAllContactIds()` → ถ้า mid **อยู่ใน contact** → watch เป็น
`chatType:"oa"` + ชื่อจริง (เข้า ONIX §4.2 ได้); ถ้า **ไม่อยู่** → ข้าม (ไม่ watch, ไม่ add — ให้ลูกค้า add เอง).
log ที่เห็น:

```
Configured OA watched (verified contact)   {"mid":"u4ca19114...","name":"SCB Connect"}   ← ยืนยันว่า mid = ธนาคารไหน
Configured OA not in contacts — skipped (customer must add it)   {"mid":"u8cc52e..."}      ← ยังไม่ได้ add
```

> ได้ mid มาจาก log ตอน OA ส่งข้อความ: `docker compose logs worker | grep -oE '"chatId":"u[0-9a-f]{32}"' | sort -u`

### 3.2 Watch มือ (fallback) — `WATCH_CHAT_IDS` หรือ `!watch add`

ถ้าไม่อยากพึ่ง auto-resolve หรืออยาก watch แชท/กลุ่มอื่น:

```dotenv
# seed ตอน boot — chatType derive จาก prefix ของ mid: c=group, u=user, r=room, s/m=square
WATCH_CHAT_IDS=u4ca19114ed596ee2f4e63335ec7143fb,c1234...
```

หรือ runtime (ไม่ต้อง restart): จาก account ที่ login พิมพ์ `!watch add <mid>` ในแชทไหนก็ได้.

**หา mid ของ OA/กลุ่ม:** เปิด `RAW_OP_LOG=1` แล้วส่ง/รับข้อความหนึ่งครั้ง — op จะถูกบันทึกแม้ยังไม่ watch.

⚠️ `RAW_OP_LOG` เขียนลง **ไฟล์เท่านั้น** (`./logs/log-DD-MM-YYYY.log`) — **ไม่ออก console** และไม่ขึ้นกับ `LOG_LEVEL`:

```bash
# 1) จากไฟล์ raw op (แหล่งหลัก — mid ถูก annotate ชื่อให้ด้วย)
grep -oE '"(to|from)":"u[0-9a-f]{32}"' logs/log-*.log | sort -u
grep -o '"param1":"u[^"]*"' logs/log-*.log | sort -u
# → "param1":"u4ca19114ed596ee2f4e63335ec7143fb (SCB Connect)"

# 2) จาก console (เฉพาะข้อความที่ไม่ใช่ text — log นี้ถูกปลดล็อกโดย RAW_OP_LOG=1)
docker compose logs worker | grep -iE 'chatId'
# ...{"chatId":"u4ca19114ed596ee2f4e63335ec7143fb","contentType":"FLEX",...}
```

> หมายเหตุ: watch มือให้ `chatType:"user"` (mid ขึ้นต้น `u`) → เข้า **generic forward (§4.1)** ได้
> แต่ **ไม่เข้า ONIX (§4.2)** เพราะ ONIX ต้อง `chatType:"oa"` (ตั้งได้จาก §3.1 เท่านั้น).

---

## 4. Webhook forwarding — 2 ปลายทาง

ทุกข้อความจาก watched chat (ที่ไม่ใช่คำสั่ง `!` และผ่าน filter) จะถูก fan-out ไปยัง sink ที่ตั้งไว้.
มี 2 รูปแบบ payload:

### 4.1 Generic — `WEBHOOK_URL` (ForwardedMessage)

```dotenv
WEBHOOK_URL=http://poc-app:8080/ingest
WATCH_HMAC_SECRET=          # ตั้งเพื่อเซ็น HMAC-SHA256 (Standard Webhooks)
WATCH_FORWARD_TIMEOUT_MS=5000
```

worker POST JSON นี้ (ทดสอบจริง — OA ส่ง `"เมนูข้อมูลผลิตภัณฑ์"`):

```json
{
  "messageId": "624250548178386945",
  "chatId":    "u4ca19114ed596ee2f4e63335ec7143fb",
  "chatName":  "u4ca19114ed596ee2f4e63335ec7143fb",
  "chatType":  "user",
  "senderId":  "u4ca19114ed596ee2f4e63335ec7143fb",
  "contentType": "RICH",
  "text":      "เมนูข้อมูลผลิตภัณฑ์",
  "receivedAt": 1784913626127,
  "instanceId": "poc-001",
  "raw": { "...": "linejs wire Message struct (redacted: ตัด chunks/DOWNLOAD_URL/PREVIEW_URL; bigint→string)" }
}
```

**Headers:** `Content-Type: application/json`, `User-Agent: rlbotline-worker/1.0`, `X-Webhook-Id`,
`X-Webhook-Timestamp`, และ (ถ้าตั้ง `WATCH_HMAC_SECRET`) `X-Webhook-Signature: v1,<base64 hmacSha256("{id}.{ts}.{body}")>`.

**ฝั่งรับ (ตัวอย่าง sink):** ดู `poc/server.ts` route `POST /ingest`. ตรวจ HMAC:

```ts
import { createHmac } from "node:crypto";
const expect = "v1," + createHmac("sha256", SECRET).update(`${id}.${ts}.${body}`).digest("base64");
// เทียบกับ header X-Webhook-Signature
```

จำลองส่งเองเพื่อทดสอบ sink:

```bash
curl -s -X POST http://localhost:8080/ingest -H 'Content-Type: application/json' \
  -H 'X-Webhook-Id: test-1' -H 'X-Webhook-Timestamp: 1784913626' \
  -d '{"messageId":"m1","chatId":"c123","chatName":"กลุ่มทดสอบ","chatType":"group","text":"เงินเข้า 23.25","instanceId":"poc-001"}'
```

### 4.2 ONIX — NotifyLineMessage (เฉพาะ bank OA ที่มี text)

```dotenv
ONIX_API_URL=http://poc-app:8080     # base URL ของ ONIX (ไม่มี trailing slash)
ONIX_ORG=global
ONIX_AGENT_ID=00000000-0000-0000-0000-000000000001
ONIX_API_USER=api
ONIX_API_KEY=apikey
ONIX_APPLICATION_TYPE=backend
ONIX_FORWARD_TIMEOUT_MS=5000
```

worker POST ไป `{ONIX_API_URL}/admin-api/AdminAgent/org/{ONIX_ORG}/action/NotifyLineMessage/{ONIX_AGENT_ID}`
(`src/core/onix-client.ts`) เมื่อข้อความ **มาจาก watched OA** (`chatType:"oa"`) **และมี text ไม่ว่าง**.
ถ้า `ONIX_API_URL` เป็น endpoint เต็ม (มี `/action/NotifyLineMessage` อยู่แล้ว) worker ยิงไปที่ URL นั้นตรง ๆ ไม่ต่อ path ซ้ำ:

```
POST /admin-api/AdminAgent/org/global/action/NotifyLineMessage/00000000-0000-0000-0000-000000000001
Content-Type:          application/json
Onix-Application-Type: backend
Authorization:         Basic base64("api:apikey")

{
  "sourceType":  "NOTIFICATION",
  "sourceKey":   "jp.naver.line.android",
  "sourceLabel": "LINE",
  "title":       "Krungthai Connext",   // = watched.chatName (ชื่อ OA)
  "text":        "เงินเข้า 23.25 บาท ..." // = msg.text
}
```

จำลองส่งเอง (ทดสอบ ONIX sink โดยไม่ต้องมี bank OA จริง):

```bash
curl -s -X POST \
  "http://localhost:8080/admin-api/AdminAgent/org/global/action/NotifyLineMessage/00000000-0000-0000-0000-000000000001" \
  -H "Content-Type: application/json" -H "Onix-Application-Type: backend" \
  -H "Authorization: Basic $(printf 'api:apikey' | base64)" \
  -d '{"sourceType":"NOTIFICATION","sourceKey":"jp.naver.line.android","sourceLabel":"LINE","title":"Krungthai Connext","text":"เงินเข้า 23.25 บาท"}'
# → {"status":"ok"}
```

**ONIX จะข้ามข้อความเมื่อ:** OA ส่งเป็น **FLEX/rich/media ที่ไม่มี text** (เช่น การ์ดเมนู) — ตัดทิ้งพร้อม log `debug`
(generic §4.1 ยังรับได้). onix ปิดอัตโนมัติถ้าไม่ได้ตั้ง `ONIX_API_URL`+`ONIX_AGENT_ID`+`ONIX_API_KEY` ครบ.

### 4.3 เงื่อนไขการ forward (สรุป)

| เงื่อนไข | generic (§4.1) | ONIX (§4.2) |
|---|---|---|
| อยู่ใน watched registry + `enabled` | ✅ | ✅ |
| ไม่ใช่คำสั่ง `!` + ผ่าน filter | ✅ | ✅ |
| `chatType === "oa"` | — | ✅ (ต้องมาจาก §3.1) |
| มี `text` ไม่ว่าง | — (forward ทุกชนิด) | ✅ |

---

## 5. Env reference (สำหรับ integration)

```dotenv
# --- เชื่อมต่อ + login ---
HTTP_PORT=3000
HTTP_API_USER=api
HTTP_API_KEY=poc-secret          # Basic auth สำหรับ /login/*
INSTANCE_ID=poc-001
API_BASE_URL=                    # ว่าง = standalone (ไม่ใช้ Central API)

# --- keep session (Redis) ---
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_KEY_PREFIX=                # default rlbotline:${INSTANCE_ID}

# --- watch bank OA / chats ---
BANK_OA_MIDS=                    # mid ของ bank OA (verified — ไม่ auto-follow) §3.1b
BANK_OA_HANDLES=                 # ปล่อยว่าง — @handle resolve ไม่ได้ (ดู §3.1)
WATCH_CHAT_IDS=                  # fallback: watch มือ (comma-separated)

# --- logging ---
LOG_LEVEL=debug                  # console: debug/info/warn/error (default info)
RAW_OP_LOG=1                     # raw op → ไฟล์ ./logs/ เท่านั้น (ไม่ออก console)
RAW_OP_LOG_DIR=/app/logs

# --- webhook: generic ---
WEBHOOK_URL=http://poc-app:8080/ingest
WATCH_HMAC_SECRET=
WATCH_FORWARD_TIMEOUT_MS=5000

# --- webhook: ONIX ---
ONIX_API_URL=http://poc-app:8080
ONIX_ORG=global
ONIX_AGENT_ID=00000000-0000-0000-0000-000000000001
ONIX_API_USER=api
ONIX_API_KEY=apikey
ONIX_APPLICATION_TYPE=backend
ONIX_FORWARD_TIMEOUT_MS=5000
```

## 6. Checklist ทดสอบ end-to-end

1. `docker compose up --build -d` → `curl localhost:8080/api/health` = `ok`
2. เปิด http://localhost:8080 → login (QR/password) → state `ready`
3. `docker compose exec redis redis-cli KEYS 'rlbotline:*'` → เห็น 2 keys (§2.3)
4. `docker compose restart worker` → log ขึ้น `Attempting login with auth token` (ไม่ login ใหม่)
5. add 3 bank OA เป็นเพื่อน → restart → log `Bank OA followed + watched` (ไม่ใช่ "did not resolve")
6. OA ส่งข้อความ **text** → เห็นใน section 3 (generic) และ section 4 (ONIX ถ้าเป็น oa+text)
7. ตรวจ payload: `curl localhost:8080/api/messages` และ `curl localhost:8080/api/onix`
