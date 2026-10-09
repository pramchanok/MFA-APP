# Google import verification — 0.2.0, 9 October 2026

## Delivered

- A one-time Google Authenticator export importer, reached from the dashboard's **นำเข้าจาก Google** button or the add-account dialog.
- Local PNG/JPG/WebP QR decoding, multiple image selection, masked migration URI entry, account preview and explicit selection/confirmation.
- Native bounded protobuf/base64 parser: version 1, complete matching batch required, at most 100 QR / 1,000 accounts; invalid data and duplicate QR rejected without echoing payloads. TOTP SHA1/SHA256/SHA512 with six/eight digits and thirty-second periods. HOTP and unsupported enums are shown as unselectable rows.
- Exact issuer/account label collisions are skipped conservatively. This is label-based duplicate protection, not secret-key comparison; labels with different capitalization remain different. An existing label is never silently overwritten.
- Preview returns metadata only. Import revalidates payloads, batch, selection, duplicates, session and capacity in Rust, then commits the whole selection once through the existing encrypted atomic vault writer. Native decoded secrets and input strings use zeroizing containers. JavaScript cannot guarantee erasure of immutable strings, but inputs/references are released on reset, close, lock or successful import, and are never persisted in browser storage or logged.
- App identifier and vault format remain unchanged; installed 0.1.0 vaults continue using their original app-data location. No migration or vault replacement is performed by Google import.

## Executed checks

- `npm test`: **19 passed**, including selection, disabled duplicate/HOTP entries, full-batch requirement, multiple local images, error preservation, late response disposal and application lock purging the import form.
- TypeScript/Vite production build: passed, including the build performed by Tauri packaging.
- `cargo test --locked --offline`: **16 passed, 1 ignored**. The ignored test is the existing optional production-strength snapshot timing benchmark, previously run for 0.1.0. New tests cover parser enums/overflow/truncation/bounds, 512 arbitrary bounded payloads without panic, batch consistency, metadata-only preview, selected additive persistence, invalid selection rejection, locked sessions and preserved ciphertext on rejection. Existing RFC6238 vectors and vault/clipboard tests also passed.
- `cargo clippy --locked --offline --all-targets -- -D warnings`: passed.
- `cargo fmt --check`: passed.
- Optimized Windows x64 build and NSIS packaging: passed. The pre-existing third-party libsodium missing-PDB linker warnings remain informational.

## Windows native UI evidence

Used the real embedded debug app through WebView2/CDP, with the debug-only data-directory override pointing to ignored `.tools/google-uat`, separate from normal app data. All accounts, passwords and QR images were synthetic. QR generation used a separate Node encoder of the published wire schema, not the Rust parser's own test helper.

Verified through the UI: create vault, upload the first of two QR images, see incomplete-batch notice and disabled import, upload the second image, see Google/Microsoft-labelled TOTP rows plus an unselectable HOTP row, explicitly confirm two accounts, show both accounts and codes together, lock, unlock and recover the same accounts, upload both images again, show two duplicate rows and a disabled zero-account import button. The Microsoft-labelled fixture came from a Google-format export; this does not demonstrate Microsoft Authenticator integration.

Native UI assertions returned `{duplicates:2, importDisabled:true}`. The dashboard fit an emulated 620×560 viewport without horizontal document overflow. Console check returned zero errors and zero warnings. Screenshots in ignored `output/playwright/`: `google-import-native.png`, `google-import-accounts-native.png`, `google-import-duplicates-native.png`, `google-import-narrow-native.png`.

## Installer

- `src-tauri/target/release/bundle/nsis/MFA Desktop_0.2.0_x64-setup.exe`
- Size: **3,574,219 bytes** (3.41 MiB)
- SHA256: `F112FD1799902BFA38D99B991AAACCF1A6D69B34CDC5BA3A3B3E4AE8C8701E4E`

## Boundaries

No real Google export or live account credentials were used. Compatibility with the user's installed Google Authenticator version still needs a local trial; the migration wire schema is unofficial and may change. Microsoft Authenticator cloud backup/import, Google/Microsoft cloud synchronization, Microsoft push/number matching/passwordless, direct camera scanning, macOS build/runtime, Windows installation/upgrade/uninstall, signing and live OTA were not verified in this task. The installer is unsigned and OTA remains unconfigured.

Dependencies are unchanged apart from the application version. Existing Rust dependency maintenance/target-specific advisories remain as documented in [the initial verification](verification-2026-10-09.md). No clean full Rust security audit or production readiness is claimed. No commits, pushes, workflow dispatches or releases were published.
