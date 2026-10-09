# Android and iOS builds

The mobile application reuses the React interface and native Rust/Stronghold vault. Account seeds and sync encryption keys stay in the password-protected native vault; they are not stored in browser storage. Google/Microsoft Authenticator remain separate applications. Automatic sync covers accounts added through our applications after device pairing.

## What is implemented

- Android/iOS entry point and platform configuration, with the existing application identifier preserved.
- Desktop-only updater, process/restart and single-instance plugins excluded from mobile compilation.
- Native mobile clipboard plugin behind the same copy-code command and conditional 30-second cleanup. JavaScript has no direct clipboard read/write permission.
- Mobile suspension emits a vault-lock event and schedules native lock/clipboard cleanup off the UI thread. Any in-flight operation finishes before the vault mutex can be locked. Mobile OS suspension or termination may prevent a cleanup timer from running; clipboard behavior needs real-device verification.
- QR image inputs request camera capture where the operating system supports it. File selection remains available. This is image-based decoding, not continuous camera scanning.
- Foreground/unlocked synchronization. Returning from the background requires unlocking again; no background execution guarantee is made.
- Android manifest hardening disables automatic app backup and cleartext WebView traffic; iOS camera/photo usage descriptions are included. Production sync uses an HTTPS endpoint with a trusted certificate.

Native sync verifies HTTPS against the bundled Mozilla public CA roots. Use a publicly trusted certificate, for example Caddy with Let's Encrypt. Private/self-signed CAs installed only in the device's OS trust store are not supported. There is no option to bypass certificate verification. Android/iOS native crypto dependencies also require a working NDK/Xcode toolchain.

Encrypted backup import/export currently uses desktop filesystem paths. Those buttons are disabled on mobile until native document URI/sharing support is implemented. The mobile app can pair with a desktop vault and sync normally once builds and runtime are verified.

## Local verification on 2026-10-09

The development host is Windows. Java 27 is installed, but the Android SDK/NDK are absent, `ANDROID_HOME` and `NDK_HOME` are unset, and only the Windows Rust target is installed. `node scripts/mobile-init.mjs android` was executed and stopped with the official CLI error **Android SDK not found**. No large SDK was downloaded. Therefore no Android APK, emulator run or device run is claimed.

iOS requires macOS and Xcode. No iOS build or device run was performed on this Windows host. The manually triggered workflow is prepared, not executed. Mobile source compatibility is not a substitute for successful native platform builds and device acceptance checks.

The existing Stronghold snapshot format also uses a scrypt work factor of 19, requiring approximately 512 MiB for its main memory-hard operation in addition to application overhead. Argon2id remains 64 MiB and three passes. This has not been profiled on phones and may exceed mobile process memory limits. Mobile release acceptance must resolve KDF/memory behavior on real devices, including existing desktop vaults/backups; the implementation does not silently reduce snapshot protection.

## Android prerequisites and debug APK

Install Node 24, Rust, Android Studio/SDK command-line tools and a JDK supported by the generated Gradle version (CI uses Temurin 21). Set `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME` to real installed locations. Install the NDK and Android Rust target explicitly:

```sh
sdkmanager "ndk;27.2.12479018"
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
rustup target add aarch64-linux-android
npm ci
node scripts/mobile-init.mjs android
sdkmanager "platforms;android-$(node scripts/mobile-sdk.mjs)"
npm run tauri -- android build --debug --target aarch64 --apk --ci
```

The generated project uses the SDK from the pinned Tauri CLI template; `mobile-sdk.mjs` reads its `compileSdk` rather than assuming an older SDK. The hardening script runs immediately after initialization. If you reinitialize using the raw Tauri CLI, rerun `node scripts/mobile-harden.mjs android` before building.

Debug APKs appear beneath `src-tauri/gen/android/app/build/outputs/apk/`. Install only test builds with synthetic accounts while validating this release. Android emulator networking to the host is not the same as loopback on the desktop. Use the HTTPS relay endpoint; do not bypass native endpoint validation or ship a broad cleartext exception.

## iOS simulator and physical devices

On a Mac, install full Xcode, its iOS simulator runtime, Node 24, Rust and XcodeGen. Open Xcode once to finish setup, then:

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
brew install xcodegen
npm ci
node scripts/mobile-init.mjs ios
npm run tauri -- ios build --debug --target aarch64-sim --no-sign --ci
```

The simulator `.app` cannot be installed on an iPhone. Physical-device builds need an Apple signing team and provisioning profile configured in the generated Xcode project, plus a device target (`aarch64`). TestFlight/App Store distribution requires the corresponding Apple account, signing and submission steps. None are automatically published by this repository.

Tauri merges `src-tauri/Info.ios.plist` into the generated app during the build. Camera/photo access must remain a deliberate user action. Test permission denial and selection cancellation on both operating systems. Opening the camera/file chooser can trigger the mobile suspension lock; the current conservative behavior may require unlocking and retrying after returning. This needs real-device UX validation before release.

## CI and acceptance

`.github/workflows/mobile.yml` is manual only. It builds an Android ARM64 debug APK and an unsigned iOS ARM simulator application, then keeps test artifacts for seven days. It does not publish a release, contact the relay, sign for production or submit to a store. Build failures should be fixed from their actual runner logs; the workflow has not been dispatched in this session.

Before a mobile release, test setup/unlock, QR photo and camera selection, permission denial, background/foreground locking, clipboard expiry and changed-clipboard preservation, offline edits, pairing and two-device synchronization, simultaneous deletion/addition, restart persistence and battery/network behavior. Verify camera/file selection remains usable with the suspension lock. Confirm device clock accuracy because TOTP depends on time.

Official references: [Tauri mobile prerequisites](https://v2.tauri.app/start/prerequisites/#configure-for-mobile-targets), [Tauri clipboard plugin](https://v2.tauri.app/plugin/clipboard/), [Tauri mobile CLI](https://v2.tauri.app/reference/cli/#android), [pinned Android template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.1/crates/tauri-cli/templates/mobile/android/app/build.gradle.kts).
