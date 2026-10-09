# Encrypted mobile and desktop sync

The user confirmed the desired system is our own mobile authenticator plus our desktop app, with automatic synchronization of accounts added through our apps. They selected both Android/iOS and a self-hosted Docker service. This implements the previously agreed direction directly; no cloud account, deployment, publication, push or store submission is authorized by this local implementation.

## Platform and data boundary

Reuse the Tauri 2 React/Rust application and its password-protected Stronghold vault across desktop and mobile. Preserve the existing vault identifier, format, encrypted backup and Google migration import. No Google/Microsoft cloud connection is claimed. iOS builds require a Mac; an unexecuted workflow or generated platform project is not runtime verification.

Auto-sync runs at unlock, foreground/resume and every ten seconds while unlocked and online. Locking drops keys and stops foreground requests. Mobile background execution is not promised. Updates continue to work only on desktop; mobile distribution follows native platform builds.

## Transport v1

An API-only Node 24 server with built-in SQLite persists opaque records and SHA256-hashed per-vault random authorization tokens. Registration requires a separate owner-configured registration token. Every request has strict body, count, quota and rate limits. No credentials, keys, codes or bodies in logs. Docker Compose provides the API and optional Caddy HTTPS termination. No public service is launched automatically.

- POST /v1/vaults: owner registration bearer; body {vaultId,authToken}. Idempotent for identical credentials, otherwise conflict.
- POST /v1/vaults/:vaultId/records: vault bearer; body {records:[{id,nonce,ciphertext}]}; at most 100 records and 1 MiB. UUID IDs, base64 nonce (12 bytes), ciphertext (AES-GCM tag included). Append-only and transactional; identical ID/body is idempotent, conflicting ID/body returns 409.
- GET /v1/vaults/:vaultId/records?after=N: vault bearer; returns {records:[{sequence,id,nonce,ciphertext}],cursor,hasMore,latest}. At most 100, ascending sequence. Cursor beyond latest returns 409 rather than silently resetting history.
- GET /health: status only.

## End-to-end encryption and local state

Generate independent random 32-byte AES256-GCM encryption key and random 32-byte authorization token. Serialize a pairing bundle as mfa-sync://pair?data=<URL-safe-base64-JSON> with {version:1,server,vaultId,key,authToken}. Show it only by deliberate action and clear it from UI on close/lock/timeout. Server never receives the encryption key. Pairing gives full shared-vault access; initial version does not claim per-device revocation.

AAD is UTF8 `mfa-sync-v1:<vaultId>:<recordId>`. The encrypted operation is {version:1,clock,deviceId,kind:"put"|"delete",account?,secret?,id}. Put contains validated account metadata and Base32 key; delete contains account ID. Use random nonce per immutable operation. Account secrets are encrypted through Stronghold guarded procedures and never returned to React. Decrypt and validate in native code before committing.

Persist sync credentials in the encrypted local Stronghold vault. Persist outbox, cursor, Lamport clock and per-account winning rank in the same atomic snapshot as every account mutation. Rank (clock,deviceId,recordId) determines a stable concurrent winner; updates/deletions are explicit operations, including tombstones. Pull before push to advance known clock. Unknown upload outcome retains exact outbox records for idempotent reconciliation; never generate a replacement operation automatically. Duplicate record delivery does not duplicate accounts.

Only configure HTTPS URLs, with plain HTTP limited to explicit loopback development endpoints. Reject userinfo/fragments/query and redirects, bound responses and set network timeouts. Repeated sync failure leaves local offline data usable and displays a quiet status. Failed parse/decrypt/network/local write preserves the previous vault, cursor and pending records. Disconnect disables only this device's synchronization and preserves accounts; other paired devices remain authorized.

## Acceptance

Two independent native vaults pair via the service. An add on one reaches the other without manual export, generates the same TOTP, survives lock/reopen, and does not resurrect a deleted account. Offline operations remain pending and merge deterministically after reconnect. Server database contains no account labels, TOTP keys or encryption key. Wrong authorization, corrupted ciphertext, conflicts, replay/cursor rollback and concurrent requests cannot silently overwrite data. Preserve existing local-only tests. Supply Docker instructions, mobile build instructions, desktop installer and evidence stating which platform builds/runtime checks actually ran.
