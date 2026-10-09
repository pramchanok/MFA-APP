use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use iota_stronghold::{
    procedures::{Procedure, ProcedureError, Runner},
    Client, Location,
};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Sha256, Sha512};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

pub type Result<T> = std::result::Result<T, String>;

#[derive(Deserialize, Zeroize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub issuer: String,
    pub account: String,
    pub secret: String,
    pub uri: String,
    pub algorithm: String,
    pub digits: u32,
    pub period: u64,
}

impl Drop for AccountInput {
    fn drop(&mut self) {
        self.zeroize();
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Account {
    pub id: String,
    pub issuer: String,
    pub account: String,
    pub algorithm: String,
    pub digits: u32,
    pub period: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCode {
    pub id: String,
    pub issuer: String,
    pub account: String,
    pub code: String,
    pub digits: u32,
    pub period: u64,
    pub remaining: u64,
}

// Only the rendered image crosses IPC. Never return the setup URI or raw key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountQr {
    pub image: String,
    pub custom_parameters: bool,
}

impl Drop for AccountQr {
    fn drop(&mut self) {
        self.image.zeroize();
    }
}

impl Account {
    pub fn validate(&self) -> Result<()> {
        if Uuid::parse_str(&self.id).is_err() {
            return Err("Invalid account identifier.".into());
        }
        if self.account.trim().is_empty()
            || self.account.len() > 320
            || self.issuer.len() > 200
            || self
                .account
                .chars()
                .chain(self.issuer.chars())
                .any(char::is_control)
        {
            return Err("Enter a valid account name (maximum 320 characters).".into());
        }
        if !matches!(self.algorithm.as_str(), "SHA1" | "SHA256" | "SHA512") {
            return Err("Only SHA1, SHA256 and SHA512 are supported.".into());
        }
        if !matches!(self.digits, 6 | 8) || !(15..=120).contains(&self.period) {
            return Err("Use 6 or 8 digits and a period from 15 to 120 seconds.".into());
        }
        Ok(())
    }

    pub fn location(&self) -> Location {
        Location::generic(b"totp-secrets".to_vec(), self.id.as_bytes().to_vec())
    }

    pub fn qr(&self, client: &Client) -> Result<AccountQr> {
        let image = SetupQrProcedure {
            account: self.clone(),
        }
        .execute(client)
        .map_err(|_| "Unable to generate this account's QR code.".to_string())?;
        Ok(AccountQr {
            image,
            custom_parameters: self.algorithm != "SHA1" || self.digits != 6 || self.period != 30,
        })
    }

    pub fn code(&self, client: &Client, timestamp: u64) -> Result<AccountCode> {
        let code = TotpProcedure {
            location: self.location(),
            algorithm: self.algorithm.clone(),
            counter: timestamp / self.period,
            digits: self.digits,
        }
        .execute(client)
        .map_err(|_| "Unable to generate this account's code.".to_string())?;
        Ok(AccountCode {
            id: self.id.clone(),
            issuer: self.issuer.clone(),
            account: self.account.clone(),
            code,
            digits: self.digits,
            period: self.period,
            remaining: self.period - timestamp % self.period,
        })
    }
}

fn setup_uri(account: &Account, key: &[u8]) -> Zeroizing<String> {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    use std::fmt::Write;
    let issuer = utf8_percent_encode(&account.issuer, NON_ALPHANUMERIC);
    let name = utf8_percent_encode(&account.account, NON_ALPHANUMERIC);
    let label = if account.issuer.is_empty() {
        name.to_string()
    } else {
        format!("{issuer}:{name}")
    };
    let secret = Zeroizing::new(BASE32_NOPAD.encode(key));
    let mut uri = Zeroizing::new(format!("otpauth://totp/{label}?secret="));
    uri.push_str(&secret);
    write!(
        &mut *uri,
        "&issuer={issuer}&algorithm={}&digits={}&period={}",
        account.algorithm, account.digits, account.period
    )
    .expect("writing to String cannot fail");
    uri
}

struct SetupQrProcedure {
    account: Account,
}

impl Procedure for SetupQrProcedure {
    type Output = String;

    fn execute<R: Runner>(self, runner: &R) -> std::result::Result<String, ProcedureError> {
        Ok(runner.get_guards([self.account.location()], |guards| {
            let key = guards[0].borrow();
            let uri = setup_uri(&self.account, key.as_ref());
            let code = qrcode::QrCode::new(uri.as_bytes()).map_err(|_| {
                iota_stronghold::procedures::FatalProcedureError::from(
                    "QR generation failed".to_string(),
                )
            })?;
            let svg = Zeroizing::new(
                code.render::<qrcode::render::svg::Color>()
                    .min_dimensions(320, 320)
                    .build(),
            );
            Ok(format!(
                "data:image/svg+xml;base64,{}",
                data_encoding::BASE64.encode(svg.as_bytes())
            ))
        })?)
    }
}

pub fn parse(input: &AccountInput) -> Result<(Account, Zeroizing<Vec<u8>>)> {
    let mut account = Account {
        id: Uuid::new_v4().to_string(),
        issuer: input.issuer.trim().into(),
        account: input.account.trim().into(),
        algorithm: input.algorithm.trim().to_uppercase(),
        digits: input.digits,
        period: input.period,
    };
    if account.algorithm.is_empty() {
        account.algorithm = "SHA1".into();
    }
    let mut secret = Zeroizing::new(input.secret.clone());
    if !input.uri.trim().is_empty() {
        if input.uri.len() > 8192 {
            return Err("The QR or setup URI is too large.".into());
        }
        let uri = url::Url::parse(input.uri.trim()).map_err(|_| "Invalid setup URI.")?;
        if uri.scheme() == "otpauth-migration" {
            return Err(
                "Google migration QR is unsupported. Export a standard TOTP setup QR instead."
                    .into(),
            );
        }
        if uri.scheme() != "otpauth" || uri.host_str() != Some("totp") {
            return Err("Use an otpauth://totp setup QR. HOTP and Microsoft push enrollment are unsupported.".into());
        }
        if uri.fragment().is_some() || !uri.username().is_empty() || uri.port().is_some() {
            return Err("Invalid setup URI.".into());
        }
        let label = percent_encoding::percent_decode_str(uri.path().trim_start_matches('/'))
            .decode_utf8()
            .map_err(|_| "Invalid account label.")?;
        let (label_issuer, label_account) = label.split_once(':').unwrap_or(("", &label));
        account.issuer = label_issuer.trim().into();
        account.account = label_account.trim().into();
        account.algorithm = "SHA1".into();
        account.digits = 6;
        account.period = 30;
        secret.clear();
        let mut seen = std::collections::HashSet::new();
        for (key, value) in uri.query_pairs() {
            if !seen.insert(key.to_string()) {
                return Err("Duplicate setup parameters are not allowed.".into());
            }
            match key.as_ref() {
                "secret" => secret.push_str(&value),
                "issuer" => {
                    if !account.issuer.is_empty() && account.issuer != value.trim() {
                        return Err("The setup issuer does not match the account label.".into());
                    }
                    account.issuer = value.trim().into();
                }
                "algorithm" => account.algorithm = value.to_uppercase(),
                "digits" => account.digits = value.parse().map_err(|_| "Invalid digit count.")?,
                "period" => account.period = value.parse().map_err(|_| "Invalid period.")?,
                _ => {
                    return Err(
                        "Unsupported setup parameter. Use a standard TOTP setup URI.".into(),
                    )
                }
            }
        }
    }
    account.validate()?;
    let normalized = Zeroizing::new(
        secret
            .chars()
            .filter(|c| !c.is_ascii_whitespace())
            .collect::<String>()
            .to_uppercase(),
    );
    if normalized.len() > 256 || normalized.is_empty() {
        return Err("Enter a Base32 secret key.".into());
    }
    let decoded = Zeroizing::new(
        BASE32_NOPAD
            .decode(normalized.trim_end_matches('=').as_bytes())
            .map_err(|_| "The secret must be a valid Base32 key.")?,
    );
    if decoded.len() < 10 || decoded.len() > 128 {
        return Err("The secret key must contain between 10 and 128 bytes.".into());
    }
    Ok((account, decoded))
}

// Custom procedure keeps raw keys inside Stronghold's guarded runtime.
struct TotpProcedure {
    location: Location,
    algorithm: String,
    counter: u64,
    digits: u32,
}

impl Procedure for TotpProcedure {
    type Output = String;

    fn execute<R: Runner>(self, runner: &R) -> std::result::Result<String, ProcedureError> {
        Ok(runner.get_guards([self.location], |guards| {
            let key = guards[0].borrow();
            let msg = self.counter.to_be_bytes();
            macro_rules! digest {
                ($hash:ty) => {{
                    let mut mac = Hmac::<$hash>::new_from_slice(key.as_ref()).map_err(|_| {
                        iota_stronghold::procedures::FatalProcedureError::from(
                            "Invalid key".to_string(),
                        )
                    })?;
                    mac.update(&msg);
                    Zeroizing::new(mac.finalize().into_bytes().to_vec())
                }};
            }
            let hash = match self.algorithm.as_str() {
                "SHA1" => digest!(Sha1),
                "SHA256" => digest!(Sha256),
                "SHA512" => digest!(Sha512),
                _ => return Err("Unsupported algorithm".to_string().into()),
            };
            let offset = usize::from(hash[hash.len() - 1] & 15);
            let number =
                u32::from_be_bytes(hash[offset..offset + 4].try_into().expect("HMAC length"))
                    & 0x7fff_ffff;
            Ok(format!(
                "{:0width$}",
                number % 10_u32.pow(self.digits),
                width = self.digits as usize
            ))
        })?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iota_stronghold::Stronghold;

    fn input() -> AccountInput {
        AccountInput {
            issuer: "Example".into(),
            account: "test@example.invalid".into(),
            secret: "JBSWY3DPEHPK3PXP".into(),
            uri: String::new(),
            algorithm: "SHA1".into(),
            digits: 6,
            period: 30,
        }
    }

    #[test]
    fn rfc6238_all_algorithms_all_vectors() {
        let timestamps = [
            59,
            1111111109,
            1111111111,
            1234567890,
            2000000000,
            20000000000,
        ];
        let vectors = [
            (
                "SHA1",
                "12345678901234567890",
                [
                    "94287082", "07081804", "14050471", "89005924", "69279037", "65353130",
                ],
            ),
            (
                "SHA256",
                "12345678901234567890123456789012",
                [
                    "46119246", "68084774", "67062674", "91819424", "90698825", "77737706",
                ],
            ),
            (
                "SHA512",
                "1234567890123456789012345678901234567890123456789012345678901234",
                [
                    "90693936", "25091201", "99943326", "93441116", "38618901", "47863826",
                ],
            ),
        ];
        for (algorithm, secret, expected) in vectors {
            let stronghold = Stronghold::default();
            let client = stronghold.create_client(b"test").unwrap();
            let mut i = input();
            i.algorithm = algorithm.into();
            i.digits = 8;
            i.secret = BASE32_NOPAD.encode(secret.as_bytes());
            let (a, secret) = parse(&i).unwrap();
            client
                .vault(b"totp-secrets")
                .write_secret(a.location(), secret)
                .unwrap();
            for (t, expected) in timestamps.into_iter().zip(expected) {
                assert_eq!(a.code(&client, t).unwrap().code, expected);
            }
        }
    }

    #[test]
    fn setup_qr_preserves_credentials_parameters_and_encoded_labels() {
        let stronghold = Stronghold::default();
        let client = stronghold.create_client(b"qr-test").unwrap();
        for algorithm in ["SHA1", "SHA256", "SHA512"] {
            for issuer in ["", "บริการ & /?#%+ ทดสอบ"] {
                let mut original = input();
                original.issuer = issuer.into();
                original.account = "alice+test /?#%@example.invalid".into();
                original.algorithm = algorithm.into();
                original.digits = if algorithm == "SHA1" { 6 } else { 8 };
                original.period = if algorithm == "SHA1" { 30 } else { 60 };
                let (account, secret) = parse(&original).unwrap();
                let uri = setup_uri(&account, &secret);
                let mut imported = input();
                imported.uri = uri.to_string();
                let (copy, copy_secret) = parse(&imported).unwrap();
                assert_eq!(copy.issuer, account.issuer);
                assert_eq!(copy.account, account.account);
                assert_eq!(copy.algorithm, account.algorithm);
                assert_eq!(copy.digits, account.digits);
                assert_eq!(copy.period, account.period);
                assert_eq!(*copy_secret, *secret);
                client
                    .vault(b"totp-secrets")
                    .write_secret(account.location(), secret)
                    .unwrap();
                client
                    .vault(b"totp-secrets")
                    .write_secret(copy.location(), copy_secret)
                    .unwrap();
                assert_eq!(
                    account.code(&client, 1234567890).unwrap().code,
                    copy.code(&client, 1234567890).unwrap().code
                );
                let qr = account.qr(&client).unwrap();
                assert_eq!(qr.custom_parameters, algorithm != "SHA1");
                let svg = data_encoding::BASE64
                    .decode(
                        qr.image
                            .strip_prefix("data:image/svg+xml;base64,")
                            .unwrap()
                            .as_bytes(),
                    )
                    .unwrap();
                let svg = String::from_utf8(svg).unwrap();
                assert!(svg.contains("<svg"));
                assert!(!svg.contains("otpauth"));
                assert!(!svg.contains(&original.secret));
            }
        }
    }

    #[test]
    fn validates_uri_and_parameters_without_echoing_secrets() {
        let mut i = input();
        i.uri = "otpauth://totp/Example:test%40example.invalid?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA256&digits=8&period=60".into();
        let (a, _) = parse(&i).unwrap();
        assert_eq!(a.account, "test@example.invalid");
        assert_eq!(a.period, 60);
        for uri in [
            "otpauth://hotp/a?secret=JBSWY3DPEHPK3PXP",
            "otpauth-migration://offline?data=test",
            "otpauth://totp/a?secret=SECRET&secret=SECOND",
            "otpauth://totp/a?secret=invalid!",
            "otpauth://totp/A:a?secret=JBSWY3DPEHPK3PXP&issuer=B",
            "otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&digits=7",
        ] {
            i.uri = uri.into();
            let error = parse(&i).err().unwrap();
            assert!(!error.contains("JBSWY"));
            assert!(!error.contains("SECRET"));
        }
        i.uri.clear();
        i.period = 0;
        assert!(parse(&i).is_err());
    }
}
