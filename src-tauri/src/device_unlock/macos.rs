use super::*;
use core_foundation::{
    base::{CFRelease, CFTypeRef, TCFType},
    string::{CFString, CFStringRef},
};
use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use security_framework::{
    access_control::{ProtectionMode, SecAccessControl},
    passwords::{self, AccessControlOptions, PasswordOptions},
};

#[link(name = "LocalAuthentication", kind = "framework")]
unsafe extern "C" {}

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecTaskCreateFromSelf(allocator: *const std::ffi::c_void) -> CFTypeRef;
    fn SecTaskCopyValueForEntitlement(
        task: CFTypeRef,
        entitlement: CFStringRef,
        error: *mut CFTypeRef,
    ) -> CFTypeRef;
}

fn has_keychain_identity() -> bool {
    // Data-protection Keychain requires an application-identifier entitlement.
    // Unsigned development builds retain the master-password path.
    unsafe {
        let task = SecTaskCreateFromSelf(std::ptr::null());
        if task.is_null() {
            return false;
        }
        let name = CFString::new("com.apple.application-identifier");
        let value =
            SecTaskCopyValueForEntitlement(task, name.as_concrete_TypeRef(), std::ptr::null_mut());
        CFRelease(task);
        if value.is_null() {
            return false;
        }
        CFRelease(value);
        true
    }
}

const SERVICE: &str = "app.mfadesktop.authenticator.device-unlock.v1";

fn options(id: &str) -> PasswordOptions {
    let mut options = PasswordOptions::new_generic_password(SERVICE, id);
    options.use_protected_keychain();
    options.set_access_synchronized(Some(false));
    options
}

impl Protector for NativeProtector {
    fn label(&self) -> &'static str {
        "Touch ID"
    }

    fn available(&self) -> bool {
        let _ = self.window;
        if !has_keychain_identity() {
            return false;
        }
        // DeviceOwnerAuthenticationWithBiometrics: no password-only fallback
        // masquerading as Touch ID. Keychain enforces the same biometric gate.
        unsafe {
            let context: Retained<AnyObject> = msg_send![class!(LAContext), new];
            msg_send![&*context, canEvaluatePolicy: 1_isize, error: std::ptr::null_mut::<*mut AnyObject>()]
        }
    }

    fn seal(&self, id: &str, key: &[u8]) -> Result<Vec<u8>> {
        if !self.available() {
            return Err(UNAVAILABLE.into());
        }
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            AccessControlOptions::BIOMETRY_CURRENT_SET.bits(),
        )
        .map_err(|_| UNAVAILABLE.to_string())?;
        let mut options = options(id);
        options.set_access_control(access);
        options.set_label("MFA Desktop — Touch ID");
        passwords::set_generic_password_options(key, options).map_err(|_| FAILED.to_string())?;
        Ok(vec![]) // Secret exists only inside the non-synchronizing Keychain.
    }

    fn unseal(&self, id: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        if !sealed.is_empty() {
            return Err(INVALID.into());
        }
        passwords::generic_password(options(id))
            .map(Zeroizing::new)
            .map_err(|_| FAILED.into())
    }

    fn delete(&self, id: &str) -> Result<()> {
        match passwords::delete_generic_password_options(options(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == -25300 => Ok(()), // Already absent.
            Err(_) => Err(FAILED.into()),
        }
    }
}
