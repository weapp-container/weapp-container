//! Retained selector transport: public API tables/events are never callback
//! authority. Existing native/DOM queues keep their presentation/deadline model.
use super::*;

pub(super) const FIRST_PRIVATE_ID: u64 = 1 << 63;

#[derive(Default)]
pub(super) struct PrivateSelectorState {
    after: u64,
    sequence: u64,
    deliveries: BTreeMap<u64, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapturedRequests {
    requests: Vec<CapturedRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapturedRequest {
    sequence: String,
    ticket: String,
    owner: Option<browser_query::QueryOwner>,
    receivers: Value,
    options: Map<String, Value>,
}

impl Session {
    fn capture_private_selector_requests(&mut self) -> Result<Value, BridgeError> {
        let after = self.private_selectors.after;
        match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| BridgeError::invalid("QuickJS provider unavailable"))?
                        .capture_selector_query_requests(after)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    let _ = after;
                    Err(BridgeError::invalid("QuickJS provider unavailable"))
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| BridgeError::invalid("V8 provider unavailable"))?
                        .capture_selector_query_requests(after)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    let _ = after;
                    Err(BridgeError::invalid("V8 provider unavailable"))
                }
            }
        }
    }

    pub(super) fn selector_receiver_snapshot(
        &mut self,
        api_id: u64,
        page: u64,
        scopes: &[String],
    ) -> Result<Value, BridgeError> {
        if api_id < FIRST_PRIVATE_ID {
            return self.live_receiver_snapshot(page, scopes);
        }
        match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| BridgeError::invalid("QuickJS provider unavailable"))?
                        .capture_selector_query_receivers(page, scopes)
                        .map_err(|error| {
                            let error = error.into_core_error();
                            let fallback = if error.code == container_core::EngineErrorCode::Call {
                                BridgeErrorCode::Cancelled
                            } else {
                                BridgeErrorCode::Engine
                            };
                            engine_bridge_error(error, fallback)
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
                        .capture_selector_query_receivers(page, scopes)
                        .map_err(|error| {
                            let error = error.into_core_error();
                            let fallback = if error.code == container_core::EngineErrorCode::Call {
                                BridgeErrorCode::Cancelled
                            } else {
                                BridgeErrorCode::Engine
                            };
                            engine_bridge_error(error, fallback)
                        })
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    Err(BridgeError::invalid("V8 provider unavailable"))
                }
            }
        }
    }

    pub(super) fn drain_private_selector_queries(&mut self) -> Result<bool, BridgeError> {
        let snapshot = self.capture_private_selector_requests()?;
        let snapshot: CapturedRequests = serde_json::from_value(snapshot).map_err(|error| {
            BridgeError::invalid(format!("invalid private selector requests: {error}"))
        })?;
        if snapshot.requests.len() > 256 {
            return Err(BridgeError::invalid(
                "private selector request budget exceeded",
            ));
        }
        let had_requests = !snapshot.requests.is_empty();
        for request in snapshot.requests {
            let sequence = request
                .sequence
                .parse::<u64>()
                .ok()
                .filter(|value| value.to_string() == request.sequence)
                .ok_or_else(|| BridgeError::invalid("invalid private selector sequence"))?;
            if sequence <= self.private_selectors.after
                || request.ticket != format!("selector:{sequence}")
            {
                return Err(BridgeError::invalid("stale private selector request"));
            }
            let next = self
                .private_selectors
                .sequence
                .checked_add(1)
                .filter(|value| *value < FIRST_PRIVATE_ID)
                .ok_or_else(|| {
                    BridgeError::invalid("private selector native identity exhausted")
                })?;
            let id = FIRST_PRIVATE_ID + next;
            self.private_selectors.sequence = next;
            self.private_selectors.after = sequence;
            self.private_selectors.deliveries.insert(id, request.ticket);
            let admitted = (|| {
                if let Some(owner) = &request.owner {
                    let page = owner
                        .page_id
                        .parse::<u64>()
                        .map_err(|_| BridgeError::invalid("invalid selector page"))?;
                    let scopes = request
                        .receivers
                        .get("scopes")
                        .and_then(Value::as_object)
                        .ok_or_else(|| BridgeError::invalid("invalid selector receiver proof"))?
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>();
                    if self.selector_receiver_snapshot(id, page, &scopes)? != request.receivers {
                        return Err(BridgeError::new(
                            BridgeErrorCode::Cancelled,
                            "selector receiver incarnation was retired",
                        ));
                    }
                } else {
                    if !request.receivers.is_null() {
                        return Err(BridgeError::invalid(
                            "unowned selector has a receiver proof",
                        ));
                    }
                    if !self.legacy_manual_selector_query_embedding() {
                        return Err(BridgeError::new(
                            BridgeErrorCode::Cancelled,
                            "private selector query has no captured Page owner",
                        ));
                    }
                }
                // Created/unmeasured manual native embedding retains its
                // historical unowned extension. The existing native/DOM
                // admission paths still enforce their full lifecycle policy.
                let owner = request
                    .owner
                    .as_ref()
                    .map(serde_json::to_value)
                    .transpose()
                    .map_err(|error| BridgeError::invalid(error.to_string()))?;
                if self.browser_route_active() {
                    self.enqueue_browser_query(id, owner.as_ref(), &request.options)
                } else {
                    self.dispatch_native_query(id, owner.as_ref(), &request.options)
                }
            })();
            if let Err(error) = admitted {
                self.resolve_private_selector_query(id, &Err(error))?;
            }
        }
        Ok(had_requests)
    }

    pub(super) fn resolve_private_selector_query(
        &mut self,
        id: u64,
        result: &Result<Value, BridgeError>,
    ) -> Result<bool, BridgeError> {
        let Some(ticket) = self.private_selectors.deliveries.get(&id).cloned() else {
            return Ok(false);
        };
        let payload = match result {
            Ok(result) => json!({"ticket":ticket,"result":result,"error":null}),
            Err(error) => {
                json!({"ticket":ticket,"result":null,"error":async_host::host_error_payload("wx.createSelectorQuery",error,None)})
            }
        };
        // Keep routing state until the retained dispatcher acknowledges. The
        // dispatcher claims its callback once before scheduling any guest job.
        if !self.dispatch_lifecycle_notification("selectorQuery", &payload)? {
            return Err(BridgeError::invalid(
                "private selector delivery was not acknowledged",
            ));
        }
        self.private_selectors.deliveries.remove(&id);
        // A retained delivery resolves an async host operation. Give it the
        // same bounded task checkpoint as the ordinary API resolver, without
        // calling an application-writable global or changing lifecycle dispatch.
        self.ensure_engine_execution_healthy()?;
        match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                container_core::JsEngine::drain_microtasks(
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| BridgeError::invalid("QuickJS provider unavailable"))?,
                )
                .map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine))?;
                #[cfg(not(feature = "quickjs-native"))]
                return Err(BridgeError::invalid("QuickJS provider unavailable"));
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                container_core::JsEngine::drain_microtasks(
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| BridgeError::invalid("V8 provider unavailable"))?,
                )
                .map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine))?;
                #[cfg(not(feature = "v8-native"))]
                return Err(BridgeError::invalid("V8 provider unavailable"));
            }
        }
        Ok(true)
    }
}
