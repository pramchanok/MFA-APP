# MFA Desktop

แอป Authenticator สำหรับ Windows และ macOS พร้อมฐานแอป Android/iOS สร้างรหัส TOTP ออฟไลน์ เก็บบัญชีใน vault เข้ารหัส และซิงค์ระหว่างอุปกรณ์ผ่าน Cloudflare Workers + D1 หรือ Docker ของคุณเอง

**สถานะ: เวอร์ชันแรกสำหรับทดสอบด้วยบัญชีจำลอง** ควรตรวจสอบแอปและทดสอบการกู้คืนข้อมูลก่อนใช้กับบัญชีสำคัญ โปรเจกต์ยังไม่มี release ที่เผยแพร่หรือการยืนยัน OTA บนเครื่องจริง

เวอร์ชัน 0.2.0 เพิ่มการนำเข้าบัญชีเดิมจาก QR ส่งออกของ Google Authenticator แบบครั้งเดียว ดู [ผลตรวจ 0.2.0](docs/verification-google-import-2026-10-09.md), [ผลตรวจเวอร์ชันแรก](docs/verification-2026-10-09.md) และ [คู่มือการนำเข้าจากมือถือ](docs/google-import.md) สำหรับขั้นตอนและข้อจำกัด

เวอร์ชัน 0.3.0 เพิ่มคลังซิงค์แบบเข้ารหัส, QR จับคู่อุปกรณ์ และเซิร์ฟเวอร์ SQLite พร้อม Docker ดู [คู่มือเซิร์ฟเวอร์](docs/sync-server.md), [การ build Android/iOS และข้อจำกัดที่ยังไม่ตรวจบนเครื่องจริง](docs/mobile.md) และ [ผลตรวจซิงค์](docs/verification-sync-2026-10-09.md) ยังไม่มี APK/iPhone build

เวอร์ชัน 0.3.1 เพิ่มเซิร์ฟเวอร์ **Cloudflare Workers + D1 สำหรับประมาณ 10 คน** ลดการตรวจซิงค์เหลือทุก 1–2 นาที พร้อมส่งทันทีเมื่อเพิ่ม/ลบบัญชี ติดตั้งในบัญชีของเจ้าของโปรเจกต์แล้วที่ **https://mfa-sync.pramchanok.workers.dev** และตรวจ native sync ผ่าน HTTPS จริงแล้ว ดู [วิธีตั้งค่าและโควตา Free](docs/cloudflare-sync.md) และ [ผลตรวจ 0.3.1](docs/verification-cloudflare-2026-10-09.md)

## ความสามารถ

เวอร์ชัน 0.5.0 ปรับสัดส่วนหน้ารหัส เพิ่มคลิกการ์ดเพื่อคัดลอก ลากเรียงบัญชีและจำลำดับใน vault ของแต่ละเครื่อง รวมการเพิ่ม/นำเข้าไว้ในเมนูเดียวพร้อมสแกนกล้อง เลือกหลายภาพ วาง URI หรือกรอกคีย์ลับ ตรวจชนิด TOTP/Google export อัตโนมัติและยืนยันก่อนบันทึก ดู [ผลตรวจและขอบเขตการทดสอบ](docs/verification-layout-import-2026-10-09.md) และ [วิธีกด build/release เองบน GitHub](docs/manual-build-release.md)

เวอร์ชัน 0.4.2 ปรับการเข้ารหัส public key สำหรับ Windows Hello โดยคง private key ไว้กับระบบ และแยกข้อผิดพลาดการยืนยันใบหน้าออกจากการยกเลิก บิลด์ Windows พร้อมแล้ว แต่ยังรอตรวจ enrollment และปลดล็อกจริงด้วยใบหน้าให้ครบ ดู [หลักฐานและสถานะการทดสอบ](docs/verification-hello-2026-10-09.md)

เวอร์ชัน 0.4.1 แก้การนำเข้า QR ส่งออก Google Authenticator **เวอร์ชัน 2** ที่รุ่นก่อนแจ้งว่าข้อมูลเสียหาย รองรับชุดหลาย QR ตามเดิม ตรวจอ่านรูปจริง 2 รูปผ่าน native preview แล้ว ดู [ผลตรวจและขอบเขตข้อมูลส่วนตัว](docs/verification-google-v2-2026-10-09.md)

เวอร์ชัน 0.4.0 ปรับหน้าบัญชีเป็นการ์ดรหัสขนาดใหญ่ พร้อมค้นหาด้านบน ปุ่มซ่อน/คัดลอกบนการ์ด และเมนู `…` สำหรับแสดง QR หรือลบบัญชี เมนูด้านซ้ายรวมสำรองข้อมูล ซิงค์อุปกรณ์ และตั้งค่า รองรับโหมดสว่าง มืด และตามระบบ ดู [ผลตรวจหน้าจอและแอป Windows](docs/verification-account-ui-2026-10-09.md)

งานพัฒนา 0.3.2 เพิ่มตัวเลือก Windows Hello / Touch ID สำหรับปลดล็อกเฉพาะเครื่อง โดยยังใช้รหัสผ่านหลักได้ตามเดิม ดู [วิธีเปิดใช้และขอบเขตที่ตรวจแล้ว](docs/device-unlock.md) การยืนยันด้วยอุปกรณ์จริงและ Mac build ยังต้องตรวจบนเครื่องที่รองรับ

- ตั้งรหัสผ่าน vault อย่างน้อย 6 ตัว ใช้ PIN ตัวเลข 6–8 หลักหรือรหัสผ่านที่ยาวกว่านี้ได้ ใน **ตั้งค่า → ความปลอดภัย** เลือกเวลาล็อกอัตโนมัติ 1–1440 นาที (ค่าเริ่มต้น 5 นาที) หรือไม่ล็อกจนกว่าจะปิดแอป กดล็อกเองได้ทุกเมื่อ
- เปิดใช้ Windows Hello / Touch ID หลังยืนยันรหัสผ่านหลัก หากเครื่องไม่พร้อมใช้รหัสผ่านหลักได้เสมอ
- เพิ่มบัญชีด้วย Base32 secret, `otpauth://totp` URI หรือรูป QR Code ที่อ่านภายในเครื่อง
- นำเข้าบัญชีเดิมจาก Google Authenticator (`otpauth-migration://`) เลือกหลายรูปหรือเพิ่มทีละ QR ให้ครบชุด ตรวจรายการและเลือกบัญชีก่อนบันทึก เพิ่มรวมกับบัญชีเดิมและข้ามชื่อบริการ/บัญชีที่ซ้ำ
- รองรับ SHA1 / SHA256 / SHA512, รหัส 6 หรือ 8 หลัก และรอบเวลา 15–120 วินาที
- ค้นหาบัญชี คลิกการ์ดหรือปุ่มคัดลอก แสดงเวลานับถอยหลัง ลากจุดจับเพื่อเรียง (หรือใช้ปุ่มลูกศร/Home/End) และยืนยันก่อนลบบัญชี ลำดับเป็นของแต่ละเครื่องและไม่ถูกสลับเมื่อบัญชีซิงค์อัปเดต
- กด `…` บนการ์ดบัญชี → **แสดง QR สำหรับแอปอื่น** แล้วยืนยันรหัสผ่านหลักเพื่อให้ Google/Microsoft Authenticator สแกนเพิ่มบัญชี ภาพซ่อนภายใน 60 วินาทีและเมื่อแอปล็อก เป็นการคัดลอกบัญชีครั้งเดียว ไม่ซิงค์กับแอปอื่น ดู [วิธีส่งออกและผลตรวจ](docs/account-export-qr.md) สำหรับข้อจำกัดของค่ารหัสและชื่อบัญชี
- ส่งออกและนำเข้าไฟล์สำรองเข้ารหัส การนำเข้าจะแทนที่บัญชีทั้งหมดหลังยืนยันและตรวจสอบข้อมูลสำเร็จ
- รุ่นเดสก์ท็อปที่เปิดระบบอัปเดตจะตรวจหาอัปเดตทุกครั้งที่เริ่มแอป แสดงปุ่มเมื่อมีรุ่นใหม่ และให้ผู้ใช้ยืนยันก่อนติดตั้ง
- จับคู่แอปของเราด้วย QR ส่งการเพิ่ม/ลบทันที และตรวจข้อมูลจากเครื่องอื่นทุก 1–2 นาทีขณะปลดล็อกและออนไลน์ รายการออฟไลน์อยู่ใน outbox ที่เข้ารหัส
- เซิร์ฟเวอร์ Cloudflare/Docker เก็บเฉพาะ ciphertext และข้อมูลสำหรับยืนยันสิทธิ์ แยกคีย์เข้ารหัสจากโทเคนเซิร์ฟเวอร์ และตรวจความถูกต้องก่อนบันทึกข้อมูลที่รับมา

รวมรหัส **TOTP มาตรฐาน** ไว้ในหน้าเดียวได้ บัญชีเดิมใน Google Authenticator นำเข้าผ่าน QR ส่งออกได้ แต่ไม่ซิงค์การเพิ่ม/ลบจาก Google cloud ภายหลัง ยังไม่รองรับการดึงบัญชีหรือ cloud backup จาก Microsoft Authenticator โดยตรง บัญชีจาก Microsoft ต้องเพิ่มจากคีย์หรือ QR ตั้งค่า TOTP ของแต่ละบริการ แอปไม่รองรับ Microsoft push / number matching / passwordless หรือ HOTP บัญชีบริษัทต้องอนุญาตการใช้แอป Authenticator ภายนอก

การซิงค์ครอบคลุมบัญชีที่เพิ่มใน **แอปของเรา** เท่านั้น หลังนำเข้าของเดิมแล้ว ให้เพิ่มบัญชีใหม่ผ่านแอปนี้ Google/Microsoft Authenticator ไม่ได้ส่งรายการใหม่มายังแอปนี้ การซิงค์ทำงานเมื่อแอปอยู่ด้านหน้าและปลดล็อก ไม่รับประกันการทำงานขณะมือถือพักหรือปิดแอป

ไม่มีบริการรีเซ็ตรหัสผ่าน vault, biometrics หรือการเพิกถอนสิทธิ์แยกเครื่อง QR จับคู่ให้สิทธิ์เข้าถึงทั้งคลังและแสดง 60 วินาที การหยุดซิงค์บนเครื่องหนึ่งไม่เพิกถอนสิทธิ์เครื่องอื่น ตั้งเวลาเครื่องให้อัตโนมัติ เพราะรหัส TOTP ขึ้นอยู่กับนาฬิกาของเครื่อง

## เริ่มซิงค์มือถือกับคอม

1. ใช้ `https://mfa-sync.pramchanok.workers.dev` ที่ติดตั้งแล้วตาม [คู่มือ Cloudflare](docs/cloudflare-sync.md) หรือสร้างบริการของคุณเองตาม [คู่มือ Docker/HTTPS](docs/sync-server.md) มือถือต้องเข้าถึง URL HTTPS ได้
2. เปิดแอปคอม ตั้งรหัสผ่านหลัก และนำเข้าบัญชีเดิมที่ต้องการ
3. เปิด **ซิงค์อุปกรณ์ → ตั้งค่าคลังซิงค์ใหม่** ใส่ URL และโทเคนสร้างคลังจากเซิร์ฟเวอร์
4. บนอุปกรณ์อีกเครื่อง ติดตั้งแอปของเรา ตั้งรหัสผ่านหลักของเครื่องนั้น แล้วเลือก **จับคู่กับเครื่องเดิม** สแกนหรือวางรหัสจากเครื่องแรก
5. เพิ่มบัญชีผ่านแอปของเราบนเครื่องใดก็ได้ เมื่อเปิดและปลดล็อกอีกเครื่อง รายการจะซิงค์ถึงกัน รวมถึงการลบ

รหัสผ่านหลักแต่ละเครื่องเป็นคนละรหัสได้ การจับคู่ไม่ได้ส่งรหัสผ่านหลักให้เซิร์ฟเวอร์ โทรศัพท์ต้อง build/install แอป Android/iOS ก่อนตาม [คู่มือมือถือ](docs/mobile.md) รุ่นนี้ยังไม่ได้ทดสอบบนโทรศัพท์จริง

## พัฒนา

ใช้ Tauri 2, React, TypeScript, Vite และ Rust โดย Rust จัดการ TOTP, Stronghold, clipboard และไฟล์สำรอง ไม่ส่งคีย์ลับที่เก็บไว้หรือ setup URI เป็นข้อความกลับไปยัง UI การส่งออก QR หลังยืนยันรหัสผ่านส่งเฉพาะภาพที่สร้างใน Rust ซึ่งยังถือเป็นข้อมูลลับ ไม่เก็บใน browser storage หรือ log

สิ่งที่ต้องติดตั้ง:

- Node.js 24 และ npm (เซิร์ฟเวอร์ใช้ SQLite ในตัว Node 24)
- Rust stable รุ่น 1.90 ขึ้นไป พร้อม Cargo
- Windows: Visual Studio Build Tools พร้อม Desktop development with C++, Windows SDK และ Microsoft Edge WebView2
- macOS: Xcode command line tools (`xcode-select --install`)

ดู [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) สำหรับรายละเอียดของแต่ละระบบ

```sh
npm ci
npm run tauri -- dev
```

เปิดเฉพาะ UI สำหรับดูหน้าตาได้ด้วย `npm run dev` ที่ `http://localhost:1420` โหมด browser ใช้ข้อมูลจำลอง อ่านอย่างเดียว และไม่รับบันทึกคีย์จริง

โหมด development แสดงชื่อ native command ใน console เพื่อวิเคราะห์ปัญหา โดยไม่แสดง arguments, รหัสผ่าน, คีย์ลับ หรือรหัส OTP

```sh
npm test
npm run test:server
npm ci --prefix cloudflare
npm run test:cloudflare
npm run cloudflare:check
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

การทดสอบทั้งหมดใช้ข้อมูลจำลอง ห้ามเพิ่มรหัสผ่าน, recovery code, secret หรือ QR ของบัญชีจริงลง source, fixture, log หรือ screenshot

## สร้างตัวติดตั้งในเครื่อง

หากต้องการกด build และ publish release บน GitHub ด้วยมือ ให้ใช้ **Actions → Build desktop installers → Run workflow** ไม่ต้องตั้ง signing secrets สำหรับตัวติดตั้งทดสอบ ค่าเริ่มต้น `publish_release = true` จะ publish หลัง build ครบทุกแพลตฟอร์ม เลือก `false` เมื่อต้องการ Artifacts อย่างเดียว ดูขั้นตอนและ workflow สำหรับ signed OTA ใน [คู่มือ Build / Release ด้วยมือ](docs/manual-build-release.md)

```sh
# Windows: NSIS installer
npm run tauri -- build --bundles nsis

# บน Mac: app bundle และ DMG
npm run tauri -- build --bundles app,dmg
```

ไฟล์จะอยู่ใต้ `src-tauri/target/release/bundle/` การ build แบบนี้ยังไม่ลงลายเซ็นอัปเดตและจะแสดงว่า updater ยังไม่ได้กำหนดค่า ไม่ต้องใช้ signing key เพื่อพัฒนาหรือทดสอบตัวติดตั้งในเครื่อง

Windows ต้องใช้ Windows build environment และ macOS ต้อง build/test บน Mac หรือ macOS runner การ build บน Windows ไม่ได้ยืนยันการทำงานของ macOS ตัวติดตั้ง Windows อาจดาวน์โหลด WebView2 หากยังไม่มี และอาจแสดง SmartScreen เพราะยังไม่ได้ทำ Windows Authenticode signing

## ข้อมูลและไฟล์สำรอง

Vault อยู่ใน application data ของผู้ใช้ภายใต้ identifier `app.mfadesktop.authenticator` แยกจากไฟล์โปรแกรม โดยทั่วไปคือ `%APPDATA%\app.mfadesktop.authenticator` บน Windows และ `~/Library/Application Support/app.mfadesktop.authenticator` บน macOS ตัวติดตั้งและ updater ไม่ได้บรรจุ vault ของผู้ใช้

ส่งออกไฟล์สำรองจากแอปขณะปลดล็อก เก็บไฟล์ในที่ปลอดภัยแยกจากเครื่อง และจำรหัสผ่านที่ใช้กับ vault ตอนส่งออก การนำเข้าใช้รหัสผ่านของไฟล์สำรองนั้น การลืมรหัสผ่านทำให้กู้คืนข้อมูลไม่ได้ เก็บ recovery codes ของบริการและวิธีเข้าถึงสำรองไว้เสมอ

การนำเข้าเป็นการ **แทนที่** vault ปัจจุบัน ไม่ได้รวมบัญชี เก็บสำเนาของ vault ปัจจุบันก่อนนำเข้า ไฟล์ที่รหัสผ่านผิดหรือไม่ผ่านการตรวจสอบจะไม่แทนที่ข้อมูลเดิม

การเข้ารหัสช่วยปกป้องข้อมูลที่เก็บบนดิสก์ เมื่อปลดล็อกแอป คอมพิวเตอร์และ session ต้องเชื่อถือได้ การวาง Authenticator บนคอมพิวเตอร์เครื่องเดียวกับที่เข้าสู่ระบบลดการแยกอุปกรณ์ของปัจจัยยืนยันตัวตน Clipboard อาจถูกอ่านหรือเก็บประวัติโดยแอปอื่นได้ แอปพยายามล้างรหัสหลัง 30 วินาทีเมื่อ clipboard ยังเป็นรหัสเดิม แต่ไม่สามารถลบประวัติหรือสำเนาที่แอปอื่นเก็บแล้ว

## Signed updates / OTA

ส่วนนี้ใช้กับ Windows/macOS เท่านั้น Android/iOS ยังไม่มีระบบอัปเดตแอปอัตโนมัติในโปรเจกต์นี้ workflow มือถือสร้างไฟล์ทดสอบโดยไม่เผยแพร่ไปยัง Store หรือ TestFlight

ค่าเริ่มต้น `pubkey: "UNCONFIGURED"` ปิดการตรวจอัปเดตใน UI ใช้ GitHub Releases ของ `pramchanok/MFA-APP` เป็นที่แจกไฟล์และ `latest.json` ไม่มี server API เพิ่ม ผู้ใช้ต้องเข้าถึงไฟล์ release ผ่าน HTTPS ได้โดยไม่ต้องยืนยัน GitHub ส่วนตัว แอปไม่ได้ฝัง GitHub token หาก repository เป็น private ต้องเลือก hosting สาธารณะสำหรับ updater หรือออกแบบบริการยืนยันสิทธิ์แยกก่อนใช้งานจริง

สร้าง key บนเครื่องที่เชื่อถือได้และเก็บ **นอก repository**:

```sh
npm run tauri -- signer generate -w /absolute/private/path/mfa-desktop.key
```

เก็บ private key และ password ไว้ในที่สำรองที่ปลอดภัย Public key ใช้ตรวจความน่าเชื่อถือของอัปเดต การสูญเสีย private key จะกระทบการอัปเดตสำหรับแอปที่ติดตั้งไปแล้ว ห้าม commit `.key`, password, certificate หรือ secret ลง Git

สำหรับ signed build ตั้ง environment ต่อไปนี้ (ค่า public key คือเนื้อหา `.pub` ที่ Tauri สร้าง):

```powershell
$env:MFA_UPDATER_PUBLIC_KEY = Get-Content -Raw 'C:\private\mfa-desktop.key.pub'
$env:TAURI_SIGNING_PRIVATE_KEY = 'C:\private\mfa-desktop.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = 'your-private-key-password'
node scripts/prepare-release.mjs
npm run tauri -- build --bundles nsis --config src-tauri/tauri.release.conf.json
```

`scripts/prepare-release.mjs` ตรวจรูปแบบ public key และเวอร์ชัน แล้วสร้าง config ที่ Git ignore ไว้ เพื่อเปิด updater artifacts และฝัง public key จริง ไม่มี private key ใน config นั้น ก่อน release ให้เปลี่ยนเวอร์ชันใน `package.json`, `src-tauri/tauri.conf.json` และ `src-tauri/Cargo.toml` ให้ตรงกัน

Workflow `Build and publish signed release` เรียกด้วยมือเท่านั้น สร้าง Windows x64, macOS Apple Silicon และ macOS Intel แล้ว publish หลังทุกแพลตฟอร์มสำเร็จ ตั้ง repository secrets ก่อนเรียก:

| Secret | ใช้สำหรับ |
| --- | --- |
| `MFA_UPDATER_PUBLIC_KEY` | เนื้อหา Tauri `.pub` |
| `TAURI_SIGNING_PRIVATE_KEY` | เนื้อหา private key สำหรับ updater |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | รหัสผ่าน private key |
| `APPLE_CERTIFICATE` | Base64 ของ Developer ID Application certificate (`.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | รหัสผ่าน certificate |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application identity |
| `APPLE_ID` | บัญชี Apple สำหรับ notarization |
| `APPLE_PASSWORD` | App-specific password สำหรับ notarization |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_PROVISIONING_PROFILE` | Base64 ของ Developer ID provisioning profile สำหรับ app identifier และ Keychain access group |

Updater signature กับ macOS code signing / notarization เป็นคนละส่วน Workflow ต้องมีทั้งสองส่วนสำหรับ Mac ดู [Tauri updater](https://v2.tauri.app/plugin/updater/) และ [macOS signing](https://v2.tauri.app/distribute/sign/macos/) Windows release workflow นี้ยังไม่ได้กำหนด Authenticode certificate

ก่อนกดรัน signed release ควรตรวจ signature, ตัวติดตั้งทั้งสามแพลตฟอร์ม, entries ใน `latest.json` และทดสอบอัปเดตจากเวอร์ชันเก่าโดย vault ยังเปิดได้ Workflow จะพักไฟล์ไว้ใน draft ระหว่าง build แล้ว publish พร้อมกำหนดเป็น Latest ในรอบเดียวกันเมื่อครบทุกแพลตฟอร์ม การทดสอบ OTA ต้องมีเวอร์ชันที่ใหม่กว่าเวอร์ชันติดตั้งจริง

## CI และขอบเขตการตรวจสอบ

ทุก workflow เรียกด้วยมือผ่าน **Actions → Run workflow** เท่านั้น ไม่มี trigger จาก push/PR/tag `Validate desktop app` ทดสอบ frontend, Rust, format, Clippy, dependency audit และ compile executable บน Windows/macOS โดยไม่สร้าง release การ compile กับ unit tests ยังไม่ใช่หลักฐานว่าใช้งาน vault, clipboard, installer หรือ OTA บนเครื่องปลายทางผ่าน ต้องตรวจ native flow ด้วยข้อมูลจำลองเพิ่มเติม

ผลตรวจ dependency ณ 9 ตุลาคม 2026: `npm audit --omit=dev` ไม่พบช่องโหว่ ส่วน Rust/OSV มีประกาศเลิกบำรุงรักษา `bincode` และ `paste` ที่สืบทอดผ่าน Stronghold รวมถึง `proc-macro-error` ใน dependency ของแพลตฟอร์ม มี advisory ของ `glib` ใน lockfile ด้วย แต่ไม่อยู่ใน dependency tree ของ Windows จึงยังไม่ควรถือว่า Rust audit สะอาดทั้งหมด รายละเอียดอยู่ในบันทึกผลการตรวจสอบ

ไอคอนต้นฉบับสร้างด้วย `scripts/generate-icons.py` (ต้องมี Pillow) สามารถสร้าง PNG, ICO และ ICNS ใหม่โดยไม่ดาวน์โหลด artwork
