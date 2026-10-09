# ส่งบัญชีไปยัง Google / Microsoft Authenticator

1. เปิดแอปที่ติดตั้งและปลดล็อกคลังบัญชี
2. กด `…` มุมขวาบนการ์ดบัญชีที่ต้องการ แล้วเลือก **แสดง QR สำหรับแอปอื่น**
3. ใส่รหัสผ่านหลัก แล้วกด **ยืนยันและแสดง QR**
4. Google Authenticator: กด **+ → สแกน QR Code**
5. Microsoft Authenticator: เลือก **เพิ่มบัญชี → บัญชีอื่น → สแกน QR**
6. ตรวจว่ารหัสในทั้งสองแอปตรงกัน แล้วกด **เสร็จแล้ว / ปิด QR**

เป็นการคัดลอกบัญชี TOTP ครั้งเดียว การเพิ่ม/ลบ/แก้ไขภายหลังไม่ซิงค์ระหว่างแอป ไม่ใช่ QR จับคู่คลังซิงค์ของ MFA Desktop และไม่รองรับ Microsoft push / number matching / passwordless

QR มีคีย์ลับที่สร้างรหัสของบัญชีได้ อย่าส่งให้บุคคลอื่น ภาพจะหายภายใน 60 วินาที เมื่อปิดหน้าต่าง เมื่อแอปล็อก หรือเมื่อหน้าจอแอปถูกซ่อน การแสดงใหม่ต้องยืนยันรหัสผ่านอีกครั้ง แอปไม่บันทึกภาพลงไฟล์ คลิปบอร์ด หรือ browser storage

แอปเก็บ algorithm, digits และ period ตามต้นฉบับ หากต่างจาก SHA1 / 6 หลัก / 30 วินาที จะแสดงคำเตือนให้ตรวจความเข้ากันได้ของแอปปลายทาง ไม่เปลี่ยนค่ารหัสให้เอง ชื่อบริการหรือชื่อบัญชีที่มี `:` ไม่สามารถส่งออกในรูปแบบ label มาตรฐานนี้ได้

## ผลตรวจ 9 ตุลาคม 2026

- UI tests: 48 ผ่าน รวมการยืนยันรหัสผ่าน การล้างรหัสผ่านระหว่างรอ QR ซ่อนหลัง 60 วินาที การปิด/ล็อก/ซ่อนหน้าจอ และการเพิกเฉยผลลัพธ์ที่กลับมาช้า
- Rust tests: 32 ผ่าน; 3 เคสเดิมที่ต้องรันแยกยังถูก ignore (production snapshot timing/reopen และ relay integration)
- ทดสอบการส่งออกแล้ว parse กลับด้วยชื่อไทย อักขระ URL พิเศษ และ SHA1/SHA256/SHA512: คีย์ลับ ชื่อ algorithm จำนวนหลัก รอบเวลา และรหัส TOTP ตรงกัน
- TypeScript และ production frontend build ผ่าน; Windows native debug build ผ่าน
- `cargo fmt --check`, `cargo test --locked --offline` และ `cargo clippy --locked --offline --all-targets -- -D warnings` ผ่าน
- Windows release/NSIS installer build ผ่าน: `src-tauri/target/release/mfa-desktop.exe` และ `output/MFA Desktop_0.3.4_x64-setup.exe` (ยังไม่ได้ติดตั้งทับแอปของผู้ใช้)
- รุ่น 0.3.4 เพิ่มข้อความ **แสดง QR** ข้างปุ่มคัดลอกบน desktop เพื่อให้ค้นพบได้ง่าย จอแคบยังแสดงไอคอน QR พร้อม tooltip/accessible label
- ตรวจ `app_info` จาก release executable จริงได้ 0.3.4 และคำสั่ง `account_qr` มีอยู่จริง/ปฏิเสธเมื่อคลังล็อก ตรวจ production UI bundle เดียวกับที่ฝังใน release โดย mock บัญชีสมมติ: ปุ่มเห็นชัด เปิดหน้าต่างยืนยันได้ และจอ 1100/620/390px ไม่ล้น ภาพ: `output/account-export-qr-release-034-button.png`, `output/account-export-qr-release-034-confirm.png`
- Playwright ผ่าน WebView2 และ Rust IPC จริงด้วยคลังทดสอบแยก: รหัสผ่านผิดไม่แสดง QR และส่งออกขณะล็อกไม่ได้
- อ่านภาพ QR ที่ Rust สร้างและ UI แสดงจริงกลับด้วย jsQR: เป็น `otpauth://totp` และ secret/issuer/algorithm/digits/period ตรงต้นฉบับ ไม่มี setup URI หรือ secret เป็นข้อความใน UI
- ตรวจการล็อก native แล้ว QR/หน้าต่างถูกล้าง และตรวจหน้าจอ 1100, 620, 390px ไม่มีการล้นแนวนอน
- ภาพตัวอย่างข้อมูลสมมติ: `output/account-export-qr-native.png`, `output/account-export-qr-mobile.png`

ยังไม่ได้สแกนด้วย Google/Microsoft Authenticator บนโทรศัพท์จริง หรือ build/test บน macOS / Android / iOS

Rust สร้าง QR ภายใน Stronghold procedure ส่งเฉพาะ SVG data URL ผ่านคำสั่ง `account_qr` หลังตรวจรหัสผ่าน และตรวจว่า session ยังไม่หมดอายุ ไม่ส่ง raw key หรือ setup URI เป็นข้อความผ่าน IPC ไม่เพิ่มการบันทึกข้อมูลลับใน development log
