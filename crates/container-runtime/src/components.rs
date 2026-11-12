//! Session-owned, batched component graph. Template ownership (usingComponents)
//! and listener ownership travel with slot content, independently of its host.
use super::node_metadata::{project_dataset, project_mark};
use super::*;
use crate::animation_bindings::{
    OwnerKey as AnimationOwner, ScopeSnapshot as AnimationScope, WriteSnapshot as AnimationWrites,
};
use container_core::ViewRenderTask;
use std::sync::Arc;

#[path = "render_work.rs"]
mod render_work;
pub(super) use render_work::RenderWork;
use render_work::{RenderRead, RenderTicket};

#[derive(Clone, Copy)]
enum ViewScopeCleanup {
    AcknowledgedRelease,
    FinalSessionRetirement,
}

#[cfg(test)]
#[path = "declarative_tests.rs"]
mod declarative_tests;

/// Exact private component incarnation and completed mutation prefix sampled
/// before its snapshot was cloned. Neither ACK nor a repaint refreshes this.
#[derive(Clone, Debug)]
#[cfg_attr(
    not(any(feature = "quickjs-native", feature = "v8-native")),
    allow(dead_code)
)]
struct ComponentInputIdentity {
    token: u64,
    revision: u64,
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
impl ComponentInputIdentity {
    fn parse(value: &Value) -> Option<Self> {
        let value = value.as_object()?;
        if value.len() != 2 {
            return None;
        }
        let decimal = |key| {
            let text = value.get(key)?.as_str()?;
            let parsed = text.parse::<u64>().ok()?;
            (parsed.to_string() == text).then_some(parsed)
        };
        let token = decimal("instanceToken")?;
        (token != 0).then_some(Self {
            token,
            revision: decimal("mutationRevision")?,
        })
    }
}

#[cfg_attr(
    not(any(feature = "quickjs-native", feature = "v8-native")),
    allow(dead_code)
)]
pub(super) struct ConsumedComponentInputs {
    render_revision: u64,
    page: PageId,
    scopes: BTreeMap<String, ComponentInputIdentity>,
}

#[derive(Clone, Debug, Default)]
pub(super) struct ManagedPage {
    instances: Vec<Value>,
    selection_nodes: Vec<Value>,
    event_nodes: Vec<Value>,
    selection_index_active: bool,
    snapshots: BTreeMap<String, Value>,
    // A native mutation receipt invalidates presentation without cloning the
    // new component data. Detached previews cannot consume that pending data
    // until a normal render or an immutable mutation receipt refreshes them.
    snapshots_dirty: BTreeSet<String>,
    component_inputs: BTreeMap<String, ComponentInputIdentity>,
    pending_page_ready: Option<usize>,
    render_work: RenderWork,
    // A mutation can finish inside the engine before result serialization or
    // microtask draining fails. Such a page has no trustworthy live topology;
    // keep its scope/work ownership for teardown, but never replay discovery.
    reconciliation_failure: Option<BridgeError>,
    // Own even occurrences whose prepare call failed before returning a
    // snapshot. A missing receipt cannot prove that construction did not run.
    scope_leases: Vec<String>,
    // Scope IDs are opaque. Retain the typed physical parent and the latest
    // prepared preorder so disposal never infers ancestry from their bytes.
    scope_parents: BTreeMap<String, Option<String>>,
    scope_frontier: Vec<String>,
    // Exact parent binding inputs from successful prepare receipts. These are
    // distinct from normalized/defaulted properties and component-local data.
    prepared_bindings: BTreeMap<String, Value>,
    // Rejected new occurrences are disposed immediately, including their View
    // module caches. Retain one bounded input/error memo outside those scopes
    // so idle rendering cannot construct and execute the same failed frontier.
    rejected_frontier: Option<(RejectedFrontierInput, BridgeError)>,
}

#[derive(Clone, Debug, PartialEq)]
struct RejectedFrontierInput {
    root_epoch: (u64, Option<(u64, u64)>),
    root: WxmlAst,
    survivors: BTreeMap<String, Value>,
    prepared_bindings: BTreeMap<String, Value>,
}

impl ManagedPage {
    pub(super) fn contains_observer_scope(&self, scope: &str) -> bool {
        self.reconciliation_failure.is_none()
            && self
                .instances
                .iter()
                .any(|instance| instance.get("scopeId").and_then(Value::as_str) == Some(scope))
    }
    fn frontier_input(&self, page: PageId, ast: &WxmlAst) -> RejectedFrontierInput {
        RejectedFrontierInput {
            root_epoch: self.render_work.input_epoch(&format!("page:{}", page.0)),
            root: ast.clone(),
            survivors: self
                .instances
                .iter()
                .filter_map(|instance| {
                    let scope = instance.get("scopeId")?.as_str()?;
                    let snapshot = self.snapshots.get(scope)?;
                    Some((
                        scope.into(),
                        json!({
                            "data": snapshot.get("data"),
                            "properties": snapshot.get("properties"),
                        }),
                    ))
                })
                .collect(),
            prepared_bindings: self.prepared_bindings.clone(),
        }
    }

    fn lease_frontier(&mut self, specs: &[Value]) -> Result<(), BridgeError> {
        let mut seen = self.scope_leases.iter().cloned().collect::<BTreeSet<_>>();
        let mut frontier = Vec::with_capacity(specs.len());
        for spec in specs {
            let scope = spec
                .get("scopeId")
                .and_then(Value::as_str)
                .ok_or_else(|| Self::ownership_error("prepared component has no scope ID"))?;
            let parent = match spec.get("parentScopeId") {
                Some(Value::Null) => None,
                Some(Value::String(parent)) => Some(parent.clone()),
                _ => {
                    return Err(Self::ownership_error(
                        "prepared component has no typed parent",
                    ))
                }
            };
            if self
                .scope_parents
                .get(scope)
                .is_some_and(|previous| *previous != parent)
            {
                return Err(Self::ownership_error(
                    "prepared component changed its parent",
                ));
            }
            self.scope_parents.insert(scope.into(), parent);
            if seen.insert(scope.into()) {
                self.scope_leases.push(scope.into());
            }
            frontier.push(scope.into());
        }
        self.scope_frontier = frontier;
        // Validate the entire ownership graph before crossing an engine
        // boundary. A missing/cyclic parent cannot be safely torn down.
        self.ordered_scopes(self.scope_leases.iter().cloned())?;
        Ok(())
    }

    fn ownership_error(message: &str) -> BridgeError {
        BridgeError::new(
            BridgeErrorCode::Engine,
            format!("component ownership invariant: {message}"),
        )
    }

    /// The engine consumes disposal scopes in reverse. Supply physical
    /// preorder, retaining current-frontier sibling order and then accepted
    /// order for retired branches. The lease list owns unacknowledged creates.
    fn ordered_scopes(
        &self,
        requested: impl IntoIterator<Item = String>,
    ) -> Result<Vec<String>, BridgeError> {
        let mut remaining = requested.into_iter().collect::<BTreeSet<_>>();
        let mut seen = BTreeSet::new();
        let mut order = Vec::new();
        for scope in self
            .scope_frontier
            .iter()
            .map(String::as_str)
            .chain(
                self.instances
                    .iter()
                    .filter_map(|entry| entry.get("scopeId").and_then(Value::as_str)),
            )
            .chain(self.scope_leases.iter().map(String::as_str))
            .chain(self.snapshots.keys().map(String::as_str))
            .chain(remaining.iter().map(String::as_str))
        {
            if seen.insert(scope.to_owned()) {
                order.push(scope.to_owned());
            }
        }
        let mut children = BTreeMap::<Option<String>, Vec<String>>::new();
        for scope in &order {
            let parent = self
                .scope_parents
                .get(scope)
                .ok_or_else(|| Self::ownership_error("owned component has no parent metadata"))?;
            if parent.as_ref().is_some_and(|parent| !seen.contains(parent)) {
                return Err(Self::ownership_error(
                    "owned component parent is unavailable",
                ));
            }
            children
                .entry(parent.clone())
                .or_default()
                .push(scope.clone());
        }
        let mut visited = BTreeSet::new();
        let mut output = Vec::with_capacity(remaining.len());
        let mut pending = children.get(&None).cloned().unwrap_or_default();
        pending.reverse();
        while let Some(scope) = pending.pop() {
            if !visited.insert(scope.clone()) {
                return Err(Self::ownership_error(
                    "owned component graph contains a cycle",
                ));
            }
            if remaining.remove(&scope) {
                output.push(scope.clone());
            }
            if let Some(descendants) = children.get(&Some(scope)) {
                pending.extend(descendants.iter().rev().cloned());
            }
        }
        if visited.len() != order.len() || !remaining.is_empty() {
            return Err(Self::ownership_error(
                "owned component graph contains a cycle",
            ));
        }
        Ok(output)
    }

    fn release_scope_leases(&mut self, scopes: &[String]) {
        let removed = scopes.iter().collect::<BTreeSet<_>>();
        self.scope_leases.retain(|scope| !removed.contains(scope));
        self.scope_frontier.retain(|scope| !removed.contains(scope));
        self.scope_parents
            .retain(|scope, _| !removed.contains(scope));
        self.prepared_bindings
            .retain(|scope, _| !removed.contains(scope));
    }

    fn acknowledge_frontier(&mut self, specs: &[Value]) {
        for spec in specs {
            if let Some(scope) = spec.get("scopeId").and_then(Value::as_str) {
                self.prepared_bindings
                    .insert(scope.into(), spec["properties"].clone());
            }
        }
    }
}

struct ComponentReceipt {
    animation_writes: BTreeMap<String, AnimationWrites>,
    snapshots: BTreeMap<String, Value>,
    component_inputs: BTreeMap<String, ComponentInputIdentity>,
}

/// A successful engine transport is not itself a mutation acknowledgement.
/// Validate the whole batch before publishing any snapshot or releasing leases.
fn component_receipt(
    values: Vec<Value>,
    expected: BTreeSet<String>,
    phase: &str,
    disposal: bool,
) -> Result<ComponentReceipt, BridgeError> {
    let invalid = |detail: &str| {
        BridgeError::new(
            BridgeErrorCode::Engine,
            format!("component {phase} returned an invalid acknowledgement: {detail}"),
        )
    };
    if values.len() != 1 {
        return Err(invalid("expected exactly one batch result"));
    }
    let response = &values[0];
    let instances = response
        .get("instances")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("missing instances array"))?;
    if disposal {
        let scopes = response
            .get("acknowledgedScopeIds")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("missing disposal scope acknowledgement"))?;
        let mut acknowledged = BTreeSet::new();
        for scope in scopes {
            let scope = scope
                .as_str()
                .ok_or_else(|| invalid("invalid disposal scope acknowledgement"))?;
            if !acknowledged.insert(scope.to_owned()) {
                return Err(invalid("duplicate disposal scope acknowledgement"));
            }
        }
        if acknowledged != expected {
            return Err(invalid(
                "disposal scope acknowledgement does not match the request",
            ));
        }
    }
    let mut snapshots = BTreeMap::new();
    let mut indexes = BTreeSet::new();
    for instance in instances {
        let scope = instance
            .get("scopeId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("instance has no scope ID"))?;
        if !expected.contains(scope) || snapshots.contains_key(scope) {
            return Err(invalid("unexpected or duplicate instance scope"));
        }
        let index = instance
            .get("index")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("instance has no nonnegative index"))?;
        if !indexes.insert(index) {
            return Err(invalid("different scopes share one instance index"));
        }
        let snapshot = instance
            .get("snapshot")
            .filter(|value| {
                value.get("data").is_some_and(Value::is_object)
                    && value.get("properties").is_some_and(Value::is_object)
            })
            .ok_or_else(|| invalid("instance has no complete data/properties snapshot"))?;
        if disposal && snapshot.get("detached").and_then(Value::as_bool) != Some(true) {
            return Err(invalid("disposed instance is not detached"));
        }
        snapshots.insert(scope.to_owned(), snapshot.clone());
    }
    if !disposal && snapshots.keys().cloned().collect::<BTreeSet<_>>() != expected {
        return Err(invalid("instance scopes do not match the complete request"));
    }
    Ok(ComponentReceipt {
        animation_writes: BTreeMap::new(),
        snapshots,
        component_inputs: BTreeMap::new(),
    })
}

fn component_scope_ids(instances: &[Value]) -> BTreeSet<String> {
    instances
        .iter()
        .filter_map(|entry| entry.get("scopeId").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

/// Fingerprint the actual documents and their lexical module programs once at
/// an operation boundary. Presentation-only styles/assets do not invalidate
/// executable results. Template aliases are retained exactly as supplied to
/// the evaluator so an import/include change cannot reuse stale expansion.
pub(super) fn render_program_fingerprint(
    manifest: &ContainerManifestV1,
    templates: &BTreeMap<String, WxmlAst>,
) -> Result<String, BridgeError> {
    let bindings = manifest
        .templates
        .iter()
        .map(|template| (&template.id, &template.wxs_modules))
        .collect::<BTreeMap<_, _>>();
    let bytes = serde_json::to_vec(&(
        templates,
        bindings,
        &manifest.view_scripts,
        &manifest.view_compilation,
        &manifest.modern_view,
    ))
    .map_err(|error| {
        BridgeError::new(
            BridgeErrorCode::Render,
            format!("cannot fingerprint View program: {error}"),
        )
    })?;
    Ok(container_ir::hex_digest(&bytes))
}

#[derive(Clone)]
struct PendingViewRender {
    ticket: RenderTicket,
    task: ViewRenderTask,
}

fn read_scope_template(
    work: &mut RenderWork,
    scope: &str,
    template: &str,
    data: &Value,
    pending: &mut Vec<PendingViewRender>,
) -> Result<Option<WxmlAst>, BridgeError> {
    match work.read(scope, template, data) {
        RenderRead::Ready(result) => result.map(Some),
        RenderRead::Pending(ticket) => {
            if !pending.iter().any(|job| job.ticket == ticket) {
                pending.push(PendingViewRender {
                    ticket,
                    task: ViewRenderTask {
                        task_id: scope.into(),
                        scope_id: scope.into(),
                        document_id: template
                            .strip_prefix("template:")
                            .unwrap_or(template)
                            .into(),
                        data: data.clone(),
                    },
                });
            }
            Ok(None)
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct RenderOwnership {
    pub event_owner: Option<String>,
    /// Declaration document of the event owner, before lexical include/import
    /// provenance is applied. Retained even when declarative hosts are removed.
    pub event_owner_document: Option<String>,
    pub component_scope: Option<String>,
    /// Resolved component template for a host, independent of lexical origin
    /// and composed ancestry (which can change through template/slot expansion).
    pub component_document: Option<String>,
    /// Lexical source document, retained through component and slot projection.
    pub template: String,
}

#[derive(Clone)]
struct OwnedNode {
    node: WxmlNode,
    template: String,
    owner: Option<String>,
    component_scope: Option<String>,
    component_document: Option<String>,
    // Keep declaration ancestry when light content is projected into a slot.
    // Physical render ancestry and component reference ownership can differ.
    selection_ancestors: Vec<Value>,
    children: Vec<OwnedNode>,
}

/// Both execution modes plan the same declaration-owned occurrence graph.
/// Declarative documents have no AppService registrations; their host wrapper
/// stays transparent for the existing headless presentation contract.
#[derive(Clone, Copy)]
enum ComponentExpansion<'a> {
    Managed {
        snapshots: &'a BTreeMap<String, Value>,
        prepared_bindings: &'a BTreeMap<String, Value>,
    },
    Declarative,
}

fn own_nodes(nodes: &[WxmlNode], template: &str, owner: Option<&str>) -> Vec<OwnedNode> {
    own_nodes_with_ancestors(nodes, template, owner, &[])
}

fn selection_node(node: &WxmlNode) -> Option<Value> {
    match node {
        WxmlNode::Element { tag, attrs, .. } if tag != "block" => Some(json!({
            "tag": tag,
            "id": attrs.get("id").map(String::as_str).unwrap_or(""),
            "classes": attrs.get("class").map(|classes| classes.split_whitespace().collect::<Vec<_>>()).unwrap_or_default(),
        })),
        _ => None,
    }
}

fn own_nodes_with_ancestors(
    nodes: &[WxmlNode],
    template: &str,
    owner: Option<&str>,
    ancestors: &[Value],
) -> Vec<OwnedNode> {
    nodes
        .iter()
        .map(|node| {
            let mut shell = node.clone();
            if let WxmlNode::Element { children, .. } = &mut shell {
                children.clear();
            }
            let mut child_ancestors = ancestors.to_vec();
            if let Some(selector) = selection_node(node) {
                child_ancestors.push(selector);
            }
            OwnedNode {
                children: match node {
                    WxmlNode::Element { children, .. } => {
                        own_nodes_with_ancestors(children, template, owner, &child_ancestors)
                    }
                    _ => Vec::new(),
                },
                node: shell,
                template: template.into(),
                owner: owner.map(str::to_owned),
                component_scope: None,
                component_document: None,
                selection_ancestors: ancestors.to_vec(),
            }
        })
        .collect()
}

fn node_path(node: &WxmlNode, parent: &str, index: usize) -> String {
    let segment = match node {
        WxmlNode::Element {
            key: Some(key),
            key_scope,
            ..
        } => keyed_wxml_path_segment(key_scope.as_deref(), key),
        _ => index.to_string(),
    };
    if parent.is_empty() {
        segment
    } else {
        format!("{parent}.{segment}")
    }
}

/// Project already evaluated light nodes, preserving their declaration data,
/// template and listener owner. Unused light nodes never become occurrences.
fn project_slots(nodes: Vec<OwnedNode>, light: &[OwnedNode], multiple: bool) -> Vec<OwnedNode> {
    let mut output = Vec::new();
    for mut node in nodes {
        if let WxmlNode::Element { tag, attrs, .. } = &node.node {
            if tag == "slot" {
                let name = attrs.get("name").map(|name| name.trim()).unwrap_or("");
                let mut selected = light
                    .iter()
                    .filter(|child| {
                        let slot = match &child.node {
                            WxmlNode::Element { attrs, .. } => {
                                attrs.get("slot").map(String::as_str).unwrap_or("")
                            }
                            _ => "",
                        };
                        if multiple {
                            slot.trim() == name
                        } else {
                            name.is_empty()
                        }
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if selected.is_empty() {
                    selected = project_slots(node.children, light, multiple);
                } else {
                    for child in &mut selected {
                        if let WxmlNode::Element {
                            attrs,
                            bound_values,
                            ..
                        } = &mut child.node
                        {
                            attrs.remove("slot");
                            bound_values.remove("slot");
                        }
                    }
                }
                output.extend(selected);
                continue;
            }
        }
        node.children = project_slots(node.children, light, multiple);
        output.push(node);
    }
    output
}

fn flatten(
    nodes: Vec<OwnedNode>,
    path: &str,
    ownership: &mut BTreeMap<String, RenderOwnership>,
) -> Vec<WxmlNode> {
    nodes
        .into_iter()
        .enumerate()
        .map(|(index, mut owned)| {
            let path = node_path(&owned.node, path, index);
            ownership.insert(
                path.clone(),
                RenderOwnership {
                    event_owner_document: owned.owner.as_ref().map(|_| owned.template.clone()),
                    event_owner: owned.owner,
                    component_scope: owned.component_scope,
                    component_document: owned.component_document,
                    template: match &owned.node {
                        WxmlNode::Element {
                            lexical_origin: Some(origin),
                            ..
                        } => origin.document_id.clone(),
                        _ => owned.template,
                    },
                },
            );
            if let WxmlNode::Element { children, .. } = &mut owned.node {
                *children = flatten(owned.children, &path, ownership);
            }
            owned.node
        })
        .collect()
}

/// Publish ordinary nodes too: selecting the first matching native node must
/// not skip ahead to a later custom component with the same public selector.
fn collect_selection_nodes(nodes: &[OwnedNode], instances: &mut [Value]) -> Vec<Value> {
    fn visit(nodes: &[OwnedNode], output: &mut Vec<Value>, orders: &mut BTreeMap<String, usize>) {
        for node in nodes {
            if let Some(mut selection) = selection_node(&node.node) {
                let order = output.len();
                selection["ancestors"] = json!(node.selection_ancestors);
                selection["order"] = json!(order);
                if let Some(scope) = &node.component_scope {
                    orders.insert(scope.clone(), order);
                }
                output.push(json!({
                    "ownerScopeId": node.owner,
                    "componentScopeId": node.component_scope,
                    "selection": selection,
                }));
            }
            visit(&node.children, output, orders);
        }
    }
    let mut nodes_output = Vec::new();
    let mut orders = BTreeMap::new();
    visit(nodes, &mut nodes_output, &mut orders);
    for instance in instances {
        if let Some(order) = instance
            .get("scopeId")
            .and_then(Value::as_str)
            .and_then(|scope| orders.get(scope))
        {
            instance["selection"]["order"] = json!(order);
        }
    }
    nodes_output
}

/// Listener topology follows the composed render tree, while owner scopes
/// preserve the declaration boundary of projected slot content. The keys use
/// the same keyed paths as `flatten` and the renderer's event identity.
fn collect_event_nodes(nodes: &[OwnedNode]) -> Result<Vec<Value>, BridgeError> {
    fn visit(
        nodes: &[OwnedNode],
        path: &str,
        parent_key: Option<&str>,
        output: &mut Vec<Value>,
        keys: &mut BTreeSet<String>,
    ) -> Result<(), BridgeError> {
        for (index, owned) in nodes.iter().enumerate() {
            let path = node_path(&owned.node, path, index);
            let mut next_parent = parent_key.map(str::to_owned);
            if let WxmlNode::Element {
                tag,
                attrs,
                bound_values,
                ..
            } = &owned.node
            {
                // WXML block has no render/event node. Its descendants keep
                // their keyed source paths and the nearest physical parent.
                if tag != "block" {
                    let key = format!("event:{path}");
                    if !keys.insert(key.clone()) {
                        return Err(BridgeError::new(
                            BridgeErrorCode::Render,
                            "duplicate keyed event identity",
                        ));
                    }
                    output.push(json!({
                        "key":key,"parentKey":parent_key,
                        "ownerScopeId":owned.owner,"componentScopeId":owned.component_scope,
                        "attributes":attrs,
                        "dataset":project_dataset(attrs,bound_values),
                        "mark":project_mark(attrs,bound_values),
                    }));
                    next_parent = Some(key);
                }
            }
            visit(&owned.children, &path, next_parent.as_deref(), output, keys)?;
        }
        Ok(())
    }
    let mut nodes_output = Vec::new();
    visit(nodes, "", None, &mut nodes_output, &mut BTreeSet::new())?;
    Ok(nodes_output)
}

impl Session {
    /// The caller sampled this private stamp snapshot with root page data,
    /// before entering View or component hooks. Equality cache hits keep it.
    pub(super) fn set_animation_root_snapshot(
        &mut self,
        page: PageId,
        snapshot: Arc<AnimationScope>,
    ) {
        self.component_pages
            .entry(page)
            .or_default()
            .render_work
            .set_input_snapshot(&format!("page:{}", page.0), snapshot);
    }

    /// Collect from the exact evaluated tree and its clone-time scope cache.
    /// No live ledger sampling occurs here or during presentation ACK.
    pub(super) fn collect_animation_bindings(
        &self,
        page: PageId,
        ast: &WxmlAst,
        ownership: &BTreeMap<String, RenderOwnership>,
    ) -> Result<Vec<crate::animation_bindings::BindingInput>, BridgeError> {
        fn visit<'a>(
            nodes: &'a [WxmlNode],
            parent: &str,
            output: &mut Vec<(String, String, &'a Value)>,
        ) -> Result<(), BridgeError> {
            for (index, node) in nodes.iter().enumerate() {
                let path = node_path(node, parent, index);
                if let WxmlNode::Element {
                    tag,
                    attrs,
                    bound_values,
                    source_site,
                    children,
                    ..
                } = node
                {
                    if tag != "block" && attrs.contains_key("animation") {
                        let payload = bound_values.get("animation").ok_or_else(|| {
                            BridgeError::new(
                                BridgeErrorCode::UnsupportedCapability,
                                "animation requires a typed evaluator binding",
                            )
                        })?;
                        if !payload.is_null() && payload.as_str() != Some("") {
                            let site = source_site.clone().ok_or_else(|| {
                                BridgeError::new(
                                    BridgeErrorCode::Render,
                                    "animation source occurrence unavailable",
                                )
                            })?;
                            output.push((path.clone(), site, payload));
                        }
                    }
                    visit(children, &path, output)?;
                }
            }
            Ok(())
        }
        let mut borrowed = Vec::new();
        visit(&ast.nodes, "", &mut borrowed)?;
        crate::animation_bindings::preflight_payloads(
            borrowed.iter().map(|(_, _, payload)| *payload),
        )?;
        let work = self
            .component_pages
            .get(&page)
            .map(|graph| &graph.render_work);
        let root = format!("page:{}", page.0);
        let mut output = Vec::new();
        for (path, site, payload) in borrowed {
            let scope = ownership
                .get(&path)
                .and_then(|owner| owner.event_owner.as_deref())
                .unwrap_or(&root);
            let work = work.ok_or_else(|| {
                BridgeError::new(
                    BridgeErrorCode::Render,
                    "animation input scope cache unavailable",
                )
            })?;
            let snapshot = work.input_snapshot(scope).ok_or_else(|| {
                BridgeError::new(
                    BridgeErrorCode::Render,
                    "animation clone-time owner snapshot unavailable",
                )
            })?;
            let source = work
                .attribute_sources(scope)
                .iter()
                .find(|source| source.source_site == site && source.attribute == "animation")
                .cloned()
                .ok_or_else(|| {
                    BridgeError::new(
                        BridgeErrorCode::UnsupportedCapability,
                        "animation evaluator provenance unavailable",
                    )
                })?;
            output.push(crate::animation_bindings::BindingInput {
                occurrence: format!("event:{path}"),
                source_site: site,
                scope_snapshot: snapshot,
                source,
                payload: payload.clone(),
            });
        }
        Ok(output)
    }

    #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
    fn authenticate_component_receipt(
        &mut self,
        _page: PageId,
        receipt: ComponentReceipt,
    ) -> Result<ComponentReceipt, BridgeError> {
        Ok(receipt)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn authenticate_component_receipt(
        &mut self,
        page: PageId,
        mut receipt: ComponentReceipt,
    ) -> Result<ComponentReceipt, BridgeError> {
        if receipt.snapshots.is_empty() {
            return Ok(receipt);
        }
        let scopes = receipt.snapshots.keys().cloned().collect::<Vec<_>>();
        #[allow(unused_variables)]
        let proofs = match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(BridgeErrorCode::Engine, "QuickJS unavailable")
                        })?
                        .capture_component_snapshot_receipts(page.0, &scopes)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    return Ok(receipt);
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| BridgeError::new(BridgeErrorCode::Engine, "V8 unavailable"))?
                        .capture_component_snapshot_receipts(page.0, &scopes)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    return Ok(receipt);
                }
            }
        };
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        for (scope, snapshot) in &receipt.snapshots {
            let proof = &proofs["scopes"][scope];
            let Some(json) = proof["snapshotJson"].as_str() else {
                continue;
            };
            let Ok(authentic) = serde_json::from_str::<Value>(json) else {
                continue;
            };
            if authentic == *snapshot {
                if let Some(identity) = ComponentInputIdentity::parse(&proof["identity"]) {
                    let page_token = proofs["pageToken"]
                        .as_str()
                        .and_then(|text| text.parse::<u64>().ok())
                        .filter(|token| *token != 0)
                        .ok_or_else(|| {
                            BridgeError::new(
                                BridgeErrorCode::Engine,
                                "animation Page incarnation unavailable",
                            )
                        })?;
                    let owner = AnimationOwner {
                        page_id: page.0,
                        page_incarnation: page_token,
                        scope_id: Some(scope.clone()),
                        scope_incarnation: Some(identity.token),
                    };
                    let writes = AnimationWrites::from_private(owner, &proof["writeSnapshot"])?;
                    receipt.animation_writes.insert(scope.clone(), writes);
                    receipt.component_inputs.insert(scope.clone(), identity);
                }
            }
        }
        Ok(receipt)
    }

    /// A retained sample carries the same consumed component prefix; it must
    /// never resample a newer graph or live receiver after presentation.
    pub(super) fn carry_consumed_component_inputs(
        &mut self,
        previous_revision: u64,
        next_revision: u64,
    ) {
        if let Some(receipt) = self
            .consumed_component_inputs
            .as_mut()
            .filter(|receipt| receipt.render_revision == previous_revision)
        {
            receipt.render_revision = next_revision;
        }
    }

    /// Called only after a normal generated frame and all its materialization
    /// checks were accepted. The final graph contains the exact component
    /// snapshots used by that frame, not live samples taken after ready/ACK.
    pub(super) fn capture_consumed_component_inputs(&mut self) {
        self.consumed_component_inputs = self.committed_frame_input.as_ref().and_then(|input| {
            let graph = self.component_pages.get(&input.input.page_id)?;
            Some(ConsumedComponentInputs {
                render_revision: input.revision,
                page: input.input.page_id,
                scopes: graph.component_inputs.clone(),
            })
        });
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn component_mutation_was_consumed(
        &self,
        scope: &str,
        event: &Map<String, Value>,
    ) -> bool {
        let Some(receipt) = &self.consumed_component_inputs else {
            return false;
        };
        let Some(input) = self.committed_frame_input.as_ref() else {
            return false;
        };
        if !self.accepted_skia_scene
            || self.browser_route_active()
            || receipt.render_revision != self.skia_backend.renderer.snapshot_revision()
            || input.revision != receipt.render_revision
            || input.input.page_id != receipt.page
            || !self
                .app_service
                .pages()
                .current()
                .is_some_and(|page| page.id == receipt.page)
        {
            return false;
        }
        let Some(accepted) = receipt.scopes.get(scope) else {
            return false;
        };
        if event.get("pageId").and_then(Value::as_str) != Some(receipt.page.0.to_string().as_str())
        {
            return false;
        }
        let identity = json!({"instanceToken":event.get("instanceToken"),"mutationRevision":event.get("mutationRevision")});
        let Some(event_identity) = ComponentInputIdentity::parse(&identity) else {
            return false;
        };
        event_identity.revision != 0
            && event_identity.token == accepted.token
            && event_identity.revision <= accepted.revision
    }

    fn evaluate_view_frontier(
        &self,
        work: &mut RenderWork,
        pending: Vec<PendingViewRender>,
        templates: &BTreeMap<String, WxmlAst>,
        preview: bool,
    ) -> Result<(), BridgeError> {
        if self.engine_execution_is_faulted() {
            return Err(BridgeError::new(
                BridgeErrorCode::Engine,
                "AppService requires a new session",
            ));
        }
        if pending.is_empty() {
            return Ok(());
        }
        fn declares_wxs(nodes: &[WxmlNode]) -> bool {
            nodes.iter().any(|node| match node {
                WxmlNode::Element { tag, children, .. } => tag == "wxs" || declares_wxs(children),
                _ => false,
            })
        }
        let has_view_modules = self.manifest.modern_view.is_some()
            || !self.manifest.view_scripts.is_empty()
            || self
                .manifest
                .templates
                .iter()
                .any(|template| !template.wxs_modules.is_empty())
            || self
                .manifest
                .assets
                .iter()
                .any(|asset| asset.path.ends_with(".wxs"))
            || templates
                .values()
                .any(|template| declares_wxs(&template.nodes));
        if preview && has_view_modules && self.view_execution.borrow().is_available() {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "native View preview has uncached executable work; an isolated restart is required",
            ));
        }
        let tasks = pending
            .iter()
            .map(|job| job.task.clone())
            .collect::<Vec<_>>();
        let result = if self.view_execution.borrow().is_available() {
            self.view_execution
                .borrow_mut()
                .render_documents_with_sources(
                    &self.manifest,
                    templates,
                    &tasks,
                    &self.view_execution_budget(),
                )
        } else {
            tasks
                .iter()
                .map(|task| {
                    let source = templates
                        .get(&task.document_id)
                        .or_else(|| templates.get(&format!("template:{}", task.document_id)))
                        .ok_or_else(|| {
                            BridgeError::new(
                                BridgeErrorCode::Render,
                                "View document is unavailable",
                            )
                        })?;
                    container_ir::evaluate_wxml_with_templates_and_provenance(
                        source,
                        &task.data,
                        templates,
                        Some(&task.document_id),
                    )
                    .map(|ast| (task.task_id.clone(), ast))
                    .map_err(|error| {
                        BridgeError::new(
                            BridgeErrorCode::Render,
                            format!(
                                "template template:{} data evaluation failed: {error}",
                                task.document_id,
                            ),
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        };
        let decoded = result.and_then(|results| {
            let mut by_id = BTreeMap::new();
            for (id, ast) in results {
                if by_id.insert(id, ast).is_some() {
                    return Err(BridgeError::new(
                        BridgeErrorCode::Engine,
                        "duplicate View render result",
                    ));
                }
            }
            if by_id.len() != tasks.len()
                || tasks.iter().any(|task| !by_id.contains_key(&task.task_id))
            {
                return Err(BridgeError::new(
                    BridgeErrorCode::Engine,
                    "incomplete View render result batch",
                ));
            }
            Ok(by_id)
        });
        match decoded {
            Ok(mut results) => work.commit_batch_with_sources(
                pending
                    .into_iter()
                    .map(|job| {
                        (
                            job.ticket,
                            Ok(results.remove(&job.task.task_id).expect("validated task")),
                        )
                    })
                    .collect(),
            ),
            Err(error) => {
                // A later task can fail after earlier WXS calls changed state.
                // Cache the failed batch in full so discovery cannot replay it.
                work.commit_batch(
                    pending
                        .into_iter()
                        .map(|job| (job.ticket, Err(error.clone())))
                        .collect(),
                )?;
                Err(error)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn evaluate_cached_scope(
        &self,
        work: &mut RenderWork,
        scope: &str,
        template: &str,
        data: &Value,
        templates: &BTreeMap<String, WxmlAst>,
        preview: bool,
    ) -> Result<WxmlAst, BridgeError> {
        let mut pending = Vec::new();
        if let Some(ast) = read_scope_template(work, scope, template, data, &mut pending)? {
            return Ok(ast);
        }
        self.evaluate_view_frontier(work, pending, templates, preview)?;
        read_scope_template(work, scope, template, data, &mut Vec::new())?.ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::Engine,
                "View render work was not committed",
            )
        })
    }

    fn release_view_scopes(&self, scopes: &[String]) -> Result<(), BridgeError> {
        self.cleanup_view_scopes(scopes, ViewScopeCleanup::AcknowledgedRelease)
    }

    fn cleanup_view_scopes(
        &self,
        scopes: &[String],
        cleanup: ViewScopeCleanup,
    ) -> Result<(), BridgeError> {
        if self.engine_execution_is_faulted() {
            return Err(BridgeError::new(
                BridgeErrorCode::Engine,
                "AppService requires a new session",
            ));
        }
        // Acknowledged release still needs a successful View-side
        // acknowledgement. Once the View has been poisoned, treating an
        // unavailable provider (or an empty scope set) as a successful
        // release would silently drop native ownership and make the next
        // session observe a stale component graph. Final retirement is the
        // explicit escape hatch: it invalidates the poisoned View without
        // asking it to execute another release batch.
        if matches!(cleanup, ViewScopeCleanup::AcknowledgedRelease)
            && self.view_execution.borrow().is_faulted()
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Engine,
                "AppService requires a new session",
            ));
        }
        self.observers.borrow_mut().release_scopes(scopes);
        if matches!(cleanup, ViewScopeCleanup::FinalSessionRetirement)
            && self.view_execution.borrow_mut().retire_poisoned()
        {
            return Ok(());
        }
        if scopes.is_empty() || !self.view_execution.borrow().is_available() {
            return Ok(());
        }
        self.view_execution
            .borrow_mut()
            .release_scopes(scopes, &self.view_execution_budget())
    }

    /// Terminal app unload only. A healthy View still acknowledges release;
    /// a known-poisoned View relinquishes native ownership without guest JS.
    pub(super) fn retire_standalone_view_scopes(&mut self) -> Result<(), BridgeError> {
        let scopes = self
            .standalone_render_work
            .scope_ids()
            .into_iter()
            .collect::<Vec<_>>();
        self.cleanup_view_scopes(&scopes, ViewScopeCleanup::FinalSessionRetirement)?;
        self.standalone_render_work = RenderWork::default();
        Ok(())
    }

    pub(super) fn ensure_component_page_reusable(&self, page: PageId) -> Result<(), BridgeError> {
        if let Some(error) = self
            .component_pages
            .get(&page)
            .and_then(|graph| graph.reconciliation_failure.as_ref())
        {
            return Err(error.clone());
        }
        Ok(())
    }

    /// Share the initial component preparation's page evaluation with its
    /// first committed frame. Data changes in onLoad/onShow reserve new work;
    /// lifecycle metadata alone does not replay document evaluation.
    pub(super) fn evaluate_page_template(
        &mut self,
        page: PageId,
        template: &str,
        _source: &WxmlAst,
        data: &Value,
        templates: &BTreeMap<String, WxmlAst>,
    ) -> Result<WxmlAst, BridgeError> {
        self.ensure_component_page_reusable(page)?;
        let fingerprint = render_program_fingerprint(&self.manifest, templates)?;
        let mut work = self
            .component_pages
            .entry(page)
            .or_default()
            .render_work
            .clone();
        work.begin_program(fingerprint);
        let result = self.evaluate_cached_scope(
            &mut work,
            &format!("page:{}", page.0),
            template,
            data,
            templates,
            false,
        );
        self.component_pages.entry(page).or_default().render_work = work;
        result
    }

    /// Candidate evaluation owns a cloned work cache. It cannot publish a
    /// speculative result or error into the live page's retained work.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn preview_page_template(
        &self,
        live: &Session,
        page: PageId,
        template: &str,
        _source: &WxmlAst,
        data: &Value,
        templates: &BTreeMap<String, WxmlAst>,
    ) -> Result<WxmlAst, BridgeError> {
        live.ensure_component_page_reusable(page)?;
        let mut work = live
            .component_pages
            .get(&page)
            .map(|graph| graph.render_work.clone())
            .unwrap_or_default();
        work.begin_program(render_program_fingerprint(&self.manifest, templates)?);
        self.evaluate_cached_scope(
            &mut work,
            &format!("page:{}", page.0),
            template,
            data,
            templates,
            true,
        )
    }

    pub(super) fn evaluate_standalone_template(
        &mut self,
        live: Option<&Session>,
        template: &str,
        _source: &WxmlAst,
        data: &Value,
        templates: &BTreeMap<String, WxmlAst>,
    ) -> Result<WxmlAst, BridgeError> {
        let mut work = live
            .map(|session| session.standalone_render_work.clone())
            .unwrap_or_else(|| self.standalone_render_work.clone());
        work.begin_program(render_program_fingerprint(&self.manifest, templates)?);
        let result = self.evaluate_cached_scope(
            &mut work,
            "standalone",
            template,
            data,
            templates,
            live.is_some(),
        );
        if live.is_none() {
            self.standalone_render_work = work;
        }
        result
    }

    /// The declarative/headless path uses the same occurrence and slot planner
    /// as managed components. Preview work belongs to the candidate, never the
    /// live page; failed inputs remain cached without replacing the last frame.
    pub(super) fn declarative_component_tree(
        &mut self,
        page: Option<PageId>,
        ast: &WxmlAst,
        template: &str,
        templates: &BTreeMap<String, WxmlAst>,
        live: Option<&Session>,
    ) -> Result<(WxmlAst, BTreeMap<String, RenderOwnership>), BridgeError> {
        let source = live.unwrap_or(self);
        if let Some(page) = page {
            source.ensure_component_page_reusable(page)?;
        }
        let mut work = page
            .and_then(|page| source.component_pages.get(&page))
            .map(|graph| graph.render_work.clone())
            .unwrap_or_else(|| {
                if page.is_none() {
                    source.standalone_render_work.clone()
                } else {
                    RenderWork::default()
                }
            });
        work.begin_program(render_program_fingerprint(&self.manifest, templates)?);
        let root_scope = page
            .map(|page| format!("page:{}", page.0))
            .unwrap_or_else(|| "standalone".into());
        let mut specs = Vec::new();
        let result = self
            .settle_owned_components(
                own_nodes(&ast.nodes, template, None),
                &root_scope,
                None,
                "",
                templates,
                ComponentExpansion::Declarative,
                &mut work,
                &mut specs,
                0,
                live.is_some(),
                self,
            )
            .and_then(|owned| {
                let mut retained = BTreeSet::from([root_scope]);
                for spec in &specs {
                    let scope = spec["scopeId"].as_str().expect("planned scope").to_owned();
                    if !retained.insert(scope) {
                        return Err(BridgeError::new(
                            BridgeErrorCode::Render,
                            "duplicate keyed component identity",
                        ));
                    }
                }
                // A successful plan retires missing occurrences, including work
                // from an earlier rejected plan. Unused light content never enters
                // this set; hidden/cached pages retain their own independent work.
                if live.is_none() {
                    let removed = work
                        .scope_ids()
                        .difference(&retained)
                        .cloned()
                        .collect::<Vec<_>>();
                    self.release_view_scopes(&removed)?;
                }
                work.retain_scopes(&retained);
                let mut ownership = BTreeMap::new();
                let nodes = flatten(owned, "", &mut ownership);
                Ok((
                    WxmlAst {
                        version: ast.version,
                        nodes,
                    },
                    ownership,
                ))
            });
        if live.is_none() {
            if let Some(page) = page {
                self.component_pages.entry(page).or_default().render_work = work;
            } else {
                self.standalone_render_work = work;
            }
        }
        result
    }

    #[cfg(test)]
    pub(super) fn clone_page_render_work(
        &self,
        page: PageId,
        templates: &BTreeMap<String, WxmlAst>,
    ) -> Result<RenderWork, BridgeError> {
        let mut work = self
            .component_pages
            .get(&page)
            .map(|graph| graph.render_work.clone())
            .unwrap_or_default();
        work.begin_program(render_program_fingerprint(&self.manifest, templates)?);
        Ok(work)
    }

    #[cfg(test)]
    pub(super) fn commit_page_render_work(&mut self, page: PageId, work: RenderWork) {
        self.component_pages.entry(page).or_default().render_work = work;
    }

    /// Resolve actual entry modules, not every component-scoped helper chunk.
    pub(super) fn component_module(&self, template: &str) -> Option<String> {
        let path = template.strip_prefix("template:").unwrap_or(template);
        let stem = path.strip_suffix(".wxml")?;
        [
            format!("module:{stem}.js"),
            format!("{stem}.js"),
            format!("module:{stem}.mjs"),
            format!("{stem}.mjs"),
        ]
        .into_iter()
        .find(|id| self.manifest.modules.iter().any(|module| module.id == *id))
    }

    pub(super) fn managed_module_ids(&self) -> Vec<String> {
        // Leaf components need not own a usingComponents relation table, and
        // valid entries can live outside a directory named `components`.
        // Resolve referenced template/module pairs instead of guessing from
        // module scope or configuring zero-registration shared chunks.
        let templates = self
            .manifest
            .templates
            .iter()
            .map(|template| (template.id.clone(), WxmlAst::default()))
            .collect::<BTreeMap<_, _>>();
        let mut ids = self
            .manifest
            .components
            .iter()
            .flat_map(|entry| entry.using_components.values())
            .filter_map(|target| find_component_template(target, &templates))
            .filter_map(|(template, _)| self.component_module(&template))
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        ids
    }

    fn component_batch(
        &mut self,
        page: PageId,
        phase: &str,
        instances: &[Value],
        remove: &[String],
    ) -> Result<ComponentReceipt, BridgeError> {
        self.component_batch_with_selection(page, phase, instances, remove, None, None)
    }

    fn component_batch_with_selection(
        &mut self,
        page: PageId,
        phase: &str,
        instances: &[Value],
        remove: &[String],
        selection_nodes: Option<&[Value]>,
        event_nodes: Option<&[Value]>,
    ) -> Result<ComponentReceipt, BridgeError> {
        if phase == "dispose" {
            let mut scopes = component_scope_ids(instances);
            scopes.extend(remove.iter().cloned());
            self.animation_writes.retire_scopes(page.0, &scopes);
            self.animation_bindings.retire_scopes(page.0, &scopes);
            self.animation_playback.retire_scopes(page.0, &scopes);
            self.retire_native_component_owners(page, Some(&scopes));
            self.retire_owned_canvas_owners(page, Some(&scopes));
            self.cancel_touches_for_scopes(page, &scopes)?;
        }
        let mut batch = json!({"version":1,"phase":phase,"pageId":page.0,"instances":instances,"remove":remove});
        if let Some(nodes) = selection_nodes {
            batch["selectionNodes"] = json!(nodes);
        }
        if let Some(nodes) = event_nodes {
            batch["eventNodes"] = json!(nodes);
        }
        let values = self.call_engine(
            CallTarget::Global {
                name: "__container_reconcile_components".into(),
            },
            vec![batch],
        )?;
        let mut expected = component_scope_ids(instances);
        if phase == "dispose" {
            expected.extend(remove.iter().cloned());
        }
        let receipt = component_receipt(values, expected, phase, phase == "dispose")?;
        if phase == "dispose" {
            Ok(receipt)
        } else {
            self.authenticate_component_receipt(page, receipt)
        }
    }

    fn merge_component_snapshots(graph: &mut ManagedPage, result: ComponentReceipt) {
        for (scope, writes) in &result.animation_writes {
            let mut snapshot = AnimationScope::new(writes.clone());
            // Relation/lifetime receipts refresh this receiver's local write
            // prefix after planning. Preserve the parent's already cloned
            // property origins across that refresh, never across incarnations.
            if let Some(previous) = graph
                .render_work
                .input_snapshot(scope)
                .filter(|previous| previous.owner == writes.owner)
            {
                snapshot.forwarded_inputs = previous.forwarded_inputs.clone();
            }
            graph
                .render_work
                .set_input_snapshot(scope, Arc::new(snapshot));
        }
        for scope in result.snapshots.keys() {
            graph.component_inputs.remove(scope);
            graph.snapshots_dirty.remove(scope);
        }
        graph.component_inputs.extend(result.component_inputs);
        graph.snapshots.extend(result.snapshots);
    }

    fn refresh_component_snapshots(
        &mut self,
        page: PageId,
        graph: &mut ManagedPage,
    ) -> Result<(), BridgeError> {
        if graph.instances.is_empty() {
            return Ok(());
        }
        let scopes = component_scope_ids(&graph.instances);
        let values = self.call_engine(
            CallTarget::Global {
                name: "__container_snapshot_component_scopes".into(),
            },
            vec![json!({"version":1,"pageId":page.0,"scopeIds":scopes})],
        )?;
        Self::merge_component_snapshots(
            graph,
            self.authenticate_component_receipt(
                page,
                component_receipt(values, scopes, "snapshot", false)?,
            )?,
        );
        Ok(())
    }

    /// Commit live references once the complete composed frontier has attached.
    /// Relation callbacks stay inside the isolate; return all survivor snapshots
    /// so unlinked/linked setData participates in the same convergence loop.
    fn component_relation_batch(
        &mut self,
        page: PageId,
        instances: &[Value],
        silent: bool,
    ) -> Result<ComponentReceipt, BridgeError> {
        let scopes = instances
            .iter()
            .filter_map(|instance| instance.get("scopeId").and_then(Value::as_str))
            .collect::<Vec<_>>();
        let values = self.call_engine(
            CallTarget::Global {
                name: "__container_commit_component_relations".into(),
            },
            vec![json!({"version":1,"pageId":page.0,"scopeIds":scopes,"silent":silent})],
        )?;
        self.authenticate_component_receipt(
            page,
            component_receipt(values, component_scope_ids(instances), "relations", false)?,
        )
    }

    fn component_page_lifetime_batch(
        &mut self,
        page: PageId,
        name: &str,
        args: Vec<Value>,
        instances: &[Value],
    ) -> Result<ComponentReceipt, BridgeError> {
        let scopes = instances
            .iter()
            .filter_map(|instance| instance.get("scopeId").and_then(Value::as_str))
            .collect::<Vec<_>>();
        if scopes.is_empty() {
            return Ok(ComponentReceipt {
                animation_writes: BTreeMap::new(),
                snapshots: BTreeMap::new(),
                component_inputs: BTreeMap::new(),
            });
        }
        let values = self.call_engine(
            CallTarget::Global {
                name: "__container_invoke_component_page_lifetimes".into(),
            },
            vec![json!({"version":1,"pageId":page.0,"name":name,"args":args,"scopeIds":scopes})],
        )?;
        self.authenticate_component_receipt(
            page,
            component_receipt(values, component_scope_ids(instances), name, false)?,
        )
    }

    /// Page visibility crosses the engine once, even for large component trees.
    /// The dedicated entrypoint cannot be shadowed by an ordinary method named
    /// show/hide/resize. Returned snapshots include synchronous hook setData.
    pub(super) fn dispatch_component_page_lifetime(
        &mut self,
        page: PageId,
        name: &str,
        args: Vec<Value>,
    ) -> Result<(), BridgeError> {
        self.ensure_component_page_reusable(page)?;
        let Some(instances) = self
            .component_pages
            .get(&page)
            .map(|graph| graph.instances.clone())
        else {
            return Ok(());
        };
        let result = match self.component_page_lifetime_batch(page, name, args, &instances) {
            Ok(result) => result,
            Err(error) => return Err(self.invalidate_component_page(page, error, "page lifetime")),
        };
        if let Some(graph) = self.component_pages.get_mut(&page) {
            Self::merge_component_snapshots(graph, result);
        }
        Ok(())
    }

    fn invalidate_component_page(
        &mut self,
        page: PageId,
        mut error: BridgeError,
        operation: &str,
    ) -> BridgeError {
        self.invalidate_browser_page(page);
        error.message.push_str(&format!(
            "; component {operation} returned no complete acknowledgement; managed component page invalidated; session restart required"
        ));
        if let Some(graph) = self.component_pages.get_mut(&page) {
            graph.reconciliation_failure = Some(error.clone());
        }
        error
    }

    /// Refresh a candidate's cloned graph from immutable mutation receipts.
    /// These were captured inside the completed setData turn, so this native
    /// read invokes no live serializer, application callback or job checkpoint.
    pub(super) fn prepare_dev_component_snapshots(
        &mut self,
        candidate: &mut Session,
    ) -> Result<(), BridgeError> {
        let Some(page) = self.app_service.pages().current().map(|page| page.id) else {
            return Ok(());
        };
        self.ensure_component_page_reusable(page)?;
        let Some(mut graph) = self.component_pages.get(&page).cloned() else {
            return Ok(());
        };
        if graph.snapshots_dirty.is_empty() {
            return Ok(());
        }
        let scopes = graph.snapshots_dirty.iter().cloned().collect::<Vec<_>>();
        let unavailable = || {
            BridgeError::new(
            BridgeErrorCode::Cancelled,
            "pending component data has no complete immutable snapshot; render normally before development presentation",
        )
        };
        #[allow(unused_variables)]
        let proofs = match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(unavailable)?
                        .capture_component_data_receipts(page.0, &scopes)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    return Err(unavailable());
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(unavailable)?
                        .capture_component_data_receipts(page.0, &scopes)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    return Err(unavailable());
                }
            }
        };
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        {
            let page_token = proofs["pageToken"]
                .as_str()
                .and_then(|text| text.parse::<u64>().ok())
                .filter(|token| *token != 0)
                .ok_or_else(unavailable)?;
            let mut receipt = ComponentReceipt {
                snapshots: BTreeMap::new(),
                animation_writes: BTreeMap::new(),
                component_inputs: BTreeMap::new(),
            };
            for scope in scopes {
                let proof = &proofs["scopes"][&scope];
                let snapshot: Value =
                    serde_json::from_str(proof["snapshotJson"].as_str().ok_or_else(unavailable)?)
                        .map_err(|_| unavailable())?;
                if !snapshot.get("data").is_some_and(Value::is_object)
                    || !snapshot.get("properties").is_some_and(Value::is_object)
                {
                    return Err(unavailable());
                }
                let identity =
                    ComponentInputIdentity::parse(&proof["identity"]).ok_or_else(unavailable)?;
                let owner = AnimationOwner {
                    page_id: page.0,
                    page_incarnation: page_token,
                    scope_id: Some(scope.clone()),
                    scope_incarnation: Some(identity.token),
                };
                receipt.animation_writes.insert(
                    scope.clone(),
                    AnimationWrites::from_private(owner, &proof["writeSnapshot"])?,
                );
                receipt.component_inputs.insert(scope.clone(), identity);
                receipt.snapshots.insert(scope, snapshot);
            }
            Self::merge_component_snapshots(&mut graph, receipt);
            candidate.component_pages.insert(page, graph);
        }
        Ok(())
    }

    /// Evaluate a presentation candidate against the last accepted component
    /// snapshots. This path is read-only: it never prepares scopes, publishes
    /// indexes or invokes JavaScript. A changed input/topology needs isolated
    /// startup rather than speculative mutation of the live component heap.
    pub(super) fn preview_managed_component_tree(
        &self,
        executor: &Session,
        page: PageId,
        ast: &WxmlAst,
        template: &str,
        templates: &BTreeMap<String, WxmlAst>,
    ) -> Result<(WxmlAst, BTreeMap<String, RenderOwnership>, ManagedPage), BridgeError> {
        self.ensure_component_page_reusable(page)?;
        let mut graph = executor
            .component_pages
            .get(&page)
            .or_else(|| self.component_pages.get(&page))
            .cloned()
            .unwrap_or_default();
        if !graph.snapshots_dirty.is_empty() {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "pending component data requires an ordinary render before development presentation",
            ));
        }
        graph
            .render_work
            .begin_program(render_program_fingerprint(&self.manifest, templates)?);
        let mut specs = Vec::new();
        let owned = self.settle_owned_components(
            own_nodes(&ast.nodes, template, None),
            &format!("page:{}", page.0),
            None,
            "",
            templates,
            ComponentExpansion::Managed {
                snapshots: &graph.snapshots,
                prepared_bindings: &graph.prepared_bindings,
            },
            &mut graph.render_work,
            &mut specs,
            0,
            true,
            executor,
        )?;
        let inputs = |instances: &[Value]| {
            instances
                .iter()
                .map(|instance| {
                    json!({
                        "scopeId": instance["scopeId"],
                        "moduleId": instance["moduleId"],
                        "parentScopeId": instance["parentScopeId"],
                        "ownerScopeId": instance["ownerScopeId"],
                        "properties": instance["properties"],
                    })
                })
                .collect::<Vec<_>>()
        };
        if inputs(&specs) != inputs(&graph.instances) {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "presentation preview changed managed component inputs or topology; an isolated restart is required",
            ));
        }
        graph.selection_nodes = collect_selection_nodes(&owned, &mut specs);
        graph.event_nodes = collect_event_nodes(&owned)?;
        graph.instances = specs;
        let mut ownership = BTreeMap::new();
        let nodes = flatten(owned, "", &mut ownership);
        Ok((
            WxmlAst {
                version: ast.version,
                nodes,
            },
            ownership,
            graph,
        ))
    }

    fn dev_component_presentation_transport(
        &mut self,
        payload: Value,
    ) -> Result<Value, BridgeError> {
        match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(BridgeErrorCode::Engine, "QuickJS unavailable")
                        })?
                        .component_presentation(payload)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    Err(BridgeError::new(
                        BridgeErrorCode::Engine,
                        "QuickJS unavailable",
                    ))
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| BridgeError::new(BridgeErrorCode::Engine, "V8 unavailable"))?
                        .component_presentation(payload)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    Err(BridgeError::new(BridgeErrorCode::Engine, "V8 unavailable"))
                }
            }
        }
    }

    pub(super) fn prepare_dev_component_indexes(
        &mut self,
        candidate: &Session,
    ) -> Result<Option<(PageId, String)>, BridgeError> {
        let Some(page) = self.app_service.pages().current().map(|page| page.id) else {
            return Ok(None);
        };
        let Some(graph) = candidate.component_pages.get(&page) else {
            return Ok(None);
        };
        self.prepare_dev_component_graph_indexes(page, graph)
    }

    pub(super) fn prepare_dev_component_graph_indexes(
        &mut self,
        page: PageId,
        graph: &ManagedPage,
    ) -> Result<Option<(PageId, String)>, BridgeError> {
        if self.component_pages.get(&page).is_some_and(|previous| {
            previous.selection_nodes == graph.selection_nodes
                && previous.event_nodes == graph.event_nodes
        }) {
            return Ok(None);
        }
        let result = self.dev_component_presentation_transport(json!({
            "phase":"stage","pageId":page.0.to_string(),"scopes":component_scope_ids(&graph.instances),
            "selectionNodes":graph.selection_nodes,"eventNodes":graph.event_nodes,
        }))?;
        let ticket = result
            .get("ticket")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                BridgeError::new(
                    BridgeErrorCode::Engine,
                    "component presentation omitted its ticket",
                )
            })?;
        Ok(Some((page, ticket.into())))
    }

    pub(super) fn commit_dev_component_indexes(
        &mut self,
        prepared: Option<(PageId, String)>,
    ) -> Result<(), BridgeError> {
        let Some((page, ticket)) = prepared else {
            return Ok(());
        };
        match self.dev_component_presentation_transport(json!({"phase":"commit","ticket":ticket})) {
            Ok(Value::Bool(true)) => Ok(()),
            result => {
                let error = result.err().unwrap_or_else(|| {
                    BridgeError::new(
                        BridgeErrorCode::Engine,
                        "component presentation commit was not acknowledged",
                    )
                });
                self.retire_skia_frame_authority();
                Err(self.invalidate_component_page(page, error, "development metadata commit"))
            }
        }
    }

    /// Every frontier crosses the engine once as a batch. Nested templates
    /// require their parent's default data/observers before discovery, so the
    /// traversal converges by depth rather than issuing per-node FFI calls.
    pub(super) fn managed_component_tree(
        &mut self,
        page: PageId,
        ast: &WxmlAst,
        template: &str,
        templates: &BTreeMap<String, WxmlAst>,
    ) -> Result<(WxmlAst, BTreeMap<String, RenderOwnership>), BridgeError> {
        self.ensure_component_page_reusable(page)?;
        let mut graph = self.component_pages.get(&page).cloned().unwrap_or_default();
        graph
            .render_work
            .begin_program(render_program_fingerprint(&self.manifest, templates)?);
        // A failed frontier's cleanup retains no transient native heap. Check
        // its bounded memo against current live inputs before preparing again.
        self.refresh_component_snapshots(page, &mut graph)?;
        let input = graph.frontier_input(page, ast);
        if let Some((rejected, error)) = &graph.rejected_frontier {
            if *rejected == input {
                return Err(error.clone());
            }
        }
        graph.rejected_frontier = None;
        let mut original = graph.clone();
        // A failed engine call has no commit receipt. In particular, the JS
        // batch may have completed before serialization/microtasks failed.
        let mut uncertain_mutation = None;
        let result = (|| {
            let mut previous = Vec::new();
            let mut published_selection_nodes = graph.selection_nodes.clone();
            let mut published_event_nodes = graph.event_nodes.clone();
            for _ in 0..64 {
                let mut specs = Vec::new();
                let owned = self.expand_owned_components(
                    own_nodes(&ast.nodes, template, None),
                    &format!("page:{}", page.0),
                    None,
                    "",
                    templates,
                    ComponentExpansion::Managed {
                        snapshots: &graph.snapshots,
                        prepared_bindings: &graph.prepared_bindings,
                    },
                    &mut graph.render_work,
                    &mut specs,
                    0,
                )?;
                let selection_nodes = collect_selection_nodes(&owned, &mut specs);
                let event_nodes = collect_event_nodes(&owned)?;
                let scopes = specs
                    .iter()
                    .filter_map(|entry| entry.get("scopeId").and_then(Value::as_str))
                    .collect::<std::collections::BTreeSet<_>>();
                if scopes.len() != specs.len() {
                    return Err(BridgeError::new(
                        BridgeErrorCode::Render,
                        "duplicate keyed component identity",
                    ));
                }
                if specs == previous {
                    // Properties/observers may change ordinary nodes without
                    // changing any component record. Publish the final index
                    // before attached hooks, including native-only frontiers.
                    if graph.selection_index_active
                        && (selection_nodes != published_selection_nodes
                            || event_nodes != published_event_nodes)
                    {
                        uncertain_mutation = Some("publish frontier");
                        self.component_batch_with_selection(
                            page,
                            "publish",
                            &specs,
                            &[],
                            Some(&selection_nodes),
                            Some(&event_nodes),
                        )?;
                        uncertain_mutation = None;
                        published_selection_nodes = selection_nodes.clone();
                        published_event_nodes = event_nodes.clone();
                    }
                    // Attach only after the full pre-order graph is known.
                    // Include occurrences constructed by an earlier frontier
                    // in this render, even if an attached hook hid them before
                    // any tree was accepted.
                    let removed = graph.ordered_scopes(
                        graph
                            .snapshots
                            .keys()
                            .filter(|scope| !scopes.contains(scope.as_str()))
                            .cloned(),
                    )?;
                    let before = graph.snapshots.clone();
                    if !specs.is_empty() {
                        uncertain_mutation = Some("attach frontier");
                        let result = self.component_batch(page, "attach", &specs, &[])?;
                        uncertain_mutation = None;
                        Self::merge_component_snapshots(&mut graph, result);
                        if self.component_visible_pages.get(&page) == Some(&true) {
                            // Newly attached occurrences on a visible page need
                            // show too. Engine-side attempt flags skip survivors,
                            // including a hook that threw on an earlier frontier.
                            uncertain_mutation = Some("show frontier");
                            let result = self.component_page_lifetime_batch(
                                page,
                                "show",
                                Vec::new(),
                                &specs,
                            )?;
                            uncertain_mutation = None;
                            Self::merge_component_snapshots(&mut graph, result);
                        }
                    }
                    if graph.snapshots != before {
                        previous = Vec::new();
                        continue;
                    }
                    if !removed.is_empty() {
                        uncertain_mutation = Some("dispose removed scopes");
                        self.component_batch(page, "dispose", &[], &removed)?;
                        uncertain_mutation = None;
                        for scope in &removed {
                            graph.snapshots.remove(scope);
                            graph.snapshots_dirty.remove(scope);
                            graph.component_inputs.remove(scope);
                        }
                        graph.release_scope_leases(&removed);
                        graph.render_work.release_scopes(&removed);
                    }
                    // Successful disposal is already irreversible, even when
                    // the following relation batch fails without a receipt.
                    // Never restore an accepted graph containing dead scopes.
                    graph.instances = specs.clone();
                    graph.selection_nodes = selection_nodes.clone();
                    graph.event_nodes = event_nodes.clone();
                    original = graph.clone();
                    // AppService disposal already crossed its irreversible
                    // boundary. A failed View release must not restore it.
                    self.release_view_scopes(&removed)?;
                    uncertain_mutation = Some("commit component relations");
                    let result = self.component_relation_batch(page, &specs, false)?;
                    uncertain_mutation = None;
                    Self::merge_component_snapshots(&mut graph, result);
                    // detached/unlinked/linked have now crossed an irreversible
                    // lifecycle boundary. A later hook-driven render can fail,
                    // but must recover this live topology rather than resurrect
                    // occurrences whose detached hooks already ran and freed.
                    graph.instances = specs.clone();
                    graph.selection_nodes = selection_nodes.clone();
                    graph.event_nodes = event_nodes.clone();
                    original = graph.clone();
                    if graph.snapshots != before {
                        previous = Vec::new();
                        continue;
                    }
                    graph.instances = specs;
                    graph.selection_nodes = selection_nodes;
                    graph.event_nodes = event_nodes;
                    let mut ownership = BTreeMap::new();
                    let nodes = flatten(owned, "", &mut ownership);
                    return Ok((
                        WxmlAst {
                            version: ast.version,
                            nodes,
                        },
                        ownership,
                    ));
                }
                graph.lease_frontier(&specs)?;
                uncertain_mutation = Some("prepare frontier");
                // Publication can complete before the acknowledgement fails.
                // Own even a native-only index until explicit empty publish.
                graph.selection_index_active = true;
                let result = self.component_batch_with_selection(
                    page,
                    "prepare",
                    &specs,
                    &[],
                    Some(&selection_nodes),
                    Some(&event_nodes),
                )?;
                uncertain_mutation = None;
                graph.acknowledge_frontier(&specs);
                published_selection_nodes = selection_nodes;
                published_event_nodes = event_nodes;
                Self::merge_component_snapshots(&mut graph, result);
                previous = specs;
            }
            Err(BridgeError::new(
                BridgeErrorCode::Render,
                "component graph did not converge after 64 batched frontiers",
            ))
        })();
        if let Err(mut error) = result {
            // A rejected dynamic frontier must not leak newly constructed
            // occurrences. Existing JS effects remain ordinary runtime state;
            // dev reloads that can change topology use an isolated session.
            let mut recovery_failure = uncertain_mutation
                .map(|phase| format!("{phase} returned no mutation acknowledgement"));
            let added = match graph.ordered_scopes(
                graph
                    .snapshots
                    .keys()
                    .filter(|scope| !original.snapshots.contains_key(*scope))
                    .cloned(),
            ) {
                Ok(added) => added,
                Err(ownership) => {
                    let detail = format!("cannot order rejected frontier: {}", ownership.message);
                    if let Some(failure) = &mut recovery_failure {
                        failure.push_str(&format!("; {detail}"));
                    } else {
                        recovery_failure = Some(detail);
                    }
                    Vec::new()
                }
            };
            if recovery_failure.is_none() && !added.is_empty() {
                match self.component_batch(page, "dispose", &[], &added) {
                    Ok(_) => {
                        for scope in &added {
                            graph.snapshots.remove(scope);
                            graph.snapshots_dirty.remove(scope);
                            graph.component_inputs.remove(scope);
                        }
                        graph.release_scope_leases(&added);
                        graph.render_work.release_scopes(&added);
                        if let Err(cleanup) = self.release_view_scopes(&added) {
                            recovery_failure = Some(format!(
                                "release rejected View scopes failed: {}: {}",
                                cleanup.code, cleanup.message
                            ));
                        }
                    }
                    Err(cleanup) => {
                        recovery_failure = Some(format!(
                            "dispose rejected frontier failed: {}: {}",
                            cleanup.code, cleanup.message
                        ));
                    }
                }
            }
            // Restore the accepted reference tree without rerunning observers
            // or hooks. User JS state is not a transaction, but a rejected
            // frontier must not replace selection for the retained frame.
            if recovery_failure.is_none()
                && (graph.selection_index_active || original.selection_index_active)
            {
                match self.component_batch_with_selection(
                    page,
                    "publish",
                    &original.instances,
                    &[],
                    Some(&original.selection_nodes),
                    Some(&original.event_nodes),
                ) {
                    Ok(_) => {
                        // Restore itself can create a native-only engine index
                        // for a page that had never published one. Own cleanup
                        // even if the following relation restoration fails.
                        original.selection_index_active = true;
                        if let Err(cleanup) =
                            self.component_relation_batch(page, &original.instances, true)
                        {
                            recovery_failure = Some(format!(
                                "restore component relations failed: {}: {}",
                                cleanup.code, cleanup.message
                            ));
                        }
                    }
                    Err(cleanup) => {
                        recovery_failure = Some(format!(
                            "restore accepted selection failed: {}: {}",
                            cleanup.code, cleanup.message
                        ));
                    }
                }
            }
            if recovery_failure.is_none() {
                // Cleanup can run detached/unlinked callbacks which update a
                // survivor. Memoize those final inputs, not stale pre-failure
                // snapshots, while still owning no disposed transient scopes.
                let mut accepted = original.clone();
                accepted.prepared_bindings = graph.prepared_bindings.clone();
                match self.refresh_component_snapshots(page, &mut accepted) {
                    Ok(()) => {
                        accepted.render_work = graph.render_work.clone();
                        let rejected = accepted.frontier_input(page, ast);
                        original.snapshots = accepted.snapshots;
                        original.rejected_frontier = Some((rejected, error.clone()));
                    }
                    Err(cleanup) => {
                        recovery_failure = Some(format!(
                            "refresh recovered component inputs failed: {}: {}",
                            cleanup.code, cleanup.message
                        ));
                    }
                }
            }
            // Evaluated code is not rolled back with graph indexes. Preserve
            // survivor results/errors so a rejected input cannot execute anew
            // during the next idle attempt; transient scopes were released.
            if let Some(failure) = recovery_failure {
                // Preserve the original failure/code and expose the secondary
                // failure explicitly. No further engine operation is safe:
                // retain all still-owned scopes/work for eventual teardown,
                // and require the host to replace the session before reuse.
                error.message.push_str(&format!(
                    "; component recovery: {failure}; managed component page invalidated; session restart required"
                ));
                graph.reconciliation_failure = Some(error.clone());
                self.component_pages.insert(page, graph);
            } else {
                original.render_work = graph.render_work;
                // A recovered graph rolls back indexes, not acknowledged
                // parent inputs already applied inside the JavaScript heap.
                original.prepared_bindings = graph.prepared_bindings;
                self.component_pages.insert(page, original);
            }
            Err(error)
        } else {
            self.component_pages.insert(page, graph);
            result
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn expand_owned_components(
        &self,
        nodes: Vec<OwnedNode>,
        root_scope: &str,
        parent_scope: Option<&str>,
        path: &str,
        templates: &BTreeMap<String, WxmlAst>,
        mode: ComponentExpansion<'_>,
        work: &mut RenderWork,
        specs: &mut Vec<Value>,
        depth: usize,
    ) -> Result<Vec<OwnedNode>, BridgeError> {
        self.settle_owned_components(
            nodes,
            root_scope,
            parent_scope,
            path,
            templates,
            mode,
            work,
            specs,
            depth,
            false,
            self,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn settle_owned_components(
        &self,
        nodes: Vec<OwnedNode>,
        root_scope: &str,
        parent_scope: Option<&str>,
        path: &str,
        templates: &BTreeMap<String, WxmlAst>,
        mode: ComponentExpansion<'_>,
        work: &mut RenderWork,
        specs: &mut Vec<Value>,
        depth: usize,
        preview: bool,
        executor: &Session,
    ) -> Result<Vec<OwnedNode>, BridgeError> {
        let original_specs = specs.clone();
        for _ in 0..64 {
            *specs = original_specs.clone();
            let mut pending = Vec::new();
            let output = self.plan_owned_components(
                nodes.clone(),
                root_scope,
                parent_scope,
                path,
                templates,
                mode,
                work,
                specs,
                depth,
                &mut pending,
            )?;
            if component_scope_ids(specs).len() != specs.len() {
                return Err(BridgeError::new(
                    BridgeErrorCode::Render,
                    "duplicate keyed component identity",
                ));
            }
            if pending.is_empty() {
                return Ok(output);
            }
            executor.evaluate_view_frontier(work, pending, templates, preview)?;
        }
        Err(BridgeError::new(
            BridgeErrorCode::Render,
            "View document frontier exceeded maximum depth",
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn plan_owned_components(
        &self,
        nodes: Vec<OwnedNode>,
        root_scope: &str,
        parent_scope: Option<&str>,
        path: &str,
        templates: &BTreeMap<String, WxmlAst>,
        mode: ComponentExpansion<'_>,
        work: &mut RenderWork,
        specs: &mut Vec<Value>,
        depth: usize,
        pending: &mut Vec<PendingViewRender>,
    ) -> Result<Vec<OwnedNode>, BridgeError> {
        if depth > 32 {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "component expansion exceeded maximum depth",
            ));
        }
        let mut output = Vec::new();
        for (index, mut owned) in nodes.into_iter().enumerate() {
            let path = node_path(&owned.node, path, index);
            let target = match &owned.node {
                WxmlNode::Element { tag, .. } => self
                    .manifest
                    .components
                    .iter()
                    .find(|entry| entry.owner == template_owner_config(&owned.template))
                    .and_then(|entry| entry.using_components.get(tag))
                    .or_else(|| {
                        self.manifest
                            .components
                            .iter()
                            .find(|entry| entry.owner == "app.json")
                            .and_then(|entry| entry.using_components.get(tag))
                    }),
                _ => None,
            };
            if let Some(target) =
                target.filter(|target| find_component_template(target, templates).is_none())
            {
                let code = if target.starts_with("plugin://") || target.starts_with("npm:") {
                    BridgeErrorCode::UnsupportedCapability
                } else {
                    BridgeErrorCode::ModuleLoad
                };
                return Err(BridgeError::new(
                    code,
                    format!("component target {target} has no available portable template"),
                ));
            }
            if let Some((template, _source)) =
                target.and_then(|target| find_component_template(target, templates))
            {
                let module = match mode {
                    ComponentExpansion::Managed { .. } => Some(
                        self.component_module(&template)
                            .filter(|id| self.loaded_modules.contains_key(id))
                            .ok_or_else(|| {
                                BridgeError::new(
                                    BridgeErrorCode::ModuleLoad,
                                    format!("component {template} has no loaded entry module"),
                                )
                            })?,
                    ),
                    ComponentExpansion::Declarative => None,
                };
                {
                    let site = match &owned.node {
                        WxmlNode::Element {
                            source_site: Some(site),
                            ..
                        } => site.as_str(),
                        _ => &path,
                    };
                    let parent = parent_scope.unwrap_or("");
                    let identity = module.as_deref().unwrap_or(&template);
                    let scope = format!(
                        "{root_scope}/component:{}:{}{}:{}{}:{}",
                        parent.len(),
                        parent,
                        site.len(),
                        site,
                        identity.len(),
                        identity
                    );
                    let properties = match &owned.node {
                        WxmlNode::Element {
                            attrs,
                            bound_values,
                            ..
                        } => component_properties(attrs, bound_values),
                        _ => unreachable!(),
                    };
                    let mut selection = selection_node(&owned.node).ok_or_else(|| {
                        BridgeError::new(
                            BridgeErrorCode::Render,
                            "virtual WXML block cannot be a custom component host",
                        )
                    })?;
                    selection["ancestors"] = json!(owned.selection_ancestors);
                    selection["order"] = json!(specs.len());
                    specs.push(
                        json!({"scopeId":scope,"moduleId":module,"parentScopeId":parent_scope,
                        "ownerScopeId":owned.owner,"properties":properties,"selection":selection}),
                    );
                    owned.component_scope = Some(scope.clone());
                    owned.component_document = Some(template.clone());
                    let data = match mode {
                        ComponentExpansion::Managed {
                            snapshots,
                            prepared_bindings,
                        } => {
                            // A parent binding update may hide or replace an
                            // entire subtree. Settle it in the next batched
                            // prepare before discovering descendants from a
                            // stale snapshot, otherwise recovery can recreate
                            // a disposed child for one transient frontier.
                            if prepared_bindings.get(&scope) == Some(&properties) {
                                snapshots.get(&scope).map(|snapshot| {
                                    snapshot.get("data").cloned().unwrap_or_else(|| json!({}))
                                })
                            } else {
                                None
                            }
                        }
                        ComponentExpansion::Declarative => match &owned.node {
                            WxmlNode::Element {
                                attrs,
                                bound_values,
                                ..
                            } => Some(component_scope_data(attrs, bound_values)),
                            _ => unreachable!(),
                        },
                    };
                    if let Some(data) = data {
                        if let Some(existing) = work.input_snapshot(&scope) {
                            let mut snapshot = (*existing).clone();
                            snapshot.forwarded_inputs.clear();
                            let parent = owned.owner.as_deref().unwrap_or(root_scope);
                            if let Some(parent_snapshot) = work.input_snapshot(parent) {
                                let site = match &owned.node {
                                    WxmlNode::Element {
                                        source_site: Some(site),
                                        ..
                                    } => site.as_str(),
                                    _ => "",
                                };
                                for source in work
                                    .attribute_sources(parent)
                                    .iter()
                                    .filter(|source| source.source_site == site)
                                {
                                    // Component properties normalize kebab names to camelCase.
                                    let mut property = String::new();
                                    let mut upper = false;
                                    for ch in source.attribute.chars() {
                                        if ch == '-' {
                                            upper = true;
                                        } else if upper {
                                            property.extend(ch.to_uppercase());
                                            upper = false;
                                        } else {
                                            property.push(ch);
                                        }
                                    }
                                    snapshot.forward(
                                        property,
                                        source.clone(),
                                        Arc::clone(&parent_snapshot),
                                    );
                                }
                            }
                            work.set_input_snapshot(&scope, Arc::new(snapshot));
                        }
                        let Some(evaluated) =
                            read_scope_template(work, &scope, &template, &data, pending)?
                        else {
                            owned.children.clear();
                            if !matches!(mode, ComponentExpansion::Declarative) {
                                output.push(owned);
                            }
                            continue;
                        };
                        let multiple = self
                            .manifest
                            .components
                            .iter()
                            .find(|entry| entry.owner == template_owner_config(&template))
                            .and_then(|entry| entry.multiple_slots)
                            .unwrap_or(false);
                        let projected = project_slots(
                            own_nodes(&evaluated.nodes, &template, Some(&scope)),
                            &owned.children,
                            multiple,
                        );
                        owned.children = self.plan_owned_components(
                            projected,
                            root_scope,
                            Some(&scope),
                            &path,
                            templates,
                            mode,
                            work,
                            specs,
                            depth + 1,
                            pending,
                        )?;
                    } else {
                        owned.children.clear();
                    }
                    if matches!(mode, ComponentExpansion::Declarative) {
                        output.extend(owned.children);
                    } else {
                        output.push(owned);
                    }
                    continue;
                }
            }
            owned.children = self.plan_owned_components(
                owned.children,
                root_scope,
                parent_scope,
                &path,
                templates,
                mode,
                work,
                specs,
                depth,
                pending,
            )?;
            output.push(owned);
        }
        Ok(output)
    }

    pub(super) fn prepare_page_components(&mut self, page: PageId) -> Result<(), BridgeError> {
        self.validate_view_resources(&self.render_blobs)?;
        self.ensure_view_execution_supported()
            .map_err(|error| error.bridge_error())?;
        if self.render_blobs.is_empty() || self.managed_module_ids().is_empty() {
            return Ok(());
        }
        let Some(entry) = self.app_service.pages().get(page) else {
            return Ok(());
        };
        let template = format!("template:{}.wxml", entry.path);
        let data = entry.data.clone();
        let templates = self.component_templates(&self.render_blobs)?;
        let Some(source) = templates.get(&template) else {
            return Ok(());
        };
        let evaluated = self.evaluate_page_template(page, &template, source, &data, &templates)?;
        self.managed_component_tree(page, &evaluated, &template, &templates)?;
        Ok(())
    }

    pub(super) fn component_templates(
        &self,
        blobs: &BTreeMap<String, Vec<u8>>,
    ) -> Result<BTreeMap<String, WxmlAst>, BridgeError> {
        let mut templates = BTreeMap::new();
        for entry in &self.manifest.templates {
            let Some(bytes) = blobs.get(&entry.wxml_ast) else {
                continue;
            };
            let ast = decode_wxml(bytes)
                .map_err(|error| BridgeError::new(BridgeErrorCode::Render, error.to_string()))?;
            ensure_wxml_view_supported(
                &ast,
                &entry.id,
                self.template_view_execution_allowed(&entry.id),
            )?;
            templates.insert(entry.id.clone(), ast.clone());
            if let Some(path) = entry.id.strip_prefix("template:") {
                templates.insert(path.into(), ast);
            }
        }
        Ok(templates)
    }

    pub(super) fn defer_component_page_ready(&mut self, page: PageId, index: usize) -> bool {
        // External/native GPU and explicit developer Raster frames can be
        // prepared before the host actually presents them. Even pages without
        // components wait for the validated acknowledgement, not page.push.
        if self.browser_route_active()
            || self.skia_backend.renderer.page_render_mode()
                != container_render_skia::PageRenderMode::Raster
            || self.dev_raster_presentation_required()
        {
            self.component_pages
                .entry(page)
                .or_default()
                .pending_page_ready = Some(index);
            return true;
        }
        if let Some(graph) = self.component_pages.get_mut(&page) {
            if graph.instances.is_empty() {
                return false;
            }
            graph.pending_page_ready = Some(index);
            true
        } else {
            false
        }
    }

    pub(super) fn ready_page_components(&mut self) -> Result<(), BridgeError> {
        let Some(page) = self.app_service.pages().current().map(|page| page.id) else {
            return Ok(());
        };
        self.ensure_component_page_reusable(page)?;
        let Some(mut graph) = self.component_pages.get(&page).cloned() else {
            return Ok(());
        };
        if !graph.instances.is_empty() {
            let result = match self.component_batch(page, "ready", &graph.instances, &[]) {
                Ok(result) => result,
                Err(error) => return Err(self.invalidate_component_page(page, error, "ready")),
            };
            Self::merge_component_snapshots(&mut graph, result);
        }
        let pending = graph.pending_page_ready.take();
        self.component_pages.insert(page, graph);
        if let Some(index) = pending {
            self.call_engine(
                CallTarget::Global {
                    name: "__container_invoke_page_instance".into(),
                },
                vec![json!(page.0), json!(index), json!("onReady"), json!([])],
            )?;
        }
        Ok(())
    }

    pub(super) fn dispose_page_components(&mut self, page: PageId) -> Result<(), BridgeError> {
        self.cleanup_page_components(page, ViewScopeCleanup::AcknowledgedRelease)
    }

    /// Final session cleanup preserves AppService disposal acknowledgements.
    /// Only the already-poisoned View's cleanup changes to invalidation.
    pub(super) fn retire_page_components(&mut self, page: PageId) -> Result<(), BridgeError> {
        self.cleanup_page_components(page, ViewScopeCleanup::FinalSessionRetirement)
    }

    fn cleanup_page_components(
        &mut self,
        page: PageId,
        cleanup: ViewScopeCleanup,
    ) -> Result<(), BridgeError> {
        self.retire_native_component_owners(page, None);
        self.retire_owned_canvas_owners(page, None);
        let contacts = self.cancel_browser_contacts_for_page(page, "page-components-disposed");
        self.invalidate_browser_page(page);
        contacts?;
        if let Some(mut graph) = self.component_pages.get(&page).cloned() {
            let selection_index_active = graph.selection_index_active;
            let mut view_scopes = graph.render_work.scope_ids();
            view_scopes.insert(format!("page:{}", page.0));
            let result: Result<(), BridgeError> = (|| {
                let remove = graph.ordered_scopes(
                    graph
                        .instances
                        .iter()
                        .filter_map(|entry| entry.get("scopeId").and_then(Value::as_str))
                        .map(str::to_owned)
                        .chain(graph.snapshots.keys().cloned())
                        .chain(graph.scope_leases.iter().cloned()),
                )?;
                if !remove.is_empty() {
                    self.component_batch(page, "dispose", &[], &remove)?;
                    graph.render_work.release_scopes(&remove);
                    graph.release_scope_leases(&remove);
                    graph.snapshots.clear();
                    graph.component_inputs.clear();
                    graph.instances.clear();
                }
                if selection_index_active {
                    self.component_batch_with_selection(
                        page,
                        "publish",
                        &[],
                        &[],
                        Some(&[]),
                        Some(&[]),
                    )?;
                }
                // Includes the page root and declarative scopes, even when
                // there were no AppService component occurrences to dispose.
                self.cleanup_view_scopes(&view_scopes.into_iter().collect::<Vec<_>>(), cleanup)?;
                Ok(())
            })();
            if let Err(mut error) = result {
                error.message.push_str(
                    "; component page disposal returned no complete acknowledgement; managed component page invalidated; session restart required",
                );
                graph.reconciliation_failure = Some(error.clone());
                self.component_pages.insert(page, graph);
                return Err(error);
            }
            self.component_pages.remove(&page);
        } else {
            self.cleanup_view_scopes(&[format!("page:{}", page.0)], cleanup)?;
        }
        Ok(())
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn invalidate_component_scope(&mut self, scope: &str) {
        let mut invalidated = false;
        for graph in self.component_pages.values_mut() {
            if graph.snapshots.contains_key(scope) {
                graph.snapshots_dirty.insert(scope.to_owned());
                invalidated = true;
            }
        }
        if invalidated {
            self.view.invalidate_template();
        }
    }
}

fn component_properties(
    attrs: &BTreeMap<String, String>,
    bound: &BTreeMap<String, Value>,
) -> Value {
    Value::Object(
        attrs
            .iter()
            .filter(|(name, _)| !component_metadata_attribute(name))
            .map(|(name, value)| {
                (
                    name.clone(),
                    bound
                        .get(name)
                        .cloned()
                        .unwrap_or_else(|| Value::String(value.clone())),
                )
            })
            .collect(),
    )
}

pub(super) fn component_metadata_attribute(name: &str) -> bool {
    name == "slot"
        || name.starts_with("wx:")
        || name.starts_with("bind")
        || name.starts_with("catch")
        || name.starts_with("capture-bind")
        || name.starts_with("capture-catch")
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_core::ViewExecutionBudget;
    use container_ir::{evaluate_wxml, parse_wxml};

    fn work_session(templates: &BTreeMap<String, WxmlAst>) -> Session {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "render-work-fixture".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.templates = templates
            .iter()
            .map(|(id, ast)| container_ir::Template {
                id: id.clone(),
                wxml_ast: format!(
                    "sha256:{}",
                    container_ir::hex_digest(&ast.canonical_json().unwrap())
                ),
                bindings: Vec::new(),
                wxs_modules: BTreeMap::new(),
            })
            .collect();
        let session = Session::new(manifest, SessionConfig::default()).unwrap();
        session
            .view_execution
            .borrow_mut()
            .prepare_modules(
                &session.manifest,
                &BTreeMap::new(),
                &ViewExecutionBudget::default(),
            )
            .unwrap();
        session
    }

    #[test]
    fn final_retirement_clears_standalone_work_and_componentless_page_ownership() {
        let mut session = work_session(&BTreeMap::new());
        session
            .standalone_render_work
            .evaluate("standalone:fixture", "fixture.wxml", &json!({}), || {
                Ok(parse_wxml("<view/>").unwrap())
            })
            .unwrap();
        assert_eq!(session.standalone_render_work.scope_ids().len(), 1);
        session.view_execution.borrow_mut().inject_fault_for_test(
            container_core::ViewEngineError::new(
                container_core::ViewEngineErrorCode::Timeout,
                "interrupted standalone View",
            ),
        );
        let fault = session.view_execution.borrow().fault();
        assert!(session.dispose_page_components(PageId(99)).is_err());
        session.retire_page_components(PageId(99)).unwrap();
        session.retire_standalone_view_scopes().unwrap();
        assert!(session.standalone_render_work.scope_ids().is_empty());
        assert_eq!(session.view_execution.borrow().fault(), fault);
    }

    #[test]
    fn external_presentation_defers_ready_for_componentless_pages() {
        let mut session = work_session(&BTreeMap::new());
        let page = PageId(42);
        assert!(!session.defer_component_page_ready(page, 1));
        assert!(!session.component_pages.contains_key(&page));
        session.component_pages.insert(page, ManagedPage::default());
        assert!(!session.defer_component_page_ready(page, 1));
        assert!(session.component_pages[&page].pending_page_ready.is_none());

        session
            .skia_backend
            .renderer
            .ensure_mut()
            .configure_page_render_mode(container_render_skia::PageRenderMode::ExternalFrame)
            .unwrap();
        session.component_pages.remove(&page);
        assert!(session.defer_component_page_ready(page, 1));
        assert_eq!(session.component_pages[&page].pending_page_ready, Some(1));
        assert!(session.component_pages[&page].instances.is_empty());
        assert!(session.defer_component_page_ready(page, 2));
        assert_eq!(session.component_pages[&page].pending_page_ready, Some(2));
    }

    #[test]
    fn prepared_page_and_component_share_an_epoch_and_preview_cannot_replace_live_work() {
        let template = "template:pages/index/index.wxml";
        let source = parse_wxml("<text>{{title}}</text>").unwrap();
        let mut templates = BTreeMap::from([(template.into(), source.clone())]);
        let mut session = work_session(&templates);
        let page = PageId(1);
        let data = json!({"title":"prepared"});
        let prepared = session
            .evaluate_page_template(page, template, &source, &data, &templates)
            .unwrap();
        let mut frontier = session.clone_page_render_work(page, &templates).unwrap();
        frontier
            .evaluate("page:1/component:child", "child.wxml", &json!({}), || {
                Ok(parse_wxml("<view/>").unwrap())
            })
            .unwrap();
        session.commit_page_render_work(page, frontier);
        assert_eq!(
            session
                .evaluate_page_template(page, template, &source, &data, &templates)
                .unwrap(),
            prepared
        );
        assert_eq!(
            session.component_pages[&page]
                .render_work
                .completed_evaluations(),
            2
        );

        let candidate_source = parse_wxml("<text>candidate:{{title}}</text>").unwrap();
        templates.insert(template.into(), candidate_source.clone());
        let candidate = work_session(&templates);
        let preview = candidate
            .preview_page_template(
                &session,
                page,
                template,
                &candidate_source,
                &data,
                &templates,
            )
            .unwrap();
        assert_ne!(preview, prepared);
        assert_eq!(
            session.component_pages[&page]
                .render_work
                .completed_evaluations(),
            2
        );
        let mut live_work = session.component_pages[&page].render_work.clone();
        assert!(matches!(
            live_work.read("page:1/component:child", "child.wxml", &json!({})),
            render_work::RenderRead::Ready(Ok(_))
        ));
    }

    #[test]
    fn component_frontiers_reuse_data_but_not_historical_a_b_a_results() {
        let page_template = "template:pages/index/index.wxml";
        let component_template = "template:components/card/index.wxml";
        let module = "module:components/card/index.js";
        let page_source = parse_wxml("<card><text>{{title}}</text></card>").unwrap();
        let component_source = parse_wxml("<view><slot/><text>{{count}}</text></view>").unwrap();
        let templates = BTreeMap::from([
            (page_template.into(), page_source.clone()),
            (component_template.into(), component_source),
        ]);
        let evaluated_page = evaluate_wxml(&page_source, &json!({"title":"parent"})).unwrap();
        let mut session = work_session(&templates);
        session.manifest.modules.push(container_ir::Module {
            id: module.into(),
            sha256: "0".repeat(64),
            format: ModuleFormat::Commonjs,
            scope: container_ir::ModuleScope::Component,
            dependencies: Vec::new(),
        });
        session.manifest.components.push(container_ir::Component {
            id: "components:page".into(),
            owner: "pages/index/index.json".into(),
            using_components: BTreeMap::from([("card".into(), "/components/card/index".into())]),
            multiple_slots: None,
        });
        session.loaded_modules.insert(
            module.into(),
            LoadedModule {
                module_id: ModuleId(1),
                sha256: "0".repeat(64),
                format: ModuleFormat::Commonjs,
                // This render-only fixture installs a factory mapping; it
                // does not execute a native module-evaluation task.
                evaluated: false,
            },
        );
        let mut work = RenderWork::default();
        work.begin_program(render_program_fingerprint(&session.manifest, &templates).unwrap());
        let mut specs = Vec::new();
        session
            .expand_owned_components(
                own_nodes(&evaluated_page.nodes, page_template, None),
                "page:1",
                None,
                "",
                &templates,
                ComponentExpansion::Managed {
                    snapshots: &BTreeMap::new(),
                    prepared_bindings: &BTreeMap::new(),
                },
                &mut work,
                &mut specs,
                0,
            )
            .unwrap();
        let scope = specs[0]["scopeId"].as_str().unwrap().to_owned();
        let prepared_bindings = BTreeMap::from([(scope.clone(), specs[0]["properties"].clone())]);
        for (count, attached, expected) in [(1, false, 1), (1, true, 1), (2, true, 2), (1, true, 3)]
        {
            let snapshots = BTreeMap::from([(
                scope.clone(),
                json!({"data":{"count":count},"created":true,"attached":attached,"lifecycle":["created","attached"]}),
            )]);
            let mut next_specs = Vec::new();
            let owned = session
                .expand_owned_components(
                    own_nodes(&evaluated_page.nodes, page_template, None),
                    "page:1",
                    None,
                    "",
                    &templates,
                    ComponentExpansion::Managed {
                        snapshots: &snapshots,
                        prepared_bindings: &prepared_bindings,
                    },
                    &mut work,
                    &mut next_specs,
                    0,
                )
                .unwrap();
            assert_eq!(work.completed_evaluations(), expected);
            assert_eq!(next_specs, specs);
            let events = collect_event_nodes(&owned).unwrap();
            assert!(events.iter().any(|event| event["ownerScopeId"].is_null()));
            assert!(events.iter().any(|event| event["ownerScopeId"] == scope));
        }
        work.release_scopes(std::slice::from_ref(&scope));
        assert!(matches!(
            work.read(&scope, component_template, &json!({"count":1})),
            render_work::RenderRead::Pending(_)
        ));
    }

    #[test]
    fn program_fingerprint_tracks_imported_documents_and_bindings_but_excludes_styles() {
        let mut manifest = ContainerManifestV1::default();
        let mut templates = BTreeMap::from([
            (
                "page.wxml".into(),
                parse_wxml("<include src=\"shared.wxml\"/>").unwrap(),
            ),
            (
                "shared.wxml".into(),
                parse_wxml("<text>first</text>").unwrap(),
            ),
        ]);
        let initial = render_program_fingerprint(&manifest, &templates).unwrap();
        manifest.styles.push(container_ir::Style {
            id: "style:app.wxss".into(),
            wxss_ir: format!("sha256:{}", "0".repeat(64)),
            scope: container_ir::StyleScope::App,
        });
        assert_eq!(
            render_program_fingerprint(&manifest, &templates).unwrap(),
            initial
        );
        templates.insert(
            "shared.wxml".into(),
            parse_wxml("<text>second</text>").unwrap(),
        );
        let changed_document = render_program_fingerprint(&manifest, &templates).unwrap();
        assert_ne!(changed_document, initial);
        manifest.templates.push(container_ir::Template {
            id: "page.wxml".into(),
            wxml_ast: format!("sha256:{}", "0".repeat(64)),
            bindings: Vec::new(),
            wxs_modules: BTreeMap::from([("format".into(), "view-script:format.wxs".into())]),
        });
        assert_ne!(
            render_program_fingerprint(&manifest, &templates).unwrap(),
            changed_document
        );
    }

    fn evaluated_nodes(source: &str, data: Value, owner: Option<&str>) -> Vec<OwnedNode> {
        let ast = evaluate_wxml(&parse_wxml(source).unwrap(), &data).unwrap();
        own_nodes(&ast.nodes, "template:pages/index/index.wxml", owner)
    }

    #[test]
    fn flattened_ownership_keeps_resolved_component_and_owner_documents() {
        let mut nodes = evaluated_nodes(
            "<card><text>slot</text></card>",
            json!({}),
            Some("declaring-owner"),
        );
        nodes[0].component_scope = Some("mounted-child".into());
        nodes[0].component_document = Some("template:components/child/index.wxml".into());
        if let WxmlNode::Element { lexical_origin, .. } = &mut nodes[0].node {
            *lexical_origin = Some(
                container_ir::WxmlLexicalOrigin::from_document("shared/included.wxml").unwrap(),
            );
        }
        let mut ownership = BTreeMap::new();
        flatten(nodes, "", &mut ownership);
        assert_eq!(ownership["0"].template, "shared/included.wxml");
        assert_eq!(
            ownership["0"].component_document.as_deref(),
            Some("template:components/child/index.wxml")
        );
        assert_eq!(
            ownership["0"].event_owner_document.as_deref(),
            Some("template:pages/index/index.wxml")
        );
        assert_eq!(
            ownership["0.0"].event_owner.as_deref(),
            Some("declaring-owner")
        );
        assert_eq!(
            ownership["0.0"].event_owner_document.as_deref(),
            Some("template:pages/index/index.wxml")
        );
        assert!(ownership["0.0"].component_document.is_none());
    }

    #[test]
    fn composed_event_nodes_preserve_physical_parents_attributes_and_typed_metadata() {
        let mut nodes = evaluated_nodes(concat!(
            "<view id=\"root\" data-user-id=\"{{user}}\" mark:ready=\"{{ready}}\" mark-source=\"raw\" bind:custom=\"receive\">",
            "<!-- comment --><block><view id=\"middle\" data-count=\"{{count}}\"><text id=\"leaf\">text</text></view></block></view>",
            "<image id=\"other\"/>"
        ),json!({"user":{"id":7},"ready":true,"count":3}),None);
        nodes[0].component_scope = Some("outer".into());
        nodes[0].children[1].children[0].owner = Some("outer".into());
        nodes[0].children[1].children[0].component_scope = Some("inner".into());
        nodes[0].children[1].children[0].children[0].owner = Some("inner".into());
        let events = collect_event_nodes(&nodes).unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(events[0]["key"], "event:0");
        assert!(events[0]["parentKey"].is_null());
        assert!(events[0]["ownerScopeId"].is_null());
        assert_eq!(events[0]["componentScopeId"], "outer");
        assert_eq!(events[0]["dataset"], json!({"userId":{"id":7}}));
        assert_eq!(events[0]["mark"], json!({"ready":true,"source":"raw"}));
        assert_eq!(events[0]["attributes"]["bind:custom"], "receive");
        assert_eq!(events[1]["key"], "event:0.1.0");
        assert_eq!(events[1]["parentKey"], "event:0");
        assert_eq!(events[1]["ownerScopeId"], "outer");
        assert_eq!(events[1]["componentScopeId"], "inner");
        assert_eq!(events[1]["dataset"]["count"].as_f64(), Some(3.0));
        assert_eq!(events[2]["parentKey"], events[1]["key"]);
        assert_eq!(events[2]["ownerScopeId"], "inner");
        assert_eq!(events[3]["key"], "event:1");
        assert!(events[3]["parentKey"].is_null());
    }

    #[test]
    fn event_keys_match_render_ownership_and_survive_keyed_reordering() {
        let source = "<view><view wx:for=\"{{items}}\" wx:key=\"id\" id=\"{{item.id}}\"/></view>";
        let identity_map = |items| {
            let nodes = evaluated_nodes(source, json!({"items":items}), None);
            let events = collect_event_nodes(&nodes).unwrap();
            let mut ownership = BTreeMap::new();
            flatten(nodes, "", &mut ownership);
            for event in &events {
                let key = event["key"].as_str().unwrap();
                assert!(ownership.contains_key(key.strip_prefix("event:").unwrap()));
            }
            events
                .into_iter()
                .map(|event| (event["attributes"]["id"].clone(), event["key"].clone()))
                .collect::<Vec<_>>()
        };
        let initial = identity_map(json!([{"id":"a"},{"id":"b"}]));
        let reordered = identity_map(json!([{"id":"b"},{"id":"a"}]));
        assert_eq!(initial[1], reordered[2]);
        assert_eq!(initial[2], reordered[1]);
        assert_ne!(initial[1].1, initial[2].1);
    }

    #[test]
    fn projected_slot_event_parent_follows_composition_and_listener_owner_follows_declaration() {
        let light = evaluated_nodes(
            "<view id=\"light\" data-value=\"{{value}}\" bind:custom=\"pageHandler\"/>",
            json!({"value":false}),
            None,
        );
        let component = evaluated_nodes(
            "<view id=\"inside\"><slot/></view>",
            json!({}),
            Some("host"),
        );
        let projected = project_slots(component, &light, false);
        let events = collect_event_nodes(&projected).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["ownerScopeId"], "host");
        assert_eq!(events[1]["parentKey"], events[0]["key"]);
        assert!(events[1]["ownerScopeId"].is_null());
        assert_eq!(events[1]["dataset"]["value"], false);
        assert_eq!(events[1]["attributes"]["bind:custom"], "pageHandler");
    }

    #[test]
    fn event_only_binding_changes_are_not_hidden_by_unchanged_component_selection() {
        let first=evaluated_nodes("<view id=\"same\" data-value=\"{{value}}\" mark:state=\"{{value}}\" bind:custom=\"{{handler}}\"/>",json!({"value":1,"handler":"first"}),None);
        let next=evaluated_nodes("<view id=\"same\" data-value=\"{{value}}\" mark:state=\"{{value}}\" bind:custom=\"{{handler}}\"/>",json!({"value":2,"handler":"next"}),None);
        assert_eq!(
            collect_selection_nodes(&first, &mut []),
            collect_selection_nodes(&next, &mut [])
        );
        assert_ne!(
            collect_event_nodes(&first).unwrap(),
            collect_event_nodes(&next).unwrap()
        );
    }

    #[test]
    fn component_ownership_uses_typed_parents_and_releases_only_confirmed_scopes() {
        let mut graph = ManagedPage::default();
        graph
            .lease_frontier(&[
                json!({"scopeId":"long-parent","parentScopeId":null}),
                json!({"scopeId":"s","parentScopeId":null}),
            ])
            .unwrap();
        graph.instances = vec![json!({"scopeId":"long-parent"}), json!({"scopeId":"s"})];
        graph
            .lease_frontier(&[
                json!({"scopeId":"long-parent","parentScopeId":null}),
                json!({"scopeId":"i","parentScopeId":"long-parent"}),
                json!({"scopeId":"s","parentScopeId":null}),
            ])
            .unwrap();
        assert_eq!(graph.scope_leases, ["long-parent", "s", "i"]);
        assert_eq!(
            graph
                .ordered_scopes(graph.scope_leases.iter().cloned())
                .unwrap(),
            ["long-parent", "i", "s"]
        );
        assert_eq!(
            graph.ordered_scopes(["s".into(), "i".into()]).unwrap(),
            ["i", "s"]
        );
        graph.release_scope_leases(&["i".into()]);
        assert_eq!(graph.scope_leases, ["long-parent", "s"]);
        assert!(!graph.scope_parents.contains_key("i"));
        assert_eq!(graph.scope_frontier, ["long-parent", "s"]);
    }

    #[test]
    fn component_ownership_rejects_missing_parents_and_cycles_explicitly() {
        let mut missing = ManagedPage::default();
        let error = missing
            .lease_frontier(&[json!({"scopeId":"child","parentScopeId":"missing"})])
            .unwrap_err();
        assert!(error.message.contains("parent is unavailable"));
        let mut cyclic = ManagedPage::default();
        let error = cyclic
            .lease_frontier(&[
                json!({"scopeId":"a","parentScopeId":"b"}),
                json!({"scopeId":"b","parentScopeId":"a"}),
            ])
            .unwrap_err();
        assert!(error.message.contains("contains a cycle"));
    }
}
