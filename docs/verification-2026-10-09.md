# Verification on 9 October 2026

## Delivered
- Local Tauri/React/Rust app; no commits, pushes, workflow dispatches or releases published.
- Unsigned Windows x64 NSIS installer: `src-tauri/target/release/bundle/nsis/MFA Desktop_0.1.0_x64-setup.exe`, 3,540,565 bytes.
- Installer SHA256: `9C53A3F78A16CC1AB94942B106DDE6E748175622E98FFD39BC6B63E988219288`.
- Signed OTA integration and manual draft-release workflow are present. The local installer intentionally has an unconfigured updater public key.

## Executed checks
- Frontend: 12 tests passed; TypeScript/Vite production build passed.
- Native: 10 tests passed, including all 18 RFC 6238 SHA1/SHA256/SHA512 vectors, invalid setup input, password failure, tampering, transactional backup/write behavior, idle expiry, clipboard retry/conditional clearing, exit cleanup and exclusive file locking.
- One timing test is ignored in the ordinary suite and was run separately at the real production Stronghold work factor 19. Passed; last debug timing: create 1.01s, add 1.90s, unlock 1.08s. Ordinary tests lower only snapshot scrypt work factor for speed; Argon2id retains full cost.
- `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` passed. Third-party libsodium debug linking emits missing-PDB warnings; this did not prevent tests or builds.
- Embedded Windows debug executable and optimized Windows NSIS build passed.
- Browser preview inspected at 1100x760 and 390x844, including search and add modal; preview is read-only with synthetic samples.

## Native Windows flow
Used an embedded debug build through WebView2/CDP, not the browser mock. Its debug-only `MFA_TEST_DATA_DIR` pointed to ignored `.tools/native-uat`, separate from the real user's app data. This override is compiled out of release builds.

Verified through the real UI: create password vault, upload/decode a PNG QR with a synthetic TOTP seed, save account, show codes/countdown, copy six-digit code, lock and purge account UI, reject incorrect password, and reopen the same account with the correct password. A same-process clipboard comparison confirmed the copied synthetic code was no longer present after lock; other clipboard content was never printed.

Verified through native IPC in that same app: export encrypted backup, delete synthetic account, reject a wrong backup password without replacing the empty current vault, lock, restore the backup with its correct password, and preserve the account ID. Assertions returned `{before:1, afterWrong:0, rejectedWrongPassword:true, restored:1, sameId:true}`. The actual encrypted vault file contained neither the test seed nor account label in plaintext. This plaintext check is corroborating evidence, not a cryptographic proof.

Screenshots are local ignored artifacts in `output/playwright/`: desktop-preview.png, narrow-preview.png, native-setup.png and native-account.png. All contain synthetic information only. Native backup file selection dialogs and the installer installation/uninstallation lifecycle were not automated.

## Dependency findings and boundaries
`npm audit --omit=dev`: zero reported vulnerabilities. OSV lookup examined 610 locked public Rust crates and returned:
- bincode 1.3.3: RUSTSEC-2025-0141, unmaintained, inherited through Stronghold.
- paste 1.0.15: RUSTSEC-2024-0436, unmaintained, inherited through Stronghold.
- proc-macro-error 1.0.4: RUSTSEC-2024-0370, unmaintained, platform dependency.
- glib 0.18.5: RUSTSEC-2024-0429, VariantStrIter unsoundness; no active Windows dependency path (`cargo tree -i glib` on Windows returned no path).

Raw lookup/advisory data is in ignored `src-tauri/target/native-dependency-*.json`. This is a current advisory lookup and source review, not a clean full Rust audit or independent security certification.

Not verified: macOS runtime/build on a Mac, Apple signing/notarization, Windows Authenticode, published signed updater artifacts, live OTA across versions, or production account enrollment. Those need platform runners/credentials and a deliberately published release. The unsigned installer is available for local evaluation; no real account secrets were used during development.
