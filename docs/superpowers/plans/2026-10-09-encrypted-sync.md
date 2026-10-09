# Encrypted Sync Implementation Plan

> **For agentic workers:** Use the collaboration agents according to the swarm-orchestration skill for independent subsystem implementation, then integrate and verify in this existing checkout. No commits/pushes/deployment unless requested.

**Goal:** Automatically synchronize authenticator accounts between our desktop and Android/iOS apps using a self-hosted encrypted relay.

**Architecture:** Tauri React UI with Rust Stronghold keys and AES-GCM operation records. An append-only SQLite relay provides authenticated pagination and idempotent writes; shared native code merges and persists account operations atomically.

**Tech Stack:** Tauri 2, Rust AES-GCM/reqwest, React/TypeScript, Node 24 built-in HTTP/SQLite, Docker/Caddy.

**Spec:** ../specs/2026-10-09-encrypted-sync-design.md

## Global constraints

Preserve local vault format and identifier. Never return account secrets to UI. Foreground/unlocked sync only. HTTPS except loopback. No logs of tokens, pairing bundles, keys, account codes or request bodies. Existing release remains usable until new code passes checks. Preserve authorization safeguards, transactional writes and clipboard cleanup.

## Review focus

- Upload response lost: retain exact immutable pending record and reconcile idempotently.
- Two offline edits/deletion: same deterministic winner on every device; no resurrection from older history.
- Failed decryption/write: no partial account, cursor or outbox changes.
- Lock while network request is pending: no late UI repopulation or visible pairing key.
- Mobile lifecycle: foreground/resume initiates sync, background does not expose keys; native mobile APIs replace desktop-only plugins.

### Native transport/merge

Files: src-tauri/src/sync.rs, vault.rs, otp.rs, Cargo.toml/Cargo.lock. Interfaces: Vault::sync_status()->Result<SyncStatus>; sync_create(&str,&str)->Result<PairingInfo>; sync_pair(&str)->Result<Vec<AccountCode>>; sync_once()->Result<SyncResult>; sync_pairing()->Result<PairingInfo>; sync_disconnect()->Result<()>.

- [x] Implement bounded authenticated AES-GCM records and key-safe pairing.
- [x] Couple outbox/rank/cursor updates to every atomic account commit and imports.
- [x] Add tests for crypto tampering, deterministic merge, rollback safety and two-vault relay integration.
- [x] Run Rust tests, fmt and Clippy.

### Relay service

Files: server/*.mjs, server/Dockerfile, docker-compose.yml, deploy/*, docs/sync-server.md.

- [x] Implement spec routes, SQLite transactions, authentication hashing, quotas and rate limits.
- [x] Add Node HTTP integration tests for authentication, pagination, idempotency/conflict, persistence and atomic rejects.
- [x] Supply Docker/Caddy configuration and environment template; validate what is locally possible.

### Native mobile compatibility

Files: src-tauri/src/commands.rs, lib.rs, target dependencies, mobile config/capabilities, scripts/mobile*, .github/workflows/mobile.yml, docs/mobile.md.

- [x] Guard desktop-only clipboard/single-instance/updater and add mobile equivalents.
- [x] Expose the agreed native sync command interfaces without logging arguments/results.
- [x] Provide Android/iOS initialization/build instructions and workflow; inspect available toolchains and execute supported builds.

### Shared UI and integrated verification

Files: src/components/Sync.tsx, src/api.ts, types.ts, App.tsx, styles.css, frontend tests, README and verification docs.

- [x] Implement setup/pairing QR/import, sanitized status, automatic foreground synchronization and deliberate disconnect.
- [x] Add UI tests for pair expiration, locked/late results, offline status and automatic scheduling.
- [x] Run two-vault native relay integration and native Windows UI checks, with synthetic data only.
- [x] Build a new Windows installer and record platform/deployment limitations.


## Remaining platform release gates

- [ ] Build Android APK and iOS application on provisioned platform toolchains; local Android initialization stopped at missing SDK and iOS requires Mac/Xcode.
- [ ] Profile production Stronghold snapshot memory on phones and verify QR capture/background/clipboard behavior on physical devices.
- [ ] Configure a real HTTPS relay endpoint and validate phone-to-desktop delivery there.
- [ ] Sign/publish desktop OTA and mobile distribution artifacts only when requested.

Implementation/source checks and local Windows/relay verification are recorded in docs/verification-sync-2026-10-09.md. The checked mobile implementation item records prepared source/instructions and inspected prerequisites, not a successful mobile build.
