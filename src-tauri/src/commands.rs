use crate::{
    device_unlock::{DeviceStatus, NativeProtector},
    otp::{AccountCode, AccountInput, Result},
    vault::{Vault, VaultStatus},
};
#[cfg(desktop)]
use arboard::Clipboard;
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};
#[cfg(mobile)]
use tauri_plugin_clipboard_manager::ClipboardExt;
use zeroize::Zeroizing;

#[derive(Clone)]
struct NativeState {
    vault: Arc<Mutex<Vault>>,
    clipboard: mpsc::Sender<ClipboardAction>,
}

// Updater installation and process relaunch call cleanup_before_exit directly,
// bypassing event handlers. Its resource-table cleanup drops this guard before
// std::process::exit, synchronously locking secrets and clearing leased OTPs.
struct ExitCleanup(NativeState);
impl tauri::Resource for ExitCleanup {}
impl Drop for ExitCleanup {
    fn drop(&mut self) {
        lock_and_clear(&self.0);
    }
}

enum ClipboardAction {
    Copy(Zeroizing<String>, mpsc::Sender<Result<()>>),
    Clear(Option<mpsc::Sender<Result<()>>>),
}

struct ClipboardLease {
    text: Zeroizing<String>,
    expires: Instant,
}

trait ClipboardAccess {
    fn text(&mut self) -> Option<String>;
    fn clear_text(&mut self) -> bool;
}

#[cfg(desktop)]
impl ClipboardAccess for Clipboard {
    fn text(&mut self) -> Option<String> {
        self.get_text().ok()
    }
    fn clear_text(&mut self) -> bool {
        self.clear().is_ok()
    }
}

#[cfg(mobile)]
struct Clipboard(tauri::AppHandle);

#[cfg(mobile)]
impl Clipboard {
    fn set_text(&mut self, text: &str) -> Result<()> {
        self.0
            .clipboard()
            .write_text(text)
            .map_err(|_| "Unable to copy this code.".into())
    }
}

#[cfg(mobile)]
impl ClipboardAccess for Clipboard {
    fn text(&mut self) -> Option<String> {
        self.0.clipboard().read_text().ok()
    }
    fn clear_text(&mut self) -> bool {
        self.0.clipboard().clear().is_ok()
    }
}

fn platform_clipboard(_app: &tauri::AppHandle) -> Option<Clipboard> {
    #[cfg(desktop)]
    {
        Clipboard::new().ok()
    }
    #[cfg(mobile)]
    {
        Some(Clipboard(_app.clone()))
    }
}

fn clear_lease<C: ClipboardAccess>(
    clipboard: &mut Option<C>,
    lease: &mut Option<ClipboardLease>,
) -> bool {
    let Some(old) = lease.take() else {
        return true;
    };
    let cleared = clipboard
        .as_mut()
        .is_some_and(|clipboard| match clipboard.text() {
            Some(current) if current != *old.text => true,
            Some(_) => clipboard.clear_text(),
            None => false,
        });
    // Clipboard can be briefly busy. Keep the lease so the next tick retries.
    if !cleared {
        *lease = Some(old);
    }
    cleared
}

fn spawn_native_worker(
    app: tauri::AppHandle,
    state: NativeState,
    receiver: mpsc::Receiver<ClipboardAction>,
) {
    std::thread::spawn(move || {
        let mut clipboard = None;
        let mut lease: Option<ClipboardLease> = None;
        loop {
            match receiver.recv_timeout(Duration::from_millis(500)) {
                Ok(ClipboardAction::Copy(text, result)) => {
                    let mut vault = match state.vault.try_lock() {
                        Ok(vault) => vault,
                        Err(_) => {
                            let _ = result.send(Err(
                                "Vault is busy. Wait for the current operation to finish.".into(),
                            ));
                            if lease.as_ref().is_some_and(|l| Instant::now() >= l.expires) {
                                clear_lease(&mut clipboard, &mut lease);
                            }
                            continue;
                        }
                    };
                    if !vault.status().unlocked {
                        clear_lease(&mut clipboard, &mut lease);
                        let _ = result.send(Err("Vault locked. Unlock it to continue.".into()));
                        continue;
                    }
                    if clipboard.is_none() {
                        clipboard = platform_clipboard(&app);
                    }
                    let copied = clipboard
                        .as_mut()
                        .ok_or_else(|| "Clipboard is unavailable.".to_string())
                        .and_then(|c| {
                            c.set_text(text.as_str())
                                .map_err(|_| "Unable to copy this code.".into())
                        });
                    if copied.is_ok() {
                        lease = Some(ClipboardLease {
                            text,
                            expires: Instant::now() + Duration::from_secs(30),
                        });
                    }
                    let _ = result.send(copied);
                }
                Ok(ClipboardAction::Clear(done)) => {
                    let cleared = clear_lease(&mut clipboard, &mut lease);
                    if let Some(done) = done {
                        let _ = done.send(if cleared { Ok(()) } else { Err("Vault locked, but clipboard is busy. Try again before installing the update.".into()) });
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    clear_lease(&mut clipboard, &mut lease);
                    return;
                }
            }
            // A slow KDF or disk operation must not delay clipboard expiry.
            let expired = state
                .vault
                .try_lock()
                .map(|mut v| v.expire())
                .unwrap_or(false);
            if expired {
                clear_lease(&mut clipboard, &mut lease);
                let _ = app.emit("vault-locked", ());
            }
            if lease.as_ref().is_some_and(|l| Instant::now() >= l.expires) {
                clear_lease(&mut clipboard, &mut lease);
            }
        }
    });
}

async fn with_vault<T: Send + 'static>(
    state: &NativeState,
    work: impl FnOnce(&mut Vault) -> Result<T> + Send + 'static,
) -> Result<T> {
    let vault = state.vault.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut vault = vault
            .lock()
            .map_err(|_| "Vault unavailable. Restart the app.".to_string())?;
        work(&mut vault)
    })
    .await
    .map_err(|_| "Vault operation failed safely. Restart the app.".to_string())?
}

#[tauri::command]
async fn vault_status(state: State<'_, NativeState>) -> Result<VaultStatus> {
    with_vault(&state, |v| Ok(v.status())).await
}

#[tauri::command]
async fn create_vault(state: State<'_, NativeState>, password: String) -> Result<Vec<AccountCode>> {
    let password = Zeroizing::new(password);
    with_vault(&state, move |v| v.create(&password)).await
}

#[tauri::command]
async fn unlock_vault(state: State<'_, NativeState>, password: String) -> Result<Vec<AccountCode>> {
    let password = Zeroizing::new(password);
    with_vault(&state, move |v| v.unlock(&password)).await
}

fn device_protector(window: &tauri::WebviewWindow) -> NativeProtector {
    #[cfg(target_os = "windows")]
    let handle = window.hwnd().map(|hwnd| hwnd.0 as usize).unwrap_or(0);
    #[cfg(not(target_os = "windows"))]
    let handle = {
        let _ = window;
        0
    };
    NativeProtector { window: handle }
}

#[tauri::command]
async fn device_unlock_status(
    state: State<'_, NativeState>,
    window: tauri::WebviewWindow,
) -> Result<DeviceStatus> {
    let protector = device_protector(&window);
    with_vault(&state, move |v| Ok(v.device_status(&protector))).await
}

#[tauri::command]
async fn enable_device_unlock(
    state: State<'_, NativeState>,
    window: tauri::WebviewWindow,
    password: String,
) -> Result<DeviceStatus> {
    let password = Zeroizing::new(password);
    let protector = device_protector(&window);
    with_vault(&state, move |v| v.enable_device(&password, &protector)).await
}

#[tauri::command]
async fn unlock_with_device(
    state: State<'_, NativeState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<AccountCode>> {
    let protector = device_protector(&window);
    with_vault(&state, move |v| v.unlock_device(&protector)).await
}

#[tauri::command]
async fn disable_device_unlock(
    state: State<'_, NativeState>,
    window: tauri::WebviewWindow,
) -> Result<DeviceStatus> {
    let protector = device_protector(&window);
    with_vault(&state, move |v| v.disable_device(&protector)).await
}

#[tauri::command]
async fn lock_vault(state: State<'_, NativeState>) -> Result<()> {
    with_vault(&state, |v| {
        v.lock();
        Ok(())
    })
    .await?;
    let (sender, receiver) = mpsc::channel();
    state
        .clipboard
        .send(ClipboardAction::Clear(Some(sender)))
        .map_err(|_| "Vault locked, but clipboard is unavailable.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(1))
            .map_err(|_| "Vault locked, but clipboard cleanup timed out.".to_string())?
    })
    .await
    .map_err(|_| "Vault locked, but clipboard cleanup failed.".to_string())?
}

#[tauri::command]
async fn touch_session(state: State<'_, NativeState>) -> Result<()> {
    with_vault(&state, |v| v.touch()).await
}

#[tauri::command]
async fn list_codes(state: State<'_, NativeState>) -> Result<Vec<AccountCode>> {
    with_vault(&state, |v| v.codes()).await
}

#[tauri::command]
async fn account_qr(
    state: State<'_, NativeState>,
    id: String,
    password: String,
) -> Result<crate::otp::AccountQr> {
    let password = Zeroizing::new(password);
    with_vault(&state, move |v| v.account_qr(&id, &password)).await
}

#[tauri::command]
async fn add_account(
    state: State<'_, NativeState>,
    input: AccountInput,
) -> Result<Vec<AccountCode>> {
    with_vault(&state, move |v| v.add(&input)).await
}

#[tauri::command]
async fn delete_account(state: State<'_, NativeState>, id: String) -> Result<Vec<AccountCode>> {
    with_vault(&state, move |v| v.delete(&id)).await
}

#[tauri::command]
async fn reorder_accounts(
    state: State<'_, NativeState>,
    ids: Vec<String>,
) -> Result<Vec<AccountCode>> {
    with_vault(&state, move |v| v.reorder(&ids)).await
}

#[tauri::command]
async fn preview_accounts(
    state: State<'_, NativeState>,
    uris: Vec<String>,
) -> Result<crate::migration::Preview> {
    let uris = Zeroizing::new(uris);
    with_vault(&state, move |v| v.preview_accounts(&uris)).await
}

#[tauri::command]
async fn import_accounts(
    state: State<'_, NativeState>,
    uris: Vec<String>,
    selected: Vec<usize>,
) -> Result<Vec<AccountCode>> {
    let uris = Zeroizing::new(uris);
    with_vault(&state, move |v| v.import_accounts(&uris, &selected)).await
}

#[tauri::command]
async fn preview_google_export(
    state: State<'_, NativeState>,
    uris: Vec<String>,
) -> Result<crate::migration::Preview> {
    let uris = Zeroizing::new(uris);
    with_vault(&state, move |v| v.preview_google(&uris)).await
}

#[tauri::command]
async fn import_google_export(
    state: State<'_, NativeState>,
    uris: Vec<String>,
    selected: Vec<usize>,
) -> Result<Vec<AccountCode>> {
    let uris = Zeroizing::new(uris);
    with_vault(&state, move |v| v.import_google(&uris, &selected)).await
}

#[tauri::command]
async fn copy_code(state: State<'_, NativeState>, id: String) -> Result<()> {
    let code = Zeroizing::new(with_vault(&state, move |v| v.copy_value(&id)).await?);
    let (sender, receiver) = mpsc::channel();
    state
        .clipboard
        .send(ClipboardAction::Copy(code, sender))
        .map_err(|_| "Clipboard is unavailable.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Clipboard is unavailable.".to_string())?
    })
    .await
    .map_err(|_| "Clipboard is unavailable.".to_string())?
}

#[tauri::command]
async fn export_backup(state: State<'_, NativeState>, path: String) -> Result<()> {
    with_vault(&state, move |v| v.export(&PathBuf::from(path))).await
}

#[tauri::command]
async fn import_backup(
    state: State<'_, NativeState>,
    path: String,
    password: String,
) -> Result<Vec<AccountCode>> {
    let password = Zeroizing::new(password);
    with_vault(&state, move |v| v.import(&PathBuf::from(path), &password)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    updater_configured: bool,
    mobile: bool,
    auto_lock_minutes: u32,
}

#[tauri::command]
async fn app_info(app: tauri::AppHandle, state: State<'_, NativeState>) -> Result<AppInfo> {
    let updater_configured = cfg!(desktop)
        && app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|v| v.get("pubkey"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|key| !key.trim().is_empty() && key.trim() != "UNCONFIGURED");
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        updater_configured,
        mobile: cfg!(mobile),
        auto_lock_minutes: with_vault(&state, |vault| Ok(vault.auto_lock_minutes())).await?,
    })
}

#[tauri::command]
async fn set_auto_lock_minutes(state: State<'_, NativeState>, minutes: u32) -> Result<()> {
    with_vault(&state, move |vault| vault.set_auto_lock_minutes(minutes)).await
}

#[tauri::command]
async fn sync_status(state: State<'_, NativeState>) -> Result<crate::sync::SyncStatus> {
    with_vault(&state, |v| v.sync_status()).await
}

#[tauri::command]
async fn sync_create(
    state: State<'_, NativeState>,
    server: String,
    registration: String,
) -> Result<crate::sync::PairingInfo> {
    let registration = Zeroizing::new(registration);
    with_vault(&state, move |v| v.sync_create(&server, &registration)).await
}

#[tauri::command]
async fn sync_pair(state: State<'_, NativeState>, uri: String) -> Result<Vec<AccountCode>> {
    let uri = Zeroizing::new(uri);
    with_vault(&state, move |v| v.sync_pair(&uri)).await
}

#[tauri::command]
async fn sync_once(state: State<'_, NativeState>) -> Result<crate::sync::SyncResult> {
    with_vault(&state, |v| v.sync_once()).await
}

#[tauri::command]
async fn sync_pairing(state: State<'_, NativeState>) -> Result<crate::sync::PairingInfo> {
    with_vault(&state, |v| v.sync_pairing()).await
}

#[tauri::command]
async fn sync_disconnect(state: State<'_, NativeState>) -> Result<()> {
    with_vault(&state, |v| v.sync_disconnect()).await
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        // Acquire the platform instance guard before any plugin or vault setup.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            #[cfg(debug_assertions)]
            let app_data = match std::env::var_os("MFA_TEST_DATA_DIR") {
                Some(value) => {
                    let path = PathBuf::from(value);
                    if !path.is_absolute() {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            "MFA_TEST_DATA_DIR must be an absolute path.",
                        )
                        .into());
                    }
                    path
                }
                None => app_data,
            };
            let path = app_data.join("vault.mfa");
            let vault = Vault::new(path).map_err(std::io::Error::other)?;
            let (sender, receiver) = mpsc::channel();
            let state = NativeState {
                vault: Arc::new(Mutex::new(vault)),
                clipboard: sender,
            };
            app.manage(state.clone());
            app.resources_table().add(ExitCleanup(state.clone()));
            spawn_native_worker(app.handle().clone(), state, receiver);
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                lock_and_clear(&window.state::<NativeState>());
            }
            #[cfg(mobile)]
            if matches!(event, tauri::WindowEvent::Suspended) {
                // Do not block the mobile UI thread: clipboard plugin calls are
                // marshalled back to that thread.
                let state = window.state::<NativeState>().inner().clone();
                let window = window.clone();
                std::thread::spawn(move || {
                    let Ok(mut vault) = state.vault.lock() else {
                        return;
                    };
                    if vault.auto_lock_minutes() == 0 {
                        return;
                    }
                    vault.lock();
                    drop(vault);
                    let _ = state.clipboard.send(ClipboardAction::Clear(None));
                    let _ = window.emit("vault-locked", ());
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            create_vault,
            unlock_vault,
            device_unlock_status,
            enable_device_unlock,
            unlock_with_device,
            disable_device_unlock,
            lock_vault,
            touch_session,
            list_codes,
            account_qr,
            add_account,
            reorder_accounts,
            preview_accounts,
            import_accounts,
            preview_google_export,
            import_google_export,
            delete_account,
            copy_code,
            export_backup,
            import_backup,
            app_info,
            set_auto_lock_minutes,
            sync_status,
            sync_create,
            sync_pair,
            sync_once,
            sync_pairing,
            sync_disconnect
        ])
        .build(tauri::generate_context!())
        .expect("Unable to start MFA Desktop")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                lock_and_clear(&app.state::<NativeState>());
            }
        });
}

fn lock_and_clear(state: &NativeState) {
    // Drop the vault guard before waiting: the clipboard worker may inspect it.
    if let Ok(mut vault) = state.vault.lock() {
        vault.lock();
    }
    let (sender, receiver) = mpsc::channel();
    if state
        .clipboard
        .send(ClipboardAction::Clear(Some(sender)))
        .is_ok()
    {
        let _ = receiver.recv_timeout(Duration::from_secs(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeClipboard {
        value: String,
        clears: u8,
        fail_clear: bool,
    }
    impl ClipboardAccess for FakeClipboard {
        fn text(&mut self) -> Option<String> {
            Some(self.value.clone())
        }
        fn clear_text(&mut self) -> bool {
            if self.fail_clear {
                return false;
            }
            self.value.clear();
            self.clears += 1;
            true
        }
    }

    #[test]
    fn clipboard_expiry_clears_only_the_unchanged_copied_value() {
        let mut clipboard = Some(FakeClipboard {
            value: "123456".into(),
            clears: 0,
            fail_clear: false,
        });
        let mut lease = Some(ClipboardLease {
            text: Zeroizing::new("123456".into()),
            expires: Instant::now(),
        });
        clear_lease(&mut clipboard, &mut lease);
        assert_eq!(clipboard.as_ref().unwrap().clears, 1);
        assert!(lease.is_none());
        clipboard.as_mut().unwrap().value = "new user clipboard content".into();
        let mut lease = Some(ClipboardLease {
            text: Zeroizing::new("123456".into()),
            expires: Instant::now(),
        });
        clear_lease(&mut clipboard, &mut lease);
        assert_eq!(clipboard.as_ref().unwrap().clears, 1);
        assert_eq!(
            clipboard.as_ref().unwrap().value,
            "new user clipboard content"
        );
    }

    #[test]
    fn busy_clipboard_retains_lease_for_retry() {
        let mut clipboard = Some(FakeClipboard {
            value: "123456".into(),
            clears: 0,
            fail_clear: true,
        });
        let mut lease = Some(ClipboardLease {
            text: Zeroizing::new("123456".into()),
            expires: Instant::now(),
        });
        assert!(!clear_lease(&mut clipboard, &mut lease));
        assert!(lease.is_some());
        clipboard.as_mut().unwrap().fail_clear = false;
        assert!(clear_lease(&mut clipboard, &mut lease));
        assert!(lease.is_none());
    }

    #[test]
    fn resource_cleanup_locks_and_waits_for_clipboard_ack() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().join("vault.mfa")).unwrap();
        vault.create("test-only-password-123").unwrap();
        let (sender, receiver) = mpsc::channel();
        let state = NativeState {
            vault: Arc::new(Mutex::new(vault)),
            clipboard: sender,
        };
        let acknowledged = Arc::new(AtomicBool::new(false));
        let ack_flag = acknowledged.clone();
        let worker = std::thread::spawn(move || {
            if let ClipboardAction::Clear(Some(done)) = receiver.recv().unwrap() {
                ack_flag.store(true, Ordering::SeqCst);
                done.send(Ok(())).unwrap();
            } else {
                panic!("expected synchronous cleanup");
            }
        });
        let mut resources = tauri::ResourceTable::default();
        resources.add(ExitCleanup(state.clone()));
        drop(resources);
        assert!(acknowledged.load(Ordering::SeqCst));
        assert!(!state.vault.lock().unwrap().status().unlocked);
        worker.join().unwrap();
    }
}
