# .docs — rlbotline Worker

เอกสารสถาปัตยกรรมของ worker (LINE selfbot container)

Worker รันได้ **standalone**: session (auth token + E2EE) เก็บที่ **Redis** (`REDIS_HOST`, ไม่มี auth) ส่วน
**Central API เป็นออปชัน** (`API_BASE_URL`) — ไม่ตั้งก็รันเดี่ยวได้ แล้ว forward เข้า `WEBHOOK_URL`

- [architecture.md](./architecture.md) — ภาพรวมระบบ, components, Redis session store, Central API
  (ออปชัน), runtime model, ตาราง env
- [forwarding.md](./forwarding.md) — เส้นทาง forward: Bank OA → onix (ติดตาม OA 3 ตัว, กรอง, onix
  NotifyLineMessage contract) และ standalone watch ผ่าน `WATCH_CHAT_IDS` → `WEBHOOK_URL`
- [login.md](./login.md) — on-demand login (QR + email/password) ผ่าน HTTP API (standalone) หรือ central
  web (WS-RPC): RPC, webhook events, sequence diagram, และ session persistence บน Redis

วิธีรัน/ติดตั้งดูที่ [../README.md](../README.md)
