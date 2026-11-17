//! Session-owned scrolling. Render frames contain published offsets; this
//! registry retains them across fresh WXML/layout generations and hidden pages.
use super::*;
use container_render_skia::ScrollOffset;

#[derive(Clone, Debug, Default)]
pub(super) struct ScrollRegistry {
    pages: BTreeMap<Option<PageId>, BTreeMap<String, ScrollState>>,
    pending: Vec<ScrollChange>,
    touch_positions: BTreeMap<i64, (f32, f32)>,
}

#[derive(Clone, Debug)]
struct ScrollState {
    target: String,
    x: bool,
    y: bool,
    offset: ScrollOffset,
    max_left: f32,
    max_top: f32,
    width: f32,
    height: f32,
    declared_left: Option<f32>,
    declared_top: Option<f32>,
    declared_into: Option<String>,
    pending_left: Option<f32>,
    pending_top: Option<f32>,
    pending_into: Option<String>,
    page: bool,
}

#[derive(Clone, Debug)]
struct ScrollChange {
    page: Option<PageId>,
    target: String,
    offset: ScrollOffset,
    delta_left: f32,
    delta_top: f32,
    width: f32,
    height: f32,
    page_scroll: bool,
    reach_bottom: bool,
}

fn enabled(node: &RenderNode, name: &str) -> bool {
    node.attributes
        .get(name)
        .is_some_and(|value| value.is_empty() || value == "true" || value == "1")
}

fn declared_number(node: &RenderNode, name: &str) -> Result<Option<f32>, BridgeError> {
    node.attributes
        .get(name)
        .map(|value| {
            let value = value.parse::<f32>().map_err(|_| {
                BridgeError::invalid(format!("{name} must be finite numeric pixels"))
            })?;
            if !value.is_finite() {
                return Err(BridgeError::invalid(format!(
                    "{name} must be finite numeric pixels"
                )));
            }
            Ok(value.max(0.0))
        })
        .transpose()
}

fn identity(node: &RenderNode, parent: &str, parent_event: Option<&str>, index: usize) -> String {
    let local_event = node.event_identity.as_deref().and_then(|event| {
        parent_event
            .and_then(|parent| {
                event
                    .strip_prefix(parent)
                    .and_then(|tail| tail.strip_prefix('.'))
            })
            .or_else(|| {
                event
                    .strip_prefix("event:")
                    .filter(|_| parent_event.is_none())
            })
    });
    if let Some(key) = &node.key {
        // Generated keyed segments include their repeat-site namespace. Keep
        // the entire length-prefixed segment (keys may themselves contain
        // dots) instead of splitting an opaque occurrence address.
        if let Some(local) = local_event.filter(|local| local.starts_with('k')) {
            return format!("{parent}/{}:{local}", local.len());
        }
        let segment =
            serde_json::to_string(&(node.tag.as_deref(), key)).expect("string tuple serialization");
        return format!("{parent}/{}:{segment}", segment.len());
    }
    match local_event {
        Some(local) if parent_event.is_some() => format!("{parent}/{}:{local}", local.len()),
        _ => format!("{parent}/{index}"),
    }
}

impl ScrollRegistry {
    /// A replacement presentation surface starts fresh pointer deltas while
    /// retaining page offsets, deferred commands, layout and notifications.
    /// This pure retirement never dispatches scroll/touch callbacks.
    pub(super) fn retire_touch_positions(&mut self) {
        self.touch_positions.clear();
    }

    pub(super) fn release_touch(&mut self, id: i64) {
        self.touch_positions.remove(&id);
    }
    pub(super) fn release_page(&mut self, page: PageId) {
        self.pages.remove(&Some(page));
        self.pending.retain(|change| change.page != Some(page));
    }

    /// Work on a cloned registry and frame. The caller publishes both only
    /// after renderer validation/painting succeeds.
    pub(super) fn reconcile(
        &mut self,
        page: Option<PageId>,
        frame: &mut RenderFrame,
        generated: bool,
    ) -> Result<(), BridgeError> {
        // A resolved host frame owns its explicit offsets. Only WXML
        // generations need reconciliation against retained user positions.
        let previous = if generated {
            self.pages.get(&page).cloned().unwrap_or_default()
        } else {
            BTreeMap::new()
        };
        let mut next = BTreeMap::new();
        self.reconcile_node(
            page,
            &mut frame.root,
            "root",
            None,
            0,
            generated,
            frame.viewport,
            &previous,
            &mut next,
        )?;
        self.pages.insert(page, next);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn reconcile_node(
        &mut self,
        page: Option<PageId>,
        node: &mut RenderNode,
        parent: &str,
        parent_event: Option<&str>,
        index: usize,
        generated: bool,
        host_viewport: Rect,
        previous: &BTreeMap<String, ScrollState>,
        next: &mut BTreeMap<String, ScrollState>,
    ) -> Result<(), BridgeError> {
        let key = identity(node, parent, parent_event, index);
        let is_page = generated && node.tag.as_deref() == Some("page");
        let is_view = generated && node.tag.as_deref() == Some("scroll-view");
        let x = if is_view {
            enabled(node, "scroll-x")
        } else {
            node.scroll_container && !is_page
        };
        let y = if is_page {
            node.scroll_container
        } else if is_view {
            enabled(node, "scroll-y")
        } else {
            node.scroll_container
        };
        if generated && (is_page || is_view) {
            node.scroll_container = x || y;
        }
        for (index, child) in node.children.iter_mut().enumerate() {
            self.reconcile_node(
                page,
                child,
                &key,
                node.event_identity.as_deref(),
                index,
                generated,
                host_viewport,
                previous,
                next,
            )?;
        }
        if !node.scroll_container {
            return Ok(());
        }
        let viewport = if is_page {
            host_viewport
        } else {
            node.scroll_viewport()
        };
        let (width, height) = node.scroll_content_extent();
        let (width, height) = if is_page {
            (width.max(node.bounds.width), height.max(node.bounds.height))
        } else {
            (width, height)
        };
        let max_left = if x {
            (width - viewport.width).max(0.0)
        } else {
            0.0
        };
        let max_top = if y {
            (height - viewport.height).max(0.0)
        } else {
            0.0
        };
        let left = if generated {
            declared_number(node, "scroll-left")?
        } else {
            None
        };
        let top = if generated {
            declared_number(node, "scroll-top")?
        } else {
            None
        };
        let into = node
            .attributes
            .get("scroll-into-view")
            .filter(|value| !value.is_empty())
            .filter(|_| generated)
            .cloned();
        let old = previous.get(&key);
        let mut offset = old
            .map(|state| state.offset)
            .unwrap_or_else(|| node.scroll_offset.unwrap_or_default());
        let before = offset;
        let mut pending_left = old.and_then(|state| state.pending_left);
        let mut pending_top = old.and_then(|state| state.pending_top);
        let mut pending_into = old.and_then(|state| state.pending_into.clone());
        if old.is_none_or(|state| state.declared_left != left) {
            if let Some(left) = left {
                pending_left = Some(left);
            }
        }
        if old.is_none_or(|state| state.declared_top != top) {
            if let Some(top) = top {
                pending_top = Some(top);
            }
        }
        if old.is_none_or(|state| state.declared_into != into) {
            pending_into = into.clone();
        }
        if let Some(left) = pending_left {
            offset.scroll_left = left;
        }
        if let Some(top) = pending_top {
            offset.scroll_top = top;
        }
        if let Some(target) = &pending_into {
            if let Some(target) = find_descendant_public_id(node, target) {
                if let Some(target_offset) = node.scroll_target_offset(target) {
                    if x {
                        offset.scroll_left = target_offset.scroll_left;
                    }
                    if y {
                        offset.scroll_top = target_offset.scroll_top;
                    }
                    pending_into = None;
                }
            }
        }
        if generated && enabled(node, "scroll-with-animation") && before != offset {
            return Err(BridgeError::new(BridgeErrorCode::UnsupportedCapability, "animated scroll-view commands are not implemented; use scroll-with-animation=false"));
        }
        if generated {
            offset.scroll_left = offset.scroll_left.clamp(0.0, max_left);
            offset.scroll_top = offset.scroll_top.clamp(0.0, max_top);
        }
        if pending_left.is_some_and(|value| value <= max_left) {
            pending_left = None;
        }
        if pending_top.is_some_and(|value| value <= max_top) {
            pending_top = None;
        }
        node.scroll_offset = Some(offset);
        let state = ScrollState {
            target: node.event_identity.as_ref().unwrap_or(&node.id).clone(),
            x,
            y,
            offset,
            max_left,
            max_top,
            width,
            height,
            declared_left: left,
            declared_top: top,
            declared_into: into,
            pending_left,
            pending_top,
            pending_into,
            page: is_page,
        };
        self.record_change(page, &state, before);
        if next.insert(key, state).is_some() {
            return Err(BridgeError::invalid(
                "duplicate scrolling occurrence; wx:key must be unique within its repeat site",
            ));
        }
        Ok(())
    }

    fn record_change(&mut self, page: Option<PageId>, state: &ScrollState, before: ScrollOffset) {
        if before == state.offset {
            return;
        }
        self.pending.push(ScrollChange {
            page,
            target: state.target.clone(),
            offset: state.offset,
            delta_left: state.offset.scroll_left - before.scroll_left,
            delta_top: state.offset.scroll_top - before.scroll_top,
            width: state.width,
            height: state.height,
            page_scroll: state.page,
            reach_bottom: state.y
                && state.max_top > 0.0
                && before.scroll_top < state.max_top
                && state.offset.scroll_top >= state.max_top,
        });
    }

    fn set_offset(
        &mut self,
        page: Option<PageId>,
        target: &str,
        left: Option<f32>,
        top: Option<f32>,
        frame: &mut RenderFrame,
    ) -> bool {
        let Some(states) = self.pages.get_mut(&page) else {
            return false;
        };
        let Some(state) = states.values_mut().find(|state| state.target == target) else {
            return false;
        };
        let before = state.offset;
        if let Some(left) = left {
            state.pending_left = None;
            state.pending_into = None;
            state.offset.scroll_left = if state.x {
                left.clamp(0.0, state.max_left)
            } else {
                0.0
            };
        }
        if let Some(top) = top {
            state.pending_top = None;
            state.pending_into = None;
            state.offset.scroll_top = if state.y {
                top.clamp(0.0, state.max_top)
            } else {
                0.0
            };
        }
        if before == state.offset {
            return false;
        }
        let state = state.clone();
        if let Some(node) = find_node_mut(&mut frame.root, target) {
            node.scroll_offset = Some(state.offset);
        }
        self.record_change(page, &state, before);
        true
    }

    fn delta(
        &mut self,
        page: Option<PageId>,
        target: &str,
        mut dx: f32,
        mut dy: f32,
        frame: &mut RenderFrame,
    ) -> Result<bool, BridgeError> {
        let Some(path) = find_render_path(&frame.root, target) else {
            return Ok(false);
        };
        let geometries = frame.node_geometries();
        let targets: Vec<(String, Transform2D)> = path
            .iter()
            .rev()
            .map(|node| {
                (
                    node.event_identity.as_ref().unwrap_or(&node.id).clone(),
                    geometries
                        .iter()
                        .find(|geometry| std::ptr::eq(geometry.node, *node))
                        .map(|geometry| geometry.world_transform)
                        .unwrap_or_default(),
                )
            })
            .collect();
        let mut changed = false;
        for (target, transform) in targets {
            let Some(state) = self
                .pages
                .get(&page)
                .and_then(|states| states.values().find(|state| state.target == target))
                .cloned()
            else {
                continue;
            };
            let inverse = transform.inverse().ok_or_else(|| {
                BridgeError::new(
                    BridgeErrorCode::UnsupportedCapability,
                    "cannot scroll a singular transformed viewport",
                )
            })?;
            let local_dx = inverse.a * dx + inverse.c * dy;
            let local_dy = inverse.b * dx + inverse.d * dy;
            let left = if state.x {
                Some(state.offset.scroll_left + local_dx)
            } else {
                None
            };
            let top = if state.y {
                Some(state.offset.scroll_top + local_dy)
            } else {
                None
            };
            let applied_x = left
                .map(|left| left.clamp(0.0, state.max_left) - state.offset.scroll_left)
                .unwrap_or_default();
            let applied_y = top
                .map(|top| top.clamp(0.0, state.max_top) - state.offset.scroll_top)
                .unwrap_or_default();
            changed |= self.set_offset(page, &target, left, top, frame);
            dx -= transform.a * applied_x + transform.c * applied_y;
            dy -= transform.b * applied_x + transform.d * applied_y;
            if dx == 0.0 && dy == 0.0 {
                break;
            }
        }
        Ok(changed)
    }
}

fn find_descendant_public_id<'a>(node: &'a RenderNode, id: &str) -> Option<&'a RenderNode> {
    node.children.iter().find_map(|child| {
        if child.attributes.get("id").is_some_and(|value| value == id) {
            Some(child)
        } else {
            find_descendant_public_id(child, id)
        }
    })
}

fn find_node_mut<'a>(node: &'a mut RenderNode, identity: &str) -> Option<&'a mut RenderNode> {
    if node.event_identity.as_ref().unwrap_or(&node.id) == identity {
        return Some(node);
    }
    node.children
        .iter_mut()
        .find_map(|child| find_node_mut(child, identity))
}

fn default_prevented(result: Option<&Value>) -> bool {
    match result {
        Some(Value::Array(values)) => values.iter().any(|value| default_prevented(Some(value))),
        Some(Value::Object(object)) => {
            object.get("handler").is_some()
                && object.get("defaultPrevented") == Some(&Value::Bool(true))
        }
        _ => false,
    }
}

fn coordinate(value: &Value) -> Option<(f32, f32)> {
    let x = value.get("x").or_else(|| value.get("clientX"))?.as_f64()? as f32;
    let y = value.get("y").or_else(|| value.get("clientY"))?.as_f64()? as f32;
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

impl Session {
    pub(super) fn page_scroll_enabled(
        &self,
        template_id: &str,
        blobs: &BTreeMap<String, Vec<u8>>,
    ) -> Result<bool, BridgeError> {
        let config = |path: &str| crate::chrome::configuration_json(&self.manifest, blobs, path);
        let app = config(&self.manifest.app.app_json)?;
        let page_path = self
            .app_service
            .pages()
            .current()
            .and_then(|page| {
                self.manifest
                    .routes
                    .iter()
                    .find(|route| route.path == page.path)
            })
            .and_then(|route| route.config.clone())
            .unwrap_or_else(|| template_owner_config(template_id));
        let page = config(&page_path)?;
        let disabled = page
            .as_ref()
            .and_then(|page| page.get("disableScroll"))
            .or_else(|| {
                app.as_ref()
                    .and_then(|app| app.get("window"))
                    .and_then(|window| window.get("disableScroll"))
            });
        match disabled {
            None => Ok(true),
            Some(Value::Bool(disabled)) => Ok(!disabled),
            _ => Err(BridgeError::invalid(
                "disableScroll configuration must be boolean",
            )),
        }
    }

    pub(super) fn apply_scroll_default(
        &mut self,
        value: &Value,
        event: &EventInput,
        dispatches: &[EventDispatch],
        result: Option<&Value>,
        captured: Option<&TouchRoute>,
    ) -> Result<(), BridgeError> {
        let kind = event.event_type.as_str();
        let changed_touch = value
            .get("changedTouches")
            .and_then(Value::as_array)
            .filter(|touches| touches.len() == 1)
            .and_then(|touches| touches.first());
        let touch_id = changed_touch
            .and_then(|touch| touch.get("identifier"))
            .or_else(|| value.get("touchId"))
            .or_else(|| value.get("contactId"))
            .or_else(|| value.get("pointerId"))
            .and_then(Value::as_i64);
        let mut touch_delta = None;
        if let Some(id) = touch_id {
            if let Some(position) = coordinate(value).or_else(|| changed_touch.and_then(coordinate))
            {
                match kind {
                    "touchstart" => {
                        self.scrolling.touch_positions.insert(id, position);
                    }
                    "touchmove" => {
                        if let Some(previous) = self.scrolling.touch_positions.insert(id, position)
                        {
                            touch_delta = Some((previous.0 - position.0, previous.1 - position.1));
                        }
                    }
                    "touchend" | "touchcancel" => {
                        self.scrolling.touch_positions.remove(&id);
                    }
                    _ => {}
                }
            }
        }
        if default_prevented(result)
            || (kind == "touchmove" && self.catch_touch_move_consumed(result, dispatches, captured))
        {
            return Ok(());
        }
        if kind != "wheel" && touch_delta.is_none() {
            return Ok(());
        }
        let page = self.app_service.pages().current().map(|page| page.id);
        if !self.observer_frame_valid || page != self.observer_frame_page {
            return Ok(());
        }
        let Some(mut frame) = self.skia_backend.renderer.last_frame().cloned() else {
            return Ok(());
        };
        let (dx, dy) = if let Some(delta) = touch_delta {
            delta
        } else {
            let delta = |key: &str| -> Result<f32, BridgeError> {
                let value = match value.get(key) {
                    Some(value) => value
                        .as_f64()
                        .ok_or_else(|| BridgeError::invalid("wheel deltas must be numeric"))?
                        as f32,
                    None => 0.0,
                };
                if !value.is_finite() {
                    return Err(BridgeError::invalid("wheel deltas must be finite"));
                }
                Ok(value)
            };
            let mode = value.get("deltaMode");
            if mode.is_some_and(|mode| {
                !matches!(mode.as_u64(), Some(0..=2))
                    && !matches!(mode.as_str(), Some("pixel" | "line" | "page"))
            }) {
                return Err(BridgeError::invalid(
                    "wheel deltaMode must be pixel/line/page or 0/1/2",
                ));
            }
            let (scale_x, scale_y) =
                if mode == Some(&json!(1)) || mode.and_then(Value::as_str) == Some("line") {
                    (16.0, 16.0)
                } else if mode == Some(&json!(2)) || mode.and_then(Value::as_str) == Some("page") {
                    (frame.viewport.width, frame.viewport.height)
                } else {
                    (1.0, 1.0)
                };
            (delta("deltaX")? * scale_x, delta("deltaY")? * scale_y)
        };
        if !dx.is_finite() || !dy.is_finite() {
            return Err(BridgeError::invalid("scroll deltas exceed finite pixels"));
        }
        let mut candidate = self.scrolling.clone();
        if self.view_deadline_ns.get().is_some_and(deadline_expired) {
            return Err(BridgeError::new(
                BridgeErrorCode::Timeout,
                "scroll input deadline expired before publication",
            ));
        }
        if candidate.delta(page, &event.target, dx, dy, &mut frame)? {
            self.publish_scrolled_frame(frame, candidate)?;
        }
        Ok(())
    }

    fn catch_touch_move_consumed(
        &self,
        result: Option<&Value>,
        dispatches: &[EventDispatch],
        captured: Option<&TouchRoute>,
    ) -> bool {
        match result {
            Some(Value::Array(values)) => values
                .iter()
                .any(|value| self.catch_touch_move_consumed(Some(value), dispatches, captured)),
            Some(Value::Object(record)) => {
                let Some(handler) = record.get("handler").and_then(Value::as_str) else {
                    return false;
                };
                let Some(dispatch) = event_control_dispatch_index(record, dispatches)
                    .and_then(|index| dispatches.get(index))
                else {
                    return false;
                };
                self.wxml_event_binding(
                    captured,
                    &dispatch.current_target,
                    "touchmove",
                    dispatch.phase == container_core::EventPhase::Capture,
                )
                .is_some_and(|(binding, catches)| catches && binding == handler)
            }
            _ => false,
        }
    }

    fn publish_scrolled_frame(
        &mut self,
        mut frame: RenderFrame,
        candidate: ScrollRegistry,
    ) -> Result<(), BridgeError> {
        frame.frame_id = frame.frame_id.saturating_add(1);
        let frame_id = frame.frame_id;
        let authority = self.current_skia_frame_authority().cloned();
        let page_input = self
            .last_frame_input(self.skia_backend.renderer.snapshot_revision())
            .cloned();
        self.skia_backend
            .renderer
            .ensure_mut()
            .commit(frame)
            .map_err(|error| BridgeError::new(BridgeErrorCode::Render, error.to_string()))?;
        // Scrolling repaints retained layout; it consumes no newer page data.
        self.record_last_frame_input(page_input);
        self.carry_retained_skia_frame_authority(authority);
        self.scrolling = candidate;
        self.view.last_frame_id = Some(frame_id);
        self.observer_observation_pending = true;
        Ok(())
    }

    pub(super) fn page_scroll_to(
        &mut self,
        payload: &Map<String, Value>,
        deadline: Option<u64>,
        cancel_token: Option<&str>,
    ) -> Result<Value, BridgeError> {
        if self.effective_capability("wx.pageScrollTo") == CapabilitySupport::Unsupported {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "wx.pageScrollTo is unsupported on this session",
            ));
        }
        if deadline.is_some_and(deadline_expired) {
            return Err(BridgeError::new(
                BridgeErrorCode::Timeout,
                "pageScrollTo deadline expired",
            ));
        }
        if cancel_token.is_some_and(|token| self.is_cancelled(token)) {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "pageScrollTo cancelled",
            ));
        }
        if let Some(duration) = payload.get("duration") {
            let duration = duration
                .as_f64()
                .filter(|duration| duration.is_finite() && *duration >= 0.0)
                .ok_or_else(|| {
                    BridgeError::invalid(
                        "pageScrollTo duration must be finite nonnegative milliseconds",
                    )
                })?;
            if duration != 0.0 {
                return Err(BridgeError::new(
                    BridgeErrorCode::UnsupportedCapability,
                    "animated pageScrollTo is not implemented; use duration: 0",
                ));
            }
        }
        let page = self
            .app_service
            .pages()
            .current()
            .map(|page| page.id)
            .ok_or_else(|| {
                BridgeError::new(BridgeErrorCode::Render, "pageScrollTo requires a live page")
            })?;
        if !self.observer_frame_valid || self.observer_frame_page != Some(page) {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "pageScrollTo requires this page's committed frame",
            ));
        }
        // Selector scrolling consumes layout geometry and needs the same
        // presentation authority as selector queries. Numeric scrollTop is an
        // application intent; keep accepting it against the retained viewport
        // even while a developer preview is disconnected or awaiting a draw.
        if payload.contains_key("selector") && !self.is_current_frame_presented() {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "pageScrollTo selector awaits current frame presentation",
            ));
        }
        let mut frame = self
            .skia_backend
            .renderer
            .last_frame()
            .cloned()
            .ok_or_else(|| {
                BridgeError::new(
                    BridgeErrorCode::Render,
                    "pageScrollTo requires a committed frame",
                )
            })?;
        let target = frame
            .root
            .event_identity
            .as_ref()
            .unwrap_or(&frame.root.id)
            .clone();
        if !frame.root.scroll_container {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "page scrolling is disabled by page/app configuration",
            ));
        }
        let top = if let Some(selector) = payload.get("selector") {
            let selector = selector
                .as_str()
                .ok_or_else(|| BridgeError::invalid("pageScrollTo selector must be a string"))?;
            let selected = frame
                .query(selector, false)
                .map_err(|error| BridgeError::invalid(error.to_string()))?;
            let selected = selected.first().ok_or_else(|| {
                BridgeError::invalid("pageScrollTo selector did not match a node")
            })?;
            // Geometry is in the current viewport. Add the page offset to
            // recover document coordinates; nested scroll transforms remain.
            let geometries = frame.node_geometries();
            let bounds = geometries
                .iter()
                .find(|geometry| std::ptr::eq(geometry.node, *selected))
                .map(|geometry| geometry.bounds)
                .unwrap_or(selected.bounds);
            let offset = payload
                .get("offsetTop")
                .map(|offset| {
                    offset.as_f64().ok_or_else(|| {
                        BridgeError::invalid("pageScrollTo offsetTop must be numeric")
                    })
                })
                .transpose()?
                .unwrap_or_default() as f32;
            bounds.y - frame.viewport.y
                + frame.root.scroll_offset.unwrap_or_default().scroll_top
                + offset
        } else {
            payload
                .get("scrollTop")
                .and_then(Value::as_f64)
                .ok_or_else(|| {
                    BridgeError::invalid("pageScrollTo requires scrollTop or selector")
                })? as f32
        };
        if !top.is_finite() {
            return Err(BridgeError::invalid(
                "pageScrollTo scrollTop/offsetTop must be finite",
            ));
        }
        let mut candidate = self.scrolling.clone();
        if candidate.set_offset(Some(page), &target, None, Some(top.max(0.0)), &mut frame) {
            self.publish_scrolled_frame(frame, candidate)?;
        } else if !self.scrolling.pages.get(&Some(page)).is_some_and(|states| {
            states
                .values()
                .any(|state| state.target == target && state.page)
        }) {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "committed page is not a scrolling viewport",
            ));
        }
        Ok(json!({"errMsg":"pageScrollTo:ok"}))
    }

    pub(super) fn append_scroll_notifications(&mut self, messages: &mut Vec<BridgeEnvelope>) {
        let changed = !self.scrolling.pending.is_empty();
        let changes = std::mem::take(&mut self.scrolling.pending);
        for change in changes {
            let result = if change.page_scroll {
                change
                    .page
                    .map(|page| {
                        self.invoke_page_hook_for_id(
                            page,
                            "onPageScroll",
                            vec![json!({"scrollTop":change.offset.scroll_top})],
                        )
                    })
                    .transpose()
                    .map(|_| ())
            } else {
                let path = self
                    .skia_backend
                    .renderer
                    .last_frame()
                    .and_then(|frame| find_render_path(&frame.root, &change.target))
                    .map(|path| {
                        path.iter()
                            .map(|node| node.event_identity.as_ref().unwrap_or(&node.id).clone())
                            .collect::<Vec<_>>()
                    });
                if let Some(path) = path {
                    self.dispatch_view_event(json!({"type":"scroll","target":change.target,"path":path,"bubbles":false,"detail":{"scrollLeft":change.offset.scroll_left,"scrollTop":change.offset.scroll_top,"scrollWidth":change.width,"scrollHeight":change.height,"deltaX":change.delta_left,"deltaY":change.delta_top}}), None).map(|_| ())
                } else {
                    Ok(())
                }
            };
            if let Err(error) = result {
                let mut message = self.error_envelope(&error, String::new(), op::ERROR);
                message.payload["committed"] = json!(true);
                message.payload["phase"] = json!("scroll");
                messages.push(message);
            }
            if change.page_scroll && change.reach_bottom {
                if let Some(page) = change.page {
                    if let Err(error) =
                        self.invoke_page_hook_for_id(page, "onReachBottom", Vec::new())
                    {
                        let mut message = self.error_envelope(&error, String::new(), op::ERROR);
                        message.payload["committed"] = json!(true);
                        message.payload["phase"] = json!("reachBottom");
                        messages.push(message);
                    }
                }
            }
        }
        if changed {
            // A callback can throw after publication. Keep the visible frame
            // and expose the error without converting a successful mutation
            // into a failed bridge request.
            if let Err(error) = self.notify_observers(messages) {
                let mut message = self.error_envelope(&error, String::new(), op::ERROR);
                message.payload["committed"] = json!(true);
                message.payload["phase"] = json!("scroll-observers");
                messages.push(message);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "scrolling-test".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.refresh_integrity().unwrap();
        Session::new(manifest, SessionConfig::default()).unwrap()
    }

    #[test]
    fn surface_recovery_retires_pointer_deltas_without_changing_scroll_state_or_geometry() {
        let mut session = session();
        session
            .skia_backend
            .renderer
            .ensure_mut()
            .configure_page_render_mode(container_render_skia::PageRenderMode::ExternalFrame)
            .unwrap();
        session.config.host.window_width = 100;
        session.config.host.window_height = 100;
        session
            .app_service
            .dispatch_lifecycle(LifecycleEvent::Launch)
            .unwrap();
        let page = session.app_service.push_page("pages/home/index").unwrap();
        let mut rendered = frame();
        session
            .scrolling
            .reconcile(Some(page), &mut rendered, true)
            .unwrap();
        session
            .scrolling
            .delta(Some(page), "event:0", 0.0, 25.0, &mut rendered)
            .unwrap();
        session.scrolling.touch_positions.insert(3, (0.0, 90.0));
        let scroll_state = format!("{:?}", session.scrolling.pages);
        let pending = format!("{:?}", session.scrolling.pending);
        session
            .skia_backend
            .renderer
            .ensure_mut()
            .commit(rendered.clone())
            .unwrap();
        session.observer_frame_page = Some(page);
        session.observer_frame_valid = true;
        session.record_last_frame_input(Some(BrowserPageInput {
            page_id: page,
            route_path: "pages/home/index".into(),
            template_revision: session.view.template_revision,
            viewport: rendered.viewport,
        }));
        session.install_skia_frame_authority();
        let expected = ExternalFrameRecoveryExpected {
            session_id: session.config.session_id.clone(),
            page_id: page.0.to_string(),
            route_path: "pages/home/index".into(),
            viewport: rendered.viewport,
            renderer_profile: container_ir::RendererProfile::Skia,
            template_revision: session.view.template_revision.to_string(),
            render_revision: "1".into(),
            input_lifetime_revision: "0".into(),
        };
        session.app_service.drain_events();
        session.recover_external_frame(&expected).unwrap();
        assert!(session.scrolling.touch_positions.is_empty());
        assert_eq!(format!("{:?}", session.scrolling.pages), scroll_state);
        assert_eq!(format!("{:?}", session.scrolling.pending), pending);
        assert_eq!(session.skia_backend.renderer.last_frame(), Some(&rendered));
        assert!(session.app_service.drain_events().is_empty());
        // With the next surface's geometry eligible, reusing an id must
        // establish a new start instead of inheriting the old 30px delta.
        session.observer_frame_valid = true;
        let event = EventInput {
            event_type: "touchmove".into(),
            target: "event:0".into(),
            ..Default::default()
        };
        session
            .apply_scroll_default(&json!({"touchId":3,"x":0,"y":60}), &event, &[], None, None)
            .unwrap();
        assert_eq!(session.skia_backend.renderer.snapshot_revision(), 2);
        assert_eq!(session.skia_backend.renderer.last_frame(), Some(&rendered));
    }

    #[test]
    fn developer_owner_retirement_clears_orphan_scroll_capture_without_rewriting_offsets() {
        let mut session = session();
        let mut rendered = frame();
        session
            .scrolling
            .reconcile(None, &mut rendered, true)
            .unwrap();
        session
            .scrolling
            .delta(None, "event:0", 0.0, 25.0, &mut rendered)
            .unwrap();
        session.scrolling.touch_positions.insert(7, (0.0, 90.0));
        let before = (
            format!("{:?}", session.scrolling.pages),
            format!("{:?}", session.scrolling.pending),
        );
        session.retire_dev_preview("owner-detached").unwrap();
        assert!(session.scrolling.touch_positions.is_empty());
        assert_eq!(
            (
                format!("{:?}", session.scrolling.pages),
                format!("{:?}", session.scrolling.pending)
            ),
            before
        );
    }

    #[test]
    fn faulted_owner_retirement_revokes_scroll_capture_without_entering_application_js() {
        let mut session = session();
        session.scrolling.touch_positions.insert(7, (0.0, 90.0));
        session.record_execution_fault(&BridgeError::new(
            BridgeErrorCode::Timeout,
            "test prior timeout",
        ));
        assert!(session.retire_dev_preview("faulted-owner").is_err());
        assert!(session.scrolling.touch_positions.is_empty());
        assert!(session.execution_fault().is_some());
        assert!(!session.is_current_frame_presented());
    }

    fn frame() -> RenderFrame {
        let mut root = RenderNode::new(
            "page",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
        );
        root.tag = Some("page".into());
        root.scroll_container = true;
        let mut view = RenderNode::new(
            "duplicate",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 50.0,
            },
        );
        view.event_identity = Some("event:0".into());
        view.tag = Some("scroll-view".into());
        view.attributes.insert("scroll-y".into(), "true".into());
        view.attributes.insert("scroll-top".into(), "10".into());
        view.children.push(RenderNode::new(
            "content",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 200.0,
            },
        ));
        root.children.push(view);
        RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport: root.bounds,
            root,
        }
    }
    #[test]
    fn unchanged_binding_preserves_user_position_and_page_identity() {
        let mut registry = ScrollRegistry::default();
        let mut original = frame();
        registry
            .reconcile(Some(PageId(1)), &mut original, true)
            .unwrap();
        assert_eq!(
            original.root.children[0].scroll_offset.unwrap().scroll_top,
            10.0
        );
        registry
            .delta(Some(PageId(1)), "event:0", 0.0, 25.0, &mut original)
            .unwrap();
        let mut rerender = frame();
        registry
            .reconcile(Some(PageId(1)), &mut rerender, true)
            .unwrap();
        assert_eq!(
            rerender.root.children[0].scroll_offset.unwrap().scroll_top,
            35.0
        );
        let mut other = frame();
        registry
            .reconcile(Some(PageId(2)), &mut other, true)
            .unwrap();
        assert_eq!(
            other.root.children[0].scroll_offset.unwrap().scroll_top,
            10.0
        );
        registry.release_page(PageId(1));
        let mut reload = frame();
        registry
            .reconcile(Some(PageId(1)), &mut reload, true)
            .unwrap();
        assert_eq!(
            reload.root.children[0].scroll_offset.unwrap().scroll_top,
            10.0
        );
    }
    #[test]
    fn changed_declaration_commands_scroll_and_removed_occurrence_drops_state() {
        let mut registry = ScrollRegistry::default();
        let mut original = frame();
        registry
            .reconcile(Some(PageId(1)), &mut original, true)
            .unwrap();
        let mut next = frame();
        next.root.children[0]
            .attributes
            .insert("scroll-top".into(), "500".into());
        registry
            .reconcile(Some(PageId(1)), &mut next, true)
            .unwrap();
        assert_eq!(
            next.root.children[0].scroll_offset.unwrap().scroll_top,
            150.0
        );
        next.root.children.clear();
        registry
            .reconcile(Some(PageId(1)), &mut next, true)
            .unwrap();
        assert_eq!(registry.pages[&Some(PageId(1))].len(), 1);
    }

    #[test]
    fn deferred_content_retries_a_clamped_command_but_user_input_cancels_it() {
        let mut registry = ScrollRegistry::default();
        let mut empty = frame();
        empty.root.children[0].children.clear();
        empty.root.children[0]
            .attributes
            .insert("scroll-top".into(), "100".into());
        registry
            .reconcile(Some(PageId(1)), &mut empty, true)
            .unwrap();
        assert_eq!(
            empty.root.children[0].scroll_offset.unwrap().scroll_top,
            0.0
        );
        let mut populated = frame();
        populated.root.children[0]
            .attributes
            .insert("scroll-top".into(), "100".into());
        registry
            .reconcile(Some(PageId(1)), &mut populated, true)
            .unwrap();
        assert_eq!(
            populated.root.children[0].scroll_offset.unwrap().scroll_top,
            100.0
        );
        registry
            .delta(Some(PageId(1)), "event:0", 0.0, -30.0, &mut populated)
            .unwrap();
        let mut repeated = frame();
        repeated.root.children[0]
            .attributes
            .insert("scroll-top".into(), "100".into());
        registry
            .reconcile(Some(PageId(1)), &mut repeated, true)
            .unwrap();
        assert_eq!(
            repeated.root.children[0].scroll_offset.unwrap().scroll_top,
            70.0
        );
    }

    #[test]
    fn viewport_delta_uses_inverse_scale_and_page_uses_physical_viewport() {
        let mut registry = ScrollRegistry::default();
        let mut scaled = frame();
        scaled.root.children[0].style = Some(LayoutStyle {
            transform: Some(Transform2D {
                a: 2.0,
                d: 2.0,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        registry
            .reconcile(Some(PageId(1)), &mut scaled, true)
            .unwrap();
        registry
            .delta(Some(PageId(1)), "event:0", 0.0, 20.0, &mut scaled)
            .unwrap();
        assert_eq!(
            scaled.root.children[0].scroll_offset.unwrap().scroll_top,
            20.0
        );
        let mut tall = frame();
        tall.root.bounds.height = 1000.0;
        registry
            .reconcile(Some(PageId(2)), &mut tall, true)
            .unwrap();
        registry.set_offset(Some(PageId(2)), "page", None, Some(2000.0), &mut tall);
        assert_eq!(tall.root.scroll_offset.unwrap().scroll_top, 900.0);
        let mut disabled = frame();
        disabled.root.scroll_container = false;
        registry
            .reconcile(Some(PageId(3)), &mut disabled, true)
            .unwrap();
        assert!(!disabled.root.scroll_container);
        assert!(!registry.pages[&Some(PageId(3))]
            .values()
            .any(|state| state.page));
    }

    #[test]
    fn keyed_wrapper_reorder_keeps_child_position_without_public_id_identity() {
        let mut registry = ScrollRegistry::default();
        let make = |position: usize| {
            let mut result = frame();
            let mut wrapper = RenderNode::new("same-public-id", result.root.bounds);
            wrapper.key = Some("wrapper/key:with.punctuation".into());
            wrapper.event_identity = Some(format!("event:{position}"));
            let mut child = result.root.children.remove(0);
            child.event_identity = Some(format!("event:{position}.0"));
            wrapper.children.push(child);
            result.root.children.push(wrapper);
            result
        };
        let mut first = make(0);
        registry
            .reconcile(Some(PageId(1)), &mut first, true)
            .unwrap();
        registry
            .delta(Some(PageId(1)), "event:0.0", 0.0, 20.0, &mut first)
            .unwrap();
        let mut second = make(4);
        registry
            .reconcile(Some(PageId(1)), &mut second, true)
            .unwrap();
        assert_eq!(
            second.root.children[0].children[0]
                .scroll_offset
                .unwrap()
                .scroll_top,
            30.0
        );
        let mut duplicate = second.clone();
        duplicate
            .root
            .children
            .push(duplicate.root.children[0].clone());
        assert!(registry
            .clone()
            .reconcile(Some(PageId(1)), &mut duplicate, true)
            .is_err());
    }

    #[test]
    fn resolved_host_frame_offsets_are_authoritative_and_not_wxml_commands() {
        let mut registry = ScrollRegistry::default();
        let mut raw = frame();
        raw.root.scroll_container = false;
        raw.root.children[0].scroll_container = true;
        raw.root.children[0].scroll_offset = Some(ScrollOffset {
            scroll_left: 0.0,
            scroll_top: 12.0,
        });
        raw.root.children[0]
            .attributes
            .insert("scroll-top".into(), "not a numeric WXML command".into());
        registry
            .reconcile(Some(PageId(1)), &mut raw, false)
            .unwrap();
        assert_eq!(raw.root.children[0].scroll_offset.unwrap().scroll_top, 12.0);
        registry
            .delta(Some(PageId(1)), "event:0", 0.0, 15.0, &mut raw)
            .unwrap();
        assert_eq!(raw.root.children[0].scroll_offset.unwrap().scroll_top, 27.0);
        let mut next = raw.clone();
        next.root.children[0]
            .scroll_offset
            .as_mut()
            .unwrap()
            .scroll_top = 70.0;
        registry
            .reconcile(Some(PageId(1)), &mut next, false)
            .unwrap();
        assert_eq!(
            next.root.children[0].scroll_offset.unwrap().scroll_top,
            70.0
        );
        registry
            .delta(Some(PageId(1)), "event:0", 0.0, 10.0, &mut next)
            .unwrap();
        assert_eq!(
            next.root.children[0].scroll_offset.unwrap().scroll_top,
            80.0
        );
        next.root.children[0]
            .scroll_offset
            .as_mut()
            .unwrap()
            .scroll_top = 500.0;
        registry
            .reconcile(Some(PageId(1)), &mut next, false)
            .unwrap();
        assert_eq!(
            next.root.children[0].scroll_offset.unwrap().scroll_top,
            500.0
        );
        next.root.children[0]
            .scroll_offset
            .as_mut()
            .unwrap()
            .scroll_top = -1.0;
        registry
            .reconcile(Some(PageId(1)), &mut next, false)
            .unwrap();
        assert_eq!(
            container_render_skia::SoftwareRenderer::new()
                .commit(next)
                .unwrap_err(),
            container_render_skia::RenderError::InvalidScrollOffset
        );
    }

    #[test]
    fn catch_touchmove_uses_dispatch_occurrence_not_duplicate_public_id() {
        let session = session();
        let mut rendered = frame();
        rendered.root.event_identity = Some("event:root".into());
        rendered
            .root
            .attributes
            .insert("id".into(), "duplicate".into());
        rendered
            .root
            .attributes
            .insert("catchtouchmove".into(), "onCatch".into());
        rendered.root.children[0]
            .attributes
            .insert("id".into(), "duplicate".into());
        rendered.root.children[0]
            .attributes
            .insert("bindtouchmove".into(), "onNormal".into());
        let captured = TouchRoute {
            page: Some(PageId(1)),
            nodes: vec![
                TouchRouteNode::from_render(&rendered.root),
                TouchRouteNode::from_render(&rendered.root.children[0]),
            ],
        };
        let dispatches = dispatch_event(&EventInput {
            event_type: "touchmove".into(),
            target: "event:0".into(),
            path: vec!["event:root".into(), "event:0".into()],
            bubbles: true,
            ..EventInput::default()
        })
        .unwrap();
        let normal = json!([{"currentTarget":"duplicate","dispatchIndex":0,"handler":"onNormal","phase":"target","propagationStopped":true}]);
        assert!(!session.catch_touch_move_consumed(Some(&normal), &dispatches, Some(&captured)));
        let caught = json!([{"currentTarget":"duplicate","dispatchIndex":1,"handler":"onCatch","phase":"bubble","propagationStopped":true}]);
        assert!(session.catch_touch_move_consumed(Some(&caught), &dispatches, Some(&captured)));
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        {
            let mut observed = dispatches.clone();
            trim_event_dispatches_for_control(&mut observed, &normal);
            assert_eq!(observed.len(), 1);
            assert_eq!(observed[0].current_target, "event:0");
        }
    }

    #[test]
    fn synthetic_scroll_keeps_complete_target_route_after_publication() {
        let mut session = session();
        let mut rendered = frame();
        session
            .scrolling
            .reconcile(None, &mut rendered, true)
            .unwrap();
        session
            .skia_backend
            .renderer
            .ensure_mut()
            .commit(rendered)
            .unwrap();
        let mut messages = Vec::new();
        session.append_scroll_notifications(&mut messages);
        assert!(
            messages.iter().all(|message| message.op != op::ERROR),
            "scroll callbacks must dispatch using a complete root-to-target route: {messages:?}"
        );
        assert!(session.scrolling.pending.is_empty());
    }
}
