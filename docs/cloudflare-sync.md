# ซิงค์ด้วย Cloudflare Workers + D1 สำหรับประมาณ 10 คน

ใช้ Worker ตัวเดียวและ D1 ฐานเดียว แต่ **แต่ละคนสร้างคลังของตัวเอง** โทเคนและคีย์แยกจากกัน จับคู่ QR เฉพาะอุปกรณ์ของคนเดียวกัน เซิร์ฟเวอร์รับเฉพาะข้อมูลที่แอปเข้ารหัสแล้ว ไม่ได้รับรหัสผ่านหลัก คีย์เข้ารหัส ชื่อบัญชี หรือ TOTP secret ในรูปแบบข้อความที่อ่านได้

นี่คือเซิร์ฟเวอร์ของแอป MFA ของเรา ไม่ใช่บริการดึงรายการจาก Google/Microsoft Authenticator อัตโนมัติ ต้องนำเข้าของเดิมแล้วเพิ่มบัญชีใหม่ผ่านแอปของเรา การซิงค์ทำงานขณะเปิดและปลดล็อกแอป

## บริการที่ติดตั้งในโปรเจกต์นี้แล้ว

วันที่ 9 ตุลาคม 2026 ติดตั้งและตรวจผ่าน HTTPS จริงแล้วที่ **https://mfa-sync.pramchanok.workers.dev** ฐาน D1 อยู่ APAC ใช้ในแอปรุ่น 0.3.1 ได้เลย ไม่ต้องรัน Docker หรือทำขั้นตอนสร้างบริการซ้ำ

1. ปลดล็อกแอปด้วยรหัสผ่านหลักที่คุณตั้งเอง
2. เปิด **ซิงค์อุปกรณ์ → ตั้งค่าคลังซิงค์ใหม่** ใส่ URL ด้านบน
3. ช่องโทเคนสร้างคลัง ใช้ค่าในไฟล์ส่วนตัว `.tools/cloudflare-registration-token.txt` ภายใน repository นี้ ไฟล์จำกัดสิทธิ์เฉพาะผู้ใช้ Windows ปัจจุบันและไม่ถูก commit โทเคนนี้แยกจากรหัสผ่านหลักของแอป
4. จับคู่อุปกรณ์ของคนเดียวกันด้วย QR จากคลังนั้น คนละคนสร้างคนละคลัง อย่าใช้ QR เดียวกันทั้งกลุ่ม

ดู [ผลตรวจและข้อจำกัด](verification-cloudflare-2026-10-09.md) เซิร์ฟเวอร์มีคลังข้อมูลจำลองจากการตรวจ 1 คลัง ไม่ต้องนำคลังนั้นมาจับคู่บัญชีจริง ยังไม่มี APK/iPhone build ที่ติดตั้งบนโทรศัพท์แล้ว

## เริ่มใช้งานบน Cloudflare

ต้องมีบัญชี Cloudflare ที่เปิดใช้ Workers และ D1 เลือก Free ได้ ไม่จำเป็นต้องมี Docker หรือเปิดคอมเป็นเซิร์ฟเวอร์ ใช้ HTTPS ที่ `workers.dev` ได้ ไม่ต้องซื้อโดเมน

เปิด terminal ใน repository แล้วทำตามลำดับ:

```powershell
npm ci --prefix cloudflare
cd cloudflare
npx --no-install wrangler login --scopes account:read user:read workers:write workers_scripts:write workers_routes:write d1:write
npx --no-install wrangler d1 create mfa-sync --location apac
```

ขั้นตอนส่วนนี้สำหรับสร้างบริการใหม่ในบัญชีอื่นหรือชื่อใหม่ ค่า `database_id` ใน `cloudflare/wrangler.jsonc` ชี้ฐานที่ติดตั้งแล้วในโปรเจกต์นี้ หากสร้างบริการใหม่ นำ ID ที่ได้มาแทนค่าปัจจุบันเมื่อ Wrangler ยังไม่ได้แก้ให้เอง ID ฐานข้อมูลไม่ใช่รหัสลับ ส่วน secret ต้องเก็บแยกจากไฟล์นี้ อย่าเปิด read replication หรือเพิ่ม cache ให้ route ยืนยันสิทธิ์/ซิงค์ รุ่นนี้ตั้งใจอ่าน primary เพื่อป้องกัน cursor ถอยหลัง

```powershell
npm run db:remote
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url')+'\n')"
npx --no-install wrangler secret put SYNC_REGISTRATION_TOKEN
npm run deploy
```

เมื่อคำสั่ง `secret put` ถาม ให้ป้อนโทเคนที่สร้างด้วย Node เก็บค่านี้ใน password manager ของผู้ดูแล เป็น **โทเคนสร้างคลัง** แยกจากรหัสผ่านหลักของแอปและไม่ใช่ Cloudflare API token ห้ามใส่ใน source, URL, screenshot, issue หรือแชท ผู้ดูแลควรตั้งค่าคลังให้แต่ละคนโดยไม่แจกโทเคนนี้ให้ทุกคน เพราะผู้ถือโทเคนสร้างคลังเพิ่มได้จนเต็มโควตา

Wrangler จะแสดง URL เช่น `https://mfa-sync.<your-subdomain>.workers.dev` ตรวจด้วย:

```powershell
Invoke-RestMethod https://mfa-sync.YOUR-SUBDOMAIN.workers.dev/health
```

ควรได้ `status: ok` จากนั้นเปิดแอป **รุ่น 0.3.1 ขึ้นไป → ซิงค์อุปกรณ์ → ตั้งค่าคลังซิงค์ใหม่** ใส่ URL ของ Worker และโทเคนสร้างคลัง อุปกรณ์เครื่องอื่นของคนเดียวกันเลือก **จับคู่กับเครื่องเดิม** แล้วใช้ QR จากเครื่องแรก แต่ละคนใช้รหัสผ่านหลักของเครื่องตัวเองได้

คู่มือเตรียม Android/iOS อยู่ที่ [mobile.md](mobile.md) ยังต้อง build/install แอปมือถือของเราเอง ไม่สามารถใช้ Google/Microsoft Authenticator เป็นแอปมือถือสำหรับซิงค์นี้ได้

คำสั่งด้านบนสร้างและเผยแพร่บริการจริงในบัญชี Cloudflare ส่วนการรัน `check`, `db:local` และชุดทดสอบข้างล่างทำงานในเครื่อง ไม่ deploy

## รอบซิงค์และงบ Free

แอปรุ่น 0.3.1 ส่งทันทีหลังเพิ่ม/นำเข้า/ลบบัญชี ตรวจข้อมูลใหม่จากเครื่องอื่นทุก 60 วินาทีเมื่อมีความเคลื่อนไหว และ 120 วินาทีเมื่อไม่มีข้อมูลใหม่ กด **ซิงค์ตอนนี้** เพื่อรับทันที เครือข่ายล้มเหลวพัก 60 → 120 → 240 → 300 วินาที เมื่อกลับมาออนไลน์หรือกลับมาเปิดหน้าต่างจะตรวจทันที ขณะล็อก/ซ่อนแอปจะไม่ส่งคำขอซิงค์

| สมมติเปิดและปลดล็อกตลอด 24 ชั่วโมง | ตรวจทุก 120 วินาที | ตรวจทุก 60 วินาที |
| --- | ---: | ---: |
| 10 คน × 2 อุปกรณ์ | 14,400 คำขอ/วัน | 28,800 คำขอ/วัน |
| 10 คน × 3 อุปกรณ์ | 21,600 คำขอ/วัน | 43,200 คำขอ/วัน |

ตัวเลขนี้เป็นเฉพาะการตรวจตามรอบ ไม่รวม unlock/resume, กดซิงค์เอง, uploads, pagination, health probes หรือ traffic ที่ไม่พึงประสงค์ ใช้เป็นงบประมาณ ไม่ใช่ผลทดสอบโหลด production รุ่น 0.3.0 ยังตรวจทุก 10 วินาที: 30 เครื่องที่เปิดตลอดวันใช้ 259,200 คำขอ จึงควรอัปเดตทุกเครื่อง

Workers Free มี 100,000 requests/วัน **ใช้ร่วมกันทั้งบัญชี** และ CPU 10 ms ต่อ invocation; D1 Free มี 5 ล้าน rows read/วัน และ 100,000 rows written/วัน ขนาดสูงสุด **500 MB ต่อฐาน** และ 5 GB รวมทั้งบัญชี ตรวจข้อจำกัดล่าสุดจาก [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) และ [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) ตัวเลขตรวจเมื่อ 9 ตุลาคม 2026 ต้องติดตาม Workers requests/CPU และ D1 Metrics ใน dashboard หลังเปิดใช้งานจริง โควตารวมกับโปรเจกต์อื่นได้ และ Free อาจหยุดรับคำขอเมื่อเต็ม

## สิ่งที่ลดค่าใช้จ่ายและป้องกันข้อมูลข้ามคน

- ตรวจคลังที่ทันสมัยแล้ว: SELECT ด้วย primary key เพียง 1 แถว, ไม่ query ประวัติ, ไม่เขียน heartbeat/last_seen ลง D1
- ข้อมูลใหม่: ดัชนี `(vault_id, sequence)` อ่านต่อจาก cursor เท่านั้น จำกัดหน้าละ 100 รายการและต่ำกว่า 1 MiB
- อัปโหลด 100 รายการด้วย `json_each` และ SQL trigger ในคำสั่ง INSERT เดียว พร้อม SELECT latest ใน D1 batch ไม่ใช้ 100 queries ซึ่งชนข้อจำกัด Free ที่ 50 queries/invocation ได้
- แต่ละรายการมี ID คงที่ ส่งซ้ำตรงเดิมไม่เพิ่มรายการหรือเขียน counters; ID เดิมกับข้อมูลต่างกันยกเลิกทั้งชุด รวมทั้ง counters/sequence
- เช็กโทเคนแยกต่อคลังทุกคำขอ เก็บเฉพาะ SHA-256 hash; คีย์เข้ารหัสอยู่กับอุปกรณ์ ไม่มี cache ของสิทธิ์หรือ ciphertext response
- ใช้ native rate-limit bindings จึงไม่เขียนตาราง rate limit ใน D1 ทุก request; IP 240/นาที, vault 60/นาที, สร้างคลังรวม 5/นาที ตอบ 429 พร้อม `Retry-After: 60`

[Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) มี counters แยกต่อ Cloudflare location และ eventually consistent จึงไม่ใช่เพดาน traffic แบบ global ที่แม่นยำ และไม่ป้องกันการใช้ Workers request quota จากการโจมตีได้ทั้งหมด ควรติดตาม dashboard; ไม่ต้องเพิ่ม KV, Durable Objects หรือ cron เพื่อใช้งานปกติ 10 คน

## โควตาพื้นที่และการดูแล

ค่าเริ่มต้นใน migration:

| ข้อจำกัด | ค่า |
| --- | ---: |
| จำนวนคลัง | 20 (เผื่อคลังทดสอบ/เปลี่ยนเครื่องสำหรับ 10 คน) |
| ประวัติต่อคลัง | 20,000 รายการ |
| Accounted bytes ต่อคลัง | 8 MiB |
| Accounted bytes รวม | 128 MiB |
| Request body / จำนวนรายการต่อ upload | 1 MiB / 100 |
| Ciphertext ต่อรายการ | 16 bytes ถึง 64 KiB |

Accounted bytes คือขนาด Base64 + 128 bytes ต่อรายการ เผื่อ metadata ไม่ใช่ขนาดไฟล์ SQLite จริง มีพื้นที่เผื่อดัชนีและ overhead ก่อนเพดาน Free 500 MB ตรวจขนาดจริงใน D1 dashboard ไม่มีการลบประวัติหรือ tombstone อัตโนมัติ เมื่อเต็มจะปฏิเสธ upload ทั้งชุดด้วย 413 โดยแอปยังเก็บบัญชีและ pending changes ในเครื่อง

นับโควตาด้วย singleton counters ใน transaction ไม่มี `COUNT(*)`/`SUM(...)` สแกนประวัติทุกครั้ง หากต้องเพิ่มโควตา ให้ทำ migration ใหม่ที่ UPDATE แถว `relay_limits` โดยทบทวนพื้นที่จริงก่อน อย่าแก้ migration ที่ใช้แล้วหรือลบ rows/counters ตรง ๆ

สำรองฐานข้อมูลผ่าน Cloudflare D1 dashboard หรือ `wrangler d1 export mfa-sync --remote --output .wrangler/mfa-sync-backup.sql` เก็บ export อย่างปลอดภัย ไฟล์ใต้ `.wrangler/` ถูก gitignore พร้อมสำรอง vault เข้ารหัสจากแอปด้วย D1 backup อย่างเดียวไม่มี encryption key ที่ใช้กู้คืนบัญชี อย่าเก็บโทเคน/คีย์คู่กับฐานที่สำรองในที่สาธารณะ

หากย้ายจาก Docker: ยังไม่มีตัวโอนฐานข้อมูลอัตโนมัติ QR เก่าชี้เซิร์ฟเวอร์เก่า ต้องสำรอง vault, ซิงค์การเปลี่ยนแปลงของทุกเครื่องให้ครบ, หยุดซิงค์เดิมผ่าน UI แล้วสร้างคลังใหม่บน Worker จากบัญชีที่มีอยู่ ก่อนจับคู่เครื่องอื่นใหม่ การหยุดซิงค์ทิ้ง pending outbox จึงไม่ควรทำขณะเครื่องอื่นยังมีการเปลี่ยนแปลงที่ไม่ส่ง **อย่าลบ vault หรือรีเซ็ตรหัสผ่านเพื่อย้ายเซิร์ฟเวอร์**

การหยุดซิงค์ไม่เพิกถอนเครื่องอื่น รุ่นนี้ยังไม่มีบัญชีเข้าสู่ระบบบนเว็บหรือการเพิกถอนอุปกรณ์รายเครื่อง QR ให้สิทธิ์เข้าถึงทั้งคลัง ต้องส่งเฉพาะอุปกรณ์ที่เชื่อถือได้

## พัฒนาและทดสอบในเครื่อง

```powershell
cd cloudflare
npm ci
Copy-Item .dev.vars.example .dev.vars
```

สร้าง synthetic registration token ใหม่แล้วใส่ `.dev.vars` ห้ามใช้ข้อมูลจริง ค่านี้ gitignored และต้องไม่ซ้ำ production เปิด development diagnostics ด้วย `SYNC_DEBUG_LOGGING=true` ได้: log แสดงแค่หมวดคำขอและ status ไม่มี vault ID, URL/query, headers, payload, OTP หรือ token Production ปิด Workers observability โดยค่าเริ่มต้น ไม่ตั้ง debug flag ใน production

```powershell
npm run db:local
npm run dev
```

ใช้ `http://127.0.0.1:8787` ในแอปคอมเครื่องเดียวกัน หากพอร์ตไม่ว่าง Wrangler อาจเลือกพอร์ตอื่น ดูค่าจาก terminal มือถือต้องใช้ HTTPS Worker ที่ deploy แล้ว

```powershell
npm test
npm run check
# ต้องมี Rust/Windows prerequisites ตาม README หรือ build environment ของระบบนั้น
npm run test:native
```

ชุดทดสอบใช้ Cloudflare workerd/Miniflare + D1 local ไม่ใช่ mock SQLite ทดสอบ native เป็น vault จำลองสองไฟล์ใน temp directory ไม่แตะ vault ที่ติดตั้งอยู่ `npm run check` เป็น dry run ไม่ยืนยัน latency/CPU บน Free edge หรือการเข้าถึงจากโทรศัพท์จริง
