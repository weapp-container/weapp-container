//! Private immutable byte leases shared by one AppService and its consumers.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

pub const BUFFER_URL_MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_LEASES: usize = 1024;
const URL_PREFIX: &str = "wxbuffer://";
const PATH_PREFIX: &str = "__container_buffer_urls/";

#[derive(Default, Debug)]
pub struct BufferUrlStore {
    state: Mutex<State>,
}
#[derive(Default, Debug)]
struct State {
    retired: bool,
    bytes: usize,
    leases: BTreeMap<String, Arc<[u8]>>,
}

impl BufferUrlStore {
    /// Native callback wire is bounded, primitive and independent of guest JSON hooks.
    pub fn invoke_json(&self, operation: &str, input: &str) -> String {
        let result = match operation {
            "create" => self.create_hex(input).map(Value::String),
            "revoke" => self.revoke(input).map(|()| Value::Null),
            _ => Err("unknown buffer URL operation".to_owned()),
        };
        match result {
            Ok(value) => json!({"ok":true,"value":value}).to_string(),
            Err(message) => {
                json!({"ok":false,"error":{"code":"ERR_INVALID_REQUEST","errMsg":message}})
                    .to_string()
            }
        }
    }
    fn create_hex(&self, input: &str) -> Result<String, String> {
        if input.len() > BUFFER_URL_MAX_BYTES * 2 || !input.len().is_multiple_of(2) {
            return Err("buffer URL byte budget exceeded".into());
        }
        let mut bytes = Vec::with_capacity(input.len() / 2);
        for pair in input.as_bytes().as_chunks::<2>().0 {
            let digit = |value: u8| match value {
                b'0'..=b'9' => Some(value - b'0'),
                b'a'..=b'f' => Some(value - b'a' + 10),
                _ => None,
            };
            let high = digit(pair[0]).ok_or("invalid buffer URL byte wire")?;
            let low = digit(pair[1]).ok_or("invalid buffer URL byte wire")?;
            bytes.push(high * 16 + low);
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "buffer URL owner unavailable")?;
        if state.retired {
            return Err("buffer URL owner retired".into());
        }
        if state.leases.len() >= MAX_LEASES
            || bytes.len() > MAX_TOTAL_BYTES.saturating_sub(state.bytes)
        {
            return Err("buffer URL owner budget exceeded".into());
        }
        // Entropy belongs to the native owner. Guest clocks/Math.random and
        // public session IDs never determine a resource capability.
        let mut token = [0_u8; 24];
        getrandom::fill(&mut token).map_err(|_| "buffer URL entropy unavailable")?;
        let hex: String = token.iter().map(|byte| format!("{byte:02x}")).collect();
        let url = format!("{URL_PREFIX}{hex}");
        if state.leases.contains_key(&url) {
            return Err("buffer URL identity collision".into());
        }
        state.bytes += bytes.len();
        state.leases.insert(url.clone(), bytes.into());
        Ok(url)
    }
    pub fn revoke(&self, url: &str) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "buffer URL owner unavailable")?;
        if let Some(bytes) = state.leases.remove(url) {
            state.bytes -= bytes.len();
        }
        Ok(())
    }
    /// Re-check this live owner before every use, including decoded cache hits.
    pub fn resolve(&self, url: &str) -> Result<Arc<[u8]>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "buffer URL owner unavailable")?;
        if state.retired {
            return Err("buffer URL owner retired".into());
        }
        state
            .leases
            .get(url)
            .cloned()
            .ok_or_else(|| "buffer URL is unknown or revoked".into())
    }
    pub fn retire(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.retired = true;
            state.bytes = 0;
            state.leases.clear();
        }
    }
    pub fn resource_path(url: &str) -> Option<String> {
        let token = url.strip_prefix(URL_PREFIX)?;
        (token.len() == 48
            && token
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
        .then(|| format!("{PATH_PREFIX}{token}"))
    }
    pub fn resource_url(path: &str) -> Option<String> {
        let token = path.strip_prefix(PATH_PREFIX)?;
        let url = format!("{URL_PREFIX}{token}");
        (Self::resource_path(&url).as_deref() == Some(path)).then_some(url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leases_are_unique_immutable_and_owner_scoped() {
        let first = BufferUrlStore::default();
        let second = BufferUrlStore::default();
        let a = first.create_hex("0080ff").unwrap();
        let b = first.create_hex("0080ff").unwrap();
        assert_ne!(a, b);
        assert_eq!(&*first.resolve(&a).unwrap(), &[0, 128, 255]);
        assert!(second.resolve(&a).is_err());
        second.revoke(&a).unwrap();
        let published = first.resolve(&a).unwrap();
        first.revoke(&a).unwrap();
        first.revoke(&a).unwrap();
        assert!(first.resolve(&a).is_err());
        assert_eq!(&*published, &[0, 128, 255]);
        assert_eq!(
            BufferUrlStore::resource_url(&BufferUrlStore::resource_path(&b).unwrap()),
            Some(b.clone())
        );
        first.retire();
        assert!(first.resolve(&b).is_err());
        assert!(first.create_hex("").is_err());
    }
    #[test]
    fn revocation_reclaims_both_count_and_byte_quotas() {
        let owner = BufferUrlStore::default();
        let mut urls = Vec::new();
        for _ in 0..MAX_LEASES {
            urls.push(owner.create_hex("").unwrap());
        }
        assert!(owner.create_hex("").is_err());
        owner.revoke(&urls[0]).unwrap();
        owner.create_hex("").unwrap();
        owner.retire();
        let owner = BufferUrlStore::default();
        let wire = "00".repeat(BUFFER_URL_MAX_BYTES);
        let mut urls = Vec::new();
        for _ in 0..MAX_TOTAL_BYTES / BUFFER_URL_MAX_BYTES {
            urls.push(owner.create_hex(&wire).unwrap());
        }
        assert!(owner.create_hex("00").is_err());
        owner.revoke(&urls[0]).unwrap();
        let recovered = owner.create_hex("ff").unwrap();
        assert_eq!(&*owner.resolve(&recovered).unwrap(), &[255]);
        owner.retire();
        let state = owner.state.lock().unwrap();
        assert_eq!(state.bytes, 0);
        assert!(state.leases.is_empty());
    }
    #[test]
    fn malformed_and_over_budget_wires_never_allocate_leases() {
        let owner = BufferUrlStore::default();
        for wire in ["0", "gg", "FF"] {
            assert!(owner.create_hex(wire).is_err());
        }
        assert!(owner
            .create_hex(&"0".repeat(BUFFER_URL_MAX_BYTES * 2 + 2))
            .is_err());
        let empty = owner.create_hex("").unwrap();
        assert!(owner.resolve(&empty).unwrap().is_empty());
        for url in ["wxbuffer://x", "wxbuffer://../x", "wxbuffer://00?x"] {
            assert!(BufferUrlStore::resource_path(url).is_none());
        }
    }
}
