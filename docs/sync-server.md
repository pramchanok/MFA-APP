# Self-hosted encrypted sync relay

For approximately ten people without an always-on host, use the [Cloudflare Workers + D1 setup](cloudflare-sync.md). This document covers the Docker alternative. Both use the same encrypted API v1; Cloudflare has lower, separate storage quotas.

This service synchronizes **our own MFA apps** on desktop, Android and iOS. It does not connect to Google Authenticator or Microsoft Authenticator cloud storage. Import existing TOTP accounts first, then add new accounts through our app to synchronize them. Mobile syncing runs while the app is unlocked and in the foreground; continuous background syncing is not promised.

The server stores opaque encrypted operations, vault UUIDs, a SHA-256 hash of each random authorization token and sequence numbers. The client generates and retains the independent encryption key. Account labels, TOTP secrets, generated codes, vault passwords and encryption keys are not sent to this service. HTTPS is still required outside loopback. Pairing material gives full shared-vault access; this version has no individual-device revocation.

## Start locally with Docker

Install Docker Engine/Desktop with Compose v2. In the repository root:

```powershell
Copy-Item deploy/sync.env.example .env
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url')+'\n')"
```

Place the generated value in `.env` as `SYNC_REGISTRATION_TOKEN`. This is an **owner registration credential**: enter it only when creating a new shared vault in the app. It is not the vault password or encryption key and it is not included in device pairing. Keep `.env` private; do not commit it or paste its contents into logs/chat. The service refuses to start with a missing or malformed token. The example intentionally contains no working credentials.

```powershell
docker compose up -d --build sync
docker compose ps
Invoke-RestMethod http://127.0.0.1:8787/health
```

Use `http://127.0.0.1:8787` in the **desktop app on the same machine** for local development. The API port is bound to loopback by default. A phone cannot reach the computer through its own `127.0.0.1`; use the HTTPS setup below for phone pairing. Do not expose the plain-HTTP port publicly or weaken the client's HTTPS validation.

## HTTPS for desktop and phones

Point a domain you control to the server and permit inbound TCP 80/443. Set `SYNC_DOMAIN` to that hostname in `.env`, then explicitly start the optional TLS proxy:

```powershell
docker compose --profile tls up -d --build
```

Caddy obtains and renews certificates for the configured domain. Use `https://your-domain` as the app server URL, with no query, fragment or subpath. Never put bearer tokens in URLs. The optional proxy does not enable access logging; retain that behavior if using another proxy. A reverse proxy configured to log headers/bodies can expose credentials even though the application itself does not log them.

Nothing in the repository automatically deploys a public server, changes DNS, registers a domain or publishes an app. Docker images use maintained major tags; pin reviewed image digests in your own production deployment policy.

## Storage, limits and operations

SQLite lives in the named `sync-data` volume under `/data`. The API container runs as the unprivileged `node` user with a read-only root filesystem. It uses SQLite WAL with transactional immutable appends. Identical retries do not duplicate records; a conflicting record ID rejects the entire batch. Disconnecting a client does not revoke other devices or delete server records.

Default limits:

| Limit | Value |
| --- | --- |
| Request body | 1 MiB |
| Records per upload | 100 |
| Nonce | Exactly 12 bytes, canonical padded standard Base64 |
| Ciphertext including tag | 16 bytes to 64 KiB per record |
| Download page | At most 100 records and below 1 MiB |
| Vaults | 1,000 |
| Records per vault | 100,000 |
| Accounted storage per vault / total | 64 MiB / 1 GiB |
| Requests per IP and per vault | 120 per minute |

The account-storage quota includes encoded payload and a fixed metadata allowance; it is **not** an exact bound on SQLite/WAL/index files. Monitor free disk space and back up the volume. Records and tombstones are append-only; no automatic compaction or retention cleanup is implemented. Quota failures preserve local offline data and pending changes; an administrator can raise limits deliberately in `.env` and recreate the service.

App 0.3.1 polls every 60–120 seconds per unlocked foreground device, immediately sends local changes, and backs off failed requests up to five minutes. Version 0.3.0 polls every ten seconds; update all devices for the lower request budget. When using Caddy, the application sees Caddy's network address and applies a shared IP bucket; increase `SYNC_RATE_LIMIT_PER_MINUTE` for larger deployments. Forwarded IP headers are deliberately not trusted, so clients cannot spoof their way around limits. Health probes count toward the IP limit as well. Rate-limit responses are HTTP 429 with `Retry-After: 60`.

Back up only while the API is stopped, so SQLite and its WAL are consistent. For example on a Docker host with a shell:

```sh
docker compose stop sync
docker compose run --rm --no-deps -T --entrypoint tar sync -C /data -czf - . > sync-backup.tar.gz
docker compose start sync
```

The example streams a backup out of a temporary container without deleting the persistent volume. On Windows PowerShell before 7.4 use a binary-safe archiving/copy tool instead of native stdout redirection. Preserve the entire data directory when restoring and restore with the container stopped and correct volume ownership. Store backups securely; encrypted records and authentication-token hashes are still sensitive. `docker compose down` retains named volumes; `down -v` destroys them and must not be used as a routine upgrade step.

## API v1

All responses use `Cache-Control: no-store`. Authentication is `Authorization: Bearer <canonical-43-character-base64url-token>`. Owner registration and vault authorization are separate 32-byte random tokens. JSON schemas reject unknown fields. UUIDs must use canonical lowercase hexadecimal spelling.

- `GET /health` → `{ "status": "ok" }`.
- `POST /v1/vaults` with owner bearer and `{vaultId,authToken}` → HTTP 201, or 200 on an identical retry. Same vault ID with different credentials → 409.
- `POST /v1/vaults/:vaultId/records` with vault bearer and `{records:[{id,nonce,ciphertext}]}` → `{accepted,latest}`. Append-only transaction; conflicting duplicate IDs → 409 with no partial write.
- `GET /v1/vaults/:vaultId/records?after=N` with vault bearer → `{records:[{sequence,id,nonce,ciphertext}],cursor,hasMore,latest}`. Sequences start at 1 and are contiguous per vault. `cursor` equals the last returned sequence, or `N` for an empty page. Cursor beyond the server's latest → 409; clients must not silently reset a lost server history.

The relay validates only transport format and limits, not the contents of encryption. Clients must decrypt/validate every operation before committing local state. Unknown vaults and wrong credentials both return 401. Error responses contain a bounded stable `{error:"code"}` without credentials or internal database errors.

## Local verification

No external npm packages are required. Node 24 includes the HTTP, crypto, test and SQLite modules used here.

```powershell
node --test server/relay.test.mjs
docker compose --env-file deploy/sync.env.example config --quiet
```

The second command deliberately fails until the blank owner token is replaced or supplied through the environment. Do not run `docker compose config` without `--quiet` against real credentials because the rendered configuration contains environment values.

Tests use temporary SQLite files and synthetic opaque ciphertext only. They verify authentication, registration idempotence, transactional conflicts, concurrent retries, restart persistence, strict validation, bounded pagination, quotas and rate-limit recovery. A test passing locally does not prove Docker deployment, public TLS, Android or iOS runtime behavior; see the current verification report for executed checks.
