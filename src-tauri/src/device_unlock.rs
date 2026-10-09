//! OS-protected convenience unlock. Passwords never enter the device store.
use crate::otp::Result;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

pub const UNAVAILABLE: &str = "Device unlock is unavailable. Use your master password.";
pub const FAILED: &str = "Device unlock was cancelled or failed. Use your master password.";
pub const INVALID: &str = "Device unlock needs to be set up again. Use your master password.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub available: bool,
    pub enabled: bool,
    pub label: &'static str,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Enrollment {
    pub version: u8,
    pub id: uuid::Uuid,
    pub salt: [u8; 16],
    pub sealed: Vec<u8>,
}

pub trait Protector {
    fn label(&self) -> &'static str;
    fn available(&self) -> bool;
    fn seal(&self, id: &str, key: &[u8]) -> Result<Vec<u8>>;
    fn unseal(&self, id: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>>;
    fn delete(&self, id: &str) -> Result<()>;
}

pub struct NativeProtector {
    // OS prompts are parented to the calling window on Windows.
    pub window: usize,
}

#[cfg(target_os = "windows")]
#[path = "device_unlock/windows.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "device_unlock/macos.rs"]
mod platform;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl Protector for NativeProtector {
    fn label(&self) -> &'static str {
        "ปลดล็อกด้วยอุปกรณ์"
    }
    fn available(&self) -> bool {
        let _ = self.window;
        false
    }
    fn seal(&self, _: &str, _: &[u8]) -> Result<Vec<u8>> {
        Err(UNAVAILABLE.into())
    }
    fn unseal(&self, _: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        Err(UNAVAILABLE.into())
    }
    fn delete(&self, _: &str) -> Result<()> {
        Ok(())
    }
}
