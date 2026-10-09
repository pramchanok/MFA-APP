# Windows Hello investigation — 0.4.2

## Observed failure

- Reproduced in an isolated debug application and an empty synthetic vault. The user confirmed facial recognition in Windows Security, but `NCryptFinalizeKey` returned `0x80098044` (`WINBIO_E_INVALID_TICKET`). The previous UI collapsed this into a cancellation/failure message.
- A subsequent facial enrollment passed key finalization but failed `NCryptEncrypt` with `0x80090027` (`NTE_INVALID_PARAMETER`). These are two different stages; neither result is successful enrollment.
- Window diagnostics detected the system CredentialUIBroker dialog. Foreground activation was denied when enrollment was started through CDP while the user interacted with Codex. The foreground hypothesis is not yet established as the cause of the biometric ticket error.

## Change

- Export only the RSA public blob and encrypt with BCrypt RSA-OAEP/SHA-256. The non-exportable private key remains in Microsoft Passport KSP and decrypt still requires a fresh Windows Hello gesture. No change to padding, vault format, key cache policy, or password fallback.
- Bounded best-effort activation assistance targets a newly visible credential dialog whose executable is exactly the system CredentialUIBroker. No wildcard foreground grant, automatic authentication retry, or software private-key fallback.
- Distinguish cancellation, rejected biometric tickets, and native operation/error codes in the UI. Debug diagnostics contain stage and window activation state, without vault/account/key material.

## Verification

- Frontend: 58 tests passed across 10 files. TypeScript and Vite production build passed.
- Rust: 38 tests passed, 4 ignored. Added RSA public-blob OAEP/SHA-256 encryption/decryption validation, randomized ciphertext validation, and rejection with the wrong OAEP hash. This test uses an unnamed disposable software test key, not production enrollment.
- Strict Clippy passed for all local targets in debug and release modes; formatting passed.
- Windows release and NSIS builds passed with the production identifier unchanged. EXE: `src-tauri/target/release/mfa-desktop.exe`, version 0.4.2, 16,821,248 bytes, SHA-256 `1F94116C5B9780C5B987B63DF29543A96A801A02485D1EEF06C7E946392A391F`. Installer: `output/MFA Desktop_0.4.2_x64-setup.exe`, 4,277,390 bytes, SHA-256 `C8609960F8688A516E604F21E939F76ADE7E3EB37B3EA773F1C2847344F15E0B`. Existing libsodium PDB warnings did not fail the build.
- Physical enrollment using the updated public-key encryption path is pending. The user has been asked to click the prepared enrollment button in the isolated 0-account app so foreground behavior matches normal use. Lock/unlock, cancellation and password fallback must then be checked on the native path before claiming the bug is fixed.

## Data and release scope

Testing uses `.tools/hello-fix-042` and a separate debug application identifier. Real vaults, imported QR images, passwords and existing device enrollment have not been modified. No release has been published, no installer has been run, and no commit or push has been made.

## References consulted

- [Microsoft NCryptEncrypt parameters](https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/nf-ncrypt-ncryptencrypt)
- [Microsoft SetForegroundWindow restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)
- [Microsoft AllowSetForegroundWindow target process](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-allowsetforegroundwindow)
- [KeePassWinHello foreground investigation PR](https://github.com/sirAndros/KeePassWinHello/pull/159) is an unmerged report, used as a hypothesis only.
