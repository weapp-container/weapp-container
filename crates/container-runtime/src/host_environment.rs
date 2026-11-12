//! Complete trusted AppService mirrors; no application checkpoint during repair.
use super::*;

#[derive(Default)]
pub(super) struct HostEnvironmentMirror {
    epoch: u64,
    installed_epoch: Option<u64>,
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    values: Option<HostEnvironmentValues>,
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[derive(Clone)]
struct HostEnvironmentValues {
    values: Map<String, Value>,
    errors: Map<String, Value>,
}

pub(super) struct PreparedHostGeometry {
    host: HostMetadata,
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    values: HostEnvironmentValues,
}

/// Only the logical geometry installed by a developer resize belongs to its
/// abort. Provider/network metadata changed by hooks remains authoritative.
#[derive(Clone)]
pub(super) struct OwnedWindowGeometry {
    width: u32,
    height: u32,
    display: Option<HostDisplayMetrics>,
}

impl OwnedWindowGeometry {
    pub(super) fn capture(host: &HostMetadata) -> Self {
        Self {
            width: host.window_width,
            height: host.window_height,
            display: host.display_metrics.clone(),
        }
    }
}

/// Owned undo data survives application work without borrowing the Session.
/// The stamp is captured just after this attempt installs desired metrics.
pub(super) struct LogicalGeometryUndo {
    previous: OwnedWindowGeometry,
    installed_epoch: u64,
}

impl LogicalGeometryUndo {
    pub(super) fn restore(self, host: &mut HostMetadata, mirror: &mut HostEnvironmentMirror) {
        if mirror.epoch == self.installed_epoch {
            host.window_width = self.previous.width;
            host.window_height = self.previous.height;
            host.display_metrics = self.previous.display;
        }
        // Native repair happens only at the next trusted raw entry. Never
        // invoke providers/jobs, reserve an epoch, or clear sticky faults here.
        mirror.installed_epoch = None;
    }
}

pub(super) struct LogicalGeometryAbort<'a> {
    host: &'a mut HostMetadata,
    mirror: &'a mut HostEnvironmentMirror,
    undo: Option<LogicalGeometryUndo>,
}

impl<'a> LogicalGeometryAbort<'a> {
    pub(super) fn new(
        host: &'a mut HostMetadata,
        mirror: &'a mut HostEnvironmentMirror,
        undo: Option<LogicalGeometryUndo>,
    ) -> Self {
        Self { host, mirror, undo }
    }

    pub(super) fn accept(mut self) -> Option<LogicalGeometryUndo> {
        self.undo.take()
    }
}

impl Drop for LogicalGeometryAbort<'_> {
    fn drop(&mut self) {
        if let Some(undo) = self.undo.take() {
            undo.restore(self.host, self.mirror);
        }
    }
}

impl Session {
    pub(super) fn prepare_host_geometry(
        &mut self,
        host: HostMetadata,
    ) -> Result<PreparedHostGeometry, BridgeError> {
        self.ensure_engine_execution_healthy()?;
        let previous = std::mem::replace(&mut self.config.host, host.clone());
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        let values = self.collect_engine_host_values();
        self.config.host = previous;
        Ok(PreparedHostGeometry {
            host,
            #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
            values,
        })
    }

    pub(super) fn install_prepared_host_geometry(
        &mut self,
        prepared: PreparedHostGeometry,
    ) -> Result<(), BridgeError> {
        self.mark_engine_host_environment_dirty()?;
        self.config.host = prepared.host;
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        if self.selected_environment_provider_compiled() {
            return self.install_engine_host_environment_with_storage(prepared.values, None, false);
        }
        self.ensure_engine_environment_current()
    }
    pub(super) fn logical_geometry_epoch(&self) -> u64 {
        self.engine_host_environment.epoch
    }

    pub(super) fn capture_logical_geometry_undo(
        &self,
        previous: OwnedWindowGeometry,
    ) -> LogicalGeometryUndo {
        LogicalGeometryUndo {
            previous,
            installed_epoch: self.engine_host_environment.epoch,
        }
    }

    pub(super) fn invalidate_engine_host_environment(&mut self) {
        self.engine_host_environment.installed_epoch = None;
    }

    /// Pure retirement for a host geometry change or an owned abort. No VM,
    /// provider, lifecycle, storage or file work is allowed in this operation.
    pub(super) fn mark_engine_host_environment_dirty(&mut self) -> Result<(), BridgeError> {
        let Some(epoch) = self.engine_host_environment.epoch.checked_add(1) else {
            let error = BridgeError::new(
                BridgeErrorCode::Engine,
                "host environment epoch exhausted; create a new session",
            );
            self.record_execution_fault(&error);
            return Err(error);
        };
        self.engine_host_environment.epoch = epoch;
        Ok(())
    }

    fn selected_environment_provider_compiled(&self) -> bool {
        match self.config.engine {
            EngineKind::Quickjs => cfg!(feature = "quickjs-native"),
            EngineKind::V8 => cfg!(feature = "v8-native"),
        }
    }

    /// This gate is used at every raw AppService entry, not just outer turns.
    /// A same-turn abort must repair before error/effect continuations too.
    pub(super) fn ensure_engine_environment_current(&mut self) -> Result<(), BridgeError> {
        self.ensure_engine_execution_healthy()?;
        if !self.selected_environment_provider_compiled() {
            // Preserve existing protocol/headless behavior; no JS was run.
            self.engine_host_environment.installed_epoch = Some(self.engine_host_environment.epoch);
            return Ok(());
        }
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        {
            let dirty = self.engine_host_environment.installed_epoch
                != Some(self.engine_host_environment.epoch);
            if dirty || self.engine_storage_stamp != Some(self.app_service.storage().stamp()) {
                let values = if dirty {
                    self.collect_engine_host_values()
                } else {
                    self.engine_host_environment
                        .values
                        .clone()
                        .expect("installed environment values")
                };
                // Repairs retain private pending file writes. Storage replaces
                // only when Rust owns a newer revision, as before this change.
                self.install_engine_host_environment(values, None)?;
            }
        }
        Ok(())
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn environment_capabilities(&self) -> BTreeMap<String, String> {
        let mut negotiated = self.effective_capabilities();
        for name in [
            "wx.fs.readFileSync",
            "wx.fs.writeFileSync",
            "wx.fs.accessSync",
            "wx.fs.unlinkSync",
        ] {
            negotiated.insert(name.to_owned(), self.effective_capability(name));
        }
        negotiated
            .into_iter()
            .map(|(name, support)| {
                let value = serde_json::to_value(support)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_else(|| "unsupported".into());
                (name, value)
            })
            .collect()
    }

    pub(super) fn sync_engine_capabilities(&mut self) -> Result<(), BridgeError> {
        self.ensure_engine_environment_current()?;
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        if self.selected_environment_provider_compiled() {
            let values = self
                .engine_host_environment
                .values
                .clone()
                .expect("installed environment values");
            self.install_engine_host_environment(values, None)?;
        }
        Ok(())
    }

    /// Normal explicit environment refresh may replace provider files. All
    /// collection finishes before one trusted native installation, no jobs.
    pub(super) fn prepare_engine_environment(&mut self) -> Result<(), BridgeError> {
        self.ensure_engine_execution_healthy()?;
        if !self.selected_environment_provider_compiled() {
            return self.ensure_engine_environment_current();
        }
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        {
            let values = self.collect_engine_host_values();
            let files = self.provider.sync_file_snapshot().into_iter().map(|(path, bytes)| {
                let text = String::from_utf8(bytes.clone()).ok();
                (path, json!({"bytes":bytes, "text":text, "base64":provider::base64_encode(&bytes)}))
            }).collect::<Map<_, _>>();
            self.install_engine_host_environment(values, Some(files))?;
        }
        Ok(())
    }

    /// Geometry publication cannot replay an older storage/file snapshot over
    /// writes performed by hooks in this same owner turn. No checkpoint runs.
    pub(super) fn prepare_geometry_environment(&mut self) -> Result<(), BridgeError> {
        self.ensure_engine_execution_healthy()?;
        if !self.selected_environment_provider_compiled() {
            return self.ensure_engine_environment_current();
        }
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        {
            let values = self.collect_engine_host_values();
            self.install_engine_host_environment_with_storage(values, None, false)?;
        }
        Ok(())
    }

    pub(super) fn sync_engine_storage(&mut self) -> Result<(), BridgeError> {
        self.ensure_engine_environment_current()
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn collect_engine_host_values(&mut self) -> HostEnvironmentValues {
        const SYNC_APIS: [&str; 12] = [
            "wx.getSystemInfoSync",
            "wx.getAppBaseInfo",
            "wx.getDeviceInfo",
            "wx.getWindowInfo",
            "wx.getSystemSetting",
            "wx.getMenuButtonBoundingClientRect",
            "wx.getAccountInfoSync",
            "wx.getExtConfigSync",
            "wx.getAppAuthorizeSetting",
            "wx.getLaunchOptionsSync",
            "wx.getEnterOptionsSync",
            "wx.getBatteryInfoSync",
        ];
        let context = ProviderContext {
            session_id: self.config.session_id.clone(),
            host: self.config.host.clone(),
            now_ns: unix_now_ns(),
            deadline_ns: None,
            cancel_token: None,
            cancelled: false,
        };
        let mut names = SYNC_APIS
            .into_iter()
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        // Extensions and future catalog snapshots use the same atomic mirror
        // as the built-in facades. Registration never installs a second cache.
        names.extend(self.host_services.registered.iter().filter_map(|name| {
            host_api_descriptor(name)
                .is_some_and(|api| api.kind == "syncSnapshot")
                .then_some(name.clone())
        }));
        let mut values = Map::new();
        let mut errors = Map::new();
        for name in names {
            let name = name.as_str();
            if self.effective_capability(name) == CapabilitySupport::Unsupported {
                continue;
            }
            if matches!(name, "wx.getLaunchOptionsSync" | "wx.getEnterOptionsSync") {
                values.insert(name.to_owned(), self.launch_options.clone());
                continue;
            }
            match self.provider.call(name, &Map::new(), &context) {
                Ok(value) => {
                    values.insert(name.to_owned(), value);
                }
                Err(error) => {
                    let bridge = provider_bridge_error(error);
                    errors.insert(
                        name.to_owned(),
                        json!({
                            "code": bridge.code,
                            "errMsg": format!("{name}:fail {}", bridge.message),
                            "message": bridge.message,
                            "retryable": bridge.retryable,
                            "api": name,
                        }),
                    );
                }
            }
        }
        HostEnvironmentValues { values, errors }
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn install_engine_host_environment(
        &mut self,
        values: HostEnvironmentValues,
        files: Option<Map<String, Value>>,
    ) -> Result<(), BridgeError> {
        self.install_engine_host_environment_with_storage(values, files, true)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn install_engine_host_environment_with_storage(
        &mut self,
        values: HostEnvironmentValues,
        files: Option<Map<String, Value>>,
        replace_storage: bool,
    ) -> Result<(), BridgeError> {
        self.ensure_engine_execution_healthy()?;
        let stamp = self.app_service.storage().stamp();
        let snapshot = container_core::HostEnvironmentSnapshot {
            version: "1.0".into(),
            capabilities: self.environment_capabilities(),
            dom_query: self.browser_route_active(),
            sync_api_values: values.values.clone(),
            sync_api_errors: values.errors.clone(),
            storage: (replace_storage && self.engine_storage_stamp.as_ref() != Some(&stamp))
                .then(|| self.app_service.storage().snapshot_state()),
            files,
        };
        let installed = match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(
                                BridgeErrorCode::Engine,
                                "QuickJS native provider is unavailable",
                            )
                        })
                        .and_then(|engine| {
                            engine.install_host_environment(&snapshot).map_err(|error| {
                                engine_bridge_error(
                                    error.into_core_error(),
                                    BridgeErrorCode::Engine,
                                )
                            })
                        })
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    Ok(())
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(
                                BridgeErrorCode::Engine,
                                "V8 native provider is unavailable",
                            )
                        })
                        .and_then(|engine| {
                            engine.install_host_environment(&snapshot).map_err(|error| {
                                engine_bridge_error(
                                    error.into_core_error(),
                                    BridgeErrorCode::Engine,
                                )
                            })
                        })
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    Ok(())
                }
            }
        };
        if let Err(error) = installed {
            self.record_execution_fault(&error);
            return Err(error);
        }
        if replace_storage {
            self.engine_storage_stamp = Some(stamp);
        }
        self.engine_host_environment.values = Some(values);
        self.engine_host_environment.installed_epoch = Some(self.engine_host_environment.epoch);
        Ok(())
    }
}

#[cfg(test)]
#[path = "host_environment_tests.rs"]
mod tests;
