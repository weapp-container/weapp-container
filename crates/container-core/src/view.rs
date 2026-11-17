//! Batched, isolated View execution. This API does not expose AppService or
//! certify the WeChat WXS dialect. Hosts must retain the last committed frame
//! until a complete evaluation succeeds.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::atomic::AtomicBool,
    sync::Arc,
    time::Duration,
};

pub const VIEW_SCRIPT_BOOTSTRAP: &str = include_str!("view.js");
/// Separate synchronous ECMAScript profile; legacy WXS retains its own realm.
pub const MODERN_VIEW_SCRIPT_BOOTSTRAP: &str = include_str!("modern_view.js");

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewModuleSource {
    pub id: String,
    pub source: String,
    pub dependencies: Vec<String>,
    /// Explicit compiled WXS input. Without this field the direct ViewEngine
    /// API continues to execute ECMAScript, rather than claiming WXS semantics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compilation: Option<ViewCompiledSource>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewCompiledSource {
    pub code: String,
    pub helper: String,
    pub abi: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewCompiledExpression {
    pub source: String,
    pub shorthand: bool,
    pub compilation: ViewCompiledSource,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewExpressionTask {
    pub task_id: String,
    pub scope_id: String,
    pub document_id: String,
    pub expression: String,
    pub data: Value,
    pub bindings: BTreeMap<String, String>,
}

/// JSON cannot represent these JavaScript values without losing information.
/// Tags apply recursively and never invoke user-defined `toJSON` methods.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum ViewValue {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    #[serde(rename = "nan")]
    NaN,
    PositiveInfinity,
    NegativeInfinity,
    NegativeZero,
    String(String),
    Array(Vec<ViewValue>),
    Object(BTreeMap<String, ViewValue>),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewExpressionResult {
    pub task_id: String,
    pub value: ViewValue,
}

/// One verified WXML document, identified by its canonical package-relative
/// path. The runtime validates the AST against container-ir before transport;
/// the View realm independently validates the wire shape before executing it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewRenderDocument {
    pub document_id: String,
    pub ast: Value,
    pub bindings: BTreeMap<String, String>,
    /// Some(empty) is a compiled document with no executable expressions.
    /// Missing compiled expressions must never fall back to raw evaluation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compilation: Option<Vec<ViewCompiledExpression>>,
}

/// Render an entire document in one page or component occurrence. Data crosses
/// the native boundary once; loops and lazy branches execute inside View.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewRenderTask {
    pub task_id: String,
    pub scope_id: String,
    pub document_id: String,
    pub data: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewRenderBatch {
    pub documents: Vec<ViewRenderDocument>,
    pub tasks: Vec<ViewRenderTask>,
}

/// Immutable static input for one profile in the current module epoch. A
/// caller can create a candidate, but only the provider can install it after
/// full validation. Claimed manifest hashes are never authority.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewDocumentProgram {
    documents: Vec<ViewRenderDocument>,
}

impl ViewDocumentProgram {
    pub fn new(documents: Vec<ViewRenderDocument>) -> Self {
        Self { documents }
    }

    pub fn documents(&self) -> &[ViewRenderDocument] {
        &self.documents
    }
}

/// An opaque, process-local lease. It is deliberately not serializable and
/// has no public constructor. Ownership is an unforgeable Arc identity, not
/// an input hash, pointer exported to JS, or caller-supplied numeric token.
#[derive(Clone)]
pub struct ViewDocumentHandle(Arc<ViewDocumentLease>);

struct ViewDocumentLease {
    wire_key: String,
    document_ids: BTreeSet<String>,
}

impl fmt::Debug for ViewDocumentHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ViewDocumentHandle").finish_non_exhaustive()
    }
}

impl ViewDocumentHandle {
    pub fn document_ids(&self) -> &BTreeSet<String> {
        &self.0.document_ids
    }
}

/// Concrete providers own one registry for one realm/profile. Successful
/// registration retires the prior lease; module load/reset/dispose invalidates
/// it. Failed ordinary preparation leaves it untouched. Only one static
/// program is retained by this registry and by the private JS closure.
#[derive(Default, Debug)]
pub struct ViewDocumentRegistry {
    next: u64,
    active: Option<ViewDocumentHandle>,
}

impl ViewDocumentRegistry {
    pub fn reserve_key(&mut self) -> Result<String, ViewEngineError> {
        self.next = self.next.checked_add(1).ok_or_else(|| {
            ViewEngineError::new(
                ViewEngineErrorCode::InvalidBatch,
                "View document registration sequence exhausted",
            )
        })?;
        Ok(self.next.to_string())
    }

    /// Invoke only after the private VM has accepted the complete program.
    pub fn publish(
        &mut self,
        wire_key: String,
        documents: &[ViewRenderDocument],
    ) -> ViewDocumentHandle {
        let handle = ViewDocumentHandle(Arc::new(ViewDocumentLease {
            wire_key,
            document_ids: documents
                .iter()
                .map(|document| document.document_id.clone())
                .collect(),
        }));
        self.active = Some(handle.clone());
        handle
    }

    pub fn key(&self, handle: &ViewDocumentHandle) -> Result<String, ViewEngineError> {
        if !self
            .active
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(&active.0, &handle.0))
        {
            return Err(ViewEngineError::new(
                ViewEngineErrorCode::InvalidBatch,
                "View document handle belongs to another realm, module epoch or retired program",
            ));
        }
        Ok(handle.0.wire_key.clone())
    }

    pub fn invalidate(&mut self) {
        self.active = None;
    }
}

/// Each registration is bounded before VM parsing; this is not a total realm
/// memory budget. Existing expression-function caches have their own entry
/// bounds. Ordinary render_batch retains its independent boundary.
pub const MAX_VIEW_DOCUMENT_PROGRAM_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_VIEW_DOCUMENT_PROGRAM_DOCUMENTS: usize = 4096;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewDocumentRegistration<'a> {
    pub program_id: &'a str,
    pub documents: &'a [ViewRenderDocument],
}

pub fn encode_view_document_registration(
    input: ViewDocumentRegistration<'_>,
) -> Result<String, serde_json::Error> {
    use serde::ser::Error;
    if input.documents.len() > MAX_VIEW_DOCUMENT_PROGRAM_DOCUMENTS {
        return Err(serde_json::Error::custom(
            "View document program exceeds the document bound",
        ));
    }
    let encoded = serde_json::to_string(&input)?;
    if encoded.len() > MAX_VIEW_DOCUMENT_PROGRAM_BYTES {
        return Err(serde_json::Error::custom(
            "View document program exceeds the static byte bound",
        ));
    }
    Ok(encoded)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewRegisteredRenderBatch<'a> {
    pub program_id: &'a str,
    pub tasks: &'a [ViewRenderTask],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewRenderResult {
    pub task_id: String,
    /// Complete evaluated WXML AST, with ordinary JSON attribute values.
    /// Intermediate JavaScript values are retained until their render sink;
    /// values that cannot enter that sink fail with UnsupportedValue.
    pub ast: Value,
    /// Constructed by the retained evaluator, independently of input AST metadata.
    /// These paths carry no owner tokens or accepted-write authority.
    #[serde(default)]
    pub attribute_sources: Vec<Value>,
}

/// Verify the complete evaluated tree's lexical document provenance before a
/// host may publish it. Source documents and older IR may omit this metadata;
/// native render results cannot. Occurrence sites remain opaque and are never
/// parsed to recover document identity or component ownership.
pub fn validate_view_render_provenance(
    ast: &Value,
    documents: &BTreeSet<String>,
) -> Result<(), ViewEngineError> {
    fn invalid(message: &str) -> ViewEngineError {
        ViewEngineError::new(ViewEngineErrorCode::InvalidBatch, message)
    }
    fn visit(
        nodes: &Value,
        documents: &BTreeSet<String>,
        depth: usize,
    ) -> Result<(), ViewEngineError> {
        let nodes = nodes.as_array().filter(|_| depth <= 128).ok_or_else(|| {
            invalid("View render result has invalid nodes or exceeds the maximum depth")
        })?;
        for node in nodes {
            let origin = node
                .get("lexicalOrigin")
                .and_then(Value::as_object)
                .filter(|origin| origin.len() == 1)
                .and_then(|origin| origin.get("documentId"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    invalid("View render node is missing typed lexical document provenance")
                })?;
            if !documents.contains(origin)
                || !origin.ends_with(".wxml")
                || origin.chars().any(|character| {
                    character.is_control() || matches!(character, '\\' | '#' | '?' | ':')
                })
                || origin
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
            {
                return Err(invalid(
                    "View render node names an undeclared or noncanonical lexical document",
                ));
            }
            match node.get("kind").and_then(Value::as_str) {
                Some("element") => visit(&node["children"], documents, depth + 1)?,
                Some("text" | "comment") => {}
                _ => return Err(invalid("View render result contains an invalid node kind")),
            }
        }
        Ok(())
    }
    if ast.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(invalid("View render result has an unsupported AST version"));
    }
    visit(&ast["nodes"], documents, 0)
}

/// A total monotonic budget for one load/evaluation batch, including transport,
/// compilation, module initialization and result conversion. Cancellation can
/// be signalled by another thread without moving the thread-affine JS engine.
#[derive(Clone, Debug)]
pub struct ViewExecutionBudget {
    pub timeout: Duration,
    pub cancellation: Arc<AtomicBool>,
}

impl ViewExecutionBudget {
    pub fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            cancellation: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Default for ViewExecutionBudget {
    fn default() -> Self {
        Self::new(Duration::from_millis(50))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewEngineErrorCode {
    Unavailable,
    Timeout,
    Cancelled,
    RequiresReset,
    Module,
    Execution,
    UnsupportedValue,
    InvalidBatch,
}

impl ViewEngineErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "ERR_ENGINE",
            Self::Timeout => "ERR_TIMEOUT",
            Self::Cancelled => "ERR_CANCELLED",
            Self::RequiresReset => "ERR_VIEW_REQUIRES_RESET",
            Self::Module => "ERR_VIEW_MODULE",
            Self::Execution => "ERR_VIEW_EXECUTION",
            Self::UnsupportedValue => "ERR_VIEW_UNSUPPORTED_VALUE",
            Self::InvalidBatch => "ERR_VIEW_INVALID_BATCH",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewEngineError {
    pub code: ViewEngineErrorCode,
    pub message: String,
    pub stack: Option<String>,
    document_program_rejected: bool,
}

impl ViewEngineError {
    pub fn new(code: ViewEngineErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            stack: None,
            document_program_rejected: false,
        }
    }

    /// Only a concrete provider's pure static-registration boundary may use
    /// this provenance. It must never be inferred from ERR_* or guest text.
    pub fn document_program_rejected(mut self) -> Self {
        self.document_program_rejected = true;
        self
    }

    pub fn is_document_program_rejection(&self) -> bool {
        self.document_program_rejected
    }

    pub fn with_stack(mut self, stack: impl Into<String>) -> Self {
        self.stack = Some(stack.into());
        self
    }

    /// Decode the bootstrap's error object, failing closed on malformed replies.
    pub fn from_wire(value: &Value) -> Self {
        let code = match value.get("code").and_then(Value::as_str) {
            Some("ERR_VIEW_MODULE") => ViewEngineErrorCode::Module,
            Some("ERR_VIEW_UNSUPPORTED_VALUE") => ViewEngineErrorCode::UnsupportedValue,
            Some("ERR_VIEW_INVALID_BATCH") => ViewEngineErrorCode::InvalidBatch,
            Some("ERR_TIMEOUT") => ViewEngineErrorCode::Timeout,
            Some("ERR_CANCELLED") => ViewEngineErrorCode::Cancelled,
            _ => ViewEngineErrorCode::Execution,
        };
        Self {
            code,
            message: value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("invalid View engine error response")
                .to_owned(),
            stack: value
                .get("stack")
                .and_then(Value::as_str)
                .map(str::to_owned),
            document_program_rejected: false,
        }
    }
}

impl fmt::Display for ViewEngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ViewEngineError {}

/// Native monotonic measurements from the most recent provider batch. VM
/// execution includes bootstrap validation, lazy compilation and guest work;
/// compile time is unavailable until those operations have separate native
/// boundaries. A null compileNs must never be interpreted as zero compile cost.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewEngineTimings {
    pub batches: u64,
    pub elapsed_ns: u64,
    pub input_encode_ns: u64,
    #[serde(default)]
    pub input_bytes: u64,
    #[serde(default)]
    pub document_registrations: u64,
    #[serde(default)]
    pub registered_render_batches: u64,
    pub vm_input_parse_ns: u64,
    pub execute_including_lazy_compile_ns: u64,
    /// Intrinsic result encoding and native string copy. Modern View returns
    /// an already encoded reply, so its in-VM writer belongs to execution.
    pub vm_output_encode_ns: u64,
    pub output_decode_ns: u64,
    pub compile_ns: Option<u64>,
    /// One actual owner-thread batch, never an aggregate CPU/clock interval.
    /// Disabled, WASM and unsupported platforms serialize this explicitly null.
    #[serde(default)]
    pub last_batch: Option<crate::view_probe::ViewBatchDiagnostics>,
    /// Optional detail for exactly last_batch; never an aggregate interval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_batch_breakdown: Option<crate::view_probe::ViewBatchBreakdown>,
}

impl ViewEngineTimings {
    pub fn accumulate(&mut self, next: &Self) {
        self.batches = self.batches.saturating_add(next.batches);
        self.elapsed_ns = self.elapsed_ns.saturating_add(next.elapsed_ns);
        self.input_encode_ns = self.input_encode_ns.saturating_add(next.input_encode_ns);
        self.input_bytes = self.input_bytes.saturating_add(next.input_bytes);
        self.document_registrations = self
            .document_registrations
            .saturating_add(next.document_registrations);
        self.registered_render_batches = self
            .registered_render_batches
            .saturating_add(next.registered_render_batches);
        self.vm_input_parse_ns = self
            .vm_input_parse_ns
            .saturating_add(next.vm_input_parse_ns);
        self.execute_including_lazy_compile_ns = self
            .execute_including_lazy_compile_ns
            .saturating_add(next.execute_including_lazy_compile_ns);
        self.vm_output_encode_ns = self
            .vm_output_encode_ns
            .saturating_add(next.vm_output_encode_ns);
        self.output_decode_ns = self.output_decode_ns.saturating_add(next.output_decode_ns);
        // The last provider call owns its own sequence/clock interval. Never
        // relabel an aggregate frontier as one diagnostic batch, or retain a
        // stale record when the last provider is uninstrumented.
        self.last_batch = next.last_batch.clone();
        self.last_batch_breakdown = next.last_batch_breakdown.clone();
        // Unknown stays unknown, including when an uninstrumented provider is
        // mixed with an instrumented profile by the runtime.
        self.compile_ns = self
            .compile_ns
            .zip(next.compile_ns)
            .map(|(left, right)| left.saturating_add(right));
    }
}

/// Entire module/expression batches cross the native boundary once. A timeout
/// or cancellation poisons only this View realm; `reset` creates a fresh realm.
/// No AppService globals, host providers or microtask draining are installed.
pub trait ViewEngine {
    /// Pure metadata access. Reading this cannot enter the VM or run guest
    /// code; uninstrumented providers return None rather than invented zeros.
    fn last_timings(&self) -> Option<ViewEngineTimings> {
        None
    }
    fn load_modules(
        &mut self,
        modules: &[ViewModuleSource],
        budget: &ViewExecutionBudget,
    ) -> Result<(), ViewEngineError>;
    fn evaluate_batch(
        &mut self,
        tasks: &[ViewExpressionTask],
        budget: &ViewExecutionBudget,
    ) -> Result<Vec<ViewExpressionResult>, ViewEngineError>;
    fn render_batch(
        &mut self,
        batch: &ViewRenderBatch,
        budget: &ViewExecutionBudget,
    ) -> Result<Vec<ViewRenderResult>, ViewEngineError>;
    /// Preflight all static documents/expressions without initializing any
    /// module occurrence. This and following renders share the caller's total
    /// deadline by receiving only the remaining budget.
    fn register_documents(
        &mut self,
        program: &ViewDocumentProgram,
        budget: &ViewExecutionBudget,
    ) -> Result<ViewDocumentHandle, ViewEngineError>;
    fn render_registered_batch(
        &mut self,
        handle: &ViewDocumentHandle,
        tasks: &[ViewRenderTask],
        budget: &ViewExecutionBudget,
    ) -> Result<Vec<ViewRenderResult>, ViewEngineError>;
    /// Release exactly these page/component caches. Hidden pages retain their
    /// scopes; popped pages and detached component occurrences release them.
    fn release_scopes(
        &mut self,
        scopes: &[String],
        budget: &ViewExecutionBudget,
    ) -> Result<(), ViewEngineError>;
    fn reset(&mut self) -> Result<(), ViewEngineError>;
    /// Destroy native ownership and invalidate document handles without
    /// entering the VM or running guest cleanup. This must remain safe after
    /// interruption; selective healthy cleanup belongs to `release_scopes`.
    fn dispose(&mut self);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_provenance_rejects_missing_undeclared_and_malformed_origins() {
        let documents = BTreeSet::from(["pages/index.wxml".into(), "shared/card.wxml".into()]);
        let valid = serde_json::json!({"version":1,"nodes":[{
            "kind":"element","tag":"view","lexicalOrigin":{"documentId":"pages/index.wxml"},
            "children":[{"kind":"text","value":"imported","lexicalOrigin":{"documentId":"shared/card.wxml"}}]
        }]});
        validate_view_render_provenance(&valid, &documents).unwrap();
        for origin in [
            Value::Null,
            serde_json::json!({"documentId":"unsubmitted.wxml"}),
            serde_json::json!({"documentId":"../pages/index.wxml"}),
            serde_json::json!({"documentId":"pages/index.wxml","ownerScopeId":"page:1"}),
        ] {
            let mut broken = valid.clone();
            broken["nodes"][0]["children"][0]["lexicalOrigin"] = origin;
            assert_eq!(
                validate_view_render_provenance(&broken, &documents)
                    .unwrap_err()
                    .code,
                ViewEngineErrorCode::InvalidBatch
            );
        }
        let mut absent = valid;
        absent["nodes"][0]
            .as_object_mut()
            .unwrap()
            .remove("lexicalOrigin");
        assert!(validate_view_render_provenance(&absent, &documents).is_err());
    }

    #[test]
    fn tagged_values_roundtrip_without_user_shape_collisions() {
        let value = ViewValue::Object(BTreeMap::from([
            ("type".into(), ViewValue::String("undefined".into())),
            (
                "value".into(),
                ViewValue::Array(vec![
                    ViewValue::NaN,
                    ViewValue::Undefined,
                    ViewValue::NegativeZero,
                    ViewValue::PositiveInfinity,
                    ViewValue::NegativeInfinity,
                ]),
            ),
        ]));
        let json = serde_json::to_string(&value).unwrap();
        assert_eq!(serde_json::from_str::<ViewValue>(&json).unwrap(), value);
    }
}
