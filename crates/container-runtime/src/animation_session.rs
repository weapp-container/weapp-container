//! Session integration for private animation write reservations and root input
//! snapshots. No public Animation field can choose an owner or mint a stamp.
use super::*;
use crate::animation_bindings::{OwnerKey, PreparedWrites, ScopeSnapshot, WriteSnapshot};
use std::sync::Arc;

pub(super) struct AnimationHostWrite {
    ledger: PreparedWrites,
    ticket: Option<String>,
}
impl Session {
    /// Call only on the native-overwritten metadata from engine effect drain,
    /// before public event processing. Public __dataWrites is stripped by both
    /// adapters and cannot mint this tail. Validate the whole tail first.
    pub(super) fn consume_animation_write_effects(
        &mut self,
        effect: &Value,
    ) -> Result<bool, BridgeError> {
        self.animation_writes.ensure_valid()?;
        let result = (|| {
            let Some(records) = effect.get("__dataWrites") else {
                return Ok(false);
            };
            let records = records
                .as_object()
                .ok_or_else(|| BridgeError::invalid("invalid private animation write tail"))?;
            if records.len() > 100_000 {
                return Err(BridgeError::invalid(
                    "private animation write tail budget exceeded",
                ));
            }
            let decimal = |value: &Value| -> Result<u64, BridgeError> {
                let text = value.as_str().ok_or_else(|| {
                    BridgeError::invalid("invalid private animation write identity")
                })?;
                text.parse::<u64>()
                    .ok()
                    .filter(|number| *number != 0 && number.to_string() == text)
                    .ok_or_else(|| BridgeError::invalid("invalid private animation write identity"))
            };
            let mut parsed = Vec::new();
            let mut bytes = 0usize;
            for record in records.values() {
                let object = record.as_object().ok_or_else(|| {
                    BridgeError::invalid("invalid private animation write receipt")
                })?;
                if object.len() != 7 {
                    return Err(BridgeError::invalid(
                        "invalid private animation write receipt fields",
                    ));
                }
                let page = decimal(&record["pageId"])?;
                let page_incarnation = decimal(&record["pageToken"])?;
                let scope_id = match &record["scopeId"] {
                    Value::Null => None,
                    Value::String(scope) if !scope.is_empty() => Some(scope.clone()),
                    _ => {
                        return Err(BridgeError::invalid(
                            "invalid private animation write scope",
                        ))
                    }
                };
                let instance = decimal(&record["instanceToken"])?;
                if scope_id.is_none() && instance != page_incarnation {
                    return Err(BridgeError::invalid(
                        "private animation write Page incarnation mismatch",
                    ));
                }
                let owner = OwnerKey {
                    page_id: page,
                    page_incarnation,
                    scope_incarnation: scope_id.as_ref().map(|_| instance),
                    scope_id,
                };
                owner.validate()?;
                let stamp = decimal(&record["stamp"])?;
                if !record["local"].is_boolean() {
                    return Err(BridgeError::invalid(
                        "invalid private animation write source",
                    ));
                }
                let paths: Vec<container_ir::BindingDataPath> =
                    serde_json::from_value(record["paths"].clone()).map_err(|_| {
                        BridgeError::invalid("invalid private animation write paths")
                    })?;
                if paths.len() > 100_000 || paths.iter().any(|path| path.len() > 256) {
                    return Err(BridgeError::invalid(
                        "private animation write path budget exceeded",
                    ));
                }
                bytes = bytes.saturating_add(
                    paths
                        .iter()
                        .flat_map(|path| path.iter())
                        .map(|part| match part {
                            container_ir::BindingPathSegment::Key(text) => text.len() + 24,
                            container_ir::BindingPathSegment::Index(_) => 24,
                        })
                        .sum::<usize>(),
                );
                if bytes > 8 * 1024 * 1024 {
                    return Err(BridgeError::invalid(
                        "private animation write byte budget exceeded",
                    ));
                }
                parsed.push((owner, paths, stamp));
            }
            let current = self.app_service.pages().current().map(|page| page.id.0);
            Ok(parsed.iter().any(|(owner, paths, stamp)| {
                Some(owner.page_id) == current
                    && self.animation_bindings.is_visible(owner.page_id)
                    && self.animation_bindings.touches(owner, paths, *stamp)
            }))
        })();
        if result.is_err() {
            self.animation_writes.poison();
            self.animation_bindings.retire_all();
            self.animation_playback.retire_all();
        }
        result
    }

    fn animation_private_capture(&mut self, page: PageId) -> Result<Option<Value>, BridgeError> {
        if !self.engine_provider_available() || self.loaded_modules.is_empty() {
            return Ok(None);
        }
        match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| BridgeError::invalid("QuickJS provider unavailable"))?
                        .capture_animation_write_snapshot(page.0, &[])
                        .map(Some)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    Err(BridgeError::invalid("QuickJS provider unavailable"))
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| BridgeError::invalid("V8 provider unavailable"))?
                        .capture_animation_write_snapshot(page.0, &[])
                        .map(Some)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    Err(BridgeError::invalid("V8 provider unavailable"))
                }
            }
        }
    }
    pub(super) fn capture_animation_root_snapshot(
        &mut self,
        page: PageId,
    ) -> Result<Arc<ScopeSnapshot>, BridgeError> {
        self.animation_writes.ensure_valid()?;
        let capture = self.animation_private_capture(page)?;
        let token = if let Some(capture) = &capture {
            let text = capture
                .get("pageToken")
                .and_then(Value::as_str)
                .ok_or_else(|| BridgeError::invalid("private animation Page token unavailable"))?;
            text.parse::<u64>()
                .ok()
                .filter(|value| *value != 0 && value.to_string() == text)
                .ok_or_else(|| BridgeError::invalid("invalid private animation Page token"))?
        } else {
            page.0
        };
        let owner = OwnerKey {
            page_id: page.0,
            page_incarnation: token,
            scope_id: None,
            scope_incarnation: None,
        };
        let writes = if let Some(capture) = capture {
            WriteSnapshot::from_private(owner, &capture["pageWrites"])?
        } else {
            self.animation_writes.snapshot(&owner)
        };
        Ok(Arc::new(ScopeSnapshot::new(writes)))
    }
    pub(super) fn prepare_animation_host_write(
        &mut self,
        page: PageId,
        patches: &[DataPatch],
    ) -> Result<AnimationHostWrite, BridgeError> {
        let snapshot = self.capture_animation_root_snapshot(page)?;
        let ledger = self
            .animation_writes
            .prepare_patches(&snapshot.owner, patches)?;
        let paths = patches
            .iter()
            .map(|patch| patch.path.clone())
            .collect::<Vec<_>>();
        let ticket = if self.engine_provider_available() && !self.loaded_modules.is_empty() {
            let response: Value = match self.config.engine {
                EngineKind::Quickjs => {
                    #[cfg(feature = "quickjs-native")]
                    {
                        self.quickjs_engine
                            .as_mut()
                            .ok_or_else(|| BridgeError::invalid("QuickJS provider unavailable"))?
                            .prepare_animation_host_writes(page.0, &paths)
                            .map_err(|error| {
                                engine_bridge_error(
                                    error.into_core_error(),
                                    BridgeErrorCode::Engine,
                                )
                            })?
                    }
                    #[cfg(not(feature = "quickjs-native"))]
                    {
                        return Err(BridgeError::invalid("QuickJS provider unavailable"));
                    }
                }
                EngineKind::V8 => {
                    #[cfg(feature = "v8-native")]
                    {
                        self.v8_engine
                            .as_mut()
                            .ok_or_else(|| BridgeError::invalid("V8 provider unavailable"))?
                            .prepare_animation_host_writes(page.0, &paths)
                            .map_err(|error| {
                                engine_bridge_error(
                                    error.into_core_error(),
                                    BridgeErrorCode::Engine,
                                )
                            })?
                    }
                    #[cfg(not(feature = "v8-native"))]
                    {
                        return Err(BridgeError::invalid("V8 provider unavailable"));
                    }
                }
            };
            Some(
                response
                    .get("ticket")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .ok_or_else(|| {
                        BridgeError::invalid("private animation write ticket unavailable")
                    })?
                    .to_owned(),
            )
        } else {
            None
        };
        Ok(AnimationHostWrite { ledger, ticket })
    }
    /// Call after the data transaction, true only if it was accepted. Any
    /// post-write receipt failure is sticky: later snapshots fail closed.
    pub(super) fn finish_animation_host_write(
        &mut self,
        reservation: AnimationHostWrite,
        completed: bool,
    ) -> Result<(), BridgeError> {
        let result = (|| {
            self.animation_writes.validate_record(&reservation.ledger)?;
            if let Some(ticket) = &reservation.ticket {
                match self.config.engine {
                    EngineKind::Quickjs => {
                        #[cfg(feature = "quickjs-native")]
                        {
                            self.quickjs_engine
                                .as_mut()
                                .ok_or_else(|| {
                                    BridgeError::invalid("QuickJS provider unavailable")
                                })?
                                .finish_animation_host_writes(ticket, completed)
                                .map_err(|error| {
                                    engine_bridge_error(
                                        error.into_core_error(),
                                        BridgeErrorCode::Engine,
                                    )
                                })?;
                        }
                        #[cfg(not(feature = "quickjs-native"))]
                        {
                            return Err(BridgeError::invalid("QuickJS provider unavailable"));
                        }
                    }
                    EngineKind::V8 => {
                        #[cfg(feature = "v8-native")]
                        {
                            self.v8_engine
                                .as_mut()
                                .ok_or_else(|| BridgeError::invalid("V8 provider unavailable"))?
                                .finish_animation_host_writes(ticket, completed)
                                .map_err(|error| {
                                    engine_bridge_error(
                                        error.into_core_error(),
                                        BridgeErrorCode::Engine,
                                    )
                                })?;
                        }
                        #[cfg(not(feature = "v8-native"))]
                        {
                            return Err(BridgeError::invalid("V8 provider unavailable"));
                        }
                    }
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            self.animation_writes.poison();
            self.animation_bindings.retire_all();
            self.animation_playback.retire_all();
            return Err(error);
        }
        if completed {
            self.animation_writes.commit_record(reservation.ledger);
        }
        Ok(())
    }
}
