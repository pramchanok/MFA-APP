# Workers + D1 verification — 0.3.1 — 2026-10-09

Implemented the existing encrypted relay API v1 on Cloudflare Workers + D1, with ten-person capacity assumptions and lower client request frequency. After the user completed Cloudflare OAuth login, a dedicated APAC D1 database and public Worker were provisioned and verified over HTTPS. No installed user vault was reset, imported, unlocked or modified; its SHA-256 still matches the earlier diagnostic baseline. No source was committed/pushed.

## Verified

| Check | Result |
| --- | --- |
| `npm run test:cloudflare` | 10 passed on real workerd + local D1 |
| `npm test` | 32 passed across 5 frontend suites |
| `npm run test:server` | 9 passed; Docker relay remains compatible |
| `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml` | 24 passed, 3 explicitly ignored |
| `npm --prefix cloudflare run test:native` | 1 ignored integration test explicitly run and passed against Worker + D1 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Passed |
| `cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Passed on Windows target |
| `npm run build` | TypeScript + Vite passed; also repeated by installer build |
| `npm run cloudflare:check` | Wrangler 4.149.0 deploy dry run passed; Worker 9.01 KiB / gzip 3.25 KiB |
| `npm --prefix cloudflare run db:local` | Actual Wrangler migration succeeded; 12 SQL commands |
| `npm --prefix cloudflare run db:remote` | New APAC database migration succeeded; 12 SQL commands, reported 2 ms |
| `npm --prefix cloudflare run deploy` + Wrangler secret upload | Published Worker and registration secret; HTTPS endpoint active |
| Public `GET /health` | HTTP 200, `Cache-Control: no-store`, `{status:ok}` |
| Public unauthenticated records request | HTTP 401, `{error:unauthorized}` |
| Native two-vault integration pointed at public HTTPS Worker | 1 passed; 3.43 seconds test duration, not a latency SLA |
| `npm audit --prefix cloudflare --json` | 0 known vulnerabilities, including development tools |
| `npm audit --omit=dev --json` | 0 known production JavaScript vulnerabilities |
| Tauri Windows NSIS release build | Passed, unsigned 0.3.1 installer produced |

Native test: two isolated synthetic Stronghold vaults create/pair a shared vault, preserve existing local accounts, receive matching TOTP codes, converge offline additions/deletions, then lock/unlock and sync without resurrecting deleted accounts. The integration script keeps Miniflare running while an asynchronous Cargo process exercises real HTTP/native encryption. It never uses an installed app data directory.

Worker tests exercise 10 distinct users with three concurrent device uploads each; sequential cursor integrity and cross-vault authorization; 100-record uploads; immutable exact retries; whole-batch conflict and quota rollback; concurrent registration at the vault cap; strict schemas/base64/stream size limits; pagination below 1 MiB; persistence across runtime restart; missing bindings fail closed; and rate-limit binding rejection.

Efficiency evidence: caught-up polls execute exactly `SELECT token_hash,latest FROM vaults WHERE id=?`. D1 reported `rows_read: 1`, `rows_written: 0`. Re-uploading the same 100 records reported zero rows written. `EXPLAIN QUERY PLAN` confirmed indexed records lookup without table scan or temporary sort. Counters are transactional singleton rows, not full-table aggregates.

Frontend tests verify idle polling at 120 seconds measured from request completion (including simulated network latency), immediate explicit refresh, queuing a local edit while a request is in flight, cancellation on component unmount, retry intervals capped at five minutes, offline/hidden suppression, immediate resume, and stale-response rejection after locking. Existing add/delete UI tests also verify an immediate sync after the native mutation succeeds, while deletion still requires explicit confirmation.

## Installer

- Path: `src-tauri/target/release/bundle/nsis/MFA Desktop_0.3.1_x64-setup.exe`
- Size: 4,204,480 bytes
- SHA-256: `3490B5B1329FEFC87973D7A27AEF775304AC12CC2315C951FC25882E8AF778D1`
- Authenticode/updater signing not configured; no OTA release published. Existing updater key remains `UNCONFIGURED`.

Local diagnostics and databases live in ignored `.tools/`, `cloudflare/.wrangler/` and `cloudflare/.test-output.log`; `.dev.vars` and nested `node_modules` are ignored. No credentials are committed. Development Worker diagnostics are opt-in and include only fixed route category and status, never request path/IDs, headers, tokens or payloads.

## Public deployment

- Worker: `mfa-sync`, URL: <https://mfa-sync.pramchanok.workers.dev>
- D1: `mfa-sync`, ID `cad1a214-501d-485e-9b6d-b637f3c50cd1`, created in APAC
- Production registration token set via stdin to Wrangler secret API; no credential value was printed in tool output/chat.
- Owner's private copy: `.tools/cloudflare-registration-token.txt`; Windows inherited ACLs removed and full access granted to the current user. It is gitignored. Recent Wrangler logs were checked for this exact token; zero matches.
- Wrangler OAuth uses Windows keyring via the pinned `@napi-rs/keyring@1.3.0` helper. Scopes cover account/user read, Workers/script/routes write and D1 write; no billing plan change was requested or performed.
- One synthetic integration vault is retained on D1: 5 encrypted records, 2,432 accounted bytes, consuming 1 of 20 vault slots. No real accounts were uploaded. Its ephemeral encryption key is not retained for user pairing; users should create their own vaults.
- Public HTTPS integration exercises the same native test as local D1, including pairing, matching codes, offline add/delete convergence and lock/unlock. This verifies the live transport/API path on Windows, not physical mobile support or sustained load.

## Limits of this evidence

- No sustained load, per-invocation Free CPU measurement, account-wide quota audit or physical mobile-network proof. Public workers.dev HTTPS and native API sync on Windows are verified. The 21,600–43,200 scheduled GETs/day estimate assumes ten users × three unlocked foreground devices at 120/60 seconds; extra operations and abusive traffic are excluded. Wrangler's reported 7 ms Worker startup is not request CPU usage.
- Worker tests use service-binding fetch inside workerd. The Miniflare HTTP proxy intermittently returned `ECONNRESET` on the request following a rejected oversized body; service-binding tests remove that transport dependency. Native integration separately verifies normal requests over HTTP. Public edge behavior for rejected oversized streams remains unverified.
- The three ordinary Rust ignores are the externally configured integration and two expensive production-strength snapshot tests. The integration was run separately here; production-strength snapshot tests were not repeated for this transport/polling change.
- Third-party libsodium link warnings concern unavailable debug PDBs; compilation/tests succeeded. Rust dependency advisories recorded in the preceding sync verification were not re-audited here. JavaScript audit results do not establish a clean Rust audit.
- No Android/iOS binary or physical-device test, macOS build, installer install-over-existing-vault test, or new Windows GUI automation was performed in this change. Mobile source and its KDF/camera/background constraints remain as documented in `mobile.md`.
- Per-location rate limits are approximate and do not guarantee global request quota protection. Logical storage quotas are not a precise SQLite file-size bound. No retention compaction, individual-device revocation, web account login or automatic Docker-to-D1 data migration was added.

Deployment instructions, capacity budget and account-isolation steps: [cloudflare-sync.md](cloudflare-sync.md).
