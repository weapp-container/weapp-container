//! Evaluated View data before either Rust or browser layout. This transport
//! contains no bounds and never asks a presenter to evaluate View expressions.
use crate::rendering::canonical_view_path;
use crate::{is_sha256, validate_wxss, Asset, RendererProfile, WxssIr};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const VIEW_DOCUMENT_VERSION: &str = "1.0";
const MAX_VIEW_NODES: usize = 100_000;
const MAX_VIEW_DEPTH: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewDocument {
    pub version: String,
    pub session_id: String,
    pub page_id: u64,
    pub revision: u64,
    pub route_path: String,
    pub profile: RendererProfile,
    pub nodes: Vec<ViewNode>,
    /// Ordered entry styles. Available declared imports also have entries in
    /// `styles`, preserving source-order IR rather than flattening CSS.
    /// Unresolved references remain in raw IR; projection is not proof that
    /// every conditional import was loaded or accepted by a browser renderer.
    pub style_roots: Vec<String>,
    pub styles: Vec<ViewStyleSheet>,
    pub resources: Vec<Asset>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewOwnership {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component_scope: Option<String>,
    /// Declaration owner of projected slot content; physical DOM ancestry is
    /// deliberately not a replacement for this semantic ownership.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_owner: Option<String>,
    pub document_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewEventPhase {
    Capture,
    Bubble,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewEventBinding {
    pub event: String,
    pub handler: String,
    pub phase: ViewEventPhase,
    /// A presenter can synchronously apply the declared catch policy before
    /// posting a batched event to a potentially remote AppService.
    pub catch: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ViewNode {
    Element {
        #[serde(rename = "occurrenceId")]
        occurrence_id: String,
        tag: String,
        attrs: BTreeMap<String, String>,
        /// When a key exists here this JSON value is authoritative. `attrs`
        /// is only the legacy string projection and must not be re-evaluated.
        #[serde(rename = "typedAttrs", default)]
        typed_attrs: BTreeMap<String, Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
        ownership: ViewOwnership,
        events: Vec<ViewEventBinding>,
        children: Vec<ViewNode>,
    },
    Text {
        #[serde(rename = "occurrenceId")]
        occurrence_id: String,
        value: String,
        ownership: ViewOwnership,
    },
}

impl ViewNode {
    pub fn occurrence_id(&self) -> &str {
        match self {
            Self::Element { occurrence_id, .. } | Self::Text { occurrence_id, .. } => occurrence_id,
        }
    }

    pub fn ownership(&self) -> &ViewOwnership {
        match self {
            Self::Element { ownership, .. } | Self::Text { ownership, .. } => ownership,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewStyleSheet {
    pub id: String,
    /// One source stylesheet may occur once per component instance scope.
    /// Scoped copies must retain identical IR for the same source id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    pub ir: WxssIr,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewDocumentError(pub String);

impl std::fmt::Display for ViewDocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
impl std::error::Error for ViewDocumentError {}

impl ViewDocument {
    pub fn validate(&self) -> Result<(), ViewDocumentError> {
        let invalid = |message: &str| ViewDocumentError(message.into());
        if self.version != VIEW_DOCUMENT_VERSION {
            return Err(invalid("unsupported ViewDocument version"));
        }
        if self.session_id.is_empty() || !canonical_view_path(&self.route_path) {
            return Err(invalid(
                "ViewDocument requires a session and canonical route",
            ));
        }
        let mut identities = BTreeSet::new();
        let mut pending: Vec<_> = self.nodes.iter().map(|node| (node, 0)).collect();
        while let Some((node, depth)) = pending.pop() {
            if depth > MAX_VIEW_DEPTH || identities.len() >= MAX_VIEW_NODES {
                return Err(invalid("ViewDocument node budget exceeded"));
            }
            if node.occurrence_id().is_empty() || !identities.insert(node.occurrence_id()) {
                return Err(invalid(
                    "ViewDocument occurrence ids must be nonempty and unique",
                ));
            }
            let owner = node.ownership();
            if !canonical_view_path(&owner.document_id) || !owner.document_id.ends_with(".wxml") {
                return Err(invalid(
                    "ViewDocument ownership requires an emitted WXML path",
                ));
            }
            if [
                &owner.event_owner,
                &owner.component_scope,
                &owner.slot_owner,
            ]
            .into_iter()
            .any(|value| value.as_ref().is_some_and(String::is_empty))
            {
                return Err(invalid("ViewDocument owner ids cannot be empty"));
            }
            if let ViewNode::Element {
                tag,
                events,
                children,
                ..
            } = node
            {
                if tag.is_empty() {
                    return Err(invalid("ViewDocument element tag cannot be empty"));
                }
                let mut bindings = BTreeSet::new();
                for event in events {
                    let phase = matches!(event.phase, ViewEventPhase::Capture);
                    if event.event.is_empty()
                        || event.handler.is_empty()
                        || !bindings.insert((&event.event, phase))
                    {
                        return Err(invalid(
                            "ViewDocument event bindings must be valid and unique per phase",
                        ));
                    }
                }
                pending.extend(children.iter().map(|child| (child, depth + 1)));
            }
        }
        let mut styles = BTreeMap::new();
        let mut style_scopes = BTreeSet::new();
        for style in &self.styles {
            if !style.id.strip_prefix("style:").is_some_and(|path| {
                canonical_view_path(path) && (path.ends_with(".wxss") || path.ends_with(".css"))
            }) || style.scope_id.as_ref().is_some_and(String::is_empty)
                || !style_scopes.insert((&style.id, &style.scope_id))
            {
                return Err(invalid(
                    "ViewDocument stylesheet ids and scopes must be canonical and unique",
                ));
            }
            if styles
                .insert(&style.id, &style.ir)
                .is_some_and(|ir| ir != &style.ir)
            {
                return Err(invalid(
                    "ViewDocument scoped copies must retain the same source stylesheet",
                ));
            }
            validate_wxss(&style.ir).map_err(|error| ViewDocumentError(error.to_string()))?;
        }
        if self
            .style_roots
            .iter()
            .any(|root| !styles.contains_key(root))
        {
            return Err(invalid("ViewDocument style root is missing"));
        }
        let mut resources = BTreeSet::new();
        for resource in &self.resources {
            if !canonical_view_path(&resource.path)
                || !is_sha256(&resource.sha256)
                || resource.mime.is_empty()
                || !resources.insert(&resource.path)
            {
                return Err(invalid(
                    "ViewDocument resource references must be canonical and unique",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> ViewDocument {
        ViewDocument {
            version: VIEW_DOCUMENT_VERSION.into(),
            session_id: "session".into(),
            page_id: 1,
            revision: 2,
            route_path: "pages/home/index".into(),
            profile: RendererProfile::WebView,
            nodes: vec![ViewNode::Element {
                occurrence_id: "node:key-a".into(),
                tag: "view".into(),
                attrs: BTreeMap::from([("data-value".into(), "false".into())]),
                typed_attrs: BTreeMap::from([("data-value".into(), Value::Bool(false))]),
                key: Some("a".into()),
                ownership: ViewOwnership {
                    document_id: "pages/home/index.wxml".into(),
                    slot_owner: Some("parent".into()),
                    ..ViewOwnership::default()
                },
                events: vec![ViewEventBinding {
                    event: "tap".into(),
                    handler: "onTap".into(),
                    phase: ViewEventPhase::Capture,
                    catch: true,
                }],
                children: vec![],
            }],
            style_roots: vec!["style:app.wxss".into()],
            styles: vec![ViewStyleSheet {
                id: "style:app.wxss".into(),
                scope_id: None,
                ir: crate::parse_wxss("@media (min-width: 100px) { view { width: 40rpx; } }")
                    .unwrap(),
            }],
            resources: vec![],
        }
    }

    #[test]
    fn document_round_trip_preserves_typed_values_ownership_and_raw_style_rules() {
        let value = document();
        value.validate().unwrap();
        let json = serde_json::to_value(&value).unwrap();
        assert_eq!(json["nodes"][0]["typedAttrs"]["data-value"], false);
        assert_eq!(json["nodes"][0]["ownership"]["slotOwner"], "parent");
        assert!(json["nodes"][0].get("bounds").is_none());
        assert_eq!(serde_json::from_value::<ViewDocument>(json).unwrap(), value);
    }

    #[test]
    fn document_rejects_geometry_and_duplicate_occurrences() {
        let mut value = document();
        value.nodes.push(value.nodes[0].clone());
        assert!(value.validate().is_err());
        let mut json = serde_json::to_value(document()).unwrap();
        json["nodes"][0]["bounds"] = serde_json::json!({"width": 50});
        assert!(serde_json::from_value::<ViewDocument>(json).is_err());
    }

    #[test]
    fn document_rejects_unknown_style_roots_and_invalid_resources() {
        let mut value = document();
        value.style_roots.push("style:missing.wxss".into());
        assert!(value.validate().is_err());
        value.style_roots.pop();
        value.resources.push(Asset {
            path: "../secret".into(),
            sha256: "a".repeat(64),
            mime: "image/png".into(),
            size: 1,
        });
        assert!(value.validate().is_err());
    }

    #[test]
    fn component_instances_share_source_styles_without_sharing_scope() {
        let mut value = document();
        let first = ViewStyleSheet {
            id: "style:component.wxss".into(),
            scope_id: Some("instance-a".into()),
            ir: WxssIr::default(),
        };
        let mut second = first.clone();
        second.scope_id = Some("instance-b".into());
        value.styles.extend([first, second]);
        value.validate().unwrap();
        value.styles.push(value.styles[1].clone());
        assert!(value.validate().is_err());
        value.styles.pop();
        value.styles[2].ir = crate::parse_wxss("view { color: red }").unwrap();
        assert!(value.validate().is_err());
    }
}
