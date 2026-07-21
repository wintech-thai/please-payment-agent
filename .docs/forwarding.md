# Forwarding — Bank OA → onix

เอกสารนี้อธิบายเส้นทางที่ข้อความจาก **LINE OA ธนาคาร** ถูกส่งต่อไปยัง **onix** (destination server)

## 1. ภาพรวม pipeline

```mermaid
sequenceDiagram
  participant OA as LINE OA (ธนาคาร)
  participant LINE as LINE talk API
  participant PL as poll-loop
  participant ER as event-router
  participant IC as intercept feature
  participant OX as onix-client
  participant ONIX as onix NotifyLineMessage

  OA->>LINE: ข้อความ (เช่น "เงินเข้า 23.25 บาท")
  PL->>LINE: talk.sync() (long-poll)
  LINE-->>PL: op RECEIVE_MESSAGE (E2EE)
  PL->>PL: ถอด E2EE
  PL->>ER: emit "message"
  ER->>IC: onRawMessage(msg)
  IC->>IC: chat อยู่ใน watched registry + enabled?
  IC->>IC: เป็น OA + มี text?
  IC->>OX: notifyLineMessage({title, text})
  OX->>ONIX: POST + Basic auth
  ONIX-->>OX: 200 OK
```

ไฟล์ที่เกี่ยวข้อง:
- [../src/core/poll-loop.ts](../src/core/poll-loop.ts) — รับ + ถอด E2EE
- [../src/features/intercept.ts](../src/features/intercept.ts) — กรอง watched chats + เรียก onix
- [../src/core/chat-registry.ts](../src/core/chat-registry.ts) — registry ของ watched chats
- [../src/core/onix-client.ts](../src/core/onix-client.ts) — adapter → onix NotifyLineMessage
- [../src/core/forwarder.ts](../src/core/forwarder.ts) — forward แบบ generic (แยกจาก onix)

## 2. การเลือกว่าจะ forward อันไหน

`intercept` จะ forward เฉพาะข้อความที่:

1. มาจาก chat ที่อยู่ใน **watched-chats registry** และ `enabled = true`
2. **ไม่ใช่คำสั่งบอท** (ขึ้นต้นด้วย `COMMAND_PREFIX`)
3. ผ่าน **filter** ของ chat นั้น (`none` / `substring` / `regex`) ถ้ามีตั้งไว้

เฉพาะเส้นทาง **onix** เพิ่มเงื่อนไข:

4. `onix.enabled === true` (ตั้ง env ครบ)
5. `watched.chatType === "oa"` (เป็น official account)
6. ข้อความมี **text** ไม่ว่าง — onix's NotifyLineMessage สื่อสารด้วย `title` + `text`; ข้อความที่เป็น
   media/sticker ล้วน (ไม่มี text) จะถูก **ข้าม** พร้อม log ระดับ `debug` (ไม่ทิ้งเงียบ)

> การ forward แบบ generic (per-chat `forwardUrl`, user webhook targets, และ sink กลาง
> `/webhooks/forward`) ยังทำงานเหมือนเดิมทุกข้อความที่ผ่านข้อ 1–3 — onix เป็น sink **เพิ่มเติม** ไม่ทับของเดิม

## 3. การติดตาม OA ธนาคาร 3 ตัว

`BANK_OA_HANDLES` (default `@scbconnect,@krungthaiconnext,@kbanklive`) กำหนดว่าจะ follow + watch OA ตัวไหน

ตอน boot worker จะรัน `ensureBankOaWatched()` ([../src/index.ts](../src/index.ts)) — **idempotent**:

```mermaid
flowchart TD
  A["สำหรับแต่ละ @handle"] --> B["findContactByUserid(handle) → mid"]
  B -->|"ไม่เจอ"| W["log warn แล้วข้าม"]
  B -->|"เจอ mid"| C{"watched อยู่แล้ว?"}
  C -->|"ใช่"| S["ข้าม (idempotent)"]
  C -->|"ไม่"| D["addFriendByMid(mid) (follow)"]
  D --> E["addWatched({chatId: mid, chatType: 'oa', enabled: true})"]
```

- รันผ่าน **shared rate limiter** (talk proxy) — ปลอดภัยที่จะรันทุก boot
- เรียกซ้ำได้ผ่าน RPC **`ensure_bank_oa`** จาก central web
- ถ้าอยากคุมเอง (ไม่ auto) ตั้ง `BANK_OA_HANDLES=` (ว่าง) แล้วเพิ่มด้วยคำสั่ง `!watch add <mid>` แทน

## 4. onix contract (NotifyLineMessage)

อ้างอิงจากตัวอย่าง `examples/Admin/test-admin-agent-notify.rb` + `utils.rb` ของ onix

### Request

```
POST {ONIX_API_URL}/admin-api/AdminAgent/org/{ONIX_ORG}/action/NotifyLineMessage/{ONIX_AGENT_ID}

Content-Type:          application/json
Onix-Application-Type: backend
Authorization:         Basic base64("api:apikey")
```

### Body

```json
{
  "sourceType":  "NOTIFICATION",
  "sourceKey":   "jp.naver.line.android",
  "sourceLabel": "LINE",
  "title":       "Krungthai Connext",
  "text":        "เงินเข้า: 23.25 บาท เข้าบัญชี XX7157 เมื่อ 16/06/6"
}
```

### Mapping

| onix field | ที่มา | หมายเหตุ |
|---|---|---|
| `sourceType` | คงที่ `"NOTIFICATION"` | |
| `sourceKey` | คงที่ `"jp.naver.line.android"` | |
| `sourceLabel` | คงที่ `"LINE"` | |
| `title` | `watched.chatName` | ชื่อ OA เช่น "Krungthai Connext" |
| `text` | `msg.text` | ข้อความจริงจาก OA |

### Authentication

Basic auth: **user = `ONIX_API_USER` (default `api`)**, **password = `ONIX_API_KEY`** →
header `Authorization: Basic base64("api:apikey")` (สร้างใน `onix-client.ts` `buildBasicAuth`)

> รูปแบบ Basic auth `api:<key>` นี้ตรงกับที่ generic forwarder ทำอยู่แล้ว
> (`forwarder.ts` `buildApiKeyAuthorization`) — onix-client แค่เพิ่ม header `Onix-Application-Type`
> และ endpoint ที่มี `agentId` เข้าไป

## 5. Error handling

- `onix-client.notifyLineMessage()` **ไม่ throw** — คืน `{ ok, status?, error?, skipped? }`
- Timeout ต่อ request = `ONIX_FORWARD_TIMEOUT_MS` (default 5000ms) ผ่าน `AbortController`
- non-2xx หรือ network error → log `warn` + คืน `ok:false` (ไม่ล้ม pipeline)
- onix ไม่ได้ตั้งค่า → คืน `{ skipped: true }` (intercept ไม่ log เป็น error)

## 6. การตั้งค่า (env)

```dotenv
ONIX_API_URL=https://api.onix.example.com
ONIX_ORG=global
ONIX_AGENT_ID=198b743a-4579-41ee-853f-a748f6a40825
ONIX_API_USER=api
ONIX_API_KEY=apikey
ONIX_APPLICATION_TYPE=backend
ONIX_FORWARD_TIMEOUT_MS=5000
BANK_OA_HANDLES=@scbconnect,@krungthaiconnext,@kbanklive
```

onix forwarding **ปิดอัตโนมัติ** ถ้าไม่ได้ตั้ง `ONIX_API_URL` + `ONIX_AGENT_ID` + `ONIX_API_KEY` ครบ
