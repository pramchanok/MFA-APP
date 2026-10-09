# Google export QR version 2 compatibility — 0.4.1

## Root cause

Both local JPEG screenshots supplied by the user decoded successfully as Google offline migration URIs. Their protobuf envelopes specify version **2** and a two-part batch. The existing parser accepted only version **1**, so it returned the generic damaged-export error despite valid OTP and batch fields. No image-decoder or Base64 failure was observed.

## Change

- Explicitly accept migration versions 1 and 2 using the existing bounded protobuf reader and OTP validation.
- Require a consistent version, batch size and batch ID across all parts.
- Keep incomplete-batch, duplicate-part, unsupported OTP, account-selection, secret-size and atomic-write checks.
- Return a specific update-required message for unknown future versions rather than telling the user to export again.
- Bump the desktop app to 0.4.1.

## Verification

- A synthetic version 2 regression failed on the old parser, reproducing the invalid-export error, then passed after the fix.
- Rust: 35 passed, 4 existing environment-dependent tests ignored. Tests cover 10+2 synthetic entries in two v2 QR parts, incomplete batches, unknown/mixed versions, existing v1 behavior, actual vault import/reopen, and expected RFC 6238 codes.
- Frontend: 56 tests passed; TypeScript and Vite production build passed.
- `cargo fmt --check` and `cargo clippy --locked --offline --all-targets -- -D warnings` passed.
- Actual native WebView and Rust IPC: selected each of the user's two local JPEGs. First part showed 10 entries and blocked import; both parts showed 12 selectable entries and enabled import. The modal was closed and the isolated test vault was locked without importing the private accounts.
- Windows release and NSIS build passed. Verified file metadata is 0.4.1 for `src-tauri/target/release/mfa-desktop.exe` (16,798,720 bytes) and `output/MFA Desktop_0.4.1_x64-setup.exe` (4,283,876 bytes). Default production application identifier is unchanged. Existing libsodium PDB linker warnings did not fail the build.

## Data handling and scope

The private QR images were read locally. QR contents, account labels and secrets were not printed, uploaded, photographed or copied into fixtures. Diagnostics retained only structural metadata and counts. The native preview used a separate application ID and empty isolated vault; the user's vault and original images were not modified. Synthetic keys were used for all save/reopen tests. Physical-phone scanning is outside this import fix.

## Evidence

- `.tools/google-v2-red.log`
- `.tools/google-v2-rust-tests.log`
- `.tools/google-v2-ui-tests.log`
- `.tools/google-v2-clippy.log`
- `.tools/google-v2-private-result.log` (counts only)
- `.tools/google-v2-release-build.log`
