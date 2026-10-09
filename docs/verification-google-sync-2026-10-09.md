# Google import to MFA sync — 0.3.5

Approved flow: import selected Google Authenticator export accounts once, then use this app's encrypted device sync. This release adds the handoff; Google import and encrypted sync already existed. There is no Google sign-in integration.

## Changes

- Successful Google imports return their selected count and open a completion screen. Users can view offline codes or continue to sync setup without losing imported accounts.
- First setup opens the create-vault tab with the project's Cloudflare URL. Registration remains an explicit action requiring an administrator token; credentials are not bundled or auto-submitted.
- Existing connections keep the same shared vault. The completion screen distinguishes pending items, active sync and failures instead of assuming import means upload succeeded.
- Pairing still requires an explicit action; the capability QR expires after 60 seconds. Locking clears the completion screen and sensitive UI.
- Google changes still require another export/import. Subsequent additions within MFA sync automatically while the app is open and unlocked.

## Verification

- Vitest: 52 passed, including import selection, completion-to-setup, postponing setup without losing accounts, existing sync reuse and truthful pending/error messages.
- TypeScript and production Vite build passed.
- `cargo fmt --check` and Clippy for all targets with `-D warnings` passed.
- Rust: 32 passed, 4 ignored by default. The new isolated-relay integration was run separately and passed: multi-part Google import before setup; pairing two independent vaults; import after setup; persisted encrypted outbox across vault restart; peer receives all 3 accounts; both vaults match RFC 6238 SHA1 codes at timestamp 59; duplicate re-import rejected.
- Native Windows debug app, actual Rust IPC and a disposable localhost relay: imported 2 TOTP entries from 2 export parts; incomplete batch and HOTP rejected; completion opens sync creation; explicit creation uploads both entries, pending count reaches zero and lastSync is recorded; offline codes remain visible; browser storage stays empty; locking clears accounts and dialogs.
- Rendered native UI inspected at widths 1100, 620 and 390 without horizontal overflow. Screenshots in `output/google-import-sync-{success,mobile,setup,codes}-035.png` use synthetic accounts.
- Windows release and NSIS installer built successfully. EXE and installer ProductVersion are 0.3.5. Linker emits the existing missing libsodium debug-PDB warnings; packaging succeeds.

Artifacts: `src-tauri/target/release/mfa-desktop.exe`, `output/MFA Desktop_0.3.5_x64-setup.exe`.

The new integration used a disposable localhost relay, not the production Cloudflare vault. No real user Google QR, live Google phone comparison, or Android/iOS installation was exercised. Production Cloudflare deployment was not modified. Existing user vaults were not opened or changed by the native UI test.
