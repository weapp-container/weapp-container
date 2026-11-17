//! Atomic session storage with a shared, logical JavaScript byte accountant.
//!
//! The accounting contract charges canonical JSON payloads and `[key,payload]`
//! entries. It is a container policy, not a measured WeChat serialization
//! algorithm or the physical size of a persisted snapshot. Encryption and
//! lossless transport of lone UTF16 surrogates belong to other boundaries.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::Arc,
};

/// Lossless top-level storage state, including JavaScript `undefined`.
#[derive(Clone, Debug, PartialEq)]
pub enum StorageValue {
    Json(Value),
    Undefined,
}

impl StorageValue {
    pub fn as_ref(&self) -> StorageValueRef<'_> {
        match self {
            Self::Json(value) => StorageValueRef::Json(value),
            Self::Undefined => StorageValueRef::Undefined,
        }
    }

    fn into_legacy_value(self) -> Value {
        match self {
            Self::Json(value) => value,
            Self::Undefined => Value::Null,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StorageValueRef<'a> {
    Json(&'a Value),
    Undefined,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StorageLimits {
    pub max_value_bytes: u64,
    pub max_total_bytes: u64,
}

impl StorageLimits {
    pub const WECHAT_PLAIN: Self = Self {
        max_value_bytes: 1_048_576,
        max_total_bytes: 10_485_760,
    };
}

impl Default for StorageLimits {
    fn default() -> Self {
        Self::WECHAT_PLAIN
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StorageUsage {
    pub entry_bytes: u64,
    pub key_count: usize,
}

impl StorageUsage {
    pub fn current_size_kib(self) -> u64 {
        self.entry_bytes.div_ceil(1024)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StorageQuotaStatus {
    pub over_total_limit: bool,
    pub oversized_key_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StorageEntryUsage {
    pub value_bytes: u64,
    pub entry_bytes: u64,
}

impl StorageEntryUsage {
    /// Measure logical canonical JSON bytes without materializing another JSON
    /// copy. Undefined is charged as the null placeholder, but stays typed.
    pub fn measure(key: &str, value: StorageValueRef<'_>) -> Result<Self, StorageError> {
        validate_key(key)?;
        let value_bytes = match value {
            StorageValueRef::Json(value) => canonical_value_size(value)?,
            StorageValueRef::Undefined => 4,
        };
        let entry_bytes = checked_add(checked_add(json_string_size(key)?, value_bytes)?, 3)?;
        Ok(Self {
            value_bytes,
            entry_bytes,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum StorageMutation {
    Set { key: String, value: StorageValue },
    Remove { key: String },
    Clear,
}

#[derive(Clone, Debug, PartialEq)]
pub enum StorageReceipt {
    Set {
        key: String,
        previous: Option<StorageValue>,
    },
    Remove {
        key: String,
        previous: Option<StorageValue>,
    },
    Clear {
        removed: usize,
    },
}

/// Opaque process-local freshness identity. It is never serialized or used as
/// authorization for guest effects. Numeric revisions alone can collide after
/// replacing a whole store, cloning it, or wrapping the revision counter.
#[derive(Clone)]
pub struct StorageStamp(Arc<()>);

impl StorageStamp {
    fn fresh() -> Self {
        Self(Arc::new(()))
    }
}

impl PartialEq for StorageStamp {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for StorageStamp {}

impl fmt::Debug for StorageStamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StorageStamp(..)")
    }
}

#[derive(Debug)]
pub struct StorageCommit {
    pub revision_before: u64,
    pub revision_after: u64,
    pub mutated: bool,
    /// Receipts preserve input order, including ineffective removes/clears.
    pub receipts: Vec<StorageReceipt>,
    pub usage: StorageUsage,
    pub stamp: StorageStamp,
}

#[derive(Debug)]
enum PreparedMutation {
    Set {
        key: String,
        value: StorageValue,
        usage: StorageEntryUsage,
    },
    Remove {
        key: String,
    },
    Clear,
}

/// Owned, fully validated operations prepared against one exact live state.
/// Private fields prevent callers from bypassing validation. Runtime must
/// authenticate its guest ledger separately before preparing a transaction.
#[derive(Debug)]
pub struct PreparedStorageTransaction {
    base_stamp: StorageStamp,
    operations: Vec<PreparedMutation>,
    usage: StorageUsage,
    oversized_key_count: usize,
    mutated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageRestorePolicy {
    /// Keep old over-quota data readable and permit writes that do not grow its
    /// total debt. Every newly set value still obeys the per-value limit.
    PreserveLegacy,
    EnforceQuotas,
}

/// Backwards-compatible plaintext snapshot. Undefined entries use null
/// placeholders. Derived byte counters and process-local stamps are omitted.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct StorageSnapshot {
    pub values: BTreeMap<String, Value>,
    #[serde(rename = "undefinedKeys", default)]
    pub undefined_keys: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StorageError {
    EmptyKey,
    ValueQuotaExceeded {
        key: String,
        actual_bytes: u64,
        limit_bytes: u64,
    },
    TotalQuotaExceeded {
        actual_bytes: u64,
        limit_bytes: u64,
    },
    SizeOverflow,
    InvalidNumber,
    StaleTransaction,
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyKey => f.write_str("storage key cannot be empty"),
            Self::ValueQuotaExceeded {
                key,
                actual_bytes,
                limit_bytes,
            } => write!(
                f,
                "storage value for {key:?} uses {actual_bytes} bytes, exceeding {limit_bytes}"
            ),
            Self::TotalQuotaExceeded {
                actual_bytes,
                limit_bytes,
            } => write!(
                f,
                "storage uses {actual_bytes} bytes, exceeding {limit_bytes}"
            ),
            Self::SizeOverflow => f.write_str("storage byte accounting overflow"),
            Self::InvalidNumber => f.write_str("storage number is not a finite JavaScript number"),
            Self::StaleTransaction => {
                f.write_str("storage transaction was prepared against stale state")
            }
        }
    }
}

impl std::error::Error for StorageError {}

/// Session-scoped storage. Hosts can persist the existing snapshot format;
/// quota caches are rebuilt on restore instead of trusting persisted counters.
#[derive(Debug)]
pub struct MemoryStorage {
    values: BTreeMap<String, Value>,
    undefined_keys: BTreeSet<String>,
    entry_sizes: BTreeMap<String, StorageEntryUsage>,
    usage: StorageUsage,
    oversized_key_count: usize,
    limits: StorageLimits,
    revision: u64,
    stamp: StorageStamp,
}

impl Default for MemoryStorage {
    fn default() -> Self {
        Self::with_limits(StorageLimits::default())
    }
}

impl Clone for MemoryStorage {
    fn clone(&self) -> Self {
        Self {
            values: self.values.clone(),
            undefined_keys: self.undefined_keys.clone(),
            entry_sizes: self.entry_sizes.clone(),
            usage: self.usage,
            oversized_key_count: self.oversized_key_count,
            limits: self.limits,
            revision: self.revision,
            stamp: StorageStamp::fresh(),
        }
    }
}

impl PartialEq for MemoryStorage {
    fn eq(&self, other: &Self) -> bool {
        self.values == other.values && self.undefined_keys == other.undefined_keys
    }
}

impl MemoryStorage {
    pub fn with_limits(limits: StorageLimits) -> Self {
        Self {
            values: BTreeMap::new(),
            undefined_keys: BTreeSet::new(),
            entry_sizes: BTreeMap::new(),
            usage: StorageUsage::default(),
            oversized_key_count: 0,
            limits,
            revision: 0,
            stamp: StorageStamp::fresh(),
        }
    }

    /// Kept for existing hosts. New freshness comparisons should use stamp().
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn stamp(&self) -> StorageStamp {
        self.stamp.clone()
    }

    pub fn limits(&self) -> StorageLimits {
        self.limits
    }

    pub fn usage(&self) -> StorageUsage {
        self.usage
    }

    pub fn quota_status(&self) -> StorageQuotaStatus {
        StorageQuotaStatus {
            over_total_limit: self.usage.entry_bytes > self.limits.max_total_bytes,
            oversized_key_count: self.oversized_key_count,
        }
    }

    pub fn entry_usage(&self, key: &str) -> Option<StorageEntryUsage> {
        self.entry_sizes.get(key).copied()
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.values.contains_key(key)
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.values.get(key)
    }

    pub fn get_cloned(&self, key: &str) -> Option<Value> {
        self.values.get(key).cloned()
    }

    pub fn is_undefined(&self, key: &str) -> bool {
        self.undefined_keys.contains(key)
    }

    pub fn value(&self, key: &str) -> Option<StorageValueRef<'_>> {
        self.values.get(key).map(|value| {
            if self.is_undefined(key) {
                StorageValueRef::Undefined
            } else {
                StorageValueRef::Json(value)
            }
        })
    }

    pub fn set(
        &mut self,
        key: impl Into<String>,
        value: Value,
    ) -> Result<Option<Value>, StorageError> {
        self.set_value(key.into(), StorageValue::Json(value))
    }

    pub fn set_undefined(&mut self, key: impl Into<String>) -> Result<Option<Value>, StorageError> {
        self.set_value(key.into(), StorageValue::Undefined)
    }

    fn set_value(
        &mut self,
        key: String,
        value: StorageValue,
    ) -> Result<Option<Value>, StorageError> {
        let commit = self.apply_transaction(vec![StorageMutation::Set { key, value }])?;
        match commit.receipts.into_iter().next() {
            Some(StorageReceipt::Set { previous, .. }) => {
                Ok(previous.map(StorageValue::into_legacy_value))
            }
            _ => unreachable!("one set produces one set receipt"),
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        // Existing infallible callers accept blank/missing removal as a no-op.
        if key.trim().is_empty() {
            return None;
        }
        let commit = self
            .apply_transaction(vec![StorageMutation::Remove { key: key.into() }])
            .expect("removing a valid key cannot increase storage usage");
        match commit.receipts.into_iter().next() {
            Some(StorageReceipt::Remove { previous, .. }) => {
                previous.map(StorageValue::into_legacy_value)
            }
            _ => unreachable!("one remove produces one remove receipt"),
        }
    }

    pub fn clear(&mut self) -> usize {
        let commit = self
            .apply_transaction(vec![StorageMutation::Clear])
            .expect("clearing storage cannot increase storage usage");
        match commit.receipts.into_iter().next() {
            Some(StorageReceipt::Clear { removed }) => removed,
            _ => unreachable!("one clear produces one clear receipt"),
        }
    }

    /// Validation and quota simulation do not mutate live state. Only metadata
    /// for touched keys is overlaid; existing JSON values are not cloned.
    pub fn prepare_transaction(
        &self,
        operations: Vec<StorageMutation>,
    ) -> Result<PreparedStorageTransaction, StorageError> {
        let mut overlay = BTreeMap::<String, Option<StorageEntryUsage>>::new();
        let mut cleared = false;
        let mut usage = self.usage;
        let mut oversized_key_count = self.oversized_key_count;
        let mut prepared = Vec::with_capacity(operations.len());
        let mut mutated = false;
        for operation in operations {
            match operation {
                StorageMutation::Set { key, value } => {
                    validate_key(&key)?;
                    let measured = StorageEntryUsage::measure(&key, value.as_ref())?;
                    self.check_value_quota(&key, measured)?;
                    let previous = overlay_usage(&overlay, cleared, &self.entry_sizes, &key);
                    if let Some(previous) = previous {
                        usage.entry_bytes -= previous.entry_bytes;
                        oversized_key_count -=
                            usize::from(previous.value_bytes > self.limits.max_value_bytes);
                    } else {
                        usage.key_count = usage
                            .key_count
                            .checked_add(1)
                            .ok_or(StorageError::SizeOverflow)?;
                    }
                    usage.entry_bytes = checked_add(usage.entry_bytes, measured.entry_bytes)?;
                    overlay.insert(key.clone(), Some(measured));
                    prepared.push(PreparedMutation::Set {
                        key,
                        value,
                        usage: measured,
                    });
                    mutated = true;
                }
                StorageMutation::Remove { key } => {
                    validate_key(&key)?;
                    if let Some(previous) =
                        overlay_usage(&overlay, cleared, &self.entry_sizes, &key)
                    {
                        usage.entry_bytes -= previous.entry_bytes;
                        usage.key_count -= 1;
                        oversized_key_count -=
                            usize::from(previous.value_bytes > self.limits.max_value_bytes);
                        mutated = true;
                    }
                    overlay.insert(key.clone(), None);
                    prepared.push(PreparedMutation::Remove { key });
                }
                StorageMutation::Clear => {
                    mutated |= usage.key_count != 0;
                    usage = StorageUsage::default();
                    oversized_key_count = 0;
                    overlay.clear();
                    cleared = true;
                    prepared.push(PreparedMutation::Clear);
                }
            }
        }
        // Preserve an imported legacy overage without allowing it to grow.
        let total_ceiling = self.limits.max_total_bytes.max(self.usage.entry_bytes);
        if usage.entry_bytes > total_ceiling {
            return Err(StorageError::TotalQuotaExceeded {
                actual_bytes: usage.entry_bytes,
                limit_bytes: total_ceiling,
            });
        }
        Ok(PreparedStorageTransaction {
            base_stamp: self.stamp(),
            operations: prepared,
            usage,
            oversized_key_count,
            mutated,
        })
    }

    /// After the initial stamp check publication has no ordinary error path,
    /// serialization, guest callback or quota check. A process allocator abort
    /// is outside the recovery guarantees of this in-memory transaction.
    pub fn commit_transaction(
        &mut self,
        prepared: PreparedStorageTransaction,
    ) -> Result<StorageCommit, StorageError> {
        if self.stamp != prepared.base_stamp {
            return Err(StorageError::StaleTransaction);
        }
        let revision_before = self.revision;
        let next_stamp = if prepared.mutated {
            StorageStamp::fresh()
        } else {
            self.stamp()
        };
        let mut receipts = Vec::with_capacity(prepared.operations.len());
        for operation in prepared.operations {
            match operation {
                PreparedMutation::Set { key, value, usage } => {
                    let was_undefined = self.undefined_keys.remove(&key);
                    let undefined = matches!(value, StorageValue::Undefined);
                    let previous = self.values.insert(key.clone(), value.into_legacy_value());
                    if undefined {
                        self.undefined_keys.insert(key.clone());
                    }
                    self.entry_sizes.insert(key.clone(), usage);
                    receipts.push(StorageReceipt::Set {
                        key,
                        previous: typed_previous(previous, was_undefined),
                    });
                }
                PreparedMutation::Remove { key } => {
                    let was_undefined = self.undefined_keys.remove(&key);
                    let previous = self.values.remove(&key);
                    self.entry_sizes.remove(&key);
                    receipts.push(StorageReceipt::Remove {
                        key,
                        previous: typed_previous(previous, was_undefined),
                    });
                }
                PreparedMutation::Clear => {
                    let removed = self.values.len();
                    self.values.clear();
                    self.undefined_keys.clear();
                    self.entry_sizes.clear();
                    receipts.push(StorageReceipt::Clear { removed });
                }
            }
        }
        self.usage = prepared.usage;
        self.oversized_key_count = prepared.oversized_key_count;
        if prepared.mutated {
            self.revision = self.revision.wrapping_add(1);
        }
        self.stamp = next_stamp;
        Ok(StorageCommit {
            revision_before,
            revision_after: self.revision,
            mutated: prepared.mutated,
            receipts,
            usage: self.usage,
            stamp: self.stamp(),
        })
    }

    pub fn apply_transaction(
        &mut self,
        operations: Vec<StorageMutation>,
    ) -> Result<StorageCommit, StorageError> {
        let prepared = self.prepare_transaction(operations)?;
        self.commit_transaction(prepared)
    }

    /// Legacy JSON snapshot with null placeholders for undefined entries.
    pub fn snapshot(&self) -> BTreeMap<String, Value> {
        self.values.clone()
    }

    pub fn snapshot_state(&self) -> StorageSnapshot {
        StorageSnapshot {
            values: self.values.clone(),
            undefined_keys: self.undefined_keys.clone(),
        }
    }

    pub fn restore_state(&mut self, state: StorageSnapshot) -> Result<(), StorageError> {
        self.restore_state_with_policy(state, StorageRestorePolicy::PreserveLegacy)
    }

    pub fn restore(&mut self, values: BTreeMap<String, Value>) -> Result<(), StorageError> {
        self.restore_state(StorageSnapshot {
            values,
            undefined_keys: BTreeSet::new(),
        })
    }

    /// Normalize and measure an entire snapshot before replacing live state.
    /// Default restores preserve old over-quota data instead of truncating it
    /// or preventing an existing application's startup/reload.
    pub fn restore_state_with_policy(
        &mut self,
        mut state: StorageSnapshot,
        policy: StorageRestorePolicy,
    ) -> Result<(), StorageError> {
        for key in state.values.keys().chain(state.undefined_keys.iter()) {
            validate_key(key)?;
        }
        for key in &state.undefined_keys {
            state.values.insert(key.clone(), Value::Null);
        }
        let mut entry_sizes = BTreeMap::new();
        let mut usage = StorageUsage {
            entry_bytes: 0,
            key_count: state.values.len(),
        };
        let mut oversized_key_count = 0;
        for (key, value) in &state.values {
            let value = if state.undefined_keys.contains(key) {
                StorageValueRef::Undefined
            } else {
                StorageValueRef::Json(value)
            };
            let measured = StorageEntryUsage::measure(key, value)?;
            oversized_key_count += usize::from(measured.value_bytes > self.limits.max_value_bytes);
            if policy == StorageRestorePolicy::EnforceQuotas {
                self.check_value_quota(key, measured)?;
            }
            usage.entry_bytes = checked_add(usage.entry_bytes, measured.entry_bytes)?;
            entry_sizes.insert(key.clone(), measured);
        }
        if policy == StorageRestorePolicy::EnforceQuotas
            && usage.entry_bytes > self.limits.max_total_bytes
        {
            return Err(StorageError::TotalQuotaExceeded {
                actual_bytes: usage.entry_bytes,
                limit_bytes: self.limits.max_total_bytes,
            });
        }
        let stamp = StorageStamp::fresh();
        self.values = state.values;
        self.undefined_keys = state.undefined_keys;
        self.entry_sizes = entry_sizes;
        self.usage = usage;
        self.oversized_key_count = oversized_key_count;
        self.revision = self.revision.wrapping_add(1);
        self.stamp = stamp;
        Ok(())
    }

    fn check_value_quota(&self, key: &str, usage: StorageEntryUsage) -> Result<(), StorageError> {
        if usage.value_bytes > self.limits.max_value_bytes {
            return Err(StorageError::ValueQuotaExceeded {
                key: key.into(),
                actual_bytes: usage.value_bytes,
                limit_bytes: self.limits.max_value_bytes,
            });
        }
        Ok(())
    }
}

fn overlay_usage(
    overlay: &BTreeMap<String, Option<StorageEntryUsage>>,
    cleared: bool,
    stored: &BTreeMap<String, StorageEntryUsage>,
    key: &str,
) -> Option<StorageEntryUsage> {
    match overlay.get(key) {
        Some(value) => *value,
        None if cleared => None,
        None => stored.get(key).copied(),
    }
}

fn typed_previous(value: Option<Value>, undefined: bool) -> Option<StorageValue> {
    value.map(|value| {
        if undefined {
            StorageValue::Undefined
        } else {
            StorageValue::Json(value)
        }
    })
}

fn validate_key(key: &str) -> Result<(), StorageError> {
    if key.trim().is_empty() {
        Err(StorageError::EmptyKey)
    } else {
        Ok(())
    }
}

fn checked_add(left: u64, right: u64) -> Result<u64, StorageError> {
    left.checked_add(right).ok_or(StorageError::SizeOverflow)
}

fn count(value: usize) -> Result<u64, StorageError> {
    u64::try_from(value).map_err(|_| StorageError::SizeOverflow)
}

fn json_string_size(text: &str) -> Result<u64, StorageError> {
    let mut size = 2; // opening and closing quotes
    for character in text.chars() {
        let bytes = match character {
            '"' | '\\' | '\u{08}' | '\t' | '\n' | '\u{0c}' | '\r' => 2,
            '\u{00}'..='\u{1f}' => 6,
            _ => character.len_utf8() as u64,
        };
        size = checked_add(size, bytes)?;
    }
    Ok(size)
}

/// Counts canonical JSON bytes iteratively. Key ordering cannot change byte
/// length, so this avoids sorting/materializing objects or recursing on the
/// Rust stack. Numbers use a dedicated ECMAScript formatter, not Rust Display.
fn canonical_value_size(root: &Value) -> Result<u64, StorageError> {
    let mut pending = vec![root];
    let mut size = 0;
    let mut numbers = ryu_js::Buffer::new();
    while let Some(value) = pending.pop() {
        let bytes = match value {
            Value::Null => 4,
            Value::Bool(true) => 4,
            Value::Bool(false) => 5,
            Value::Number(number) => {
                let number = number
                    .as_f64()
                    .filter(|number| number.is_finite())
                    .ok_or(StorageError::InvalidNumber)?;
                count(numbers.format_finite(number).len())?
            }
            Value::String(text) => json_string_size(text)?,
            Value::Array(values) => {
                pending.extend(values.iter());
                checked_add(2, count(values.len().saturating_sub(1))?)?
            }
            Value::Object(values) => {
                let mut bytes = checked_add(2, count(values.len().saturating_sub(1))?)?;
                for (key, value) in values {
                    bytes = checked_add(bytes, checked_add(json_string_size(key)?, 1)?)?;
                    pending.push(value);
                }
                bytes
            }
        };
        size = checked_add(size, bytes)?;
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn set(key: &str, value: Value) -> StorageMutation {
        StorageMutation::Set {
            key: key.into(),
            value: StorageValue::Json(value),
        }
    }

    fn remove(key: &str) -> StorageMutation {
        StorageMutation::Remove { key: key.into() }
    }

    fn small_store(value: u64, total: u64) -> MemoryStorage {
        MemoryStorage::with_limits(StorageLimits {
            max_value_bytes: value,
            max_total_bytes: total,
        })
    }

    fn assert_unchanged(
        store: &MemoryStorage,
        snapshot: &StorageSnapshot,
        usage: StorageUsage,
        revision: u64,
        stamp: &StorageStamp,
    ) {
        assert_eq!(&store.snapshot_state(), snapshot);
        assert_eq!(store.usage(), usage);
        assert_eq!(store.revision(), revision);
        assert_eq!(&store.stamp(), stamp);
    }

    #[test]
    fn canonical_accounting_matches_ecmascript_numbers_utf8_and_json_structure() {
        let cases = [
            (json!(null), 4),
            (json!(false), 5),
            (json!(""), 2),
            (json!("é"), 4),
            (json!("😀"), 6),
            (json!("\n"), 4),
            (json!("\0"), 8),
            (json!("\"\\"), 6),
            (json!("\u{2028}\u{2029}"), 8),
            (json!(1), 1),
            (json!(1.0), 1),
            (json!(-0.0), 1),
            (json!(1e20), 21),
            (json!(1e21), 5),
            (json!(1e-6), 8),
            (json!(1e-7), 4),
            (json!([1.0, null, "é"]), 13),
            (json!({"😀": [false, 1.0]}), 18),
            (json!(u64::MAX), 20),
        ];
        for (value, expected) in cases {
            let measured = StorageEntryUsage::measure("k", StorageValueRef::Json(&value)).unwrap();
            assert_eq!(measured.value_bytes, expected, "{value:?}");
            assert_eq!(measured.entry_bytes, expected + 6, "{value:?}");
        }
        assert_eq!(
            StorageEntryUsage::measure("é", StorageValueRef::Undefined).unwrap(),
            StorageEntryUsage {
                value_bytes: 4,
                entry_bytes: 11,
            }
        );
    }

    #[test]
    fn canonical_number_decoding_preserves_javascript_bits_and_quota_bytes() {
        // These are JS JSON.stringify outputs. serde_json's approximate
        // float parser changed their bits; the second then cost an extra byte.
        for (encoded, bits) in [
            ("1.9430538399282263e-44", 0x36dbbb70e036180fu64),
            ("4.501222173364241e-13", 0x3d5facae56160c35u64),
        ] {
            let value: Value = serde_json::from_str(encoded).unwrap();
            assert_eq!(value.as_f64().unwrap().to_bits(), bits);
            let usage =
                StorageEntryUsage::measure("number", StorageValueRef::Json(&value)).unwrap();
            assert_eq!(usage.value_bytes, encoded.len() as u64);
        }
    }

    #[test]
    fn typed_receipts_and_legacy_returns_keep_undefined_null_and_absent_distinct() {
        let mut store = MemoryStorage::default();
        assert_eq!(store.set_undefined("u").unwrap(), None);
        assert_eq!(store.value("u"), Some(StorageValueRef::Undefined));
        assert_eq!(store.value("missing"), None);
        assert_eq!(store.get("u"), Some(&Value::Null));
        assert_eq!(store.set("u", Value::Null).unwrap(), Some(Value::Null));
        assert_eq!(store.value("u"), Some(StorageValueRef::Json(&Value::Null)));
        let commit = store
            .apply_transaction(vec![
                StorageMutation::Set {
                    key: "u".into(),
                    value: StorageValue::Undefined,
                },
                remove("u"),
                set("u", json!(7)),
                remove("absent"),
            ])
            .unwrap();
        assert_eq!(
            commit.receipts,
            vec![
                StorageReceipt::Set {
                    key: "u".into(),
                    previous: Some(StorageValue::Json(Value::Null)),
                },
                StorageReceipt::Remove {
                    key: "u".into(),
                    previous: Some(StorageValue::Undefined),
                },
                StorageReceipt::Set {
                    key: "u".into(),
                    previous: None,
                },
                StorageReceipt::Remove {
                    key: "absent".into(),
                    previous: None,
                },
            ]
        );
        assert_eq!(store.get("u"), Some(&json!(7)));
        assert!(!store.is_undefined("u"));
        store.set_undefined("u").unwrap();
        assert_eq!(store.remove("u"), Some(Value::Null));
    }

    #[test]
    fn invalid_later_operations_never_publish_a_transaction_prefix() {
        let mut store = small_store(8, 20);
        store.set_undefined("u").unwrap();
        let before = store.snapshot_state();
        let usage = store.usage();
        let revision = store.revision();
        let stamp = store.stamp();
        for operations in [
            vec![StorageMutation::Clear, set(" ", json!(1))],
            vec![set("x", json!(1)), remove("\n")],
            vec![StorageMutation::Clear, set("x", json!("1234567"))],
            vec![set("x", json!(null)), set("y", json!(null))],
            // An oversized input is invalid even if a later clear hides it.
            vec![set("x", json!("1234567")), StorageMutation::Clear],
        ] {
            assert!(store.apply_transaction(operations).is_err());
            assert_unchanged(&store, &before, usage, revision, &stamp);
        }
    }

    #[test]
    fn quotas_use_final_state_and_ordered_duplicate_updates() {
        let mut store = small_store(8, 14);
        store.set("a", json!("123456")).unwrap();
        // The intermediate overlay exceeds total quota; final state fits.
        let commit = store
            .apply_transaction(vec![set("b", json!("123456")), remove("a")])
            .unwrap();
        assert_eq!(commit.revision_after, commit.revision_before + 1);
        assert_eq!(store.usage().entry_bytes, 14);
        assert_eq!(store.len(), 1);
        let commit = store
            .apply_transaction(vec![
                set("b", json!(1)),
                set("b", json!(2)),
                StorageMutation::Clear,
                set("c", Value::Null),
            ])
            .unwrap();
        assert_eq!(
            commit.receipts[1],
            StorageReceipt::Set {
                key: "b".into(),
                previous: Some(StorageValue::Json(json!(1)))
            }
        );
        assert_eq!(commit.receipts[2], StorageReceipt::Clear { removed: 1 });
        assert_eq!(
            store.snapshot(),
            BTreeMap::from([("c".into(), Value::Null)])
        );
        assert_eq!(
            store.usage(),
            StorageUsage {
                entry_bytes: 10,
                key_count: 1
            }
        );
    }

    #[test]
    fn single_mutations_share_exact_quota_boundaries_and_release_usage() {
        let mut store = small_store(4, 10);
        store.set("k", Value::Null).unwrap();
        assert_eq!(store.usage().entry_bytes, 10);
        assert!(matches!(
            store.set("k", json!(false)),
            Err(StorageError::ValueQuotaExceeded {
                actual_bytes: 5,
                ..
            })
        ));
        assert!(matches!(
            store.set("x", json!(0)),
            Err(StorageError::TotalQuotaExceeded { .. })
        ));
        store.set("k", json!(0)).unwrap();
        assert_eq!(store.usage().entry_bytes, 7);
        assert_eq!(store.remove("k"), Some(json!(0)));
        assert_eq!(store.usage(), StorageUsage::default());
        store.set_undefined("x").unwrap();
        assert_eq!(store.clear(), 1);
        assert_eq!(store.entry_usage("x"), None);
        assert_eq!(store.usage().current_size_kib(), 0);
        assert_eq!(
            StorageUsage {
                entry_bytes: 1024,
                key_count: 1
            }
            .current_size_kib(),
            1
        );
        assert_eq!(
            StorageUsage {
                entry_bytes: 1025,
                key_count: 1
            }
            .current_size_kib(),
            2
        );
    }

    #[test]
    fn default_per_value_limit_counts_the_encoded_payload() {
        let mut store = MemoryStorage::default();
        assert_eq!(store.limits(), StorageLimits::WECHAT_PLAIN);
        let value = Value::String("a".repeat(1_048_574));
        store.set("k", value.clone()).unwrap();
        assert_eq!(store.entry_usage("k").unwrap().value_bytes, 1_048_576);
        let stamp = store.stamp();
        assert!(matches!(
            store.set("k", Value::String("a".repeat(1_048_575))),
            Err(StorageError::ValueQuotaExceeded {
                actual_bytes: 1_048_577,
                ..
            })
        ));
        assert_eq!(store.get("k"), Some(&value));
        assert_eq!(store.stamp(), stamp);
    }

    #[test]
    fn stale_preparations_cannot_commit_after_mutation_restore_clone_or_replacement() {
        let mut store = MemoryStorage::default();
        store.set("a", json!(1)).unwrap();
        let valid = store.prepare_transaction(vec![set("b", json!(2))]).unwrap();
        assert_eq!(store.set(" ", json!(0)), Err(StorageError::EmptyKey));
        store.commit_transaction(valid).unwrap();
        let stale = store.prepare_transaction(vec![set("c", json!(3))]).unwrap();
        store.set("a", json!(1)).unwrap();
        let before = store.snapshot_state();
        let stamp = store.stamp();
        assert!(matches!(
            store.commit_transaction(stale),
            Err(StorageError::StaleTransaction)
        ));
        assert_eq!(store.snapshot_state(), before);
        assert_eq!(store.stamp(), stamp);
        let stale = store.prepare_transaction(vec![set("c", json!(3))]).unwrap();
        let mut cloned = store.clone();
        assert_eq!(store, cloned);
        assert_eq!(store.revision(), cloned.revision());
        assert_ne!(store.stamp(), cloned.stamp());
        assert!(matches!(
            cloned.commit_transaction(stale),
            Err(StorageError::StaleTransaction)
        ));
        let stale = store.prepare_transaction(vec![set("c", json!(3))]).unwrap();
        store = store.clone();
        assert!(matches!(
            store.commit_transaction(stale),
            Err(StorageError::StaleTransaction)
        ));
        let stale = store.prepare_transaction(vec![set("c", json!(3))]).unwrap();
        store.restore_state(store.snapshot_state()).unwrap();
        assert!(matches!(
            store.commit_transaction(stale),
            Err(StorageError::StaleTransaction)
        ));
    }

    #[test]
    fn revisions_count_atomic_mutation_intent_and_stamps_survive_numeric_wrap() {
        let mut store = MemoryStorage::default();
        let original_stamp = store.stamp();
        assert!(!store.apply_transaction(vec![]).unwrap().mutated);
        assert_eq!(store.remove(""), None);
        assert_eq!(store.remove("missing"), None);
        assert_eq!(store.clear(), 0);
        assert_eq!(store.revision(), 0);
        assert_eq!(store.stamp(), original_stamp);
        let noop = store
            .apply_transaction(vec![remove("missing"), StorageMutation::Clear])
            .unwrap();
        assert!(!noop.mutated);
        assert_eq!(noop.receipts.len(), 2);
        store.set("a", json!(1)).unwrap();
        store.set("a", json!(1)).unwrap();
        assert_eq!(store.revision(), 2);
        let commit = store
            .apply_transaction(vec![set("b", json!(2)), remove("b")])
            .unwrap();
        assert!(commit.mutated);
        assert_eq!(store.revision(), 3);
        store.revision = u64::MAX;
        let before_wrap = store.stamp();
        let stale = store.prepare_transaction(vec![set("b", json!(2))]).unwrap();
        store.set("a", json!(1)).unwrap();
        assert_eq!(store.revision(), 0);
        assert_ne!(store.stamp(), before_wrap);
        assert!(matches!(
            store.commit_transaction(stale),
            Err(StorageError::StaleTransaction)
        ));
    }

    #[test]
    fn preserve_legacy_restore_recovers_without_truncation_or_new_overages() {
        let mut store = small_store(8, 20);
        let old = StorageSnapshot {
            values: BTreeMap::from([("a".into(), json!("0123456789")), ("b".into(), Value::Null)]),
            undefined_keys: BTreeSet::new(),
        };
        store.restore_state(old.clone()).unwrap();
        assert_eq!(store.snapshot_state(), old);
        assert_eq!(store.usage().entry_bytes, 28);
        assert_eq!(
            store.quota_status(),
            StorageQuotaStatus {
                over_total_limit: true,
                oversized_key_count: 1
            }
        );
        store.set("b", Value::Null).unwrap(); // same-size legacy debt is accepted
        assert!(matches!(
            store.set("b", json!(false)),
            Err(StorageError::TotalQuotaExceeded { .. })
        ));
        assert!(matches!(
            store.set("a", json!("1234567")),
            Err(StorageError::ValueQuotaExceeded { .. })
        ));
        store.set("a", json!("123456")).unwrap();
        assert_eq!(store.usage().entry_bytes, 24);
        assert_eq!(store.quota_status().oversized_key_count, 0);
        store.remove("b");
        assert_eq!(store.usage().entry_bytes, 14);
        assert!(!store.quota_status().over_total_limit);
        assert!(store.set("c", Value::Null).is_err());
        store.clear();
        assert_eq!(store.quota_status(), StorageQuotaStatus::default());
        store.set("c", Value::Null).unwrap();
    }

    #[test]
    fn strict_and_invalid_restore_fail_atomically_and_keep_preparations_current() {
        let mut store = small_store(4, 10);
        store.set("a", json!(1)).unwrap();
        let prepared = store.prepare_transaction(vec![set("a", json!(2))]).unwrap();
        let before = store.snapshot_state();
        let usage = store.usage();
        let revision = store.revision();
        let stamp = store.stamp();
        for snapshot in [
            StorageSnapshot {
                values: BTreeMap::from([("a".into(), json!(false))]),
                undefined_keys: BTreeSet::new(),
            },
            StorageSnapshot {
                values: BTreeMap::from([("a".into(), Value::Null), ("b".into(), Value::Null)]),
                undefined_keys: BTreeSet::new(),
            },
            StorageSnapshot {
                values: BTreeMap::new(),
                undefined_keys: BTreeSet::from([" ".into()]),
            },
        ] {
            assert!(store
                .restore_state_with_policy(snapshot, StorageRestorePolicy::EnforceQuotas)
                .is_err());
            assert_unchanged(&store, &before, usage, revision, &stamp);
        }
        store.commit_transaction(prepared).unwrap();
    }

    #[test]
    fn old_snapshot_shape_and_marker_normalization_remain_backwards_compatible() {
        let old: StorageSnapshot = serde_json::from_value(json!({"values":{"plain":7}})).unwrap();
        let mut store = MemoryStorage::default();
        store.restore_state(old).unwrap();
        let state = StorageSnapshot {
            values: BTreeMap::from([
                ("overridden".into(), json!(99)),
                ("null".into(), Value::Null),
            ]),
            undefined_keys: BTreeSet::from(["overridden".into(), "marker-only".into()]),
        };
        store.restore_state(state).unwrap();
        assert_eq!(store.value("marker-only"), Some(StorageValueRef::Undefined));
        assert_eq!(store.value("overridden"), Some(StorageValueRef::Undefined));
        assert_eq!(
            store.value("null"),
            Some(StorageValueRef::Json(&Value::Null))
        );
        let encoded = serde_json::to_value(store.snapshot_state()).unwrap();
        assert_eq!(encoded.as_object().unwrap().len(), 2);
        assert!(encoded.get("values").is_some());
        assert!(encoded.get("undefinedKeys").is_some());
        let mut restarted = MemoryStorage::default();
        restarted
            .restore_state(serde_json::from_value(encoded).unwrap())
            .unwrap();
        assert_eq!(store, restarted);
        assert_eq!(store.usage(), restarted.usage());
        store.restore(store.snapshot()).unwrap();
        assert!(!store.is_undefined("marker-only"));
    }

    #[test]
    fn existing_runtime_wrapper_event_behavior_is_unchanged() {
        use crate::{ContainerRuntime, RuntimeEvent, StorageOperation};
        let mut runtime = ContainerRuntime::default();
        *runtime.storage_mut() = small_store(1, 7);
        assert!(runtime.set_storage("a", json!(false)).is_err());
        assert!(runtime.drain_events().is_empty());
        runtime.remove_storage("missing");
        runtime.clear_storage();
        runtime.set_storage("a", json!(1)).unwrap();
        let events = runtime.drain_events();
        assert!(matches!(
            &events[..],
            [
                RuntimeEvent::StorageChanged {
                    operation: StorageOperation::Remove,
                    ..
                },
                RuntimeEvent::StorageChanged {
                    operation: StorageOperation::Clear,
                    ..
                },
                RuntimeEvent::StorageChanged {
                    operation: StorageOperation::Set,
                    ..
                },
            ]
        ));
    }

    #[test]
    fn runtime_transaction_publishes_all_events_after_success_and_none_on_failure() {
        use crate::{ContainerRuntime, RuntimeEvent, StorageOperation};
        let mut runtime = ContainerRuntime::default();
        *runtime.storage_mut() = small_store(4, 10);
        runtime.set_storage_undefined("u").unwrap();
        runtime.drain_events();
        let before = runtime.storage().snapshot_state();
        assert!(runtime
            .apply_storage_transaction(vec![StorageMutation::Clear, set("k", json!(false))])
            .is_err());
        assert!(runtime.drain_events().is_empty());
        assert_eq!(runtime.storage().snapshot_state(), before);
        let commit = runtime
            .apply_storage_transaction(vec![
                remove("missing"),
                StorageMutation::Clear,
                set("k", json!(1)),
                set("k", json!(2)),
            ])
            .unwrap();
        assert_eq!(commit.revision_after, commit.revision_before + 1);
        assert_eq!(runtime.storage().get("k"), Some(&json!(2)));
        assert!(matches!(
            &runtime.drain_events()[..],
            [
                RuntimeEvent::StorageChanged {
                    operation: StorageOperation::Remove,
                    ..
                },
                RuntimeEvent::StorageChanged {
                    operation: StorageOperation::Clear,
                    ..
                },
                RuntimeEvent::StorageChanged {
                    operation: StorageOperation::Set,
                    ..
                },
                RuntimeEvent::StorageChanged {
                    operation: StorageOperation::Set,
                    ..
                },
            ]
        ));
    }
}
