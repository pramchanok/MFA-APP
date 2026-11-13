use super::*;
#[path = "hello_prompt.rs"]
mod hello_prompt;
use windows::{
    core::{w, HSTRING, PCWSTR, PWSTR},
    Security::Credentials::UI::{UserConsentVerifier, UserConsentVerifierAvailability},
    Win32::{
        Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL},
        Security::{
            Authorization::ConvertSidToStringSidW, Cryptography::*, GetTokenInformation, TokenUser,
            OBJECT_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
        },
        System::{
            Threading::{GetCurrentProcess, OpenProcessToken},
            WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        },
    },
};

struct Cng(NCRYPT_HANDLE);

const RSA_CIPHERTEXT_SIZE: usize = 256;
const PASSPORT_PKCS1: u8 = 1;

#[derive(Clone, Copy)]
enum RsaPadding {
    OaepSha256,
    Pkcs1,
}

fn wrapped_key(sealed: &[u8]) -> Result<(RsaPadding, &[u8])> {
    match sealed {
        // Earlier Windows enrollments have an untagged OAEP ciphertext.
        bytes if bytes.len() == RSA_CIPHERTEXT_SIZE => Ok((RsaPadding::OaepSha256, bytes)),
        [PASSPORT_PKCS1, bytes @ ..] if bytes.len() == RSA_CIPHERTEXT_SIZE => {
            Ok((RsaPadding::Pkcs1, bytes))
        }
        _ => Err(INVALID.into()),
    }
}

fn native_failure(operation: &str, error: windows::core::Error) -> String {
    #[cfg(debug_assertions)]
    eprintln!(
        "[MFA device-unlock] {operation}: HRESULT {:08X}",
        error.code().0 as u32
    );
    match error.code().0 as u32 {
        0x80090036 | 0x800704C7 => "Device unlock was cancelled. Use your master password.".into(),
        0x80098044 => "Windows Hello could not validate the biometric ticket (0x80098044). Try again or choose the Windows PIN.".into(),
        code => format!("Windows Hello failed during {operation} (0x{code:08X}). Use your master password."),
    }
}
impl Drop for Cng {
    fn drop(&mut self) {
        unsafe {
            let _ = NCryptFreeObject(self.0);
        }
    }
}
impl Cng {
    fn key(&self) -> NCRYPT_KEY_HANDLE {
        NCRYPT_KEY_HANDLE(self.0 .0)
    }
    fn set(&self, property: PCWSTR, value: &[u8]) -> Result<()> {
        unsafe { NCryptSetProperty(self.0, property, value, NCRYPT_FLAGS(0)) }
            .map_err(|error| native_failure("set key policy", error))
    }
    fn property(&self, property: PCWSTR) -> Result<u32> {
        let mut bytes = [0; 4];
        let mut count = 0;
        unsafe {
            NCryptGetProperty(
                self.0,
                property,
                Some(&mut bytes),
                &mut count,
                OBJECT_SECURITY_INFORMATION(0),
            )
        }
        .map_err(|_| INVALID.to_string())?;
        if count != 4 {
            return Err(INVALID.into());
        }
        Ok(u32::from_le_bytes(bytes))
    }
    fn verify(&self) -> Result<()> {
        // Reject imported/replaced keys and keys permitting cached consent.
        let usage = self.property(NCRYPT_KEY_USAGE_PROPERTY)?;
        if usage & NCRYPT_ALLOW_DECRYPT_FLAG == 0
            || usage & 8 != 0
            || self.property(w!("NgcCacheType"))? != 1
            || self.property(NCRYPT_EXPORT_POLICY_PROPERTY)? != 0
        {
            return Err(INVALID.into());
        }
        Ok(())
    }
    fn context(&self, window: usize) -> Result<()> {
        if window != 0 {
            self.set(NCRYPT_WINDOW_HANDLE_PROPERTY, &window.to_ne_bytes())?;
        }
        // Include the UTF-16 terminator, without logging any operation data.
        let utf16: Vec<u8> = "Unlock MFA Desktop"
            .encode_utf16()
            .chain(std::iter::once(0))
            .flat_map(|c| c.to_ne_bytes())
            .collect();
        self.set(NCRYPT_USE_CONTEXT_PROPERTY, &utf16)
    }
}

fn provider() -> Result<Cng> {
    let mut handle = NCRYPT_PROV_HANDLE::default();
    unsafe { NCryptOpenStorageProvider(&mut handle, MS_NGC_KEY_STORAGE_PROVIDER, 0) }
        .map_err(|_| UNAVAILABLE.to_string())?;
    Ok(Cng(NCRYPT_HANDLE(handle.0)))
}

fn key_name(id: &str) -> Result<HSTRING> {
    struct Token(HANDLE);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
    unsafe {
        let mut handle = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle)
            .map_err(|_| UNAVAILABLE.to_string())?;
        let token = Token(handle);
        let mut count = 0;
        let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut count);
        if count == 0 || count > 65536 {
            return Err(UNAVAILABLE.into());
        }
        // Aligned storage is required for TOKEN_USER and its trailing SID.
        let mut storage = vec![0usize; (count as usize).div_ceil(std::mem::size_of::<usize>())];
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(storage.as_mut_ptr().cast()),
            count,
            &mut count,
        )
        .map_err(|_| UNAVAILABLE.to_string())?;
        let user = &*storage.as_ptr().cast::<TOKEN_USER>();
        let mut sid = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut sid).map_err(|_| UNAVAILABLE.to_string())?;
        let result = sid.to_string().map_err(|_| UNAVAILABLE.to_string());
        let _ = LocalFree(Some(HLOCAL(sid.0.cast())));
        Ok(HSTRING::from(format!(
            "{}//MFA Desktop/device-unlock/{id}",
            result?
        )))
    }
}

fn open(id: &str) -> Result<Cng> {
    let provider = provider()?;
    let mut key = NCRYPT_KEY_HANDLE::default();
    unsafe {
        NCryptOpenKey(
            NCRYPT_PROV_HANDLE(provider.0 .0),
            &mut key,
            &key_name(id)?,
            CERT_KEY_SPEC(0),
            NCRYPT_FLAGS(0),
        )
    }
    .map_err(|_| INVALID.to_string())?;
    Ok(Cng(NCRYPT_HANDLE(key.0)))
}

// Public-key encryption does not require Passport's private-key provider. Only
// the public RSA blob leaves the provider; decryption remains Hello-protected.
fn encrypt_public_key(key: &Cng, input: &[u8], padding: RsaPadding) -> Result<Vec<u8>> {
    struct Algorithm(BCRYPT_ALG_HANDLE);
    impl Drop for Algorithm {
        fn drop(&mut self) {
            unsafe {
                let _ = BCryptCloseAlgorithmProvider(self.0, 0);
            }
        }
    }
    struct PublicKey(BCRYPT_KEY_HANDLE);
    impl Drop for PublicKey {
        fn drop(&mut self) {
            unsafe {
                let _ = BCryptDestroyKey(self.0);
            }
        }
    }
    unsafe {
        let mut count = 0;
        NCryptExportKey(
            key.key(),
            None,
            BCRYPT_RSAPUBLIC_BLOB,
            None,
            None,
            &mut count,
            NCRYPT_FLAGS(0),
        )
        .map_err(|error| native_failure("export public key", error))?;
        if count == 0 || count > 4096 {
            return Err(INVALID.into());
        }
        let mut blob = vec![0; count as usize];
        NCryptExportKey(
            key.key(),
            None,
            BCRYPT_RSAPUBLIC_BLOB,
            None,
            Some(&mut blob),
            &mut count,
            NCRYPT_FLAGS(0),
        )
        .map_err(|error| native_failure("export public key", error))?;
        blob.truncate(count as usize);
        let mut algorithm = BCRYPT_ALG_HANDLE::default();
        BCryptOpenAlgorithmProvider(
            &mut algorithm,
            BCRYPT_RSA_ALGORITHM,
            None,
            BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS(0),
        )
        .ok()
        .map_err(|_| FAILED.to_string())?;
        let algorithm = Algorithm(algorithm);
        let mut public = BCRYPT_KEY_HANDLE::default();
        BCryptImportKeyPair(
            algorithm.0,
            None,
            BCRYPT_RSAPUBLIC_BLOB,
            &mut public,
            &blob,
            0,
        )
        .ok()
        .map_err(|_| INVALID.to_string())?;
        let public = PublicKey(public);
        let oaep = BCRYPT_OAEP_PADDING_INFO {
            pszAlgId: BCRYPT_SHA256_ALGORITHM,
            ..Default::default()
        };
        let (info, flags) = match padding {
            RsaPadding::OaepSha256 => (
                Some((&oaep as *const BCRYPT_OAEP_PADDING_INFO).cast()),
                BCRYPT_PAD_OAEP,
            ),
            RsaPadding::Pkcs1 => (None, BCRYPT_PAD_PKCS1),
        };
        let mut sealed = vec![0; RSA_CIPHERTEXT_SIZE];
        BCryptEncrypt(
            public.0,
            Some(input),
            info,
            None,
            Some(&mut sealed),
            &mut count,
            flags,
        )
        .ok()
        .map_err(|error| native_failure("encrypt public key", error))?;
        if count as usize != RSA_CIPHERTEXT_SIZE {
            return Err(INVALID.into());
        }
        Ok(sealed)
    }
}

fn decrypt_key(
    key: &Cng,
    ciphertext: &[u8],
    padding: RsaPadding,
) -> windows::core::Result<Zeroizing<Vec<u8>>> {
    let mut bytes = Zeroizing::new(vec![0; RSA_CIPHERTEXT_SIZE]);
    let mut count = 0;
    let oaep = BCRYPT_OAEP_PADDING_INFO {
        pszAlgId: BCRYPT_SHA256_ALGORITHM,
        ..Default::default()
    };
    let (info, flags) = match padding {
        RsaPadding::OaepSha256 => (
            Some((&oaep as *const BCRYPT_OAEP_PADDING_INFO).cast()),
            NCRYPT_PAD_OAEP_FLAG,
        ),
        RsaPadding::Pkcs1 => (None, NCRYPT_PAD_PKCS1_FLAG),
    };
    unsafe {
        NCryptDecrypt(
            key.key(),
            Some(ciphertext),
            info,
            Some(&mut bytes),
            &mut count,
            flags,
        )
    }?;
    bytes.truncate(count as usize);
    Ok(bytes)
}

impl Protector for NativeProtector {
    fn label(&self) -> &'static str {
        "Windows Hello"
    }

    fn available(&self) -> bool {
        struct Runtime;
        impl Drop for Runtime {
            fn drop(&mut self) {
                unsafe {
                    RoUninitialize();
                }
            }
        }
        if unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_err() {
            return false;
        }
        let _runtime = Runtime;
        UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|operation| operation.join())
            .is_ok_and(|value| value == UserConsentVerifierAvailability::Available)
            && provider().is_ok()
    }

    fn seal(&self, id: &str, key_bytes: &[u8]) -> Result<Vec<u8>> {
        if !self.available() {
            return Err(UNAVAILABLE.into());
        }
        let provider = provider()?;
        let mut handle = NCRYPT_KEY_HANDLE::default();
        unsafe {
            NCryptCreatePersistedKey(
                NCRYPT_PROV_HANDLE(provider.0 .0),
                &mut handle,
                BCRYPT_RSA_ALGORITHM,
                &key_name(id)?,
                CERT_KEY_SPEC(0),
                NCRYPT_FLAGS(0),
            )
        }
        .map_err(|error| native_failure("create Hello key", error))?;
        let key = Cng(NCRYPT_HANDLE(handle.0));
        let result = (|| {
            key.set(NCRYPT_LENGTH_PROPERTY, &2048u32.to_le_bytes())?;
            key.set(
                NCRYPT_KEY_USAGE_PROPERTY,
                &NCRYPT_ALLOW_DECRYPT_FLAG.to_le_bytes(),
            )?;
            key.set(NCRYPT_EXPORT_POLICY_PROPERTY, &0u32.to_le_bytes())?;
            // Passport KSP policy: every private-key use needs a fresh gesture.
            // Unsupported policies fail closed; there is no software-KSP fallback.
            key.set(w!("NgcCacheType"), &1u32.to_le_bytes())?;
            key.context(self.window)?;
            let _prompt = hello_prompt::HelloPrompt::start(self.window);
            unsafe { NCryptFinalizeKey(key.key(), NCRYPT_FLAGS(0)) }
                .map_err(|error| native_failure("finalize Hello key", error))?;
            key.verify()?;
            // Passport KSP can reject OAEP decryption with NTE_INVALID_PARAMETER.
            // Use its supported padding for newly created local enrollment keys.
            let ciphertext = encrypt_public_key(&key, key_bytes, RsaPadding::Pkcs1)?;
            let mut sealed = Vec::with_capacity(1 + RSA_CIPHERTEXT_SIZE);
            sealed.push(PASSPORT_PKCS1);
            sealed.extend(ciphertext);
            Ok(sealed)
        })();
        if result.is_err() {
            // Delete consumes the handle on success.
            if unsafe { NCryptDeleteKey(key.key(), 0) }.is_ok() {
                std::mem::forget(key);
            }
        }
        result
    }

    fn unseal(&self, id: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        let (padding, ciphertext) = wrapped_key(sealed)?;
        let key = open(id)?;
        key.verify()?;
        key.context(self.window)?;
        key.set(
            NCRYPT_PIN_CACHE_IS_GESTURE_REQUIRED_PROPERTY,
            &1u32.to_le_bytes(),
        )?;
        let _prompt = hello_prompt::HelloPrompt::start(self.window);
        let bytes = decrypt_key(&key, ciphertext, padding)
            .map_err(|error| native_failure("Hello decrypt", error))?;
        if bytes.len() != 32 {
            return Err(INVALID.into());
        }
        Ok(bytes)
    }

    fn delete(&self, id: &str) -> Result<()> {
        let provider = provider()?;
        let mut handle = NCRYPT_KEY_HANDLE::default();
        let result = unsafe {
            NCryptOpenKey(
                NCRYPT_PROV_HANDLE(provider.0 .0),
                &mut handle,
                &key_name(id)?,
                CERT_KEY_SPEC(0),
                NCRYPT_SILENT_FLAG,
            )
        };
        if let Err(error) = result {
            // Resetting the Hello PIN may already have removed this key.
            return match error.code().0 as u32 {
                0x8009000D | 0x80090011 | 0x80090016 => Ok(()),
                _ => Err(native_failure("open key for deletion", error)),
            };
        }
        let key = Cng(NCRYPT_HANDLE(handle.0));
        unsafe { NCryptDeleteKey(key.key(), 0) }.map_err(|_| FAILED.to_string())?;
        std::mem::forget(key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_blob_encryption_roundtrips_legacy_and_passport_padding() {
        unsafe {
            // An unnamed software test key is never persisted and never used by
            // production enrollment. No biometric prompt or user data is needed.
            let mut provider = NCRYPT_PROV_HANDLE::default();
            NCryptOpenStorageProvider(&mut provider, MS_KEY_STORAGE_PROVIDER, 0).unwrap();
            let provider = Cng(NCRYPT_HANDLE(provider.0));
            let mut handle = NCRYPT_KEY_HANDLE::default();
            NCryptCreatePersistedKey(
                NCRYPT_PROV_HANDLE(provider.0 .0),
                &mut handle,
                BCRYPT_RSA_ALGORITHM,
                None,
                CERT_KEY_SPEC(0),
                NCRYPT_FLAGS(0),
            )
            .unwrap();
            let key = Cng(NCRYPT_HANDLE(handle.0));
            key.set(NCRYPT_LENGTH_PROPERTY, &2048u32.to_le_bytes())
                .unwrap();
            key.set(NCRYPT_EXPORT_POLICY_PROPERTY, &0u32.to_le_bytes())
                .unwrap();
            NCryptFinalizeKey(key.key(), NCRYPT_FLAGS(0)).unwrap();
            let input = [0x42; 32];
            let legacy = encrypt_public_key(&key, &input, RsaPadding::OaepSha256).unwrap();
            let pkcs1 = encrypt_public_key(&key, &input, RsaPadding::Pkcs1).unwrap();
            assert_ne!(
                pkcs1,
                encrypt_public_key(&key, &input, RsaPadding::Pkcs1).unwrap()
            );
            let mut tagged = vec![PASSPORT_PKCS1];
            tagged.extend(&pkcs1);
            for sealed in [&legacy, &tagged] {
                let (padding, ciphertext) = wrapped_key(sealed).unwrap();
                assert_eq!(
                    decrypt_key(&key, ciphertext, padding).unwrap().as_slice(),
                    input
                );
            }
            assert!(decrypt_key(&key, &legacy, RsaPadding::Pkcs1).is_err());
            assert!(decrypt_key(&key, &pkcs1, RsaPadding::OaepSha256).is_err());
            tagged[0] = 0;
            assert!(wrapped_key(&tagged).is_err());
        }
    }
    #[test]
    fn distinguishes_biometric_ticket_errors_from_cancellation_without_key_material() {
        let failure = |code: u32| {
            native_failure(
                "finalize Hello key",
                windows::core::Error::from_hresult(windows::core::HRESULT(code as i32)),
            )
        };
        assert!(failure(0x80098044).contains("biometric ticket"));
        assert!(!failure(0x80098044).contains("cancelled"));
        assert_eq!(
            failure(0x80090036),
            "Device unlock was cancelled. Use your master password."
        );
        assert_eq!(failure(0x800704C7), failure(0x80090036));
        assert!(failure(0x80090029).contains("finalize Hello key (0x80090029)"));
    }
}
