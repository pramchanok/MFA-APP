//! Opaque immutable operations. Only ciphertext leaves the native vault boundary.
use crate::otp::{Account, AccountInput, Result};
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use data_encoding::{BASE32_NOPAD, BASE64, BASE64URL_NOPAD};
use iota_stronghold::{
    procedures::{Procedure, ProcedureError, ProcedureOutput, Runner},
    Client, Location,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    time::{Duration, Instant},
};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const BAD: &str = "Invalid or damaged encrypted sync data. The local vault was not changed.";
const NETWORK: &str = "Sync is unavailable. Your accounts remain available offline.";
const MAX_BODY: u64 = 1024 * 1024;
const MAX_PENDING: usize = 5000;
const MAX_RANKS: usize = 20000;
const CREDENTIALS: &[u8] = b"credentials-v1";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub configured: bool,
    pub server: Option<String>,
    pub vault_id: Option<String>,
    pub pending: usize,
    pub last_sync: Option<u64>,
}

impl SyncStatus {
    pub fn disconnected() -> Self {
        Self {
            configured: false,
            server: None,
            vault_id: None,
            pending: 0,
            last_sync: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub uri: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub changed: bool,
    pub status: SyncStatus,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rank {
    clock: u64,
    device_id: String,
    record_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub id: String,
    pub nonce: String,
    pub ciphertext: String,
}

impl Record {
    fn validate(&self) -> Result<()> {
        canonical_uuid(&self.id)?;
        if self.nonce.len() != 16 || self.ciphertext.len() > 87384 || self.ciphertext.len() < 24 {
            return Err(BAD.into());
        }
        let ciphertext_len = BASE64
            .decode(self.ciphertext.as_bytes())
            .map_err(|_| BAD)?
            .len();
        if BASE64.decode(self.nonce.as_bytes()).map_err(|_| BAD)?.len() != 12
            || !(16..=65536).contains(&ciphertext_len)
        {
            return Err(BAD.into());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub server: String,
    pub vault_id: String,
    pub device_id: String,
    pub cursor: u64,
    pub high_watermark: u64,
    pub clock: u64,
    pub ranks: HashMap<String, Rank>,
    pub outbox: Vec<Record>,
    pub last_sync: Option<u64>,
    // Pairing an existing local vault retains its accounts until initial pull finishes.
    pub bootstrap: bool,
}

impl State {
    pub fn new(server: String, vault_id: String, bootstrap: bool) -> Self {
        Self {
            server,
            vault_id,
            device_id: Uuid::new_v4().to_string(),
            cursor: 0,
            high_watermark: 0,
            clock: 0,
            ranks: HashMap::new(),
            outbox: Vec::new(),
            last_sync: None,
            bootstrap,
        }
    }

    pub fn status(&self) -> SyncStatus {
        SyncStatus {
            configured: true,
            server: Some(self.server.clone()),
            vault_id: Some(self.vault_id.clone()),
            pending: self.outbox.len(),
            last_sync: self.last_sync,
        }
    }

    pub fn validate(&self) -> Result<()> {
        if validate_server(&self.server)? != self.server {
            return Err(BAD.into());
        }
        canonical_uuid(&self.vault_id)?;
        canonical_uuid(&self.device_id)?;
        if self.cursor > self.high_watermark {
            return Err(BAD.into());
        }
        if self.ranks.len() > MAX_RANKS || self.outbox.len() > MAX_PENDING {
            return Err(BAD.into());
        }
        for (id, rank) in &self.ranks {
            canonical_uuid(id)?;
            canonical_uuid(&rank.device_id)?;
            canonical_uuid(&rank.record_id)?;
            if rank.clock == 0 || rank.clock > self.clock {
                return Err(BAD.into());
            }
        }
        let mut ids = std::collections::HashSet::new();
        for record in &self.outbox {
            record.validate()?;
            if !ids.insert(&record.id) {
                return Err(BAD.into());
            }
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    version: u8,
    server: String,
    vault_id: String,
    key: String,
    auth_token: String,
}
impl Drop for Bundle {
    fn drop(&mut self) {
        self.key.zeroize();
        self.auth_token.zeroize();
    }
}

pub fn validate_server(server: &str) -> Result<String> {
    if server.len() > 2048 {
        return Err("Invalid sync server URL.".into());
    }
    let url = url::Url::parse(server.trim()).map_err(|_| "Enter an HTTPS sync server URL.")?;
    let loopback = match url.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Use an HTTPS server URL without credentials, path, query or fragment. HTTP is allowed only for localhost development.".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn canonical_uuid(value: &str) -> Result<()> {
    if Uuid::parse_str(value).map_err(|_| BAD)?.to_string() != value {
        return Err(BAD.into());
    }
    Ok(())
}

pub fn credentials_location() -> Location {
    Location::generic(b"sync-secrets".to_vec(), CREDENTIALS.to_vec())
}

pub fn generate_credentials(client: &Client) -> Result<()> {
    let mut material = Zeroizing::new(vec![0; 64]);
    OsRng.fill_bytes(&mut material);
    client
        .vault(b"sync-secrets")
        .write_secret(credentials_location(), material)
        .map_err(|_| BAD.to_string())
}

pub fn install_bundle(client: &Client, uri: &str) -> Result<State> {
    if uri.len() > 8192 {
        return Err("The pairing bundle is too large.".into());
    }
    let url = url::Url::parse(uri.trim()).map_err(|_| "Invalid pairing bundle.")?;
    if url.scheme() != "mfa-sync"
        || url.host_str() != Some("pair")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err("Invalid pairing bundle.".into());
    }
    let mut params = url.query_pairs();
    let (name, value) = params.next().ok_or("Invalid pairing bundle.")?;
    if name != "data" || params.next().is_some() {
        return Err("Invalid pairing bundle.".into());
    }
    let decoded = Zeroizing::new(BASE64URL_NOPAD.decode(value.as_bytes()).map_err(|_| BAD)?);
    let bundle: Bundle = serde_json::from_slice(&decoded).map_err(|_| BAD)?;
    if bundle.version != 1 {
        return Err("Unsupported pairing version.".into());
    }
    let server = validate_server(&bundle.server)?;
    canonical_uuid(&bundle.vault_id)?;
    let key = Zeroizing::new(
        BASE64URL_NOPAD
            .decode(bundle.key.as_bytes())
            .map_err(|_| BAD)?,
    );
    let auth = Zeroizing::new(
        BASE64URL_NOPAD
            .decode(bundle.auth_token.as_bytes())
            .map_err(|_| BAD)?,
    );
    if key.len() != 32 || auth.len() != 32 {
        return Err(BAD.into());
    }
    let mut material = Zeroizing::new(Vec::with_capacity(64));
    material.extend_from_slice(&key);
    material.extend_from_slice(&auth);
    client
        .vault(b"sync-secrets")
        .write_secret(credentials_location(), material)
        .map_err(|_| BAD)?;
    Ok(State::new(server, bundle.vault_id.clone(), true))
}

struct CredentialsProcedure {
    state: Option<(String, String)>,
}
impl Procedure for CredentialsProcedure {
    type Output = String;
    fn execute<R: Runner>(self, runner: &R) -> std::result::Result<Self::Output, ProcedureError> {
        Ok(runner.get_guards([credentials_location()], |guards| {
            let material = guards[0].borrow();
            if material.len() != 64 {
                return Err(BAD.to_string().into());
            }
            if let Some((server, vault_id)) = self.state {
                let bundle = Bundle {
                    version: 1,
                    server,
                    vault_id,
                    key: BASE64URL_NOPAD.encode(&material[..32]),
                    auth_token: BASE64URL_NOPAD.encode(&material[32..]),
                };
                let bytes =
                    Zeroizing::new(serde_json::to_vec(&bundle).map_err(|_| BAD.to_string())?);
                Ok(format!(
                    "mfa-sync://pair?data={}",
                    BASE64URL_NOPAD.encode(&bytes)
                ))
            } else {
                Ok(BASE64URL_NOPAD.encode(&material[32..]))
            }
        })?)
    }
}

pub fn pairing(client: &Client, state: &State) -> Result<PairingInfo> {
    let uri = Zeroizing::new(
        CredentialsProcedure {
            state: Some((state.server.clone(), state.vault_id.clone())),
        }
        .execute(client)
        .map_err(|_| BAD)?,
    );
    Ok(PairingInfo {
        uri: uri.to_string(),
    })
}

pub fn validate_credentials(client: &Client) -> Result<()> {
    // Check the guarded record without constructing a key-containing pairing URI.
    let _auth = Zeroizing::new(
        CredentialsProcedure { state: None }
            .execute(client)
            .map_err(|_| BAD)?,
    );
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Operation {
    version: u8,
    clock: u64,
    device_id: String,
    kind: String,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<Account>,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret: Option<String>,
}
impl Drop for Operation {
    fn drop(&mut self) {
        if let Some(secret) = &mut self.secret {
            secret.zeroize();
        }
    }
}

// Stronghold's Procedure trait also supports dynamic procedure dispatch. These
// conversions keep that contract strict even though we execute typed procedures.
impl TryFrom<ProcedureOutput> for Record {
    type Error = String;
    fn try_from(output: ProcedureOutput) -> Result<Self> {
        let bytes = Vec::<u8>::from(output);
        serde_json::from_slice(&bytes).map_err(|_| BAD.into())
    }
}
impl TryFrom<ProcedureOutput> for Operation {
    type Error = String;
    fn try_from(output: ProcedureOutput) -> Result<Self> {
        let bytes = Zeroizing::new(Vec::<u8>::from(output));
        serde_json::from_slice(&bytes).map_err(|_| BAD.into())
    }
}

impl Operation {
    fn validate(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
        if self.version != 1 || self.clock == 0 {
            return Err(BAD.into());
        }
        canonical_uuid(&self.device_id)?;
        canonical_uuid(&self.id)?;
        match self.kind.as_str() {
            "delete" if self.account.is_none() && self.secret.is_none() => Ok(None),
            "put" => {
                let account = self.account.as_ref().ok_or(BAD)?;
                account.validate().map_err(|_| BAD)?;
                if account.id != self.id {
                    return Err(BAD.into());
                }
                let input = AccountInput {
                    issuer: account.issuer.clone(),
                    account: account.account.clone(),
                    secret: self.secret.as_ref().ok_or(BAD)?.clone(),
                    uri: String::new(),
                    algorithm: account.algorithm.clone(),
                    digits: account.digits,
                    period: account.period,
                };
                Ok(Some(crate::otp::parse(&input).map_err(|_| BAD)?.1))
            }
            _ => Err(BAD.into()),
        }
    }
}

struct EncryptProcedure {
    vault_id: String,
    record_id: String,
    operation: Operation,
    account_location: Option<Location>,
}
impl Procedure for EncryptProcedure {
    type Output = Record;
    fn execute<R: Runner>(
        mut self,
        runner: &R,
    ) -> std::result::Result<Self::Output, ProcedureError> {
        let encrypt = |key: &[u8],
                       operation: &Operation|
         -> std::result::Result<
            Record,
            iota_stronghold::procedures::FatalProcedureError,
        > {
            if key.len() != 64 {
                return Err(BAD.to_string().into());
            }
            let cipher = Aes256Gcm::new_from_slice(&key[..32]).map_err(|_| BAD.to_string())?;
            let bytes = Zeroizing::new(serde_json::to_vec(operation).map_err(|_| BAD.to_string())?);
            let mut nonce = [0; 12];
            OsRng.fill_bytes(&mut nonce);
            let aad = format!("mfa-sync-v1:{}:{}", self.vault_id, self.record_id);
            let ciphertext = cipher
                .encrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &bytes,
                        aad: aad.as_bytes(),
                    },
                )
                .map_err(|_| BAD.to_string())?;
            Ok(Record {
                id: self.record_id.clone(),
                nonce: BASE64.encode(&nonce),
                ciphertext: BASE64.encode(&ciphertext),
            })
        };
        if let Some(location) = self.account_location.take() {
            Ok(
                runner.get_guards([credentials_location(), location], |guards| {
                    let key = guards[0].borrow();
                    let secret = guards[1].borrow();
                    self.operation.secret = Some(BASE32_NOPAD.encode(secret.as_ref()));
                    encrypt(key.as_ref(), &self.operation)
                })?,
            )
        } else {
            Ok(runner.get_guards([credentials_location()], |guards| {
                let key = guards[0].borrow();
                encrypt(key.as_ref(), &self.operation)
            })?)
        }
    }
}

struct DecryptProcedure<'a> {
    state: &'a State,
    record: &'a Record,
}
impl Procedure for DecryptProcedure<'_> {
    type Output = Operation;
    fn execute<R: Runner>(self, runner: &R) -> std::result::Result<Self::Output, ProcedureError> {
        Ok(runner.get_guards([credentials_location()], |guards| {
            let key = guards[0].borrow();
            if key.len() != 64 {
                return Err(BAD.to_string().into());
            }
            let nonce = BASE64
                .decode(self.record.nonce.as_bytes())
                .map_err(|_| BAD.to_string())?;
            let ciphertext = BASE64
                .decode(self.record.ciphertext.as_bytes())
                .map_err(|_| BAD.to_string())?;
            let cipher = Aes256Gcm::new_from_slice(&key[..32]).map_err(|_| BAD.to_string())?;
            let aad = format!("mfa-sync-v1:{}:{}", self.state.vault_id, self.record.id);
            let bytes = Zeroizing::new(
                cipher
                    .decrypt(
                        Nonce::from_slice(&nonce),
                        Payload {
                            msg: &ciphertext,
                            aad: aad.as_bytes(),
                        },
                    )
                    .map_err(|_| BAD.to_string())?,
            );
            serde_json::from_slice(&bytes).map_err(|_| BAD.to_string().into())
        })?)
    }
}

fn queue(client: &Client, state: &mut State, account: Option<&Account>, id: &str) -> Result<()> {
    if state.outbox.len() >= MAX_PENDING
        || (state.ranks.len() >= MAX_RANKS && !state.ranks.contains_key(id))
    {
        return Err("Too many pending changes. Sync before changing more accounts.".into());
    }
    let clock = state.clock.checked_add(1).ok_or(BAD)?;
    let record_id = Uuid::new_v4().to_string();
    let operation = Operation {
        version: 1,
        clock,
        device_id: state.device_id.clone(),
        kind: if account.is_some() { "put" } else { "delete" }.into(),
        id: id.into(),
        account: account.cloned(),
        secret: None,
    };
    let record = EncryptProcedure {
        vault_id: state.vault_id.clone(),
        record_id: record_id.clone(),
        operation,
        account_location: account.map(Account::location),
    }
    .execute(client)
    .map_err(|_| BAD)?;
    state.clock = clock;
    state.ranks.insert(
        id.into(),
        Rank {
            clock,
            device_id: state.device_id.clone(),
            record_id,
        },
    );
    state.outbox.push(record);
    Ok(())
}

pub fn queue_put(client: &Client, state: &mut State, account: &Account) -> Result<()> {
    queue(client, state, Some(account), &account.id)
}
pub fn queue_delete(client: &Client, state: &mut State, id: &str) -> Result<()> {
    queue(client, state, None, id)
}

pub fn apply(
    client: &Client,
    accounts: &mut Vec<Account>,
    state: &mut State,
    record: &Record,
) -> Result<bool> {
    record.validate()?;
    let operation = DecryptProcedure { state, record }
        .execute(client)
        .map_err(|_| BAD)?;
    let secret = operation.validate()?;
    let rank = Rank {
        clock: operation.clock,
        device_id: operation.device_id.clone(),
        record_id: record.id.clone(),
    };
    state.clock = state.clock.max(operation.clock);
    if state
        .ranks
        .get(&operation.id)
        .is_some_and(|current| current >= &rank)
    {
        return Ok(false);
    }
    if state.ranks.len() >= MAX_RANKS && !state.ranks.contains_key(&operation.id) {
        return Err(BAD.into());
    }
    if let Some(account) = &operation.account {
        if accounts.len() >= 1000 && !accounts.iter().any(|a| a.id == account.id) {
            return Err("The shared vault exceeds the 1000 account limit.".into());
        }
        client
            .vault(b"totp-secrets")
            .write_secret(account.location(), secret.ok_or(BAD)?)
            .map_err(|_| BAD)?;
        accounts.retain(|a| a.id != account.id);
        accounts.push(account.clone());
    } else {
        // A repeated delete is valid even when this device never saw the put.
        client
            .vault(b"totp-secrets")
            .delete_secret(operation.id.as_bytes())
            .map_err(|_| BAD)?;
        accounts.retain(|a| a.id != operation.id);
    }
    state.ranks.insert(operation.id.clone(), rank);
    Ok(true)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteRecord {
    sequence: u64,
    id: String,
    nonce: String,
    ciphertext: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Page {
    records: Vec<RemoteRecord>,
    cursor: u64,
    has_more: bool,
    latest: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Acknowledgement {
    accepted: usize,
    latest: u64,
}

struct Transport {
    client: reqwest::blocking::Client,
    auth: Zeroizing<String>,
    server: String,
    deadline: Instant,
}
impl Transport {
    fn new(client: &Client, state: &State) -> Result<Self> {
        state.validate()?;
        let auth = Zeroizing::new(
            CredentialsProcedure { state: None }
                .execute(client)
                .map_err(|_| BAD)?,
        );
        // Explicit public CA roots avoid Android's platform-verifier JNI helper.
        // Private/self-signed certificates are deliberately not accepted.
        let roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| NETWORK)?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let client = reqwest::blocking::Client::builder()
            .tls_backend_preconfigured(tls)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| NETWORK)?;
        Ok(Self {
            client,
            auth,
            server: state.server.clone(),
            deadline: Instant::now() + Duration::from_secs(12),
        })
    }

    fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        auth: &str,
        body: Option<Vec<u8>>,
    ) -> Result<Vec<u8>> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .ok_or(NETWORK)?;
        let mut request = self
            .client
            .request(method, format!("{}{}", self.server, path))
            .bearer_auth(auth)
            .timeout(remaining.min(Duration::from_secs(5)));
        if let Some(body) = body {
            if body.len() as u64 > MAX_BODY {
                return Err(BAD.into());
            }
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }
        let response = request.send().map_err(|_| NETWORK)?;
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                401 | 403 => {
                    "Sync authorization was rejected. Check the server or pair this device again."
                }
                409 => "Sync history or credentials conflict. The local vault was not changed.",
                413 | 507 => {
                    "The sync server storage limit was reached. The local vault was not changed."
                }
                _ => NETWORK,
            }
            .into());
        }
        if response.content_length().is_some_and(|n| n > MAX_BODY) {
            return Err(BAD.into());
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_BODY + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| NETWORK)?;
        if bytes.len() as u64 > MAX_BODY {
            return Err(BAD.into());
        }
        Ok(bytes)
    }
}

pub fn register(client: &Client, state: &State, registration: &str) -> Result<()> {
    if registration.len() != 43
        || BASE64URL_NOPAD
            .decode(registration.as_bytes())
            .map_or(true, |bytes| bytes.len() != 32)
    {
        return Err("Enter the server's 43-character registration token.".into());
    }
    let transport = Transport::new(client, state)?;
    let body = Zeroizing::new(
        serde_json::to_vec(
            &serde_json::json!({"vaultId": state.vault_id, "authToken": transport.auth.as_str()}),
        )
        .map_err(|_| BAD)?,
    );
    transport.send(
        reqwest::Method::POST,
        "/v1/vaults",
        registration,
        Some(body.to_vec()),
    )?;
    Ok(())
}

fn validate_page(page: &Page, state: &State) -> Result<()> {
    if page.records.len() > 100
        || page.latest < page.cursor
        || page.cursor < state.cursor
        || page.latest < state.high_watermark
        || page.has_more != (page.cursor < page.latest)
        || (page.records.is_empty() && page.has_more)
    {
        return Err(BAD.into());
    }
    let mut sequence = state.cursor;
    for record in &page.records {
        if record.sequence != sequence.checked_add(1).ok_or(BAD)? {
            return Err(BAD.into());
        }
        sequence = record.sequence;
    }
    if page.cursor != sequence {
        return Err(BAD.into());
    }
    Ok(())
}

fn get_page(transport: &Transport, state: &State) -> Result<Page> {
    let bytes = transport.send(
        reqwest::Method::GET,
        &format!(
            "/v1/vaults/{}/records?after={}",
            state.vault_id, state.cursor
        ),
        &transport.auth,
        None,
    )?;
    let page: Page = serde_json::from_slice(&bytes).map_err(|_| BAD)?;
    validate_page(&page, state)?;
    Ok(page)
}

/// Idle polling must not run the snapshot KDF or rewrite the encrypted vault.
pub fn has_remote_changes(client: &Client, state: &mut State) -> Result<bool> {
    let transport = Transport::new(client, state)?;
    let page = get_page(&transport, state)?;
    if page.records.is_empty() {
        state.last_sync = Some(crate::vault::now()?);
        Ok(false)
    } else {
        Ok(true)
    }
}

/// Mutates only a disposable candidate Session. Caller atomically commits on success.
pub fn synchronize(
    client: &Client,
    accounts: &mut Vec<Account>,
    state: &mut State,
) -> Result<bool> {
    let transport = Transport::new(client, state)?;
    let mut changed = false;
    let mut caught_up = false;
    // Incrementally persist a long history rather than locking the app indefinitely.
    for _ in 0..10 {
        let page = get_page(&transport, state)?;
        state.high_watermark = page.latest;
        for remote in page.records {
            let record = Record {
                id: remote.id,
                nonce: remote.nonce,
                ciphertext: remote.ciphertext,
            };
            changed |= apply(client, accounts, state, &record)?;
        }
        state.cursor = page.cursor;
        if !page.has_more {
            caught_up = true;
            break;
        }
    }
    if caught_up {
        if state.bootstrap {
            for account in accounts.iter() {
                if !state.ranks.contains_key(&account.id) {
                    queue_put(client, state, account)?;
                }
            }
            state.bootstrap = false;
        }
        // Exact records remain in the persisted old snapshot if any outcome is unknown.
        let count = state.outbox.len().min(100);
        if count != 0 {
            let body = serde_json::to_vec(&serde_json::json!({"records": &state.outbox[..count]}))
                .map_err(|_| BAD)?;
            let bytes = transport.send(
                reqwest::Method::POST,
                &format!("/v1/vaults/{}/records", state.vault_id),
                &transport.auth,
                Some(body),
            )?;
            let acknowledgement: Acknowledgement =
                serde_json::from_slice(&bytes).map_err(|_| BAD)?;
            if acknowledgement.accepted != count || acknowledgement.latest < state.high_watermark {
                return Err(BAD.into());
            }
            state.high_watermark = acknowledgement.latest;
            state.outbox.drain(..count);
        }
    }
    state.last_sync = Some(crate::vault::now()?);
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use iota_stronghold::Stronghold;

    #[test]
    fn server_url_and_pairing_reject_unsafe_inputs() {
        assert_eq!(
            validate_server("https://sync.example.invalid/").unwrap(),
            "https://sync.example.invalid"
        );
        assert!(validate_server("http://127.0.0.1:4111").is_ok());
        assert!(validate_server("http://[::1]:4111").is_ok());
        for value in [
            "http://example.invalid",
            "https://user:pass@example.invalid",
            "https://example.invalid/path",
            "https://example.invalid?key=x",
            "https://example.invalid/#x",
            "file:///tmp/a",
        ] {
            assert!(validate_server(value).is_err());
        }
        let s = Stronghold::default();
        let c = s.create_client(b"test").unwrap();
        assert!(install_bundle(&c, "mfa-sync://pair?data=notjson").is_err());
        assert!(install_bundle(&c, "mfa-sync://pair?data=e30&data=e30").is_err());
    }

    #[test]
    fn authenticated_records_converge_and_tampering_cannot_apply() {
        let stronghold = Stronghold::default();
        let client = stronghold.create_client(b"test").unwrap();
        generate_credentials(&client).unwrap();
        let mut state = State::new(
            "https://sync.example.invalid".into(),
            Uuid::new_v4().to_string(),
            false,
        );
        let account = Account {
            id: Uuid::new_v4().to_string(),
            issuer: "Synthetic".into(),
            account: "test@example.invalid".into(),
            algorithm: "SHA1".into(),
            digits: 6,
            period: 30,
        };
        client
            .vault(b"totp-secrets")
            .write_secret(
                account.location(),
                Zeroizing::new(b"12345678901234567890".to_vec()),
            )
            .unwrap();
        queue_put(&client, &mut state, &account).unwrap();
        let put = state.outbox[0].clone();
        assert!(!put.ciphertext.contains("Synthetic"));
        let bundle = pairing(&client, &state).unwrap();
        let peer_hold = Stronghold::default();
        let peer = peer_hold.create_client(b"peer").unwrap();
        let mut peer_state = install_bundle(&peer, &bundle.uri).unwrap();
        let mut accounts = vec![];
        assert!(apply(&peer, &mut accounts, &mut peer_state, &put).unwrap());
        assert_eq!(
            accounts[0].code(&peer, 59).unwrap().code,
            account.code(&client, 59).unwrap().code
        );
        assert!(!apply(&peer, &mut accounts, &mut peer_state, &put).unwrap());
        queue_delete(&client, &mut state, &account.id).unwrap();
        assert!(apply(&peer, &mut accounts, &mut peer_state, &state.outbox[1]).unwrap());
        assert!(accounts.is_empty());
        let late_hold = Stronghold::default();
        let late = late_hold.create_client(b"late").unwrap();
        let mut late_state = install_bundle(&late, &bundle.uri).unwrap();
        let mut late_accounts = vec![];
        assert!(apply(&late, &mut late_accounts, &mut late_state, &state.outbox[1]).unwrap());
        assert!(!apply(&late, &mut late_accounts, &mut late_state, &put).unwrap());
        assert!(late_accounts.is_empty());
        assert!(!apply(&peer, &mut accounts, &mut peer_state, &put).unwrap());
        assert!(accounts.is_empty());
        let mut damaged = put.clone();
        damaged.id = Uuid::new_v4().to_string();
        assert!(apply(&peer, &mut accounts, &mut peer_state, &damaged).is_err());
        assert!(accounts.is_empty());
        peer_state.vault_id = Uuid::new_v4().to_string();
        assert!(apply(&peer, &mut accounts, &mut peer_state, &put).is_err());
    }

    #[test]
    fn rejects_cursor_replay_gaps_and_history_rollback() {
        let mut state = State::new(
            "https://sync.example.invalid".into(),
            Uuid::new_v4().to_string(),
            false,
        );
        state.cursor = 4;
        state.high_watermark = 8;
        let mut page = Page {
            records: vec![],
            cursor: 4,
            has_more: false,
            latest: 4,
        };
        assert!(validate_page(&page, &state).is_err());
        page.latest = 8;
        page.has_more = true;
        assert!(validate_page(&page, &state).is_err());
        page.records.push(RemoteRecord {
            sequence: 6,
            id: Uuid::new_v4().to_string(),
            nonce: String::new(),
            ciphertext: String::new(),
        });
        page.cursor = 6;
        assert!(validate_page(&page, &state).is_err());
        page.records[0].sequence = 5;
        page.cursor = 5;
        assert!(validate_page(&page, &state).is_ok());
        page.cursor = 4;
        assert!(validate_page(&page, &state).is_err());
    }

    #[test]
    fn concurrent_put_and_delete_converge_independently_of_arrival_order() {
        let left_hold = Stronghold::default();
        let left = left_hold.create_client(b"left").unwrap();
        generate_credentials(&left).unwrap();
        let mut left_state = State::new(
            "https://sync.example.invalid".into(),
            Uuid::new_v4().to_string(),
            false,
        );
        left_state.device_id = "11111111-1111-4111-8111-111111111111".into();
        let account = Account {
            id: Uuid::new_v4().to_string(),
            issuer: "Synthetic".into(),
            account: "concurrent@example.invalid".into(),
            algorithm: "SHA1".into(),
            digits: 6,
            period: 30,
        };
        left.vault(b"totp-secrets")
            .write_secret(
                account.location(),
                Zeroizing::new(b"12345678901234567890".to_vec()),
            )
            .unwrap();
        queue_put(&left, &mut left_state, &account).unwrap();
        let bundle = pairing(&left, &left_state).unwrap();
        let right_hold = Stronghold::default();
        let right = right_hold.create_client(b"right").unwrap();
        let mut right_state = install_bundle(&right, &bundle.uri).unwrap();
        right_state.device_id = "22222222-2222-4222-8222-222222222222".into();
        let mut right_accounts = vec![];
        apply(
            &right,
            &mut right_accounts,
            &mut right_state,
            &left_state.outbox[0],
        )
        .unwrap();
        queue_put(&left, &mut left_state, &account).unwrap();
        queue_delete(&right, &mut right_state, &account.id).unwrap();
        let mut left_accounts = vec![account];
        right_accounts.clear();
        apply(
            &left,
            &mut left_accounts,
            &mut left_state,
            &right_state.outbox[0],
        )
        .unwrap();
        apply(
            &right,
            &mut right_accounts,
            &mut right_state,
            &left_state.outbox[1],
        )
        .unwrap();
        assert!(left_accounts.is_empty() && right_accounts.is_empty());
        assert!(left_state.ranks == right_state.ranks);
    }
}
