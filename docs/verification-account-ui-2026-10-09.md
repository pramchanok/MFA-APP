# Account cards UI — 0.4.0

Implemented the approved desktop design: account cards, sidebar navigation, top search, copy/hide controls, account actions behind `…`, and light/dark/system appearance. Backup and settings group the existing actions; Google export import and encrypted sync retain their existing behavior. No Google OAuth or direct Google cloud account import was added.

## Verification

- Vitest: 9 files, 56 tests passed. Coverage includes retained QR/password/lock/deletion/backup safeguards, card menu dismissal, hidden-code refresh, appearance persistence, and OS preference changes.
- TypeScript project build and Vite production build passed.
- Chrome with the production bundle and synthetic native responses: search, copy feedback, hide/reveal, QR confirmation, delete confirmation, settings, backup, Google import, and locking passed.
- Responsive checks: 1400px = 4 columns, 1100px = 3, 620px = 2, 390px = 1. No page overflow or clipped OTP groups, including 8-digit codes and long account labels.
- Actual Windows debug WebView/native IPC, using `.tools/account-ui-native-040` as an isolated vault: created a test vault, imported two Google export QR parts, rejected an incomplete batch and unsupported HOTP, rendered 9 accounts, searched, copied through the native clipboard command, hid/revealed codes, changed appearance, cancelled deletion, and locked successfully. No user vault was read or changed for these checks.
- Native QR export: wrong password rejected; generated image decoded as `otpauth://totp` with the expected synthetic secret, issuer, algorithm, digits and period; plaintext secret absent from the UI. Lock purged the QR and prevented export while locked.
- Browser storage contains only `mfa-appearance`; no account data, password or pairing credentials.
- Windows release and NSIS build passed. Both EXE metadata versions are `0.4.0`: `src-tauri/target/release/mfa-desktop.exe` (16,799,744 bytes), `output/MFA Desktop_0.4.0_x64-setup.exe` (4,279,953 bytes). The release includes the verified production frontend bundle; it was not installed over the user's app. Backend libsodium PDB linker warnings remain diagnostic warnings and did not fail either build.

## Evidence

- `output/playwright/account-ui-native-light.png`
- `output/playwright/account-ui-native-dark.png`
- `output/playwright/account-ui-native-qr.png`
- `output/playwright/account-ui-light.png`
- `output/playwright/account-ui-dark.png`
- `output/playwright/account-ui-menu.png`
- `output/playwright/account-ui-settings-dark.png`
- `output/playwright/account-ui-backup-dark.png`
- `output/playwright/account-ui-google-dark.png`
- `output/playwright/account-ui-mobile-dark.png`

## Scope

UI/native runtime checks used synthetic accounts. Scanning with a physical phone, Windows Hello biometric enrollment, Mac/mobile builds, and live sync service behavior were not retested for this UI change. The change does not modify their backend implementation.
