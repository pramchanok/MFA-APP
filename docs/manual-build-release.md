# Build และ Release ด้วยมือบน GitHub

ทุก workflow ใน `.github/workflows/` เริ่มด้วย `workflow_dispatch` เท่านั้น ไม่มี trigger จาก push, PR, tag หรือ schedule เมื่อกดรัน workflow สำหรับ release ระบบจะ publish ให้หลัง build และอัปโหลดครบทุกแพลตฟอร์ม ไม่ต้องกด publish ซ้ำ

ต้องนำไฟล์ workflow ขึ้น **default branch** ของ GitHub ก่อนจึงจะเห็นปุ่ม `Run workflow` จากนั้นเปิด repository → **Actions** → เลือก workflow → **Run workflow** → เลือก branch → กดรัน ดูขั้นตอนทางการที่ [GitHub: Manually running a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

## Build ตัวติดตั้ง ไม่ต้องตั้ง secrets

เลือก **Build desktop installers** (`build-desktop.yml`) แล้วปล่อย `publish_release` เป็น `true` ตามค่าเริ่มต้น

Workflow ตรวจเวอร์ชัน ทดสอบ frontend/Rust แล้วสร้าง Windows x64 (`.exe`), macOS Apple Silicon (`.dmg`) และ macOS Intel (`.dmg`) ดาวน์โหลดแต่ละแพลตฟอร์มจาก **Artifacts** ด้านล่างหน้าผลรัน เก็บไฟล์ไว้ 14 วัน

เมื่อทุกแพลตฟอร์ม build ผ่าน workflow จะ publish release ชื่อ `MFA Desktop v<version> (test installers)` พร้อมตัวติดตั้งทั้งสามไฟล์ ใช้ `GITHUB_TOKEN` ของ workflow เท่านั้น ไม่ต้องเพิ่ม personal access token หากต้องการ build เพื่อดาวน์โหลดจาก Artifacts อย่างเดียว ให้เลือก `publish_release = false` ชุด unsigned จะไม่ถูกกำหนดเป็น Latest เพื่อสงวนช่องทาง OTA ให้ signed release

ไฟล์ชุดนี้เป็นตัวติดตั้งทดสอบ **ไม่มี updater signature และปิด OTA**; Windows ยังไม่มี Authenticode ส่วน macOS ยังไม่ได้ Developer ID signing/notarization และความสามารถ Keychain/Touch ID ของ signed app ต้องทดสอบผ่าน signed workflow บน Mac อีกครั้ง ระบบปฏิบัติการอาจแจ้งเตือนหรือบล็อกไฟล์ที่ไม่ลงนาม อ่านขอบเขตของ [Tauri distribution](https://v2.tauri.app/distribute/)

## Signed release สำหรับ OTA และ macOS signing

สำหรับ **Windows x64** มี workflow **Build signed Windows update** (`build-windows-update.yml`) ที่ใช้ secrets `MFA_UPDATER_PUBLIC_KEY` และ `TAURI_SIGNING_PRIVATE_KEY` รวมถึง `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` หากตั้งรหัสผ่านคีย์ Workflow ทดสอบแล้วสร้าง `.exe` และ `.exe.sig` ใน artifact `windows-x64-signed-update` โดยใช้คีย์ชุดเดิมสำหรับทุกเวอร์ชันในช่องทางนี้

เผยแพร่ตัวติดตั้งที่ตรวจลายเซ็นแล้วใน [MFA Desktop Windows Releases](https://github.com/pramchanok/MFA-Desktop-Releases/releases) พร้อม `latest.json` ตาม [รูปแบบ Tauri static JSON](https://v2.tauri.app/plugin/updater/#static-json-file) ระบุเวอร์ชันและ `platforms.windows-x86_64` โดยใส่ URL ดาวน์โหลด `.exe` ของ release นั้น และเนื้อหา `.exe.sig` ใน `signature` อัปโหลดให้ครบใน draft ก่อนเผยแพร่และตั้งเป็น Latest จากนั้นตรวจว่า URL `releases/latest/download/latest.json` และ URL ตัวติดตั้งเปิดได้โดยไม่ต้องล็อกอิน

ผู้ใช้ v0.5.2 หรือต่ำกว่าต้องติดตั้ง v0.5.3 หรือรุ่นใหม่กว่าจากช่องทางนี้ด้วยตนเองหนึ่งครั้ง หลังจากนั้นแอปตรวจเวอร์ชันใหม่และให้ผู้ใช้กดยืนยันติดตั้งในเมนู **ตั้งค่า → อัปเดตแอป**

สำหรับการออกรีลีสแบบลงนามครบทั้ง Windows และ macOS ให้ใช้ขั้นตอนด้านล่าง

เลือก **Build and publish signed release** (`release.yml`) หลังตั้ง **Settings → Secrets and variables → Actions → Repository secrets**:

| Secret | ค่า |
| --- | --- |
| `MFA_UPDATER_PUBLIC_KEY` | เนื้อหาไฟล์ `.pub` จาก `tauri signer generate` |
| `TAURI_SIGNING_PRIVATE_KEY` | เนื้อหา updater private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | รหัสผ่าน updater private key ถ้ามี |
| `APPLE_CERTIFICATE` | Base64 ของ Developer ID Application certificate `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | รหัสผ่าน certificate |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application identity |
| `APPLE_ID` | บัญชี Apple สำหรับ notarization |
| `APPLE_PASSWORD` | Apple app-specific password |
| `APPLE_TEAM_ID` | Team ID 10 ตัวอักษร |
| `APPLE_PROVISIONING_PROFILE` | Base64 ของ Developer ID provisioning profile ที่อนุญาต app identifier และ Keychain access group |

ต้องตั้งค่าของ Apple แม้เริ่ม build บน Windows เพราะ workflow นี้สร้างครบทั้งสามแพลตฟอร์ม ก่อนเริ่มเตรียม public key และ signing material ตามหัวข้อ Signed updates ใน README ห้ามใส่ค่าลับใน source หรือ workflow YAML

Workflow นี้ publish release ชื่อ `MFA Desktop v<version>` พร้อมตัวติดตั้ง, updater artifacts, signatures และ `latest.json` ตาม [Tauri action](https://github.com/tauri-apps/tauri-action) และกำหนดเป็น Latest เมื่อทุกแพลตฟอร์มสำเร็จ ยังไม่มี Windows Authenticode signing ควรตรวจ installer, กล้อง, clipboard, vault, Keychain/Touch ID และ OTA ด้วยบัญชีจำลองบนแต่ละแพลตฟอร์มก่อนเลือกรัน signed release สำหรับแจกจ่าย

ทั้งสอง workflow ใช้ draft ชั่วคราวระหว่างอัปโหลด และ publish ในรอบเดียวกันหลังไฟล์ครบ ผู้ใช้ไม่ต้องเปิด draft หรืออนุมัติอีกครั้ง หาก build หรืออัปโหลดล้มเหลวจะไม่ publish ให้แก้สาเหตุแล้วรัน workflow เดิมอีกครั้ง ทั้งสอง workflow หยุดถ้า tag `v<version>` เผยแพร่แล้ว และไม่ผสม unsigned กับ signed draft หากต้องเปลี่ยนชนิด ให้ลบ draft เดิมหรือเพิ่มเวอร์ชันก่อน

## เวอร์ชันและตรวจคุณภาพ

ก่อน release อัปเดตเวอร์ชันใน `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` และ `src-tauri/Cargo.lock` ให้ตรงกัน ตรวจด้วย `node scripts/check-release-version.mjs` tag ใช้ `v<version>` ของ app และอ้างอิง commit ที่เลือกตอนรัน

เลือก **Validate desktop app** (`validate.yml`) สำหรับ frontend/Rust tests, format, Clippy, dependency audit และ compile บน Windows/macOS โดยไม่มีการสร้าง release ส่วน **Build mobile test artifacts** (`mobile.yml`) สร้าง Android debug APK และ iOS simulator app เท่านั้น ไม่มี Store/TestFlight submission

การผ่าน local tests หรือ workflow syntax validation ไม่ใช่ผล build ของ GitHub runner ต้องกดรัน workflow บน GitHub และตรวจผลกับไฟล์จริงอีกครั้ง
