# MFA Desktop Implementation Plan

> Execution: implement directly in this session as explicitly requested by the user. Parallel helpers own disjoint backend and release files; the primary agent integrates and verifies the complete app. No further design approval gate is needed under the user's instruction to start implementation.

**Goal:** Deliver a runnable local Windows/macOS TOTP authenticator with encrypted storage and signed-update integration.

**Architecture:** React/Vite calls a narrow Rust command API; Stronghold owns encrypted persisted state. The UI never persists secrets. Signed binary updates use Tauri Updater and GitHub Releases.

**Tech Stack:** Tauri 2, React, TypeScript, Rust, Stronghold, Vitest.

**Spec:** ../specs/2026-10-09-desktop-authenticator-design.md

## Global constraints
- Password minimum 12 characters; idle lock 300 seconds; unchanged clipboard cleared after 30 seconds.
- No plaintext credential logging/storage; no real secrets in preview/tests.
- No push or release publication. Signing keys remain outside source control.
- Validate backups before replacement and retain data on failed writes.

## Review focus
- Malformed or unsupported QR URI fails without leaking the secret.
- Wrong password, modified backup and failed persistence preserve data.
- Polling cannot extend an idle session; late async results cannot repopulate a locked UI.
- An unconfigured updater is distinguishable from "up to date" and never installs unchecked binaries.
- Installer artifacts cannot contain or replace local user vaults.

### Task 1: Native vault and TOTP
Files: src-tauri/Cargo.toml, build.rs, src/{main,lib,commands,vault,otp}.rs and Rust tests.
Interfaces: implement the command and response contract in the spec; consume Tauri app-data paths and trusted file selections.
- [x] Implement validated TOTP parsing and test RFC SHA1/SHA256/SHA512 vectors plus invalid URI/base32/parameters.
- [x] Implement encrypted vault/session state; test password failures, round trips, backup tampering and native idle lock.
- [x] Implement transactional add/delete, clipboard expiry and encrypted backup commands.
- [x] Run cargo test, fmt and clippy; address actual failures.

### Task 2: Desktop interface
Files: package.json, index.html, tsconfig*.json, vite.config.ts, src/{App,main,styles,api,types}.*, src/components/*, frontend tests.
Interfaces: consume native command contract; preview adapter supplies only synthetic read-only data.
- [x] Build setup/unlock screen and searchable account workspace with accessible add/delete/backup dialogs.
- [x] Add QR-image import, copy feedback, idle/session handling and update status/download/install flow.
- [x] Test relevant user flows with mocks, build the frontend and inspect desktop/narrow rendering.

### Task 3: Packaging and releases
Files: src-tauri/tauri.conf.json, capabilities/default.json, icons/*, .github/workflows/*, scripts/*, README.md, .gitignore.
Interfaces: Tauri entrypoint mfa_desktop_lib::run(); npm scripts dev/build/test/tauri; updater configuration compiled only with a real supplied public key.
- [x] Configure least-privilege local UI, CSP, Windows/macOS bundle metadata and updater endpoint for pramchanok/MFA-APP.
- [x] Add deterministic icon assets, CI validation and manually triggered draft signed-release workflow.
- [x] Document development, backups, supported accounts, signing requirements and verification boundaries.

### Task 4: Integration verification
- [x] Run fresh frontend tests/build and native test/build; audit dependencies without installing a speculative security scanner.
- [x] Inspect git diff/status for unrelated changes, secrets and generated binaries.
- [x] Report tested functionality, installer paths, and any macOS/signing/OTA limitations precisely.
