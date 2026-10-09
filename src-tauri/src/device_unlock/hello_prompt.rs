//! Keep a newly requested Windows credential dialog active while biometric
//! recognition starts. This changes window activation only, never authentication.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use windows::{
    core::{w, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HWND},
        System::{
            SystemInformation::GetSystemDirectoryW,
            Threading::{
                GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::WindowsAndMessaging::{
            AllowSetForegroundWindow, FindWindowW, GetForegroundWindow, GetWindowThreadProcessId,
            IsWindowVisible, SetForegroundWindow,
        },
    },
};

pub struct HelloPrompt {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

fn is_broker_image(image: &str, system: &str) -> bool {
    image.eq_ignore_ascii_case(&format!("{system}\\CredentialUIBroker.exe"))
}

fn credential_dialog() -> Option<(HWND, u32)> {
    unsafe {
        let window = FindWindowW(w!("Credential Dialog Xaml Host"), None).ok()?;
        if !IsWindowVisible(window).as_bool() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(window, Some(&mut pid));
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut image = [0u16; 32768];
        let mut count = image.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(image.as_mut_ptr()),
            &mut count,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        let mut system = [0u16; 260];
        let size = GetSystemDirectoryW(Some(&mut system)) as usize;
        if size == 0 || size >= system.len() {
            return None;
        }
        is_broker_image(
            &String::from_utf16_lossy(&image[..count as usize]),
            &String::from_utf16_lossy(&system[..size]),
        )
        .then_some((window, pid))
    }
}

impl HelloPrompt {
    pub fn start(parent: usize) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let mut guard = Self {
            stop: stop.clone(),
            worker: None,
        };
        if parent == 0 {
            return guard;
        }
        let existing = credential_dialog().map(|(window, _)| window.0 as usize);
        #[cfg(debug_assertions)]
        eprintln!(
            "[MFA Hello prompt] start; existing visible trusted dialog: {}",
            existing.is_some()
        );
        unsafe {
            let parent = HWND(parent as *mut _);
            let mut pid = 0;
            GetWindowThreadProcessId(parent, Some(&mut pid));
            if pid != GetCurrentProcessId() {
                return guard;
            }
            let _activated = SetForegroundWindow(parent);
            #[cfg(debug_assertions)]
            eprintln!(
                "[MFA Hello prompt] activate parent: {}",
                _activated.as_bool()
            );
        }
        guard.worker = thread::Builder::new()
            .name("hello-prompt-focus".into())
            .spawn(move || {
                let _started = std::time::Instant::now();
                let mut _seen = false;
                let mut _activated_dialog = false;
                // Bounded activation help for this explicit prompt only. Never touch
                // a pre-existing dialog or grant foreground rights to every process.
                for _ in 0..40 {
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    if let Some((window, pid)) = credential_dialog() {
                        _seen = true;
                        if Some(window.0 as usize) != existing {
                            unsafe {
                                if GetForegroundWindow() != window {
                                    let _ = AllowSetForegroundWindow(pid);
                                    _activated_dialog |= SetForegroundWindow(window).as_bool();
                                }
                            }
                        }
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                #[cfg(debug_assertions)]
                eprintln!(
                    "[MFA Hello prompt] end; saw trusted dialog: {_seen}; activated: {_activated_dialog}; elapsed ms: {}",
                    _started.elapsed().as_millis()
                );
            })
            .ok();
        guard
    }
}
impl Drop for HelloPrompt {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_accepts_the_system_credential_broker_image() {
        assert!(is_broker_image(
            r"C:\WINDOWS\System32\CredentialUIBroker.exe",
            r"C:\Windows\System32"
        ));
        assert!(!is_broker_image(
            r"C:\Temp\CredentialUIBroker.exe",
            r"C:\Windows\System32"
        ));
        assert!(!is_broker_image(
            r"C:\Windows\System32\Other.exe",
            r"C:\Windows\System32"
        ));
        assert!(!is_broker_image(
            r"C:\Windows\System32\CredentialUIBroker.exe.extra",
            r"C:\Windows\System32"
        ));
    }
}
