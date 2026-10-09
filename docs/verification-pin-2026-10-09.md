# Short master passwords — 0.3.3

Per the user's request, new vaults accept at least six characters, including numeric PINs of six to eight digits. Longer passwords remain supported. This changes creation validation and setup help text; it does not change encryption, KDF settings, the backup format or unlock validation for existing vaults. Native input remains limited to 1024 bytes. Short PINs provide less resistance to offline guessing than long passwords.

Verified on Windows:

- Frontend: 41 tests passed. New six-digit PIN and eight-character password cases failed against the old UI, then passed after the change. Five-character input and mismatched confirmation remain rejected.
- Rust: 30 tests passed, three pre-existing optional tests ignored. New coverage creates encrypted vaults with six-digit and eight-character credentials, retains an account across restart, rejects a wrong PIN without modifying ciphertext, and restores encrypted backups. Existing long-password tests still pass.
- Changed Rust file passes rustfmt checking. TypeScript/Vite and Windows release/NSIS builds succeeded. Existing libsodium missing-PDB linker warnings remain.
- The real 0.3.3 release WebView reported both setup fields' minimum length as six, and native status as no active vault. No user password was entered or vault created during inspection. Screenshot: `output/playwright/pin-setup-native.png`.
- Inspection was detached, its process closed, and the release application reopened normally. The old archived vault and its separate backup retain the same SHA-256. No macOS build or biometric enrollment was tested for this change.

Installer: `output/MFA Desktop_0.3.3_x64-setup.exe`. The installer was built; the standalone release executable was opened directly rather than running an installation.
