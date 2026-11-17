//! Trusted native storage intent is committed before fallible public effects.
use super::*;
use container_core::{StorageMutation, StorageValue};

fn decode_storage_value(encoded: &str) -> Result<Value, BridgeError> {
    if encoded.len() > container_core::StorageLimits::WECHAT_PLAIN.max_value_bytes as usize {
        return Err(BridgeError::invalid(
            "native storage value exceeds its admission byte limit",
        ));
    }
    // JSON's default recursive parser counts containers differently from the
    // JS proof's root-at-zero depth. Bound nesting before parsing so disabling
    // its default 128 limit only admits the small, explicitly checked window.
    let (mut quoted, mut escaped, mut nesting) = (false, false, 0usize);
    for byte in encoded.bytes() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'[' | b'{' => {
                    nesting += 1;
                    if nesting > 129 {
                        return Err(BridgeError::invalid(
                            "native storage JSON proof depth exceeded",
                        ));
                    }
                }
                b']' | b'}' => {
                    nesting = nesting.checked_sub(1).ok_or_else(|| {
                        BridgeError::invalid("invalid native storage JSON nesting")
                    })?
                }
                _ => {}
            }
        }
    }
    let mut decoder = serde_json::Deserializer::from_str(encoded);
    decoder.disable_recursion_limit();
    let value = Value::deserialize(&mut decoder).map_err(|error| {
        BridgeError::invalid(format!("native storage value encoding failed: {error}"))
    })?;
    decoder.end().map_err(|error| {
        BridgeError::invalid(format!("native storage value encoding failed: {error}"))
    })?;
    let mut pending = vec![(&value, 0usize)];
    let mut nodes = 0usize;
    while let Some((entry, depth)) = pending.pop() {
        nodes += 1;
        if nodes > 1_000_000 || depth > 128 {
            return Err(BridgeError::invalid(
                "native storage JSON proof budget exceeded",
            ));
        }
        match entry {
            Value::Array(entries) => pending.extend(entries.iter().map(|entry| (entry, depth + 1))),
            Value::Object(entries) => {
                pending.extend(entries.values().map(|entry| (entry, depth + 1)))
            }
            _ => {}
        }
    }
    Ok(value)
}

#[derive(Default)]
pub(super) struct StorageTransactions {
    committed: u64,
    acknowledged: u64,
}

impl Session {
    /// Settle successful guest writes before replacing their baseline or
    /// accepting a later host write, even if public event conversion failed.
    pub(super) fn reconcile_engine_storage(&mut self) -> Result<(), BridgeError> {
        self.ensure_engine_execution_healthy()?;
        if !self.engine_provider_available() {
            return Ok(());
        }
        let transactions = match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(
                                BridgeErrorCode::Engine,
                                "QuickJS provider unavailable",
                            )
                        })?
                        .pending_storage_transactions()
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?
                }
                #[cfg(not(feature = "quickjs-native"))]
                Value::Array(Vec::new())
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(BridgeErrorCode::Engine, "V8 provider unavailable")
                        })?
                        .pending_storage_transactions()
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?
                }
                #[cfg(not(feature = "v8-native"))]
                Value::Array(Vec::new())
            }
        };
        self.commit_engine_storage(&[json!({"__storageTransactions":transactions})])
    }

    pub(super) fn commit_engine_storage(&mut self, effects: &[Value]) -> Result<(), BridgeError> {
        let mut transactions = Vec::new();
        // Decode the entire trusted sidecar before mutating anything. Engines
        // remove public aliases and attach this only from their retained ledger.
        for envelope in effects {
            let Some(records) = envelope.get("__storageTransactions") else {
                continue;
            };
            let records = records.as_array().ok_or_else(|| {
                BridgeError::invalid("native storage transactions require an array")
            })?;
            for record in records {
                let sequence = record
                    .get("sequence")
                    .and_then(Value::as_str)
                    .and_then(|sequence| sequence.parse::<u64>().ok())
                    .filter(|sequence| *sequence != 0)
                    .ok_or_else(|| {
                        BridgeError::invalid("native storage transaction requires an identity")
                    })?;
                let patches = record
                    .get("patches")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        BridgeError::invalid("native storage transaction requires patches")
                    })?;
                let mut operations = Vec::with_capacity(patches.len());
                for patch in patches {
                    let key = || {
                        patch
                            .get("key")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .ok_or_else(|| {
                                BridgeError::invalid("native storage patch requires a key")
                            })
                    };
                    let operation = match patch.get("op").and_then(Value::as_str) {
                        Some("clear") => StorageMutation::Clear,
                        Some("remove") => StorageMutation::Remove { key: key()? },
                        Some("set") => {
                            let encoded = patch
                                .get("valueJson")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    BridgeError::invalid(
                                        "native storage set requires an encoded value",
                                    )
                                })?;
                            let undefined = patch
                                .get("undefined")
                                .and_then(Value::as_bool)
                                .ok_or_else(|| {
                                    BridgeError::invalid(
                                        "native storage set requires an undefined marker",
                                    )
                                })?;
                            let value = if undefined {
                                if encoded != "null" {
                                    return Err(BridgeError::invalid(
                                        "native undefined storage value must use null placeholder",
                                    ));
                                }
                                StorageValue::Undefined
                            } else {
                                StorageValue::Json(decode_storage_value(encoded)?)
                            };
                            StorageMutation::Set { key: key()?, value }
                        }
                        _ => {
                            return Err(BridgeError::invalid(
                                "unknown native storage patch operation",
                            ))
                        }
                    };
                    operations.push(operation);
                }
                transactions.push((sequence, operations));
            }
        }
        for (sequence, operations) in transactions {
            if sequence <= self.storage_transactions.committed {
                continue;
            }
            let expected = self
                .storage_transactions
                .committed
                .checked_add(1)
                .ok_or_else(|| {
                    BridgeError::invalid("native storage transaction identity exhausted")
                })?;
            if sequence != expected {
                return Err(BridgeError::invalid(
                    "native storage transaction sequence gap",
                ));
            }
            self.app_service
                .apply_storage_transaction(operations)
                .map_err(|error| {
                    BridgeError::new(
                        BridgeErrorCode::Engine,
                        format!("native storage admission invariant failed: {error}"),
                    )
                })?;
            // Consume identity immediately after core commit, before any ACK
            // can fail. A retry can deliver this prefix again without replay.
            self.storage_transactions.committed = sequence;
            self.engine_storage_stamp = Some(self.app_service.storage().stamp());
        }
        self.acknowledge_engine_storage()
    }

    fn acknowledge_engine_storage(&mut self) -> Result<(), BridgeError> {
        let sequence = self.storage_transactions.committed;
        if self.storage_transactions.acknowledged == sequence {
            return Ok(());
        }
        match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                self.quickjs_engine
                    .as_mut()
                    .ok_or_else(|| {
                        BridgeError::new(BridgeErrorCode::Engine, "QuickJS provider unavailable")
                    })?
                    .acknowledge_storage_transactions(sequence)
                    .map_err(|error| {
                        engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                    })?;
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                self.v8_engine
                    .as_mut()
                    .ok_or_else(|| {
                        BridgeError::new(BridgeErrorCode::Engine, "V8 provider unavailable")
                    })?
                    .acknowledge_storage_transactions(sequence)
                    .map_err(|error| {
                        engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                    })?;
            }
        }
        self.storage_transactions.acknowledged = sequence;
        Ok(())
    }
}
