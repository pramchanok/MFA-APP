# Encrypted sync verification — 2026-10-09

Version 0.3.0. Local implementation and verification only. No commit, push, public deployment, store submission or signed OTA release was performed. All test credentials, account seeds and QR images are synthetic.

## Delivered source

- Shared React pairing/setup/status UI, QR image import and deliberate local disconnect. Pairing capability appears on demand and expires after 60 seconds; locking/unmounting purges visible pairing/account data.
- Native AES-256-GCM operation encryption with independent random encryption and bearer keys, authenticated vault/record context, immutable retries, deterministic Lamport/device/record ordering and deletion tombstones.
- Stronghold-protected sync credentials and atomically persisted account mutations, outbox, cursor and rollback watermark. Network/decryption/write failures preserve the previous snapshot. Empty polls avoid the snapshot KDF and disk rewrites.
- Node 24 HTTP/SQLite relay, strict schemas, transactional immutable appends, pagination, authentication hashes, request limits and storage quotas. Non-root Docker packaging and optional Caddy HTTPS configuration.
- Android/iOS source guards, mobile clipboard adapter, entry point, initialization/hardening scripts and manual artifact-build workflow. Mobile builds remain unverified as detailed below.

Sync covers accounts added/imported through **our app** after pairing. It does not read subsequent changes from Google Authenticator or Microsoft Authenticator. Polling runs every ten seconds while unlocked and in the foreground; it does not promise background delivery.

## Automated verification

| Check | Result |
| --- | --- |
| Frontend Vitest | 26 passed |
| TypeScript/Vite production build | Passed |
| Native Rust ordinary suite | 24 passed, 2 intentionally ignored |
| Real two-independent-vault relay integration | Separately passed, one of the ignored tests |
| Rust formatting and strict Clippy, all targets for the Windows host | Passed |
| Node HTTP/SQLite suite | 9 passed |
| npm production dependency audit | Zero reported vulnerabilities |

Native tests cover authenticated-record tampering, wrong vault context, duplicate/reordered records, deterministic simultaneous put/delete convergence, unknown-upload-outcome retries with identical immutable records, offline persistence, snapshot/cursor/outbox preservation after damaged network ciphertext, idle polling without snapshot changes and deletion when a peer never received the original put. Existing TOTP, Google migration, backup and clipboard checks remain in the suite. Ordinary native tests lower the snapshot work factor only inside test builds for speed; real native UI checks retain production settings.

The real relay integration used two independently password-protected native vaults and the actual loopback Node service. It exercised registration, pairing, account/code equality, an independent local account merged during pairing, offline deletion persistence, synchronization after reopening and convergence without resurrecting the deleted account.

## Native Windows UI

Used embedded WebView2 through Playwright/CDP with debug-only `MFA_TEST_DATA_DIR` directories under ignored `.tools/`. User app vaults were not used. Verified:

1. Create a local vault, create a shared relay vault through the UI, render/hide pairing QR and retain no browser local/session storage.
2. Add a synthetic TOTP account through the UI and observe the native encrypted outbox drain automatically, without pressing manual sync.
3. Launch a separate fresh native data profile with a different local password; pair through the UI and receive the first profile's account.
4. Display pairing QR on the peer; lock the app and confirm both QR and account UI disappear. Unlock again and confirm account/configuration persistence.
5. Render the sync dialog at a 390×844 WebView viewport: document width 390 and modal width 358, with no horizontal overflow. This is responsive UI evidence, not an Android/iOS device run.

Synthetic screenshots are ignored artifacts in `output/playwright/`: `sync-native-account.png`, `sync-native-peer.png`, `sync-native-pairing-scrolled.png`, `sync-native-narrow.png`. The scrolled pairing screenshot preceded a final cosmetic input-spacing adjustment. It is not a production pairing code; the temporary relay is stopped after verification.

## Docker

Both ordinary and TLS Compose configurations validated with a temporary synthetic registration token. The relay image built and ran as user `node` with a read-only root filesystem and temporary writable data storage. Root verification exercised health, registration, append, exact retry and readback: one immutable record remained after retry. The test container was stopped and removed. This opaque-record transport smoke test complements the native cryptographic integration; it does not itself validate encryption.

No public domain, DNS, certificate issuance, remote server or live HTTPS deployment was configured. Use [the server guide](sync-server.md) to configure your own endpoint. Phones require reachable HTTPS; desktop loopback HTTP is for local development only.

## Platform and release limits

- Android initialization was attempted and failed because Android SDK/NDK are absent. No APK, emulator or physical-device test was produced. The prepared workflow was not pushed or dispatched.
- iOS requires macOS/Xcode. No iOS app, simulator/device run or signing was performed here. macOS desktop builds also remain unverified on this Windows host.
- Stronghold snapshot work factor 19 requires approximately 512 MiB for its scrypt operation. Mobile memory/battery behavior must be measured before a mobile release; snapshot protection was not silently weakened.
- Mobile camera/file selection may trigger immediate suspension locking. Manual key/URI entry is available; camera permission, selection, background transitions and clipboard cleanup still need physical-device acceptance.
- Mobile encrypted backup sharing/import is not implemented; path-based backup buttons are disabled on phones. Desktop backup remains available and contains shared sync credentials if sync was configured.
- HTTPS transport uses Mozilla public CA roots. Private/local CA certificates are not accepted by adding them to the OS trust store; do not disable verification as a workaround.
- Pairing grants full shared-vault access. Disconnect stops only the local profile and discards its pending outbox; it does not revoke other devices. No individual-device revocation, key rotation, server history compaction or password recovery is implemented.
- Desktop signed OTA remains unconfigured. The Windows installer is unsigned; installation/uninstallation and an actual cross-version OTA upgrade were not automated. Mobile automatic app updates are not implemented by the desktop updater plugin.

## Dependencies

OSV queried 654 public crates from the final lockfile. Existing findings remain: bincode 1.3.3 (RUSTSEC-2025-0141), paste 1.0.15 (RUSTSEC-2024-0436), proc-macro-error 1.0.4 (RUSTSEC-2024-0370), and glib 0.18.5 (RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g). The first three are unmaintained-package notices. The glib unsoundness finding is a platform dependency; it has no active Windows dependency path. Raw results are in ignored `src-tauri/target/sync-dependency-audit.json`. This is not a clean Rust security audit or independent certification.

Third-party libsodium linking emits missing-PDB warnings; compilation and installer generation succeeded. No application credentials are logged by native commands or relay error handling.

## Windows artifact

`src-tauri/target/release/bundle/nsis/MFA Desktop_0.3.0_x64-setup.exe`

Final build succeeded after the last UI layout adjustment.

- Size: 4,213,992 bytes (4.02 MiB).
- SHA-256: `26D9CCCA224DA840145CCF176AB2452ABE46EB3D4B4E3286961EB2EC6B83BD3D`.

The isolated native app, loopback relay and temporary Docker container were stopped after verification. Test fixtures and generated output remain ignored. Repository source is still untracked/uncommitted, as it was before this work.
