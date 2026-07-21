# .docs — rlbotline Worker

เอกสารสถาปัตยกรรมของ worker (LINE selfbot container)

- [architecture.md](./architecture.md) — ภาพรวมระบบ, components, ช่องทางสื่อสารกับ central web, runtime
  model, ตาราง env
- [forwarding.md](./forwarding.md) — เส้นทาง Bank OA → onix: การติดตาม OA 3 ตัว, การกรอง, และ onix
  NotifyLineMessage contract (endpoint / headers / auth / payload)
- [login.md](./login.md) — on-demand login (QR + email/password) ผ่าน central web: RPC, webhook events,
  sequence diagram

วิธีรัน/ติดตั้งดูที่ [../README.md](../README.md)
