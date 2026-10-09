//! Google Authenticator's offline export format. No network or cloud login.
//! Wire schema reference (unofficial, not a Google API contract):
//! https://github.com/qistoph/otp_export/blob/master/OtpMigration.proto
use crate::otp::{Account, Result};
use data_encoding::{BASE64, BASE64_NOPAD};
use serde::Serialize;
use std::collections::HashSet;
use uuid::Uuid;
use zeroize::Zeroizing;

const INVALID: &str =
    "Invalid Google export QR. Export the accounts again from Google Authenticator.";
const UNSUPPORTED_VERSION: &str =
    "This Google export version is not supported. Update MFA Desktop before importing.";
pub const MAX_PARTS: usize = 100;
const MAX_ENTRIES: usize = 1000;

pub struct Entry {
    pub account: Account,
    pub secret: Zeroizing<Vec<u8>>,
    pub unsupported: Option<&'static str>,
}

pub struct Export {
    pub entries: Vec<Entry>,
    pub parts: usize,
    pub expected: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEntry {
    pub index: usize,
    pub issuer: String,
    pub account: String,
    pub algorithm: String,
    pub digits: u32,
    pub reason: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub entries: Vec<PreviewEntry>,
    pub parts: usize,
    pub expected: usize,
    pub complete: bool,
}

impl Export {
    pub fn preview(&self, existing: &[Account]) -> Preview {
        let mut names: HashSet<(&str, &str)> = existing
            .iter()
            .map(|a| (a.issuer.as_str(), a.account.as_str()))
            .collect();
        let entries = self
            .entries
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let a = &entry.account;
                let reason = entry
                    .unsupported
                    .or_else(|| (!names.insert((&a.issuer, &a.account))).then_some("duplicate"));
                PreviewEntry {
                    index,
                    issuer: a.issuer.clone(),
                    account: a.account.clone(),
                    algorithm: a.algorithm.clone(),
                    digits: a.digits,
                    reason,
                }
            })
            .collect();
        Preview {
            entries,
            parts: self.parts,
            expected: self.expected,
            complete: self.parts == self.expected,
        }
    }
}

// Small bounded protobuf wire reader. No recursive messages or unchecked lengths.
struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }
    fn varint(&mut self) -> Result<u64> {
        let mut result = 0_u64;
        for shift in (0..70).step_by(7) {
            let byte = *self.bytes.get(self.position).ok_or(INVALID)?;
            self.position += 1;
            if shift == 63 && byte > 1 {
                return Err(INVALID.into());
            }
            result |= u64::from(byte & 127) << shift;
            if byte & 128 == 0 {
                return Ok(result);
            }
        }
        Err(INVALID.into())
    }
    fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        let end = self.position.checked_add(length).ok_or(INVALID)?;
        let value = self.bytes.get(self.position..end).ok_or(INVALID)?;
        self.position = end;
        Ok(value)
    }
    fn bytes(&mut self, wire: u64) -> Result<&'a [u8]> {
        if wire != 2 {
            return Err(INVALID.into());
        }
        let length = usize::try_from(self.varint()?).map_err(|_| INVALID)?;
        self.take(length)
    }
    fn number(&mut self, wire: u64) -> Result<u64> {
        if wire != 0 {
            return Err(INVALID.into());
        }
        self.varint()
    }
    fn tag(&mut self) -> Result<Option<(u64, u64)>> {
        if self.position == self.bytes.len() {
            return Ok(None);
        }
        let tag = self.varint()?;
        let field = tag >> 3;
        if field == 0 || field > 0x1fff_ffff {
            return Err(INVALID.into());
        }
        Ok(Some((field, tag & 7)))
    }
    fn skip(&mut self, wire: u64) -> Result<()> {
        match wire {
            0 => {
                self.varint()?;
            }
            1 => {
                self.take(8)?;
            }
            2 => {
                self.bytes(wire)?;
            }
            5 => {
                self.take(4)?;
            }
            _ => return Err(INVALID.into()),
        }
        Ok(())
    }
}

fn text(bytes: &[u8], maximum: usize) -> Result<String> {
    if bytes.len() > maximum {
        return Err(INVALID.into());
    }
    let value = std::str::from_utf8(bytes).map_err(|_| INVALID)?.trim();
    if value.chars().any(char::is_control) {
        return Err(INVALID.into());
    }
    Ok(value.into())
}

fn entry(bytes: &[u8]) -> Result<Entry> {
    let mut reader = Reader::new(bytes);
    let mut seen = HashSet::new();
    let mut secret = Zeroizing::new(Vec::new());
    let (mut name, mut issuer) = (String::new(), String::new());
    let (mut algorithm, mut digits, mut kind, mut counter) = (0, 0, 0, 0);
    while let Some((field, wire)) = reader.tag()? {
        if field <= 7 && !seen.insert(field) {
            return Err(INVALID.into());
        }
        match field {
            1 => {
                let value = reader.bytes(wire)?;
                if !(10..=128).contains(&value.len()) {
                    return Err(INVALID.into());
                }
                secret.extend_from_slice(value);
            }
            2 => name = text(reader.bytes(wire)?, 520)?,
            3 => issuer = text(reader.bytes(wire)?, 200)?,
            4 => algorithm = reader.number(wire)?,
            5 => digits = reader.number(wire)?,
            6 => kind = reader.number(wire)?,
            7 => counter = reader.number(wire)?,
            _ => reader.skip(wire)?,
        }
    }
    if secret.is_empty() || name.is_empty() {
        return Err(INVALID.into());
    }
    if let Some((prefix, suffix)) = name.split_once(':') {
        if issuer.is_empty() || prefix.trim() == issuer {
            if issuer.is_empty() {
                issuer = prefix.trim().into();
            }
            name = suffix.trim().into();
        }
    }
    let unsupported = match (kind, algorithm, digits, counter) {
        (1, _, _, _) => Some("hotp"),
        (2, 1..=3, 1 | 2, 0) => None,
        (2, 0 | 4.., _, _) => Some("algorithm"),
        (2, _, 0 | 3.., _) => Some("digits"),
        _ => Some("type"),
    };
    let account = Account {
        id: Uuid::new_v4().to_string(),
        issuer,
        account: name,
        algorithm: match algorithm {
            2 => "SHA256",
            3 => "SHA512",
            _ => "SHA1",
        }
        .into(),
        digits: if digits == 2 { 8 } else { 6 },
        period: 30,
    };
    account.validate().map_err(|_| INVALID)?;
    Ok(Entry {
        account,
        secret,
        unsupported,
    })
}

pub fn parse(uris: &[String]) -> Result<Export> {
    if uris.is_empty() || uris.len() > MAX_PARTS {
        return Err(INVALID.into());
    }
    let mut entries = Vec::new();
    let mut batch = None;
    let mut indices = HashSet::new();
    let mut total_bytes = 0;
    for uri in uris {
        total_bytes += uri.len();
        if uri.len() > 32768 || total_bytes > 1024 * 1024 {
            return Err(INVALID.into());
        }
        let encoded = uri
            .trim()
            .strip_prefix("otpauth-migration://offline?data=")
            .ok_or(INVALID)?;
        if encoded.contains(['&', '#']) {
            return Err(INVALID.into());
        }
        let encoded = Zeroizing::new(
            percent_encoding::percent_decode_str(encoded)
                .decode_utf8()
                .map_err(|_| INVALID)?
                .into_owned(),
        );
        let bytes = Zeroizing::new(
            BASE64
                .decode(encoded.as_bytes())
                .or_else(|_| BASE64_NOPAD.decode(encoded.as_bytes()))
                .map_err(|_| INVALID)?,
        );
        let mut reader = Reader::new(&bytes);
        let mut seen = HashSet::new();
        let (mut version, mut size, mut index, mut id) = (0, 1, 0, 0);
        let start = entries.len();
        while let Some((field, wire)) = reader.tag()? {
            if (2..=5).contains(&field) && !seen.insert(field) {
                return Err(INVALID.into());
            }
            match field {
                1 => {
                    if entries.len() >= MAX_ENTRIES {
                        return Err(INVALID.into());
                    }
                    entries.push(entry(reader.bytes(wire)?)?);
                }
                2 => version = reader.number(wire)?,
                3 => size = reader.number(wire)?,
                4 => index = reader.number(wire)?,
                5 => id = reader.number(wire)?,
                _ => reader.skip(wire)?,
            }
        }
        // Observed Google v2 exports use the same OTP and batch wire fields as v1.
        // Accept these explicitly; an unknown future format must not be guessed.
        if !matches!(version, 1 | 2) {
            return Err(UNSUPPORTED_VERSION.into());
        }
        if size == 0 || size > MAX_PARTS as u64 || index >= size || entries.len() == start {
            return Err(INVALID.into());
        }
        if batch.is_some_and(|previous| previous != (version, size, id)) {
            return Err(
                "Google export QR codes belong to different batches. Start a new import.".into(),
            );
        }
        if !indices.insert(index) {
            return Err("This Google export QR has already been added.".into());
        }
        batch = Some((version, size, id));
    }
    Ok(Export {
        entries,
        parts: indices.len(),
        expected: batch.ok_or(INVALID)?.1 as usize,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn varint(mut value: u64) -> Vec<u8> {
        let mut bytes = vec![];
        while value >= 128 {
            bytes.push((value as u8 & 127) | 128);
            value >>= 7;
        }
        bytes.push(value as u8);
        bytes
    }
    fn number(field: u64, value: u64) -> Vec<u8> {
        [varint(field << 3), varint(value)].concat()
    }
    fn blob(field: u64, bytes: &[u8]) -> Vec<u8> {
        [
            varint(field << 3 | 2),
            varint(bytes.len() as u64),
            bytes.to_vec(),
        ]
        .concat()
    }
    pub fn fixture(names: &[&str], size: u64, index: u64, id: u64, kind: u64) -> String {
        fixture_version(names, size, index, id, kind, 1)
    }

    pub fn fixture_version(
        names: &[&str],
        size: u64,
        index: u64,
        id: u64,
        kind: u64,
        version: u64,
    ) -> String {
        let mut bytes = vec![];
        for name in names {
            let entry = [
                blob(1, b"12345678901234567890"),
                blob(2, name.as_bytes()),
                blob(3, b"Example"),
                number(4, 1),
                number(5, 1),
                number(6, kind),
            ]
            .concat();
            bytes.extend(blob(1, &entry));
        }
        bytes.extend(
            [
                number(2, version),
                number(3, size),
                number(4, index),
                number(5, id),
            ]
            .concat(),
        );
        format!(
            "otpauth-migration://offline?data={}",
            percent_encoding::utf8_percent_encode(
                &BASE64.encode(&bytes),
                percent_encoding::NON_ALPHANUMERIC
            )
        )
    }

    #[test]
    fn accepts_version_two_multi_part_exports_with_the_same_otp_wire_fields() {
        // Reproduce the observed v2 structure with entirely synthetic accounts/keys.
        let names: Vec<String> = (0..12)
            .map(|n| format!("synthetic-{n}@example.invalid"))
            .collect();
        let first: Vec<&str> = names[..10].iter().map(String::as_str).collect();
        let second: Vec<&str> = names[10..].iter().map(String::as_str).collect();
        let a = fixture_version(&first, 2, 0, 81, 2, 2);
        let b = fixture_version(&second, 2, 1, 81, 2, 2);
        let partial = parse(std::slice::from_ref(&a)).unwrap();
        assert!(!partial.preview(&[]).complete);
        let all = parse(&[a, b]).unwrap();
        let preview = all.preview(&[]);
        assert!(preview.complete);
        assert_eq!(preview.entries.len(), 12);
        assert!(preview.entries.iter().all(|e| e.reason.is_none()));
        assert_eq!(all.entries[11].account.account, names[11]);
        assert_eq!(all.entries[11].secret.as_slice(), b"12345678901234567890");
    }

    #[test]
    fn rejects_future_versions_without_echoing_private_export_data() {
        for version in [0, 3, u64::MAX] {
            let uri = fixture_version(&["synthetic@example.invalid"], 1, 0, 82, 2, version);
            let error = parse(std::slice::from_ref(&uri)).err().unwrap();
            assert_eq!(error, UNSUPPORTED_VERSION);
            assert!(!error.contains(&uri));
            assert!(!error.contains("synthetic@example.invalid"));
        }
        assert!(parse(&[
            fixture_version(&["first"], 2, 0, 83, 2, 1),
            fixture_version(&["second"], 2, 1, 83, 2, 2),
        ])
        .is_err());
    }

    #[test]
    fn parses_export_without_serializing_secrets_and_tracks_all_parts() {
        let a = fixture(&["Example:alice@example.invalid"], 2, 0, 77, 2);
        let b = fixture(&["bob@example.invalid"], 2, 1, 77, 2);
        let first = parse(std::slice::from_ref(&a)).unwrap();
        assert!(!first.preview(&[]).complete);
        let all = parse(&[a.clone(), b.clone()]).unwrap();
        let preview = all.preview(&[]);
        assert!(preview.complete);
        assert_eq!(preview.entries[0].account, "alice@example.invalid");
        assert_eq!(all.entries[0].secret.as_slice(), b"12345678901234567890");
        let json = serde_json::to_string(&preview).unwrap();
        assert!(!json.contains("12345678901234567890"));
        assert!(!json.contains("secret"));
        assert!(parse(&[a.clone(), a]).is_err());
        assert!(parse(&[b, fixture(&["a"], 2, 0, 78, 2)]).is_err());
    }

    #[test]
    fn rejects_malformed_wire_uri_and_unsupported_versions_without_echo() {
        for bytes in [
            vec![],
            vec![0],
            vec![10, 255],
            vec![16, 2],
            vec![255; 11],
            vec![10, 3, 0, 0, 0],
        ] {
            let uri = format!("otpauth-migration://offline?data={}", BASE64.encode(&bytes));
            let error = parse(std::slice::from_ref(&uri)).err().unwrap();
            assert!(!error.contains(&uri));
        }
        assert!(parse(&["otpauth-migration://attacker?data=SECRET".into()]).is_err());
        assert!(parse(&["x".repeat(32769)]).is_err());
        assert!(parse(&[fixture(&["a"], 2, 2, 1, 2)]).is_err());
        assert!(parse(&[fixture(&["a"], 0, 0, 1, 2)]).is_err());
    }

    #[test]
    fn reports_hotp_and_duplicate_labels_without_importing_them() {
        let export = parse(&[fixture(&["alice", "alice"], 1, 0, 1, 2)]).unwrap();
        let preview = export.preview(&[]);
        assert!(preview.entries[0].reason.is_none());
        assert_eq!(preview.entries[1].reason, Some("duplicate"));
        let existing = vec![export.entries[0].account.clone()];
        assert_eq!(
            export.preview(&existing).entries[0].reason,
            Some("duplicate")
        );
        let hotp = parse(&[fixture(&["counter"], 1, 0, 2, 1)]).unwrap();
        assert_eq!(hotp.preview(&[]).entries[0].reason, Some("hotp"));
    }

    #[test]
    fn validates_enum_variants_and_protobuf_boundaries() {
        for algorithm in 0..=4 {
            for digits in 0..=3 {
                let bytes = [
                    blob(1, b"12345678901234567890"),
                    blob(2, b"test"),
                    number(4, algorithm),
                    number(5, digits),
                    number(6, 2),
                ]
                .concat();
                let parsed = entry(&bytes).unwrap();
                assert_eq!(
                    parsed.unsupported.is_none(),
                    (1..=3).contains(&algorithm) && (1..=2).contains(&digits)
                );
                if parsed.unsupported.is_none() {
                    assert_eq!(
                        parsed.account.algorithm,
                        ["SHA1", "SHA256", "SHA512"][(algorithm - 1) as usize]
                    );
                    assert_eq!(parsed.account.digits, if digits == 1 { 6 } else { 8 });
                }
            }
        }
        assert!(Reader::new(&[255; 10]).varint().is_err());
        assert!(Reader::new(&[255; 9]).varint().is_err());
        assert_eq!(Reader::new(&varint(u64::MAX)).varint().unwrap(), u64::MAX);
        assert!(Reader::new(&[5, 1]).bytes(2).is_err());
        assert!(Reader::new(&[]).skip(3).is_err());
        let duplicate_secret = [
            blob(1, b"12345678901234567890"),
            blob(1, b"12345678901234567890"),
        ]
        .concat();
        assert!(entry(&duplicate_secret).is_err());
    }

    #[test]
    fn arbitrary_bounded_payloads_do_not_panic() {
        let mut state = 0x5eed_u64;
        for length in 0..512 {
            let bytes: Vec<u8> = (0..length)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    state as u8
                })
                .collect();
            let uri = format!("otpauth-migration://offline?data={}", BASE64.encode(&bytes));
            let _ = parse(&[uri]);
        }
    }
}
