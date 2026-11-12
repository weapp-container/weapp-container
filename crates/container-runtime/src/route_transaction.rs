//! Route intent is validated synchronously before its first page-side effect.
use super::*;
use std::rc::Rc;

/// The private PAGE_* bridge predates wx navigation. Its literal path and
/// one-pop/last-page-clear contract must not inherit public API restrictions.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RouteOrigin {
    PublicApi,
    NativePush,
    NativeReplace,
    NativePop,
}

pub(super) const APIS: [&str; 5] = [
    "wx.onBeforeAppRoute",
    "wx.offBeforeAppRoute",
    "wx.onAppRoute",
    "wx.offAppRoute",
    "wx.rewriteRoute",
];

fn listener_peer(name: &str) -> Option<&'static str> {
    match name {
        "wx.onBeforeAppRoute" => Some("wx.offBeforeAppRoute"),
        "wx.offBeforeAppRoute" => Some("wx.onBeforeAppRoute"),
        "wx.onAppRoute" => Some("wx.offAppRoute"),
        "wx.offAppRoute" => Some("wx.onAppRoute"),
        _ => None,
    }
}

#[derive(Default)]
pub(super) struct RouteTransactions {
    sequence: u64,
}

pub(super) struct PreparedRoute {
    pub(super) id: String,
    pub(super) payload: Map<String, Value>,
    event: Value,
    source: Vec<(PageId, String)>,
}

fn source_shape(session: &Session) -> Vec<(PageId, String)> {
    session
        .app_service
        .pages()
        .iter()
        .map(|page| (page.id, page.path.clone()))
        .collect()
}

fn package_root<'a>(path: &str, roots: &'a [String]) -> Option<&'a str> {
    roots
        .iter()
        .filter(|root| {
            path == root.as_str()
                || path
                    .strip_prefix(root.as_str())
                    .is_some_and(|tail| tail.starts_with('/'))
        })
        .max_by_key(|root| root.len())
        .map(String::as_str)
}

impl Session {
    pub(super) fn route_capability(
        &self,
        name: &str,
        provider: &BTreeMap<String, CapabilitySupport>,
    ) -> Option<CapabilitySupport> {
        if !APIS.contains(&name) {
            return None;
        }
        let resolve = |api: &str| {
            let manifest = self
                .manifest
                .capabilities
                .get(api)
                .copied()
                .unwrap_or(CapabilitySupport::Unsupported);
            let host = self
                .config
                .capabilities
                .get(api)
                .copied()
                .map_or(manifest, |host| min_support(manifest, host));
            let support = provider
                .get(api)
                .copied()
                .map_or(host, |provider| min_support(host, provider));
            if matches!(api, "wx.offBeforeAppRoute" | "wx.offAppRoute") {
                support
            } else {
                min_support(support, CapabilitySupport::Partial)
            }
        };
        let own = resolve(name);
        // A peer must remain admitted so registration and removal share one
        // live owner. Its incomplete producer grade is not this method's grade.
        Some(match listener_peer(name) {
            Some(peer) if resolve(peer) == CapabilitySupport::Unsupported => {
                CapabilitySupport::Unsupported
            }
            _ => own,
        })
    }

    pub(super) fn prepare_route_transaction(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        origin: RouteOrigin,
    ) -> Result<PreparedRoute, BridgeError> {
        self.route_transactions.sequence = self
            .route_transactions
            .sequence
            .checked_add(1)
            .ok_or_else(|| BridgeError::invalid("route identity exhausted"))?;
        let id = format!("route-tx:{}", self.route_transactions.sequence);
        let source = source_shape(self);
        let raw = payload
            .get("url")
            .or_else(|| payload.get("path"))
            .and_then(Value::as_str);
        // The public URL parser permits an unresolved page here so the
        // before event can recover notFound. Private bridge paths are literal;
        // preserve their existing acceptance and query stringification.
        let (path, query) =
            if origin == RouteOrigin::NativePush || origin == RouteOrigin::NativeReplace {
                let path = payload
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| BridgeError::invalid("native page operation requires path"))?;
                validate_page_input(path, payload)?;
                let query = payload
                    .get("query")
                    .and_then(Value::as_object)
                    .map(|object| {
                        object
                            .iter()
                            .map(|(key, value)| {
                                (key.clone(), Value::String(stringify_query_value(value)))
                            })
                            .collect::<Map<String, Value>>()
                    })
                    .unwrap_or_default();
                (path.to_owned(), Value::Object(query))
            } else if name == "wx.navigateBack" {
                let delta = if origin == RouteOrigin::NativePop {
                    1
                } else {
                    payload
                        .get("delta")
                        .and_then(Value::as_u64)
                        .unwrap_or(1)
                        .max(1)
                };
                let offset =
                    delta.min(self.app_service.pages().len().saturating_sub(1) as u64) as usize;
                let target = self
                    .app_service
                    .pages()
                    .iter()
                    .rev()
                    .nth(offset)
                    .ok_or_else(|| BridgeError::invalid("route requires a page"))?;
                (target.path.clone(), json!(target.query))
            } else {
                let (path, query) =
                    navigation_target_unchecked(&self.manifest, name, raw, payload.get("query"))?;
                let path = path.ok_or_else(|| BridgeError::invalid("route requires url"))?;
                if self.manifest.routes.iter().any(|route| route.path == path) {
                    // Known targets still obey route-kind admission. Only missing
                    // pages receive the documented notFound recovery opportunity.
                    navigation_target(&self.manifest, name, raw, payload.get("query"))?;
                }
                (path, query)
            };
        let initial = source.is_empty() && origin == RouteOrigin::NativePush;
        let open_type = if initial {
            "appLaunch"
        } else {
            name.trim_start_matches("wx.")
        };
        let catalog = chrome::ResolvedChromeCatalog::load(&self.manifest, &self.render_blobs)?;
        let roots = catalog.subpackage_roots();
        let mut event = json!({"routeEventId":id,"openType":open_type,"path":path,"query":query,
            "notFound":!self.manifest.routes.iter().any(|route|route.path==path),
            "page":catalog.page_configuration(&path),
            // This is the actual container profile, not invented Skyline parity.
            "renderer":self.renderer_profile_for_route(&path),
            "timeStamp":unix_now_ns()/1_000_000});
        if let Some(page) = self.app_service.pages().current() {
            event["webviewId"] = json!(page.id.0);
        }
        let chosen: Rc<RefCell<Option<(String, Value)>>> = Rc::new(RefCell::new(None));
        let selection = chosen.clone();
        let manifest = self.manifest.clone();
        let validation_name = if initial { "wx.reLaunch" } else { name };
        let api = validation_name.to_owned();
        let original_path = path.clone();
        let original_query = query.clone();
        let allowed =
            self.effective_capability("wx.rewriteRoute") != CapabilitySupport::Unsupported;
        let atomic_initial = initial && self.navigation_layout.enabled;
        let validator: container_core::RouteRewriteValidator = Box::new(move |url, preserve| {
            let validate = || -> Result<(String, Value), BridgeError> {
                if !allowed {
                    return Err(BridgeError::new(
                        BridgeErrorCode::UnsupportedCapability,
                        "rewriteRoute unsupported",
                    ));
                }
                if selection.borrow().is_some() {
                    return Err(BridgeError::invalid(
                        "route event has already been rewritten",
                    ));
                }
                if api == "wx.navigateBack" {
                    return Err(BridgeError::invalid(
                        "navigateBack event cannot be rewritten",
                    ));
                }
                let (target, query) = navigation_target(&manifest, &api, Some(url), None)?;
                let target =
                    target.ok_or_else(|| BridgeError::invalid("rewrite requires target"))?;
                if target.contains("://") {
                    return Err(BridgeError::new(
                        BridgeErrorCode::UnsupportedCapability,
                        "plugin route ownership is not implemented",
                    ));
                }
                if !manifest.routes.iter().any(|route| route.path == target) {
                    return Err(BridgeError::invalid(format!(
                        "unknown rewrite route {target}"
                    )));
                }
                if package_root(&original_path, &roots) != package_root(&target, &roots) {
                    return Err(BridgeError::new(
                        BridgeErrorCode::UnsupportedCapability,
                        "cross-subpackage route rewrite unsupported",
                    ));
                }
                let query = if preserve {
                    original_query.clone()
                } else {
                    query
                };
                // Initial host geometry has already been measured by the SDK.
                // Never reuse that permit for a different target or query.
                if atomic_initial && (target != original_path || query != original_query) {
                    return Err(BridgeError::new(
                        BridgeErrorCode::UnsupportedCapability,
                        "initial route rewrite requires a fresh host layout transaction",
                    ));
                }
                Ok((target, query))
            };
            let target = validate().map_err(|error| {
                container_core::RouteRewriteError::new(error.code.as_str(), error.message)
            })?;
            *selection.borrow_mut() = Some(target);
            Ok(())
        });
        self.dispatch_route_notification("before", &event, Some(validator))?;
        // The native lease is closed before any later jobs/effects can run.
        if source_shape(self) != source
            || self.app_service.lifecycle().state() == container_core::LifecycleState::Destroyed
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "route source retired during before dispatch",
            ));
        }
        let (path, query) = match chosen.borrow_mut().take() {
            Some(target) => target,
            None if name == "wx.navigateBack" || origin != RouteOrigin::PublicApi => (path, query),
            None => {
                let (target, query) =
                    navigation_target(&self.manifest, validation_name, raw, payload.get("query"))?;
                (
                    target.ok_or_else(|| BridgeError::invalid("route requires target"))?,
                    query,
                )
            }
        };
        if name != "wx.navigateBack" && (origin == RouteOrigin::PublicApi || initial) {
            self.ensure_route_target_ready(&path)?;
        }
        event["path"] = json!(path);
        event["query"] = query.clone();
        event["notFound"] = json!(!self.manifest.routes.iter().any(|route| route.path == path));
        event["page"] = catalog.page_configuration(&path);
        event["renderer"] = json!(self.renderer_profile_for_route(&path));
        let mut prepared_payload = payload.clone();
        if name != "wx.navigateBack" {
            prepared_payload.insert("url".into(), json!(path));
            prepared_payload.insert("path".into(), json!(path));
            prepared_payload.insert("query".into(), query);
        }
        Ok(PreparedRoute {
            id,
            payload: prepared_payload,
            event,
            source,
        })
    }

    /// A declared route is not runnable until its named module has produced
    /// the Page definition owned by that route. Falling back to the manifest
    /// position here can run another page's hooks during lazy subpackage load.
    /// Protocol-only/legacy packs may name logical route entries without
    /// declaring executable modules for them. Loading an unrelated helper or
    /// a legacy combined App/Page bundle does not turn those placeholders into
    /// lazy Page roots; executable route declarations carry that obligation.
    /// Native protocol embedders may also share the App entry as a route
    /// placeholder while installing no AppService modules at all. A linked
    /// engine alone cannot turn that metadata into an executed Page runtime.
    fn ensure_route_target_ready(&self, path: &str) -> Result<(), BridgeError> {
        if !self.engine_provider_available() {
            return Ok(());
        }
        let Some(route) = self.manifest.routes.iter().find(|route| route.path == path) else {
            return Ok(());
        };
        let module_id = module_reference_id(&route.entry_module);
        let Some(module) = self
            .manifest
            .modules
            .iter()
            .find(|module| module.id == module_id)
        else {
            return Ok(());
        };
        if self.loaded_modules.is_empty()
            && module.scope == container_ir::ModuleScope::App
            && module_id == module_reference_id(&self.manifest.app.entry_module)
        {
            return Ok(());
        }
        if self.page_module_indices.contains_key(path) {
            return Ok(());
        }
        Err(BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!(
                "route {path} is not ready; page module {} has not registered its Page definition",
                route.entry_module
            ),
        ))
    }

    pub(super) fn finish_route_transaction<T>(
        &mut self,
        prepared: PreparedRoute,
        action: impl FnOnce(&mut Self, &Map<String, Value>) -> Result<T, BridgeError>,
    ) -> Result<T, BridgeError> {
        let PreparedRoute {
            id,
            payload,
            mut event,
            source,
        } = prepared;
        if source_shape(self) != source {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "route source changed before commit",
            ));
        }
        let result = self.with_route_event_id(id, |session| action(session, &payload))?;
        self.sync_current_pages()?;
        if let Some(page) = self.app_service.pages().current() {
            event["path"] = json!(page.path);
            event["query"] = json!(page.query);
            event["webviewId"] = json!(page.id.0);
        }
        self.dispatch_route_notification("after", &event, None)?;
        Ok(result)
    }

    fn dispatch_route_notification(
        &mut self,
        name: &str,
        payload: &Value,
        validator: Option<container_core::RouteRewriteValidator>,
    ) -> Result<bool, BridgeError> {
        let api = match name {
            "before" => "wx.onBeforeAppRoute",
            "after" => "wx.onAppRoute",
            _ => return Ok(false),
        };
        if self.effective_capability(api) == CapabilitySupport::Unsupported {
            return Ok(false);
        }
        #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
        let _ = (&name, &payload, &validator);
        if !self.engine_provider_available() {
            return Ok(false);
        }
        self.ensure_engine_environment_current()?;
        match self.config.engine {
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
                        .dispatch_route_notification(name, payload, validator)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    Ok(false)
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(BridgeErrorCode::Engine, "V8 provider unavailable")
                        })?
                        .dispatch_route_notification(name, payload, validator)
                        .map_err(|error| {
                            BridgeError::new(BridgeErrorCode::Engine, error.to_string())
                        })
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    Ok(false)
                }
            }
        }
    }
}

#[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
#[path = "route-transaction-native-tests.rs"]
mod native_tests;
