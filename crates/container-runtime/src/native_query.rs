//! Native JS SelectorQuery waits for real presentation, independently of input
//! coordinate leases. A same-page layout observation is not page disposal.
//! Direct synchronous bridge queries retain their historical explicit error.
use super::*;
use crate::browser_query::{QueryLimits, QueryOwner};

const MAX_PENDING: usize = 256;
const MAX_OPERATIONS: usize = 256;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_PENDING_BYTES: usize = 64 * 1024 * 1024;

#[derive(Default)]
pub(super) struct NativeQueryState {
    waiting: VecDeque<WaitingQuery>,
    completions: VecDeque<(u64, BridgeError)>,
    bytes: usize,
}

struct WaitingQuery {
    api_id: u64,
    page: PageId,
    profile: container_ir::RendererProfile,
    mode: container_render_skia::PageRenderMode,
    scopes: Vec<String>,
    receivers: Value,
    options: Map<String, Value>,
    limits: QueryLimits,
    bytes: usize,
}

fn cancelled(message: &str) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Cancelled, message)
}

impl Session {
    pub(super) fn legacy_manual_selector_query_embedding(&self) -> bool {
        self.app_service.lifecycle().state() == container_core::LifecycleState::Created
            && self.page_render_mode() == PageRenderMode::Raster
            && self.config.host.window_width == 0
            && self.config.host.window_height == 0
            && self.config.host.menu_button_rect.is_none()
            && !self.dev_raster_presentation_required()
            && !self.navigation_layout.enabled
            && !self.config.browser_view_enabled
    }

    /// Preserve only the original pre-launch, unmeasured manual embedding.
    /// A launched page always joins the bounded async queue, even when its
    /// host still uses the zero-size sentinel. Native/chrome and developer
    /// presentation opt-ins must never regain the synchronous bypass.
    pub(super) fn dispatch_native_query(
        &mut self,
        api_id: u64,
        owner: Option<&Value>,
        options: &Map<String, Value>,
    ) -> Result<(), BridgeError> {
        let legacy_manual_embedding = self.legacy_manual_selector_query_embedding();
        if !legacy_manual_embedding {
            return match self.enqueue_native_query(api_id, owner, options) {
                Ok(()) => Ok(()),
                Err(error) => self.resolve_engine_api(api_id, "wx.createSelectorQuery", Err(error)),
            };
        }
        let result = (|| {
            if self.effective_capability("wx.createSelectorQuery") == CapabilitySupport::Unsupported
            {
                return Err(BridgeError::new(
                    BridgeErrorCode::UnsupportedCapability,
                    "wx.createSelectorQuery is unsupported on this session",
                ));
            }
            // Reuse the originating request deadline/cancellation and the
            // query's own limits. Neither the AppService turn nor the 50 ms
            // View execution budget replaces this query's original lifetime.
            let limits = self.selector_query_limits(options)?;
            let queries = options
                .get("queries")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    BridgeError::invalid("native selector query requires an exec operation batch")
                })?;
            if queries.is_empty() || queries.len() > MAX_OPERATIONS {
                return Err(BridgeError::invalid(
                    "selector query requires 1..=256 operations",
                ));
            }
            if serde_json::to_vec(options)
                .map_err(|error| BridgeError::invalid(error.to_string()))?
                .len()
                > MAX_REQUEST_BYTES
            {
                return Err(BridgeError::invalid(
                    "native selector query exceeds its byte budget",
                ));
            }
            // The shared projection retains capability, execution-health and
            // actual-presentation checks, including explicit manual frames.
            let result = self
                .selector_query_result(options)
                .map(|(_, _, _, value)| value);
            if limits.deadline_ns <= unix_now_ns() {
                return Err(BridgeError::new(
                    BridgeErrorCode::Timeout,
                    "native selector query deadline expired",
                ));
            }
            if limits.is_cancelled(self) {
                return Err(cancelled("native selector query was cancelled"));
            }
            result
        })();
        self.resolve_engine_api(api_id, "wx.createSelectorQuery", result)
    }

    /// Capture ownership once at the native effect boundary. The sealed engine
    /// receiver snapshot and the facade's private liveOwner check both protect
    /// component/page incarnation, including replacing an object under one ID.
    pub(super) fn enqueue_native_query(
        &mut self,
        api_id: u64,
        owner: Option<&Value>,
        options: &Map<String, Value>,
    ) -> Result<(), BridgeError> {
        if self.effective_capability("wx.createSelectorQuery") == CapabilitySupport::Unsupported {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "wx.createSelectorQuery is unsupported on this session",
            ));
        }
        let page = self
            .app_service
            .pages()
            .current()
            .ok_or_else(|| cancelled("native selector query has no live current page"))?;
        let page_id = page.id;
        let profile = self.renderer_profile_for_route(&page.path);
        if self.app_service.lifecycle().state() != container_core::LifecycleState::Active {
            return Err(cancelled("native selector query page is not foreground"));
        }
        let mode = self.page_render_mode();
        let mut scopes = BTreeSet::new();
        if let Some(owner) = owner.filter(|value| !value.is_null()) {
            let owner: QueryOwner = serde_json::from_value(owner.clone()).map_err(|error| {
                BridgeError::invalid(format!("invalid selector owner: {error}"))
            })?;
            if owner.page_id != page_id.0.to_string() {
                return Err(cancelled(
                    "native selector query owner is no longer current",
                ));
            }
            if let Some(scope) = owner.scope_id {
                scopes.insert(scope);
            }
        }
        let queries = options
            .get("queries")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                BridgeError::invalid("native selector query requires an exec operation batch")
            })?;
        if queries.is_empty() || queries.len() > MAX_OPERATIONS {
            return Err(BridgeError::invalid(
                "selector query requires 1..=256 operations",
            ));
        }
        for query in queries {
            let query = query
                .as_object()
                .ok_or_else(|| BridgeError::invalid("selector query operations must be objects"))?;
            if let Some(scope) = selector_query_scope_id(query)? {
                scopes.insert(scope.to_owned());
            }
        }
        if scopes.iter().any(|scope| {
            !self
                .component_pages
                .get(&page_id)
                .is_some_and(|p| p.contains_observer_scope(scope))
        }) {
            return Err(cancelled("native selector query component was detached"));
        }
        let limits = self.selector_query_limits(options)?;
        let request_bytes = serde_json::to_vec(options)
            .map_err(|error| BridgeError::invalid(error.to_string()))?
            .len();
        // Reject input bytes before privileged VM capture, cloning or queueing.
        if request_bytes > MAX_REQUEST_BYTES {
            return Err(BridgeError::invalid(
                "native selector query exceeds its byte budget",
            ));
        }
        let scopes = scopes.into_iter().collect::<Vec<_>>();
        let receivers = self.selector_receiver_snapshot(api_id, page_id.0, &scopes)?;
        let bytes = request_bytes
            .saturating_add(limits.bytes())
            .saturating_add(
                serde_json::to_vec(&receivers)
                    .map_err(|error| BridgeError::invalid(error.to_string()))?
                    .len(),
            )
            .saturating_add(scopes.iter().map(String::len).sum::<usize>());
        if bytes > MAX_REQUEST_BYTES
            || self.native_queries.waiting.len() + self.native_queries.completions.len()
                >= MAX_PENDING
            || self.native_queries.bytes.saturating_add(bytes) > MAX_PENDING_BYTES
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "native selector waiting queue exceeds its byte/count budget",
            ));
        }
        self.native_queries.waiting.push_back(WaitingQuery {
            api_id,
            page: page_id,
            profile,
            mode,
            scopes,
            receivers,
            options: options.clone(),
            limits,
            bytes,
        });
        self.native_queries.bytes += bytes;
        Ok(())
    }

    /// Pure retirement: hooks/atomic environment installation never invoke API
    /// callbacks. A normal owner-thread effect drain publishes the terminal
    /// outcome, and may then run application microtasks under its usual budget.
    pub(super) fn retire_native_queries(&mut self, page: Option<PageId>, reason: &str) {
        let mut retained = VecDeque::new();
        while let Some(waiting) = self.native_queries.waiting.pop_front() {
            if page.is_none_or(|page| waiting.page == page) {
                self.native_queries.bytes -= waiting.bytes;
                self.native_queries
                    .completions
                    .push_back((waiting.api_id, cancelled(reason)));
            } else {
                retained.push_back(waiting);
            }
        }
        self.native_queries.waiting = retained;
    }

    pub(super) fn drain_native_query_completions(&mut self) -> Result<bool, BridgeError> {
        self.drain_native_query_completions_at(unix_now_ns())
    }

    fn drain_native_query_completions_at(&mut self, now: u64) -> Result<bool, BridgeError> {
        // Purely retired requests are already terminal. Publish one before a
        // newer eligible waiter; no presentation is needed, and the bounded
        // owner effect loop continues to check deadlines without a UI wait.
        if let Some((id, error)) = self.native_queries.completions.pop_front() {
            self.resolve_engine_api(id, "wx.createSelectorQuery", Err(error))?;
            return Ok(true);
        }
        // Freeze candidates and resolve at most one callback. Its setData/API
        // effects must be consumed before the next geometry projection; the
        // enclosing ordinary effect drain owns continuation and yielding.
        let count = self.native_queries.waiting.len();
        let mut retained = VecDeque::new();
        for _ in 0..count {
            let Some(waiting) = self.native_queries.waiting.pop_front() else {
                break;
            };
            let outcome = if waiting.limits.deadline_ns <= now {
                Some(Err(BridgeError::new(
                    BridgeErrorCode::Timeout,
                    "native selector query deadline expired before presentation",
                )))
            } else if waiting.limits.is_cancelled(self) {
                Some(Err(cancelled("native selector query was cancelled")))
            } else if self.view_execution_is_faulted() {
                Some(Err(BridgeError::new(
                    BridgeErrorCode::Render,
                    "native selector query View requires a fresh session",
                )))
            } else if self.browser_route_active()
                || self.app_service.lifecycle().state() != container_core::LifecycleState::Active
                || !self.app_service.pages().current().is_some_and(|p| {
                    p.id == waiting.page
                        && self.renderer_profile_for_route(&p.path) == waiting.profile
                })
                || self.page_render_mode() != waiting.mode
            {
                Some(Err(cancelled(
                    "native selector query lifecycle/profile was retired",
                )))
            } else {
                match self.selector_receiver_snapshot(
                    waiting.api_id,
                    waiting.page.0,
                    &waiting.scopes,
                ) {
                    Ok(current) if current == waiting.receivers => {
                        if self.native_query_frame_is_current() {
                            Some(
                                self.selector_query_result(&waiting.options)
                                    .map(|(_, _, _, value)| value),
                            )
                        } else {
                            None
                        }
                    }
                    Ok(_) => Some(Err(cancelled(
                        "native selector query receiver incarnation was retired",
                    ))),
                    Err(error) => Some(Err(error)),
                }
            };
            if let Some(mut outcome) = outcome {
                // Projection and privileged receiver capture can consume time.
                // Keep the original deadline, including the originating bridge
                // limits, through the final point before entering app JS.
                if waiting.limits.deadline_ns <= unix_now_ns() {
                    outcome = Err(BridgeError::new(
                        BridgeErrorCode::Timeout,
                        "native selector query deadline expired",
                    ));
                } else if waiting.limits.is_cancelled(self) {
                    outcome = Err(cancelled("native selector query was cancelled"));
                }
                self.native_queries.bytes -= waiting.bytes;
                // A scanned-but-not-ready prefix must stay before the untouched
                // suffix. Restore it before entering JS so reentrant effects
                // cannot observe or inherit a rotated [C, A] survivor order.
                retained.append(&mut self.native_queries.waiting);
                self.native_queries.waiting = retained;
                self.resolve_engine_api(waiting.api_id, "wx.createSelectorQuery", outcome)?;
                return Ok(true);
            } else {
                retained.push_back(waiting);
            }
        }
        retained.append(&mut self.native_queries.waiting);
        self.native_queries.waiting = retained;
        Ok(false)
    }

    fn native_query_frame_is_current(&self) -> bool {
        if !self.is_current_frame_presented() {
            return false;
        }
        // Generated scenes expose immutable scheduling provenance captured
        // alongside their data clone. A presented old frame must not satisfy
        // a query after setData, even before the owner prepares the new frame.
        // Explicit host frames retain their established bridge semantics.
        !self.accepted_skia_scene
            || self
                .last_frame_input(self.skia_backend.renderer.snapshot_revision())
                .is_some_and(|input| {
                    input.template_revision == self.view.template_revision
                        // Host zero sizes are the unmeasured sentinel, not a
                        // 0x0 viewport. Presentation above already validates
                        // measured host geometry and exact layout authority;
                        // immutable input must match the actual accepted frame.
                        && self.skia_backend.renderer.last_frame().is_some_and(|frame| {
                            input.viewport == frame.viewport
                        })
                })
    }
}

#[cfg(test)]
#[path = "native_query_tests.rs"]
mod tests;
