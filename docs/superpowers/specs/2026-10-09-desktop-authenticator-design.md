# MFA Desktop design

## Intent and scope
Build a personal Windows/macOS authenticator so the user can obtain time-based verification codes without reaching for a phone. The user approved Tauri, React, TypeScript, Rust and encrypted local storage, asked for OTA updates, and explicitly instructed implementation to start. Proceed in this session without additional process approval gates. No push, release publication or use of real account credentials is authorized.

## First release
- Create a password-protected local vault, unlock it, lock manually, and lock after five minutes without user interaction. Password minimum: 12 characters.
- Add standard TOTP accounts with a Base32 secret or an otpauth://totp URI, including a QR image decoded locally. Support SHA1/SHA256/SHA512, 6/8 digits and 15-120 second periods. Reject HOTP, Microsoft push enrollment and Google migration QR with actionable messages.
- Show issuer, account name, current code and per-account countdown. Search accounts, copy codes, and delete after confirmation. Never return stored secret keys to the UI.
- Export/import a versioned encrypted backup with an explicit replacement confirmation; incorrect passwords or invalid backups must preserve the current vault.
- Tauri updater checks for signed releases and allows download/install only on a deliberate user action. Unconfigured signing is shown honestly, without contacting a fake endpoint. Updates must not overwrite user data.
- Provide Windows/macOS build and validation workflows. Actual OTA requires release signing secrets, a published signed release and macOS platform signing configuration. Do not claim live OTA or macOS verification from Windows checks.

## Architecture
React/Vite renders the interface. Narrow Tauri commands own vault lifecycle, URI validation, TOTP generation, clipboard and backup I/O. Rust uses Stronghold snapshots and a per-vault salt with a password KDF; secrets stay in Rust and encrypted snapshots. Writes must preserve the previous valid snapshot on failure. Session activity comes from user events, not polling. The backend enforces the idle timeout independently of frontend timers. The UI purges codes and input fields on lock. No plaintext secrets, passwords or OTPs in logs or browser persistence.

## Shared command contract
All command parameters use Tauri camelCase. Rust response structures serialize camelCase.
- vault_status() -> { exists: boolean, unlocked: boolean }
- create_vault(password: string) -> AccountCode[]
- unlock_vault(password: string) -> AccountCode[]
- lock_vault() -> void
- touch_session() -> void (user activity only)
- list_codes() -> AccountCode[] (does not renew activity)
- add_account(input: AccountInput) -> AccountCode[]
- delete_account(id: string) -> AccountCode[]
- copy_code(id: string) -> void (clears the clipboard after 30 seconds only if unchanged)
- export_backup(path: string) -> void
- import_backup(path: string, password: string) -> AccountCode[] (replaces only after complete validation)
- app_info() -> { version: string, updaterConfigured: boolean }
AccountCode = { id, issuer, account, code, digits, period, remaining } (string IDs, string code; numeric digits/period/remaining).
AccountInput = { issuer: string, account: string, secret: string, uri: string, algorithm: string, digits: number, period: number }. URI, when provided, is authoritative. Ignore empty optional fields. Errors must be safe user-facing strings, without secret/URI/password contents.

## UI
Thai interface with familiar English provider names. A compact desktop workspace, cool off-white surface, deep blue text, cobalt primary actions, mint timer accent. Use system Thai-friendly sans typography and tabular monospace for large OTP codes. One discoverable account list, prominent search/add/copy, secondary backup/update/lock actions. Keyboard access, visible focus, modal focus handling, reduced-motion support and narrow-window layout are required. A browser preview contains labeled synthetic samples only and cannot save real secrets.

## Validation
Rust tests cover RFC 6238 vectors, URI/Base32 validation, wrong-password handling, snapshot round trips, tampering, backup validation, and idle expiry. Frontend tests cover setup/unlock, invalid input, search, deletion confirmation, lock purging and honest updater states using mocks. Build TypeScript/Vite and Rust; inspect the rendered preview at desktop/narrow widths. Dependency audit results and any environment/platform limits must be reported separately.
