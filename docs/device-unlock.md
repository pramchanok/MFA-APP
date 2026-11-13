# Windows Hello / Touch ID

## วิธีใช้

1. ปลดล็อกด้วยรหัสผ่านหลักตามเดิม
2. เลือก **ตั้งค่า** ที่แถบด้านซ้าย แล้วกด **ตั้งค่า Windows Hello** หรือ **ตั้งค่า Touch ID**
3. ยืนยันรหัสผ่านหลักอีกครั้ง แล้วกดเปิดใช้และยืนยันกับระบบปฏิบัติการ
4. เมื่อกลับมาหน้าล็อกจะมีปุ่มปลดล็อกด้วยอุปกรณ์ พร้อมช่องรหัสผ่านหลักเดิม

เมื่อเปิดแอปและหน้าต่างอยู่ด้านหน้า แอปจะเรียก Windows Hello หรือ Touch ID ที่เปิดใช้ไว้แล้วหนึ่งครั้ง หากยกเลิกหรือยืนยันไม่ผ่าน ให้กดปุ่มปลดล็อกด้วยอุปกรณ์เพื่อลองใหม่ หรือใส่รหัสผ่านหลัก หลังล็อกแอประหว่างใช้งาน ให้เลือกวิธีปลดล็อกจากหน้าล็อก แต่ละเครื่องตั้งค่าแยกกันและปิดใช้ได้จากเมนูตั้งค่า

ต้องเก็บรหัสผ่านหลักไว้สำหรับกู้คืนไฟล์สำรองและย้ายเครื่อง การลืมรหัสผ่านไม่ได้แก้ได้ด้วยการติดตั้งใหม่ หน้าจอนี้ยังไม่ได้เพิ่ม Social Login หรือ Recovery Key

## การเก็บกุญแจ

รหัสผ่านหลักและรูปแบบคลัง Stronghold เดิมไม่เปลี่ยน Native backend ขอรหัสผ่านใหม่เพื่อพิสูจน์ว่าถอดคลังปัจจุบันได้ แล้วส่งเฉพาะกุญแจที่ได้ไปเก็บกับ OS ไม่มีรหัสผ่านหรือกุญแจส่งกลับ UI และไม่มีการเก็บใน browser storage

- Windows: สร้าง RSA key แยกแต่ละการเปิดใช้ใน Microsoft Passport Key Storage Provider และใช้ BCrypt กับ public key เพื่อห่อกุญแจของคลัง การลงทะเบียนใหม่ใช้ RSA PKCS#1 v1.5 เพื่อให้เข้ากับ Passport KSP ที่ปฏิเสธ OAEP ส่วนข้อมูลลงทะเบียนเดิมยังอ่านด้วย RSA-OAEP/SHA-256 แอปตรวจ key usage, export policy และ `NgcCacheType=1` ก่อนถอดกุญแจ และตั้ง `PinCacheIsGestureRequired` ให้ Windows Hello ขอการยืนยันใหม่ หากการทดสอบถอดกุญแจตอนลงทะเบียนไม่ผ่าน ผู้ใช้ยังเข้าคลังด้วยรหัสผ่านหลักได้
- macOS: ใช้ data-protection Keychain, `AccessibleWhenUnlockedThisDeviceOnly` และ `BIOMETRY_CURRENT_SET` ปิดการซิงค์ Keychain item ไป iCloud การเปลี่ยนชุดลายนิ้วมืออาจทำให้ต้องตั้งค่าใหม่
- `vault.device-unlock` มี version, UUID, salt และ ciphertext เฉพาะ Windows ส่วน Mac มีเพียงข้อมูลอ้างอิง ไฟล์นี้ไม่รวมใน backup/sync, จำกัดขนาด และต้องผูกกับ salt ของคลังปัจจุบัน การนำเข้าคลังอื่นไม่เปิดใช้ enrollment เก่าให้คลังใหม่
- หลังปิดใช้จะลบ OS key/item แล้วลบไฟล์อ้างอิง การเปิดใช้อีกครั้งทดสอบ protected read ก่อนบันทึกและล้าง key/item ใหม่เมื่อยืนยันไม่ผ่าน

## macOS signing

Unsigned/ad-hoc development builds ไม่มี identity ที่ data-protection Keychain ต้องการ จึงแสดงว่า Touch ID ยังไม่พร้อมและใช้รหัสผ่านหลักต่อได้

สำหรับ signed release ตั้ง CI secret `APPLE_TEAM_ID` และ `APPLE_PROVISIONING_PROFILE` (base64 ของ Developer ID provisioning profile ที่อนุญาต App ID และ Keychain access group `${APPLE_TEAM_ID}.app.mfadesktop.authenticator`) นอกเหนือจาก signing/notarization secrets เดิม `prepare-release.mjs` สร้าง entitlements และฝัง profile ลงใน `Contents/embedded.provisionprofile` ไม่เก็บไฟล์ที่สร้างลง Git ขั้นตอนนี้ยังไม่ได้รันบน Mac จริง ต้องตรวจ profile, codesign, notarization และ Touch ID ก่อนเผยแพร่

## การตรวจ Windows Hello รุ่น 0.4.2

ตรวจพบข้อผิดพลาดจริงสองขั้นตอน: Windows ปฏิเสธ biometric ticket (`0x80098044`) และเมื่อยืนยันผ่านแล้ว Passport KSP ปฏิเสธการเข้ารหัส (`0x80090027`) จึงปรับการเข้ารหัสด้วย public key และแยกข้อความผิดพลาด ดู [หลักฐานและสถานะการทดสอบอุปกรณ์จริง](verification-hello-2026-10-09.md) ข้อความว่าหน้าต่าง Windows ยืนยันสำเร็จอย่างเดียวยังไม่ยืนยันว่าเปิดใช้ในแอปสำเร็จ ต้องผ่านการถอดกุญแจทดสอบและบันทึก enrollment ด้วย

## ผลตรวจ 0.3.2 วันที่ 2026-10-09

- Frontend: 38 tests ผ่าน รวม unavailable/detection failure, Hello/Touch ID button, cancellation, explicit enrollment และ late enrollment response หลังล็อก
- Rust: 29 tests ผ่าน, 3 ignored ตามเดิม ทดสอบ Stronghold/KDF จริงกับ mock เฉพาะ OS boundary รวม wrong-password enrollment, cancellation/cleanup, restart, disable, password fallback, unavailable, tampered enrollment, vault binding และ backup isolation
- Windows `cargo check`, Clippy ทุก local target และ frontend production build ผ่าน
- Windows release + NSIS build 0.3.2 ผ่าน ตัวติดตั้งอยู่ที่ `output/MFA Desktop_0.3.2_x64-setup.exe` (4,234,126 bytes), SHA-256 `B933F5C89DA8E4227E4C85B905265C0ABD6A3CC2155763FD93504F0CA32DC901` ยังไม่ได้ติดตั้ง ตัว build มี warning PDB ของ libsodium ที่ไม่ได้แนบมา ไม่ใช่ build failure
- ตรวจ release-config generator ด้วยข้อมูลจำลอง: Windows ไม่ต้องใช้ Mac secrets, macOS ปฏิเสธเมื่อไม่มี team/profile และสร้าง entitlements/profile mapping เมื่อมีข้อมูล ผ่าน การตรวจนี้ไม่ยืนยัน provisioning profile จริงหรือการเซ็นแอป
- Browser ที่ 1100×760 และ 620×760: ตรวจปุ่มทั้งสองระบบ การยกเลิก ทางสำรอง และ modal เปิดใช้ด้วย mock IPC ผ่าน ภาพอยู่ใน `output/device-unlock-*.png` เป็นข้อมูลสมมติ
- Native Windows WebView + Rust จริงใช้ `.tools/device-native-uat` ที่แยกจาก app data: ตรวจพบ Windows Hello available, ปฏิเสธ device unlock ก่อนเปิดใช้, ปฏิเสธรหัสผ่านผิด, เปิดบัญชีจำลองด้วยรหัสผ่านถูกต้อง และล็อกกลับสำเร็จ ไม่ได้เรียก biometric enrollment หรือยืนยัน PIN จริง
- ยังไม่ยืนยัน Windows Hello create/enroll/decrypt บนเครื่องจริง, macOS compile/signing/Touch ID, OTA หรือการติดตั้งทับแอปผู้ใช้ ไม่เปลี่ยนข้อมูลคลังจริงและไม่เผยแพร่ release

## แหล่งอ้างอิง

- [Microsoft key storage properties](https://learn.microsoft.com/en-us/windows/win32/seccng/key-storage-property-identifiers)
- [Microsoft NCryptDecrypt](https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/nf-ncrypt-ncryptdecrypt)
- [Apple biometric Keychain access](https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id)
- [Apple macOS Keychain implementations](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)
- [Apple distribution signing and profiles](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac)
