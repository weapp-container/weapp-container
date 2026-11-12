//! Parsers and stable, runtime-independent IR for WXML and WXSS.
//!
//! The manifest keeps pointers to these documents in content-addressed blobs.
//! This module describes the bytes stored behind those pointers.  It is kept
//! deliberately small and lossless for the parts which are needed by a host:
//! element names/attributes, text and mustache expressions for WXML, and
//! selectors/declarations for WXSS.  Unknown WXML tags and CSS properties are
//! preserved instead of being interpreted by the container.

use crate::{
    parse_wxss_font_size, parse_wxss_line_height, parse_wxss_text_align, parse_wxss_text_direction,
    parse_wxss_unicode_bidi, parse_wxss_white_space, parse_wxss_word_break,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};

#[path = "binding_provenance.rs"]
mod binding_provenance;
use binding_provenance::{source_origin, BindingOrigin};
pub use binding_provenance::{BindingDataPath, BindingPathSegment, WxmlAttributeSource};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvaluatedWxml {
    pub ast: WxmlAst,
    pub attribute_sources: Vec<WxmlAttributeSource>,
}

pub const WXML_IR_VERSION: u32 = 1;
pub const WXSS_IR_VERSION: u32 = 2;

/// A parsed WXML document.  `version` belongs to the blob format and is
/// independent from the enclosing container-manifest schema version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WxmlAst {
    pub version: u32,
    pub nodes: Vec<WxmlNode>,
}

impl Default for WxmlAst {
    fn default() -> Self {
        Self {
            version: WXML_IR_VERSION,
            nodes: Vec::new(),
        }
    }
}

impl WxmlAst {
    /// Serialize with the same recursively UTF-8-key-sorted JSON rules used
    /// by the JavaScript packer.  Hosts may use this when deriving a blob or
    /// comparing a generated IR document with a manifest blob.
    pub fn canonical_json(&self) -> Result<Vec<u8>, MarkupError> {
        let value = serde_json::to_value(self).map_err(|error| MarkupError::InvalidSyntax {
            offset: 0,
            message: format!("cannot serialize WXML IR: {error}"),
        })?;
        Ok(super::canonicalize_value(&value).into_bytes())
    }
}

/// The verified document a node was evaluated from. Occurrence identity,
/// component configuration and listener ownership use separate metadata.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WxmlLexicalOrigin {
    /// Canonical package-relative WXML path. This names lexical WXS bindings,
    /// not a component configuration, listener owner or physical parent.
    pub document_id: String,
}

impl WxmlLexicalOrigin {
    pub fn from_document(document: &str) -> Result<Self, MarkupError> {
        if document.is_empty()
            || !document.ends_with(".wxml")
            || document.chars().any(|character| {
                character.is_control() || matches!(character, '\\' | '#' | '?' | ':')
            })
            || document
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(MarkupError::InvalidSyntax {
                offset: 0,
                message: "WXML lexical origin requires a canonical package-relative .wxml path"
                    .into(),
            });
        }
        Ok(Self {
            document_id: document.into(),
        })
    }
}

/// WXML nodes use a tagged representation so that a renderer does not have
/// to infer whether a string is markup or text. `attrs` is a sorted map in
/// the serialized form, making output deterministic across hosts.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WxmlNode {
    Element {
        tag: String,
        #[serde(
            rename = "lexicalOrigin",
            alias = "lexical_origin",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        lexical_origin: Option<WxmlLexicalOrigin>,
        attrs: BTreeMap<String, String>,
        /// Evaluated JSON values for attributes consisting of one complete
        /// mustache binding. `attrs` retains its string representation for
        /// existing renderers, while consumers such as component properties
        /// can use this map without guessing a type from a rendered string.
        /// Parsed source and older v1 blobs omit this optional wire field.
        #[serde(
            rename = "boundValues",
            alias = "bound_values",
            default,
            skip_serializing_if = "BTreeMap::is_empty"
        )]
        bound_values: BTreeMap<String, Value>,
        bindings: Vec<String>,
        #[serde(default, skip_serializing_if = "WxmlDirectives::is_empty")]
        directives: WxmlDirectives,
        /// Stable identity assigned by a `wx:for`/`wx:key` evaluation.
        ///
        /// Source AST nodes keep this field empty.  The evaluator fills it
        /// with the serialized key for every repeated instance so a host can
        /// reconcile state when an array is reordered.  It is optional on the
        /// wire to keep v1 AST blobs produced before keyed-repeat support
        /// backwards compatible.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
        /// Source occurrence of the repeat which assigned `key`. Unlike an
        /// expanded sibling index, this stays stable when items reorder and
        /// distinguishes independent repeat/template/include declarations.
        /// Source AST blobs omit it; older v1 evaluated blobs remain readable.
        #[serde(
            rename = "keyScope",
            alias = "key_scope",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        key_scope: Option<String>,
        /// Stable source occurrence after evaluation, independent of filtered
        /// sibling positions. Includes template/include invocations and loop
        /// identity so unkeyed child instances can retain their own state.
        /// Source AST blobs and older v1 blobs omit this optional field.
        #[serde(
            rename = "sourceSite",
            alias = "source_site",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        source_site: Option<String>,
        children: Vec<WxmlNode>,
    },
    Text {
        value: String,
        bindings: Vec<String>,
        #[serde(
            rename = "lexicalOrigin",
            alias = "lexical_origin",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        lexical_origin: Option<WxmlLexicalOrigin>,
    },
    Comment {
        value: String,
        #[serde(
            rename = "lexicalOrigin",
            alias = "lexical_origin",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        lexical_origin: Option<WxmlLexicalOrigin>,
    },
}

impl WxmlNode {
    pub fn lexical_origin(&self) -> Option<&WxmlLexicalOrigin> {
        match self {
            Self::Element { lexical_origin, .. }
            | Self::Text { lexical_origin, .. }
            | Self::Comment { lexical_origin, .. } => lexical_origin.as_ref(),
        }
    }
}

/// Structured WXML directives extracted from the attribute map.
///
/// The original attributes remain lossless in `WxmlNode::Element::attrs`; this
/// normalized view lets a host implement control flow and event dispatch
/// without reparsing attribute names on every render.  All fields are
/// optional so documents without directives serialize exactly as they did in
/// the v1 IR.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WxmlDirectives {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub if_expr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elif_expr: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub else_branch: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub for_expr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub for_item: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub for_index: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub for_key: Option<String>,
    /// Event attributes are keyed by their original WXML spelling, for
    /// example `bindtap` or `capture-catch:longpress`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub events: BTreeMap<String, String>,
}

impl WxmlDirectives {
    pub fn is_empty(&self) -> bool {
        self.if_expr.is_none()
            && self.elif_expr.is_none()
            && !self.else_branch
            && self.for_expr.is_none()
            && self.for_item.is_none()
            && self.for_index.is_none()
            && self.for_key.is_none()
            && self.events.is_empty()
    }

    /// Build a normalized directive view while preserving unknown attributes.
    pub fn from_attrs(attrs: &BTreeMap<String, String>) -> Self {
        let mut directives = Self::default();
        for (name, value) in attrs {
            match name.as_str() {
                "wx:if" => directives.if_expr = directive_expression(value),
                "wx:elif" => directives.elif_expr = directive_expression(value),
                "wx:else" => directives.else_branch = true,
                "wx:for" => directives.for_expr = directive_expression(value),
                "wx:for-item" => directives.for_item = non_empty(value),
                "wx:for-index" => directives.for_index = non_empty(value),
                "wx:key" => directives.for_key = directive_key(value),
                name if is_event_attribute(name) => {
                    directives.events.insert(name.to_owned(), value.clone());
                }
                _ => {}
            }
        }
        directives
    }
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn directive_expression(value: &str) -> Option<String> {
    let value = value.trim();
    let value = value
        .strip_prefix("{{")
        .and_then(|value| value.strip_suffix("}}"))
        .unwrap_or(value)
        .trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// Normalize the value of `wx:key` while preserving the two forms accepted by
/// the WeChat template compiler: a property name (for object entries) and the
/// special `*this` marker (for primitive entries).  Mustache delimiters are
/// accepted as a convenience by some generated WXML even though the documented
/// form is unwrapped.
fn directive_key(value: &str) -> Option<String> {
    let value = value.trim();
    let value = value
        .strip_prefix("{{")
        .and_then(|value| value.strip_suffix("}}"))
        .map(str::trim)
        .unwrap_or(value);
    (!value.is_empty()).then(|| value.to_owned())
}

fn is_event_attribute(name: &str) -> bool {
    name.starts_with("bind")
        || name.starts_with("catch")
        || name.starts_with("capture-bind")
        || name.starts_with("capture-catch")
}

/// A parsed WXSS document.  Nested at-rules are represented by `nested`; this
/// retains media/supports/keyframes blocks without asking a host to parse CSS
/// again. Version 2 stores imports as empty-bodied at-rules at their source
/// position, including their original nesting; `imports` must be empty.
/// Legacy version 1 stores imports in a separate list and cannot recover their
/// source position or conditional context.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WxssIr {
    pub version: u32,
    pub imports: Vec<String>,
    pub rules: Vec<WxssRule>,
}

impl Default for WxssIr {
    fn default() -> Self {
        Self {
            version: WXSS_IR_VERSION,
            imports: Vec::new(),
            rules: Vec::new(),
        }
    }
}

impl WxssIr {
    /// Serialize with the same canonical JSON representation as the manifest
    /// packer.  The bytes are therefore suitable for SHA-256 content
    /// addressing without depending on struct field declaration order.
    pub fn canonical_json(&self) -> Result<Vec<u8>, MarkupError> {
        let value = serde_json::to_value(self).map_err(|error| MarkupError::InvalidSyntax {
            offset: 0,
            message: format!("cannot serialize WXSS IR: {error}"),
        })?;
        Ok(super::canonicalize_value(&value).into_bytes())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WxssRule {
    /// Normal style rules have one or more selectors.  At-rules leave this
    /// empty and carry their prelude in `at_rule`.
    pub selectors: Vec<String>,
    pub declarations: Vec<WxssDeclaration>,
    pub nested: Vec<WxssRule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_rule: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WxssDeclaration {
    pub property: String,
    pub value: String,
    pub important: bool,
}

/// A CSS/WXSS length with its original unit preserved until a host supplies a
/// viewport.  WXSS uses a 750 design-width `rpx` grid; keeping this conversion
/// out of the parser prevents device-specific values from leaking into the
/// portable IR.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WxssLengthUnit {
    Px,
    Rpx,
    Rem,
    Vw,
    Vh,
    Percent,
    Number,
    Auto,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WxssLength {
    pub value: f32,
    pub unit: WxssLengthUnit,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WxssLengthError {
    Empty,
    Invalid(String),
    Unsupported(String),
}

impl fmt::Display for WxssLengthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("WXSS length cannot be empty"),
            Self::Invalid(value) => write!(f, "invalid WXSS length: {value}"),
            Self::Unsupported(value) => write!(f, "unsupported WXSS length: {value}"),
        }
    }
}

impl std::error::Error for WxssLengthError {}

impl WxssLength {
    /// Convert a length to physical CSS pixels for the given viewport.
    pub fn to_px(
        self,
        viewport_width: f32,
        viewport_height: f32,
        root_font_size: f32,
    ) -> Option<f32> {
        if !viewport_width.is_finite()
            || !viewport_height.is_finite()
            || !root_font_size.is_finite()
        {
            return None;
        }
        Some(match self.unit {
            WxssLengthUnit::Px | WxssLengthUnit::Number => self.value,
            WxssLengthUnit::Rpx => self.value * viewport_width / 750.0,
            WxssLengthUnit::Rem => self.value * root_font_size,
            WxssLengthUnit::Vw => self.value * viewport_width / 100.0,
            WxssLengthUnit::Vh => self.value * viewport_height / 100.0,
            WxssLengthUnit::Percent => self.value * viewport_width / 100.0,
            WxssLengthUnit::Auto => return None,
        })
    }
}

/// Parse a WXSS single length token. Compound values such as `margin: 1px 2px`
/// remain lossless in [`WxssDeclaration::value`] and can be split by a host.
pub fn parse_wxss_length(source: &str) -> Result<WxssLength, WxssLengthError> {
    let source = source.trim();
    if source.is_empty() {
        return Err(WxssLengthError::Empty);
    }
    if source.eq_ignore_ascii_case("auto") {
        return Ok(WxssLength {
            value: 0.0,
            unit: WxssLengthUnit::Auto,
        });
    }
    let lower = source.to_ascii_lowercase();
    let (number, unit) = ["rpx", "rem", "px", "vw", "vh", "%"]
        .iter()
        .find_map(|unit| lower.strip_suffix(unit).map(|number| (number, *unit)))
        .unwrap_or((lower.as_str(), ""));
    let value = number
        .trim()
        .parse::<f32>()
        .map_err(|_| WxssLengthError::Invalid(source.to_owned()))?;
    if !value.is_finite() {
        return Err(WxssLengthError::Invalid(source.to_owned()));
    }
    let unit = match unit {
        "rpx" => WxssLengthUnit::Rpx,
        "rem" => WxssLengthUnit::Rem,
        "px" => WxssLengthUnit::Px,
        "vw" => WxssLengthUnit::Vw,
        "vh" => WxssLengthUnit::Vh,
        "%" => WxssLengthUnit::Percent,
        "" => WxssLengthUnit::Number,
        _ => return Err(WxssLengthError::Unsupported(source.to_owned())),
    };
    Ok(WxssLength { value, unit })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MarkupError {
    UnexpectedEof { context: &'static str },
    InvalidSyntax { offset: usize, message: String },
    MismatchedClosing { expected: String, actual: String },
    DuplicateAttribute(String),
    InvalidVersion { kind: &'static str, version: u32 },
}

impl fmt::Display for MarkupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnexpectedEof { context } => {
                write!(f, "unexpected end of input while parsing {context}")
            }
            Self::InvalidSyntax { offset, message } => {
                write!(f, "invalid markup at byte {offset}: {message}")
            }
            Self::MismatchedClosing { expected, actual } => {
                write!(
                    f,
                    "mismatched closing tag: expected </{expected}>, got </{actual}>"
                )
            }
            Self::DuplicateAttribute(name) => write!(f, "duplicate WXML attribute: {name}"),
            Self::InvalidVersion { kind, version } => {
                write!(f, "unsupported {kind} IR version {version}")
            }
        }
    }
}

impl std::error::Error for MarkupError {}

/// Parse WXML into a deterministic AST.
pub fn parse_wxml(source: &str) -> Result<WxmlAst, MarkupError> {
    let mut parser = WxmlParser::new(source);
    let nodes = parser.parse_nodes(None)?;
    if parser.pos < source.len() {
        return Err(MarkupError::InvalidSyntax {
            offset: parser.pos,
            message: "unexpected trailing markup".into(),
        });
    }
    Ok(WxmlAst {
        version: WXML_IR_VERSION,
        nodes,
    })
}

/// Parse WXSS into a deterministic selector/declaration IR.
pub fn parse_wxss(source: &str) -> Result<WxssIr, MarkupError> {
    // Match the packer's comment normalization before recording preludes.
    // Quoted comment markers remain literal string content.
    let source = strip_wxss_comments(source)?;
    let mut parser = CssParser::new(&source);
    parser.parse_document()
}

/// Decode and validate an AST blob emitted by the manifest packer.
pub fn decode_wxml(bytes: &[u8]) -> Result<WxmlAst, MarkupError> {
    let decode = || -> Result<WxmlAst, serde_json::Error> {
        let mut value: Value = serde_json::from_slice(bytes)?;
        if let Some(nodes) = value.get_mut("nodes").and_then(Value::as_array_mut) {
            normalize_legacy_wxml_directives(nodes)?;
        }
        serde_json::from_value(value)
    };
    let ast = decode().map_err(|error| MarkupError::InvalidSyntax {
        offset: 0,
        message: format!("invalid WXML IR JSON: {error}"),
    })?;
    if ast.version != WXML_IR_VERSION {
        return Err(MarkupError::InvalidVersion {
            kind: "WXML",
            version: ast.version,
        });
    }
    validate_wxml(&ast)?;
    Ok(ast)
}

/// Earlier v1 packers emitted source attributes without the optional
/// structured directive view. Normalize those source nodes at the wire
/// boundary, before validation. An explicit directive view and evaluated
/// nodes stay authoritative: rebuilding a cleared repeat from its retained
/// source attributes would expand it twice and lose its lexical scope.
fn normalize_legacy_wxml_directives(nodes: &mut [Value]) -> Result<(), serde_json::Error> {
    for node in nodes {
        let Some(object) = node.as_object_mut() else {
            continue;
        };
        if object.get("kind").and_then(Value::as_str) != Some("element") {
            continue;
        }
        let evaluated = [
            "sourceSite",
            "source_site",
            "key",
            "keyScope",
            "key_scope",
            "boundValues",
            "bound_values",
        ]
        .iter()
        .any(|field| object.get(*field).is_some_and(|value| !value.is_null()));
        if !object.contains_key("directives") && !evaluated {
            if let Some(attrs) = object.get("attrs") {
                let attrs = serde_json::from_value(attrs.clone())?;
                let directives = WxmlDirectives::from_attrs(&attrs);
                if !directives.is_empty() {
                    object.insert("directives".into(), serde_json::to_value(directives)?);
                }
            }
        }
        if let Some(children) = object.get_mut("children").and_then(Value::as_array_mut) {
            normalize_legacy_wxml_directives(children)?;
        }
    }
    Ok(())
}

/// Decode and validate a WXSS blob emitted by the manifest packer.
pub fn decode_wxss(bytes: &[u8]) -> Result<WxssIr, MarkupError> {
    let ir: WxssIr = serde_json::from_slice(bytes).map_err(|error| MarkupError::InvalidSyntax {
        offset: 0,
        message: format!("invalid WXSS IR JSON: {error}"),
    })?;
    validate_wxss(&ir)?;
    Ok(ir)
}

pub fn validate_wxml(ast: &WxmlAst) -> Result<(), MarkupError> {
    if ast.version != WXML_IR_VERSION {
        return Err(MarkupError::InvalidVersion {
            kind: "WXML",
            version: ast.version,
        });
    }
    fn visit(node: &WxmlNode) -> Result<(), MarkupError> {
        if let Some(origin) = node.lexical_origin() {
            WxmlLexicalOrigin::from_document(&origin.document_id)?;
        }
        match node {
            WxmlNode::Element {
                tag,
                attrs,
                bindings,
                directives,
                children,
                ..
            } => {
                if tag.is_empty() || tag.chars().any(char::is_whitespace) {
                    return Err(MarkupError::InvalidSyntax {
                        offset: 0,
                        message: "element tag must be non-empty and contain no whitespace".into(),
                    });
                }
                if attrs
                    .keys()
                    .any(|key| key.is_empty() || key.chars().any(char::is_whitespace))
                {
                    return Err(MarkupError::InvalidSyntax {
                        offset: 0,
                        message: "WXML attribute names must be non-empty and contain no whitespace"
                            .into(),
                    });
                }
                if has_duplicate_bindings(bindings) || bindings.iter().any(|value| value.is_empty())
                {
                    return Err(MarkupError::InvalidSyntax {
                        offset: 0,
                        message: "WXML bindings must be unique and non-empty".into(),
                    });
                }
                if directives.if_expr.is_some() && directives.elif_expr.is_some() {
                    return Err(MarkupError::InvalidSyntax {
                        offset: 0,
                        message: "WXML element cannot contain both wx:if and wx:elif".into(),
                    });
                }
                if directives.else_branch
                    && (directives.if_expr.is_some() || directives.elif_expr.is_some())
                {
                    return Err(MarkupError::InvalidSyntax {
                        offset: 0,
                        message: "wx:else cannot be combined with wx:if or wx:elif".into(),
                    });
                }
                if directives.for_item.is_some() && directives.for_expr.is_none() {
                    return Err(MarkupError::InvalidSyntax {
                        offset: 0,
                        message: "wx:for-item requires wx:for".into(),
                    });
                }
                if directives.for_index.is_some() && directives.for_expr.is_none() {
                    return Err(MarkupError::InvalidSyntax {
                        offset: 0,
                        message: "wx:for-index requires wx:for".into(),
                    });
                }
                children.iter().try_for_each(visit)
            }
            WxmlNode::Text {
                value: _, bindings, ..
            } => {
                if has_duplicate_bindings(bindings) || bindings.iter().any(|value| value.is_empty())
                {
                    return Err(MarkupError::InvalidSyntax {
                        offset: 0,
                        message: "WXML bindings must be unique and non-empty".into(),
                    });
                }
                Ok(())
            }
            WxmlNode::Comment { .. } => Ok(()),
        }
    }
    ast.nodes.iter().try_for_each(visit)
}

pub fn validate_wxss(ir: &WxssIr) -> Result<(), MarkupError> {
    if !matches!(ir.version, 1 | WXSS_IR_VERSION) {
        return Err(MarkupError::InvalidVersion {
            kind: "WXSS",
            version: ir.version,
        });
    }
    if ir.version == WXSS_IR_VERSION && !ir.imports.is_empty() {
        return Err(MarkupError::InvalidSyntax {
            offset: 0,
            message: "WXSS IR v2 requires source-ordered import rules, not the legacy imports list"
                .into(),
        });
    }
    fn visit(rule: &WxssRule, version: u32) -> Result<(), MarkupError> {
        if rule.at_rule.is_none() && rule.selectors.is_empty() {
            return Err(MarkupError::InvalidSyntax {
                offset: 0,
                message: "style rule must contain a selector".into(),
            });
        }
        if rule.at_rule.is_some() && !rule.selectors.is_empty() {
            return Err(MarkupError::InvalidSyntax {
                offset: 0,
                message: "at-rule cannot contain normal selectors".into(),
            });
        }
        if let Some(prelude) = &rule.at_rule {
            let Some(keyword) = wxss_at_keyword(prelude) else {
                return Err(MarkupError::InvalidSyntax {
                    offset: 0,
                    message: "at-rule requires a valid at-keyword".into(),
                });
            };
            if version == WXSS_IR_VERSION && keyword.eq_ignore_ascii_case("import") {
                if prelude[7..].trim().is_empty() {
                    return Err(MarkupError::InvalidSyntax {
                        offset: 0,
                        message: "WXSS @import requires a prelude".into(),
                    });
                }
                if !rule.declarations.is_empty() || !rule.nested.is_empty() {
                    return Err(MarkupError::InvalidSyntax {
                        offset: 0,
                        message: "WXSS @import cannot have a body".into(),
                    });
                }
            }
        }
        for selector in &rule.selectors {
            if selector.trim().is_empty() {
                return Err(MarkupError::InvalidSyntax {
                    offset: 0,
                    message: "selector must be non-empty".into(),
                });
            }
        }
        for declaration in &rule.declarations {
            if declaration.property.trim().is_empty() || declaration.value.trim().is_empty() {
                return Err(MarkupError::InvalidSyntax {
                    offset: 0,
                    message: "CSS declarations require property and value".into(),
                });
            }
        }
        rule.nested.iter().try_for_each(|rule| visit(rule, version))
    }
    ir.rules.iter().try_for_each(|rule| visit(rule, ir.version))
}

/// Match a simple WXSS selector against one render node identity. Compound
/// descendant and attribute selectors still require the ancestry-aware API;
/// positional pseudo-classes require render-tree metadata and therefore do
/// not match through this identity-only helper.
pub fn matches_wxss_selector(
    selector: &str,
    tag: Option<&str>,
    id: Option<&str>,
    classes: &[&str],
) -> bool {
    let node = WxssSelectorNode {
        tag: tag.map(str::to_owned),
        id: id.map(str::to_owned),
        classes: classes.iter().map(|class| (*class).to_owned()).collect(),
        child_index: None,
        sibling_count: None,
    };
    matches_wxss_compound_selector(selector, &node)
}

/// Match a simple selector against a node carrying positional information.
/// This is kept separate from [`matches_wxss_selector`] so existing callers
/// that only have tag/id/class identity retain the v1 API while renderers can
/// opt into structural pseudo-classes.
fn matches_wxss_compound_selector(selector: &str, node: &WxssSelectorNode) -> bool {
    let selector = selector.trim();
    if selector.is_empty()
        || selector.chars().any(|character| {
            character.is_whitespace() || matches!(character, '>' | '+' | '~' | '[' | ']' | ',')
        })
    {
        return false;
    }
    let bytes = selector.as_bytes();
    let mut index = 0;
    let mut expected_tag = None;
    if bytes
        .first()
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        let start = index;
        index += 1;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'-' | b'_'))
        {
            index += 1;
        }
        expected_tag = Some(&selector[start..index]);
    }
    let mut expected_id = None;
    let mut expected_classes = Vec::new();
    let mut pseudo_matches = Vec::new();
    while index < bytes.len() {
        let prefix = bytes[index];
        if prefix != b'#' && prefix != b'.' && prefix != b':' {
            return false;
        }
        index += 1;
        let start = index;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'-' | b'_' | b'@'))
        {
            index += 1;
        }
        if start == index {
            return false;
        }
        if prefix == b':' {
            let pseudo = &selector[start..index];
            let argument = if bytes.get(index) == Some(&b'(') {
                let Some(end) = find_selector_function_end(selector, index) else {
                    return false;
                };
                let argument = selector[index + 1..end].trim();
                index = end + 1;
                Some(argument)
            } else {
                None
            };
            pseudo_matches.push((pseudo, argument));
        } else if prefix == b'#' {
            if expected_id.replace(&selector[start..index]).is_some() {
                return false;
            }
        } else {
            expected_classes.push(&selector[start..index]);
        }
    }
    if !expected_tag.is_none_or(|expected| node.tag.as_deref() == Some(expected))
        || !expected_id.is_none_or(|expected| node.id.as_deref() == Some(expected))
        || !expected_classes
            .into_iter()
            .all(|expected| node.classes.iter().any(|class| class == expected))
    {
        return false;
    }
    pseudo_matches
        .into_iter()
        .all(|(pseudo, argument)| matches_wxss_pseudo(pseudo, argument, node))
}

fn find_selector_function_end(selector: &str, open: usize) -> Option<usize> {
    let bytes = selector.as_bytes();
    let mut depth = 1usize;
    let mut quote = None;
    let mut index = open + 1;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(current) = quote {
            if byte == b'\\' {
                index = index.saturating_add(2);
                continue;
            }
            if byte == current {
                quote = None;
            }
        } else if byte == b'\'' || byte == b'"' {
            quote = Some(byte);
        } else if byte == b'(' {
            depth += 1;
        } else if byte == b')' {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(index);
            }
        }
        index += 1;
    }
    None
}

fn matches_wxss_pseudo(pseudo: &str, argument: Option<&str>, node: &WxssSelectorNode) -> bool {
    let pseudo = pseudo.to_ascii_lowercase();
    if pseudo == "not" {
        return argument.is_some_and(|value| !matches_wxss_compound_selector(value, node));
    }
    let Some(index) = node.child_index else {
        // Positional matching requires a render-tree context. Callers that
        // only provide tag/id/classes keep the historical false result for
        // pseudo selectors instead of guessing from incomplete state.
        return false;
    };
    let siblings = node.sibling_count.unwrap_or(index);
    match pseudo.as_str() {
        "first-child" => argument.is_none() && index == 1,
        "last-child" => argument.is_none() && index == siblings,
        "only-child" => argument.is_none() && siblings == 1,
        "nth-child" => argument.is_some_and(|value| matches_nth_child(index, value)),
        _ => false,
    }
}

fn matches_nth_child(index: usize, expression: &str) -> bool {
    let expression = expression.trim().to_ascii_lowercase().replace(' ', "");
    if expression == "odd" {
        return index % 2 == 1;
    }
    if expression == "even" {
        return index.is_multiple_of(2);
    }
    if let Ok(value) = expression.parse::<isize>() {
        return value > 0 && index == value as usize;
    }
    let Some((a, b)) = expression.split_once('n') else {
        return false;
    };
    let coefficient = match a {
        "" | "+" => 1,
        "-" => -1,
        value => value.parse::<isize>().ok().unwrap_or(0),
    };
    let offset = if b.is_empty() {
        0
    } else {
        b.parse::<isize>().ok().unwrap_or(isize::MIN)
    };
    if coefficient == 0 || offset == isize::MIN {
        return false;
    }
    let index = index as isize;
    let delta = index - offset;
    if coefficient > 0 {
        delta >= 0 && delta % coefficient == 0
    } else {
        delta <= 0 && delta % coefficient == 0
    }
}

/// Identity used while resolving WXSS selectors against a rendered WXML path.
/// Keeping this separate from `RenderNode` lets the IR matcher stay independent
/// from any renderer or host representation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WxssSelectorNode {
    pub tag: Option<String>,
    pub id: Option<String>,
    pub classes: Vec<String>,
    /// One-based element position among the node's siblings. This is present
    /// only when the renderer has a concrete WXML parent context.
    pub child_index: Option<usize>,
    /// Number of element siblings in the same WXML parent.
    pub sibling_count: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WxssSelectorCombinator {
    Descendant,
    Child,
}

fn parse_wxss_selector_chain(selector: &str) -> Option<(Vec<String>, Vec<WxssSelectorCombinator>)> {
    let selector = selector.trim();
    if selector.is_empty() || selector.contains(',') {
        return None;
    }
    let chars: Vec<char> = selector.chars().collect();
    let mut compounds = Vec::new();
    let mut combinators = Vec::new();
    let mut pending = None;
    let mut index = 0;
    while index < chars.len() {
        let mut had_space = false;
        while index < chars.len() && chars[index].is_whitespace() {
            had_space = true;
            index += 1;
        }
        if index == chars.len() {
            break;
        }
        if chars[index] == '>' {
            if compounds.is_empty() || pending.is_some() {
                return None;
            }
            pending = Some(WxssSelectorCombinator::Child);
            index += 1;
            continue;
        }
        if !compounds.is_empty() {
            let relation = pending
                .take()
                .or_else(|| had_space.then_some(WxssSelectorCombinator::Descendant))?;
            combinators.push(relation);
        }
        let start = index;
        while index < chars.len() && !chars[index].is_whitespace() && chars[index] != '>' {
            index += 1;
        }
        if start == index {
            return None;
        }
        let compound: String = chars[start..index].iter().collect();
        compounds.push(compound);
    }
    (!compounds.is_empty() && pending.is_none() && combinators.len() + 1 == compounds.len())
        .then_some((compounds, combinators))
}

fn matches_wxss_chain_part(
    current: &WxssSelectorNode,
    ancestors: &[WxssSelectorNode],
    compounds: &[String],
    combinators: &[WxssSelectorCombinator],
    part: usize,
) -> bool {
    if !matches_wxss_compound_selector(&compounds[part], current) {
        return false;
    }
    if part == 0 {
        return true;
    }
    match combinators[part - 1] {
        WxssSelectorCombinator::Child => ancestors.last().is_some_and(|parent| {
            matches_wxss_chain_part(
                parent,
                &ancestors[..ancestors.len() - 1],
                compounds,
                combinators,
                part - 1,
            )
        }),
        WxssSelectorCombinator::Descendant => {
            ancestors.iter().enumerate().rev().any(|(index, ancestor)| {
                matches_wxss_chain_part(
                    ancestor,
                    &ancestors[..index],
                    compounds,
                    combinators,
                    part - 1,
                )
            })
        }
    }
}

/// Match a WXSS selector against a node and its root-to-parent ancestry.
/// Descendant and child combinators are supported while retaining the strict
/// simple-selector grammar used by the existing matcher.
pub fn matches_wxss_selector_with_ancestors(
    selector: &str,
    current: &WxssSelectorNode,
    ancestors: &[WxssSelectorNode],
) -> bool {
    let Some((compounds, combinators)) = parse_wxss_selector_chain(selector) else {
        return false;
    };
    matches_wxss_chain_part(
        current,
        ancestors,
        &compounds,
        &combinators,
        compounds.len() - 1,
    )
}

/// Resolve the declarations applicable to one element, applying WXSS cascade
/// order (important, specificity, then source order).  The returned map is
/// deterministic and contains the winning declaration for each property.
pub fn resolve_wxss_style(
    ir: &WxssIr,
    tag: Option<&str>,
    id: Option<&str>,
    classes: &[&str],
) -> BTreeMap<String, WxssDeclaration> {
    resolve_wxss_style_with_ancestors(ir, tag, id, classes, &[])
}

/// Resolve declarations for a node while applying descendant/child selectors
/// against the supplied root-to-parent ancestry.
pub fn resolve_wxss_style_with_ancestors(
    ir: &WxssIr,
    tag: Option<&str>,
    id: Option<&str>,
    classes: &[&str],
    ancestors: &[WxssSelectorNode],
) -> BTreeMap<String, WxssDeclaration> {
    let current = WxssSelectorNode {
        tag: tag.map(str::to_owned),
        id: id.map(str::to_owned),
        classes: classes.iter().map(|class| (*class).to_owned()).collect(),
        child_index: None,
        sibling_count: None,
    };
    resolve_wxss_style_for_node(ir, &current, ancestors)
}

/// Resolve declarations for a render node carrying positional selector
/// metadata. This powers structural pseudo-classes such as `:first-child`
/// while leaving the tag/id/class-only resolver API source-compatible.
pub fn resolve_wxss_style_for_node(
    ir: &WxssIr,
    current: &WxssSelectorNode,
    ancestors: &[WxssSelectorNode],
) -> BTreeMap<String, WxssDeclaration> {
    resolve_wxss_style_for_node_with_inline(ir, current, ancestors, &[])
}

/// Resolve stylesheet and inline declarations through a single cascade.
/// Author `!important` beats ordinary inline declarations; important inline
/// declarations beat important selector rules. Shorthands are expanded before
/// comparing candidates so source order also applies to their longhands.
pub fn resolve_wxss_style_for_node_with_inline(
    ir: &WxssIr,
    current: &WxssSelectorNode,
    ancestors: &[WxssSelectorNode],
    inline: &[WxssDeclaration],
) -> BTreeMap<String, WxssDeclaration> {
    type CascadeEntry = (bool, bool, (usize, usize, usize), usize, WxssDeclaration);
    let mut winners: BTreeMap<String, CascadeEntry> = BTreeMap::new();
    let mut order = 0usize;
    fn insert(
        winners: &mut BTreeMap<String, CascadeEntry>,
        declaration: &WxssDeclaration,
        inline: bool,
        specificity: (usize, usize, usize),
        order: usize,
    ) {
        for declaration in expand_render_shorthand(declaration) {
            let candidate = (declaration.important, inline, specificity, order);
            let replace = winners
                .get(&declaration.property)
                .is_none_or(|current| candidate > (current.0, current.1, current.2, current.3));
            if replace {
                winners.insert(
                    declaration.property.clone(),
                    (
                        candidate.0,
                        candidate.1,
                        candidate.2,
                        candidate.3,
                        declaration,
                    ),
                );
            }
        }
    }
    fn visit(
        rules: &[WxssRule],
        winners: &mut BTreeMap<String, CascadeEntry>,
        order: &mut usize,
        current: &WxssSelectorNode,
        ancestors: &[WxssSelectorNode],
    ) {
        for rule in rules {
            // Hosts evaluate conditional/import semantics before cascading.
            // Descending here would unconditionally apply false media blocks,
            // keyframe selectors and other non-style-rule children.
            if rule.at_rule.is_some() {
                continue;
            }
            if let Some(specificity) = rule
                .selectors
                .iter()
                .filter(|selector| {
                    matches_wxss_selector_with_ancestors(selector, current, ancestors)
                })
                .map(|selector| selector_specificity(selector))
                .max()
            {
                for declaration in &rule.declarations {
                    insert(winners, declaration, false, specificity, *order);
                    *order += 1;
                }
            }
            visit(&rule.nested, winners, order, current, ancestors);
        }
    }
    visit(&ir.rules, &mut winners, &mut order, current, ancestors);
    for declaration in inline {
        insert(&mut winners, declaration, true, (0, 0, 0), order);
        order += 1;
    }
    winners
        .into_iter()
        .map(|(property, (_, _, _, _, declaration))| (property, declaration))
        .collect()
}

// Expand only shorthands that the portable renderer understands. The original
// property remains available for computed-style inspection; layout consumes
// the independently cascaded longhands rather than imposing map-key order.
fn expand_render_shorthand(declaration: &WxssDeclaration) -> Vec<WxssDeclaration> {
    if let Some(expanded) = crate::layout_values::expand_layout_declaration(declaration) {
        return expanded;
    }
    if declaration.property == "font" {
        return expand_render_font(declaration).unwrap_or_default();
    }
    if let Some(expanded) = expand_render_border(declaration) {
        return expanded;
    }
    let mut result = vec![declaration.clone()];
    let mut add = |property: String, value: String| {
        result.push(WxssDeclaration {
            property,
            value,
            important: declaration.important,
        });
    };
    let expand_quad = |value: &str| -> Option<[String; 4]> {
        let values = value.split_whitespace().collect::<Vec<_>>();
        let [top, right, bottom, left] = match values.as_slice() {
            [a] => [*a, *a, *a, *a],
            [a, b] => [*a, *b, *a, *b],
            [a, b, c] => [*a, *b, *c, *b],
            [a, b, c, d] => [*a, *b, *c, *d],
            _ => return None,
        };
        Some([top.into(), right.into(), bottom.into(), left.into()])
    };
    match declaration.property.as_str() {
        "visibility" if crate::parse_wxss_visibility(&declaration.value).is_err() => {
            return Vec::new();
        }
        "opacity" if crate::parse_wxss_opacity(&declaration.value).is_err() => {
            return Vec::new();
        }
        "z-index" if crate::parse_wxss_z_index(&declaration.value).is_err() => {
            return Vec::new();
        }
        "isolation" if crate::parse_wxss_isolation(&declaration.value).is_err() => {
            return Vec::new();
        }
        "mix-blend-mode" | "contain" | "will-change" | "perspective"
            if crate::parse_wxss_stacking_effect(&declaration.property, &declaration.value)
                .is_err() =>
        {
            return Vec::new();
        }
        "transform" if crate::parse_wxss_transform(&declaration.value).is_err() => {
            return Vec::new();
        }
        "transform-origin" if crate::parse_wxss_transform_origin(&declaration.value).is_err() => {
            return Vec::new();
        }
        "font-size" if parse_wxss_font_size(&declaration.value).is_err() => {
            return Vec::new();
        }
        "line-height" if parse_wxss_line_height(&declaration.value).is_err() => {
            return Vec::new();
        }
        "white-space" if parse_wxss_white_space(&declaration.value).is_err() => {
            return Vec::new();
        }
        "word-break" if parse_wxss_word_break(&declaration.value).is_err() => {
            return Vec::new();
        }
        "text-align" if parse_wxss_text_align(&declaration.value).is_err() => {
            return Vec::new();
        }
        "direction" if parse_wxss_text_direction(&declaration.value).is_err() => {
            return Vec::new();
        }
        "unicode-bidi" if parse_wxss_unicode_bidi(&declaration.value).is_err() => {
            return Vec::new();
        }
        "color" => {
            let value = declaration.value.trim().to_ascii_lowercase();
            if !matches!(
                value.as_str(),
                "currentcolor" | "initial" | "inherit" | "unset"
            ) && parse_wxss_color(&value).is_none()
            {
                // Reject before cascade comparison. Otherwise a malformed
                // late color would erase a valid/inherited foreground and
                // make currentcolor borders silently fall back to black.
                return Vec::new();
            }
        }
        "box-sizing" => {
            let value = declaration.value.trim().to_ascii_lowercase();
            if !matches!(
                value.as_str(),
                "content-box" | "border-box" | "initial" | "inherit" | "unset"
            ) {
                return Vec::new();
            }
            return vec![WxssDeclaration {
                value,
                ..declaration.clone()
            }];
        }
        "overflow" => {
            let values = declaration
                .value
                .split_ascii_whitespace()
                .map(str::to_ascii_lowercase)
                .collect::<Vec<_>>();
            let (x, y) = match values.as_slice() {
                [value] => (value, value),
                [x, y] => (x, y),
                _ => return Vec::new(),
            };
            if ![x, y].iter().all(|value| {
                matches!(
                    value.as_str(),
                    "visible" | "hidden" | "clip" | "scroll" | "auto"
                )
            }) {
                return Vec::new();
            }
            // Expand before cascade comparison: a later/important shorthand
            // must be able to replace an earlier ordinary axis declaration.
            add("overflow-x".into(), x.clone());
            add("overflow-y".into(), y.clone());
        }
        "overflow-x" | "overflow-y" => {
            if !matches!(
                declaration.value.trim().to_ascii_lowercase().as_str(),
                "visible" | "hidden" | "clip" | "scroll" | "auto"
            ) {
                return Vec::new();
            }
        }
        "margin" | "padding" => {
            if let Some(values) = expand_quad(&declaration.value).filter(|values| {
                values.iter().all(|value| {
                    parse_wxss_length(value)
                        .is_ok_and(|length| declaration.property == "margin" || length.value >= 0.0)
                })
            }) {
                for (edge, value) in ["top", "right", "bottom", "left"].into_iter().zip(values) {
                    add(format!("{}-{edge}", declaration.property), value);
                }
            } else {
                return Vec::new();
            }
        }
        "border-radius" => {
            let mut axes = declaration.value.split('/');
            if let Some(horizontal) = axes.next().and_then(expand_quad) {
                let vertical = match axes.next() {
                    Some(axis) => match expand_quad(axis) {
                        Some(values) => values,
                        None => return Vec::new(),
                    },
                    None => horizontal.clone(),
                };
                if axes.next().is_none()
                    && horizontal.iter().chain(&vertical).all(|value| {
                        parse_wxss_length(value).is_ok_and(|length| length.value >= 0.0)
                    })
                {
                    for (index, corner) in ["top-left", "top-right", "bottom-right", "bottom-left"]
                        .into_iter()
                        .enumerate()
                    {
                        add(
                            format!("border-{corner}-radius"),
                            format!("{} {}", horizontal[index], vertical[index]),
                        );
                    }
                } else {
                    return Vec::new();
                }
            } else {
                return Vec::new();
            }
        }
        "background" if parse_wxss_color(&declaration.value).is_some() => {
            add("background-color".into(), declaration.value.clone())
        }
        _ => {}
    }
    result
}

// Retain the original shorthand so runtimes can explicitly reject the still
// unsupported font-family/style/weight semantics. Valid shorthands nevertheless
// reset and compete with their longhands; invalid ones never enter the cascade.
fn expand_render_font(declaration: &WxssDeclaration) -> Option<Vec<WxssDeclaration>> {
    use crate::text_values::{css_identifier, top_level_arguments};
    const RESET: [(&str, &str); 13] = [
        ("font-style", "normal"),
        ("font-variant", "normal"),
        ("font-weight", "normal"),
        ("font-stretch", "normal"),
        ("font-size", "medium"),
        ("line-height", "normal"),
        ("font-family", "serif"),
        ("font-size-adjust", "none"),
        ("font-kerning", "auto"),
        ("font-optical-sizing", "auto"),
        ("font-feature-settings", "normal"),
        ("font-variation-settings", "normal"),
        ("font-language-override", "normal"),
    ];
    let value = declaration.value.trim();
    let lower = value.to_ascii_lowercase();
    let mut longhands: BTreeMap<&str, String> = RESET
        .into_iter()
        .map(|(key, value)| (key, value.into()))
        .collect();
    if matches!(
        lower.as_str(),
        "initial" | "inherit" | "unset" | "revert" | "revert-layer"
    ) {
        for value in longhands.values_mut() {
            *value = lower.clone();
        }
    } else if matches!(
        lower.as_str(),
        "caption" | "icon" | "menu" | "message-box" | "small-caption" | "status-bar"
    ) {
        // A system font requires host font selection. Do not fabricate its
        // size or family; the retained `font` declaration forces an explicit
        // unsupported result until that host-dependent operation exists.
        return Some(vec![declaration.clone()]);
    } else {
        let mut tokens = Vec::new();
        for token in split_wxss_value(value)? {
            let mut start = 0;
            let mut depth = 0usize;
            let mut quote = None;
            let mut escaped = false;
            for (index, character) in token.char_indices() {
                if escaped {
                    escaped = false;
                    continue;
                }
                if character == '\\' {
                    escaped = true;
                    continue;
                }
                if let Some(expected) = quote {
                    if character == expected {
                        quote = None;
                    }
                    continue;
                }
                match character {
                    '\'' | '"' => quote = Some(character),
                    '(' | '[' => depth += 1,
                    ')' | ']' => depth = depth.checked_sub(1)?,
                    '/' if depth == 0 => {
                        if start < index {
                            tokens.push(&token[start..index]);
                        }
                        tokens.push(&token[index..index + 1]);
                        start = index + 1;
                    }
                    _ => {}
                }
            }
            if start < token.len() {
                tokens.push(&token[start..]);
            }
        }
        let mut unresolved = false;
        for token in &tokens {
            match crate::text_values::font_substitution(token) {
                Some(true) => unresolved = true,
                Some(false) => return None,
                None => {}
            }
        }
        if unresolved {
            return Some(vec![declaration.clone()]);
        }
        let mut index = 0;
        let mut used = BTreeSet::new();
        let mut normals = 0;
        loop {
            let token = *tokens.get(index)?;
            let lower = token.to_ascii_lowercase();
            if !matches!(
                lower.as_str(),
                "initial" | "inherit" | "unset" | "revert" | "revert-layer"
            ) && parse_wxss_font_size(token).is_ok()
            {
                longhands.insert("font-size", token.into());
                index += 1;
                break;
            }
            let property = match lower.as_str() {
                "normal" => {
                    normals += 1;
                    if normals > 4 {
                        return None;
                    }
                    index += 1;
                    continue;
                }
                "italic" | "oblique" => "font-style",
                "small-caps" => "font-variant",
                "bold" | "bolder" | "lighter" => "font-weight",
                "ultra-condensed" | "extra-condensed" | "condensed" | "semi-condensed"
                | "semi-expanded" | "expanded" | "extra-expanded" | "ultra-expanded" => {
                    "font-stretch"
                }
                _ if matches!(
                    parse_wxss_line_height(token),
                    Ok(crate::WxssLineHeight::Number(_))
                ) && token.parse::<f64>().ok().is_some_and(|number| {
                    number.is_finite() && (1.0..=1000.0).contains(&number)
                }) =>
                {
                    "font-weight"
                }
                _ => return None,
            };
            if !used.insert(property) || used.len() + normals > 4 {
                return None;
            }
            longhands.insert(property, token.into());
            index += 1;
            if lower == "oblique" {
                if let Some(angle) = tokens.get(index) {
                    let lower = angle.to_ascii_lowercase();
                    if let Some((number, scale)) = [
                        ("deg", 1.0),
                        ("grad", 0.9),
                        ("rad", 180.0 / std::f64::consts::PI),
                        ("turn", 360.0),
                    ]
                    .into_iter()
                    .find_map(|(unit, scale)| {
                        lower.strip_suffix(unit).map(|number| (number, scale))
                    }) {
                        let unsigned = number.strip_prefix('-').unwrap_or(number);
                        if !matches!(
                            parse_wxss_line_height(unsigned),
                            Ok(crate::WxssLineHeight::Number(_))
                        ) {
                            return None;
                        }
                        let number = number.parse::<f64>().ok()? * scale;
                        if !number.is_finite() || !(-90.0..=90.0).contains(&number) {
                            return None;
                        }
                        longhands.insert("font-style", format!("oblique {angle}"));
                        index += 1;
                    }
                }
            }
        }
        if tokens.get(index) == Some(&"/") {
            let line_height = *tokens.get(index + 1)?;
            if parse_wxss_line_height(line_height).is_err()
                || matches!(
                    line_height.to_ascii_lowercase().as_str(),
                    "initial" | "inherit" | "unset" | "revert" | "revert-layer"
                )
            {
                return None;
            }
            longhands.insert("line-height", line_height.into());
            index += 2;
        }
        let family = tokens.get(index..)?.join(" ");
        if family.is_empty() {
            return None;
        }
        for family in top_level_arguments(&family)? {
            let names = split_wxss_value(family)?;
            if names.is_empty() {
                return None;
            }
            if names.len() == 1 && (names[0].starts_with('\'') || names[0].starts_with('"')) {
                let quoted = names[0];
                let expected = quoted.chars().next()?;
                let mut escaped = false;
                let mut closed = false;
                for (index, character) in quoted.char_indices().skip(1) {
                    if escaped {
                        escaped = false;
                        continue;
                    }
                    if character == '\\' {
                        escaped = true;
                        continue;
                    }
                    if character == expected {
                        if index + character.len_utf8() != quoted.len() {
                            return None;
                        }
                        closed = true;
                        break;
                    }
                    if matches!(character, '\n' | '\r' | '\u{c}') {
                        return None;
                    }
                }
                if !closed {
                    return None;
                }
                continue;
            }
            if names.iter().any(|name| {
                !css_identifier(name)
                    || matches!(
                        name.to_ascii_lowercase().as_str(),
                        "initial" | "inherit" | "unset" | "revert" | "revert-layer" | "default"
                    )
            }) {
                return None;
            }
        }
        longhands.insert("font-family", family);
    }
    let mut result = vec![declaration.clone()];
    result.extend(
        longhands
            .into_iter()
            .map(|(property, value)| WxssDeclaration {
                property: property.into(),
                value,
                important: declaration.important,
            }),
    );
    Some(result)
}

/// Split a declaration value only at top-level CSS whitespace. Function
/// arguments, quoted strings and escaped whitespace stay in one token. This
/// operates after declaration parsing has replaced comments with whitespace.
fn split_wxss_value(value: &str) -> Option<Vec<&str>> {
    let mut tokens = Vec::new();
    let mut start = None;
    let mut quote = None;
    let mut escaped = false;
    let mut delimiters = Vec::new();
    for (index, character) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            start.get_or_insert(index);
            escaped = true;
            continue;
        }
        if let Some(current) = quote {
            if character == current {
                quote = None;
            }
            continue;
        }
        if matches!(character, ' ' | '\t' | '\n' | '\r' | '\u{000c}') && delimiters.is_empty() {
            if let Some(start) = start.take() {
                tokens.push(&value[start..index]);
            }
            continue;
        }
        start.get_or_insert(index);
        match character {
            '\'' | '"' => quote = Some(character),
            '(' => delimiters.push(')'),
            '[' => delimiters.push(']'),
            '{' => delimiters.push('}'),
            ')' | ']' | '}' if delimiters.pop() != Some(character) => return None,
            _ => {}
        }
    }
    if escaped || quote.is_some() || !delimiters.is_empty() {
        return None;
    }
    if let Some(start) = start {
        tokens.push(&value[start..]);
    }
    Some(tokens)
}

fn border_width(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    match lower.as_str() {
        "thin" => Some("1px".into()),
        "medium" => Some("3px".into()),
        "thick" => Some("5px".into()),
        _ => {
            let length = parse_wxss_length(value).ok()?;
            let number = ["rpx", "rem", "px", "vw", "vh"]
                .iter()
                .find_map(|unit| lower.strip_suffix(unit))
                .unwrap_or(&lower);
            parse_css_number(number)?;
            if length.value < 0.0
                || matches!(length.unit, WxssLengthUnit::Auto | WxssLengthUnit::Percent)
                || (length.unit == WxssLengthUnit::Number && length.value != 0.0)
                || split_wxss_value(value)?.len() != 1
            {
                return None;
            }
            Some(lower)
        }
    }
}

fn border_style(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "none"
            | "hidden"
            | "solid"
            | "dotted"
            | "dashed"
            | "double"
            | "groove"
            | "ridge"
            | "inset"
            | "outset"
    )
    .then_some(lower)
}

fn border_color(value: &str) -> Option<String> {
    if value.eq_ignore_ascii_case("currentcolor") {
        Some("currentcolor".into())
    } else {
        parse_wxss_color(value).map(|_| value.to_owned())
    }
}

/// Border declarations are validated as a unit before entering the cascade.
/// A malformed late shorthand cannot erase a previously valid longhand. All
/// standard border styles are retained; unsupported painting styles must be
/// rejected by a renderer rather than silently becoming solid borders.
fn expand_render_border(declaration: &WxssDeclaration) -> Option<Vec<WxssDeclaration>> {
    const EDGES: [&str; 4] = ["top", "right", "bottom", "left"];
    const COMPONENTS: [&str; 3] = ["width", "style", "color"];
    #[derive(Clone, Copy)]
    enum Kind<'a> {
        All,
        Edge(&'a str),
        Quad(&'a str),
        Longhand(&'a str, &'a str),
    }
    let kind = match declaration.property.as_str() {
        "border" => Kind::All,
        "border-top" => Kind::Edge("top"),
        "border-right" => Kind::Edge("right"),
        "border-bottom" => Kind::Edge("bottom"),
        "border-left" => Kind::Edge("left"),
        "border-width" => Kind::Quad("width"),
        "border-style" => Kind::Quad("style"),
        "border-color" => Kind::Quad("color"),
        property => {
            let tail = property.strip_prefix("border-")?;
            let (edge, component) = tail.split_once('-')?;
            if !EDGES.contains(&edge) || !COMPONENTS.contains(&component) {
                return None;
            }
            Kind::Longhand(edge, component)
        }
    };
    let Some(tokens) = split_wxss_value(&declaration.value) else {
        return Some(Vec::new());
    };
    let global = if let [value] = tokens.as_slice() {
        let lower = value.to_ascii_lowercase();
        matches!(lower.as_str(), "initial" | "inherit" | "unset").then_some(lower)
    } else {
        None
    };
    let normalize = |component: &str, value: &str| match component {
        "width" => border_width(value),
        "style" => border_style(value),
        "color" => border_color(value),
        _ => unreachable!(),
    };
    let emit = |edge: &str, component: &str, value: String| WxssDeclaration {
        property: format!("border-{edge}-{component}"),
        value,
        important: declaration.important,
    };
    if let Kind::Longhand(edge, component) = kind {
        let value = global.or_else(|| match tokens.as_slice() {
            [value] => normalize(component, value),
            _ => None,
        });
        return Some(
            value
                .map(|value| vec![emit(edge, component, value)])
                .unwrap_or_default(),
        );
    }
    let mut result = vec![declaration.clone()];
    if let Kind::Quad(component) = kind {
        let values = if let Some(global) = global {
            [global.clone(), global.clone(), global.clone(), global]
        } else {
            let Some(values) = tokens
                .iter()
                .map(|value| normalize(component, value))
                .collect::<Option<Vec<_>>>()
            else {
                return Some(Vec::new());
            };
            match values.as_slice() {
                [a] => [a.clone(), a.clone(), a.clone(), a.clone()],
                [a, b] => [a.clone(), b.clone(), a.clone(), b.clone()],
                [a, b, c] => [a.clone(), b.clone(), c.clone(), b.clone()],
                [a, b, c, d] => [a.clone(), b.clone(), c.clone(), d.clone()],
                _ => return Some(Vec::new()),
            }
        };
        result.extend(
            EDGES
                .into_iter()
                .zip(values)
                .map(|(edge, value)| emit(edge, component, value)),
        );
        return Some(result);
    }
    let values = if let Some(global) = global {
        [global.clone(), global.clone(), global]
    } else {
        if tokens.is_empty() || tokens.len() > 3 {
            return Some(Vec::new());
        }
        let mut values: [Option<String>; 3] = [None, None, None];
        for token in tokens {
            let Some((index, value)) =
                COMPONENTS
                    .iter()
                    .enumerate()
                    .find_map(|(index, component)| {
                        normalize(component, token).map(|value| (index, value))
                    })
            else {
                return Some(Vec::new());
            };
            if values[index].replace(value).is_some() {
                return Some(Vec::new());
            }
        }
        let [width, style, color] = values;
        [
            width.unwrap_or_else(|| "3px".into()),
            style.unwrap_or_else(|| "none".into()),
            color.unwrap_or_else(|| "currentcolor".into()),
        ]
    };
    for edge in EDGES {
        if matches!(kind, Kind::Edge(selected) if selected != edge) {
            continue;
        }
        result.extend(
            COMPONENTS
                .into_iter()
                .zip(&values)
                .map(|(component, value)| emit(edge, component, value.clone())),
        );
    }
    Some(result)
}

/// Parse named, hexadecimal and RGB/RGBA colors shared by cascade and painting.
/// `currentcolor` needs the element's computed foreground and is deliberately
/// resolved later. Other CSS color spaces and complex backgrounds require
/// separate renderer capabilities.
pub fn parse_wxss_color(value: &str) -> Option<[u8; 4]> {
    let value = value.trim().to_ascii_lowercase();
    if value == "transparent" {
        return Some([0, 0, 0, 0]);
    }
    if let Some(rgb) = named_wxss_color(&value) {
        return Some([(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8, 255]);
    }
    if let Some(hex) = value.strip_prefix('#') {
        if !hex.is_ascii() || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let bytes = hex.as_bytes();
        return match bytes.len() {
            3 | 4 => {
                let component = |index| {
                    (bytes[index] as char)
                        .to_digit(16)
                        .map(|digit| digit as u8 * 17)
                };
                Some([
                    component(0)?,
                    component(1)?,
                    component(2)?,
                    if bytes.len() == 4 { component(3)? } else { 255 },
                ])
            }
            6 | 8 => {
                let component = |start| u8::from_str_radix(&hex[start..start + 2], 16).ok();
                Some([
                    component(0)?,
                    component(2)?,
                    component(4)?,
                    if bytes.len() == 8 { component(6)? } else { 255 },
                ])
            }
            _ => None,
        };
    }
    parse_wxss_rgb_function(&value)
}

fn parse_css_number(value: &str) -> Option<f32> {
    let bytes = value.as_bytes();
    let mut cursor = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let integer_start = cursor;
    while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
        cursor += 1;
    }
    let mut digits = cursor - integer_start;
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let fraction_start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == fraction_start {
            return None;
        }
        digits += cursor - fraction_start;
    }
    if digits == 0 {
        return None;
    }
    if matches!(bytes.get(cursor), Some(b'e' | b'E')) {
        cursor += 1;
        if matches!(bytes.get(cursor), Some(b'+' | b'-')) {
            cursor += 1;
        }
        let exponent_start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == exponent_start {
            return None;
        }
    }
    if cursor != bytes.len() {
        return None;
    }
    value.parse::<f32>().ok().filter(|value| value.is_finite())
}

fn parse_wxss_rgb_function(value: &str) -> Option<[u8; 4]> {
    let args = value
        .strip_prefix("rgb(")
        .or_else(|| value.strip_prefix("rgba("))?
        .strip_suffix(')')?;
    let channel = |value: &str| {
        let (number, percent) = value
            .strip_suffix('%')
            .map(|number| (number, true))
            .unwrap_or((value, false));
        let number = parse_css_number(number)?;
        Some(if percent {
            (number.clamp(0.0, 100.0) * 255.0 / 100.0).round() as u8
        } else {
            number.clamp(0.0, 255.0).round() as u8
        })
    };
    let alpha = |value: &str| {
        let (number, scale) = value
            .strip_suffix('%')
            .map(|number| (number, 100.0))
            .unwrap_or((value, 1.0));
        Some((parse_css_number(number)?.clamp(0.0, scale) * 255.0 / scale).round() as u8)
    };
    let (channels, opacity) = if args.contains(',') {
        let values = args.split(',').map(str::trim).collect::<Vec<_>>();
        if !(3..=4).contains(&values.len())
            || !values[..3]
                .iter()
                .all(|value| value.ends_with('%') == values[0].ends_with('%'))
        {
            return None;
        }
        (
            [values[0], values[1], values[2]],
            match values.get(3) {
                Some(value) => Some(alpha(value)?),
                None => None,
            },
        )
    } else {
        let mut parts = args.split('/');
        let values = parts.next()?.split_ascii_whitespace().collect::<Vec<_>>();
        if values.len() != 3 {
            return None;
        }
        let opacity = match parts.next() {
            Some(value) => Some(alpha(value.trim())?),
            None => None,
        };
        if parts.next().is_some() {
            return None;
        }
        ([values[0], values[1], values[2]], opacity)
    };
    Some([
        channel(channels[0])?,
        channel(channels[1])?,
        channel(channels[2])?,
        opacity.unwrap_or(255),
    ])
}

fn named_wxss_color(value: &str) -> Option<u32> {
    Some(match value {
        "aliceblue" => 0xf0f8ff,
        "antiquewhite" => 0xfaebd7,
        "aqua" | "cyan" => 0x00ffff,
        "aquamarine" => 0x7fffd4,
        "azure" => 0xf0ffff,
        "beige" => 0xf5f5dc,
        "bisque" => 0xffe4c4,
        "black" => 0x000000,
        "blanchedalmond" => 0xffebcd,
        "blue" => 0x0000ff,
        "blueviolet" => 0x8a2be2,
        "brown" => 0xa52a2a,
        "burlywood" => 0xdeb887,
        "cadetblue" => 0x5f9ea0,
        "chartreuse" => 0x7fff00,
        "chocolate" => 0xd2691e,
        "coral" => 0xff7f50,
        "cornflowerblue" => 0x6495ed,
        "cornsilk" => 0xfff8dc,
        "crimson" => 0xdc143c,
        "darkblue" => 0x00008b,
        "darkcyan" => 0x008b8b,
        "darkgoldenrod" => 0xb8860b,
        "darkgray" | "darkgrey" => 0xa9a9a9,
        "darkgreen" => 0x006400,
        "darkkhaki" => 0xbdb76b,
        "darkmagenta" => 0x8b008b,
        "darkolivegreen" => 0x556b2f,
        "darkorange" => 0xff8c00,
        "darkorchid" => 0x9932cc,
        "darkred" => 0x8b0000,
        "darksalmon" => 0xe9967a,
        "darkseagreen" => 0x8fbc8f,
        "darkslateblue" => 0x483d8b,
        "darkslategray" | "darkslategrey" => 0x2f4f4f,
        "darkturquoise" => 0x00ced1,
        "darkviolet" => 0x9400d3,
        "deeppink" => 0xff1493,
        "deepskyblue" => 0x00bfff,
        "dimgray" | "dimgrey" => 0x696969,
        "dodgerblue" => 0x1e90ff,
        "firebrick" => 0xb22222,
        "floralwhite" => 0xfffaf0,
        "forestgreen" => 0x228b22,
        "fuchsia" | "magenta" => 0xff00ff,
        "gainsboro" => 0xdcdcdc,
        "ghostwhite" => 0xf8f8ff,
        "gold" => 0xffd700,
        "goldenrod" => 0xdaa520,
        "gray" | "grey" => 0x808080,
        "green" => 0x008000,
        "greenyellow" => 0xadff2f,
        "honeydew" => 0xf0fff0,
        "hotpink" => 0xff69b4,
        "indianred" => 0xcd5c5c,
        "indigo" => 0x4b0082,
        "ivory" => 0xfffff0,
        "khaki" => 0xf0e68c,
        "lavender" => 0xe6e6fa,
        "lavenderblush" => 0xfff0f5,
        "lawngreen" => 0x7cfc00,
        "lemonchiffon" => 0xfffacd,
        "lightblue" => 0xadd8e6,
        "lightcoral" => 0xf08080,
        "lightcyan" => 0xe0ffff,
        "lightgoldenrodyellow" => 0xfafad2,
        "lightgray" | "lightgrey" => 0xd3d3d3,
        "lightgreen" => 0x90ee90,
        "lightpink" => 0xffb6c1,
        "lightsalmon" => 0xffa07a,
        "lightseagreen" => 0x20b2aa,
        "lightskyblue" => 0x87cefa,
        "lightslategray" | "lightslategrey" => 0x778899,
        "lightsteelblue" => 0xb0c4de,
        "lightyellow" => 0xffffe0,
        "lime" => 0x00ff00,
        "limegreen" => 0x32cd32,
        "linen" => 0xfaf0e6,
        "maroon" => 0x800000,
        "mediumaquamarine" => 0x66cdaa,
        "mediumblue" => 0x0000cd,
        "mediumorchid" => 0xba55d3,
        "mediumpurple" => 0x9370db,
        "mediumseagreen" => 0x3cb371,
        "mediumslateblue" => 0x7b68ee,
        "mediumspringgreen" => 0x00fa9a,
        "mediumturquoise" => 0x48d1cc,
        "mediumvioletred" => 0xc71585,
        "midnightblue" => 0x191970,
        "mintcream" => 0xf5fffa,
        "mistyrose" => 0xffe4e1,
        "moccasin" => 0xffe4b5,
        "navajowhite" => 0xffdead,
        "navy" => 0x000080,
        "oldlace" => 0xfdf5e6,
        "olive" => 0x808000,
        "olivedrab" => 0x6b8e23,
        "orange" => 0xffa500,
        "orangered" => 0xff4500,
        "orchid" => 0xda70d6,
        "palegoldenrod" => 0xeee8aa,
        "palegreen" => 0x98fb98,
        "paleturquoise" => 0xafeeee,
        "palevioletred" => 0xdb7093,
        "papayawhip" => 0xffefd5,
        "peachpuff" => 0xffdab9,
        "peru" => 0xcd853f,
        "pink" => 0xffc0cb,
        "plum" => 0xdda0dd,
        "powderblue" => 0xb0e0e6,
        "purple" => 0x800080,
        "rebeccapurple" => 0x663399,
        "red" => 0xff0000,
        "rosybrown" => 0xbc8f8f,
        "royalblue" => 0x4169e1,
        "saddlebrown" => 0x8b4513,
        "salmon" => 0xfa8072,
        "sandybrown" => 0xf4a460,
        "seagreen" => 0x2e8b57,
        "seashell" => 0xfff5ee,
        "sienna" => 0xa0522d,
        "silver" => 0xc0c0c0,
        "skyblue" => 0x87ceeb,
        "slateblue" => 0x6a5acd,
        "slategray" | "slategrey" => 0x708090,
        "snow" => 0xfffafa,
        "springgreen" => 0x00ff7f,
        "steelblue" => 0x4682b4,
        "tan" => 0xd2b48c,
        "teal" => 0x008080,
        "thistle" => 0xd8bfd8,
        "tomato" => 0xff6347,
        "turquoise" => 0x40e0d0,
        "violet" => 0xee82ee,
        "wheat" => 0xf5deb3,
        "white" => 0xffffff,
        "whitesmoke" => 0xf5f5f5,
        "yellow" => 0xffff00,
        "yellowgreen" => 0x9acd32,
        _ => return None,
    })
}

fn selector_specificity(selector: &str) -> (usize, usize, usize) {
    let mut ids = 0;
    let mut classes = 0;
    let mut tags = 0;
    let bytes = selector.as_bytes();
    let mut index = 0;
    if bytes
        .first()
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        tags = 1;
        index += 1;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'-' | b'_'))
        {
            index += 1;
        }
    }
    while index < bytes.len() {
        match bytes[index] {
            b'#' => ids += 1,
            b'.' | b':' => classes += 1,
            _ => {}
        }
        index += 1;
    }
    (ids, classes, tags)
}

pub fn wxml_bindings(ast: &WxmlAst) -> Vec<String> {
    let mut bindings = std::collections::BTreeSet::new();
    fn visit(node: &WxmlNode, output: &mut std::collections::BTreeSet<String>) {
        match node {
            WxmlNode::Element {
                bindings, children, ..
            } => {
                output.extend(bindings.iter().cloned());
                children.iter().for_each(|child| visit(child, output));
            }
            WxmlNode::Text { bindings, .. } => output.extend(bindings.iter().cloned()),
            WxmlNode::Comment { .. } => {}
        }
    }
    ast.nodes.iter().for_each(|node| visit(node, &mut bindings));
    bindings.into_iter().collect()
}

/// Expand WXML control-flow directives against a JSON data snapshot.
///
/// This is intentionally a deterministic, host-independent evaluator for the
/// expression subset used by WXML bindings (`foo.bar`, literals, `!`, `&&`,
/// `||`, and equality comparisons).  A JavaScript engine remains responsible
/// for arbitrary page expressions; the helper is useful for pre-rendering,
/// golden tests and hosts that already have a serialized data patch.
pub fn evaluate_wxml(ast: &WxmlAst, data: &Value) -> Result<WxmlAst, MarkupError> {
    validate_wxml(ast)?;
    let context = EvaluationContext::new(data);
    let nodes = evaluate_nodes(&ast.nodes, &context, None, "root", false)?;
    Ok(WxmlAst {
        version: ast.version,
        nodes,
    })
}

/// Evaluate a WXML document and resolve the portable subset of `include` and
/// `template` references. The map accepts either a manifest id
/// (`template:pages/a.wxml`) or its package-relative path (`pages/a.wxml`).
/// Definitions are collected before expansion so a template may be declared
/// after its use. Cycles are rejected with a deterministic syntax error.
pub fn evaluate_wxml_with_templates(
    ast: &WxmlAst,
    data: &Value,
    templates: &BTreeMap<String, WxmlAst>,
) -> Result<WxmlAst, MarkupError> {
    evaluate_wxml_with_templates_from_source(ast, data, templates, None)
}

/// Evaluate a WXML document while identifying the package path of its source
/// file.  This is required for a manifest-backed page or component whose root
/// document contains a relative `<import>`/`<include>`; callers that only have
/// an in-memory fragment can use [`evaluate_wxml_with_templates`] instead.
pub fn evaluate_wxml_with_templates_from_source(
    ast: &WxmlAst,
    data: &Value,
    templates: &BTreeMap<String, WxmlAst>,
    source_path: Option<&str>,
) -> Result<WxmlAst, MarkupError> {
    evaluate_wxml_with_templates_and_provenance(ast, data, templates, source_path)
        .map(|result| result.ast)
}

/// Evaluate once and retain exact data dependencies separately from the AST.
/// The sidecar contains no owner tokens or mutation stamps. Source metadata
/// cannot supply it; only this evaluator constructs the result.
pub fn evaluate_wxml_with_templates_and_provenance(
    ast: &WxmlAst,
    data: &Value,
    templates: &BTreeMap<String, WxmlAst>,
    source_path: Option<&str>,
) -> Result<EvaluatedWxml, MarkupError> {
    if let Some(source) = source_path {
        WxmlLexicalOrigin::from_document(source)?;
        validate_wxml_document_origin(ast, source)?;
    }
    validate_wxml(ast)?;
    for (document, template) in templates {
        validate_wxml(template)?;
        validate_wxml_document_origin(template, &normalize_template_source(document))?;
    }
    // Imports are declarations rather than renderable nodes.  Validate the
    // complete import graph before expansion so a missing target or a cycle
    // is reported even when the imported file only contributes a template
    // that is not invoked by this particular data snapshot.
    validate_import_graph(&ast.nodes, templates, source_path, &mut Vec::new())?;
    let context = EvaluationContext::new(data);
    // Template names are file-scoped in WXML.  A page can use definitions in
    // its own document and in documents reachable through an explicit
    // `<import>` (or a textual `<include>`), but an unrelated manifest blob
    // must not accidentally make a name visible.  The old implementation
    // collected definitions from every entry in `templates`, which made a
    // missing import look like a successful render and diverged from
    // DevTools' lexical import boundary.
    let mut definitions = BTreeMap::new();
    collect_template_scope_definitions(
        &ast.nodes,
        templates,
        source_path,
        &mut definitions,
        &mut Vec::new(),
    )?;
    let environment = TemplateEnvironment {
        templates,
        definitions: &definitions,
        source_path: source_path.map(str::to_owned),
        stack: Vec::new(),
    };
    let nodes = evaluate_nodes(
        &ast.nodes,
        &context,
        Some(&environment),
        &evaluation_source_site("", "document", source_path.unwrap_or("")),
        false,
    )?;
    let attribute_sources = context.attribute_sources.borrow().clone();
    Ok(EvaluatedWxml {
        ast: WxmlAst {
            version: ast.version,
            nodes,
        },
        attribute_sources,
    })
}

/// Source documents cannot claim another document's provenance, even if that
/// other document is part of the same verified pack. Projection consumes the
/// evaluated tree directly and never needs to replay it as a source document.
fn validate_wxml_document_origin(ast: &WxmlAst, document: &str) -> Result<(), MarkupError> {
    fn visit(nodes: &[WxmlNode], document: &str) -> Result<(), MarkupError> {
        for node in nodes {
            if node
                .lexical_origin()
                .is_some_and(|origin| origin.document_id != document)
            {
                return Err(MarkupError::InvalidSyntax {
                    offset: 0,
                    message: "WXML source lexical origin disagrees with its declaring document"
                        .into(),
                });
            }
            if let WxmlNode::Element { children, .. } = node {
                visit(children, document)?;
            }
        }
        Ok(())
    }
    visit(&ast.nodes, document)
}

/// Project light-DOM children into `<slot>` outlets in a custom component
/// template.
///
/// WeChat components use the child element's `slot` attribute to select a
/// named outlet.  A slot with no matching child renders its fallback children;
/// an empty slot disappears.  The component template is cloned while
/// projection is performed, so callers can safely reuse the same parsed AST
/// for multiple component instances.  Named slots are enabled by default;
/// [`project_wxml_slots_with_options`] can model a component that omits
/// `multipleSlots`, in which case every light child is assigned to the default
/// outlet and its `slot` marker is ignored.
pub fn project_wxml_slots(
    component: &WxmlAst,
    light_children: &[WxmlNode],
) -> Result<WxmlAst, MarkupError> {
    project_wxml_slots_with_options(component, light_children, true)
}

/// Variant of [`project_wxml_slots`] that controls named-slot support.
///
/// `multiple_slots` corresponds to the component option commonly named
/// `multipleSlots` in `Component({ options })`.  If it is `false`, named
/// markers on light children do not create separate buckets and all children
/// flow into the default `<slot>` outlet.
pub fn project_wxml_slots_with_options(
    component: &WxmlAst,
    light_children: &[WxmlNode],
    multiple_slots: bool,
) -> Result<WxmlAst, MarkupError> {
    validate_wxml(component)?;
    // Validate the projected children as a standalone fragment.  This keeps
    // malformed input from being hidden by a slot outlet that is never used.
    validate_wxml(&WxmlAst {
        version: component.version,
        nodes: light_children.to_vec(),
    })?;

    let mut buckets: BTreeMap<String, Vec<WxmlNode>> = BTreeMap::new();
    for child in light_children {
        let slot = if multiple_slots {
            assigned_slot_name(child).unwrap_or_default()
        } else {
            String::new()
        };
        buckets
            .entry(slot)
            .or_default()
            .push(strip_slot_assignment(child));
    }

    Ok(WxmlAst {
        version: component.version,
        nodes: project_slot_nodes(&component.nodes, &buckets),
    })
}

/// Return the static slot name assigned to a light child.  Only direct child
/// elements can carry a slot assignment; text and comments belong to the
/// default slot.  Dynamic slot expressions remain literal here because this
/// helper operates on an already parsed component instance and intentionally
/// has no JavaScript evaluation context.
fn assigned_slot_name(node: &WxmlNode) -> Option<String> {
    let WxmlNode::Element { attrs, .. } = node else {
        return None;
    };
    attrs
        .get("slot")
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

/// Remove the routing marker from a projected root node.  `slot` is a
/// component composition attribute, not a renderable DOM/WXML attribute.
fn strip_slot_assignment(node: &WxmlNode) -> WxmlNode {
    let mut cloned = node.clone();
    if let WxmlNode::Element {
        attrs,
        bound_values,
        ..
    } = &mut cloned
    {
        attrs.remove("slot");
        bound_values.remove("slot");
    }
    cloned
}

fn project_slot_nodes(
    nodes: &[WxmlNode],
    buckets: &BTreeMap<String, Vec<WxmlNode>>,
) -> Vec<WxmlNode> {
    let mut output = Vec::new();
    for node in nodes {
        let WxmlNode::Element {
            tag,
            attrs,
            children,
            ..
        } = node
        else {
            output.push(node.clone());
            continue;
        };
        if tag == "slot" {
            let name = attrs
                .get("name")
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .unwrap_or_default();
            if let Some(projected) = buckets.get(name).filter(|children| !children.is_empty()) {
                output.extend(projected.iter().cloned());
            } else {
                // Fallback content can itself contain a nested slot.  This is
                // useful for wrappers that provide a named outlet and a
                // default outlet inside its fallback tree.
                output.extend(project_slot_nodes(children, buckets));
            }
            continue;
        }
        let mut cloned = node.clone();
        if let WxmlNode::Element { children, .. } = &mut cloned {
            *children = project_slot_nodes(children, buckets);
        }
        output.push(cloned);
    }
    output
}

#[derive(Clone, Debug)]
struct TemplateDefinition {
    nodes: Vec<WxmlNode>,
    source_path: Option<String>,
}

fn collect_template_definitions(
    nodes: &[WxmlNode],
    source_path: Option<&str>,
    definitions: &mut BTreeMap<String, TemplateDefinition>,
) {
    for node in nodes {
        if let WxmlNode::Element {
            tag,
            attrs,
            children,
            ..
        } = node
        {
            if tag == "template" {
                if let Some(name) = attrs.get("name").filter(|name| !name.trim().is_empty()) {
                    definitions.insert(
                        name.clone(),
                        TemplateDefinition {
                            nodes: children.clone(),
                            source_path: source_path.map(str::to_owned),
                        },
                    );
                }
            }
            collect_template_definitions(children, source_path, definitions);
        }
    }
}

/// Collect the template names visible from one WXML document.
///
/// `<template name="...">` declarations belong to the document that contains
/// them.  Other documents enter the scope only through `<import>` or
/// `<include>` declarations.  `templates` is a package-wide blob map, so it
/// is especially important that this walk does not iterate over every map
/// value: doing that would silently accept a missing import and make a
/// manifest render differently from the WeChat runtime.
fn collect_template_scope_definitions(
    nodes: &[WxmlNode],
    templates: &BTreeMap<String, WxmlAst>,
    source_path: Option<&str>,
    definitions: &mut BTreeMap<String, TemplateDefinition>,
    stack: &mut Vec<String>,
) -> Result<(), MarkupError> {
    // Definitions in the current file are available to all of that file's
    // descendants, including declarations that appear after a call site.
    collect_template_definitions(nodes, source_path, definitions);

    for node in nodes {
        let WxmlNode::Element {
            tag,
            attrs,
            children,
            ..
        } = node
        else {
            continue;
        };

        let imported = match tag.as_str() {
            "import" | "include" => attrs.get("src"),
            _ => None,
        };
        if let Some(source) = imported {
            let (resolved_source, template) =
                template_lookup_with_source(templates, source_path, source).ok_or_else(|| {
                    MarkupError::InvalidSyntax {
                        offset: 0,
                        message: format!("WXML {tag} target not found: {source}"),
                    }
                })?;
            let key = format!("{tag}:{resolved_source}");
            if stack.contains(&key) {
                // `validate_import_graph` already reports import cycles with
                // its canonical diagnostic.  Includes can participate in the
                // same graph, however, and need a deterministic guard here
                // before recursively collecting definitions.
                return Err(MarkupError::InvalidSyntax {
                    offset: 0,
                    message: format!("WXML {tag} cycle detected at {source}"),
                });
            }
            stack.push(key);
            collect_template_scope_definitions(
                &template.nodes,
                templates,
                Some(&resolved_source),
                definitions,
                stack,
            )?;
            stack.pop();
        }

        // Imports/includes can be nested below a conditional or a named
        // template declaration.  The package graph is validated before data
        // evaluation, so their declarations are visible independently of
        // which branch happens to render for this snapshot.
        collect_template_scope_definitions(children, templates, source_path, definitions, stack)?;
    }
    Ok(())
}

/// Resolve a WXML import/include relative to the file that declares it and
/// return the canonical package path alongside the AST.  The old lookup only
/// normalized `./`, so an import nested in `pages/home/index.wxml` incorrectly
/// searched the package root for `../shared/item.wxml`.  WeChat resolves these
/// references from the declaring WXML file's directory.
fn template_lookup_with_source<'a>(
    templates: &'a BTreeMap<String, WxmlAst>,
    source_path: Option<&str>,
    source: &str,
) -> Option<(String, &'a WxmlAst)> {
    let source = source.trim();
    // Strip the manifest alias before joining with the declaring file, while
    // retaining leading `..` segments.  Normalizing the relative source in
    // isolation would discard a leading parent segment before it can be
    // applied to the base directory.
    let relative_source = source
        .trim_start_matches("./")
        .strip_prefix("template:")
        .unwrap_or_else(|| source.trim_start_matches("./"));
    let normalized = normalize_template_source(source);
    let mut candidates = Vec::new();
    if let Some(base) = source_path {
        let base = normalize_template_source(base);
        let directory = base.rsplit_once('/').map(|(directory, _)| directory);
        let joined = if source.starts_with('/') {
            normalize_template_source(source.trim_start_matches('/'))
        } else if let Some(directory) = directory {
            normalize_template_source(&format!("{directory}/{relative_source}"))
        } else {
            normalized.clone()
        };
        candidates.push(joined);
    }
    candidates.push(normalized);

    for candidate in candidates {
        if let Some(ast) = templates.get(&candidate) {
            return Some((candidate, ast));
        }
        let alias = format!("template:{candidate}");
        if let Some(ast) = templates.get(&alias) {
            return Some((candidate, ast));
        }
    }
    None
}

fn normalize_template_source(source: &str) -> String {
    let source = source
        .trim()
        .trim_start_matches("./")
        // Manifest maps commonly expose both `pages/foo.wxml` and
        // `template:pages/foo.wxml` aliases.  Keep the graph key canonical so
        // alternating aliases cannot bypass the recursive import/include
        // guard.
        .strip_prefix("template:")
        .unwrap_or_else(|| source.trim().trim_start_matches("./"));
    let mut parts = Vec::new();
    for part in source.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    parts.join("/")
}

/// Validate every WXML `<import src="..." />` declaration and reject cycles.
/// Imports contribute named template definitions to the caller's scope but do
/// not produce a render node.  Keeping this check separate from expansion
/// makes malformed package graphs deterministic even when a branch is not
/// selected by the current data snapshot.
fn validate_import_graph(
    nodes: &[WxmlNode],
    templates: &BTreeMap<String, WxmlAst>,
    source_path: Option<&str>,
    stack: &mut Vec<String>,
) -> Result<(), MarkupError> {
    for node in nodes {
        let WxmlNode::Element {
            tag,
            attrs,
            children,
            ..
        } = node
        else {
            continue;
        };
        if tag == "import" {
            let source = attrs.get("src").ok_or_else(|| MarkupError::InvalidSyntax {
                offset: 0,
                message: "WXML import requires src".into(),
            })?;
            let (resolved_source, imported) =
                template_lookup_with_source(templates, source_path, source).ok_or_else(|| {
                    MarkupError::InvalidSyntax {
                        offset: 0,
                        message: format!("WXML import target not found: {source}"),
                    }
                })?;
            let key = format!("import:{resolved_source}");
            if stack.contains(&key) {
                return Err(MarkupError::InvalidSyntax {
                    offset: 0,
                    message: format!("WXML import cycle detected at {source}"),
                });
            }
            stack.push(key);
            validate_import_graph(&imported.nodes, templates, Some(&resolved_source), stack)?;
            stack.pop();
        }
        // Imports may occur in a template body as well as at document root;
        // walking every child keeps the graph validation independent of
        // whether that template is selected at runtime.
        validate_import_graph(children, templates, source_path, stack)?;
    }
    Ok(())
}

/// File and invocation context carried alongside the current data scope.
/// Template/include expansion happens during evaluation, after a loop has
/// installed its aliases and after a conditional branch has been selected.
/// Keeping these in the same traversal avoids evaluating a template against
/// an outer page scope, or interpreting its rendered text a second time.
#[derive(Clone)]
struct TemplateEnvironment<'a> {
    templates: &'a BTreeMap<String, WxmlAst>,
    definitions: &'a BTreeMap<String, TemplateDefinition>,
    source_path: Option<String>,
    stack: Vec<String>,
}

impl TemplateEnvironment<'_> {
    fn enter(&self, key: String, source_path: Option<&str>) -> Result<Self, MarkupError> {
        if let Some(document) = source_path {
            WxmlLexicalOrigin::from_document(document)?;
        }
        if self.stack.len() >= 32 {
            return Err(MarkupError::InvalidSyntax {
                offset: 0,
                message: "WXML template expansion exceeded the maximum depth".into(),
            });
        }
        let mut nested = self.clone();
        nested.stack.push(key);
        nested.source_path = source_path.map(str::to_owned);
        Ok(nested)
    }
}

fn evaluate_template_node(
    tag: &str,
    attrs: &BTreeMap<String, String>,
    context: &EvaluationContext,
    environment: &TemplateEnvironment<'_>,
    source_site: &str,
    preserve_text_whitespace: bool,
) -> Result<Option<Vec<WxmlNode>>, MarkupError> {
    let source_path = environment.source_path.as_deref();
    match tag {
        "include" | "import" => {
            let source = attrs.get("src").ok_or_else(|| MarkupError::InvalidSyntax {
                offset: 0,
                message: format!("WXML {tag} requires src"),
            })?;
            let (resolved_source, document) =
                template_lookup_with_source(environment.templates, source_path, source)
                    .ok_or_else(|| MarkupError::InvalidSyntax {
                        offset: 0,
                        message: format!("WXML {tag} target not found: {source}"),
                    })?;
            if tag == "import" {
                return Ok(Some(Vec::new()));
            }
            let key = format!("include:{resolved_source}");
            if environment.stack.contains(&key) {
                return Err(MarkupError::InvalidSyntax {
                    offset: 0,
                    message: format!("WXML include cycle detected at {source}"),
                });
            }
            let nested = environment.enter(key, Some(&resolved_source))?;
            Ok(Some(evaluate_nodes(
                &document.nodes,
                context,
                Some(&nested),
                &evaluation_source_site(source_site, "include", &resolved_source),
                preserve_text_whitespace,
            )?))
        }
        "template" => {
            if attrs.contains_key("name") {
                return Ok(Some(Vec::new()));
            }
            let Some(template_name) = attrs.get("is") else {
                return Ok(None);
            };
            let name = interpolate(template_name, context)?;
            let name = name.trim();
            let definition =
                environment
                    .definitions
                    .get(name)
                    .ok_or_else(|| MarkupError::InvalidSyntax {
                        offset: 0,
                        message: format!("WXML template target not found: {name}"),
                    })?;
            let defining_source = definition.source_path.as_deref().or(source_path);
            let key = format!("template:{}:{name}", defining_source.unwrap_or(""));
            if environment.stack.contains(&key) {
                return Err(MarkupError::InvalidSyntax {
                    offset: 0,
                    message: format!("WXML template cycle detected at {name}"),
                });
            }
            let template_context = template_data_context(attrs, context)?;
            let nested = environment.enter(key.clone(), defining_source)?;
            Ok(Some(strip_control_directives(evaluate_nodes(
                &definition.nodes,
                &template_context,
                Some(&nested),
                &evaluation_source_site(source_site, "template", &key),
                preserve_text_whitespace,
            )?)))
        }
        _ => Ok(None),
    }
}

/// Resolve the `data` attribute of a named template invocation.  WeChat
/// templates pass object members into the template scope; both
/// `data="{{item}}"` and the documented spread form
/// `data="{{...item}}"` are accepted.  Keeping the caller's values as a
/// fallback preserves the existing behavior for invocations without `data`
/// while allowing passed members to override them.
fn template_data_context(
    attrs: &BTreeMap<String, String>,
    context: &EvaluationContext,
) -> Result<EvaluationContext, MarkupError> {
    let Some(raw) = attrs.get("data") else {
        return Ok(context.clone());
    };
    let expression = raw.trim();
    let expression = expression
        .strip_prefix("{{")
        .and_then(|value| value.strip_suffix("}}"))
        .map(str::trim)
        .unwrap_or(expression);
    if expression.is_empty() {
        return Err(MarkupError::InvalidSyntax {
            offset: 0,
            message: "WXML template data expression cannot be empty".into(),
        });
    }
    let value = evaluate_template_data(expression, context)?;
    let Value::Object(values) = value else {
        return Err(MarkupError::InvalidSyntax {
            offset: 0,
            message: "WXML template data must evaluate to an object".into(),
        });
    };
    let origin = binding_provenance::template_origin(expression, context);
    let mut next = context.clone();
    for (key, value) in values {
        let member = origin.member(&key, false);
        let member =
            if origin.direct() || ((value.is_object() || value.is_array()) && member.direct()) {
                member
            } else {
                BindingOrigin::unsupported()
            };
        next.origins.insert(key.clone(), member);
        next.values.insert(key, value);
    }
    Ok(next)
}

/// Evaluate ordinary expressions and the unbraced object shorthand accepted
/// by WXML template data. Both forms use the expression grammar: a colon in
/// a conditional or quoted string must never be mistaken for a property key.
fn evaluate_template_data(source: &str, context: &EvaluationContext) -> Result<Value, MarkupError> {
    let tokens = ExpressionLexer::new(source).tokenize()?;
    let ordinary_error = match ExpressionParser::new(tokens.clone()).parse() {
        Ok(expression) => return expression.evaluate(&context.values, 0)?.into_json(),
        Err(error) => error,
    };

    // Only a source which is not an ordinary expression can be shorthand.
    // Wrap its tokens instead of splitting on punctuation, preserving nested
    // objects, ternaries, computed keys, escapes and the original offsets.
    let mut tokens = tokens;
    tokens.insert(
        0,
        ExpressionToken {
            kind: ExpressionTokenKind::Symbol("{"),
            offset: 0,
        },
    );
    let end = tokens.pop().expect("the lexer always emits an end token");
    tokens.push(ExpressionToken {
        kind: ExpressionTokenKind::Symbol("}"),
        offset: end.offset,
    });
    tokens.push(end);
    let expression = ExpressionParser::new(tokens)
        .parse()
        .map_err(|_| ordinary_error)?;
    let Expression::Object(entries) = expression else {
        unreachable!("a wrapped shorthand parses as an object literal")
    };
    let mut values = BTreeMap::new();
    for entry in entries {
        match entry {
            ExpressionObjectEntry::Value(key, value) => {
                values.insert(
                    key.evaluate(&context.values, 0)?.string(),
                    value.evaluate(&context.values, 0)?,
                );
            }
            ExpressionObjectEntry::Spread(value) => match value.evaluate(&context.values, 0)? {
                ExpressionValue::Json(Value::Object(entries)) => {
                    values.extend(
                        entries
                            .iter()
                            .map(|(key, value)| (key.clone(), ExpressionValue::from_json(value))),
                    );
                }
                ExpressionValue::Object(entries) => {
                    values.extend(
                        entries
                            .iter()
                            .map(|(key, value)| (key.clone(), value.clone())),
                    );
                }
                _ => {
                    return Err(expression_error(
                        0,
                        "WXML template data spread must evaluate to an object",
                    ))
                }
            },
        }
    }
    ExpressionValue::Object(std::rc::Rc::new(values)).into_json()
}

/// Remove directives that have already been evaluated in a named template.
/// Event directives remain intact because they are consumed by the view/event
/// layer after expansion.
fn strip_control_directives(nodes: Vec<WxmlNode>) -> Vec<WxmlNode> {
    nodes
        .into_iter()
        .map(|mut node| {
            if let WxmlNode::Element {
                directives,
                children,
                ..
            } = &mut node
            {
                directives.if_expr = None;
                directives.elif_expr = None;
                directives.else_branch = false;
                directives.for_expr = None;
                directives.for_item = None;
                directives.for_index = None;
                directives.for_key = None;
                *children = strip_control_directives(std::mem::take(children));
            }
            node
        })
        .collect()
}

#[derive(Clone, Debug)]
struct EvaluationContext {
    values: Map<String, Value>,
    origins: BTreeMap<String, BindingOrigin>,
    attribute_sources: std::rc::Rc<std::cell::RefCell<Vec<WxmlAttributeSource>>>,
}

impl EvaluationContext {
    fn new(data: &Value) -> Self {
        let values = match data {
            Value::Object(values) => values.clone(),
            _ => Map::new(),
        };
        let origins = values
            .keys()
            .map(|name| (name.clone(), BindingOrigin::root(name)))
            .collect();
        Self {
            values,
            origins,
            attribute_sources: Default::default(),
        }
    }

    fn with(&self, key: &str, value: Value) -> Self {
        self.with_origin(key, value, BindingOrigin::literal())
    }

    fn with_origin(&self, key: &str, value: Value, origin: BindingOrigin) -> Self {
        let mut next = self.clone();
        next.values.insert(key.to_owned(), value);
        next.origins.insert(key.to_owned(), origin);
        next
    }
}

fn evaluation_source_site(parent: &str, kind: &str, value: &str) -> String {
    format!("{parent}/{kind}{}:{value}", value.len())
}

fn evaluate_nodes(
    nodes: &[WxmlNode],
    context: &EvaluationContext,
    environment: Option<&TemplateEnvironment<'_>>,
    source_site: &str,
    preserve_text_whitespace: bool,
) -> Result<Vec<WxmlNode>, MarkupError> {
    let mut output = Vec::new();
    let mut conditional_chain = false;
    let mut branch_taken = false;
    for (source_index, node) in nodes.iter().enumerate() {
        let node_site = evaluation_source_site(source_site, "node", &source_index.to_string());
        // Formatting whitespace (and comments) between sibling conditional
        // elements does not terminate a wx:if/wx:elif/wx:else chain in the
        // DevTools runtime. Preserve the chain state, then let evaluate_node
        // omit source formatting after its original position was assigned.
        let formatting_separator = match node {
            WxmlNode::Comment { .. } => true,
            WxmlNode::Text { value, .. } => value.trim().is_empty(),
            WxmlNode::Element { .. } => false,
        };
        if formatting_separator {
            output.extend(evaluate_node(
                node,
                context,
                environment,
                &node_site,
                preserve_text_whitespace,
            )?);
            continue;
        }
        let Some(directives) = element_directives(node) else {
            conditional_chain = false;
            branch_taken = false;
            output.extend(evaluate_node(
                node,
                context,
                environment,
                &node_site,
                preserve_text_whitespace,
            )?);
            continue;
        };
        // A loop introduces the item/index scope before a same-node wx:if
        // or template invocation can read it. Each iteration evaluates its
        // own conditional; sibling branch state never leaks across items.
        if directives.for_expr.is_some() {
            conditional_chain = false;
            branch_taken = false;
            output.extend(evaluate_node(
                node,
                context,
                environment,
                &node_site,
                preserve_text_whitespace,
            )?);
            continue;
        }
        let is_conditional = directives.if_expr.is_some()
            || directives.elif_expr.is_some()
            || directives.else_branch;
        if !is_conditional {
            conditional_chain = false;
            branch_taken = false;
            output.extend(evaluate_node(
                node,
                context,
                environment,
                &node_site,
                preserve_text_whitespace,
            )?);
            continue;
        }
        if directives.if_expr.is_some() {
            conditional_chain = true;
            branch_taken = false;
        } else if !conditional_chain {
            return Err(MarkupError::InvalidSyntax {
                offset: 0,
                message: "wx:elif/wx:else must follow wx:if in the same sibling list".into(),
            });
        }
        if branch_taken {
            continue;
        }
        let matches = if let Some(expression) = directives.if_expr.as_deref() {
            evaluate_expression(expression, context).map(|value| truthy(&value))?
        } else if let Some(expression) = directives.elif_expr.as_deref() {
            evaluate_expression(expression, context).map(|value| truthy(&value))?
        } else {
            true
        };
        if matches {
            branch_taken = true;
            output.extend(evaluate_node(
                node,
                context,
                environment,
                &node_site,
                preserve_text_whitespace,
            )?);
        }
    }
    Ok(output)
}

fn element_directives(node: &WxmlNode) -> Option<&WxmlDirectives> {
    match node {
        WxmlNode::Element { directives, .. } => Some(directives),
        _ => None,
    }
}

fn evaluate_node(
    node: &WxmlNode,
    context: &EvaluationContext,
    environment: Option<&TemplateEnvironment<'_>>,
    source_site: &str,
    preserve_text_whitespace: bool,
) -> Result<Vec<WxmlNode>, MarkupError> {
    // Known source documents always generate their own provenance. Anonymous
    // fragments can retain already evaluated metadata for callers which clone
    // and project trees without a source-document evaluation environment.
    let lexical_origin = environment
        .and_then(|environment| environment.source_path.as_deref())
        .map(|document| WxmlLexicalOrigin {
            document_id: document.into(),
        })
        .or_else(|| node.lexical_origin().cloned());
    match node {
        WxmlNode::Comment { value, .. } => Ok(vec![WxmlNode::Comment {
            value: value.clone(),
            lexical_origin,
        }]),
        WxmlNode::Text {
            value, bindings, ..
        } if !preserve_text_whitespace
            && bindings.is_empty()
            && value.trim().is_empty()
            && (value.contains('\r') || value.contains('\n')) =>
        {
            // The parser keeps source indentation lossless. It is not a
            // renderable text block, but must be removed only after
            // evaluate_nodes assigns identities from original source indices.
            // Text-element subtrees, single-line spaces, and binding results
            // remain explicit text. Retained binding metadata distinguishes
            // a previously evaluated newline from source formatting.
            Ok(Vec::new())
        }
        WxmlNode::Text {
            value, bindings, ..
        } => Ok(vec![WxmlNode::Text {
            value: interpolate(value, context)?,
            // Retain source bindings for dependency tracking; rendered data
            // is never interpreted again as binding source.
            bindings: merge_bindings(bindings, bindings_in(value)),
            lexical_origin,
        }]),
        WxmlNode::Element {
            tag,
            attrs,
            bound_values,
            bindings,
            directives,
            key,
            key_scope,
            source_site: existing_source_site,
            children,
            ..
        } => {
            // Projection and component expansion may reuse an evaluated
            // subtree in another render position. Its declaration identity
            // must follow that subtree rather than the new sibling index.
            let source_site = existing_source_site.as_deref().unwrap_or(source_site);
            if let Some(expression) = directives.for_expr.as_deref() {
                let collection_origin = source_origin(expression, context, false);
                let collection = evaluate_expression(expression, context)?;
                let collection_is_array = collection.is_array();
                let entries = match collection {
                    Value::Array(values) => values
                        .into_iter()
                        .enumerate()
                        .map(|(index, value)| (Value::from(index), value))
                        .collect::<Vec<_>>(),
                    Value::Object(values) => values
                        .into_iter()
                        .map(|(key, value)| (Value::String(key), value))
                        .collect::<Vec<_>>(),
                    _ => Vec::new(),
                };
                let item_name = directives.for_item.as_deref().unwrap_or("item");
                let index_name = directives.for_index.as_deref().unwrap_or("index");
                let mut expanded = Vec::new();
                for (index, item) in entries {
                    let loop_context = context
                        .with_origin(
                            item_name,
                            item.clone(),
                            collection_origin.member(&value_to_string(&index), collection_is_array),
                        )
                        .with(index_name, index.clone());
                    let mut clean = directives.clone();
                    clean.for_expr = None;
                    clean.for_item = None;
                    clean.for_index = None;
                    clean.for_key = None;
                    let resolved_key = directives
                        .for_key
                        .as_deref()
                        .map(|expression| evaluate_loop_key(expression, &item, &loop_context))
                        .transpose()?;
                    let iteration_site = if let Some(key) = &resolved_key {
                        evaluation_source_site(source_site, "repeat-key", key)
                    } else {
                        evaluation_source_site(
                            source_site,
                            "repeat-index",
                            &value_to_string(&index),
                        )
                    };
                    let rendered = WxmlNode::Element {
                        tag: tag.clone(),
                        lexical_origin: lexical_origin.clone(),
                        // Preserve the original binding until the node's
                        // own evaluation. Interpolating here and recursing
                        // would reinterpret a data string such as {{name}}.
                        attrs: attrs.clone(),
                        bound_values: bound_values.clone(),
                        bindings: bindings_in_attrs(attrs),
                        directives: clean,
                        key_scope: resolved_key.as_ref().map(|_| source_site.to_owned()),
                        key: resolved_key,
                        // The recursion assigns this iteration's occurrence
                        // below its key/index before evaluating descendants.
                        source_site: None,
                        children: children.clone(),
                    };
                    expanded.extend(evaluate_nodes(
                        std::slice::from_ref(&rendered),
                        &loop_context,
                        environment,
                        &iteration_site,
                        preserve_text_whitespace,
                    )?);
                }
                return Ok(expanded);
            }
            if let Some(environment) = environment {
                if let Some(rendered) = evaluate_template_node(
                    tag,
                    attrs,
                    context,
                    environment,
                    source_site,
                    preserve_text_whitespace,
                )? {
                    if key.is_some() && !rendered.is_empty() {
                        // A template/include can yield several roots. Keep
                        // their shared repeat identity on a transparent block
                        // so every root inherits the same stable key prefix.
                        return Ok(vec![WxmlNode::Element {
                            tag: "block".into(),
                            lexical_origin,
                            attrs: BTreeMap::new(),
                            bound_values: BTreeMap::new(),
                            bindings: Vec::new(),
                            directives: WxmlDirectives::default(),
                            key: key.clone(),
                            key_scope: key_scope.clone(),
                            source_site: Some(source_site.to_owned()),
                            children: rendered,
                        }]);
                    }
                    return Ok(rendered);
                }
            }
            let mut rendered_attrs = BTreeMap::new();
            let mut rendered_bound_values = BTreeMap::new();
            for (name, source) in attrs {
                let rendered = if name.starts_with("wx:") {
                    source.clone()
                } else if let Some(value) = bound_values.get(name) {
                    // An evaluated binding can itself contain mustache text.
                    // Preserve its value instead of executing that text when
                    // an evaluated subtree is passed through another scope.
                    rendered_bound_values.insert(name.clone(), value.clone());
                    // Reused evaluated light content keeps its original task's
                    // sidecar; source-supplied boundValues gain no provenance.
                    binding_provenance::record(
                        context,
                        source_site,
                        name,
                        BindingOrigin::unsupported(),
                    );
                    source.clone()
                } else if let Some(expression) = single_mustache_expression(source) {
                    // Resolve once in the current loop/template scope, using
                    // the same value for the legacy string and typed channel.
                    let value = evaluate_expression(expression, context)?;
                    binding_provenance::record(
                        context,
                        source_site,
                        name,
                        source_origin(expression, context, false),
                    );
                    let rendered = value_to_string(&value);
                    rendered_bound_values.insert(name.clone(), value);
                    rendered
                } else {
                    interpolate(source, context)?
                };
                rendered_attrs.insert(name.clone(), rendered);
            }
            let rendered_children = evaluate_nodes(
                children,
                context,
                environment,
                source_site,
                preserve_text_whitespace || tag == "text",
            )?;
            Ok(vec![WxmlNode::Element {
                tag: tag.clone(),
                lexical_origin,
                bindings: merge_bindings(bindings, bindings_in_attrs(&rendered_attrs)),
                attrs: rendered_attrs,
                bound_values: rendered_bound_values,
                directives: directives.clone(),
                key: key.clone(),
                key_scope: key_scope.clone(),
                source_site: Some(source_site.to_owned()),
                children: rendered_children,
            }])
        }
    }
}

fn bindings_in_attrs(attrs: &BTreeMap<String, String>) -> Vec<String> {
    attrs
        .values()
        .flat_map(|value| bindings_in(value))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn merge_bindings(existing: &[String], discovered: Vec<String>) -> Vec<String> {
    existing
        .iter()
        .cloned()
        .chain(discovered)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// Locate a mustache terminator outside strings and object literals. The
/// expression parser owns grammar validation; this scanner only preserves
/// the complete binding source for it, including `'}}'` and nested objects.
fn find_mustache_end(source: &str) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    let mut braces = 0usize;
    for (offset, character) in source.char_indices() {
        if let Some(delimiter) = quote {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == delimiter {
                quote = None;
            }
            continue;
        }
        match character {
            '\'' | '"' => quote = Some(character),
            '{' => braces += 1,
            '}' if braces > 0 => braces -= 1,
            '}' if source[offset..].starts_with("}}") => return Some(offset),
            _ => {}
        }
    }
    None
}

fn single_mustache_expression(source: &str) -> Option<&str> {
    // Do not trim the attribute: surrounding whitespace and mixed literal
    // text are meaningful string content, not a typed binding.
    let after = source.strip_prefix("{{")?;
    let end = find_mustache_end(after)?;
    after[end + 2..].is_empty().then(|| after[..end].trim())
}

fn interpolate(source: &str, context: &EvaluationContext) -> Result<String, MarkupError> {
    let mut output = String::with_capacity(source.len());
    let mut rest = source;
    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = find_mustache_end(after) else {
            return Err(MarkupError::InvalidSyntax {
                offset: 0,
                message: "unterminated WXML mustache expression".into(),
            });
        };
        let expression = after[..end].trim();
        let value = evaluate_expression(expression, context)?;
        output.push_str(&value_to_string(&value));
        rest = &after[end + 2..];
    }
    output.push_str(rest);
    Ok(output)
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value
            .as_f64()
            .map(expression_number_string)
            .unwrap_or_else(|| value.to_string()),
        Value::String(value) => value.clone(),
        Value::Array(_) | Value::Object(_) => expression_json_string(value),
    }
}

/// JSON data inside a WXML string uses the same JavaScript number formatting
/// as a scalar binding. serde_json retains an internal integer/float variant;
/// serializing an evaluated object directly would expose `1.0` for a literal
/// `1`, even though both are the same JavaScript Number.
fn expression_json_string(value: &Value) -> String {
    match value {
        Value::Number(_) => value_to_string(value),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(expression_json_string)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => format!(
            "{{{}}}",
            values
                .iter()
                .map(|(key, value)| format!(
                    "{}:{}",
                    serde_json::to_string(key).expect("a string always serializes as JSON"),
                    expression_json_string(value)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => serde_json::to_string(value).expect("a JSON value always serializes"),
    }
}

/// Resolve a repeated item's `wx:key` value.  WeChat treats `*this` as the
/// item itself and otherwise reads the named property from an object item.  A
/// dotted expression is also accepted for compiler-generated WXML; it is
/// evaluated against the loop context so `item.id` remains useful when the
/// caller explicitly names the loop variable.
fn evaluate_loop_key(
    expression: &str,
    item: &Value,
    context: &EvaluationContext,
) -> Result<String, MarkupError> {
    let expression = expression.trim();
    if expression.is_empty() {
        return Err(MarkupError::InvalidSyntax {
            offset: 0,
            message: "WXML wx:key expression cannot be empty".into(),
        });
    }
    let value = if expression == "*this" {
        item.clone()
    } else if !expression.contains('.') {
        match item {
            Value::Object(values) => values.get(expression).cloned().unwrap_or(Value::Null),
            _ => evaluate_expression(expression, context)?,
        }
    } else {
        evaluate_expression(expression, context)?
    };
    Ok(value_to_string(&value))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        // JavaScript objects are truthy, including empty arrays/objects.
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Parse the complete portable expression before evaluating it. Parsing and
/// evaluation are separate so short-circuited branches retain syntax checking
/// without evaluating their values. No function calls or host code execute.
fn evaluate_expression(
    expression: &str,
    context: &EvaluationContext,
) -> Result<Value, MarkupError> {
    let tokens = ExpressionLexer::new(expression).tokenize()?;
    let ast = ExpressionParser::new(tokens).parse()?;
    ast.evaluate(&context.values, 0)?.into_json()
}

const MAX_EXPRESSION_DEPTH: usize = 256;

fn expression_error(offset: usize, message: impl Into<String>) -> MarkupError {
    MarkupError::InvalidSyntax {
        offset,
        message: message.into(),
    }
}

#[derive(Clone, Debug, PartialEq)]
enum ExpressionTokenKind {
    Identifier(String),
    Number(f64),
    String(String),
    Symbol(&'static str),
    End,
}

#[derive(Clone, Debug)]
struct ExpressionToken {
    kind: ExpressionTokenKind,
    offset: usize,
}

struct ExpressionLexer<'a> {
    source: &'a str,
    offset: usize,
}

impl<'a> ExpressionLexer<'a> {
    fn new(source: &'a str) -> Self {
        Self { source, offset: 0 }
    }

    fn tokenize(mut self) -> Result<Vec<ExpressionToken>, MarkupError> {
        let mut tokens = Vec::new();
        while let Some(character) = self.peek() {
            if character.is_whitespace() {
                self.advance();
                continue;
            }
            let offset = self.offset;
            let kind = if character == '\'' || character == '"' {
                ExpressionTokenKind::String(self.string(character)?)
            } else if character.is_ascii_digit()
                || (character == '.'
                    && self
                        .source
                        .as_bytes()
                        .get(offset + 1)
                        .is_some_and(u8::is_ascii_digit))
            {
                ExpressionTokenKind::Number(self.number()?)
            } else if is_expression_identifier_start(character) {
                self.advance();
                while self.peek().is_some_and(is_expression_identifier_continue) {
                    self.advance();
                }
                ExpressionTokenKind::Identifier(self.source[offset..self.offset].to_owned())
            } else {
                let rest = &self.source[offset..];
                let symbol = [
                    "===", "!==", "...", "++", "--", "==", "!=", "<=", ">=", "&&", "||", "+", "-",
                    "*", "/", "%", "!", "<", ">", "?", ":", ".", ",", "(", ")", "[", "]", "{", "}",
                ]
                .into_iter()
                .find(|symbol| rest.starts_with(symbol))
                .ok_or_else(|| {
                    expression_error(
                        offset,
                        format!("unsupported WXML expression token: {character}"),
                    )
                })?;
                self.offset += symbol.len();
                ExpressionTokenKind::Symbol(symbol)
            };
            tokens.push(ExpressionToken { kind, offset });
        }
        tokens.push(ExpressionToken {
            kind: ExpressionTokenKind::End,
            offset: self.source.len(),
        });
        Ok(tokens)
    }

    fn peek(&self) -> Option<char> {
        self.source[self.offset..].chars().next()
    }

    fn advance(&mut self) -> Option<char> {
        let character = self.peek()?;
        self.offset += character.len_utf8();
        Some(character)
    }

    fn string(&mut self, quote: char) -> Result<String, MarkupError> {
        let start = self.offset;
        self.advance();
        let mut value = String::new();
        while let Some(character) = self.advance() {
            match character {
                character if character == quote => return Ok(value),
                '\n' | '\r' => {
                    return Err(expression_error(
                        self.offset,
                        "unescaped newline in WXML string",
                    ))
                }
                '\\' => {
                    let escaped = self.advance().ok_or_else(|| {
                        expression_error(start, "unterminated WXML string escape")
                    })?;
                    match escaped {
                        '\n' => {}
                        '\r' => {
                            if self.peek() == Some('\n') {
                                self.advance();
                            }
                        }
                        'n' => value.push('\n'),
                        'r' => value.push('\r'),
                        't' => value.push('\t'),
                        'b' => value.push('\u{0008}'),
                        'f' => value.push('\u{000c}'),
                        'v' => value.push('\u{000b}'),
                        '0' if !self.peek().is_some_and(|next| next.is_ascii_digit()) => {
                            value.push('\0')
                        }
                        '0'..='9' => {
                            return Err(expression_error(
                                self.offset,
                                "legacy numeric escapes are unsupported in WXML strings",
                            ))
                        }
                        'x' => {
                            let code = self.hex_escape(2)?;
                            value.push(
                                char::from_u32(code)
                                    .expect("two hexadecimal digits form a Unicode scalar"),
                            );
                        }
                        'u' => {
                            let code = if self.peek() == Some('{') {
                                self.advance();
                                let digits = self.offset;
                                while self.peek().is_some_and(|next| next.is_ascii_hexdigit()) {
                                    self.advance();
                                }
                                if digits == self.offset
                                    || self.offset - digits > 6
                                    || self.advance() != Some('}')
                                {
                                    return Err(expression_error(
                                        digits,
                                        "invalid WXML Unicode escape",
                                    ));
                                }
                                u32::from_str_radix(&self.source[digits..self.offset - 1], 16)
                                    .map_err(|_| {
                                        expression_error(digits, "invalid WXML Unicode escape")
                                    })?
                            } else {
                                self.hex_escape(4)?
                            };
                            let code = if (0xd800..=0xdbff).contains(&code) {
                                if !self.source[self.offset..].starts_with("\\u") {
                                    return Err(expression_error(self.offset, "unpaired UTF-16 surrogate cannot be represented in WXML JSON"));
                                }
                                self.offset += 2;
                                let low = self.hex_escape(4)?;
                                if !(0xdc00..=0xdfff).contains(&low) {
                                    return Err(expression_error(
                                        self.offset,
                                        "invalid WXML UTF-16 surrogate pair",
                                    ));
                                }
                                0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
                            } else {
                                code
                            };
                            value.push(char::from_u32(code).ok_or_else(|| {
                                expression_error(
                                    self.offset,
                                    "Unicode escape cannot be represented in WXML JSON",
                                )
                            })?);
                        }
                        other => value.push(other),
                    }
                }
                other => value.push(other),
            }
        }
        Err(expression_error(start, "unterminated WXML string"))
    }

    fn hex_escape(&mut self, count: usize) -> Result<u32, MarkupError> {
        let start = self.offset;
        for _ in 0..count {
            if !self
                .peek()
                .is_some_and(|character| character.is_ascii_hexdigit())
            {
                return Err(expression_error(
                    start,
                    "invalid hexadecimal WXML string escape",
                ));
            }
            self.advance();
        }
        u32::from_str_radix(&self.source[start..self.offset], 16)
            .map_err(|_| expression_error(start, "invalid hexadecimal WXML string escape"))
    }

    fn number(&mut self) -> Result<f64, MarkupError> {
        let start = self.offset;
        let rest = &self.source[start..];
        let radix = if rest.starts_with("0x") || rest.starts_with("0X") {
            Some(16)
        } else if rest.starts_with("0b") || rest.starts_with("0B") {
            Some(2)
        } else if rest.starts_with("0o") || rest.starts_with("0O") {
            Some(8)
        } else {
            None
        };
        if let Some(radix) = radix {
            self.offset += 2;
            let digits = self.offset;
            let mut value = 0.0;
            while let Some(digit) = self.peek().and_then(|character| character.to_digit(radix)) {
                self.advance();
                value = value * f64::from(radix) + f64::from(digit);
            }
            if digits == self.offset || self.peek().is_some_and(is_expression_identifier_continue) {
                return Err(expression_error(start, "invalid WXML numeric literal"));
            }
            return Ok(value);
        }
        while self
            .peek()
            .is_some_and(|character| character.is_ascii_digit())
        {
            self.advance();
        }
        if self.peek() == Some('.') {
            self.advance();
            while self
                .peek()
                .is_some_and(|character| character.is_ascii_digit())
            {
                self.advance();
            }
        }
        if matches!(self.peek(), Some('e' | 'E')) {
            self.advance();
            if matches!(self.peek(), Some('+' | '-')) {
                self.advance();
            }
            let digits = self.offset;
            while self
                .peek()
                .is_some_and(|character| character.is_ascii_digit())
            {
                self.advance();
            }
            if digits == self.offset {
                return Err(expression_error(start, "invalid WXML numeric exponent"));
            }
        }
        if self.peek().is_some_and(is_expression_identifier_start) {
            return Err(expression_error(start, "invalid WXML numeric literal"));
        }
        self.source[start..self.offset]
            .parse::<f64>()
            .map_err(|_| expression_error(start, "invalid WXML numeric literal"))
    }
}

fn is_expression_identifier_start(character: char) -> bool {
    character == '_' || character == '$' || character.is_alphabetic()
}

fn is_expression_identifier_continue(character: char) -> bool {
    is_expression_identifier_start(character) || character.is_ascii_digit()
}

#[derive(Debug)]
enum ExpressionLiteral {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
}

impl ExpressionLiteral {
    fn value<'a>(&self) -> ExpressionValue<'a> {
        match self {
            Self::Undefined => ExpressionValue::Undefined,
            Self::Null => ExpressionValue::Null,
            Self::Bool(value) => ExpressionValue::Bool(*value),
            Self::Number(value) => ExpressionValue::Number(*value),
            Self::String(value) => ExpressionValue::String(value.clone()),
        }
    }
}

#[derive(Debug)]
enum Expression {
    Literal(ExpressionLiteral),
    Variable(String),
    Unary(&'static str, Box<Expression>),
    Binary(&'static str, Box<Expression>, Box<Expression>),
    Conditional(Box<Expression>, Box<Expression>, Box<Expression>),
    Member(Box<Expression>, Box<Expression>),
    Array(Vec<ExpressionArrayEntry>),
    Object(Vec<ExpressionObjectEntry>),
}

#[derive(Debug)]
enum ExpressionArrayEntry {
    Value(Expression),
    Spread(Expression),
    Hole,
}

#[derive(Debug)]
enum ExpressionObjectEntry {
    Value(Expression, Expression),
    Spread(Expression),
}

struct ExpressionParser {
    tokens: Vec<ExpressionToken>,
    cursor: usize,
    depth: usize,
}

impl ExpressionParser {
    fn new(tokens: Vec<ExpressionToken>) -> Self {
        Self {
            tokens,
            cursor: 0,
            depth: 0,
        }
    }

    fn parse(mut self) -> Result<Expression, MarkupError> {
        if self.peek().kind == ExpressionTokenKind::End {
            return Err(expression_error(0, "WXML expression cannot be empty"));
        }
        let expression = self.expression(0)?;
        if self.peek().kind != ExpressionTokenKind::End {
            return Err(expression_error(
                self.peek().offset,
                "unexpected token after WXML expression",
            ));
        }
        Ok(expression)
    }

    fn peek(&self) -> &ExpressionToken {
        &self.tokens[self.cursor]
    }

    fn take(&mut self) -> ExpressionToken {
        let token = self.peek().clone();
        if token.kind != ExpressionTokenKind::End {
            self.cursor += 1;
        }
        token
    }

    fn consume(&mut self, symbol: &str) -> bool {
        if matches!(&self.peek().kind, ExpressionTokenKind::Symbol(value) if *value == symbol) {
            self.take();
            true
        } else {
            false
        }
    }

    fn expect(&mut self, symbol: &str) -> Result<(), MarkupError> {
        if self.consume(symbol) {
            return Ok(());
        }
        let message = if symbol == "]" && self.peek().kind == ExpressionTokenKind::End {
            "unterminated WXML member index".to_owned()
        } else {
            format!("expected '{symbol}' in WXML expression")
        };
        Err(expression_error(self.peek().offset, message))
    }

    fn expression(&mut self, minimum: u8) -> Result<Expression, MarkupError> {
        if self.depth >= MAX_EXPRESSION_DEPTH {
            return Err(expression_error(
                self.peek().offset,
                "WXML expression exceeds the maximum nesting depth",
            ));
        }
        self.depth += 1;
        let result = self.expression_inner(minimum);
        self.depth -= 1;
        result
    }

    fn expression_inner(&mut self, minimum: u8) -> Result<Expression, MarkupError> {
        let token = self.take();
        let mut left = match token.kind {
            ExpressionTokenKind::Identifier(name) => match name.as_str() {
                "true" => Expression::Literal(ExpressionLiteral::Bool(true)),
                "false" => Expression::Literal(ExpressionLiteral::Bool(false)),
                "null" => Expression::Literal(ExpressionLiteral::Null),
                "undefined" => Expression::Literal(ExpressionLiteral::Undefined),
                _ => Expression::Variable(name),
            },
            ExpressionTokenKind::Number(value) => {
                Expression::Literal(ExpressionLiteral::Number(value))
            }
            ExpressionTokenKind::String(value) => {
                Expression::Literal(ExpressionLiteral::String(value))
            }
            ExpressionTokenKind::Symbol("(") => {
                let expression = self.expression(0)?;
                self.expect(")")?;
                expression
            }
            ExpressionTokenKind::Symbol("[") => self.array()?,
            ExpressionTokenKind::Symbol("{") => self.object()?,
            ExpressionTokenKind::Symbol(operator @ ("!" | "+" | "-")) => {
                Expression::Unary(operator, Box::new(self.expression(9)?))
            }
            _ => {
                return Err(expression_error(
                    token.offset,
                    "expected a WXML expression operand",
                ))
            }
        };
        loop {
            if self.consume(".") {
                let member = self.take();
                let ExpressionTokenKind::Identifier(name) = member.kind else {
                    return Err(expression_error(
                        member.offset,
                        "WXML member name cannot be empty",
                    ));
                };
                left = Expression::Member(
                    Box::new(left),
                    Box::new(Expression::Literal(ExpressionLiteral::String(name))),
                );
                continue;
            }
            if self.consume("[") {
                if self.peek().kind == ExpressionTokenKind::Symbol("]") {
                    return Err(expression_error(
                        self.peek().offset,
                        "WXML member index cannot be empty",
                    ));
                }
                let key = self.expression(0)?;
                self.expect("]")?;
                left = Expression::Member(Box::new(left), Box::new(key));
                continue;
            }
            if self.peek().kind == ExpressionTokenKind::Symbol("(") {
                return Err(expression_error(
                    self.peek().offset,
                    "function calls are unsupported in portable WXML expressions",
                ));
            }
            if minimum <= 1 && self.consume("?") {
                let consequent = self.expression(0)?;
                self.expect(":")?;
                let alternate = self.expression(1)?;
                left = Expression::Conditional(
                    Box::new(left),
                    Box::new(consequent),
                    Box::new(alternate),
                );
                continue;
            }
            let ExpressionTokenKind::Symbol(operator) = self.peek().kind else {
                break;
            };
            let precedence = match operator {
                "||" => 2,
                "&&" => 3,
                "==" | "!=" | "===" | "!==" => 4,
                "<" | "<=" | ">" | ">=" => 5,
                "+" | "-" => 6,
                "*" | "/" | "%" => 7,
                _ => break,
            };
            if precedence < minimum {
                break;
            }
            self.take();
            let right = self.expression(precedence + 1)?;
            left = Expression::Binary(operator, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn array(&mut self) -> Result<Expression, MarkupError> {
        let mut entries = Vec::new();
        while !self.consume("]") {
            if self.consume(",") {
                entries.push(ExpressionArrayEntry::Hole);
                continue;
            }
            entries.push(if self.consume("...") {
                ExpressionArrayEntry::Spread(self.expression(0)?)
            } else {
                ExpressionArrayEntry::Value(self.expression(0)?)
            });
            if self.consume("]") {
                break;
            }
            self.expect(",")?;
        }
        Ok(Expression::Array(entries))
    }

    fn object(&mut self) -> Result<Expression, MarkupError> {
        let mut entries = Vec::new();
        while !self.consume("}") {
            if self.consume("...") {
                entries.push(ExpressionObjectEntry::Spread(self.expression(0)?));
            } else if self.consume("[") {
                let key = self.expression(0)?;
                self.expect("]")?;
                self.expect(":")?;
                entries.push(ExpressionObjectEntry::Value(key, self.expression(0)?));
            } else {
                let token = self.take();
                let (name, shorthand) = match token.kind {
                    ExpressionTokenKind::Identifier(name) => (name, true),
                    ExpressionTokenKind::String(name) => (name, false),
                    ExpressionTokenKind::Number(value) => (expression_number_string(value), false),
                    _ => {
                        return Err(expression_error(
                            token.offset,
                            "invalid WXML object property name",
                        ))
                    }
                };
                let value = if self.consume(":") {
                    self.expression(0)?
                } else if shorthand
                    && !matches!(name.as_str(), "true" | "false" | "null" | "undefined")
                {
                    Expression::Variable(name.clone())
                } else {
                    return Err(expression_error(
                        self.peek().offset,
                        "WXML object property requires ':'",
                    ));
                };
                entries.push(ExpressionObjectEntry::Value(
                    Expression::Literal(ExpressionLiteral::String(name)),
                    value,
                ));
            }
            if self.consume("}") {
                break;
            }
            self.expect(",")?;
        }
        Ok(Expression::Object(entries))
    }
}

/// Preserve missing values and object identity until the portable JSON boundary.
/// Page data stays borrowed: evaluating one binding must not copy the entire
/// page snapshot (or a large collection just to read one indexed member).
#[derive(Clone, Debug)]
enum ExpressionValue<'a> {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Json(&'a Value),
    Array(std::rc::Rc<Vec<ExpressionValue<'a>>>),
    Object(std::rc::Rc<BTreeMap<String, ExpressionValue<'a>>>),
}

impl<'a> ExpressionValue<'a> {
    fn from_json(value: &'a Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(value) => Self::Bool(*value),
            Value::Number(value) => Self::Number(value.as_f64().unwrap_or(f64::NAN)),
            Value::String(value) => Self::String(value.clone()),
            Value::Array(_) | Value::Object(_) => Self::Json(value),
        }
    }

    fn into_json(self) -> Result<Value, MarkupError> {
        Ok(match self {
            Self::Undefined | Self::Null => Value::Null,
            Self::Bool(value) => Value::Bool(value),
            Self::Number(value) => {
                Value::Number(serde_json::Number::from_f64(value).ok_or_else(|| {
                    expression_error(
                        0,
                        "non-finite WXML expression result cannot be represented in JSON",
                    )
                })?)
            }
            Self::String(value) => Value::String(value),
            Self::Json(value) => value.clone(),
            Self::Array(values) => Value::Array(
                values
                    .iter()
                    .cloned()
                    .map(Self::into_json)
                    .collect::<Result<_, _>>()?,
            ),
            Self::Object(values) => Value::Object(
                values
                    .iter()
                    .filter(|(_, value)| !matches!(value, Self::Undefined))
                    .map(|(key, value)| Ok((key.clone(), value.clone().into_json()?)))
                    .collect::<Result<_, MarkupError>>()?,
            ),
        })
    }

    fn truthy(&self) -> bool {
        match self {
            Self::Undefined | Self::Null => false,
            Self::Bool(value) => *value,
            Self::Number(value) => *value != 0.0 && !value.is_nan(),
            Self::String(value) => !value.is_empty(),
            Self::Json(_) | Self::Array(_) | Self::Object(_) => true,
        }
    }

    fn primitive(&self) -> Self {
        match self {
            Self::Json(_) | Self::Array(_) | Self::Object(_) => Self::String(self.string()),
            _ => self.clone(),
        }
    }

    fn string(&self) -> String {
        match self {
            Self::Undefined => "undefined".into(),
            Self::Null => "null".into(),
            Self::Bool(value) => value.to_string(),
            Self::Number(value) => expression_number_string(*value),
            Self::String(value) => value.clone(),
            Self::Json(Value::Array(values)) => values
                .iter()
                .map(|value| Self::from_json(value).array_element_string())
                .collect::<Vec<_>>()
                .join(","),
            Self::Json(_) | Self::Object(_) => "[object Object]".into(),
            Self::Array(values) => values
                .iter()
                .map(Self::array_element_string)
                .collect::<Vec<_>>()
                .join(","),
        }
    }

    fn array_element_string(&self) -> String {
        if matches!(self, Self::Undefined | Self::Null) {
            String::new()
        } else {
            self.string()
        }
    }

    fn number(&self) -> f64 {
        match self {
            Self::Undefined => f64::NAN,
            Self::Null => 0.0,
            Self::Bool(value) => {
                if *value {
                    1.0
                } else {
                    0.0
                }
            }
            Self::Number(value) => *value,
            Self::String(value) => expression_string_number(value),
            Self::Json(_) | Self::Array(_) | Self::Object(_) => self.primitive().number(),
        }
    }

    fn strict_equal(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Undefined, Self::Undefined) | (Self::Null, Self::Null) => true,
            (Self::Bool(left), Self::Bool(right)) => left == right,
            (Self::Number(left), Self::Number(right)) => left == right,
            (Self::String(left), Self::String(right)) => left == right,
            (Self::Json(left), Self::Json(right)) => std::ptr::eq(*left, *right),
            (Self::Array(left), Self::Array(right)) => std::rc::Rc::ptr_eq(left, right),
            (Self::Object(left), Self::Object(right)) => std::rc::Rc::ptr_eq(left, right),
            _ => false,
        }
    }

    fn abstract_equal(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Null, Self::Undefined) | (Self::Undefined, Self::Null) => true,
            (Self::Number(_), Self::String(_)) | (Self::String(_), Self::Number(_)) => {
                self.number() == other.number()
            }
            (Self::Bool(_), _) => Self::Number(self.number()).abstract_equal(other),
            (_, Self::Bool(_)) => self.abstract_equal(&Self::Number(other.number())),
            (
                Self::Json(_) | Self::Array(_) | Self::Object(_),
                Self::String(_) | Self::Number(_),
            ) => self.primitive().abstract_equal(other),
            (
                Self::String(_) | Self::Number(_),
                Self::Json(_) | Self::Array(_) | Self::Object(_),
            ) => self.abstract_equal(&other.primitive()),
            _ => self.strict_equal(other),
        }
    }

    fn member(&self, key: &str) -> Result<Self, MarkupError> {
        Ok(match self {
            Self::Json(value) => match *value {
                Value::Object(values) => values
                    .get(key)
                    .map(Self::from_json)
                    .unwrap_or(Self::Undefined),
                Value::Array(values) if key == "length" => Self::Number(values.len() as f64),
                Value::Array(values) => expression_array_index(key)
                    .and_then(|index| values.get(index))
                    .map(Self::from_json)
                    .unwrap_or(Self::Undefined),
                _ => unreachable!("only JSON objects and arrays stay borrowed"),
            },
            Self::Object(values) => values.get(key).cloned().unwrap_or(Self::Undefined),
            Self::Array(values) if key == "length" => Self::Number(values.len() as f64),
            Self::Array(values) => expression_array_index(key)
                .and_then(|index| values.get(index))
                .cloned()
                .unwrap_or(Self::Undefined),
            Self::String(value) if key == "length" => {
                Self::Number(value.encode_utf16().count() as f64)
            }
            Self::String(value) => {
                if let Some(unit) =
                    expression_array_index(key).and_then(|index| value.encode_utf16().nth(index))
                {
                    let character = char::from_u32(u32::from(unit)).ok_or_else(|| {
                        expression_error(
                            0,
                            "UTF-16 surrogate index cannot be represented in WXML JSON",
                        )
                    })?;
                    Self::String(character.to_string())
                } else {
                    Self::Undefined
                }
            }
            _ => Self::Undefined,
        })
    }
}

fn expression_array_index(key: &str) -> Option<usize> {
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index as usize)
}

fn expression_number_string(number: f64) -> String {
    if number == 0.0 {
        return "0".into();
    }
    if number.is_nan() {
        return "NaN".into();
    }
    if number == f64::INFINITY {
        return "Infinity".into();
    }
    if number == f64::NEG_INFINITY {
        return "-Infinity".into();
    }
    if number.abs() >= 1e21 || number.abs() < 1e-6 {
        let scientific = format!("{number:e}");
        if let Some((coefficient, exponent)) = scientific.split_once('e') {
            let exponent = exponent.parse::<i32>().unwrap_or(0);
            return format!(
                "{coefficient}e{}{exponent}",
                if exponent >= 0 { "+" } else { "" }
            );
        }
    }
    number.to_string()
}

fn expression_string_number(source: &str) -> f64 {
    let source =
        source.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}');
    if source.is_empty() {
        return 0.0;
    }
    if matches!(source, "Infinity" | "+Infinity") {
        return f64::INFINITY;
    }
    if source == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    let radix = if source.starts_with("0x") || source.starts_with("0X") {
        Some(16)
    } else if source.starts_with("0b") || source.starts_with("0B") {
        Some(2)
    } else if source.starts_with("0o") || source.starts_with("0O") {
        Some(8)
    } else {
        None
    };
    if let Some(radix) = radix {
        if source.len() == 2 {
            return f64::NAN;
        }
        return source[2..]
            .chars()
            .try_fold(0.0, |value, character| {
                character
                    .to_digit(radix)
                    .map(|digit| value * f64::from(radix) + f64::from(digit))
            })
            .unwrap_or(f64::NAN);
    }
    // Rust also accepts inf/-inf, which are not JavaScript numeric strings.
    if source
        .chars()
        .any(|character| character.is_alphabetic() && character != 'e' && character != 'E')
    {
        return f64::NAN;
    }
    source.parse().unwrap_or(f64::NAN)
}

impl Expression {
    fn evaluate<'a>(
        &self,
        context: &'a Map<String, Value>,
        depth: usize,
    ) -> Result<ExpressionValue<'a>, MarkupError> {
        if depth >= MAX_EXPRESSION_DEPTH {
            return Err(expression_error(
                0,
                "WXML expression exceeds the maximum evaluation depth",
            ));
        }
        let evaluate = |expression: &Self| expression.evaluate(context, depth + 1);
        Ok(match self {
            Self::Literal(value) => value.value(),
            Self::Variable(name) => context
                .get(name)
                .map(ExpressionValue::from_json)
                .unwrap_or(ExpressionValue::Undefined),
            Self::Unary(operator, operand) => {
                let value = evaluate(operand)?;
                match *operator {
                    "!" => ExpressionValue::Bool(!value.truthy()),
                    "+" => ExpressionValue::Number(value.number()),
                    "-" => ExpressionValue::Number(-value.number()),
                    _ => unreachable!("parser restricts unary operators"),
                }
            }
            Self::Binary(operator, left, right) => {
                let left = evaluate(left)?;
                match *operator {
                    "&&" if !left.truthy() => left,
                    "||" if left.truthy() => left,
                    "&&" | "||" => evaluate(right)?,
                    _ => evaluate_expression_binary(operator, left, evaluate(right)?),
                }
            }
            Self::Conditional(condition, consequent, alternate) => {
                if evaluate(condition)?.truthy() {
                    evaluate(consequent)?
                } else {
                    evaluate(alternate)?
                }
            }
            Self::Member(object, key) => evaluate(object)?.member(&evaluate(key)?.string())?,
            Self::Array(entries) => {
                let mut values = Vec::new();
                for entry in entries {
                    match entry {
                        ExpressionArrayEntry::Hole => values.push(ExpressionValue::Undefined),
                        ExpressionArrayEntry::Value(expression) => {
                            values.push(evaluate(expression)?)
                        }
                        ExpressionArrayEntry::Spread(expression) => match evaluate(expression)? {
                            ExpressionValue::Array(entries) => {
                                values.extend(entries.iter().cloned())
                            }
                            ExpressionValue::Json(Value::Array(entries)) => {
                                values.extend(entries.iter().map(ExpressionValue::from_json))
                            }
                            ExpressionValue::String(value) => {
                                values.extend(value.chars().map(|character| {
                                    ExpressionValue::String(character.to_string())
                                }))
                            }
                            _ => {
                                return Err(expression_error(
                                    0,
                                    "WXML array spread requires an array or string",
                                ))
                            }
                        },
                    }
                }
                ExpressionValue::Array(std::rc::Rc::new(values))
            }
            Self::Object(entries) => {
                let mut values = BTreeMap::new();
                for entry in entries {
                    match entry {
                        ExpressionObjectEntry::Value(key, expression) => {
                            values.insert(evaluate(key)?.string(), evaluate(expression)?);
                        }
                        ExpressionObjectEntry::Spread(expression) => match evaluate(expression)? {
                            ExpressionValue::Object(entries) => values.extend(
                                entries
                                    .iter()
                                    .map(|(key, value)| (key.clone(), value.clone())),
                            ),
                            ExpressionValue::Json(Value::Object(entries)) => {
                                values.extend(entries.iter().map(|(key, value)| {
                                    (key.clone(), ExpressionValue::from_json(value))
                                }))
                            }
                            ExpressionValue::Json(Value::Array(entries)) => {
                                values.extend(entries.iter().enumerate().map(|(index, value)| {
                                    (index.to_string(), ExpressionValue::from_json(value))
                                }))
                            }
                            ExpressionValue::Array(entries) => values.extend(
                                entries
                                    .iter()
                                    .enumerate()
                                    .map(|(index, value)| (index.to_string(), value.clone())),
                            ),
                            ExpressionValue::String(value) => {
                                for (index, unit) in value.encode_utf16().enumerate() {
                                    let character = char::from_u32(u32::from(unit)).ok_or_else(|| expression_error(0, "UTF-16 string spread cannot be represented in WXML JSON"))?;
                                    values.insert(
                                        index.to_string(),
                                        ExpressionValue::String(character.to_string()),
                                    );
                                }
                            }
                            _ => {}
                        },
                    }
                }
                ExpressionValue::Object(std::rc::Rc::new(values))
            }
        })
    }
}

fn evaluate_expression_binary<'a>(
    operator: &str,
    left: ExpressionValue<'a>,
    right: ExpressionValue<'a>,
) -> ExpressionValue<'a> {
    match operator {
        "===" => ExpressionValue::Bool(left.strict_equal(&right)),
        "!==" => ExpressionValue::Bool(!left.strict_equal(&right)),
        "==" => ExpressionValue::Bool(left.abstract_equal(&right)),
        "!=" => ExpressionValue::Bool(!left.abstract_equal(&right)),
        "<" | "<=" | ">" | ">=" => {
            let left = left.primitive();
            let right = right.primitive();
            let comparison = match (&left, &right) {
                (ExpressionValue::String(left), ExpressionValue::String(right)) => {
                    Some(left.encode_utf16().cmp(right.encode_utf16()))
                }
                _ => left.number().partial_cmp(&right.number()),
            };
            ExpressionValue::Bool(match comparison {
                Some(std::cmp::Ordering::Less) => operator == "<" || operator == "<=",
                Some(std::cmp::Ordering::Equal) => operator == "<=" || operator == ">=",
                Some(std::cmp::Ordering::Greater) => operator == ">" || operator == ">=",
                None => false,
            })
        }
        "+" => {
            let left = left.primitive();
            let right = right.primitive();
            if matches!(left, ExpressionValue::String(_))
                || matches!(right, ExpressionValue::String(_))
            {
                ExpressionValue::String(format!("{}{}", left.string(), right.string()))
            } else {
                ExpressionValue::Number(left.number() + right.number())
            }
        }
        "-" => ExpressionValue::Number(left.number() - right.number()),
        "*" => ExpressionValue::Number(left.number() * right.number()),
        "/" => ExpressionValue::Number(left.number() / right.number()),
        "%" => ExpressionValue::Number(left.number() % right.number()),
        _ => unreachable!("parser restricts binary operators"),
    }
}

fn has_duplicate_bindings(values: &[String]) -> bool {
    let mut seen = std::collections::HashSet::new();
    values.iter().any(|value| !seen.insert(value))
}

fn bindings_in(value: &str) -> Vec<String> {
    let mut output = std::collections::BTreeSet::new();
    let mut rest = value;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = find_mustache_end(after) else {
            break;
        };
        let expression = after[..end].trim();
        if !expression.is_empty() {
            output.insert(expression.to_owned());
        }
        rest = &after[end + 2..];
    }
    output.into_iter().collect()
}

struct WxmlParser<'a> {
    source: &'a str,
    pos: usize,
}

impl<'a> WxmlParser<'a> {
    fn new(source: &'a str) -> Self {
        Self { source, pos: 0 }
    }

    fn parse_nodes(&mut self, closing: Option<&str>) -> Result<Vec<WxmlNode>, MarkupError> {
        let mut nodes = Vec::new();
        while self.pos < self.source.len() {
            if self.source[self.pos..].starts_with("</") {
                let (name, end) = self.parse_close_tag()?;
                if let Some(expected) = closing {
                    if name != expected {
                        return Err(MarkupError::MismatchedClosing {
                            expected: expected.to_owned(),
                            actual: name,
                        });
                    }
                    self.pos = end;
                    return Ok(nodes);
                }
                return Err(MarkupError::InvalidSyntax {
                    offset: self.pos,
                    message: format!("unexpected closing tag </{name}>"),
                });
            }
            if self.source.as_bytes()[self.pos] == b'<' {
                if self.source[self.pos..].starts_with("<!--") {
                    let start = self.pos + 4;
                    let Some(relative) = self.source[start..].find("-->") else {
                        return Err(MarkupError::UnexpectedEof {
                            context: "WXML comment",
                        });
                    };
                    let end = start + relative;
                    nodes.push(WxmlNode::Comment {
                        value: self.source[start..end].to_owned(),
                        lexical_origin: None,
                    });
                    self.pos = end + 3;
                    continue;
                }
                let (tag, attrs, self_closing, end) = self.parse_open_tag()?;
                self.pos = end;
                let bindings = attrs
                    .values()
                    .flat_map(|value| bindings_in(value))
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect();
                let directives = WxmlDirectives::from_attrs(&attrs);
                let children = if self_closing || is_void_wxml_tag(&tag) {
                    Vec::new()
                } else if tag == "wxs" {
                    self.parse_raw_text(&tag)?
                } else {
                    self.parse_nodes(Some(&tag))?
                };
                nodes.push(WxmlNode::Element {
                    tag,
                    lexical_origin: None,
                    attrs,
                    bound_values: BTreeMap::new(),
                    bindings,
                    directives,
                    key: None,
                    key_scope: None,
                    source_site: None,
                    children,
                });
            } else {
                let start = self.pos;
                let end = self.source[self.pos..]
                    .find('<')
                    .map(|offset| self.pos + offset)
                    .unwrap_or(self.source.len());
                self.pos = end;
                let value = self.source[start..end].to_owned();
                if !value.is_empty() {
                    nodes.push(WxmlNode::Text {
                        bindings: bindings_in(&value),
                        value,
                        lexical_origin: None,
                    });
                }
            }
        }
        if let Some(expected) = closing {
            return Err(MarkupError::UnexpectedEof {
                context: if expected.is_empty() {
                    "WXML"
                } else {
                    "WXML element"
                },
            });
        }
        Ok(nodes)
    }

    fn parse_raw_text(&mut self, closing: &str) -> Result<Vec<WxmlNode>, MarkupError> {
        let start = self.pos;
        let bytes = self.source.as_bytes();
        let mut search = start;
        while let Some(relative) = self.source[search..].find("</") {
            let end = search + relative;
            let mut cursor = end + 2;
            while cursor < bytes.len() && is_markup_whitespace(bytes[cursor]) {
                cursor += 1;
            }
            if self.source[cursor..].starts_with(closing) {
                cursor += closing.len();
                while cursor < bytes.len() && is_markup_whitespace(bytes[cursor]) {
                    cursor += 1;
                }
                if bytes.get(cursor) == Some(&b'>') {
                    // WXS has a raw-text boundary: apparent tags and moustache
                    // expressions in its source are not WXML nodes or bindings.
                    let value = self.source[start..end].to_owned();
                    self.pos = cursor + 1;
                    return Ok(if value.is_empty() {
                        Vec::new()
                    } else {
                        vec![WxmlNode::Text {
                            value,
                            bindings: Vec::new(),
                            lexical_origin: None,
                        }]
                    });
                }
            }
            search = end + 2;
        }
        Err(MarkupError::UnexpectedEof {
            context: "WXML raw text element",
        })
    }

    fn parse_open_tag(
        &self,
    ) -> Result<(String, BTreeMap<String, String>, bool, usize), MarkupError> {
        let bytes = self.source.as_bytes();
        let mut cursor = self.pos + 1;
        while cursor < bytes.len() && is_markup_whitespace(bytes[cursor]) {
            cursor += 1;
        }
        let name_start = cursor;
        while cursor < bytes.len() && !is_tag_delimiter(bytes[cursor]) {
            cursor += 1;
        }
        if name_start == cursor {
            return Err(MarkupError::InvalidSyntax {
                offset: self.pos,
                message: "missing WXML tag name".into(),
            });
        }
        let tag = self.source[name_start..cursor].to_owned();
        let mut attrs = BTreeMap::new();
        let mut self_closing = false;
        loop {
            while cursor < bytes.len() && is_markup_whitespace(bytes[cursor]) {
                cursor += 1;
            }
            if cursor >= bytes.len() {
                return Err(MarkupError::UnexpectedEof {
                    context: "WXML opening tag",
                });
            }
            if bytes[cursor] == b'>' {
                cursor += 1;
                break;
            }
            if bytes[cursor] == b'/' && cursor + 1 < bytes.len() && bytes[cursor + 1] == b'>' {
                self_closing = true;
                cursor += 2;
                break;
            }
            let attr_start = cursor;
            while cursor < bytes.len() && !is_attr_delimiter(bytes[cursor]) {
                cursor += 1;
            }
            if attr_start == cursor {
                return Err(MarkupError::InvalidSyntax {
                    offset: cursor,
                    message: "invalid WXML attribute".into(),
                });
            }
            let name = self.source[attr_start..cursor].to_owned();
            while cursor < bytes.len() && is_markup_whitespace(bytes[cursor]) {
                cursor += 1;
            }
            let value = if cursor < bytes.len() && bytes[cursor] == b'=' {
                cursor += 1;
                while cursor < bytes.len() && is_markup_whitespace(bytes[cursor]) {
                    cursor += 1;
                }
                if cursor >= bytes.len() {
                    return Err(MarkupError::UnexpectedEof {
                        context: "WXML attribute value",
                    });
                }
                let quote = bytes[cursor];
                if quote == b'\'' || quote == b'"' {
                    cursor += 1;
                    let value_start = cursor;
                    while cursor < bytes.len() && bytes[cursor] != quote {
                        cursor += 1;
                    }
                    if cursor >= bytes.len() {
                        return Err(MarkupError::UnexpectedEof {
                            context: "WXML quoted attribute",
                        });
                    }
                    let value = self.source[value_start..cursor].to_owned();
                    cursor += 1;
                    value
                } else {
                    let value_start = cursor;
                    while cursor < bytes.len()
                        && !is_markup_whitespace(bytes[cursor])
                        && bytes[cursor] != b'>'
                    {
                        cursor += 1;
                    }
                    self.source[value_start..cursor].to_owned()
                }
            } else {
                String::new()
            };
            if attrs.insert(name.clone(), value).is_some() {
                return Err(MarkupError::DuplicateAttribute(name));
            }
        }
        Ok((tag, attrs, self_closing, cursor))
    }

    fn parse_close_tag(&self) -> Result<(String, usize), MarkupError> {
        let bytes = self.source.as_bytes();
        let mut cursor = self.pos + 2;
        while cursor < bytes.len() && is_markup_whitespace(bytes[cursor]) {
            cursor += 1;
        }
        let start = cursor;
        while cursor < bytes.len() && bytes[cursor] != b'>' && !is_markup_whitespace(bytes[cursor])
        {
            cursor += 1;
        }
        let name = self.source[start..cursor].to_owned();
        while cursor < bytes.len() && bytes[cursor] != b'>' {
            cursor += 1;
        }
        if start == cursor || cursor >= bytes.len() {
            return Err(MarkupError::UnexpectedEof {
                context: "WXML closing tag",
            });
        }
        Ok((name, cursor + 1))
    }
}

fn is_markup_whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\n' | b'\r' | b'\t')
}

fn is_tag_delimiter(byte: u8) -> bool {
    is_markup_whitespace(byte) || matches!(byte, b'/' | b'>')
}

fn is_attr_delimiter(byte: u8) -> bool {
    is_markup_whitespace(byte) || matches!(byte, b'=' | b'/' | b'>')
}

fn is_void_wxml_tag(tag: &str) -> bool {
    matches!(
        tag,
        "input"
            | "image"
            | "icon"
            | "progress"
            | "checkbox"
            | "radio"
            | "switch"
            | "slider"
            | "camera"
            | "live-player"
            | "live-pusher"
    )
}

struct CssParser<'a> {
    source: &'a str,
    pos: usize,
}

impl<'a> CssParser<'a> {
    fn new(source: &'a str) -> Self {
        Self { source, pos: 0 }
    }

    fn parse_document(&mut self) -> Result<WxssIr, MarkupError> {
        Ok(WxssIr {
            rules: self.parse_rules()?,
            ..WxssIr::default()
        })
    }

    fn parse_rules(&mut self) -> Result<Vec<WxssRule>, MarkupError> {
        let mut rules = Vec::new();
        while self.pos < self.source.len() {
            self.skip_ws_comments()?;
            if self.pos >= self.source.len() {
                break;
            }
            let start = self.pos;
            let Some((delimiter, index)) = self.find_top_level(b"{;}") else {
                return Err(MarkupError::UnexpectedEof {
                    context: "WXSS rule",
                });
            };
            let prelude = self.source[start..index].trim().to_owned();
            self.pos = index + 1;
            match delimiter {
                b'}' => {
                    return Err(MarkupError::InvalidSyntax {
                        offset: index,
                        message: "unexpected closing brace".into(),
                    });
                }
                b';' => {
                    if prelude.is_empty() {
                        continue;
                    }
                    let Some(keyword) = wxss_at_keyword(&prelude) else {
                        return Err(MarkupError::InvalidSyntax {
                            offset: start,
                            message: format!("unsupported top-level WXSS statement: {prelude}"),
                        });
                    };
                    if keyword.eq_ignore_ascii_case("import") && prelude[7..].trim().is_empty() {
                        return Err(MarkupError::InvalidSyntax {
                            offset: start,
                            message: "WXSS @import requires a prelude".into(),
                        });
                    }
                    rules.push(WxssRule {
                        selectors: Vec::new(),
                        declarations: Vec::new(),
                        nested: Vec::new(),
                        at_rule: Some(prelude),
                    });
                }
                b'{' => {
                    let block_start = self.pos;
                    let block_end = find_matching_brace(self.source, block_start)?;
                    let body = &self.source[block_start..block_end];
                    if prelude.starts_with('@') {
                        let Some(keyword) = wxss_at_keyword(&prelude) else {
                            return Err(MarkupError::InvalidSyntax {
                                offset: start,
                                message: format!("invalid WXSS at-rule: {prelude}"),
                            });
                        };
                        if keyword.eq_ignore_ascii_case("import") {
                            return Err(MarkupError::InvalidSyntax {
                                offset: start,
                                message: "WXSS @import cannot have a block".into(),
                            });
                        }
                        // Group bodies retain nested statements, even when
                        // they contain only an import or another semicolon
                        // at-rule. Descriptor bodies such as @font-face must
                        // never go through the rule-list parser first.
                        let is_group = is_wxss_group_at_rule(keyword)
                            || has_top_level_brace(body)
                            || body.trim_start().starts_with('@');
                        let (declarations, nested) = if is_group {
                            (Vec::new(), CssParser::new(body).parse_rules()?)
                        } else {
                            (parse_declarations(body)?, Vec::new())
                        };
                        rules.push(WxssRule {
                            selectors: Vec::new(),
                            declarations,
                            nested,
                            at_rule: Some(prelude),
                        });
                    } else {
                        let declarations = parse_declarations(body)?;
                        rules.push(WxssRule {
                            selectors: split_selectors(&prelude),
                            declarations,
                            nested: Vec::new(),
                            at_rule: None,
                        });
                    }
                    self.pos = block_end + 1;
                }
                _ => unreachable!(),
            }
        }
        Ok(rules)
    }

    fn skip_ws_comments(&mut self) -> Result<(), MarkupError> {
        loop {
            while self.pos < self.source.len()
                && self.source.as_bytes()[self.pos].is_ascii_whitespace()
            {
                self.pos += 1;
            }
            if self.source[self.pos..].starts_with("/*") {
                if let Some(end) = self.source[self.pos + 2..].find("*/") {
                    self.pos += end + 4;
                    continue;
                }
                return Err(MarkupError::UnexpectedEof {
                    context: "WXSS comment",
                });
            }
            break;
        }
        Ok(())
    }

    fn find_top_level(&self, delimiters: &[u8]) -> Option<(u8, usize)> {
        let bytes = self.source.as_bytes();
        let mut quote = None;
        let mut paren_depth = 0usize;
        let mut index = self.pos;
        while index < bytes.len() {
            let byte = bytes[index];
            if let Some(current) = quote {
                if byte == b'\\' {
                    index += 2;
                    continue;
                }
                if byte == current {
                    quote = None;
                }
            } else if byte == b'\'' || byte == b'"' {
                quote = Some(byte);
            } else if byte == b'(' {
                paren_depth += 1;
            } else if byte == b')' {
                paren_depth = paren_depth.saturating_sub(1);
            } else if paren_depth == 0 && delimiters.contains(&byte) {
                return Some((byte, index));
            }
            index += 1;
        }
        None
    }
}

/// Read exactly the at-keyword's identifier, not an arbitrary @import prefix.
/// This intentionally matches the manifest packer's preserved keyword subset.
fn wxss_at_keyword(prelude: &str) -> Option<&str> {
    let bytes = prelude.as_bytes();
    if bytes.first() != Some(&b'@')
        || !bytes
            .get(1)
            .is_some_and(|byte| byte.is_ascii_alphabetic() || matches!(*byte, b'_' | b'-'))
    {
        return None;
    }
    let mut end = 2;
    while bytes
        .get(end)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'))
    {
        end += 1;
    }
    Some(&prelude[1..end])
}

fn is_wxss_group_at_rule(keyword: &str) -> bool {
    matches!(
        keyword.to_ascii_lowercase().as_str(),
        "media"
            | "supports"
            | "container"
            | "layer"
            | "document"
            | "scope"
            | "keyframes"
            | "-webkit-keyframes"
            | "starting-style"
    )
}

fn strip_wxss_comments(source: &str) -> Result<String, MarkupError> {
    let mut output = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut quote = None;
    while let Some(character) = chars.next() {
        if let Some(current) = quote {
            output.push(character);
            if character == '\\' {
                if let Some(escaped) = chars.next() {
                    output.push(escaped);
                }
            } else if character == current {
                quote = None;
            }
        } else if character == '\'' || character == '"' {
            quote = Some(character);
            output.push(character);
        } else if character == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut terminated = false;
            while let Some(comment_character) = chars.next() {
                if comment_character == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    terminated = true;
                    break;
                }
            }
            if !terminated {
                return Err(MarkupError::UnexpectedEof {
                    context: "WXSS comment",
                });
            }
            output.push(' ');
        } else {
            output.push(character);
        }
    }
    Ok(output)
}

fn find_matching_brace(source: &str, start: usize) -> Result<usize, MarkupError> {
    let bytes = source.as_bytes();
    let mut depth = 1usize;
    let mut quote = None;
    let mut index = start;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(current) = quote {
            if byte == b'\\' {
                index += 2;
                continue;
            }
            if byte == current {
                quote = None;
            }
        } else if byte == b'\'' || byte == b'"' {
            quote = Some(byte);
        } else if bytes[index..].starts_with(b"/*") {
            if let Some(end) = source[index + 2..].find("*/") {
                index += end + 4;
                continue;
            }
            return Err(MarkupError::UnexpectedEof {
                context: "WXSS comment",
            });
        } else if byte == b'{' {
            depth += 1;
        } else if byte == b'}' {
            depth -= 1;
            if depth == 0 {
                return Ok(index);
            }
        }
        index += 1;
    }
    Err(MarkupError::UnexpectedEof {
        context: "WXSS block",
    })
}

fn split_selectors(prelude: &str) -> Vec<String> {
    let mut selectors = Vec::new();
    let mut start = 0usize;
    let mut quote = None;
    let mut parens = 0usize;
    for (index, byte) in prelude.as_bytes().iter().copied().enumerate() {
        if let Some(current) = quote {
            if byte == current {
                quote = None;
            }
        } else if byte == b'\'' || byte == b'"' {
            quote = Some(byte);
        } else if byte == b'(' {
            parens += 1;
        } else if byte == b')' {
            parens = parens.saturating_sub(1);
        } else if byte == b',' && parens == 0 {
            let selector = prelude[start..index].trim();
            if !selector.is_empty() {
                selectors.push(selector.to_owned());
            }
            start = index + 1;
        }
    }
    let selector = prelude[start..].trim();
    if !selector.is_empty() {
        selectors.push(selector.to_owned());
    }
    selectors
}

fn has_top_level_brace(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut quote = None;
    let mut parens = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(current) = quote {
            if byte == b'\\' {
                index += 2;
                continue;
            }
            if byte == current {
                quote = None;
            }
        } else if byte == b'\'' || byte == b'"' {
            quote = Some(byte);
        } else if byte == b'(' {
            parens += 1;
        } else if byte == b')' {
            parens = parens.saturating_sub(1);
        } else if parens == 0 && byte == b'{' {
            return true;
        }
        index += 1;
    }
    false
}

/// Parse an inline style declaration list with CSS-style error recovery.
/// Invalid declarations are ignored individually, while quoted strings,
/// functions, escapes and comments cannot split a declaration prematurely.
pub fn parse_inline_wxss(source: &str) -> Vec<WxssDeclaration> {
    let mut declarations = Vec::new();
    for fragment in declaration_fragments(source, false).unwrap_or_default() {
        let _ = push_declaration(&fragment, &mut declarations);
    }
    declarations
}

fn parse_declarations(source: &str) -> Result<Vec<WxssDeclaration>, MarkupError> {
    let mut declarations = Vec::new();
    for fragment in declaration_fragments(source, true)? {
        push_declaration(&fragment, &mut declarations)?;
    }
    Ok(declarations)
}

fn declaration_fragments(source: &str, strict: bool) -> Result<Vec<String>, MarkupError> {
    let mut fragments = Vec::new();
    let mut fragment = String::new();
    let mut quote = None;
    let mut parens = 0usize;
    let mut chars = source.chars().peekable();
    while let Some(character) = chars.next() {
        if let Some(current) = quote {
            fragment.push(character);
            if character == '\\' {
                if let Some(escaped) = chars.next() {
                    fragment.push(escaped);
                }
            } else if character == current {
                quote = None;
            }
        } else if character == '/' && chars.peek() == Some(&'*') {
            chars.next();
            // A comment separates CSS tokens; deleting it outright would
            // turn `solid/**/red` into a different identifier and join RGB
            // channels separated by comments.
            fragment.push(' ');
            let mut closed = false;
            while let Some(comment) = chars.next() {
                if comment == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    closed = true;
                    break;
                }
            }
            if !closed && strict {
                return Err(MarkupError::UnexpectedEof {
                    context: "WXSS comment",
                });
            }
        } else if character == '\\' {
            fragment.push(character);
            if let Some(escaped) = chars.next() {
                fragment.push(escaped);
            }
        } else if character == ';' && parens == 0 {
            fragments.push(std::mem::take(&mut fragment));
        } else {
            fragment.push(character);
            match character {
                '\'' | '"' => quote = Some(character),
                '(' => parens += 1,
                ')' => parens = parens.saturating_sub(1),
                _ => {}
            }
        }
    }
    if quote.is_none() && parens == 0 {
        fragments.push(fragment);
    } else if strict {
        return Err(MarkupError::UnexpectedEof {
            context: "WXSS declaration",
        });
    }
    Ok(fragments)
}

fn push_declaration(source: &str, output: &mut Vec<WxssDeclaration>) -> Result<(), MarkupError> {
    let source = source.trim();
    if source.is_empty() {
        return Ok(());
    }
    let Some(colon) = source.find(':') else {
        return Err(MarkupError::InvalidSyntax {
            offset: 0,
            message: format!("WXSS declaration has no colon: {source}"),
        });
    };
    let property = source[..colon].trim();
    if !property
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(MarkupError::InvalidSyntax {
            offset: 0,
            message: "invalid WXSS property".into(),
        });
    }
    let mut value = source[colon + 1..].trim().to_owned();
    if property.is_empty() || value.is_empty() {
        return Err(MarkupError::InvalidSyntax {
            offset: 0,
            message: "WXSS declaration requires property and value".into(),
        });
    }
    let important_start = value
        .rfind('!')
        .filter(|index| value[index + 1..].trim().eq_ignore_ascii_case("important"));
    let important = important_start.is_some();
    if let Some(index) = important_start {
        value.truncate(index);
        value = value.trim_end().to_owned();
    }
    if value.is_empty() {
        return Err(MarkupError::InvalidSyntax {
            offset: 0,
            message: "WXSS declaration requires value".into(),
        });
    }
    output.push(WxssDeclaration {
        property: if property.starts_with("--") {
            property.to_owned()
        } else {
            property.to_ascii_lowercase()
        },
        value,
        important,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_wxml_and_bindings_deterministically() {
        let ast = parse_wxml(r#"<view id="root" class="{{klass}}"><text>{{ title }}</text><image src="/a.png" /></view>"#).unwrap();
        assert_eq!(ast.version, 1);
        assert_eq!(ast.nodes.len(), 1);
        let WxmlNode::Element {
            tag,
            attrs,
            bindings,
            children,
            ..
        } = &ast.nodes[0]
        else {
            panic!("expected element")
        };
        assert_eq!(tag, "view");
        assert_eq!(attrs["id"], "root");
        assert_eq!(bindings, &["klass"]);
        assert_eq!(children.len(), 2);
        assert_eq!(wxml_bindings(&ast), vec!["klass", "title"]);
    }

    #[test]
    fn wxs_raw_text_matches_the_packer_source_contract_without_bindings() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../tools/container-manifest/test/fixtures/wxml-wxs-raw-v1.json"
        ))
        .unwrap();
        let parsed = parse_wxml(contract["source"].as_str().unwrap()).unwrap();
        let structured = decode_wxml(&serde_json::to_vec(&contract["ast"]).unwrap()).unwrap();
        assert_eq!(parsed, structured);
        assert_eq!(wxml_bindings(&parsed), vec!["script.label"]);
        let WxmlNode::Element { children, .. } = &parsed.nodes[0] else {
            panic!("expected outer element")
        };
        let WxmlNode::Element { children, .. } = &children[0] else {
            panic!("expected WXS element")
        };
        assert_eq!(children.len(), 1);
        let WxmlNode::Text {
            value, bindings, ..
        } = &children[0]
        else {
            panic!("expected one raw script text node")
        };
        assert!(value.starts_with("\r\n  var label = \"微信 🧪"));
        assert!(value.ends_with("\r\n\t"));
        assert!(bindings.is_empty());
    }

    #[test]
    fn wxs_empty_whitespace_and_external_bodies_keep_their_boundaries() {
        let parsed = parse_wxml(
            "<wxs module=\"empty\"></wxs><wxs module=\"space\"> \r\n\t</wxs \t><wxs module=\"external\" src=\"./helper.wxs\"/><text>{{value}}</text>",
        )
        .unwrap();
        let WxmlNode::Element { children, .. } = &parsed.nodes[0] else {
            panic!("expected empty WXS element")
        };
        assert!(children.is_empty());
        let WxmlNode::Element { children, .. } = &parsed.nodes[1] else {
            panic!("expected whitespace WXS element")
        };
        assert_eq!(
            children,
            &[WxmlNode::Text {
                value: " \r\n\t".into(),
                bindings: Vec::new(),
                lexical_origin: None,
            }]
        );
        let WxmlNode::Element {
            attrs, children, ..
        } = &parsed.nodes[2]
        else {
            panic!("expected external WXS element")
        };
        assert_eq!(attrs["src"], "./helper.wxs");
        assert!(children.is_empty());
        assert_eq!(wxml_bindings(&parsed), vec!["value"]);
    }

    #[test]
    fn wxs_requires_its_own_complete_closing_tag() {
        for source in [
            "<wxs module=\"x\">a < b",
            "<wxs module=\"x\">\"</view>\"</wxs-extra>",
            "<wxs module=\"x\">\"</wxs invalid>\"",
            "<wxs module=\"x\">source</wxs",
        ] {
            assert!(matches!(
                parse_wxml(source),
                Err(MarkupError::UnexpectedEof {
                    context: "WXML raw text element"
                })
            ));
        }
    }

    #[test]
    fn extracts_wxml_control_flow_and_event_directives() {
        let ast = parse_wxml(
            r#"<view wx:if="{{visible}}" wx:for="{{items}}" wx:for-item="entry" wx:key="id" bindtap="onTap" />"#,
        )
        .unwrap();
        let WxmlNode::Element { directives, .. } = &ast.nodes[0] else {
            panic!("expected element")
        };
        assert_eq!(directives.if_expr.as_deref(), Some("visible"));
        assert_eq!(directives.for_expr.as_deref(), Some("items"));
        assert_eq!(directives.for_item.as_deref(), Some("entry"));
        assert_eq!(directives.for_key.as_deref(), Some("id"));
        assert_eq!(directives.events.get("bindtap"), Some(&"onTap".to_owned()));
    }

    #[test]
    fn evaluates_wxml_conditionals_loops_and_interpolations() {
        let ast = parse_wxml(
            r#"<view><text wx:if="{{show}}">{{title}}</text><text wx:elif="{{fallback}}">fallback</text><text wx:else>hidden</text><view wx:for="{{items}}" wx:for-item="item"><text>{{item.name}}:{{index}}</text></view></view>"#,
        )
        .unwrap();
        let data = serde_json::json!({
            "show": false,
            "fallback": true,
            "title": "ignored",
            "items": [{"name": "a"}, {"name": "b"}]
        });
        let rendered = evaluate_wxml(&ast, &data).unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root")
        };
        assert_eq!(children.len(), 3);
        assert!(matches!(children[0], WxmlNode::Element { .. }));
        let WxmlNode::Element {
            children: first, ..
        } = &children[0]
        else {
            panic!("expected fallback text")
        };
        assert_eq!(
            first[0],
            WxmlNode::Text {
                value: "fallback".into(),
                bindings: vec![],
                lexical_origin: None,
            }
        );
        let WxmlNode::Element {
            children: loop_text,
            ..
        } = &children[1]
        else {
            panic!("expected first loop item")
        };
        let WxmlNode::Element {
            children: first_item,
            ..
        } = &loop_text[0]
        else {
            panic!("expected loop text element")
        };
        assert_eq!(
            first_item[0],
            WxmlNode::Text {
                value: "a:0".into(),
                bindings: vec!["index".into(), "item.name".into()],
                lexical_origin: None,
            }
        );
    }

    #[test]
    fn evaluates_wxml_member_length_index_arithmetic_and_ternary() {
        let ast = parse_wxml(
            r#"<view wx:if="{{items.length > 1 && count + 2 === 5}}"><text>{{items[1].name}}/{{ok ? 'yes' : 'no'}}</text></view>"#,
        )
        .unwrap();
        let data = serde_json::json!({
            "items": [{"name": "first"}, {"name": "second"}],
            "count": 3,
            "ok": true
        });
        let rendered = evaluate_wxml(&ast, &data).unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root")
        };
        let WxmlNode::Element { children: text, .. } = &children[0] else {
            panic!("expected text element")
        };
        assert_eq!(
            text[0],
            WxmlNode::Text {
                value: "second/yes".into(),
                bindings: vec!["items[1].name".into(), "ok ? 'yes' : 'no'".into(),],
                lexical_origin: None,
            }
        );
    }

    #[test]
    fn evaluates_dynamic_wxml_member_indices_and_nested_brackets() {
        let ast = parse_wxml(
            r#"<view><text>{{items[index].name}}/{{lookup[key]}}/{{matrix[row][column]}}</text></view>"#,
        )
        .unwrap();
        let rendered = evaluate_wxml(
            &ast,
            &serde_json::json!({
                "index": 1,
                "items": [{"name": "first"}, {"name": "second"}],
                "key": "selected",
                "lookup": {"selected": "mapped"},
                "row": 0,
                "column": 1,
                "matrix": [["a", "b"], ["c", "d"]]
            }),
        )
        .unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root element")
        };
        let WxmlNode::Element { children: text, .. } = &children[0] else {
            panic!("expected text element")
        };
        assert_eq!(
            text[0],
            WxmlNode::Text {
                value: "second/mapped/b".into(),
                bindings: vec![
                    "items[index].name".into(),
                    "lookup[key]".into(),
                    "matrix[row][column]".into(),
                ],
                lexical_origin: None,
            }
        );
    }

    #[test]
    fn dynamic_wxml_member_index_reports_empty_and_unterminated_access() {
        let empty = parse_wxml("<text>{{items[]}}</text>").unwrap();
        let error = evaluate_wxml(&empty, &serde_json::json!({"items": []})).unwrap_err();
        assert!(matches!(
            error,
            MarkupError::InvalidSyntax { message, .. }
                if message == "WXML member index cannot be empty"
        ));

        let unterminated = parse_wxml("<text>{{items[index}}</text>").unwrap();
        let error = evaluate_wxml(&unterminated, &serde_json::json!({"items": [], "index": 0}))
            .unwrap_err();
        assert!(matches!(
            error,
            MarkupError::InvalidSyntax { message, .. }
                if message == "unterminated WXML member index"
        ));
    }

    #[test]
    fn evaluates_parenthesized_indices_nested_conditionals_and_object_keys() {
        let ast = parse_wxml(
            r#"<view><text>{{items[(index + 1)].name}}/{{lookup['key-' + suffix]}}/{{ready ? (count >= 2 ? 'many' : 'few') : 'off'}}/{{(count + 1) * 2}}</text></view>"#,
        )
        .unwrap();
        let rendered = evaluate_wxml(
            &ast,
            &serde_json::json!({
                "index": 0,
                "items": [{"name": "first"}, {"name": "second"}],
                "lookup": {"key-selected": "mapped"},
                "suffix": "selected",
                "ready": true,
                "count": 2
            }),
        )
        .unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root element")
        };
        let WxmlNode::Element { children: text, .. } = &children[0] else {
            panic!("expected text element")
        };
        assert_eq!(
            text[0],
            WxmlNode::Text {
                value: "second/mapped/many/6".into(),
                bindings: vec![
                    "(count + 1) * 2".into(),
                    "items[(index + 1)].name".into(),
                    "lookup['key-' + suffix]".into(),
                    "ready ? (count >= 2 ? 'many' : 'few') : 'off'".into(),
                ],
                lexical_origin: None,
            }
        );
    }

    #[test]
    fn rejects_unbalanced_parenthesized_wxml_expression_structurally() {
        let ast = parse_wxml("<text>{{items[(index + 1]}}</text>").unwrap();
        let error = evaluate_wxml(&ast, &serde_json::json!({"items": [], "index": 0}))
            .expect_err("unbalanced member expression must fail");
        assert!(matches!(error, MarkupError::InvalidSyntax { .. }));
    }

    #[test]
    fn preserves_values_for_logical_binding_expressions() {
        let ast = parse_wxml(
            r#"<view><text>{{title || 'Untitled'}}</text><text>{{ready && title}}</text><text>{{missing && title}}</text></view>"#,
        )
        .unwrap();
        let rendered = evaluate_wxml(
            &ast,
            &serde_json::json!({"title": "Hello", "ready": true, "missing": false}),
        )
        .unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root")
        };
        let values = children
            .iter()
            .map(|node| {
                let WxmlNode::Element { children, .. } = node else {
                    panic!("expected text element")
                };
                let WxmlNode::Text { value, .. } = &children[0] else {
                    panic!("expected text node")
                };
                value.as_str()
            })
            .collect::<Vec<_>>();
        assert_eq!(values, vec!["Hello", "Hello", "false"]);
    }

    #[test]
    fn evaluates_wx_key_for_object_identity_and_reordered_arrays() {
        let ast = parse_wxml(
            r#"<view wx:for="{{items}}" wx:for-item="item" wx:key="id"><text>{{item.label}}</text></view>"#,
        )
        .unwrap();
        let first = evaluate_wxml(
            &ast,
            &serde_json::json!({
                "items": [
                    {"id": "a", "label": "first"},
                    {"id": "b", "label": "second"}
                ]
            }),
        )
        .unwrap();
        let second = evaluate_wxml(
            &ast,
            &serde_json::json!({
                "items": [
                    {"id": "b", "label": "second"},
                    {"id": "a", "label": "first"}
                ]
            }),
        )
        .unwrap();
        let keys = |ast: &WxmlAst| {
            ast.nodes
                .iter()
                .map(|node| match node {
                    WxmlNode::Element { key, .. } => key.clone(),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(keys(&first), vec![Some("a".into()), Some("b".into())]);
        assert_eq!(keys(&second), vec![Some("b".into()), Some("a".into())]);
    }

    #[test]
    fn evaluates_wx_key_star_this_for_primitive_items_and_normalizes_mustache() {
        let ast =
            parse_wxml(r#"<text wx:for="{{items}}" wx:key="{{*this}}">{{item}}</text>"#).unwrap();
        let WxmlNode::Element { directives, .. } = &ast.nodes[0] else {
            panic!("expected element")
        };
        assert_eq!(directives.for_key.as_deref(), Some("*this"));
        let rendered =
            evaluate_wxml(&ast, &serde_json::json!({"items": ["alpha", "beta"]})).unwrap();
        let keys = rendered
            .nodes
            .iter()
            .map(|node| match node {
                WxmlNode::Element { key, .. } => key.clone(),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(keys, vec![Some("alpha".into()), Some("beta".into())]);
    }

    #[test]
    fn conditional_chain_ignores_formatting_separators() {
        let ast = parse_wxml(
            "<view><text wx:if=\"{{show}}\">if</text>\n  <!-- branch -->\n  <text wx:else>else</text></view>",
        )
        .unwrap();
        let rendered = evaluate_wxml(&ast, &serde_json::json!({"show": false})).unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root")
        };
        assert!(children.iter().any(|node| {
            matches!(
                node,
                WxmlNode::Element { children, .. }
                    if matches!(children.first(), Some(WxmlNode::Text { value, .. }) if value == "else")
            )
        }));
        assert!(!children.iter().any(|node| {
            matches!(
                node,
                WxmlNode::Element { children, .. }
                    if matches!(children.first(), Some(WxmlNode::Text { value, .. }) if value == "if")
            )
        }));
    }

    #[test]
    fn resolves_wxml_include_and_named_template_calls() {
        let ast = parse_wxml(
            r#"<view><include src="partials/item.wxml"/><import src="template:rows.wxml"/><template is="{{which}}"/></view>"#,
        )
        .unwrap();
        let partial = parse_wxml(r#"<text>{{label}}</text>"#).unwrap();
        let named =
            parse_wxml(r#"<template name="row"><text>{{label}} row</text></template>"#).unwrap();
        let mut templates = BTreeMap::new();
        templates.insert("partials/item.wxml".into(), partial);
        templates.insert("template:rows.wxml".into(), named);
        let rendered = evaluate_wxml_with_templates(
            &ast,
            &serde_json::json!({"label": "first", "which": "row"}),
            &templates,
        )
        .unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root")
        };
        assert_eq!(children.len(), 2);
        assert!(matches!(children[0], WxmlNode::Element { .. }));
        let WxmlNode::Element { children: row, .. } = &children[1] else {
            panic!("expected template expansion")
        };
        assert_eq!(
            row[0],
            WxmlNode::Text {
                value: "first row".into(),
                bindings: vec!["label".into()],
                lexical_origin: Some(WxmlLexicalOrigin::from_document("rows.wxml").unwrap()),
            }
        );
    }

    #[test]
    fn resolves_imported_templates_without_rendering_import_nodes() {
        let ast = parse_wxml(
            r#"<view><import src="partials/templates.wxml"/><template is="row" data="{{item}}"/></view>"#,
        )
        .unwrap();
        let imported =
            parse_wxml(r#"<template name="row"><text class="row">{{name}}</text></template>"#)
                .unwrap();
        let templates = BTreeMap::from([("partials/templates.wxml".into(), imported)]);
        let rendered = evaluate_wxml_with_templates(
            &ast,
            &serde_json::json!({"item": {"name": "from-import"}}),
            &templates,
        )
        .unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root")
        };
        assert_eq!(children.len(), 1, "import declarations must not render");
        let WxmlNode::Element { children: row, .. } = &children[0] else {
            panic!("expected imported template output")
        };
        assert_eq!(
            row[0],
            WxmlNode::Text {
                value: "from-import".into(),
                bindings: vec!["name".into()],
                lexical_origin: Some(
                    WxmlLexicalOrigin::from_document("partials/templates.wxml").unwrap()
                ),
            }
        );
    }

    #[test]
    fn resolves_nested_imports_relative_to_declaring_wxml_file() {
        let root = parse_wxml(
            r#"<view><import src="pages/shared/templates.wxml"/><template is="row"/></view>"#,
        )
        .unwrap();
        let shared = parse_wxml(r#"<import src="./partials/rows.wxml"/>"#).unwrap();
        let rows = parse_wxml(r#"<template name="row"><text>{{label}}</text></template>"#).unwrap();
        let templates = BTreeMap::from([
            ("pages/shared/templates.wxml".into(), shared),
            ("pages/shared/partials/rows.wxml".into(), rows),
        ]);

        let rendered = evaluate_wxml_with_templates(
            &root,
            &serde_json::json!({"label": "nested"}),
            &templates,
        )
        .unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root element")
        };
        let WxmlNode::Element { children: row, .. } = &children[0] else {
            panic!("expected imported template output")
        };
        assert_eq!(
            row[0],
            WxmlNode::Text {
                value: "nested".into(),
                bindings: vec!["label".into()],
                lexical_origin: Some(
                    WxmlLexicalOrigin::from_document("pages/shared/partials/rows.wxml").unwrap()
                ),
            }
        );
    }

    #[test]
    fn resolves_nested_includes_relative_to_declaring_wxml_file() {
        let root =
            parse_wxml(r#"<view><include src="pages/shared/wrapper.wxml"/></view>"#).unwrap();
        let wrapper = parse_wxml(r#"<include src="./partials/item.wxml"/>"#).unwrap();
        let item = parse_wxml(r#"<text>{{label}}</text>"#).unwrap();
        let templates = BTreeMap::from([
            ("pages/shared/wrapper.wxml".into(), wrapper),
            ("pages/shared/partials/item.wxml".into(), item),
        ]);

        let rendered = evaluate_wxml_with_templates(
            &root,
            &serde_json::json!({"label": "included"}),
            &templates,
        )
        .unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root element")
        };
        let WxmlNode::Element { children: item, .. } = &children[0] else {
            panic!("expected included element")
        };
        assert_eq!(
            item[0],
            WxmlNode::Text {
                value: "included".into(),
                bindings: vec!["label".into()],
                lexical_origin: Some(
                    WxmlLexicalOrigin::from_document("pages/shared/partials/item.wxml").unwrap()
                ),
            }
        );
    }

    #[test]
    fn resolves_root_relative_import_when_source_path_is_supplied() {
        let root =
            parse_wxml(r#"<view><include src="../shared/partials/item.wxml"/></view>"#).unwrap();
        let item = parse_wxml(r#"<text>{{label}}</text>"#).unwrap();
        let templates = BTreeMap::from([("pages/shared/partials/item.wxml".into(), item)]);

        let rendered = evaluate_wxml_with_templates_from_source(
            &root,
            &serde_json::json!({"label": "root-relative"}),
            &templates,
            Some("pages/index/index.wxml"),
        )
        .unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root element")
        };
        let WxmlNode::Element { children: item, .. } = &children[0] else {
            panic!("expected included element")
        };
        assert_eq!(
            item[0],
            WxmlNode::Text {
                value: "root-relative".into(),
                bindings: vec!["label".into()],
                lexical_origin: Some(
                    WxmlLexicalOrigin::from_document("pages/shared/partials/item.wxml").unwrap()
                ),
            }
        );
    }

    #[test]
    fn resolves_relative_include_inside_imported_named_template() {
        let root = parse_wxml(
            r#"<view><import src="pages/shared/templates.wxml"/><template is="row"/></view>"#,
        )
        .unwrap();
        let shared =
            parse_wxml(r#"<template name="row"><include src="./partials/item.wxml"/></template>"#)
                .unwrap();
        let item = parse_wxml(r#"<text>{{label}}</text>"#).unwrap();
        let templates = BTreeMap::from([
            ("pages/shared/templates.wxml".into(), shared),
            ("pages/shared/partials/item.wxml".into(), item),
        ]);

        let rendered = evaluate_wxml_with_templates(
            &root,
            &serde_json::json!({"label": "template-include"}),
            &templates,
        )
        .unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root element")
        };
        let WxmlNode::Element { children: item, .. } = &children[0] else {
            panic!("expected named template output")
        };
        assert_eq!(
            item[0],
            WxmlNode::Text {
                value: "template-include".into(),
                bindings: vec!["label".into()],
                lexical_origin: Some(
                    WxmlLexicalOrigin::from_document("pages/shared/partials/item.wxml").unwrap()
                ),
            }
        );
    }

    #[test]
    fn does_not_expose_unimported_template_blob_to_wxml_scope() {
        let ast = parse_wxml(r#"<view><template is="private"/></view>"#).unwrap();
        let unrelated =
            parse_wxml(r#"<template name="private"><text>secret</text></template>"#).unwrap();
        let templates = BTreeMap::from([("pages/other.wxml".into(), unrelated)]);
        let error = evaluate_wxml_with_templates(&ast, &Value::Null, &templates).unwrap_err();
        assert!(matches!(
            error,
            MarkupError::InvalidSyntax { message, .. }
                if message == "WXML template target not found: private"
        ));
    }

    #[test]
    fn include_makes_named_template_declarations_visible_without_import() {
        let ast = parse_wxml(
            r#"<view><include src="partials/definitions.wxml"/><template is="row"/></view>"#,
        )
        .unwrap();
        let included =
            parse_wxml(r#"<template name="row"><text>from-include</text></template>"#).unwrap();
        let templates = BTreeMap::from([("partials/definitions.wxml".into(), included)]);
        let rendered = evaluate_wxml_with_templates(&ast, &Value::Null, &templates).unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root element")
        };
        assert_eq!(
            children.len(),
            1,
            "include declaration itself is not rendered"
        );
        let WxmlNode::Element { children: row, .. } = &children[0] else {
            panic!("expected template output element")
        };
        assert!(matches!(
            row.first(),
            Some(WxmlNode::Text { value, .. }) if value == "from-include"
        ));
    }

    #[test]
    fn rejects_recursive_wxml_include_definition_graph() {
        let ast = parse_wxml(r#"<view><include src="a.wxml"/></view>"#).unwrap();
        let a = parse_wxml(r#"<include src="b.wxml"/>"#).unwrap();
        let b = parse_wxml(r#"<include src="a.wxml"/>"#).unwrap();
        let templates = BTreeMap::from([("a.wxml".into(), a), ("b.wxml".into(), b)]);
        let error = evaluate_wxml_with_templates(&ast, &Value::Null, &templates).unwrap_err();
        assert!(matches!(
            error,
            MarkupError::InvalidSyntax { message, .. }
                if message == "WXML include cycle detected at a.wxml"
        ));
    }

    #[test]
    fn import_cycle_detection_canonicalizes_manifest_template_aliases() {
        let ast = parse_wxml(r#"<view><import src="a.wxml"/></view>"#).unwrap();
        let a = parse_wxml(r#"<import src="template:a.wxml"/>"#).unwrap();
        let templates =
            BTreeMap::from([("a.wxml".into(), a.clone()), ("template:a.wxml".into(), a)]);
        let error = evaluate_wxml_with_templates(&ast, &Value::Null, &templates).unwrap_err();
        assert!(matches!(
            error,
            MarkupError::InvalidSyntax { message, .. }
                if message == "WXML import cycle detected at template:a.wxml"
        ));
    }

    #[test]
    fn rejects_missing_and_cyclic_wxml_imports() {
        let missing = parse_wxml(r#"<view><import src="missing.wxml"/></view>"#).unwrap();
        let error =
            evaluate_wxml_with_templates(&missing, &Value::Null, &BTreeMap::new()).unwrap_err();
        assert!(matches!(
            error,
            MarkupError::InvalidSyntax { message, .. }
                if message == "WXML import target not found: missing.wxml"
        ));

        let root = parse_wxml(r#"<view><import src="a.wxml"/></view>"#).unwrap();
        let a = parse_wxml(r#"<import src="./b.wxml"/>"#).unwrap();
        let b = parse_wxml(r#"<import src="a.wxml"/>"#).unwrap();
        let templates = BTreeMap::from([("a.wxml".into(), a), ("b.wxml".into(), b)]);
        let error = evaluate_wxml_with_templates(&root, &Value::Null, &templates).unwrap_err();
        assert!(matches!(
            error,
            MarkupError::InvalidSyntax { message, .. }
                if message == "WXML import cycle detected at a.wxml"
        ));
    }

    #[test]
    fn named_template_data_uses_passed_object_scope_for_bindings_and_control_flow() {
        let ast = parse_wxml(
            r#"<view><template is="row" data="{{item}}"/><template is="row" data="{{...item}}"/><template name="row"><text wx:if="{{enabled}}">{{name}}/{{outer}}</text></template></view>"#,
        )
        .unwrap();
        let rendered = evaluate_wxml_with_templates(
            &ast,
            &serde_json::json!({
                "outer": "caller",
                "item": {"name": "passed", "enabled": true}
            }),
            &BTreeMap::new(),
        )
        .unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root")
        };
        assert_eq!(children.len(), 2);
        for child in children {
            let WxmlNode::Element {
                tag,
                directives,
                children,
                ..
            } = child
            else {
                panic!("expected template output element")
            };
            assert_eq!(tag, "text");
            assert!(directives.if_expr.is_none());
            assert_eq!(
                children[0],
                WxmlNode::Text {
                    value: "passed/caller".into(),
                    bindings: vec!["name".into(), "outer".into()],
                    lexical_origin: None,
                }
            );
        }
    }

    #[test]
    fn named_template_data_supports_object_members_and_spreads() {
        let ast = parse_wxml(
            r#"<view><template is="row" data="{{ label: title, ...item }}"/><template name="row"><text>{{label}}/{{name}}</text></template></view>"#,
        )
        .unwrap();
        let rendered = evaluate_wxml_with_templates(
            &ast,
            &serde_json::json!({
                "title": "computed",
                "item": {"name": "spread"}
            }),
            &BTreeMap::new(),
        )
        .unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root")
        };
        let WxmlNode::Element { children, .. } = &children[0] else {
            panic!("expected template output element")
        };
        assert_eq!(
            children[0],
            WxmlNode::Text {
                value: "computed/spread".into(),
                bindings: vec!["label".into(), "name".into()],
                lexical_origin: None,
            }
        );
    }

    #[test]
    fn named_template_data_rejects_non_object_values() {
        let ast = parse_wxml(
            r#"<view><template is="row" data="{{value}}"/><template name="row"><text /></template></view>"#,
        )
        .unwrap();
        let error =
            evaluate_wxml_with_templates(&ast, &serde_json::json!({"value": 42}), &BTreeMap::new())
                .unwrap_err();
        assert!(matches!(
            error,
            MarkupError::InvalidSyntax { message, .. }
                if message == "WXML template data must evaluate to an object"
        ));
    }

    #[test]
    fn projects_default_slot_children_and_renders_fallback() {
        let component = parse_wxml(
            r#"<view class="shell"><slot><text class="fallback">fallback</text></slot></view>"#,
        )
        .unwrap();
        let empty = project_wxml_slots(&component, &[]).unwrap();
        let WxmlNode::Element { children, .. } = &empty.nodes[0] else {
            panic!("expected component root")
        };
        assert_eq!(children.len(), 1);
        let WxmlNode::Element {
            tag,
            attrs,
            children,
            ..
        } = &children[0]
        else {
            panic!("expected fallback element")
        };
        assert_eq!(tag, "text");
        assert_eq!(attrs.get("class"), Some(&"fallback".to_owned()));
        assert_eq!(
            children[0],
            WxmlNode::Text {
                value: "fallback".into(),
                bindings: vec![],
                lexical_origin: None,
            }
        );

        let light = parse_wxml(r#"<text>projected</text>"#).unwrap();
        let projected = project_wxml_slots(&component, &light.nodes).unwrap();
        let WxmlNode::Element { children, .. } = &projected.nodes[0] else {
            panic!("expected component root")
        };
        assert_eq!(children.len(), 1);
        let WxmlNode::Element {
            attrs, children, ..
        } = &children[0]
        else {
            panic!("expected projected element")
        };
        assert!(!attrs.contains_key("slot"));
        assert_eq!(
            children[0],
            WxmlNode::Text {
                value: "projected".into(),
                bindings: vec![],
                lexical_origin: None,
            }
        );
    }

    #[test]
    fn projects_named_slots_and_honors_multiple_slots_option() {
        let component = parse_wxml(
            r#"<view><slot name="header"><text>header fallback</text></slot><slot><text>default fallback</text></slot></view>"#,
        )
        .unwrap();
        let light = parse_wxml(r#"<text slot="header">H</text><text>D</text>"#).unwrap();

        let named = project_wxml_slots(&component, &light.nodes).unwrap();
        let WxmlNode::Element { children, .. } = &named.nodes[0] else {
            panic!("expected component root")
        };
        assert_eq!(children.len(), 2);
        assert_eq!(text_value(&children[0]), Some("H"));
        assert_eq!(text_value(&children[1]), Some("D"));

        let single = project_wxml_slots_with_options(&component, &light.nodes, false).unwrap();
        let WxmlNode::Element { children, .. } = &single.nodes[0] else {
            panic!("expected component root")
        };
        // Named content is treated as ordinary default-slot content when the
        // component does not opt into multiple slots; the named outlet keeps
        // its fallback tree.
        assert_eq!(text_value(&children[0]), Some("header fallback"));
        assert_eq!(text_value(&children[1]), Some("H"));
        assert_eq!(text_value(&children[2]), Some("D"));
    }

    #[test]
    fn nested_slots_are_projected_inside_fallback_wrappers() {
        let component = parse_wxml(
            r#"<view><slot name="header"><view class="fallback"><slot>inner fallback</slot></view></slot></view>"#,
        )
        .unwrap();
        let light = parse_wxml(r#"<text>inner content</text>"#).unwrap();
        let projected = project_wxml_slots(&component, &light.nodes).unwrap();
        let WxmlNode::Element { children, .. } = &projected.nodes[0] else {
            panic!("expected component root")
        };
        let WxmlNode::Element { children, .. } = &children[0] else {
            panic!("expected fallback wrapper")
        };
        assert_eq!(text_value(&children[0]), Some("inner content"));
    }

    fn text_value(node: &WxmlNode) -> Option<&str> {
        let WxmlNode::Element { children, .. } = node else {
            return None;
        };
        match children.first() {
            Some(WxmlNode::Text { value, .. }) => Some(value.as_str()),
            _ => None,
        }
    }

    #[test]
    fn rejects_mismatched_wxml_closing_tag() {
        assert!(matches!(
            parse_wxml("<view><text></view>"),
            Err(MarkupError::MismatchedClosing { .. })
        ));
    }

    #[test]
    fn button_is_a_container_and_preserves_nested_wxml_content() {
        let ast = parse_wxml(r#"<button bindtap="onTap"><text>{{label}}</text></button>"#).unwrap();
        let WxmlNode::Element {
            tag,
            children,
            directives,
            ..
        } = &ast.nodes[0]
        else {
            panic!("expected button element")
        };
        assert_eq!(tag, "button");
        assert_eq!(directives.events.get("bindtap"), Some(&"onTap".to_owned()));
        assert_eq!(children.len(), 1);
        let WxmlNode::Element { tag, children, .. } = &children[0] else {
            panic!("expected nested button content")
        };
        assert_eq!(tag, "text");
        assert_eq!(
            children[0],
            WxmlNode::Text {
                value: "{{label}}".into(),
                bindings: vec!["label".into()],
                lexical_origin: None,
            }
        );
    }

    #[test]
    fn parses_wxss_selectors_declarations_and_nested_at_rules() {
        let ir = parse_wxss("@import './base.wxss'; .card, #hero { color: red !important; padding: 2px; } @media (width > 1px) { .card { display: block; } }").unwrap();
        assert_eq!(ir.version, 2);
        assert!(ir.imports.is_empty());
        assert_eq!(
            ir.rules[0].at_rule.as_deref(),
            Some("@import './base.wxss'")
        );
        assert_eq!(ir.rules[1].selectors, vec![".card", "#hero"]);
        assert_eq!(ir.rules[1].declarations[0].property, "color");
        assert!(ir.rules[1].declarations[0].important);
        assert_eq!(ir.rules[2].at_rule.as_deref(), Some("@media (width > 1px)"));
        assert_eq!(ir.rules[2].nested[0].selectors, vec![".card"]);
    }

    #[test]
    fn rejects_unterminated_wxss_comment_and_preserves_escaped_quotes() {
        assert!(matches!(
            parse_wxss("/* missing"),
            Err(MarkupError::UnexpectedEof {
                context: "WXSS comment"
            })
        ));
        let ir = parse_wxss(r#".icon { content: "a\"b"; }"#).unwrap();
        assert_eq!(ir.rules[0].declarations[0].value, r#""a\"b""#);
    }

    #[test]
    fn converts_wxss_lengths_using_viewport_and_resolves_cascade() {
        let rpx = parse_wxss_length("375rpx").unwrap();
        assert_eq!(rpx.unit, WxssLengthUnit::Rpx);
        assert_eq!(rpx.to_px(750.0, 1334.0, 16.0), Some(375.0));
        let rem = parse_wxss_length("1.5rem").unwrap();
        assert_eq!(rem.to_px(750.0, 1334.0, 16.0), Some(24.0));
        let ir = parse_wxss("view { color: red; padding: 2rpx; } .card { color: blue; } #hero { color: green !important; }").unwrap();
        let style = resolve_wxss_style(&ir, Some("view"), Some("hero"), &["card"]);
        assert_eq!(style["color"].value, "green");
        assert!(style["color"].important);
        assert_eq!(style["padding"].value, "2rpx");
        assert!(matches_wxss_selector(
            "view.card",
            Some("view"),
            None,
            &["card"]
        ));
        assert!(!matches_wxss_selector(
            "view .card",
            Some("view"),
            None,
            &["card"]
        ));
    }

    #[test]
    fn invalid_text_values_do_not_erase_valid_cascade_even_when_important() {
        for (property, valid, invalid_values) in [
            ("opacity", "50%", ["50 %", "1px", "normal", "calc()"]),
            ("font-size", "13px", ["1 px", "-1px", "12", "garbage(12px)"]),
            (
                "line-height",
                "1.5",
                ["1 px", "-1", "medium", "garbage(12px)"],
            ),
        ] {
            for invalid in invalid_values {
                let ir = parse_wxss(&format!(
                    ".card {{{property}: {valid}}} #hero {{{property}: {invalid} !important}}"
                ))
                .unwrap();
                assert_eq!(
                    ir.rules[1].declarations[0].value, invalid,
                    "raw source must remain available in the IR"
                );
                let style = resolve_wxss_style(&ir, Some("view"), Some("hero"), &["card"]);
                assert_eq!(style[property].value, valid, "{property}: {invalid}");
                assert!(!style[property].important);

                let ir = parse_wxss(&format!(
                    ".card {{{property}: {valid} !important; {property}: {invalid} !important}}"
                ))
                .unwrap();
                let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
                assert_eq!(style[property].value, valid, "{property}: {invalid}");
                assert!(style[property].important);
            }
        }
    }

    #[test]
    fn text_cascade_validates_inline_and_retains_unsupported_winners() {
        let ir = parse_wxss(".card {font-size: 13px; line-height: 1.5}").unwrap();
        let current = WxssSelectorNode {
            tag: Some("view".into()),
            id: None,
            classes: vec!["card".into()],
            child_index: None,
            sibling_count: None,
        };
        let inline = parse_inline_wxss("font-size: 1 px !important; line-height: -1 !important");
        let style = resolve_wxss_style_for_node_with_inline(&ir, &current, &[], &inline);
        assert_eq!(style["font-size"].value, "13px");
        assert_eq!(style["line-height"].value, "1.5");

        let inline = parse_inline_wxss("font-size: calc(1em + 2px); line-height: var(--line)");
        let style = resolve_wxss_style_for_node_with_inline(&ir, &current, &[], &inline);
        assert_eq!(style["font-size"].value, "calc(1em + 2px)");
        assert_eq!(style["line-height"].value, "var(--line)");

        let ir = parse_wxss(
            ".card {font-size: 13px; font-size: revert !important; line-height: 1.5; line-height: calc(1em + 2px) !important}",
        ).unwrap();
        let style = resolve_wxss_style_for_node_with_inline(&ir, &current, &[], &[]);
        assert_eq!(style["font-size"].value, "revert");
        assert_eq!(style["line-height"].value, "calc(1em + 2px)");
        assert!(style["font-size"].important);
        assert!(style["line-height"].important);
    }

    #[test]
    fn text_flow_cascade_discards_invalid_important_values_before_comparison() {
        let current = WxssSelectorNode {
            tag: Some("view".into()),
            id: Some("hero".into()),
            classes: vec!["card".into()],
            child_index: None,
            sibling_count: None,
        };
        for (property, valid, invalid, unimplemented) in [
            ("white-space", "pre-wrap", "pre wrap", "preserve nowrap"),
            (
                "word-break",
                "keep-all",
                "break-all keep-all",
                "auto-phrase",
            ),
            ("text-align", "center", "center right", "justify"),
            ("direction", "ltr", "left", "rtl"),
            ("unicode-bidi", "normal", "normal isolate", "isolate"),
        ] {
            let ir = parse_wxss(&format!(
                ".card {{{property}:{valid}}} #hero {{{property}:{invalid}!important}}"
            ))
            .unwrap();
            assert_eq!(
                ir.rules[1].declarations[0].value, invalid,
                "raw IR is lossless"
            );
            let inline = parse_inline_wxss(&format!("{property}:{invalid}!important"));
            let style = resolve_wxss_style_for_node_with_inline(&ir, &current, &[], &inline);
            assert_eq!(style[property].value, valid, "invalid {property}");
            assert!(!style[property].important);
            let inline = parse_inline_wxss(&format!("{property}:{unimplemented}!important"));
            let style = resolve_wxss_style_for_node_with_inline(&ir, &current, &[], &inline);
            assert_eq!(
                style[property].value, unimplemented,
                "unsupported {property} must win"
            );
            assert!(style[property].important);
            let inline = parse_inline_wxss(&format!("{property}:var(--flow, {valid})!important"));
            let style = resolve_wxss_style_for_node_with_inline(&ir, &current, &[], &inline);
            assert_eq!(style[property].value, format!("var(--flow, {valid})"));
        }
    }

    #[test]
    fn font_shorthand_resets_longhands_and_preserves_explicit_unsupported_marker() {
        let ir = parse_wxss(r#".card {font-weight: bold; font-size-adjust: 2; line-height: 3; font: italic small-caps 700 condensed 12px/1.5 "My Font", sans-serif}"#).unwrap();
        let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
        for (property, value) in [
            ("font-style", "italic"),
            ("font-variant", "small-caps"),
            ("font-weight", "700"),
            ("font-stretch", "condensed"),
            ("font-size", "12px"),
            ("line-height", "1.5"),
            ("font-family", "\"My Font\", sans-serif"),
            ("font-size-adjust", "none"),
        ] {
            assert_eq!(style[property].value, value, "{property}");
        }
        assert!(
            style.contains_key("font"),
            "runtime must explicitly reject unimplemented shorthand semantics"
        );
        let ir = parse_wxss(".card {font: 12px serif !important; font-size: 24px; line-height: 2}")
            .unwrap();
        let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
        assert_eq!(style["font-size"].value, "12px");
        assert_eq!(style["line-height"].value, "normal");
        assert!(style["font-size"].important);
        let ir = parse_wxss(".card {font: 12px serif; font-size: 24px; line-height: 2}").unwrap();
        let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
        assert_eq!(style["font-size"].value, "24px");
        assert_eq!(style["line-height"].value, "2");
        for value in [
            "caption",
            "var(--font)",
            "italic var(--font)",
            "12px/var(--line) serif",
        ] {
            let ir = parse_wxss(&format!(".card {{font: {value}}}")).unwrap();
            assert_eq!(
                resolve_wxss_style(&ir, Some("view"), None, &["card"])["font"].value,
                value
            );
        }
    }

    #[test]
    fn invalid_font_shorthands_and_functions_do_not_enter_the_cascade() {
        for value in [
            "12px",
            "12 serif",
            "-1px serif",
            "italic italic 12px serif",
            "12px/garbage serif",
            "12px/1.5 123",
            "12px 'A'B",
            "12px/var(12) serif",
            "var(12)",
            "normal normal normal normal italic 12px serif",
            "1. 12px serif",
            "1.e2 12px serif",
        ] {
            let ir = parse_wxss(&format!(
                ".card {{font-size: 13px; line-height: 1.2; font: {value} !important}}"
            ))
            .unwrap();
            let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
            assert!(!style.contains_key("font"), "{value}");
            assert_eq!(style["font-size"].value, "13px", "{value}");
            assert_eq!(style["line-height"].value, "1.2", "{value}");
        }
        let ir = parse_wxss(".card {font-size: 13px; font-size: calc(red) !important; line-height: 1.2; line-height: var(12) !important}").unwrap();
        let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
        assert_eq!(style["font-size"].value, "13px");
        assert_eq!(style["line-height"].value, "1.2");
        let ir = parse_wxss(".card {font: 1e2 12px serif}").unwrap();
        let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
        assert_eq!(style["font-weight"].value, "1e2");
    }

    #[test]
    fn border_shorthands_reset_omitted_width_style_and_color() {
        for (source, expected) in [
            (
                "border: 7px solid red; border: blue",
                ["3px", "none", "blue"],
            ),
            (
                "border: 7px solid red; border: hidden",
                ["3px", "hidden", "currentcolor"],
            ),
            (
                "border: 7px solid red; border: thin",
                ["1px", "none", "currentcolor"],
            ),
            ("border: red medium SOLID", ["3px", "solid", "red"]),
        ] {
            let ir = parse_wxss(&format!(".card {{{source}}}")).unwrap();
            let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
            for edge in ["top", "right", "bottom", "left"] {
                for (component, value) in ["width", "style", "color"].into_iter().zip(expected) {
                    assert_eq!(
                        style[&format!("border-{edge}-{component}")].value,
                        value,
                        "{source}"
                    );
                }
            }
        }

        let ir = parse_wxss(".card {border: 5px hidden red; border-left: solid}").unwrap();
        let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
        assert_eq!(style["border-left-width"].value, "3px");
        assert_eq!(style["border-left-style"].value, "solid");
        assert_eq!(style["border-left-color"].value, "currentcolor");
        assert_eq!(style["border-top-width"].value, "5px");
        assert_eq!(style["border-top-style"].value, "hidden");
        assert_eq!(style["border-top-color"].value, "red");
    }

    #[test]
    fn border_quads_follow_css_edge_order_without_splitting_color_functions() {
        for (value, expected) in [
            ("thin", ["1px", "1px", "1px", "1px"]),
            ("thin thick", ["1px", "5px", "1px", "5px"]),
            ("0 2rpx medium", ["0", "2rpx", "3px", "2rpx"]),
            ("1px 2rem 3vw 4vh", ["1px", "2rem", "3vw", "4vh"]),
        ] {
            let ir = parse_wxss(&format!(".card {{border-width:{value}}}")).unwrap();
            let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
            for (edge, expected) in ["top", "right", "bottom", "left"].into_iter().zip(expected) {
                assert_eq!(style[&format!("border-{edge}-width")].value, expected);
            }
        }
        let ir = parse_wxss(
            ".card {border-style:solid none hidden; border-color:rgb(1, 2, 3) rgba(4 5 6 / 50%) transparent CURRENTCOLOR}",
        )
        .unwrap();
        let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
        assert_eq!(style["border-top-color"].value, "rgb(1, 2, 3)");
        assert_eq!(style["border-right-color"].value, "rgba(4 5 6 / 50%)");
        assert_eq!(style["border-bottom-color"].value, "transparent");
        assert_eq!(style["border-left-color"].value, "currentcolor");
        assert_eq!(style["border-top-style"].value, "solid");
        assert_eq!(style["border-right-style"].value, "none");
        assert_eq!(style["border-bottom-style"].value, "hidden");
        assert_eq!(style["border-left-style"].value, "none");
    }

    #[test]
    fn invalid_border_declarations_do_not_partially_override_valid_cascade() {
        let baseline = parse_wxss(".card {border: 2px solid red}").unwrap();
        let expected = resolve_wxss_style(&baseline, Some("view"), None, &["card"]);
        for invalid in [
            "border: solid solid",
            "border: -1px solid red",
            "border: 1px 2px",
            "border: 1px solid red blue",
            "border: 10% solid red",
            "border: 3 solid red",
            "border: auto solid red",
            "border: inherit solid",
            "border: 1.px solid red",
            "border: #12 solid",
            "border: rgb(1, 2) solid",
            "border: rgba(1, 2, 3, invalid) solid",
            "border-top: 2px solid 3px",
            "border-left-width: -1px",
            "border-left-width: 1 px",
            "border-left-width: 1px 2px",
            "border-right-style: solid hidden",
            "border-bottom-color: red blue",
            "border-width: 1px 2px -3px 4px",
            "border-width: 1px 2px 3px 4px 5px",
            "border-style: solid hidden invalid",
            "border-color: blue rgb(1,2) white",
        ] {
            let ir = parse_wxss(&format!(
                ".card {{border:2px solid red; {invalid}!important}}"
            ))
            .unwrap();
            let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
            assert_eq!(style, expected, "{invalid}");
        }
    }

    #[test]
    fn border_longhands_share_source_specificity_and_inline_important_cascade() {
        let ir = parse_wxss(".card {border-left-width:7px; border:2px solid red; border-left-width:thick; border-top:thin hidden blue}").unwrap();
        let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
        assert_eq!(style["border-left-width"].value, "5px");
        assert_eq!(style["border-right-width"].value, "2px");
        assert_eq!(style["border-top-width"].value, "1px");
        assert_eq!(style["border-top-color"].value, "blue");

        let node = WxssSelectorNode {
            tag: Some("view".into()),
            id: Some("hero".into()),
            classes: vec!["card".into()],
            ..Default::default()
        };
        let ir = parse_wxss("#hero {border:2px solid blue} .card {border:5px hidden red}").unwrap();
        let style = resolve_wxss_style_for_node(&ir, &node, &[]);
        assert_eq!(style["border-left-width"].value, "2px");
        assert_eq!(style["border-left-color"].value, "blue");
        let inline = parse_inline_wxss("border:thin solid green");
        let style = resolve_wxss_style_for_node_with_inline(&ir, &node, &[], &inline);
        assert_eq!(style["border-left-width"].value, "1px");
        assert_eq!(style["border-left-color"].value, "green");

        let ir = parse_wxss(".card {border:5px hidden red!important}").unwrap();
        let style = resolve_wxss_style_for_node_with_inline(&ir, &node, &[], &inline);
        assert_eq!(style["border-top-width"].value, "5px");
        assert_eq!(style["border-top-style"].value, "hidden");
        let inline = parse_inline_wxss("border:thin solid green; border-top-width:medium!important; border-right-color:rgba(1, 2, 3, .5)!important");
        let style = resolve_wxss_style_for_node_with_inline(&ir, &node, &[], &inline);
        assert_eq!(style["border-top-width"].value, "3px");
        assert!(style["border-top-width"].important);
        assert_eq!(style["border-left-width"].value, "5px");
        assert_eq!(style["border-right-color"].value, "rgba(1, 2, 3, .5)");
        assert_eq!(style["border-right-style"].value, "hidden");
    }

    #[test]
    fn border_global_keywords_expand_without_fabricating_revert_semantics() {
        for keyword in ["INITIAL", "inherit", "unset"] {
            let ir =
                parse_wxss(&format!(".card {{border:2px solid red; border:{keyword}}}")).unwrap();
            let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
            for edge in ["top", "right", "bottom", "left"] {
                for component in ["width", "style", "color"] {
                    assert_eq!(
                        style[&format!("border-{edge}-{component}")].value,
                        keyword.to_ascii_lowercase()
                    );
                }
            }
        }
        let ir = parse_wxss(".card {border:2px solid red; border-left:inherit; border-width:initial; border-top-style:unset}").unwrap();
        let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
        assert_eq!(style["border-left-style"].value, "inherit");
        assert_eq!(style["border-left-color"].value, "inherit");
        assert_eq!(style["border-right-width"].value, "initial");
        assert_eq!(style["border-top-style"].value, "unset");
        for keyword in ["revert", "revert-layer"] {
            let ir =
                parse_wxss(&format!(".card {{border:2px solid red; border:{keyword}}}")).unwrap();
            let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
            assert_eq!(style["border-left-width"].value, "2px");
            assert_eq!(style["border-left-style"].value, "solid");
        }
    }

    #[test]
    fn legal_unpainted_border_styles_are_preserved_for_explicit_renderer_rejection() {
        for value in [
            "dotted", "dashed", "double", "groove", "ridge", "inset", "outset",
        ] {
            let ir = parse_wxss(&format!(
                ".card {{border:2px solid red; border-style:{value}}}"
            ))
            .unwrap();
            let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
            for edge in ["top", "right", "bottom", "left"] {
                assert_eq!(style[&format!("border-{edge}-style")].value, value);
            }
        }
    }

    #[test]
    fn border_tokenization_preserves_functions_and_comment_boundaries() {
        assert_eq!(
            split_wxss_value(r#"1px rgb(1, 2, 3) "quoted token" fn(nested(1 2)) escaped\ space"#),
            Some(vec![
                "1px",
                "rgb(1, 2, 3)",
                r#""quoted token""#,
                "fn(nested(1 2))",
                r"escaped\ space"
            ])
        );
        for invalid in [
            "rgb(1, 2, 3",
            "rgb(1, 2, 3))",
            "[one)",
            "trailing\\",
            "'unclosed",
        ] {
            assert!(split_wxss_value(invalid).is_none(), "{invalid}");
        }
        let ir = parse_wxss(".card {border:thin/**/solid/**/rgb(10/**/20/**/30 / 50%)}").unwrap();
        let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
        assert_eq!(style["border-top-width"].value, "1px");
        assert_eq!(style["border-top-style"].value, "solid");
        assert_eq!(
            parse_wxss_color(&style["border-top-color"].value),
            Some([10, 20, 30, 128])
        );
    }

    #[test]
    fn shared_rgb_color_parser_validates_legacy_modern_alpha_and_named_values() {
        for (source, expected) in [
            ("rebeccapurple", [102, 51, 153, 255]),
            ("Orange", [255, 165, 0, 255]),
            ("lightgrey", [211, 211, 211, 255]),
            ("transparent", [0, 0, 0, 0]),
            ("#1234", [17, 34, 51, 68]),
            ("#11223380", [17, 34, 51, 128]),
            ("rgb(1, 2, 3)", [1, 2, 3, 255]),
            ("rgba(10, 20, 30, .5)", [10, 20, 30, 128]),
            ("rgb(100%, 0%, 50%)", [255, 0, 128, 255]),
            ("rgb(10 20 30 / 25%)", [10, 20, 30, 64]),
            ("rgba(100% 0 50%/.5)", [255, 0, 128, 128]),
            ("rgb(-20 300 10 / 2)", [0, 255, 10, 255]),
            ("rgba(1e2, 2e1, 0, -1)", [100, 20, 0, 0]),
        ] {
            assert_eq!(parse_wxss_color(source), Some(expected), "{source}");
        }
        for invalid in [
            "#12",
            "#12345g",
            "#123456789",
            "rgb(1, 2)",
            "rgb(1, 2, 3, 4, 5)",
            "rgb(10%, 20, 30%)",
            "rgb(1 2, 3)",
            "rgb(1 2 3 / .5 / .2)",
            "rgba(1, 2, 3, NaN)",
            "rgb(inf 2 3)",
            "rgb(1. 2 3)",
            "rgb(1 2 3 /)",
            "currentcolor",
            "hsl(0 100% 50%)",
            "rgb(from red r g b)",
        ] {
            assert_eq!(parse_wxss_color(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn invalid_box_sizing_cannot_override_a_supported_value() {
        let ir = parse_wxss(".card {box-sizing:border-box; box-sizing:invalid!important}").unwrap();
        let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
        assert_eq!(style["box-sizing"].value, "border-box");
        assert!(!style["box-sizing"].important);
        for value in ["content-box", "border-box", "initial", "inherit", "unset"] {
            let ir = parse_wxss(&format!(".card {{box-sizing:{value}}}")).unwrap();
            assert_eq!(
                resolve_wxss_style(&ir, Some("view"), None, &["card"])["box-sizing"].value,
                value
            );
        }
    }

    #[test]
    fn invalid_foreground_colors_preserve_valid_winners_and_allow_inheritance() {
        for invalid in [
            "not-a-color",
            "#12",
            "rgb(1 2)",
            "rgb(1, 2%, 3)",
            "rgba(1,2,3,NaN)",
            "red blue",
        ] {
            let ir = parse_wxss(&format!(
                ".parent{{color:green}} .child{{color:green;color:{invalid}!important}}"
            ))
            .unwrap();
            let style = resolve_wxss_style(&ir, Some("view"), None, &["child"]);
            assert_eq!(style["color"].value, "green", "{invalid}");
            assert!(!style["color"].important, "{invalid}");

            let ir = parse_wxss(&format!(
                ".parent{{color:green}} .child{{color:{invalid}!important}}"
            ))
            .unwrap();
            assert_eq!(
                resolve_wxss_style(&ir, Some("view"), None, &["parent"])["color"].value,
                "green"
            );
            // With no winning child declaration, runtime inherits its
            // parent's green instead of parsing an invalid value as black.
            assert!(!resolve_wxss_style(&ir, Some("view"), None, &["child"]).contains_key("color"));
        }
        for value in [
            "currentcolor",
            "initial",
            "inherit",
            "unset",
            "transparent",
            "rgba(1 2 3/.5)",
        ] {
            let ir = parse_wxss(&format!(".child{{color:{value}}}")).unwrap();
            assert_eq!(
                resolve_wxss_style(&ir, Some("view"), None, &["child"])["color"].value,
                value
            );
        }
    }

    #[test]
    fn overflow_axes_follow_source_order_and_importance_after_shorthand_expansion() {
        for (source, expected_x, expected_y, important_x, important_y) in [
            (
                "overflow-x:hidden; overflow:visible",
                "visible",
                "visible",
                false,
                false,
            ),
            (
                "overflow:hidden; overflow-x:clip; overflow-y:visible",
                "clip",
                "visible",
                false,
                false,
            ),
            ("overflow:CLIP VISIBLE", "clip", "visible", false, false),
            (
                "overflow:hidden!important; overflow-x:visible; overflow-y:visible",
                "hidden",
                "hidden",
                true,
                true,
            ),
            (
                "overflow-x:visible!important; overflow:hidden",
                "visible",
                "hidden",
                true,
                false,
            ),
            (
                "overflow:hidden; overflow:visible visible visible; overflow-x:invalid; overflow-y:hidden visible",
                "hidden",
                "hidden",
                false,
                false,
            ),
        ] {
            let ir = parse_wxss(&format!(".card {{{source}}}")).unwrap();
            let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
            assert_eq!(style["overflow-x"].value, expected_x, "{source}");
            assert_eq!(style["overflow-y"].value, expected_y, "{source}");
            assert_eq!(style["overflow-x"].important, important_x, "{source}");
            assert_eq!(style["overflow-y"].important, important_y, "{source}");
        }
    }

    #[test]
    fn overflow_axes_share_selector_and_inline_cascade_with_other_styles() {
        let node = WxssSelectorNode {
            tag: Some("view".into()),
            id: Some("hero".into()),
            classes: vec!["card".into()],
            ..Default::default()
        };
        let ir = parse_wxss(
            "#hero {overflow:clip hidden} .card {overflow-x:visible; overflow-y:visible}",
        )
        .unwrap();
        let style = resolve_wxss_style_for_node(&ir, &node, &[]);
        assert_eq!(style["overflow-x"].value, "clip");
        assert_eq!(style["overflow-y"].value, "hidden");
        let inline = parse_inline_wxss("overflow:visible");
        let style = resolve_wxss_style_for_node_with_inline(&ir, &node, &[], &inline);
        assert_eq!(style["overflow-x"].value, "visible");
        assert_eq!(style["overflow-y"].value, "visible");

        let important = parse_wxss(".card {overflow:hidden!important}").unwrap();
        let style = resolve_wxss_style_for_node_with_inline(&important, &node, &[], &inline);
        assert_eq!(style["overflow-x"].value, "hidden");
        assert_eq!(style["overflow-y"].value, "hidden");
        let inline_important = parse_inline_wxss("overflow:clip visible!important");
        let style =
            resolve_wxss_style_for_node_with_inline(&important, &node, &[], &inline_important);
        assert_eq!(style["overflow-x"].value, "clip");
        assert_eq!(style["overflow-y"].value, "visible");
        assert!(style["overflow-x"].important);
        assert!(style["overflow-y"].important);
    }

    #[test]
    fn invalid_overflow_does_not_enter_computed_style_or_override_valid_axes() {
        let ir = parse_wxss(".card {overflow:hidden; overflow:visible invalid!important}").unwrap();
        let style = resolve_wxss_style(&ir, Some("view"), None, &["card"]);
        assert_eq!(style["overflow"].value, "hidden");
        assert_eq!(style["overflow-x"].value, "hidden");
        assert_eq!(style["overflow-y"].value, "hidden");
        let ir = parse_wxss(".card {overflow:invalid; overflow-x:visible hidden}").unwrap();
        assert!(resolve_wxss_style(&ir, Some("view"), None, &["card"]).is_empty());
    }

    #[test]
    fn resolves_structural_wxss_pseudo_classes_with_render_context() {
        let ir = parse_wxss(
            "view:first-child { color: red; } view:nth-child(2) { color: green; } view:last-child { color: blue; } view:not(.muted) { opacity: 1; }",
        )
        .unwrap();
        let first = WxssSelectorNode {
            tag: Some("view".into()),
            id: None,
            classes: vec![],
            child_index: Some(1),
            sibling_count: Some(3),
        };
        let second = WxssSelectorNode {
            child_index: Some(2),
            ..first.clone()
        };
        let last = WxssSelectorNode {
            child_index: Some(3),
            ..first.clone()
        };
        assert_eq!(
            resolve_wxss_style_for_node(&ir, &first, &[])["color"].value,
            "red"
        );
        assert_eq!(
            resolve_wxss_style_for_node(&ir, &second, &[])["color"].value,
            "green"
        );
        assert_eq!(
            resolve_wxss_style_for_node(&ir, &last, &[])["color"].value,
            "blue"
        );
        assert!(resolve_wxss_style_for_node(&ir, &first, &[]).contains_key("opacity"));

        let nested = WxssSelectorNode {
            tag: Some("text".into()),
            child_index: Some(1),
            sibling_count: Some(1),
            ..Default::default()
        };
        let parent = WxssSelectorNode {
            tag: Some("view".into()),
            child_index: Some(1),
            sibling_count: Some(1),
            ..Default::default()
        };
        assert!(matches_wxss_selector_with_ancestors(
            "view > text:first-child",
            &nested,
            &[parent]
        ));
        assert!(!matches_wxss_selector(
            "view:first-child",
            Some("view"),
            None,
            &[]
        ));
    }

    #[test]
    fn ir_round_trips_through_json_and_rejects_bad_version() {
        let ast = parse_wxml("<view>{{value}}</view>").unwrap();
        let json = serde_json::to_vec(&ast).unwrap();
        assert_eq!(decode_wxml(&json).unwrap(), ast);
        assert_eq!(
            String::from_utf8(ast.canonical_json().unwrap()).unwrap(),
            r#"{"nodes":[{"attrs":{},"bindings":[],"children":[{"bindings":["value"],"kind":"text","value":"{{value}}"}],"kind":"element","tag":"view"}],"version":1}"#
        );
        let bad = String::from_utf8(json)
            .unwrap()
            .replace("\"version\":1", "\"version\":2");
        assert!(matches!(
            decode_wxml(bad.as_bytes()),
            Err(MarkupError::InvalidVersion { .. })
        ));
    }

    #[test]
    fn packer_structured_and_legacy_wxml_blobs_match_source_control_flow() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../tools/container-manifest/test/fixtures/wxml-directives-v1.json"
        ))
        .unwrap();
        let parsed = parse_wxml(contract["source"].as_str().unwrap()).unwrap();
        let structured = decode_wxml(&serde_json::to_vec(&contract["ast"]).unwrap()).unwrap();
        assert_eq!(
            structured, parsed,
            "JavaScript/Rust share one source IR contract"
        );

        fn strip_directives(value: &mut Value) {
            if let Some(object) = value.as_object_mut() {
                object.remove("directives");
                if let Some(children) = object.get_mut("children").and_then(Value::as_array_mut) {
                    for child in children {
                        strip_directives(child);
                    }
                }
            }
        }
        let mut legacy = contract["ast"].clone();
        for node in legacy["nodes"].as_array_mut().unwrap() {
            strip_directives(node);
        }
        let legacy = decode_wxml(&serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert_eq!(
            legacy, parsed,
            "attribute-only v1 packer blobs normalize before evaluation"
        );
        for (show_child, fallback, branch) in [
            (true, false, "relation-child"),
            (false, true, "fallback"),
            (false, false, "empty"),
        ] {
            let data = serde_json::json!({
                "showChild":show_child,"fallback":fallback,
                "rows":[{"id":"b","label":"{{literal}}"},{"id":"a","label":"A"}]
            });
            let rendered = evaluate_wxml(&legacy, &data).unwrap();
            assert_eq!(rendered, evaluate_wxml(&parsed, &data).unwrap());
            let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
                panic!("root element expected")
            };
            assert_eq!(
                children.len(),
                3,
                "one conditional branch and two keyed rows"
            );
            if show_child {
                assert!(matches!(&children[0], WxmlNode::Element { tag, .. } if tag == branch));
            } else {
                assert!(
                    matches!(&children[0], WxmlNode::Element { children, .. } if matches!(&children[0], WxmlNode::Text { value, .. } if value == branch))
                );
            }
            let keys = children[1..]
                .iter()
                .map(|node| match node {
                    WxmlNode::Element {
                        key, bound_values, ..
                    } => {
                        assert!(bound_values["data-value"].is_string());
                        key.as_deref().unwrap()
                    }
                    _ => panic!("keyed row expected"),
                })
                .collect::<Vec<_>>();
            assert_eq!(keys, vec!["b", "a"]);
            assert_eq!(
                decode_wxml(&rendered.canonical_json().unwrap()).unwrap(),
                rendered,
                "evaluated directive/key/binding state survives the wire boundary"
            );
        }
    }

    #[test]
    fn legacy_directive_normalization_validates_source_without_rebuilding_evaluated_loops() {
        let source = parse_wxml("<view wx:for=\"{{rows}}\" wx:key=\"*this\"/>").unwrap();
        let rendered =
            evaluate_wxml(&source, &serde_json::json!({"rows":["first","second"]})).unwrap();
        let decoded = decode_wxml(&rendered.canonical_json().unwrap()).unwrap();
        assert_eq!(decoded, rendered);
        for node in &decoded.nodes {
            assert!(
                matches!(node, WxmlNode::Element { directives, .. } if directives.for_expr.is_none())
            );
        }

        let invalid = br#"{"version":1,"nodes":[{"kind":"element","tag":"view","attrs":{"wx:if":"{{a}}","wx:elif":"{{b}}"},"bindings":["a","b"],"children":[]}]}"#;
        assert!(matches!(
            decode_wxml(invalid),
            Err(MarkupError::InvalidSyntax { .. })
        ));
        let authoritative = br#"{"version":1,"nodes":[{"kind":"element","tag":"view","attrs":{"wx:if":"{{visible}}"},"bindings":["visible"],"directives":{},"children":[]}]}"#;
        let ast = decode_wxml(authoritative).unwrap();
        assert_eq!(
            evaluate_wxml(&ast, &serde_json::json!({"visible":false}))
                .unwrap()
                .nodes
                .len(),
            1,
            "explicit directives remain authoritative"
        );
    }
}

#[cfg(test)]
mod expression_parser_tests {
    use super::*;
    use serde_json::json;

    fn evaluate(source: &str, data: Value) -> Value {
        evaluate_expression(source, &EvaluationContext::new(&data))
            .unwrap_or_else(|error| panic!("expression {source:?}: {error}"))
    }

    #[test]
    fn arithmetic_obeys_left_associativity_and_unary_precedence() {
        for (expression, expected) in [
            ("10 - 3 - 2", 5.0),
            ("24 / 4 / 2", 3.0),
            ("20 % 6 % 3", 2.0),
            ("1 + 2 * 3 - 8 / 4", 5.0),
            ("-a + b", 1.0),
            ("-2 * 3 + 4", -2.0),
            ("-(2 + 3) * 4", -20.0),
            ("1 + -2", -1.0),
            ("1+-2", -1.0),
            ("1- -2", 3.0),
            ("+true + +null + +'2'", 3.0),
            (".5 + 1. + 2e-1 + 0x10 + 0b10 + 0o10", 27.7),
        ] {
            assert_eq!(
                evaluate(expression, json!({"a":2,"b":3})).as_f64(),
                Some(expected),
                "{expression}"
            );
        }
    }

    #[test]
    fn unary_boolean_and_logical_precedence_matches_the_selected_operands() {
        let data = json!({"a":false,"b":false,"title":"", "empty":[], "object":{}});
        for (expression, expected) in [
            ("!a && b", json!(false)),
            ("!true || false", json!(false)),
            ("!!empty", json!(true)),
            ("empty ? 'array' : 'missing'", json!("array")),
            ("object ? 'object' : 'missing'", json!("object")),
            ("title || 'Untitled'", json!("Untitled")),
            ("'first' && 'second'", json!("second")),
            ("0 && 'unused'", json!(0.0)),
            ("'' || 'fallback' && 'chosen'", json!("chosen")),
        ] {
            assert_eq!(evaluate(expression, data.clone()), expected, "{expression}");
        }
    }

    #[test]
    fn short_circuit_and_ternary_do_not_evaluate_unselected_values() {
        for (expression, expected) in [
            ("false && (1 / 0)", json!(false)),
            ("true || (1 / 0)", json!(true)),
            ("true ? 'chosen' : (1 / 0)", json!("chosen")),
            ("false ? (1 / 0) : 'chosen'", json!("chosen")),
            ("(0 / 0) || 'nan fallback'", json!("nan fallback")),
            ("false && [...missing]", json!(false)),
            (
                "true ? 'outer' : false ? 'middle' : 'inner'",
                json!("outer"),
            ),
            (
                "false ? 'outer' : false ? 'middle' : 'inner'",
                json!("inner"),
            ),
            (
                "true ? false ? 'first' : 'nested' : 'last'",
                json!("nested"),
            ),
        ] {
            assert_eq!(evaluate(expression, json!({})), expected, "{expression}");
        }
        // Syntax and unsupported constructs are checked in every branch.
        for expression in [
            "true || helper()",
            "false && (1 +)",
            "true ? 1 : array.map(fn)",
        ] {
            assert!(
                evaluate_expression(expression, &EvaluationContext::new(&json!({}))).is_err(),
                "{expression}"
            );
        }
    }

    #[test]
    fn equality_distinguishes_types_missing_values_and_reference_identity() {
        let data = json!({"same":{"a":1},"other":{"a":1},"list":[1]});
        for (expression, expected) in [
            ("null == undefined", true),
            ("null === undefined", false),
            ("missing === undefined", true),
            ("missing === null", false),
            ("'2' == 2", true),
            ("'2' === 2", false),
            ("'2' !== 2", true),
            ("'2' != 2", false),
            ("false == []", true),
            ("[] == []", false),
            ("({}) === ({})", false),
            ("same === same", true),
            ("same === other", false),
            ("list === list", true),
            ("null == 0", false),
            ("true == '1'", true),
            ("'' == 0", true),
            ("[1] == '1'", true),
            ("[1] == 1", true),
            ("(0 / 0) === (0 / 0)", false),
            ("1 / 0 > 1e300", true),
        ] {
            assert_eq!(
                evaluate(expression, data.clone()),
                json!(expected),
                "{expression}"
            );
        }
    }

    #[test]
    fn relational_and_arithmetic_coercion_use_javascript_primitives() {
        for (expression, expected) in [
            ("'2' < 10", json!(true)),
            ("'2' < '10'", json!(false)),
            ("'bad' >= 0", json!(false)),
            ("null <= 0", json!(true)),
            ("'2' - true", json!(1.0)),
            ("null + 1", json!(1.0)),
            ("false + true", json!(1.0)),
            ("'n=' + null", json!("n=null")),
            ("'u=' + missing", json!("u=undefined")),
            ("[1, null, 3] + '!'", json!("1,,3!")),
            ("({a:1}) + '!'", json!("[object Object]!")),
            ("+'0x10'", json!(16.0)),
            ("+'  '", json!(0.0)),
            ("(+'inf') || 'fallback'", json!("fallback")),
            ("1e21 + 'px'", json!("1e+21px")),
        ] {
            assert_eq!(evaluate(expression, json!({})), expected, "{expression}");
        }
    }

    #[test]
    fn dynamic_members_accept_nested_expressions_and_quoted_delimiters() {
        let data = json!({
            "rows":[{"name":"zero"},{"name":"one"}],
            "index":0,
            "column":"name",
            "lookup":{"a]b":"bracket","a.b":"dot","01":"leading"},
            "$value": "dollar",
            "中文": "unicode",
        });
        for (expression, expected) in [
            ("rows[index + 1][column]", json!("one")),
            ("(rows[index + 1]).name", json!("one")),
            ("lookup['a]b']", json!("bracket")),
            ("lookup['a.b']", json!("dot")),
            ("lookup['01']", json!("leading")),
            ("rows['01']", Value::Null),
            ("rows.length", json!(2.0)),
            ("'😀'.length", json!(2.0)),
            ("'abc'[1]", json!("b")),
            ("$value + 中文", json!("dollarunicode")),
        ] {
            assert_eq!(evaluate(expression, data.clone()), expected, "{expression}");
        }
    }

    #[test]
    fn literals_preserve_nested_collections_computed_keys_and_spreads() {
        let data = json!({"row":{"name":"A"},"rows":[1,2],"label":"item","key":"computed"});
        assert_eq!(
            evaluate("({row, label, [key]: rows[1], ...row})", data.clone()),
            json!({"row":{"name":"A"},"label":"item","computed":2.0,"name":"A"})
        );
        assert_eq!(
            evaluate("[0, ...rows, , 3,]", data.clone()),
            json!([0.0, 1.0, 2.0, null, 3.0])
        );
        assert_eq!(evaluate("[...'A😀']", data.clone()), json!(["A", "😀"]));
        assert_eq!(
            evaluate("({...null, ...undefined, ...rows, ...'xy'})", data.clone()),
            json!({"0":"x","1":"y"})
        );
        assert_eq!(
            evaluate("({nested: [{value: rows[1]}]}).nested[0].value", data),
            json!(2.0)
        );
    }

    #[test]
    fn string_tokens_decode_escapes_without_treating_delimiters_as_operators() {
        for (expression, expected) in [
            (r#"'a\'b'"#, Some("a'b")),
            (r#""a\"b""#, Some("a\"b")),
            (r#"'a\\b'"#, Some("a\\b")),
            (r#"'a\nb\t'"#, Some("a\nb\t")),
            (r#"'\x41\u0042\u{43}'"#, Some("ABC")),
            (r#"'\uD83D\uDE00'"#, Some("😀")),
            (r#"'?:[]{}+-'"#, Some("?:[]{}+-")),
        ] {
            if let Some(expected) = expected {
                assert_eq!(
                    evaluate(expression, json!({})),
                    json!(expected),
                    "{expression}"
                );
            } else {
                assert!(
                    evaluate_expression(expression, &EvaluationContext::new(&json!({}))).is_err()
                );
            }
        }
    }

    #[test]
    fn malformed_and_executable_syntax_is_rejected_instead_of_partially_read() {
        for expression in [
            "",
            "1 +",
            "(1 + 2]",
            "1 2",
            "items[]",
            "items[",
            "items[index",
            "items..name",
            "true ? 1",
            "true ? : 2",
            "true ? 1 :",
            "'unterminated",
            "'bad\\xZ0'",
            "'bad\\u000Z'",
            "'\\uD800'",
            "0x",
            "0b2",
            "1e",
            "1e+",
            "12name",
            "[1 2]",
            "{a 1}",
            "helper()",
            "obj.method()",
            "value = 1",
            "value += 1",
            "value++",
            "++value",
            "1++2",
            "1--2",
            "1; 2",
            "new Date()",
            "function(){}",
            "({get name(){}})",
            "`template`",
            "1 & 2",
        ] {
            assert!(
                evaluate_expression(expression, &EvaluationContext::new(&json!({}))).is_err(),
                "{expression}"
            );
        }
    }

    #[test]
    fn rendering_uses_the_parser_for_conditionals_and_text_bindings() {
        let ast = parse_wxml(r#"<view><text wx:if="{{!a && b}}">wrong</text><text>{{10-3-2}}/{{-x+y}}/{{label || 'Untitled'}}</text></view>"#).unwrap();
        let rendered =
            evaluate_wxml(&ast, &json!({"a":false,"b":false,"x":2,"y":3,"label":""})).unwrap();
        let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
            panic!("expected root");
        };
        assert_eq!(children.len(), 1);
        let WxmlNode::Element { children, .. } = &children[0] else {
            panic!("expected text");
        };
        assert!(matches!(&children[0], WxmlNode::Text { value, .. } if value == "5/1/Untitled"));
    }
}

#[cfg(test)]
mod template_data_expression_tests {
    use super::*;
    use serde_json::json;

    fn text_nodes(nodes: &[WxmlNode]) -> Vec<String> {
        let mut text = Vec::new();
        for node in nodes {
            match node {
                WxmlNode::Text { value, .. } if !value.trim().is_empty() => {
                    text.push(value.clone())
                }
                WxmlNode::Element { children, .. } => text.extend(text_nodes(children)),
                _ => {}
            }
        }
        text
    }

    #[test]
    fn template_data_ternary_selects_the_current_loop_items_object() {
        let ast = parse_wxml(r#"<block wx:for="{{rows}}" wx:for-item="row" wx:key="id"><template is="entry" data="{{row.visible ? row.primary : row.fallback}}"/></block><template name="entry"><text>{{label}}/{{count}}</text></template>"#).unwrap();
        let data = json!({"rows":[
            {"id":"first","visible":true,"primary":{"label":"primary:a","count":1},"fallback":{"label":"unused","count":99}},
            {"id":"second","visible":false,"primary":{"label":"unused","count":99},"fallback":{"label":"fallback:b","count":2}},
        ]});
        let rendered = evaluate_wxml_with_templates(&ast, &data, &BTreeMap::new()).unwrap();
        assert_eq!(text_nodes(&rendered.nodes), ["primary:a/1", "fallback:b/2"]);
    }

    #[test]
    fn template_data_conditional_object_literals_keep_nested_ternary_and_string_colons() {
        let ast = parse_wxml(r#"<template is="entry" data="{{ready ? {label: nested ? 'yes:chosen' : 'yes:other'} : {label: 'no:fallback'}}}"/><template name="entry"><text>{{label}}</text></template>"#).unwrap();
        for (ready, nested, expected) in [
            (true, true, "yes:chosen"),
            (true, false, "yes:other"),
            (false, true, "no:fallback"),
        ] {
            let rendered = evaluate_wxml_with_templates(
                &ast,
                &json!({"ready":ready,"nested":nested}),
                &BTreeMap::new(),
            )
            .unwrap();
            assert_eq!(text_nodes(&rendered.nodes), [expected]);
        }
    }

    #[test]
    fn template_data_shorthand_uses_the_same_nested_expression_grammar() {
        let ast = parse_wxml(r#"<template is="entry" data="{{label: visible ? 'yes:chosen' : 'no:other', payload: {left: 1, right: [2, 3]}, ...extras, [key]: 'computed'}}"/><template name="entry"><text>{{label}}/{{payload.right[1]}}/{{note}}/{{dynamic}}</text></template>"#).unwrap();
        let rendered = evaluate_wxml_with_templates(
            &ast,
            &json!({"visible":true,"extras":{"note":"included"},"key":"dynamic"}),
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(
            text_nodes(&rendered.nodes),
            ["yes:chosen/3/included/computed"]
        );
    }

    #[test]
    fn template_data_shorthand_decodes_quoted_keys_and_supports_property_shorthand() {
        let context = EvaluationContext::new(&json!({"label":"shorthand","source":{"value":1}}));
        assert_eq!(
            evaluate_template_data(
                r#"label, 'escaped\'key': source.value, ...source"#,
                &context
            )
            .unwrap(),
            json!({"label":"shorthand", "escaped'key":1.0,"value":1.0})
        );
    }

    #[test]
    fn template_data_keeps_object_validation_and_rejects_malformed_executable_sources() {
        let context = EvaluationContext::new(&json!({"ready":true,"row":{"label":"A"},"rows":[]}));
        for source in ["...rows", "...null", "...missing"] {
            assert!(
                matches!(evaluate_template_data(source, &context), Err(MarkupError::InvalidSyntax { message, .. }) if message == "WXML template data spread must evaluate to an object"),
                "{source}"
            );
        }
        for source in [
            "ready ? row :",
            "label: helper()",
            "ready ? helper() : row",
            "label: (1 +)",
            "label: 1 other: 2",
        ] {
            assert!(
                evaluate_template_data(source, &context).is_err(),
                "{source}"
            );
        }
        let attrs = BTreeMap::from([("data".into(), "{{ready ? 'has:colon' : 'other'}}".into())]);
        assert!(
            matches!(template_data_context(&attrs, &context), Err(MarkupError::InvalidSyntax { message, .. }) if message == "WXML template data must evaluate to an object")
        );
    }

    #[test]
    fn final_numeric_interpolation_normalizes_negative_zero_and_exponent_boundaries() {
        let ast = parse_wxml(
            "<text>{{-0}}/{{1e21}}/{{1e20}}/{{1e-7}}/{{1e-6}}/{{-1e21}}/{{-1e-7}}</text>",
        )
        .unwrap();
        let rendered = evaluate_wxml(&ast, &json!({})).unwrap();
        assert_eq!(
            text_nodes(&rendered.nodes),
            ["0/1e+21/100000000000000000000/1e-7/0.000001/-1e+21/-1e-7"]
        );
    }

    #[test]
    fn nested_numeric_interpolation_matches_scalar_javascript_formatting() {
        let ast = parse_wxml(
            r#"<text>{{({value:1,nested:[-0,1e21,1e-7],missing:absent})}}/{{[absent,1]}}</text>"#,
        )
        .unwrap();
        let rendered = evaluate_wxml(&ast, &json!({})).unwrap();
        assert_eq!(
            text_nodes(&rendered.nodes),
            [r#"{"nested":[0,1e+21,1e-7],"value":1}/[null,1]"#]
        );
    }

    #[test]
    fn string_relational_operators_compare_utf16_code_units() {
        let context = EvaluationContext::new(&json!({}));
        for (source, expected) in [
            ("'𐀀' < '\u{e000}'", true),
            ("'𐀀' > '\u{e000}'", false),
            ("'\u{e000}' >= '𐀀'", true),
            ("'😀' <= '😀a'", true),
            ("'😀a' > '😀'", true),
            ("'😀' >= '😀'", true),
        ] {
            assert_eq!(
                evaluate_expression(source, &context).unwrap(),
                json!(expected),
                "{source}"
            );
        }
    }
}
