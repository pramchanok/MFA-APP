use crate::device_unlock::{self, DeviceStatus, Enrollment, Protector};
use crate::migration::{self, Preview};
use crate::otp::{self, Account, AccountCode, AccountInput, Result};
use crate::sync::{self, PairingInfo, SyncResult, SyncStatus};
use argon2::{Algorithm, Argon2, Params, Version};
use iota_stronghold::{Client, KeyProvider, SnapshotPath, Stronghold};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tempfile::NamedTempFile;
use zeroize::Zeroizing;

const HEADER: &[u8; 8] = b"MFAVLT01";
const CLIENT: &[u8] = b"mfa-desktop-v1";
const METADATA: &[u8] = b"accounts-v1";
const SYNC_METADATA: &[u8] = b"sync-v1";
const MAX_FILE: u64 = 16 * 1024 * 1024;
const MAX_ACCOUNTS: usize = 1000;
const DEFAULT_AUTO_LOCK_MINUTES: u32 = 5;
const MAX_AUTO_LOCK_MINUTES: u32 = 1440;
#[cfg(test)]
const IDLE_TIMEOUT: Duration = Duration::from_secs(DEFAULT_AUTO_LOCK_MINUTES as u64 * 60);
const BAD_BACKUP: &str = "Invalid backup, damaged vault or incorrect password.";
const IO_ERROR: &str =
    "Unable to read or save the encrypted vault. Check file permissions and disk space.";
const ORDER_ERROR: &str = "The account list changed. Refresh it before reordering.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
}

struct Session {
    stronghold: Stronghold,
    client: Client,
    key: Arc<KeyProvider>,
    salt: [u8; 16],
    accounts: Vec<Account>,
    sync: Option<sync::State>,
    last_activity: Instant,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.stronghold.clear();
    }
}

pub struct Vault {
    path: PathBuf,
    session: Option<Session>,
    auto_lock_minutes: u32,
    // Held for the Vault lifetime, including while its secrets are locked.
    // The OS releases the advisory lock automatically if the process exits.
    _file_lock: File,
}

impl Vault {
    pub fn new(path: PathBuf) -> Result<Self> {
        #[cfg(test)]
        {
            // Stronghold explicitly provides this test-only speed override. Keep
            // production snapshot strength unchanged; Argon2id remains full cost.
            static TEST_WORK_FACTOR: std::sync::Once = std::sync::Once::new();
            TEST_WORK_FACTOR.call_once(|| {
                iota_stronghold::engine::snapshot::try_set_encrypt_work_factor(10)
                    .expect("valid test work factor");
            });
        }
        let parent = path.parent().ok_or(IO_ERROR)?;
        fs::create_dir_all(parent).map_err(|_| IO_ERROR)?;
        let file_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path.with_extension("lock"))
            .map_err(|_| IO_ERROR)?;
        file_lock.try_lock().map_err(|_| {
            "This vault is already open in another app instance. Close it before trying again."
        })?;
        let auto_lock_minutes = File::open(path.with_extension("auto-lock"))
            .ok()
            .and_then(|file| {
                let mut value = String::new();
                file.take(5).read_to_string(&mut value).ok()?;
                value
                    .parse::<u32>()
                    .ok()
                    .filter(|minutes| minutes.to_string() == value)
            })
            .filter(|&minutes| minutes <= MAX_AUTO_LOCK_MINUTES)
            .unwrap_or(DEFAULT_AUTO_LOCK_MINUTES);
        Ok(Self {
            path,
            session: None,
            auto_lock_minutes,
            _file_lock: file_lock,
        })
    }

    pub fn status(&mut self) -> VaultStatus {
        self.expire();
        VaultStatus {
            exists: self.path.exists(),
            unlocked: self.session.is_some(),
        }
    }

    pub fn expire(&mut self) -> bool {
        let minutes = self.auto_lock_minutes;
        if minutes != 0
            && self.session.as_ref().is_some_and(|s| {
                s.last_activity.elapsed() >= Duration::from_secs(u64::from(minutes) * 60)
            })
        {
            self.lock();
            return true;
        }
        false
    }

    pub fn auto_lock_minutes(&self) -> u32 {
        self.auto_lock_minutes
    }

    pub fn set_auto_lock_minutes(&mut self, minutes: u32) -> Result<()> {
        if minutes > MAX_AUTO_LOCK_MINUTES {
            return Err("Auto-lock must be off or between 1 and 1440 minutes.".into());
        }
        self.session()?;
        atomic_write(
            &self.path.with_extension("auto-lock"),
            minutes.to_string().as_bytes(),
            true,
        )
        .map_err(|_| "Unable to save the auto-lock setting.".to_string())?;
        self.auto_lock_minutes = minutes;
        if let Some(session) = self.session.as_mut() {
            session.last_activity = Instant::now();
        }
        Ok(())
    }

    pub fn lock(&mut self) {
        self.session = None;
    }

    fn session(&mut self) -> Result<&mut Session> {
        self.expire();
        self.session
            .as_mut()
            .ok_or_else(|| "Vault locked. Unlock it to continue.".into())
    }

    pub fn touch(&mut self) -> Result<()> {
        self.session()?.last_activity = Instant::now();
        Ok(())
    }

    pub fn create(&mut self, password: &str) -> Result<Vec<AccountCode>> {
        if self.path.exists() {
            return Err("A vault already exists. Unlock it instead.".into());
        }
        if password.chars().count() < 6 || password.len() > 1024 {
            return Err("Use a password with at least 6 characters (maximum 1024 bytes).".into());
        }
        let mut salt = [0; 16];
        OsRng.fill_bytes(&mut salt);
        let key = derive_key(password, &salt)?;
        let stronghold = Stronghold::default();
        let client = stronghold.create_client(CLIENT).map_err(|_| IO_ERROR)?;
        let session = Session {
            stronghold,
            client,
            key,
            salt,
            accounts: vec![],
            sync: None,
            last_activity: Instant::now(),
        };
        let bytes = encode(&session)?;
        // persist_noclobber ensures a simultaneous setup cannot overwrite an existing vault.
        atomic_write(&self.path, &bytes, false)?;
        self.session = Some(session);
        self.codes()
    }

    pub fn unlock(&mut self, password: &str) -> Result<Vec<AccountCode>> {
        let bytes = read_bounded(&self.path)?;
        let session = decode_password(&bytes, password)?;
        let codes = session.codes()?;
        self.session = Some(session);
        Ok(codes)
    }

    fn device_path(&self) -> PathBuf {
        self.path.with_extension("device-unlock")
    }

    fn device_record(&self) -> Result<Enrollment> {
        let file =
            File::open(self.device_path()).map_err(|_| device_unlock::INVALID.to_string())?;
        if file.metadata().map_err(|_| IO_ERROR)?.len() > 4096 {
            return Err(device_unlock::INVALID.into());
        }
        let mut bytes = Vec::new();
        file.take(4097)
            .read_to_end(&mut bytes)
            .map_err(|_| IO_ERROR)?;
        let record: Enrollment =
            serde_json::from_slice(&bytes).map_err(|_| device_unlock::INVALID.to_string())?;
        if record.version != 1 || record.id.is_nil() {
            return Err(device_unlock::INVALID.into());
        }
        Ok(record)
    }

    fn enrollment(&self) -> Result<Enrollment> {
        let record = self.device_record()?;
        if record.salt != envelope_salt(&read_bounded(&self.path)?)? {
            return Err(device_unlock::INVALID.into());
        }
        Ok(record)
    }

    pub fn device_status(&self, protector: &impl Protector) -> DeviceStatus {
        DeviceStatus {
            available: protector.available(),
            enabled: self.enrollment().is_ok(),
            label: protector.label(),
        }
    }

    pub fn enable_device(
        &mut self,
        password: &str,
        protector: &impl Protector,
    ) -> Result<DeviceStatus> {
        self.session()?;
        if !protector.available() {
            return Err(device_unlock::UNAVAILABLE.into());
        }
        // Re-entering the password proves access to the current persisted vault.
        // Do not keep the password or expose key material over IPC.
        let session = decode_password(&read_bounded(&self.path)?, password)?;
        let previous = self.device_record().ok();
        let id = uuid::Uuid::new_v4();
        let id_string = id.to_string();
        let key = session.key.try_unlock().map_err(|_| IO_ERROR)?;
        let key = key.borrow();
        let sealed = protector.seal(&id_string, &key)?;
        let result = (|| {
            // Exercise the protected read once before persisting enrollment.
            // Cancellation/failure leaves the existing enrollment and vault intact.
            let verified = protector.unseal(&id_string, &sealed)?;
            if verified.as_slice() != &*key {
                return Err(device_unlock::INVALID.into());
            }
            let record = Enrollment {
                version: 1,
                id,
                salt: session.salt,
                sealed,
            };
            let bytes = serde_json::to_vec(&record).map_err(|_| IO_ERROR)?;
            atomic_write(&self.device_path(), &bytes, true)
        })();
        if result.is_err() {
            let _ = protector.delete(&id_string);
        }
        result?;
        if let Some(previous) = previous {
            let _ = protector.delete(&previous.id.to_string());
        }
        Ok(self.device_status(protector))
    }

    pub fn unlock_device(&mut self, protector: &impl Protector) -> Result<Vec<AccountCode>> {
        if !protector.available() {
            return Err(device_unlock::UNAVAILABLE.into());
        }
        let record = self.enrollment()?;
        let bytes = read_bounded(&self.path)?;
        let key = protector.unseal(&record.id.to_string(), &record.sealed)?;
        if key.len() != 32 {
            return Err(device_unlock::INVALID.into());
        }
        let key = KeyProvider::try_from(key).map_err(|_| device_unlock::INVALID.to_string())?;
        let session = decode_key(&bytes, Arc::new(key))?;
        let codes = session.codes()?;
        self.session = Some(session);
        Ok(codes)
    }

    pub fn disable_device(&mut self, protector: &impl Protector) -> Result<DeviceStatus> {
        self.session()?;
        if self.device_path().exists() {
            // A stale record can be removed even after restoring another vault.
            if let Ok(record) = self.device_record() {
                protector.delete(&record.id.to_string())?;
            }
            fs::remove_file(self.device_path()).map_err(|_| IO_ERROR)?;
        }
        Ok(self.device_status(protector))
    }

    pub fn codes(&mut self) -> Result<Vec<AccountCode>> {
        self.session()?.codes()
    }

    pub fn account_qr(&mut self, id: &str, password: &str) -> Result<otp::AccountQr> {
        self.session()?;
        // Verify the password without unlocking/replacing the active session.
        let verified = decode_password(&read_bounded(&self.path)?, password)?;
        drop(verified);
        // A slow password check must not revive an expired session.
        let session = self.session()?;
        let account = session
            .accounts
            .iter()
            .find(|a| a.id == id)
            .ok_or_else(|| "Account not found.".to_string())?;
        if account.issuer.contains(':') || account.account.contains(':') {
            return Err(
                "Account labels containing ':' cannot be exported as a standard QR.".into(),
            );
        }
        account.qr(&session.client)
    }

    pub fn copy_value(&mut self, id: &str) -> Result<String> {
        let s = self.session()?;
        let account = s
            .accounts
            .iter()
            .find(|a| a.id == id)
            .ok_or("Account not found.")?;
        Ok(account.code(&s.client, now()?)?.code)
    }

    pub fn add(&mut self, input: &AccountInput) -> Result<Vec<AccountCode>> {
        self.session()?;
        let (account, secret) = otp::parse(input)?;
        let mut candidate = self.candidate()?;
        if candidate.accounts.len() >= MAX_ACCOUNTS {
            return Err("This vault has reached the 1000 account limit.".into());
        }
        candidate
            .client
            .vault(b"totp-secrets")
            .write_secret(account.location(), secret)
            .map_err(|_| IO_ERROR)?;
        if let Some(state) = &mut candidate.sync {
            sync::queue_put(&candidate.client, state, &account)?;
        }
        candidate.accounts.push(account);
        self.commit(candidate)
    }

    pub fn delete(&mut self, id: &str) -> Result<Vec<AccountCode>> {
        self.session()?;
        let mut candidate = self.candidate()?;
        if !candidate.accounts.iter().any(|a| a.id == id) {
            return Err("Account not found.".into());
        }
        if let Some(state) = &mut candidate.sync {
            sync::queue_delete(&candidate.client, state, id)?;
        }
        candidate
            .client
            .vault(b"totp-secrets")
            .delete_secret(id.as_bytes())
            .map_err(|_| IO_ERROR)?;
        candidate.accounts.retain(|a| a.id != id);
        self.commit(candidate)
    }

    pub fn reorder(&mut self, ids: &[String]) -> Result<Vec<AccountCode>> {
        // The complete ID permutation prevents an old filtered list from hiding
        // new accounts or accepting duplicate/unknown IDs.
        self.session()?.validate_order(ids)?;
        let mut candidate = self.candidate()?;
        candidate.validate_order(ids)?;
        candidate.preserve_order(ids);
        // Ordering is device-local metadata; it never queues secret sync records.
        self.commit(candidate)
    }

    pub fn preview_accounts(&mut self, uris: &[String]) -> Result<Preview> {
        let session = self.session()?;
        Ok(parse_accounts(uris)?.preview(&session.accounts))
    }

    pub fn import_accounts(
        &mut self,
        uris: &[String],
        selected: &[usize],
    ) -> Result<Vec<AccountCode>> {
        let session = self.session()?;
        let export = parse_accounts(uris)?;
        let preview = export.preview(&session.accounts);
        let unique: HashSet<usize> = selected.iter().copied().collect();
        if selected.is_empty()
            || unique.len() != selected.len()
            || selected.iter().any(|&index| {
                preview
                    .entries
                    .get(index)
                    .is_none_or(|entry| entry.reason.is_some())
            })
        {
            return Err("Select new supported accounts from the setup QR codes.".into());
        }
        if session.accounts.len() + selected.len() > MAX_ACCOUNTS {
            return Err("This vault has reached the 1000 account limit.".into());
        }
        let mut candidate = self.candidate()?;
        for (index, entry) in export.entries.into_iter().enumerate() {
            if !unique.contains(&index) {
                continue;
            }
            candidate
                .client
                .vault(b"totp-secrets")
                .write_secret(entry.account.location(), entry.secret)
                .map_err(|_| IO_ERROR)?;
            if let Some(state) = &mut candidate.sync {
                sync::queue_put(&candidate.client, state, &entry.account)?;
            }
            candidate.accounts.push(entry.account);
        }
        self.commit(candidate)
    }

    pub fn preview_google(&mut self, uris: &[String]) -> Result<Preview> {
        let session = self.session()?;
        Ok(migration::parse(uris)?.preview(&session.accounts))
    }

    pub fn import_google(
        &mut self,
        uris: &[String],
        selected: &[usize],
    ) -> Result<Vec<AccountCode>> {
        let session = self.session()?;
        let export = migration::parse(uris)?;
        let preview = export.preview(&session.accounts);
        if !preview.complete {
            return Err("Add all QR codes from this Google export before importing.".into());
        }
        let unique: HashSet<usize> = selected.iter().copied().collect();
        if selected.is_empty()
            || unique.len() != selected.len()
            || selected.iter().any(|&index| {
                preview
                    .entries
                    .get(index)
                    .is_none_or(|entry| entry.reason.is_some())
            })
        {
            return Err("Select new supported accounts from the Google export.".into());
        }
        if session.accounts.len() + selected.len() > MAX_ACCOUNTS {
            return Err("This vault has reached the 1000 account limit.".into());
        }
        let mut candidate = self.candidate()?;
        for (index, entry) in export.entries.into_iter().enumerate() {
            if !unique.contains(&index) {
                continue;
            }
            candidate
                .client
                .vault(b"totp-secrets")
                .write_secret(entry.account.location(), entry.secret)
                .map_err(|_| IO_ERROR)?;
            if let Some(state) = &mut candidate.sync {
                sync::queue_put(&candidate.client, state, &entry.account)?;
            }
            candidate.accounts.push(entry.account);
        }
        // One atomic write for the entire selection, with the old session kept on failure.
        self.commit(candidate)
    }

    pub fn sync_status(&mut self) -> Result<SyncStatus> {
        Ok(self
            .session()?
            .sync
            .as_ref()
            .map_or_else(SyncStatus::disconnected, sync::State::status))
    }

    pub fn sync_create(&mut self, server: &str, registration: &str) -> Result<PairingInfo> {
        if self.session()?.sync.is_some() {
            return Err(
                "Disconnect this device before configuring a different shared vault.".into(),
            );
        }
        let mut candidate = self.candidate()?;
        let mut state = sync::State::new(
            sync::validate_server(server)?,
            uuid::Uuid::new_v4().to_string(),
            false,
        );
        sync::generate_credentials(&candidate.client)?;
        for account in &candidate.accounts {
            sync::queue_put(&candidate.client, &mut state, account)?;
        }
        sync::register(&candidate.client, &state, registration)?;
        let pairing = sync::pairing(&candidate.client, &state)?;
        // Upload begins on the next sync. Any registration/local-save failure
        // preserves all original accounts and leaves this device disconnected.
        candidate.sync = Some(state);
        self.commit(candidate)?;
        Ok(pairing)
    }

    pub fn sync_pair(&mut self, bundle: &str) -> Result<Vec<AccountCode>> {
        if self.session()?.sync.is_some() {
            return Err("Disconnect this device before pairing a different shared vault.".into());
        }
        let mut candidate = self.candidate()?;
        let mut state = sync::install_bundle(&candidate.client, bundle)?;
        let order = candidate.account_ids();
        sync::synchronize(&candidate.client, &mut candidate.accounts, &mut state)?;
        candidate.preserve_order(&order);
        candidate.sync = Some(state);
        self.commit(candidate)
    }

    pub fn sync_once(&mut self) -> Result<SyncResult> {
        let session = self.session()?;
        let state = session.sync.as_mut().ok_or("Sync is not configured.")?;
        if state.outbox.is_empty()
            && !state.bootstrap
            && !sync::has_remote_changes(&session.client, state)?
        {
            return Ok(SyncResult {
                changed: false,
                status: state.status(),
            });
        }
        let mut candidate = self.candidate()?;
        let order = candidate.account_ids();
        let state = candidate.sync.as_mut().ok_or("Sync is not configured.")?;
        let changed = sync::synchronize(&candidate.client, &mut candidate.accounts, state)?;
        let status = state.status();
        candidate.preserve_order(&order);
        self.commit(candidate)?;
        Ok(SyncResult { changed, status })
    }

    pub fn sync_pairing(&mut self) -> Result<PairingInfo> {
        let session = self.session()?;
        let state = session.sync.as_ref().ok_or("Sync is not configured.")?;
        sync::pairing(&session.client, state)
    }

    pub fn sync_disconnect(&mut self) -> Result<()> {
        self.session()?;
        let mut candidate = self.candidate()?;
        if candidate.sync.take().is_some() {
            candidate
                .client
                .vault(b"sync-secrets")
                .delete_secret(b"credentials-v1")
                .map_err(|_| IO_ERROR)?;
        }
        self.commit(candidate)?;
        Ok(())
    }

    fn candidate(&mut self) -> Result<Session> {
        let bytes = read_bounded(&self.path)?;
        let session = self.session()?;
        if envelope_salt(&bytes)? != session.salt {
            return Err(BAD_BACKUP.into());
        }
        let mut candidate = decode_key(&bytes, session.key.clone())?;
        candidate.last_activity = session.last_activity;
        Ok(candidate)
    }

    fn commit(&mut self, candidate: Session) -> Result<Vec<AccountCode>> {
        let bytes = encode(&candidate)?;
        let codes = candidate.codes()?;
        // The current in-memory session and snapshot survive all failures above and here.
        atomic_write(&self.path, &bytes, true)?;
        self.session = Some(candidate);
        Ok(codes)
    }

    pub fn export(&mut self, path: &Path) -> Result<()> {
        self.session()?;
        self.validate_external_path(path)?;
        let bytes = read_bounded(&self.path)?;
        atomic_write(path, &bytes, true)
    }

    pub fn import(&mut self, path: &Path, password: &str) -> Result<Vec<AccountCode>> {
        // The UI explicitly confirms replacement. A fully validated backup and
        // its password can recover the vault even when the old password is lost.
        self.validate_external_path(path)?;
        let bytes = read_bounded(path)?;
        let candidate = decode_password(&bytes, password)?;
        let codes = candidate.codes()?;
        atomic_write(&self.path, &bytes, true)?;
        self.session = Some(candidate);
        Ok(codes)
    }

    fn validate_external_path(&self, path: &Path) -> Result<()> {
        if !path.is_absolute() || path.file_name().is_none() {
            return Err("Choose an absolute backup file path.".into());
        }
        let lock_path = self.path.with_extension("lock");
        let device_path = self.device_path();
        if [
            self.path.as_path(),
            lock_path.as_path(),
            device_path.as_path(),
        ]
        .iter()
        .any(|protected| {
            path == *protected
                || (path.exists()
                    && fs::canonicalize(path).ok() == fs::canonicalize(protected).ok())
        }) {
            return Err("Choose a backup file outside the active vault.".into());
        }
        Ok(())
    }
}

impl Session {
    fn account_ids(&self) -> Vec<String> {
        self.accounts.iter().map(|a| a.id.clone()).collect()
    }

    fn validate_order(&self, ids: &[String]) -> Result<()> {
        let unique: HashSet<&str> = ids.iter().map(String::as_str).collect();
        if ids.len() != self.accounts.len()
            || unique.len() != ids.len()
            || self
                .accounts
                .iter()
                .any(|account| !unique.contains(account.id.as_str()))
        {
            return Err(ORDER_ERROR.into());
        }
        Ok(())
    }

    fn preserve_order(&mut self, ids: &[String]) {
        let ranks: HashMap<&str, usize> = ids
            .iter()
            .enumerate()
            .map(|(rank, id)| (id.as_str(), rank))
            .collect();
        // Stable sort keeps newly synced accounts in their received order at the end.
        self.accounts.sort_by_key(|account| {
            ranks
                .get(account.id.as_str())
                .copied()
                .unwrap_or(usize::MAX)
        });
    }

    fn codes(&self) -> Result<Vec<AccountCode>> {
        let time = now()?;
        self.accounts
            .iter()
            .map(|a| a.code(&self.client, time))
            .collect()
    }
}

fn parse_accounts(uris: &[String]) -> Result<migration::Export> {
    if uris.is_empty() || uris.len() > migration::MAX_PARTS {
        return Err("Add between 1 and 100 setup QR codes before importing.".into());
    }
    let entries = uris
        .iter()
        .map(|uri| {
            let input = AccountInput {
                issuer: String::new(),
                account: String::new(),
                secret: String::new(),
                uri: uri.clone(),
                algorithm: "SHA1".into(),
                digits: 6,
                period: 30,
            };
            let (account, secret) = otp::parse(&input)?;
            Ok(migration::Entry {
                account,
                secret,
                unsupported: None,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(migration::Export {
        entries,
        parts: uris.len(),
        expected: uris.len(),
    })
}

pub(crate) fn now() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Correct your computer's date and time.")?
        .as_secs())
}

fn derive_key(password: &str, salt: &[u8; 16]) -> Result<Arc<KeyProvider>> {
    if password.len() > 1024 {
        return Err(BAD_BACKUP.into());
    }
    let params = Params::new(65536, 3, 1, Some(32)).map_err(|_| BAD_BACKUP)?;
    let mut key = Zeroizing::new(vec![0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|_| BAD_BACKUP)?;
    KeyProvider::try_from(key)
        .map(Arc::new)
        .map_err(|_| BAD_BACKUP.into())
}

fn encode(session: &Session) -> Result<Vec<u8>> {
    let metadata = serde_json::to_vec(&session.accounts).map_err(|_| IO_ERROR)?;
    session
        .client
        .store()
        .insert(METADATA.to_vec(), metadata, None)
        .map_err(|_| IO_ERROR)?;
    if let Some(state) = &session.sync {
        state.validate()?;
        session
            .client
            .store()
            .insert(
                SYNC_METADATA.to_vec(),
                serde_json::to_vec(state).map_err(|_| IO_ERROR)?,
                None,
            )
            .map_err(|_| IO_ERROR)?;
    } else {
        session
            .client
            .store()
            .delete(SYNC_METADATA)
            .map_err(|_| IO_ERROR)?;
    }
    session
        .stronghold
        .write_client(CLIENT)
        .map_err(|_| IO_ERROR)?;
    let temporary = NamedTempFile::new().map_err(|_| IO_ERROR)?;
    session
        .stronghold
        .commit_with_keyprovider(&SnapshotPath::from_path(temporary.path()), &session.key)
        .map_err(|_| IO_ERROR)?;
    let snapshot = read_bounded(temporary.path())?;
    let mut output = Vec::with_capacity(24 + snapshot.len());
    output.extend_from_slice(HEADER);
    output.extend_from_slice(&session.salt);
    output.extend_from_slice(&snapshot);
    Ok(output)
}

fn decode_password(bytes: &[u8], password: &str) -> Result<Session> {
    let salt = envelope_salt(bytes)?;
    decode_key(bytes, derive_key(password, &salt)?)
}

fn envelope_salt(bytes: &[u8]) -> Result<[u8; 16]> {
    if bytes.len() < 25 || bytes.len() as u64 > MAX_FILE || &bytes[..8] != HEADER {
        return Err(BAD_BACKUP.into());
    }
    validate_snapshot_header(&bytes[24..])?;
    bytes[8..24].try_into().map_err(|_| BAD_BACKUP.into())
}

fn validate_snapshot_header(snapshot: &[u8]) -> Result<()> {
    // Stronghold accepts work factors up to 23 (several GiB of RAM). Our v1
    // format creates factor 19; reject oversized untrusted KDF requests before
    // entering the library so a malformed import cannot exhaust the process.
    const PREFIX: &[u8] = b"PARTI\x03\x00age-encryption.org/v1\n-> scrypt ";
    let rest = snapshot.strip_prefix(PREFIX).ok_or(BAD_BACKUP)?;
    let stanza = rest.split(|b| *b == b'\n').next().ok_or(BAD_BACKUP)?;
    if stanza.len() > 25 {
        return Err(BAD_BACKUP.into());
    }
    let stanza = std::str::from_utf8(stanza).map_err(|_| BAD_BACKUP)?;
    let (salt, work_factor) = stanza.split_once(' ').ok_or(BAD_BACKUP)?;
    let work_factor: u8 = work_factor.parse().map_err(|_| BAD_BACKUP)?;
    if salt.len() != 22 || work_factor > 19 {
        return Err(BAD_BACKUP.into());
    }
    Ok(())
}

fn decode_key(bytes: &[u8], key: Arc<KeyProvider>) -> Result<Session> {
    let salt = envelope_salt(bytes)?;
    let mut temporary = NamedTempFile::new().map_err(|_| IO_ERROR)?;
    temporary.write_all(&bytes[24..]).map_err(|_| IO_ERROR)?;
    temporary.flush().map_err(|_| IO_ERROR)?;
    let stronghold = Stronghold::default();
    let client = stronghold
        .load_client_from_snapshot(CLIENT, &key, &SnapshotPath::from_path(temporary.path()))
        .map_err(|_| BAD_BACKUP)?;
    let metadata = client
        .store()
        .get(METADATA)
        .map_err(|_| BAD_BACKUP)?
        .ok_or(BAD_BACKUP)?;
    let accounts: Vec<Account> = serde_json::from_slice(&metadata).map_err(|_| BAD_BACKUP)?;
    let sync: Option<sync::State> = client
        .store()
        .get(SYNC_METADATA)
        .map_err(|_| BAD_BACKUP)?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(|_| BAD_BACKUP))
        .transpose()?;
    if let Some(state) = &sync {
        state.validate().map_err(|_| BAD_BACKUP)?;
        // Check guarded credentials exist and have the expected structure.
        sync::validate_credentials(&client).map_err(|_| BAD_BACKUP)?;
    }
    if accounts.len() > MAX_ACCOUNTS {
        return Err(BAD_BACKUP.into());
    }
    let mut ids = HashSet::new();
    for account in &accounts {
        account.validate().map_err(|_| BAD_BACKUP)?;
        if !ids.insert(&account.id) {
            return Err(BAD_BACKUP.into());
        }
        account.code(&client, 59).map_err(|_| BAD_BACKUP)?;
    }
    Ok(Session {
        stronghold,
        client,
        key,
        salt,
        accounts,
        sync,
        last_activity: Instant::now(),
    })
}

fn read_bounded(path: &Path) -> Result<Vec<u8>> {
    let file = File::open(path).map_err(|_| IO_ERROR)?;
    if file.metadata().map_err(|_| IO_ERROR)?.len() > MAX_FILE {
        return Err(BAD_BACKUP.into());
    }
    let mut output = Vec::new();
    file.take(MAX_FILE + 1)
        .read_to_end(&mut output)
        .map_err(|_| IO_ERROR)?;
    if output.len() as u64 > MAX_FILE {
        return Err(BAD_BACKUP.into());
    }
    Ok(output)
}

fn atomic_write(path: &Path, bytes: &[u8], replace: bool) -> Result<()> {
    let parent = path.parent().ok_or(IO_ERROR)?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|_| IO_ERROR)?;
    temporary.write_all(bytes).map_err(|_| IO_ERROR)?;
    temporary.as_file().sync_all().map_err(|_| IO_ERROR)?;
    if replace {
        temporary.persist(path).map_err(|_| IO_ERROR)?;
    } else {
        temporary.persist_noclobber(path).map_err(|_| IO_ERROR)?;
    }
    #[cfg(unix)]
    // Rename is already committed; an unsupported directory fsync must not report
    // a false rollback or leave the in-memory session behind the persisted file.
    let _ = File::open(parent).and_then(|dir| dir.sync_all());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const PASSWORD: &str = "test-only-password-123";

    #[test]
    fn auto_lock_preference_persists_and_controls_native_expiry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.mfa");
        let mut vault = Vault::new(path.clone()).unwrap();
        assert_eq!(vault.auto_lock_minutes(), 5);
        assert!(vault.set_auto_lock_minutes(0).is_err());
        vault.create(PASSWORD).unwrap();
        assert!(vault.set_auto_lock_minutes(1441).is_err());
        vault.set_auto_lock_minutes(12).unwrap();
        vault.session.as_mut().unwrap().last_activity = Instant::now() - IDLE_TIMEOUT;
        assert!(!vault.expire());
        vault.session.as_mut().unwrap().last_activity = Instant::now() - Duration::from_secs(720);
        assert!(vault.expire());
        vault.unlock(PASSWORD).unwrap();
        vault.set_auto_lock_minutes(0).unwrap();
        drop(vault);

        let mut reopened = Vault::new(path).unwrap();
        assert_eq!(reopened.auto_lock_minutes(), 0);
        assert!(!reopened.status().unlocked);
        reopened.unlock(PASSWORD).unwrap();
        reopened.session.as_mut().unwrap().last_activity = Instant::now() - IDLE_TIMEOUT;
        assert!(!reopened.expire());
        reopened.lock();
        assert!(!reopened.status().unlocked);
    }

    // Mock only the OS boundary. These tests use real Stronghold vaults/KDFs.
    struct TestProtector {
        available: std::cell::Cell<bool>,
        cancel: std::cell::Cell<bool>,
        secrets: std::cell::RefCell<std::collections::HashMap<String, Zeroizing<Vec<u8>>>>,
    }
    impl Default for TestProtector {
        fn default() -> Self {
            Self {
                available: std::cell::Cell::new(true),
                cancel: std::cell::Cell::new(false),
                secrets: Default::default(),
            }
        }
    }
    impl Protector for TestProtector {
        fn label(&self) -> &'static str {
            "Test device"
        }
        fn available(&self) -> bool {
            self.available.get()
        }
        fn seal(&self, id: &str, key: &[u8]) -> Result<Vec<u8>> {
            self.secrets
                .borrow_mut()
                .insert(id.into(), Zeroizing::new(key.to_vec()));
            Ok(b"opaque-test-reference".to_vec())
        }
        fn unseal(&self, id: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
            if self.cancel.get() || sealed != b"opaque-test-reference" {
                return Err(device_unlock::FAILED.into());
            }
            self.secrets
                .borrow()
                .get(id)
                .cloned()
                .ok_or(device_unlock::INVALID.into())
        }
        fn delete(&self, id: &str) -> Result<()> {
            self.secrets.borrow_mut().remove(id);
            Ok(())
        }
    }

    #[test]
    fn device_unlock_requires_password_and_successful_os_consent() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().join("vault.mfa")).unwrap();
        vault.create(PASSWORD).unwrap();
        let protector = TestProtector::default();
        let before = fs::read(&vault.path).unwrap();
        assert!(vault.enable_device("wrong password", &protector).is_err());
        assert!(protector.secrets.borrow().is_empty());
        protector.cancel.set(true);
        assert!(vault.enable_device(PASSWORD, &protector).is_err());
        assert!(!vault.device_path().exists());
        assert!(protector.secrets.borrow().is_empty());
        assert_eq!(fs::read(&vault.path).unwrap(), before);
        assert!(vault.status().unlocked);
        vault.lock();
        assert!(vault.enable_device(PASSWORD, &protector).is_err());
    }

    #[test]
    fn device_unlock_roundtrip_cancel_disable_and_password_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.mfa");
        let protector = TestProtector::default();
        let id;
        {
            let mut vault = Vault::new(path.clone()).unwrap();
            vault.create(PASSWORD).unwrap();
            id = vault.add(&input()).unwrap()[0].id.clone();
            assert!(vault.enable_device(PASSWORD, &protector).unwrap().enabled);
        }
        let mut vault = Vault::new(path).unwrap();
        protector.cancel.set(true);
        assert!(vault.unlock_device(&protector).is_err());
        assert!(!vault.status().unlocked);
        protector.cancel.set(false);
        assert_eq!(vault.unlock_device(&protector).unwrap()[0].id, id);
        vault.disable_device(&protector).unwrap();
        assert!(protector.secrets.borrow().is_empty());
        vault.lock();
        assert!(vault.unlock_device(&protector).is_err());
        assert_eq!(vault.unlock(PASSWORD).unwrap()[0].id, id);
    }

    #[test]
    fn device_unavailable_never_prevents_password_unlock() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().join("vault.mfa")).unwrap();
        let protector = TestProtector::default();
        vault.create(PASSWORD).unwrap();
        vault.enable_device(PASSWORD, &protector).unwrap();
        protector.available.set(false);
        let status = vault.device_status(&protector);
        assert!(!status.available);
        assert!(status.enabled);
        vault.lock();
        assert!(vault.unlock_device(&protector).is_err());
        vault.unlock(PASSWORD).unwrap();
        vault.disable_device(&protector).unwrap();
    }

    #[test]
    fn device_binding_rejects_another_vault_and_tampered_enrollment() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().join("vault.mfa")).unwrap();
        let protector = TestProtector::default();
        vault.create(PASSWORD).unwrap();
        vault.enable_device(PASSWORD, &protector).unwrap();
        let original = fs::read(vault.device_path()).unwrap();
        let mut record: Enrollment = serde_json::from_slice(&original).unwrap();
        record.sealed[0] ^= 1;
        fs::write(vault.device_path(), serde_json::to_vec(&record).unwrap()).unwrap();
        vault.lock();
        assert!(vault.unlock_device(&protector).is_err());
        assert!(!vault.status().unlocked);
        fs::write(vault.device_path(), original).unwrap();
        let mut other = Vault::new(dir.path().join("other.mfa")).unwrap();
        other.create("another-test-password-123").unwrap();
        let backup = dir.path().join("other.mfa-backup");
        other.export(&backup).unwrap();
        vault.import(&backup, "another-test-password-123").unwrap();
        assert!(!vault.device_status(&protector).enabled);
        vault.lock();
        assert!(vault.unlock_device(&protector).is_err());
        vault.unlock("another-test-password-123").unwrap();
        vault.disable_device(&protector).unwrap();
        assert!(protector.secrets.borrow().is_empty());
    }

    #[test]
    fn device_enrollment_is_not_exported_and_cannot_be_overwritten_by_backup() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().join("vault.mfa")).unwrap();
        let protector = TestProtector::default();
        vault.create(PASSWORD).unwrap();
        vault.enable_device(PASSWORD, &protector).unwrap();
        let device_path = vault.device_path();
        assert!(vault.export(&device_path).is_err());
        let backup = dir.path().join("vault.mfa-backup");
        vault.export(&backup).unwrap();
        assert_eq!(fs::read(backup).unwrap(), fs::read(&vault.path).unwrap());
        vault.enable_device(PASSWORD, &protector).unwrap();
        assert_eq!(protector.secrets.borrow().len(), 1);
    }

    fn input() -> AccountInput {
        AccountInput {
            issuer: "Example".into(),
            account: "test@example.invalid".into(),
            secret: "JBSWY3DPEHPK3PXP".into(),
            uri: "".into(),
            algorithm: "SHA1".into(),
            digits: 6,
            period: 30,
        }
    }

    #[test]
    fn short_pin_survives_restart_and_backup_restore() {
        let dir = tempfile::tempdir().unwrap();
        for password in ["483927", "aB7x9p2Q"] {
            let path = dir.path().join(format!("{password}.mfa"));
            let backup = dir.path().join(format!("{password}.mfa-backup"));
            let id = {
                let mut vault = Vault::new(path.clone()).unwrap();
                assert!(vault.create("48392").is_err());
                assert!(!path.exists());
                assert!(vault.create(&"x".repeat(1025)).is_err());
                assert!(!path.exists());
                vault.create(password).unwrap();
                let id = vault.add(&input()).unwrap()[0].id.clone();
                vault.export(&backup).unwrap();
                id
            };
            let mut reopened = Vault::new(path.clone()).unwrap();
            let original = fs::read(&path).unwrap();
            assert!(reopened.unlock("483928").is_err());
            assert!(!reopened.status().unlocked);
            assert_eq!(fs::read(&path).unwrap(), original);
            assert_eq!(reopened.unlock(password).unwrap()[0].id, id);
            reopened.lock();
            assert_eq!(reopened.import(&backup, password).unwrap()[0].id, id);
        }
    }

    #[test]
    fn reordered_accounts_persist_without_changing_codes_or_sync_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.mfa");
        let expected;
        let original_codes;
        {
            let mut vault = Vault::new(path.clone()).unwrap();
            vault.create(PASSWORD).unwrap();
            configure_test_sync(&mut vault, "http://127.0.0.1:1".into());
            for name in ["one", "two", "three"] {
                let mut entry = input();
                entry.account = name.into();
                vault.add(&entry).unwrap();
            }
            let session = vault.session.as_ref().unwrap();
            original_codes = session
                .accounts
                .iter()
                .map(|a| (a.id.clone(), a.code(&session.client, 59).unwrap().code))
                .collect::<HashMap<_, _>>();
            let sync_before = serde_json::to_value(&session.sync).unwrap();
            expected = session.account_ids().into_iter().rev().collect::<Vec<_>>();
            let codes = vault.reorder(&expected).unwrap();
            assert_eq!(
                codes.iter().map(|a| a.id.clone()).collect::<Vec<_>>(),
                expected
            );
            assert_eq!(
                serde_json::to_value(&vault.session.as_ref().unwrap().sync).unwrap(),
                sync_before
            );
        }
        let mut vault = Vault::new(path).unwrap();
        let codes = vault.unlock(PASSWORD).unwrap();
        assert_eq!(
            codes.iter().map(|a| a.id.clone()).collect::<Vec<_>>(),
            expected
        );
        let session = vault.session.as_ref().unwrap();
        for account in &session.accounts {
            assert_eq!(
                account.code(&session.client, 59).unwrap().code,
                original_codes[&account.id]
            );
        }
        let mut entry = input();
        entry.account = "newly added".into();
        let codes = vault.add(&entry).unwrap();
        assert_eq!(
            codes[..3].iter().map(|a| a.id.clone()).collect::<Vec<_>>(),
            expected
        );
        assert_eq!(codes.last().unwrap().account, "newly added");
    }

    #[test]
    fn reorder_rejects_missing_duplicate_unknown_and_stale_ids_without_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().join("vault.mfa")).unwrap();
        vault.create(PASSWORD).unwrap();
        vault.add(&input()).unwrap();
        vault.add(&input()).unwrap();
        let ids = vault.session.as_ref().unwrap().account_ids();
        let before = fs::read(&vault.path).unwrap();
        for invalid in [
            vec![],
            vec![ids[0].clone()],
            vec![ids[0].clone(), ids[0].clone()],
            vec![ids[0].clone(), uuid::Uuid::new_v4().to_string()],
        ] {
            assert_eq!(vault.reorder(&invalid).err().unwrap(), ORDER_ERROR);
            assert_eq!(vault.session.as_ref().unwrap().account_ids(), ids);
            assert_eq!(fs::read(&vault.path).unwrap(), before);
        }
        vault.add(&input()).unwrap();
        let before = fs::read(&vault.path).unwrap();
        assert!(vault.reorder(&ids).is_err());
        assert_eq!(fs::read(&vault.path).unwrap(), before);
        vault.lock();
        assert_eq!(
            vault.reorder(&ids).err().unwrap(),
            "Vault locked. Unlock it to continue."
        );
        assert_eq!(fs::read(&vault.path).unwrap(), before);
    }

    #[test]
    fn standard_qr_batch_previews_duplicates_and_imports_selected_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().join("vault.mfa")).unwrap();
        vault.create(PASSWORD).unwrap();
        let one = "otpauth://totp/Example:one?secret=JBSWY3DPEHPK3PXP&issuer=Example".to_string();
        let two =
            "otpauth://totp/Example:two?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=8&period=60"
                .to_string();
        let uris = vec![one.clone(), two.clone(), one.clone()];
        let preview = vault.preview_accounts(&uris).unwrap();
        assert!(preview.complete);
        assert_eq!(preview.entries[2].reason, Some("duplicate"));
        let before = fs::read(&vault.path).unwrap();
        assert!(vault.import_accounts(&uris, &[0, 2]).is_err());
        assert!(vault.import_accounts(&uris, &[0, 0]).is_err());
        assert!(vault
            .import_accounts(&[one.clone(), "invalid".into()], &[0])
            .is_err());
        assert!(vault.import_accounts(&uris, &[9]).is_err());
        assert!(vault.import_accounts(&uris, &[]).is_err());
        assert_eq!(fs::read(&vault.path).unwrap(), before);
        let codes = vault.import_accounts(&uris, &[0, 1]).unwrap();
        assert_eq!(codes.len(), 2);
        assert_eq!((codes[1].digits, codes[1].period), (8, 60));
        let ids = codes.iter().map(|a| a.id.clone()).collect::<Vec<_>>();
        assert!(vault.preview_accounts(&[one]).unwrap().entries[0]
            .reason
            .is_some());
        vault.lock();
        assert!(vault.preview_accounts(&uris).is_err());
        assert!(vault.import_accounts(&uris, &[0]).is_err());
        assert_eq!(
            vault
                .unlock(PASSWORD)
                .unwrap()
                .iter()
                .map(|a| a.id.clone())
                .collect::<Vec<_>>(),
            ids
        );
    }

    #[test]
    fn account_qr_requires_fresh_password_and_unlocked_session_without_mutations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.mfa");
        let mut vault = Vault::new(path.clone()).unwrap();
        vault.create(PASSWORD).unwrap();
        let id = vault.add(&input()).unwrap()[0].id.clone();
        let snapshot = fs::read(&path).unwrap();
        assert!(vault.account_qr(&id, "wrong").is_err());
        assert!(vault.status().unlocked);
        assert_eq!(
            vault.account_qr("missing", PASSWORD).err().unwrap(),
            "Account not found."
        );
        let qr = vault.account_qr(&id, PASSWORD).unwrap();
        assert!(qr.image.starts_with("data:image/svg+xml;base64,"));
        assert!(!qr.custom_parameters);
        assert_eq!(fs::read(&path).unwrap(), snapshot);
        vault.lock();
        assert!(vault.account_qr(&id, PASSWORD).is_err());
        assert!(!vault.status().unlocked);
        vault.unlock(PASSWORD).unwrap();
        vault.session.as_mut().unwrap().last_activity = Instant::now() - IDLE_TIMEOUT;
        assert!(vault.account_qr(&id, PASSWORD).is_err());
        assert!(!vault.status().unlocked);
    }

    #[test]
    fn round_trip_wrong_password_and_tamper_preserve_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.mfa");
        let mut v = Vault::new(path.clone()).unwrap();
        assert!(v.create("short").is_err());
        assert!(!path.exists());
        assert!(v.create(PASSWORD).unwrap().is_empty());
        let accounts = v.add(&input()).unwrap();
        assert_eq!(accounts.len(), 1);
        let original = fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&original).contains("JBSWY3DPEHPK3PXP"));
        v.lock();
        assert!(v.codes().is_err());
        assert!(v.unlock("wrong password").is_err());
        assert!(!v.status().unlocked);
        assert_eq!(original, fs::read(&path).unwrap());
        let mut excessive_kdf = original.clone();
        let marker = excessive_kdf
            .windows(4)
            .position(|w| w == b" 10\n")
            .unwrap();
        excessive_kdf[marker + 1..marker + 3].copy_from_slice(b"23");
        assert!(decode_password(&excessive_kdf, PASSWORD).is_err());
        assert_eq!(v.unlock(PASSWORD).unwrap()[0].id, accounts[0].id);
        let mut tampered = original.clone();
        let end = tampered.len() - 1;
        tampered[end] ^= 1;
        let backup = dir.path().join("bad.mfa");
        fs::write(&backup, tampered).unwrap();
        assert!(v.import(&backup, PASSWORD).is_err());
        assert_eq!(v.codes().unwrap().len(), 1);
        assert_eq!(original, fs::read(&path).unwrap());
    }

    #[test]
    fn backup_replaces_only_after_validation_and_delete_persists() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::new(dir.path().join("vault.mfa")).unwrap();
        v.create(PASSWORD).unwrap();
        let id = v.add(&input()).unwrap()[0].id.clone();
        let backup = dir.path().join("backup.mfa");
        v.export(&backup).unwrap();
        assert!(v.export(&v.path.clone()).is_err());
        assert!(v.export(&v.path.with_extension("lock")).is_err());
        assert!(v.delete(&id).unwrap().is_empty());
        let before = fs::read(&v.path).unwrap();
        assert!(v.import(&backup, "wrong-password").is_err());
        assert_eq!(fs::read(&v.path).unwrap(), before);
        assert_eq!(v.import(&backup, PASSWORD).unwrap().len(), 1);
        v.lock();
        assert_eq!(v.import(&backup, PASSWORD).unwrap().len(), 1);
        v.lock();
        assert_eq!(v.unlock(PASSWORD).unwrap()[0].id, id);
        assert!(v.create(PASSWORD).is_err());
    }

    #[test]
    fn polling_does_not_renew_activity_and_expired_touch_cannot_unlock() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::new(dir.path().join("vault.mfa")).unwrap();
        v.create(PASSWORD).unwrap();
        let previous = Instant::now() - Duration::from_secs(299);
        v.session.as_mut().unwrap().last_activity = previous;
        v.codes().unwrap();
        assert_eq!(v.session.as_ref().unwrap().last_activity, previous);
        v.session.as_mut().unwrap().last_activity = Instant::now() - IDLE_TIMEOUT;
        assert!(v.touch().is_err());
        assert!(!v.status().unlocked);
    }

    #[test]
    fn version_two_google_import_generates_expected_codes_after_reopening() {
        use crate::migration::tests::fixture_version;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-v2.mfa");
        let mut v = Vault::new(path.clone()).unwrap();
        v.create(PASSWORD).unwrap();
        let uris = [
            fixture_version(&["first@example.invalid"], 2, 0, 901, 2, 2),
            fixture_version(&["second@example.invalid"], 2, 1, 901, 2, 2),
        ];
        assert!(v.import_google(&uris[..1], &[0]).is_err());
        assert!(v.codes().unwrap().is_empty());
        assert_eq!(v.import_google(&uris, &[0, 1]).unwrap().len(), 2);
        v.lock();
        drop(v);
        let mut reopened = Vault::new(path).unwrap();
        assert_eq!(reopened.unlock(PASSWORD).unwrap().len(), 2);
        let session = reopened.session.as_ref().unwrap();
        for account in &session.accounts {
            // The fixture key is the RFC 6238 SHA1 key at timestamp 59.
            assert_eq!(account.code(&session.client, 59).unwrap().code, "287082");
        }
    }

    #[test]
    fn google_import_is_selected_additive_persistent_and_rejects_invalid_selection() {
        use crate::migration::tests::fixture;
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::new(dir.path().join("vault.mfa")).unwrap();
        let a = fixture(&["alice@example.invalid"], 2, 0, 55, 2);
        let b = fixture(
            &["bob@example.invalid", "carol@example.invalid"],
            2,
            1,
            55,
            2,
        );
        assert!(v.preview_google(std::slice::from_ref(&a)).is_err());
        v.create(PASSWORD).unwrap();
        let old_id = v.add(&input()).unwrap()[0].id.clone();
        let before = fs::read(&v.path).unwrap();
        assert!(!v.preview_google(std::slice::from_ref(&a)).unwrap().complete);
        assert!(v.import_google(std::slice::from_ref(&a), &[0]).is_err());
        let uris = vec![a, b];
        for selection in [vec![], vec![0, 0], vec![0, 999]] {
            assert!(v.import_google(&uris, &selection).is_err());
            assert_eq!(fs::read(&v.path).unwrap(), before);
        }
        let accounts = v.import_google(&uris, &[0, 2]).unwrap();
        assert_eq!(accounts.len(), 3);
        assert_eq!(accounts[0].id, old_id);
        assert_eq!(accounts[1].account, "alice@example.invalid");
        assert_eq!(accounts[2].account, "carol@example.invalid");
        assert_eq!(
            v.preview_google(&uris).unwrap().entries[0].reason,
            Some("duplicate")
        );
        let saved = fs::read(&v.path).unwrap();
        assert!(v.import_google(&uris, &[0, 1]).is_err());
        assert_eq!(fs::read(&v.path).unwrap(), saved);
        let hotp = vec![fixture(&["counter"], 1, 0, 56, 1)];
        assert!(v.import_google(&hotp, &[0]).is_err());
        assert_eq!(fs::read(&v.path).unwrap(), saved);
        v.lock();
        assert!(v.import_google(&uris, &[1]).is_err());
        assert_eq!(v.unlock(PASSWORD).unwrap().len(), 3);
        let bytes = String::from_utf8_lossy(&saved);
        assert!(!bytes.contains("alice@example.invalid"));
        assert!(!bytes.contains("12345678901234567890"));
    }

    #[test]
    fn second_vault_handle_cannot_write_until_first_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.mfa");
        let first = Vault::new(path.clone()).unwrap();
        assert!(Vault::new(path.clone()).is_err());
        drop(first);
        assert!(Vault::new(path).is_ok());
    }

    #[test]
    fn failed_write_keeps_original_session_and_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::new(dir.path().join("vault.mfa")).unwrap();
        v.create(PASSWORD).unwrap();
        let original = fs::read(&v.path).unwrap();
        let (a, secret) = otp::parse(&input()).unwrap();
        let mut candidate = v.candidate().unwrap();
        candidate
            .client
            .vault(b"totp-secrets")
            .write_secret(a.location(), secret)
            .unwrap();
        candidate.accounts.push(a);
        let original_path = v.path.clone();
        v.path = dir.path().join("missing-parent").join("vault.mfa");
        assert!(v.commit(candidate).is_err());
        assert!(v.codes().unwrap().is_empty());
        assert_eq!(fs::read(original_path).unwrap(), original);
    }

    fn configure_test_sync(vault: &mut Vault, server: String) {
        let mut candidate = vault.candidate().unwrap();
        sync::generate_credentials(&candidate.client).unwrap();
        candidate.sync = Some(sync::State::new(
            server,
            uuid::Uuid::new_v4().to_string(),
            false,
        ));
        vault.commit(candidate).unwrap();
    }

    fn serve_test_pages(pages: Vec<serde_json::Value>) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            for page in pages {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = vec![];
                loop {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    if request.ends_with(b"\r\n\r\n") {
                        break;
                    }
                    assert!(request.len() < 8192);
                }
                let body = serde_json::to_vec(&page).unwrap();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                socket.write_all(&body).unwrap();
            }
        });
        (server, worker)
    }

    #[test]
    fn empty_sync_poll_never_rewrites_snapshot_or_renews_idle_timer() {
        let (server, worker) = serve_test_pages(vec![
            serde_json::json!({"records": [], "cursor": 0, "hasMore": false, "latest": 0}),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().join("vault.mfa")).unwrap();
        vault.create(PASSWORD).unwrap();
        configure_test_sync(&mut vault, server);
        let original = fs::read(&vault.path).unwrap();
        let activity = vault.session.as_ref().unwrap().last_activity;
        let result = vault.sync_once().unwrap();
        assert!(!result.changed && result.status.last_sync.is_some());
        assert_eq!(fs::read(&vault.path).unwrap(), original);
        assert_eq!(vault.session.as_ref().unwrap().last_activity, activity);
        worker.join().unwrap();
    }

    #[test]
    fn sync_updates_keep_local_order_and_append_new_accounts() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().join("vault.mfa")).unwrap();
        vault.create(PASSWORD).unwrap();
        for name in ["first", "second", "third"] {
            let mut entry = input();
            entry.account = name.into();
            vault.add(&entry).unwrap();
        }
        let order = vault
            .session
            .as_ref()
            .unwrap()
            .account_ids()
            .into_iter()
            .rev()
            .collect::<Vec<_>>();
        vault.reorder(&order).unwrap();
        configure_test_sync(&mut vault, "http://127.0.0.1:1".into());
        let session = vault.session.as_ref().unwrap();
        let bundle = sync::pairing(&session.client, session.sync.as_ref().unwrap()).unwrap();
        let peer_hold = Stronghold::default();
        let peer = peer_hold.create_client(b"order-peer").unwrap();
        let mut peer_state = sync::install_bundle(&peer, &bundle.uri).unwrap();
        let mut updated = session.accounts[0].clone();
        updated.issuer = "Updated remotely".into();
        let (_, secret) = otp::parse(&input()).unwrap();
        peer.vault(b"totp-secrets")
            .write_secret(updated.location(), secret)
            .unwrap();
        sync::queue_put(&peer, &mut peer_state, &updated).unwrap();
        let mut added_input = input();
        added_input.account = "remote new account".into();
        let (added, secret) = otp::parse(&added_input).unwrap();
        peer.vault(b"totp-secrets")
            .write_secret(added.location(), secret)
            .unwrap();
        sync::queue_put(&peer, &mut peer_state, &added).unwrap();
        let records = peer_state
            .outbox
            .iter()
            .enumerate()
            .map(|(index, record)| {
                serde_json::json!({"sequence": index + 1, "id": record.id, "nonce": record.nonce,
                "ciphertext": record.ciphertext})
            })
            .collect::<Vec<_>>();
        let page =
            serde_json::json!({"records": records, "cursor": 2, "hasMore": false, "latest": 2});
        let (server, worker) = serve_test_pages(vec![page.clone(), page]);
        let mut candidate = vault.candidate().unwrap();
        candidate.sync.as_mut().unwrap().server = server;
        vault.commit(candidate).unwrap();
        assert!(vault.sync_once().unwrap().changed);
        let codes = vault.codes().unwrap();
        assert_eq!(
            codes[..3].iter().map(|a| a.id.clone()).collect::<Vec<_>>(),
            order
        );
        assert_eq!(codes[0].issuer, "Updated remotely");
        assert_eq!(codes[3].id, added.id);
        vault.lock();
        assert_eq!(
            vault
                .unlock(PASSWORD)
                .unwrap()
                .iter()
                .map(|a| a.id.clone())
                .collect::<Vec<_>>(),
            order.into_iter().chain([added.id]).collect::<Vec<_>>()
        );
        worker.join().unwrap();
    }

    #[test]
    fn damaged_relay_ciphertext_preserves_snapshot_cursor_and_pending_records() {
        let page = serde_json::json!({"records": [{"sequence": 1, "id": uuid::Uuid::new_v4().to_string(),
            "nonce": data_encoding::BASE64.encode(&[0;12]), "ciphertext": data_encoding::BASE64.encode(&[0;16])}],
            "cursor": 1, "hasMore": false, "latest": 1});
        // The read-only probe sees a record; only the disposable candidate decrypts it.
        let (server, worker) = serve_test_pages(vec![page.clone(), page]);
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().join("vault.mfa")).unwrap();
        vault.create(PASSWORD).unwrap();
        vault.add(&input()).unwrap();
        configure_test_sync(&mut vault, server);
        let original = fs::read(&vault.path).unwrap();
        assert!(vault.sync_once().is_err());
        assert_eq!(fs::read(&vault.path).unwrap(), original);
        assert_eq!(
            vault
                .session
                .as_ref()
                .unwrap()
                .sync
                .as_ref()
                .unwrap()
                .cursor,
            0
        );
        assert_eq!(vault.sync_status().unwrap().pending, 0);
        assert_eq!(vault.codes().unwrap().len(), 1);
        worker.join().unwrap();
    }

    #[test]
    fn offline_mutations_persist_with_exact_outbox_and_disconnect_preserves_accounts() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().join("vault.mfa")).unwrap();
        vault.create(PASSWORD).unwrap();
        configure_test_sync(&mut vault, "http://127.0.0.1:1".into());
        let id = vault.add(&input()).unwrap()[0].id.clone();
        assert_eq!(vault.sync_status().unwrap().pending, 1);
        let before = fs::read(&vault.path).unwrap();
        assert!(vault.sync_once().is_err());
        assert_eq!(fs::read(&vault.path).unwrap(), before);
        let record_id = vault
            .session
            .as_ref()
            .unwrap()
            .sync
            .as_ref()
            .unwrap()
            .outbox[0]
            .id
            .clone();
        vault.lock();
        vault.unlock(PASSWORD).unwrap();
        assert_eq!(
            vault
                .session
                .as_ref()
                .unwrap()
                .sync
                .as_ref()
                .unwrap()
                .outbox[0]
                .id,
            record_id
        );
        vault.delete(&id).unwrap();
        assert_eq!(vault.sync_status().unwrap().pending, 2);
        vault.add(&input()).unwrap();
        vault.sync_disconnect().unwrap();
        assert!(!vault.sync_status().unwrap().configured);
        assert_eq!(vault.codes().unwrap().len(), 1);
        vault.lock();
        assert_eq!(vault.unlock(PASSWORD).unwrap().len(), 1);
        assert!(!vault.sync_status().unwrap().configured);
    }

    #[test]
    fn unknown_upload_outcome_retries_identical_records_and_keeps_snapshot_until_success() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let mut uploaded: Option<serde_json::Value> = None;
            for attempt in 0..4 {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = vec![];
                let header_end = loop {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    if request.ends_with(b"\r\n\r\n") {
                        break request.len();
                    }
                    assert!(request.len() < 8192);
                };
                let headers = String::from_utf8_lossy(&request).to_string();
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                request.resize(header_end + length, 0);
                socket.read_exact(&mut request[header_end..]).unwrap();
                let body = if attempt == 0 {
                    serde_json::json!({"records": [], "cursor": 0, "hasMore": false, "latest": 0})
                } else if attempt == 1 {
                    uploaded = Some(serde_json::from_slice(&request[header_end..]).unwrap());
                    // The relay accepted this immutable record but the response was lost.
                    continue;
                } else if attempt == 2 {
                    let mut record = uploaded.as_ref().unwrap()["records"][0].clone();
                    record["sequence"] = 1.into();
                    serde_json::json!({"records": [record], "cursor": 1, "hasMore": false, "latest": 1})
                } else {
                    let retried: serde_json::Value =
                        serde_json::from_slice(&request[header_end..]).unwrap();
                    assert_eq!(retried, *uploaded.as_ref().unwrap());
                    serde_json::json!({"accepted": 1, "latest": 1})
                };
                let body = serde_json::to_vec(&body).unwrap();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                socket.write_all(&body).unwrap();
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().join("vault.mfa")).unwrap();
        vault.create(PASSWORD).unwrap();
        configure_test_sync(&mut vault, format!("http://{address}"));
        vault.add(&input()).unwrap();
        let original = fs::read(&vault.path).unwrap();
        assert!(vault.sync_once().is_err());
        assert_eq!(fs::read(&vault.path).unwrap(), original);
        assert_eq!(
            vault
                .session
                .as_ref()
                .unwrap()
                .sync
                .as_ref()
                .unwrap()
                .cursor,
            0
        );
        assert_eq!(vault.sync_status().unwrap().pending, 1);
        assert!(!vault.sync_once().unwrap().changed);
        assert_eq!(vault.sync_status().unwrap().pending, 0);
        assert_eq!(
            vault
                .session
                .as_ref()
                .unwrap()
                .sync
                .as_ref()
                .unwrap()
                .cursor,
            1
        );
        worker.join().unwrap();
    }

    #[test]
    #[ignore = "Requires an isolated relay via MFA_TEST_SYNC_URL and MFA_TEST_SYNC_REGISTRATION"]
    fn two_independent_vaults_sync_via_relay_and_preserve_offline_deletions() {
        let server = std::env::var("MFA_TEST_SYNC_URL").expect("isolated relay URL");
        let registration = Zeroizing::new(
            std::env::var("MFA_TEST_SYNC_REGISTRATION").expect("isolated relay registration"),
        );
        let dir = tempfile::tempdir().unwrap();
        let mut first = Vault::new(dir.path().join("first.mfa")).unwrap();
        let mut second = Vault::new(dir.path().join("second.mfa")).unwrap();
        first.create(PASSWORD).unwrap();
        second.create(PASSWORD).unwrap();
        let first_id = first.add(&input()).unwrap()[0].id.clone();
        let bundle = first.sync_create(&server, &registration).unwrap();
        first.sync_once().unwrap();
        let mut local = input();
        local.account = "second-local@example.invalid".into();
        second.add(&local).unwrap();
        assert_eq!(second.sync_pair(&bundle.uri).unwrap().len(), 2);
        first.sync_once().unwrap();
        assert_eq!(first.codes().unwrap().len(), 2);
        for account in first.session.as_ref().unwrap().accounts.iter() {
            let peer = second
                .session
                .as_ref()
                .unwrap()
                .accounts
                .iter()
                .find(|a| a.id == account.id)
                .unwrap();
            assert_eq!(
                account
                    .code(&first.session.as_ref().unwrap().client, 59)
                    .unwrap()
                    .code,
                peer.code(&second.session.as_ref().unwrap().client, 59)
                    .unwrap()
                    .code
            );
        }
        // Offline changes are native local commits; no network happens in add/delete.
        let mut offline = input();
        offline.account = "offline@example.invalid".into();
        let codes = first.add(&offline).unwrap();
        let offline_id = codes
            .iter()
            .find(|a| a.account == offline.account)
            .unwrap()
            .id
            .clone();
        first.delete(&offline_id).unwrap();
        second.delete(&first_id).unwrap();
        assert_eq!(first.sync_status().unwrap().pending, 2);
        first.sync_once().unwrap();
        second.sync_once().unwrap();
        first.sync_once().unwrap();
        assert_eq!(first.codes().unwrap().len(), 1);
        assert_eq!(second.codes().unwrap().len(), 1);
        first.lock();
        second.lock();
        assert_eq!(first.unlock(PASSWORD).unwrap().len(), 1);
        assert_eq!(second.unlock(PASSWORD).unwrap().len(), 1);
        first.sync_once().unwrap();
        second.sync_once().unwrap();
        assert_eq!(first.codes().unwrap()[0].id, second.codes().unwrap()[0].id);
        assert_eq!(
            first.codes().unwrap()[0].account,
            "second-local@example.invalid"
        );
    }

    #[test]
    #[ignore = "Requires an isolated relay via MFA_TEST_SYNC_URL and MFA_TEST_SYNC_REGISTRATION"]
    fn google_import_before_and_after_pairing_syncs_and_survives_restart() {
        use crate::migration::tests::fixture;
        let server = std::env::var("MFA_TEST_SYNC_URL").expect("isolated relay URL");
        let registration = Zeroizing::new(
            std::env::var("MFA_TEST_SYNC_REGISTRATION").expect("isolated relay registration"),
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-first.mfa");
        let mut first = Vault::new(path.clone()).unwrap();
        let mut second = Vault::new(dir.path().join("google-peer.mfa")).unwrap();
        first.create(PASSWORD).unwrap();
        second.create(PASSWORD).unwrap();
        let uris = [
            fixture(&["alice@example.invalid"], 2, 0, 701, 2),
            fixture(&["bob@example.invalid"], 2, 1, 701, 2),
        ];
        assert!(first.import_google(&uris[..1], &[0]).is_err());
        assert!(first.codes().unwrap().is_empty());
        assert_eq!(first.import_google(&uris, &[0, 1]).unwrap().len(), 2);
        let pairing = first.sync_create(&server, &registration).unwrap();
        assert_eq!(first.sync_status().unwrap().pending, 2);
        first.sync_once().unwrap();
        assert_eq!(second.sync_pair(&pairing.uri).unwrap().len(), 2);

        // Import after setup queues locally without requiring a network request.
        let more = [fixture(&["charlie@example.invalid"], 1, 0, 702, 2)];
        assert_eq!(first.import_google(&more, &[0]).unwrap().len(), 3);
        assert_eq!(first.sync_status().unwrap().pending, 1);
        first.lock();
        drop(first);
        let mut first = Vault::new(path).unwrap();
        assert_eq!(first.unlock(PASSWORD).unwrap().len(), 3);
        assert_eq!(first.sync_status().unwrap().pending, 1);
        first.sync_once().unwrap();
        second.sync_once().unwrap();
        assert_eq!(second.codes().unwrap().len(), 3);
        assert_eq!(first.sync_status().unwrap().pending, 0);
        for account in &first.session.as_ref().unwrap().accounts {
            let peer = second
                .session
                .as_ref()
                .unwrap()
                .accounts
                .iter()
                .find(|peer| peer.id == account.id)
                .unwrap();
            let code = account
                .code(&first.session.as_ref().unwrap().client, 59)
                .unwrap()
                .code;
            assert_eq!(code, "287082"); // RFC 6238 SHA1 vector used by the export fixture.
            assert_eq!(
                code,
                peer.code(&second.session.as_ref().unwrap().client, 59)
                    .unwrap()
                    .code
            );
        }
        assert!(first
            .preview_google(&uris)
            .unwrap()
            .entries
            .iter()
            .all(|entry| entry.reason == Some("duplicate")));
        assert!(first.import_google(&uris, &[0, 1]).is_err());
        assert_eq!(first.codes().unwrap().len(), 3);
    }

    #[test]
    #[ignore = "Runs real production snapshot work factor; execute separately with --ignored --test-threads=1"]
    fn production_empty_vault_reopens_with_exact_password_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.mfa");
        let password = "Synthetic-รหัสผ่าน-2026";
        {
            let mut vault = Vault::new(path.clone()).unwrap();
            iota_stronghold::engine::snapshot::try_set_encrypt_work_factor(19).unwrap();
            assert!(vault.create(password).unwrap().is_empty());
            vault.lock();
            assert!(vault.unlock(password).unwrap().is_empty());
        }
        let mut vault = Vault::new(path.clone()).unwrap();
        let original = fs::read(&path).unwrap();
        assert!(vault.unlock("Synthetic-รหัสผ่าน-2027").is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(vault.unlock(password).unwrap().is_empty());
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    #[ignore = "Runs real production snapshot work factor; execute separately with --ignored --test-threads=1"]
    fn production_strength_snapshot_timing() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::new(dir.path().join("vault.mfa")).unwrap();
        iota_stronghold::engine::snapshot::try_set_encrypt_work_factor(19).unwrap();
        let start = Instant::now();
        v.create(PASSWORD).unwrap();
        eprintln!("Production-strength create: {:?}", start.elapsed());
        let start = Instant::now();
        v.add(&input()).unwrap();
        eprintln!("Production-strength add: {:?}", start.elapsed());
        v.lock();
        let start = Instant::now();
        assert_eq!(v.unlock(PASSWORD).unwrap().len(), 1);
        eprintln!("Production-strength unlock: {:?}", start.elapsed());
    }
}
