# Layout, account ordering and unified import — 0.5.0

## Delivered

- Responsive account grid with clearer account names, copy actions, and one **เพิ่ม / นำเข้าบัญชี** entry beside search.
- Click card space or press Enter/Space on a focused card to copy through the native clipboard command. Visibility, menu and drag controls do not trigger copying.
- Drag the grip with mouse or touch to reorder. Arrow keys, Home/End and **ย้ายขึ้นบนสุด** are alternatives. Reordering during search changes only visible slots.
- The exact full ID order is saved atomically in the encrypted vault. Order is local to each device, survives restart, and is preserved when remote account updates arrive. New accounts append.
- One import dialog accepts camera, multiple images, URI or manual Base32 key. It detects standard TOTP setup QR and Google export automatically. Google export still requires all parts; duplicates remain disabled. Standard multi-QR imports use one atomic native commit.
- Camera requests video only, reads frames locally, clears temporary pixels, and stops on decode, close or lock/unmount, including a late permission result. Missing, denied or busy cameras have actionable fallback messages.
- Windows/macOS manual build workflow with downloadable installers and publication enabled by default (`publish_release`, optional artifacts-only mode). Signed release workflow remains separate. All four workflows use only `workflow_dispatch`; nothing runs on push/tag/PR. Release workflows publish automatically after all three platform builds and uploads succeed, with no separate manual draft approval.

## Verification performed

- Frontend: **13 test files, 79 tests passed**. Includes card copying/control separation, order-save failure recovery, late results after lock, import review/selection, multi-part Google safeguards and camera lifecycle/error handling.
- TypeScript and Vite production build passed.
- Native Rust: **42 passed, 4 existing ignored**; format check and strict Clippy passed. Tests cover persisted exact-ID ordering, malformed/stale/locked rejection, unchanged secrets and sync records, remote updates, duplicate selection and atomic multi-QR saves.
- Release helper: **7 tests passed** with mocked GitHub APIs. Publication waits for every installer upload; upload failures and missing platform assets prevent publication. Signed publication also requires `latest.json` and becomes Latest; unsigned publication does not request Latest. Published releases and signed/unsigned draft mixing are rejected. YAML, manual-only triggers, embedded script syntax, matching versions and deliberate version mismatch were checked locally.
- Chrome with the production bundle and synthetic native responses: card copy, no copy from controls/drag, mouse drag, filtered keyboard reorder, touch drag, unified import review, denied-camera fallback, and clearing accounts on lock passed.
- Responsive checks at **360, 390, 620, 760, 820, 1100, 1400 and 1600 px** found no page overflow or clipped OTP groups, including 8-digit codes and long labels.
- Actual Windows debug WebView/native IPC, with a separate app identifier and `.tools/layout-native-vault`: created a synthetic vault, imported a QR image and two standard setup URIs, copied through the native clipboard command, saved keyboard/mouse order, and verified order after lock/unlock and process restart. No user vault was opened or changed.
- Actual Windows WebView camera path using Chromium's **fake video device** and a synthetic QR Y4M file: real `getUserMedia` and jsQR decoded the QR, stopped the media track before review, and rejected the already-imported account as a duplicate. The first canvas-stream fixture did not provide frames in WebView and was replaced with the fake video device; it is not hardware-camera proof.

## Evidence

Screenshots use only synthetic accounts:

- `output/playwright/layout-light.png`
- `output/playwright/layout-dark.png`
- `output/playwright/layout-mobile.png`
- `output/playwright/layout-drag.png`
- `output/playwright/layout-import.png`
- `output/playwright/layout-import-review.png`
- `output/playwright/layout-native.png`
- `output/playwright/layout-native-camera-review.png`

Local runtime logs and harnesses are ignored under `.tools/`. Native build emitted the existing libsodium missing-PDB linker warning; it did not fail the build.

## Remaining external verification

No physical webcam, macOS camera, Android/iOS runtime, signed installer/notarization or OTA was verified in this change. macOS camera purpose text and signed-build entitlement are configured; mobile hardening already adds camera declarations. No GitHub-hosted job, release or publication was run. Workflows become available after these local files are committed and pushed to the repository's default branch. See [manual build/release instructions](manual-build-release.md).
