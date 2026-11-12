//! Portable, versioned representation of a built WeChat mini-program.
//!
//! The IR deliberately contains no runtime handles.  It can therefore be
//! emitted by a build tool, checked in CI, and consumed by all host adapters.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fmt};
mod compositing_values;
mod layout_values;
mod modern_view;
mod rendering;
mod styles;
mod text_values;
mod transform_values;
mod view_document;
mod view_presentation;
mod visibility_values;
mod z_index_values;
pub use modern_view::{
    ModernViewCompilation, ModernViewDocument, ModernViewSource, ModernViewUnit,
    MODERN_MANIFEST_SCHEMA_VERSION,
};
pub use rendering::{
    LayoutAuthority, RendererProfile, RendererProfiles, RENDERING_MANIFEST_SCHEMA_VERSION,
    RENDERING_PROFILE_VERSION,
};
pub use view_document::{
    ViewDocument, ViewDocumentError, ViewEventBinding, ViewEventPhase, ViewNode, ViewOwnership,
    ViewStyleSheet, VIEW_DOCUMENT_VERSION,
};
pub use view_presentation::{
    BrowserGeometryBatch, BrowserNodeGeometry, PresentationKey, ViewPoint, ViewPresentationError,
    ViewRect, ViewSize, ViewViewport, MAX_BROWSER_GEOMETRY_NODES, VIEW_PRESENTATION_VERSION,
};
pub use visibility_values::{parse_wxss_visibility, WxssVisibility};

pub use compositing_values::{parse_wxss_opacity, WxssOpacity};
pub use layout_values::{parse_wxss_layout_value, WxssLayoutValue};

pub use text_values::{
    parse_wxss_font_size, parse_wxss_line_height, parse_wxss_text_align, parse_wxss_text_direction,
    parse_wxss_unicode_bidi, parse_wxss_white_space, parse_wxss_word_break, WxssFontSize,
    WxssLineHeight, WxssTextAlign, WxssTextDirection, WxssTextLength, WxssTextLengthUnit,
    WxssTextValueError, WxssUnicodeBidi, WxssWhiteSpace, WxssWordBreak,
};
pub use transform_values::{
    parse_wxss_transform, parse_wxss_transform_origin, WxssTransform, WxssTransformOperation,
    WxssTransformOrigin,
};
pub use z_index_values::{
    parse_wxss_isolation, parse_wxss_stacking_effect, parse_wxss_z_index, WxssIsolation,
    WxssStackingEffect, WxssZIndex,
};

pub mod markup;
pub use markup::{
    decode_wxml, decode_wxss, evaluate_wxml, evaluate_wxml_with_templates,
    evaluate_wxml_with_templates_and_provenance, evaluate_wxml_with_templates_from_source,
    matches_wxss_selector, matches_wxss_selector_with_ancestors, parse_inline_wxss, parse_wxml,
    parse_wxss, parse_wxss_color, parse_wxss_length, project_wxml_slots,
    project_wxml_slots_with_options, resolve_wxss_style, resolve_wxss_style_for_node,
    resolve_wxss_style_for_node_with_inline, resolve_wxss_style_with_ancestors, validate_wxml,
    validate_wxss, wxml_bindings, BindingDataPath, BindingPathSegment, EvaluatedWxml, MarkupError,
    WxmlAst, WxmlAttributeSource, WxmlDirectives, WxmlLexicalOrigin, WxmlNode, WxssDeclaration,
    WxssIr, WxssLength, WxssLengthError, WxssLengthUnit, WxssRule, WxssSelectorNode,
    WXML_IR_VERSION, WXSS_IR_VERSION,
};

pub const MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const VIEW_COMPILER_NAME: &str = "weapp-container-wxs";
pub const VIEW_COMPILER_VERSION: &str = "1.0.0";
pub const VIEW_COMPILER_ABI: &str = "1.0";
pub type Capabilities = BTreeMap<String, CapabilitySupport>;

fn valid_protocol_version(value: &str) -> bool {
    let mut parts = value.split('.');
    let Some(major) = parts.next() else {
        return false;
    };
    let Some(minor) = parts.next() else {
        return false;
    };
    !major.is_empty()
        && !minor.is_empty()
        && parts.next().is_none()
        && major.bytes().all(|byte| byte.is_ascii_digit())
        && minor.bytes().all(|byte| byte.is_ascii_digit())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContainerManifestV1 {
    #[serde(rename = "schemaVersion", alias = "schema_version")]
    pub schema_version: u32,
    #[serde(rename = "protocolVersion", alias = "protocol_version")]
    pub protocol_version: String,
    pub compiler: CompilerInfo,
    pub app: AppInfo,
    #[serde(default)]
    pub routes: Vec<Route>,
    #[serde(default)]
    pub modules: Vec<Module>,
    /// View-only WXS factories. They never enter the AppService module graph.
    #[serde(
        rename = "viewScripts",
        alias = "view_scripts",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub view_scripts: Vec<ViewScriptModule>,
    /// Versioned executable View programs, separate from their original sources.
    /// Older v1 packs omit this field and retain their original wire format.
    #[serde(
        rename = "viewCompilation",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub view_compilation: Option<ViewCompilation>,
    /// Optional synchronous ECMAScript programs. Schema v2 makes this a
    /// required execution feature rather than something old loaders ignore.
    #[serde(
        rename = "modernView",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub modern_view: Option<ModernViewCompilation>,
    /// Explicit renderer requirements use schema v3 so older runtimes reject
    /// them instead of silently loading a browser page through Skia.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rendering: Option<RendererProfiles>,
    #[serde(default)]
    pub templates: Vec<Template>,
    #[serde(default)]
    pub styles: Vec<Style>,
    #[serde(default)]
    pub components: Vec<Component>,
    #[serde(default)]
    pub assets: Vec<Asset>,
    #[serde(default)]
    pub capabilities: Capabilities,
    pub integrity: Integrity,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompilerInfo {
    pub name: String,
    pub commit: String,
    pub platform: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppInfo {
    #[serde(rename = "appJson", alias = "app_json")]
    pub app_json: String,
    #[serde(rename = "entryModule", alias = "entry_module")]
    pub entry_module: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Route {
    pub id: String,
    pub path: String,
    pub kind: RouteKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    #[serde(rename = "entryModule", alias = "entry_module")]
    pub entry_module: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteKind {
    Page,
    Tab,
    Subpage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Module {
    pub id: String,
    pub sha256: String,
    pub format: ModuleFormat,
    pub scope: ModuleScope,
    /// Statically resolved module IDs referenced by this module.
    ///
    /// The field is optional on the wire for backwards compatibility with
    /// manifests produced before dependency graph extraction was available.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<String>,
}

/// Content-addressed WXS source and its complete, separately verified graph.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewScriptModule {
    pub id: String,
    pub sha256: String,
    pub dependencies: Vec<String>,
}

/// Identity and complete source-to-executable mapping of a View compilation.
/// Original WXS bytes and WXML ASTs stay in `viewScripts` and `templates`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ViewCompilation {
    pub compiler: String,
    pub version: String,
    pub abi: String,
    pub modules: Vec<CompiledViewModule>,
    pub documents: Vec<CompiledViewDocument>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledViewModule {
    pub id: String,
    pub source_sha256: String,
    pub executable_sha256: String,
    pub helper: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledViewDocument {
    pub document_id: String,
    pub wxml_ast: String,
    /// Source-keyed programs. Manifest metadata cannot prove AST coverage;
    /// consumers must reject a missing lookup instead of evaluating raw source.
    pub expressions: Vec<CompiledViewExpression>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledViewExpression {
    pub source: String,
    pub shorthand: bool,
    pub executable_sha256: String,
    pub helper: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModuleFormat {
    Commonjs,
    Esm,
    Json,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModuleScope {
    App,
    Page,
    Component,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Template {
    pub id: String,
    #[serde(rename = "wxmlAst", alias = "wxml_ast")]
    pub wxml_ast: String,
    #[serde(default)]
    pub bindings: Vec<String>,
    /// WXS aliases belong to their declaring WXML document, not page data.
    #[serde(
        rename = "wxsModules",
        alias = "wxs_modules",
        default,
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub wxs_modules: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Style {
    pub id: String,
    #[serde(rename = "wxssIr", alias = "wxss_ir")]
    pub wxss_ir: String,
    pub scope: StyleScope,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Component {
    pub id: String,
    pub owner: String,
    #[serde(rename = "usingComponents", alias = "using_components", default)]
    pub using_components: BTreeMap<String, String>,
    /// Whether the component opts into named `<slot name="...">` outlets.
    ///
    /// WeChat defaults this option to `false`; keeping it optional preserves
    /// the manifest v1 wire form for older packers while allowing newer packs
    /// to distinguish an explicit `multipleSlots` declaration.
    #[serde(
        rename = "multipleSlots",
        alias = "multiple_slots",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub multiple_slots: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StyleScope {
    App,
    Page,
    Component,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asset {
    pub path: String,
    pub sha256: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilitySupport {
    Full,
    Partial,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Integrity {
    pub algorithm: String,
    pub root: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ManifestError {
    InvalidField { field: &'static str, reason: String },
    DuplicateId(String),
    DuplicatePath(String),
    InvalidHash { field: String, value: String },
    InvalidIntegrity(String),
    Serialization(String),
}

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidField { field, reason } => write!(f, "invalid {field}: {reason}"),
            Self::DuplicateId(id) => write!(f, "duplicate IR id: {id}"),
            Self::DuplicatePath(path) => write!(f, "duplicate asset path: {path}"),
            Self::InvalidHash { field, value } => write!(f, "invalid SHA-256 in {field}: {value}"),
            Self::InvalidIntegrity(msg) => write!(f, "invalid integrity: {msg}"),
            Self::Serialization(msg) => write!(f, "manifest serialization failed: {msg}"),
        }
    }
}

impl std::error::Error for ManifestError {}

impl Default for ContainerManifestV1 {
    fn default() -> Self {
        Self {
            schema_version: MANIFEST_SCHEMA_VERSION,
            protocol_version: "1.0".into(),
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: String::new(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: String::new(),
                entry_module: String::new(),
            },
            routes: Vec::new(),
            modules: Vec::new(),
            view_scripts: Vec::new(),
            view_compilation: None,
            modern_view: None,
            rendering: None,
            templates: Vec::new(),
            styles: Vec::new(),
            components: Vec::new(),
            assets: Vec::new(),
            capabilities: BTreeMap::new(),
            integrity: Integrity {
                algorithm: "sha256".into(),
                root: String::new(),
            },
        }
    }
}

impl ContainerManifestV1 {
    /// Manifest-level prerequisite for retaining a live execution session.
    /// Compiler provenance and presentation resources may change; registrations,
    /// module graphs, configuration and declared capabilities must stay fixed.
    /// Callers still validate the candidate's blobs and component topology before
    /// publishing a frame. A `true` result alone does not accept a portable pack.
    pub fn can_replace_presentation_with(&self, next: &Self) -> bool {
        let bindings = |manifest: &Self| {
            manifest
                .templates
                .iter()
                .filter(|template| !template.wxs_modules.is_empty())
                .map(|template| (template.id.clone(), template.wxs_modules.clone()))
                .collect::<BTreeMap<_, _>>()
        };
        // Older v1 producers retained external WXS as ordinary assets. Those
        // bytes are executable input even without a viewScripts module table.
        let legacy_wxs = |manifest: &Self| {
            manifest
                .assets
                .iter()
                .filter(|asset| asset.path.ends_with(".wxs"))
                .cloned()
                .collect::<Vec<_>>()
        };
        let has_stateful_view_code = |manifest: &Self| {
            manifest.modern_view.is_some()
                || !manifest.view_scripts.is_empty()
                || manifest
                    .templates
                    .iter()
                    .any(|template| !template.wxs_modules.is_empty())
                || manifest
                    .assets
                    .iter()
                    .any(|asset| asset.path.ends_with(".wxs"))
        };
        let documents = |manifest: &Self| {
            manifest
                .templates
                .iter()
                .map(|template| (template.id.clone(), template.wxml_ast.clone()))
                .collect::<BTreeMap<_, _>>()
        };
        let has_stateful_view_code = has_stateful_view_code(self) || has_stateful_view_code(next);
        // Compiler/ABI and WXS executable identities are execution inputs.
        // Compiled document expressions alone have no module-owned state:
        // the host may validate them in an isolated presentation candidate.
        let same_compilation = match (&self.view_compilation, &next.view_compilation) {
            (None, None) => true,
            (Some(current), Some(next)) => {
                current.compiler == next.compiler
                    && current.version == next.version
                    && current.abi == next.abi
                    && current.modules == next.modules
                    && (!has_stateful_view_code || current.documents == next.documents)
            }
            _ => false,
        };
        // WXML chooses when/how often stateful View modules execute. Until a
        // native View heap can be forked, changed documents require a fresh
        // session when WXS state exists, even if module bytes are unchanged.
        let same_view_inputs = !has_stateful_view_code || documents(self) == documents(next);
        self.schema_version == next.schema_version
            && same_view_inputs
            && self.protocol_version == next.protocol_version
            && self.app == next.app
            && self.routes == next.routes
            && self.modules == next.modules
            && self.view_scripts == next.view_scripts
            && self.modern_view == next.modern_view
            && self.rendering == next.rendering
            && same_compilation
            && bindings(self) == bindings(next)
            && legacy_wxs(self) == legacy_wxs(next)
            && self.components == next.components
            && self.capabilities == next.capabilities
    }

    /// Validate the schema and references before handing the manifest to a host.
    pub fn validate(&self) -> Result<(), ManifestError> {
        if self.schema_version != MANIFEST_SCHEMA_VERSION
            && self.schema_version != MODERN_MANIFEST_SCHEMA_VERSION
            && self.schema_version != RENDERING_MANIFEST_SCHEMA_VERSION
        {
            return Err(ManifestError::InvalidField {
                field: "schema_version",
                reason: format!(
                    "expected manifest schema 1, 2 or 3, got {}",
                    self.schema_version
                ),
            });
        }
        if (self.schema_version == MANIFEST_SCHEMA_VERSION && self.modern_view.is_some())
            || (self.schema_version == MODERN_MANIFEST_SCHEMA_VERSION && self.modern_view.is_none())
        {
            return Err(ManifestError::InvalidField {
                field: "modernView",
                reason:
                    "modern View requires schemaVersion 2 or 3; schemaVersion 2 requires modernView"
                        .into(),
            });
        }
        if (self.schema_version == RENDERING_MANIFEST_SCHEMA_VERSION) != self.rendering.is_some() {
            return Err(ManifestError::InvalidField {
                field: "rendering",
                reason: "rendering requires schemaVersion 3 and schemaVersion 3 requires rendering"
                    .into(),
            });
        }
        self.validate_rendering()?;
        self.validate_modern_view()?;
        if !valid_protocol_version(&self.protocol_version) {
            return Err(ManifestError::InvalidField {
                field: "protocol_version",
                reason: "must use the major.minor form".into(),
            });
        }
        if self.compiler.name != "weapp-vite" {
            return Err(ManifestError::InvalidField {
                field: "compiler.name",
                reason: "must be weapp-vite".into(),
            });
        }
        if self.compiler.platform != "weapp" {
            return Err(ManifestError::InvalidField {
                field: "compiler.platform",
                reason: "must be weapp".into(),
            });
        }
        if self.compiler.commit.is_empty() {
            return Err(ManifestError::InvalidField {
                field: "compiler.commit",
                reason: "cannot be empty".into(),
            });
        }
        if !valid_relative_path(&self.app.app_json) || !valid_relative_path(&self.app.entry_module)
        {
            return Err(ManifestError::InvalidField {
                field: "app",
                reason: "app_json and entry_module are required".into(),
            });
        }
        if self.integrity.algorithm != "sha256" {
            return Err(ManifestError::InvalidIntegrity(
                "algorithm must be sha256".into(),
            ));
        }
        if !self.integrity.root.is_empty() && !is_sha256(&self.integrity.root) {
            return Err(ManifestError::InvalidHash {
                field: "integrity.root".into(),
                value: self.integrity.root.clone(),
            });
        }

        let mut ids = std::collections::HashSet::new();
        for id in self
            .routes
            .iter()
            .map(|x| &x.id)
            .chain(self.modules.iter().map(|x| &x.id))
            .chain(self.view_scripts.iter().map(|x| &x.id))
            .chain(self.templates.iter().map(|x| &x.id))
            .chain(self.styles.iter().map(|x| &x.id))
            .chain(self.components.iter().map(|x| &x.id))
        {
            if id.is_empty() || !ids.insert(id) {
                return Err(ManifestError::DuplicateId(id.clone()));
            }
        }
        for route in &self.routes {
            if !route.id.starts_with("route:")
                || !valid_relative_path(&route.path)
                || !valid_relative_path(&route.entry_module)
                || route
                    .config
                    .as_deref()
                    .is_some_and(|path| !valid_relative_path(path))
            {
                return Err(ManifestError::InvalidField {
                    field: "routes",
                    reason: format!("invalid route {}", route.id),
                });
            }
        }
        for module in &self.modules {
            if !module.id.starts_with("module:") || module.id.ends_with(".wxs") {
                return Err(ManifestError::InvalidField {
                    field: "modules",
                    reason: format!("invalid module id {}", module.id),
                });
            }
            if has_duplicates(&module.dependencies)
                || module
                    .dependencies
                    .iter()
                    .any(|dependency| !dependency.starts_with("module:"))
            {
                return Err(ManifestError::InvalidField {
                    field: "modules.dependencies",
                    reason: format!("invalid dependencies for {}", module.id),
                });
            }
        }
        let module_ids = self
            .modules
            .iter()
            .map(|module| module.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        for module in &self.modules {
            if let Some(dependency) = module
                .dependencies
                .iter()
                .find(|dependency| !module_ids.contains(dependency.as_str()))
            {
                return Err(ManifestError::InvalidField {
                    field: "modules.dependencies",
                    reason: format!("{} references undeclared module {dependency}", module.id),
                });
            }
        }
        let view_ids = self
            .view_scripts
            .iter()
            .map(|module| module.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        for module in &self.view_scripts {
            if !valid_view_script_id(&module.id) {
                return Err(ManifestError::InvalidField {
                    field: "viewScripts",
                    reason: format!("invalid WXS module id {}", module.id),
                });
            }
            if !is_sha256(&module.sha256) {
                return Err(ManifestError::InvalidHash {
                    field: format!("view script {}", module.id),
                    value: module.sha256.clone(),
                });
            }
            if has_duplicates(&module.dependencies)
                || module.dependencies.iter().any(|dependency| {
                    !valid_external_wxs_id(dependency) || !view_ids.contains(dependency.as_str())
                })
            {
                return Err(ManifestError::InvalidField {
                    field: "viewScripts.dependencies",
                    reason: format!("invalid or undeclared WXS dependency for {}", module.id),
                });
            }
        }
        for template in &self.templates {
            if !template.id.starts_with("template:")
                || !is_blob_pointer(&template.wxml_ast)
                || has_duplicates(&template.bindings)
                || (!template.wxs_modules.is_empty()
                    && !template
                        .id
                        .strip_prefix("template:")
                        .is_some_and(|path| valid_wxs_source_path(path, ".wxml")))
            {
                return Err(ManifestError::InvalidField {
                    field: "templates",
                    reason: format!("invalid template {}", template.id),
                });
            }
            for (alias, target) in &template.wxs_modules {
                let inline_owner = target
                    .strip_prefix("wxs:")
                    .and_then(|id| id.split_once('#'));
                if !valid_wxs_module_name(alias)
                    || !view_ids.contains(target.as_str())
                    || inline_owner.is_some_and(|(owner, name)| {
                        template.id.strip_prefix("template:") != Some(owner) || alias != name
                    })
                {
                    return Err(ManifestError::InvalidField {
                        field: "templates.wxsModules",
                        reason: format!(
                            "invalid WXS binding {alias} -> {target} in {}",
                            template.id
                        ),
                    });
                }
            }
        }
        for module in &self.view_scripts {
            if let Some((owner, alias)) = module
                .id
                .strip_prefix("wxs:")
                .and_then(|id| id.split_once('#'))
            {
                if !self.templates.iter().any(|template| {
                    template.id.strip_prefix("template:") == Some(owner)
                        && template.wxs_modules.get(alias) == Some(&module.id)
                }) {
                    return Err(ManifestError::InvalidField {
                        field: "viewScripts",
                        reason: format!(
                            "inline WXS {} has no declaring template binding",
                            module.id
                        ),
                    });
                }
            }
        }
        if let Some(compilation) = &self.view_compilation {
            self.validate_view_compilation(compilation)?;
        }
        for style in &self.styles {
            if !style.id.starts_with("style:") || !is_blob_pointer(&style.wxss_ir) {
                return Err(ManifestError::InvalidField {
                    field: "styles",
                    reason: format!("invalid style {}", style.id),
                });
            }
        }
        for component in &self.components {
            if !component.id.starts_with("components:")
                || !valid_relative_path(&component.owner)
                || component
                    .using_components
                    .iter()
                    .any(|(name, target)| name.is_empty() || target.is_empty())
            {
                return Err(ManifestError::InvalidField {
                    field: "components",
                    reason: format!("invalid component {}", component.id),
                });
            }
        }
        let mut paths = std::collections::HashSet::new();
        for asset in &self.assets {
            if view_ids.contains(format!("wxs:{}", asset.path).as_str()) {
                return Err(ManifestError::InvalidField {
                    field: "assets",
                    reason: format!(
                        "WXS {} is declared as both a view script and an asset",
                        asset.path
                    ),
                });
            }
            if !valid_relative_path(&asset.path) || !paths.insert(&asset.path) {
                return Err(ManifestError::DuplicatePath(asset.path.clone()));
            }
            if !is_sha256(&asset.sha256) {
                return Err(ManifestError::InvalidHash {
                    field: format!("asset {}", asset.path),
                    value: asset.sha256.clone(),
                });
            }
        }
        for module in &self.modules {
            if !is_sha256(&module.sha256) {
                return Err(ManifestError::InvalidHash {
                    field: format!("module {}", module.id),
                    value: module.sha256.clone(),
                });
            }
        }
        for name in self.capabilities.keys() {
            if !valid_capability_name(name) {
                return Err(ManifestError::InvalidField {
                    field: "capabilities",
                    reason: format!("invalid capability name {name}"),
                });
            }
        }
        Ok(())
    }

    fn validate_view_compilation(
        &self,
        compilation: &ViewCompilation,
    ) -> Result<(), ManifestError> {
        for (field, actual, expected) in [
            (
                "viewCompilation.compiler",
                compilation.compiler.as_str(),
                VIEW_COMPILER_NAME,
            ),
            (
                "viewCompilation.version",
                compilation.version.as_str(),
                VIEW_COMPILER_VERSION,
            ),
            (
                "viewCompilation.abi",
                compilation.abi.as_str(),
                VIEW_COMPILER_ABI,
            ),
        ] {
            if actual != expected {
                return Err(ManifestError::InvalidField {
                    field,
                    reason: format!("expected {expected}, got {actual}"),
                });
            }
        }

        let source_modules = self
            .view_scripts
            .iter()
            .map(|module| (module.id.as_str(), module.sha256.as_str()))
            .collect::<BTreeMap<_, _>>();
        let mut modules = std::collections::HashSet::new();
        for module in &compilation.modules {
            if !valid_view_script_id(&module.id) || !modules.insert(module.id.as_str()) {
                return Err(ManifestError::InvalidField {
                    field: "viewCompilation.modules",
                    reason: format!("invalid or duplicate compiled module {}", module.id),
                });
            }
            for (field, hash) in [
                ("sourceSha256", &module.source_sha256),
                ("executableSha256", &module.executable_sha256),
            ] {
                if !is_sha256(hash) {
                    return Err(ManifestError::InvalidHash {
                        field: format!("viewCompilation.modules.{}.{field}", module.id),
                        value: hash.clone(),
                    });
                }
            }
            if source_modules.get(module.id.as_str()).copied()
                != Some(module.source_sha256.as_str())
            {
                return Err(ManifestError::InvalidField {
                    field: "viewCompilation.modules",
                    reason: format!(
                        "source mapping does not match viewScripts for {}",
                        module.id
                    ),
                });
            }
            if !valid_view_compilation_helper(&module.helper) {
                return Err(ManifestError::InvalidField {
                    field: "viewCompilation.modules.helper",
                    reason: format!("invalid or reserved helper {}", module.helper),
                });
            }
        }
        if modules.len() != source_modules.len() {
            return Err(ManifestError::InvalidField {
                field: "viewCompilation.modules",
                reason: "must compile every viewScripts module exactly once".into(),
            });
        }

        let source_documents = self
            .templates
            .iter()
            .filter(|template| !self.is_modern_document(&template.id))
            .map(|template| {
                (
                    template.id.strip_prefix("template:").unwrap_or_default(),
                    template.wxml_ast.as_str(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let mut documents = std::collections::HashSet::new();
        for document in &compilation.documents {
            if !valid_wxs_source_path(&document.document_id, ".wxml")
                || !documents.insert(document.document_id.as_str())
                || source_documents.get(document.document_id.as_str()).copied()
                    != Some(document.wxml_ast.as_str())
            {
                return Err(ManifestError::InvalidField {
                    field: "viewCompilation.documents",
                    reason: format!(
                        "invalid, duplicate or mismatched compiled document {}",
                        document.document_id
                    ),
                });
            }
            let mut expressions = std::collections::HashSet::new();
            for expression in &document.expressions {
                if expression.source.trim().is_empty()
                    || !expressions.insert((expression.source.as_str(), expression.shorthand))
                {
                    return Err(ManifestError::InvalidField {
                        field: "viewCompilation.documents.expressions",
                        reason: format!(
                            "empty or duplicate expression in {}",
                            document.document_id
                        ),
                    });
                }
                if !is_sha256(&expression.executable_sha256) {
                    return Err(ManifestError::InvalidHash {
                        field: format!(
                            "viewCompilation.documents.{}.expressions.executableSha256",
                            document.document_id
                        ),
                        value: expression.executable_sha256.clone(),
                    });
                }
                if !valid_view_compilation_helper(&expression.helper) {
                    return Err(ManifestError::InvalidField {
                        field: "viewCompilation.documents.expressions.helper",
                        reason: format!("invalid or reserved helper {}", expression.helper),
                    });
                }
            }
        }
        if documents.len() != source_documents.len() {
            return Err(ManifestError::InvalidField {
                field: "viewCompilation.documents",
                reason: "must compile every template document exactly once".into(),
            });
        }
        Ok(())
    }

    /// Return stable UTF-8 JSON with recursively sorted object keys. This
    /// matches the JavaScript packer's canonicalizer and is used for roots.
    pub fn canonical_json(&self) -> Result<Vec<u8>, ManifestError> {
        let value =
            serde_json::to_value(self).map_err(|e| ManifestError::Serialization(e.to_string()))?;
        Ok(canonicalize_value(&value).into_bytes())
    }

    /// Compute the content root with the root field blanked, avoiding a
    /// self-referential hash.
    pub fn computed_integrity_root(&self) -> Result<String, ManifestError> {
        let mut unsigned = self.clone();
        unsigned.integrity.root.clear();
        let bytes = unsigned.canonical_json()?;
        Ok(hex_digest(&bytes))
    }

    pub fn refresh_integrity(&mut self) -> Result<(), ManifestError> {
        self.integrity.algorithm = "sha256".into();
        self.integrity.root = self.computed_integrity_root()?;
        Ok(())
    }

    pub fn verify_integrity(&self) -> Result<(), ManifestError> {
        self.validate()?;
        let expected = self.computed_integrity_root()?;
        if self.integrity.root != expected {
            return Err(ManifestError::InvalidIntegrity(format!(
                "root mismatch: expected {expected}, got {}",
                self.integrity.root
            )));
        }
        Ok(())
    }
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_relative_path(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.split('/').any(|part| part == ".." || part.is_empty())
}

fn valid_wxs_source_path(value: &str, suffix: &str) -> bool {
    valid_relative_path(value)
        && value.ends_with(suffix)
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '\\' | '#' | '?' | ':'))
        && !value.split('/').any(|part| part == ".")
}

fn valid_external_wxs_id(value: &str) -> bool {
    value
        .strip_prefix("wxs:")
        .is_some_and(|path| valid_wxs_source_path(path, ".wxs"))
}

fn valid_view_script_id(value: &str) -> bool {
    let Some(source) = value.strip_prefix("wxs:") else {
        return false;
    };
    match source.split_once('#') {
        Some((owner, alias)) => {
            valid_wxs_source_path(owner, ".wxml") && valid_wxs_module_name(alias)
        }
        None => valid_wxs_source_path(source, ".wxs"),
    }
}

fn valid_wxs_module_name(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphabetic()
                || byte == b'_'
                || byte == b'$'
                || (index > 0 && byte.is_ascii_digit())
        })
        && !matches!(
            value,
            "break"
                | "case"
                | "catch"
                | "class"
                | "const"
                | "continue"
                | "debugger"
                | "default"
                | "delete"
                | "do"
                | "else"
                | "enum"
                | "export"
                | "extends"
                | "false"
                | "finally"
                | "for"
                | "function"
                | "if"
                | "implements"
                | "import"
                | "in"
                | "instanceof"
                | "interface"
                | "let"
                | "new"
                | "null"
                | "package"
                | "private"
                | "protected"
                | "public"
                | "return"
                | "static"
                | "super"
                | "switch"
                | "this"
                | "throw"
                | "true"
                | "try"
                | "typeof"
                | "var"
                | "void"
                | "while"
                | "with"
                | "yield"
                | "await"
        )
}

fn valid_view_compilation_helper(value: &str) -> bool {
    value.starts_with("__wc")
        && valid_wxs_module_name(value)
        && !matches!(
            value,
            "eval"
                | "arguments"
                | "require"
                | "module"
                | "exports"
                | "undefined"
                | "NaN"
                | "Infinity"
                | "getDate"
                | "getRegExp"
        )
}

/// Capability keys cover wx APIs, Page/Component instance methods, and global
/// runtime helpers. Instance methods have one identifier, not an arbitrary
/// namespace chain; other globals remain single JavaScript identifiers.
fn valid_capability_name(value: &str) -> bool {
    let identifier = |value: &str| {
        !value.is_empty()
            && value.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_alphabetic()
                    || byte == b'_'
                    || byte == b'$'
                    || (index > 0 && byte.is_ascii_digit())
            })
    };
    if let Some(value) = value.strip_prefix("object:") {
        let parts = value.split('.').collect::<Vec<_>>();
        return parts.len() == 2 && parts.iter().all(|part| identifier(part));
    }
    if let Some(value) = value.strip_prefix("component:") {
        return !value.is_empty()
            && value
                .split('.')
                .all(|part| !part.is_empty() && part.split('-').all(identifier));
    }
    if let Some(value) = value.strip_prefix("weappContainer.") {
        return !value.is_empty() && value.split('.').all(identifier);
    }
    if let Some(name) = value.strip_prefix("wx.") {
        return !name.is_empty()
            && name.split('.').all(|segment| {
                !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_alphanumeric())
            });
    }
    let value = value
        .strip_prefix("Page.")
        .or_else(|| value.strip_prefix("Component."))
        .unwrap_or(value);
    !value.is_empty()
        && value.bytes().enumerate().all(|(index, byte)| {
            (index == 0 && (byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$'))
                || (index > 0 && (byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'))
        })
}

fn is_blob_pointer(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(is_sha256)
}

fn has_duplicates(values: &[String]) -> bool {
    let mut seen = std::collections::HashSet::new();
    values.iter().any(|value| !seen.insert(value))
}

fn canonicalize_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".into(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::String(value) => {
            serde_json::to_string(value).expect("JSON string serialization cannot fail")
        }
        serde_json::Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonicalize_value)
                .collect::<Vec<_>>()
                .join(",")
        ),
        serde_json::Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.as_bytes().cmp(right.as_bytes()));
            let values = entries
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key serialization cannot fail"),
                        canonicalize_value(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{values}}}")
        }
    }
}

pub fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> ContainerManifestV1 {
        let mut m = ContainerManifestV1::default();
        m.compiler.commit = "abc123".into();
        m.app = AppInfo {
            app_json: "app.json".into(),
            entry_module: "app.js".into(),
        };
        m.assets.push(Asset {
            path: "app.js".into(),
            sha256: "a".repeat(64),
            mime: "text/javascript".into(),
            size: 3,
        });
        m
    }

    #[test]
    fn module_dependencies_are_optional_and_must_reference_declared_modules() {
        let mut m = manifest();
        m.modules.push(Module {
            id: "module:app.js".into(),
            sha256: "b".repeat(64),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: vec![],
        });
        let json = serde_json::to_value(&m).unwrap();
        assert!(json["modules"][0].get("dependencies").is_none());
        m.modules[0].dependencies = vec!["module:missing.js".into()];
        assert!(matches!(
            m.validate(),
            Err(ManifestError::InvalidField {
                field: "modules.dependencies",
                ..
            })
        ));
    }

    fn wxs_manifest() -> ContainerManifestV1 {
        let mut m = manifest();
        m.view_scripts = vec![
            ViewScriptModule {
                id: "wxs:utils/helper.wxs".into(),
                sha256: "b".repeat(64),
                dependencies: vec!["wxs:utils/dep.wxs".into()],
            },
            ViewScriptModule {
                id: "wxs:utils/dep.wxs".into(),
                sha256: "c".repeat(64),
                dependencies: vec!["wxs:utils/helper.wxs".into()],
            },
            ViewScriptModule {
                id: "wxs:pages/index/index.wxml#inlineTools".into(),
                sha256: "d".repeat(64),
                dependencies: vec![],
            },
        ];
        m.templates.push(Template {
            id: "template:pages/index/index.wxml".into(),
            wxml_ast: format!("sha256:{}", "e".repeat(64)),
            bindings: vec![],
            wxs_modules: BTreeMap::from([
                ("tools".into(), "wxs:utils/helper.wxs".into()),
                (
                    "inlineTools".into(),
                    "wxs:pages/index/index.wxml#inlineTools".into(),
                ),
            ]),
        });
        m
    }

    fn compiled_manifest() -> ContainerManifestV1 {
        let mut m = wxs_manifest();
        m.view_compilation = Some(ViewCompilation {
            compiler: VIEW_COMPILER_NAME.into(),
            version: VIEW_COMPILER_VERSION.into(),
            abi: VIEW_COMPILER_ABI.into(),
            modules: m
                .view_scripts
                .iter()
                .map(|module| CompiledViewModule {
                    id: module.id.clone(),
                    source_sha256: module.sha256.clone(),
                    executable_sha256: "f".repeat(64),
                    helper: "__wcView1".into(),
                })
                .collect(),
            documents: vec![CompiledViewDocument {
                document_id: "pages/index/index.wxml".into(),
                wxml_ast: m.templates[0].wxml_ast.clone(),
                expressions: vec![CompiledViewExpression {
                    source: "tools.value.constructor".into(),
                    shorthand: false,
                    executable_sha256: "0".repeat(64),
                    helper: "__wcExpression1".into(),
                }],
            }],
        });
        m
    }

    #[test]
    fn compiled_view_wire_is_optional_and_strict_without_changing_original_sources() {
        let original = wxs_manifest();
        let legacy_json = serde_json::to_value(&original).unwrap();
        assert!(legacy_json.get("viewCompilation").is_none());
        assert_eq!(
            serde_json::from_value::<ContainerManifestV1>(legacy_json)
                .unwrap()
                .view_compilation,
            None
        );

        let mut compiled = compiled_manifest();
        assert_eq!(compiled.view_scripts, original.view_scripts);
        assert_eq!(compiled.templates, original.templates);
        compiled.refresh_integrity().unwrap();
        compiled.verify_integrity().unwrap();
        let json = serde_json::to_value(&compiled).unwrap();
        assert_eq!(
            json["viewCompilation"]["modules"][0]["sourceSha256"],
            original.view_scripts[0].sha256
        );
        assert_eq!(
            json["viewCompilation"]["documents"][0]["documentId"],
            "pages/index/index.wxml"
        );
        assert_eq!(
            serde_json::from_value::<ContainerManifestV1>(json.clone()).unwrap(),
            compiled
        );
        for pointer in [
            "/viewCompilation",
            "/viewCompilation/modules/0",
            "/viewCompilation/documents/0",
            "/viewCompilation/documents/0/expressions/0",
        ] {
            let mut invalid = json.clone();
            invalid
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unknownExecutableField".into(), true.into());
            assert!(
                serde_json::from_value::<ContainerManifestV1>(invalid).is_err(),
                "{pointer}"
            );
        }
    }

    #[test]
    fn compiled_view_rejects_unknown_compilers_versions_and_incomplete_mappings() {
        type Mutation = fn(&mut ViewCompilation);
        let mutations: &[(&str, Mutation)] = &[
            ("compiler", |c| c.compiler = "other-compiler".into()),
            ("version", |c| c.version = "1.0.1".into()),
            ("abi", |c| c.abi = "1.1".into()),
            ("missing module", |c| {
                c.modules.pop();
            }),
            ("duplicate module", |c| c.modules.push(c.modules[0].clone())),
            ("undeclared module", |c| {
                c.modules[0].id = "wxs:undeclared.wxs".into();
            }),
            ("source mismatch", |c| {
                c.modules[0].source_sha256 = "0".repeat(64)
            }),
            ("invalid source hash", |c| {
                c.modules[0].source_sha256 = "bad".into()
            }),
            ("invalid executable hash", |c| {
                c.modules[0].executable_sha256 = "bad".into();
            }),
            ("missing document", |c| c.documents.clear()),
            ("duplicate document", |c| {
                c.documents.push(c.documents[0].clone());
            }),
            ("undeclared document", |c| {
                c.documents[0].document_id = "pages/other.wxml".into();
            }),
            ("noncanonical document", |c| {
                c.documents[0].document_id = "pages/./index/index.wxml".into();
            }),
            ("original AST mismatch", |c| {
                c.documents[0].wxml_ast = format!("sha256:{}", "a".repeat(64));
            }),
            ("empty expression", |c| {
                c.documents[0].expressions[0].source = " \n\t".into();
            }),
            ("invalid expression hash", |c| {
                c.documents[0].expressions[0].executable_sha256 = "bad".into();
            }),
        ];
        for (label, mutate) in mutations {
            let mut m = compiled_manifest();
            mutate(m.view_compilation.as_mut().unwrap());
            assert!(m.validate().is_err(), "{label}");
        }
        let mut no_sources = manifest();
        no_sources.view_compilation = Some(ViewCompilation {
            compiler: VIEW_COMPILER_NAME.into(),
            version: VIEW_COMPILER_VERSION.into(),
            abi: VIEW_COMPILER_ABI.into(),
            modules: Vec::new(),
            documents: Vec::new(),
        });
        assert!(no_sources.validate().is_ok());
    }

    #[test]
    fn compiled_view_expression_identity_includes_shorthand_and_document_scope() {
        let mut m = compiled_manifest();
        let c = m.view_compilation.as_mut().unwrap();
        let mut shorthand = c.documents[0].expressions[0].clone();
        shorthand.shorthand = true;
        c.documents[0].expressions.push(shorthand);
        let mut second_document = c.documents[0].clone();
        second_document.document_id = "shared/fragment.wxml".into();
        c.documents.push(second_document);
        m.templates.push(Template {
            id: "template:shared/fragment.wxml".into(),
            wxs_modules: BTreeMap::new(),
            ..m.templates[0].clone()
        });
        assert!(m.validate().is_ok());

        let c = m.view_compilation.as_mut().unwrap();
        let mut repeated_key = c.documents[0].expressions[0].clone();
        repeated_key.executable_sha256 = "1".repeat(64);
        repeated_key.helper = "__wcDifferentHelper".into();
        c.documents[0].expressions.push(repeated_key);
        assert!(matches!(
            m.validate(),
            Err(ManifestError::InvalidField {
                field: "viewCompilation.documents.expressions",
                ..
            })
        ));
    }

    #[test]
    fn compiled_view_helpers_reject_keywords_and_reserved_runtime_bindings() {
        for helper in [
            "",
            "1helper",
            "helper-name",
            "\u{e9}",
            "for",
            "await",
            "eval",
            "arguments",
            "require",
            "module",
            "exports",
            "undefined",
            "NaN",
            "Infinity",
            "getDate",
            "getRegExp",
            "$helper",
            "_helper1",
        ] {
            for expression in [false, true] {
                let mut m = compiled_manifest();
                let c = m.view_compilation.as_mut().unwrap();
                if expression {
                    c.documents[0].expressions[0].helper = helper.into();
                } else {
                    c.modules[0].helper = helper.into();
                }
                assert!(m.validate().is_err(), "{helper:?}, expression={expression}");
            }
        }
        for helper in ["__wc", "__wc_1", "__wcExpression1"] {
            let mut m = compiled_manifest();
            m.view_compilation.as_mut().unwrap().modules[0].helper = helper.into();
            assert!(m.validate().is_ok(), "{helper}");
        }
    }

    #[test]
    fn compiled_view_executable_hashes_and_abi_participate_in_integrity() {
        let mut m = compiled_manifest();
        m.refresh_integrity().unwrap();
        let root = m.integrity.root.clone();
        let c = m.view_compilation.as_mut().unwrap();
        c.modules[0].executable_sha256 = "1".repeat(64);
        assert_ne!(m.computed_integrity_root().unwrap(), root);
        assert!(m.verify_integrity().is_err());
        m.refresh_integrity().unwrap();
        m.verify_integrity().unwrap();
        let root = m.integrity.root.clone();
        m.view_compilation.as_mut().unwrap().documents[0].expressions[0].executable_sha256 =
            "2".repeat(64);
        assert_ne!(m.computed_integrity_root().unwrap(), root);
        assert!(m.verify_integrity().is_err());
        m.view_compilation.as_mut().unwrap().abi = "2.0".into();
        assert!(m.validate().is_err());
    }

    #[test]
    fn compiled_view_changes_restart_but_style_and_asset_updates_keep_the_session() {
        let original = compiled_manifest();
        let mut presentation = original.clone();
        presentation.styles.push(Style {
            id: "style:app.wxss".into(),
            wxss_ir: format!("sha256:{}", "3".repeat(64)),
            scope: StyleScope::App,
        });
        presentation.assets[0].sha256 = "4".repeat(64);
        assert!(original.can_replace_presentation_with(&presentation));

        type Mutation = fn(&mut ContainerManifestV1);
        let mutations: &[Mutation] = &[
            |m| m.view_compilation = None,
            |m| m.view_compilation.as_mut().unwrap().compiler = "other-compiler".into(),
            |m| m.view_compilation.as_mut().unwrap().version = "1.0.1".into(),
            |m| m.view_compilation.as_mut().unwrap().abi = "1.1".into(),
            |m| {
                m.view_compilation.as_mut().unwrap().modules[0].executable_sha256 = "5".repeat(64);
            },
            |m| m.view_compilation.as_mut().unwrap().modules[0].helper = "__wcNewHelper".into(),
            |m| {
                m.view_compilation.as_mut().unwrap().documents[0].expressions[0]
                    .executable_sha256 = "6".repeat(64);
            },
            |m| {
                m.view_compilation.as_mut().unwrap().documents[0].expressions[0].source =
                    "tools.changed.constructor".into();
            },
            |m| m.templates[0].wxml_ast = format!("sha256:{}", "7".repeat(64)),
        ];
        for mutate in mutations {
            let mut changed = original.clone();
            mutate(&mut changed);
            assert!(!original.can_replace_presentation_with(&changed));
            assert!(!changed.can_replace_presentation_with(&original));
        }
    }

    #[test]
    fn stateless_compiled_document_edits_keep_the_presentation_reload_contract() {
        let mut original = compiled_manifest();
        original.view_scripts.clear();
        for template in &mut original.templates {
            template.wxs_modules.clear();
        }
        let compilation = original.view_compilation.as_mut().unwrap();
        compilation.modules.clear();
        compilation.documents[0].expressions[0].source = "title.constructor".into();
        original.refresh_integrity().unwrap();
        original.verify_integrity().unwrap();

        let mut changed = original.clone();
        changed.templates[0].wxml_ast = format!("sha256:{}", "8".repeat(64));
        let document = &mut changed.view_compilation.as_mut().unwrap().documents[0];
        document.wxml_ast = changed.templates[0].wxml_ast.clone();
        document.expressions[0] = CompiledViewExpression {
            source: "message.constructor".into(),
            shorthand: false,
            executable_sha256: "9".repeat(64),
            helper: "__wcNextExpression".into(),
        };
        changed.refresh_integrity().unwrap();
        changed.verify_integrity().unwrap();
        assert!(original.can_replace_presentation_with(&changed));
        assert!(changed.can_replace_presentation_with(&original));

        let mut added = changed.clone();
        added.templates.push(Template {
            id: "template:shared/fragment.wxml".into(),
            ..changed.templates[0].clone()
        });
        let mut fragment = changed.view_compilation.as_ref().unwrap().documents[0].clone();
        fragment.document_id = "shared/fragment.wxml".into();
        added
            .view_compilation
            .as_mut()
            .unwrap()
            .documents
            .push(fragment);
        added.refresh_integrity().unwrap();
        added.verify_integrity().unwrap();
        assert!(original.can_replace_presentation_with(&added));
        assert!(added.can_replace_presentation_with(&original));

        // Changes in dialect identity are execution changes even without a
        // module-owned heap. Missing compilation is never a raw-source fallback.
        type Mutation = fn(&mut ContainerManifestV1);
        let mutations: &[Mutation] = &[
            |m| m.view_compilation = None,
            |m| m.view_compilation.as_mut().unwrap().compiler = "other-compiler".into(),
            |m| m.view_compilation.as_mut().unwrap().version = "1.0.1".into(),
            |m| m.view_compilation.as_mut().unwrap().abi = "1.1".into(),
        ];
        for mutate in mutations {
            let mut changed = original.clone();
            mutate(&mut changed);
            assert!(!original.can_replace_presentation_with(&changed));
            assert!(!changed.can_replace_presentation_with(&original));
        }
    }

    #[test]
    fn compiled_documents_still_restart_for_each_legacy_or_declared_wxs_state_marker() {
        for marker in 0..3 {
            let mut original = compiled_manifest();
            original.view_scripts.clear();
            original.templates[0].wxs_modules.clear();
            original.view_compilation.as_mut().unwrap().modules.clear();
            if marker < 2 {
                original.view_scripts.push(ViewScriptModule {
                    id: "wxs:state.wxs".into(),
                    sha256: "b".repeat(64),
                    dependencies: Vec::new(),
                });
                original
                    .view_compilation
                    .as_mut()
                    .unwrap()
                    .modules
                    .push(CompiledViewModule {
                        id: "wxs:state.wxs".into(),
                        source_sha256: "b".repeat(64),
                        executable_sha256: "c".repeat(64),
                        helper: "__wcState".into(),
                    });
            } else {
                original.assets.push(Asset {
                    path: "state.wxs".into(),
                    sha256: "b".repeat(64),
                    mime: "text/javascript".into(),
                    size: 1,
                });
            }
            if marker == 1 {
                original.templates[0]
                    .wxs_modules
                    .insert("state".into(), "wxs:state.wxs".into());
            }
            original.validate().unwrap();
            let mut changed = original.clone();
            let document = &mut changed.view_compilation.as_mut().unwrap().documents[0];
            document.expressions[0].executable_sha256 = "f".repeat(64);
            changed.validate().unwrap();
            assert!(
                !original.can_replace_presentation_with(&changed),
                "marker={marker}"
            );
            assert!(
                !changed.can_replace_presentation_with(&original),
                "marker={marker}"
            );
        }
    }

    #[test]
    fn view_scripts_have_a_complete_separate_graph_and_integrity_boundary() {
        let mut m = wxs_manifest();
        assert!(
            m.validate().is_ok(),
            "CommonJS WXS cycles are valid graph edges"
        );
        m.refresh_integrity().unwrap();
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(
            json["viewScripts"][2]["dependencies"],
            serde_json::json!([])
        );
        assert_eq!(
            json["templates"][0]["wxsModules"]["tools"],
            "wxs:utils/helper.wxs"
        );
        let decoded: ContainerManifestV1 = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(decoded, m);
        assert!(decoded.verify_integrity().is_ok());
        m.view_scripts[0].sha256 = "f".repeat(64);
        assert!(
            m.verify_integrity().is_err(),
            "WXS content participates in the integrity root"
        );
        let mut missing_graph = json;
        missing_graph["viewScripts"][0]
            .as_object_mut()
            .unwrap()
            .remove("dependencies");
        assert!(serde_json::from_value::<ContainerManifestV1>(missing_graph).is_err());
        let old = serde_json::to_value(manifest()).unwrap();
        assert!(old.get("viewScripts").is_none());
        assert!(serde_json::from_value::<ContainerManifestV1>(old)
            .unwrap()
            .view_scripts
            .is_empty());
    }

    #[test]
    fn rejects_invalid_wxs_graph_hashes_and_appservice_mixing() {
        for target in [
            "wxs:missing.wxs",
            "module:app.js",
            "wxs:pages/index/index.wxml#inlineTools",
        ] {
            let mut m = wxs_manifest();
            m.view_scripts[0].dependencies = vec![target.into()];
            assert!(matches!(
                m.validate(),
                Err(ManifestError::InvalidField {
                    field: "viewScripts.dependencies",
                    ..
                })
            ));
        }
        let mut m = wxs_manifest();
        let duplicate = m.view_scripts[0].dependencies[0].clone();
        m.view_scripts[0].dependencies.push(duplicate);
        assert!(m.validate().is_err());
        let mut m = wxs_manifest();
        m.view_scripts[0].sha256 = "BAD".into();
        assert!(matches!(
            m.validate(),
            Err(ManifestError::InvalidHash { .. })
        ));
        let mut m = wxs_manifest();
        m.view_scripts.push(m.view_scripts[0].clone());
        assert!(matches!(m.validate(), Err(ManifestError::DuplicateId(_))));
        let mut m = wxs_manifest();
        m.assets[0].path = "utils/helper.wxs".into();
        assert!(matches!(
            m.validate(),
            Err(ManifestError::InvalidField {
                field: "assets",
                ..
            })
        ));
        let mut legacy = manifest();
        legacy.assets[0].path = "utils/helper.wxs".into();
        assert!(
            legacy.validate().is_ok(),
            "legacy v1 WXS asset metadata remains readable without implying execution support"
        );
        let mut m = wxs_manifest();
        m.modules.push(Module {
            id: "module:utils/helper.wxs".into(),
            sha256: "b".repeat(64),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::Page,
            dependencies: vec![],
        });
        assert!(matches!(
            m.validate(),
            Err(ManifestError::InvalidField {
                field: "modules",
                ..
            })
        ));
    }

    #[test]
    fn wxs_aliases_are_lexical_and_inline_sources_have_one_declaring_document() {
        for id in [
            "wxs:../bad.wxs",
            "wxs:a/../../bad.wxs",
            "wxs:/bad.wxs",
            "wxs:a\\bad.wxs",
            "wxs:a/./bad.wxs",
            "wxs:a.wxml#return",
            "wxs:a.wxs?query",
        ] {
            assert!(!valid_view_script_id(id), "{id}");
        }
        for alias in ["", "a.b", "1tools", "return", "a-b"] {
            let mut m = wxs_manifest();
            m.templates[0]
                .wxs_modules
                .insert(alias.into(), "wxs:utils/helper.wxs".into());
            assert!(matches!(
                m.validate(),
                Err(ManifestError::InvalidField {
                    field: "templates.wxsModules",
                    ..
                })
            ));
        }
        for target in [
            "wxs:missing.wxs",
            "module:app.js",
            "wxs:pages/other/index.wxml#inlineTools",
        ] {
            let mut m = wxs_manifest();
            m.templates[0]
                .wxs_modules
                .insert("tools".into(), target.into());
            assert!(m.validate().is_err());
        }
        let mut m = wxs_manifest();
        let inline = m.templates[0].wxs_modules.remove("inlineTools").unwrap();
        m.templates[0].wxs_modules.insert("renamed".into(), inline);
        assert!(m.validate().is_err());
        m.templates[0].wxs_modules.remove("renamed");
        assert!(matches!(
            m.validate(),
            Err(ManifestError::InvalidField {
                field: "viewScripts",
                ..
            })
        ));
        let mut m = wxs_manifest();
        m.templates.push(Template {
            id: "template:pages/other/index.wxml".into(),
            wxml_ast: format!("sha256:{}", "f".repeat(64)),
            bindings: vec![],
            wxs_modules: BTreeMap::from([("tools".into(), "wxs:utils/dep.wxs".into())]),
        });
        assert!(
            m.validate().is_ok(),
            "the same alias can belong to different documents"
        );
        let mut legacy = manifest();
        legacy.templates.push(Template {
            id: "template:page.wxml".into(),
            wxml_ast: format!("sha256:{}", "a".repeat(64)),
            bindings: vec![],
            wxs_modules: BTreeMap::new(),
        });
        assert!(serde_json::to_value(legacy).unwrap()["templates"][0]
            .get("wxsModules")
            .is_none());
    }

    #[test]
    fn integrity_round_trip() {
        let mut m = manifest();
        m.refresh_integrity().unwrap();
        assert!(m.verify_integrity().is_ok());
        m.app.entry_module = "other.js".into();
        assert!(m.verify_integrity().is_err());
    }

    #[test]
    fn schema_serializes_expected_keys() {
        let json = serde_json::to_value(manifest()).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert!(json.get("compiler").is_some());
    }

    #[test]
    fn rejects_duplicate_ids_and_bad_hashes() {
        let mut m = manifest();
        m.routes.push(Route {
            id: "same".into(),
            path: "a".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "a.js".into(),
        });
        m.templates.push(Template {
            id: "same".into(),
            wxml_ast: "{}".into(),
            bindings: vec![],
            wxs_modules: Default::default(),
        });
        assert!(matches!(m.validate(), Err(ManifestError::DuplicateId(_))));
        m.routes[0].id = "route:r".into();
        m.templates[0].id = "template:t".into();
        m.templates[0].wxml_ast = format!("sha256:{}", "a".repeat(64));
        m.assets[0].sha256 = "bad".into();
        assert!(matches!(
            m.validate(),
            Err(ManifestError::InvalidHash { .. })
        ));
    }

    #[test]
    fn accepts_global_runtime_capabilities() {
        let mut m = manifest();
        m.capabilities
            .insert("getCurrentPages".into(), CapabilitySupport::Partial);
        m.capabilities
            .insert("wx.canvas.draw".into(), CapabilitySupport::Partial);
        assert!(m.validate().is_ok());
        m.capabilities
            .insert("get-current-pages".into(), CapabilitySupport::Partial);
        assert!(matches!(
            m.validate(),
            Err(ManifestError::InvalidField {
                field: "capabilities",
                ..
            })
        ));
    }

    #[test]
    fn instance_capability_names_are_scoped_to_page_and_component_methods() {
        let mut m = manifest();
        for name in [
            "Page.selectComponent",
            "Page.selectAllComponents",
            "Component.selectComponent",
            "Component.selectAllComponents",
            "Component.selectOwnerComponent",
        ] {
            m.capabilities
                .insert(name.into(), CapabilitySupport::Partial);
        }
        assert!(m.validate().is_ok());
        for invalid in [
            "Other.selectComponent",
            "Page.",
            "Component.selectComponent.deep",
            "Page..selectComponent",
        ] {
            let mut invalid_manifest = m.clone();
            invalid_manifest
                .capabilities
                .insert(invalid.into(), CapabilitySupport::Partial);
            assert!(matches!(
                invalid_manifest.validate(),
                Err(ManifestError::InvalidField {
                    field: "capabilities",
                    ..
                })
            ));
        }
    }

    #[test]
    fn host_capability_names_accept_canonical_objects_components_and_extensions() {
        let mut m = manifest();
        let catalog: serde_json::Value = serde_json::from_str(include_str!(
            "../../container-runtime/src/host-api-catalog.json"
        ))
        .unwrap();
        for api in catalog["apis"].as_array().unwrap() {
            let name = api["name"].as_str().unwrap();
            assert!(
                valid_capability_name(name),
                "locked API catalog name rejected: {name}"
            );
        }
        for name in [
            "object:FileSystemManager.readFileSync",
            "object:CameraContext.takePhoto",
            "component:camera",
            "component:live-player",
            "component:button.open-type.getPhoneNumber",
            "weappContainer.identity.getState",
            "weappContainer.payment.request",
        ] {
            assert!(valid_capability_name(name), "{name}");
            m.capabilities
                .insert(name.into(), CapabilitySupport::Partial);
        }
        assert!(m.validate().is_ok());
        for name in [
            "object:FileSystemManager",
            "object:FileSystemManager.readFile.deep",
            "object:1Type.read",
            "object:FileSystemManager..read",
            "component:",
            "component:camera/../../private",
            "component:button..getPhoneNumber",
            "component:live--player",
            "weappContainer.",
            "weappContainer.identity..getState",
            "weappContainer.1identity.getState",
            "untrusted:camera",
        ] {
            assert!(!valid_capability_name(name), "{name}");
        }
    }
}
