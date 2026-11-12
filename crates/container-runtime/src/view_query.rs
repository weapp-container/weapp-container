//! Pure selector matching over an evaluated [`ViewDocument`], before layout.
//!
//! This adapter preserves the document forest's source order, text siblings and
//! declaration ownership. Its synthetic [`ViewQueryPage`] is a query boundary,
//! not a View occurrence, viewport, event target or presentation handle. Matching
//! does not validate presentation state or authorize a caller, and does not
//! expose a `wx` DOM capability. Those gates remain the runtime caller's job.
//!
//! Selectors use [`container_core::selector`]'s portable grammar, not browser
//! CSS semantics. In particular, text nodes participate in `*` and sibling
//! positions. No View expression is evaluated while constructing or querying
//! this adapter.

use crate::view_topology::scalar_attribute;
use container_core::selector::{
    self, CompiledSelectorList, SelectorError, SelectorNodeRef, SelectorTree,
};
use container_ir::{ViewDocument, ViewNode, ViewOwnership};
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum ViewQueryError {
    #[error("invalid View document: {0}")]
    InvalidDocument(String),
    #[error("View occurrence {occurrence_id} attribute {name} must be a JSON scalar")]
    InvalidScalarAttribute { occurrence_id: String, name: String },
}

/// A page-level query boundary with document identity and no occurrence id.
///
/// This is independent of any host viewport and carries no geometry, input
/// identity, presentation acknowledgement or authorization.
#[derive(Clone, Copy, Debug)]
pub struct ViewQueryPage<'document> {
    document: &'document ViewDocument,
}

impl<'document> ViewQueryPage<'document> {
    pub fn document(self) -> &'document ViewDocument {
        self.document
    }

    pub fn session_id(self) -> &'document str {
        &self.document.session_id
    }

    pub fn page_id(self) -> u64 {
        self.document.page_id
    }

    pub fn revision(self) -> u64 {
        self.document.revision
    }

    pub fn route_path(self) -> &'document str {
        &self.document.route_path
    }
}

/// An unchanged source occurrence, including text and its original ownership.
#[derive(Clone, Copy, Debug)]
pub struct ViewQueryOccurrence<'document> {
    node: &'document ViewNode,
}

impl<'document> ViewQueryOccurrence<'document> {
    pub fn node(self) -> &'document ViewNode {
        self.node
    }

    pub fn occurrence_id(self) -> &'document str {
        self.node.occurrence_id()
    }

    pub fn ownership(self) -> &'document ViewOwnership {
        self.node.ownership()
    }
}

/// Query results distinguish the page boundary from addressable occurrences.
#[derive(Clone, Copy, Debug)]
pub enum ViewQueryNode<'document> {
    Page(ViewQueryPage<'document>),
    Occurrence(ViewQueryOccurrence<'document>),
}

#[derive(Debug)]
struct CachedOccurrence<'document> {
    node: &'document ViewNode,
    id: Option<String>,
    classes: Vec<String>,
    children: Vec<usize>,
}

/// A borrowed document and cached scalar selector metadata, without layout.
///
/// Selector identity (`#id` and `.class`) uses the same authoritative scalar
/// conversion as event topology: typed values override legacy strings, null
/// becomes an empty string, and arrays/objects are rejected. Attribute selectors
/// retain the document's already evaluated `attrs` string projection, including
/// object-valued dataset attributes. Identity and attribute selectors can thus
/// differ, preserving the existing portable query boundary and the shared
/// matcher's historical class fallback. Original typed values remain available
/// through [`ViewQueryOccurrence::node`]; they are never re-evaluated or newly
/// serialized here.
///
/// Cached classes avoid splitting or allocating per node during each query.
/// Managed scope filtering uses `event_owner`; neither physical ancestry nor
/// `slot_owner` is a substitute for the document's event declaration ownership.
#[derive(Debug)]
pub struct ViewDocumentQuery<'document> {
    document: &'document ViewDocument,
    roots: Vec<usize>,
    nodes: Vec<CachedOccurrence<'document>>,
    page_attributes: BTreeMap<String, String>,
}

impl<'document> ViewDocumentQuery<'document> {
    pub fn from_document(document: &'document ViewDocument) -> Result<Self, ViewQueryError> {
        document
            .validate()
            .map_err(|error| ViewQueryError::InvalidDocument(error.to_string()))?;
        let mut nodes = Vec::new();
        let roots = document
            .nodes
            .iter()
            .map(|node| cache_occurrence(node, &mut nodes))
            .collect::<Result<_, _>>()?;
        Ok(Self {
            document,
            roots,
            nodes,
            page_attributes: BTreeMap::new(),
        })
    }

    pub fn page(&self) -> ViewQueryPage<'document> {
        ViewQueryPage {
            document: self.document,
        }
    }

    /// Parse before looking up a scope, so a missing scope cannot hide invalid
    /// syntax. `all = false` selects the first result after owner filtering.
    pub fn query(
        &self,
        source: &str,
        all: bool,
        scope: Option<&str>,
    ) -> Result<Vec<ViewQueryNode<'document>>, SelectorError> {
        let selector = CompiledSelectorList::parse(source)?;
        Ok(self.query_compiled(&selector, all, scope))
    }

    /// Reuse a validated selector while preserving source-order DFS results.
    ///
    /// A managed scope matches relationships across its complete subtree, then
    /// filters returned declaration owners. Scope roots hide outer ancestors.
    /// Legacy `data-sim-scope` roots retain subtree-only matching semantics.
    pub fn query_compiled(
        &self,
        selector: &CompiledSelectorList,
        all: bool,
        scope: Option<&str>,
    ) -> Vec<ViewQueryNode<'document>> {
        selector::query(&QueryTree(self), selector, all, scope)
            .into_iter()
            .map(|handle| match handle {
                QueryHandle::Page => ViewQueryNode::Page(self.page()),
                QueryHandle::Occurrence(index) => ViewQueryNode::Occurrence(ViewQueryOccurrence {
                    node: self.nodes[index].node,
                }),
            })
            .collect()
    }
}

fn cache_occurrence<'document>(
    node: &'document ViewNode,
    nodes: &mut Vec<CachedOccurrence<'document>>,
) -> Result<usize, ViewQueryError> {
    let mut id = None;
    let mut classes = Vec::new();
    if let ViewNode::Element {
        attrs, typed_attrs, ..
    } = node
    {
        let scalar = |name: &str| {
            scalar_attribute(node.occurrence_id(), attrs, typed_attrs, name).map_err(|_| {
                ViewQueryError::InvalidScalarAttribute {
                    occurrence_id: node.occurrence_id().into(),
                    name: name.into(),
                }
            })
        };
        id = scalar("id")?;
        classes = scalar("class")?
            .map(|value| value.split_whitespace().map(str::to_owned).collect())
            .unwrap_or_default();
    }
    let index = nodes.len();
    nodes.push(CachedOccurrence {
        node,
        id,
        classes,
        children: Vec::new(),
    });
    if let ViewNode::Element { children, .. } = node {
        let children = children
            .iter()
            .map(|child| cache_occurrence(child, nodes))
            .collect::<Result<_, _>>()?;
        nodes[index].children = children;
    }
    Ok(index)
}

#[derive(Clone, Copy)]
enum QueryHandle {
    Page,
    Occurrence(usize),
}

// Keep integer handles private to the matcher. Public results borrow the source
// document, so callers cannot accidentally reuse a cache index in another tree.
struct QueryTree<'query, 'document>(&'query ViewDocumentQuery<'document>);

impl SelectorTree for QueryTree<'_, '_> {
    type Node = QueryHandle;

    fn root(&self) -> Self::Node {
        QueryHandle::Page
    }

    fn metadata(&self, handle: Self::Node) -> SelectorNodeRef<'_> {
        match handle {
            QueryHandle::Page => SelectorNodeRef {
                tag: Some("page"),
                id: None,
                classes: &[],
                attributes: &self.0.page_attributes,
                owner_scope: None,
                component_scope: None,
            },
            QueryHandle::Occurrence(index) => {
                let cached = &self.0.nodes[index];
                let (tag, attributes) = match cached.node {
                    ViewNode::Element { tag, attrs, .. } => (Some(tag.as_str()), attrs),
                    ViewNode::Text { .. } => (None, &self.0.page_attributes),
                };
                SelectorNodeRef {
                    tag,
                    id: cached.id.as_deref(),
                    classes: &cached.classes,
                    attributes,
                    owner_scope: cached.node.ownership().event_owner.as_deref(),
                    component_scope: cached.node.ownership().component_scope.as_deref(),
                }
            }
        }
    }

    fn child(&self, handle: Self::Node, index: usize) -> Option<Self::Node> {
        let children = match handle {
            QueryHandle::Page => &self.0.roots,
            QueryHandle::Occurrence(index) => &self.0.nodes[index].children,
        };
        children.get(index).copied().map(QueryHandle::Occurrence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_ir::{RendererProfile, VIEW_DOCUMENT_VERSION};
    use serde_json::{json, Value};

    fn ownership() -> ViewOwnership {
        ViewOwnership {
            document_id: "pages/home/index.wxml".into(),
            ..ViewOwnership::default()
        }
    }

    fn element(
        occurrence_id: &str,
        tag: &str,
        attrs: &[(&str, &str)],
        children: Vec<ViewNode>,
    ) -> ViewNode {
        ViewNode::Element {
            occurrence_id: occurrence_id.into(),
            tag: tag.into(),
            attrs: attrs
                .iter()
                .map(|(name, value)| ((*name).into(), (*value).into()))
                .collect(),
            typed_attrs: BTreeMap::new(),
            key: None,
            ownership: ownership(),
            events: Vec::new(),
            children,
        }
    }

    fn text(occurrence_id: &str) -> ViewNode {
        ViewNode::Text {
            occurrence_id: occurrence_id.into(),
            value: "text sibling".into(),
            ownership: ownership(),
        }
    }

    fn owned(
        mut node: ViewNode,
        owner: &str,
        scope: Option<&str>,
        slot_owner: Option<&str>,
    ) -> ViewNode {
        let ownership = match &mut node {
            ViewNode::Element { ownership, .. } | ViewNode::Text { ownership, .. } => ownership,
        };
        ownership.event_owner = Some(owner.into());
        ownership.component_scope = scope.map(str::to_owned);
        ownership.slot_owner = slot_owner.map(str::to_owned);
        node
    }

    fn document(nodes: Vec<ViewNode>) -> ViewDocument {
        ViewDocument {
            version: VIEW_DOCUMENT_VERSION.into(),
            session_id: "session".into(),
            page_id: 7,
            revision: 11,
            route_path: "pages/home/index".into(),
            profile: RendererProfile::WebView,
            nodes,
            style_roots: Vec::new(),
            styles: Vec::new(),
            resources: Vec::new(),
        }
    }

    fn ids(nodes: Vec<ViewQueryNode<'_>>) -> Vec<String> {
        nodes
            .into_iter()
            .map(|node| match node {
                ViewQueryNode::Page(_) => "$page".into(),
                ViewQueryNode::Occurrence(occurrence) => occurrence.occurrence_id().into(),
            })
            .collect()
    }

    #[test]
    fn source_forest_dfs_preserves_duplicate_public_ids_and_union_order() {
        let document = document(vec![
            element(
                "z-root",
                "view",
                &[],
                vec![element(
                    "z-first",
                    "text",
                    &[("id", "duplicate"), ("class", "card")],
                    vec![],
                )],
            ),
            element(
                "a-later",
                "view",
                &[("id", "duplicate"), ("class", "card")],
                vec![],
            ),
        ]);
        let tree = ViewDocumentQuery::from_document(&document).unwrap();
        let compiled = CompiledSelectorList::parse(".card,#duplicate,.card").unwrap();
        assert_eq!(
            ids(tree.query_compiled(&compiled, true, None)),
            ["z-first", "a-later"]
        );
        assert_eq!(
            ids(tree.query("#duplicate", false, None).unwrap()),
            ["z-first"]
        );
        assert!(tree.query("#z-first", true, None).unwrap().is_empty());
        let ViewQueryNode::Occurrence(first) = tree.query("#duplicate", false, None).unwrap()[0]
        else {
            panic!("public id must select an occurrence");
        };
        let ViewNode::Element { children, .. } = &document.nodes[0] else {
            unreachable!();
        };
        assert!(std::ptr::eq(first.node(), &children[0]));
    }

    #[test]
    fn page_is_a_typed_query_boundary_not_a_viewport_or_occurrence() {
        let document = document(vec![element(
            "viewport",
            "view",
            &[("id", "viewport"), ("class", "card")],
            vec![element("nested", "view", &[("class", "card")], vec![])],
        )]);
        let before = document.clone();
        let tree = ViewDocumentQuery::from_document(&document).unwrap();
        let results = tree.query("page", true, None).unwrap();
        let [ViewQueryNode::Page(page)] = results.as_slice() else {
            panic!("page must select the query-only page handle");
        };
        assert_eq!(page.session_id(), "session");
        assert_eq!(page.page_id(), 7);
        assert_eq!(page.revision(), 11);
        assert_eq!(page.route_path(), "pages/home/index");
        assert!(std::ptr::eq(page.document(), &document));
        assert_eq!(
            ids(tree.query("page > .card", true, None).unwrap()),
            ["viewport"]
        );
        assert_eq!(
            ids(tree.query("#viewport", true, None).unwrap()),
            ["viewport"]
        );
        assert!(tree.query("viewport", true, None).unwrap().is_empty());
        assert_eq!(document, before);
    }

    #[test]
    fn text_siblings_keep_their_positions_in_the_original_forest() {
        let document = document(vec![
            element("first", "view", &[("class", "a")], vec![]),
            text("middle-text"),
            element("last", "view", &[("class", "b")], vec![]),
        ]);
        let tree = ViewDocumentQuery::from_document(&document).unwrap();
        assert_eq!(
            ids(tree.query("*", true, None).unwrap()),
            ["$page", "first", "middle-text", "last"]
        );
        assert!(tree.query(".a + .b", true, None).unwrap().is_empty());
        for source in [".a + * + .b", ".a ~ .b"] {
            assert_eq!(ids(tree.query(source, true, None).unwrap()), ["last"]);
        }
        assert_eq!(
            ids(tree.query("page > *", true, None).unwrap()),
            ["first", "middle-text", "last"]
        );
    }

    fn managed_document() -> ViewDocument {
        document(vec![element(
            "outer",
            "view",
            &[("class", "outside")],
            vec![owned(
                element(
                    "host",
                    "panel",
                    &[("class", "m")],
                    vec![
                        owned(
                            element("light", "text", &[("class", "m light")], vec![]),
                            "page-owner",
                            None,
                            Some("page-owner"),
                        ),
                        owned(
                            element("owned", "view", &[("class", "m owned")], vec![]),
                            "S",
                            None,
                            None,
                        ),
                        owned(
                            element(
                                "wrapper",
                                "badge",
                                &[("class", "m wrapper")],
                                vec![
                                    owned(
                                        element("private", "text", &[("class", "m")], vec![]),
                                        "T",
                                        None,
                                        None,
                                    ),
                                    owned(
                                        element("projected", "text", &[("class", "m")], vec![]),
                                        "S",
                                        None,
                                        Some("T"),
                                    ),
                                ],
                            ),
                            "S",
                            Some("T"),
                            None,
                        ),
                    ],
                ),
                "page-owner",
                Some("S"),
                None,
            )],
        )])
    }

    #[test]
    fn managed_scope_filters_results_after_relationships_and_before_first_selection() {
        let document = managed_document();
        let tree = ViewDocumentQuery::from_document(&document).unwrap();
        assert_eq!(
            ids(tree.query(".m", true, Some("S")).unwrap()),
            ["owned", "wrapper", "projected"]
        );
        assert_eq!(ids(tree.query(".m", false, Some("S")).unwrap()), ["owned"]);
        assert_eq!(
            ids(tree.query(".light + .owned", true, Some("S")).unwrap()),
            ["owned"]
        );
        assert_eq!(
            ids(tree.query(".wrapper > .m", true, Some("S")).unwrap()),
            ["projected"]
        );
        assert!(tree
            .query(".outside .m", true, Some("S"))
            .unwrap()
            .is_empty());
        assert!(tree.query("page .m", true, Some("S")).unwrap().is_empty());
    }

    #[test]
    fn nested_scope_and_slot_results_use_event_owner_without_rewriting_source_ownership() {
        let document = managed_document();
        let tree = ViewDocumentQuery::from_document(&document).unwrap();
        assert_eq!(ids(tree.query(".m", true, Some("T")).unwrap()), ["private"]);
        let result = tree.query(".wrapper > .m", false, Some("S")).unwrap()[0];
        let ViewQueryNode::Occurrence(projected) = result else {
            panic!("projected content must retain its source occurrence");
        };
        assert_eq!(projected.ownership().event_owner.as_deref(), Some("S"));
        assert_eq!(projected.ownership().slot_owner.as_deref(), Some("T"));
    }

    #[test]
    fn legacy_scope_is_first_source_subtree_without_managed_owner_filtering() {
        let document = document(vec![
            owned(
                element(
                    "z-host",
                    "panel",
                    &[("data-sim-scope", "legacy"), ("class", "m")],
                    vec![owned(
                        element("child", "view", &[("class", "m")], vec![]),
                        "other-owner",
                        None,
                        None,
                    )],
                ),
                "page-owner",
                Some("different-managed-scope"),
                None,
            ),
            element(
                "a-host",
                "panel",
                &[("data-sim-scope", "legacy"), ("class", "m")],
                vec![],
            ),
        ]);
        let tree = ViewDocumentQuery::from_document(&document).unwrap();
        assert_eq!(
            ids(tree.query(".m", true, Some("legacy")).unwrap()),
            ["z-host", "child"]
        );
        assert_eq!(
            ids(tree.query(".m", false, Some("legacy")).unwrap()),
            ["z-host"]
        );
        assert!(tree
            .query("page .m", true, Some("legacy"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn missing_scope_still_validates_selector_syntax_first() {
        let document = document(vec![]);
        let tree = ViewDocumentQuery::from_document(&document).unwrap();
        assert_eq!(
            tree.query("", true, Some("missing")).unwrap_err(),
            SelectorError::Empty
        );
        assert!(matches!(
            tree.query("view >", true, Some("missing")),
            Err(SelectorError::Unsupported(_))
        ));
        assert!(tree
            .query("page", true, Some("missing"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn typed_identity_and_raw_attributes_keep_their_existing_distinct_boundaries() {
        let mut null_node = element(
            "null",
            "view",
            &[("id", "legacy-id"), ("class", "legacy-class")],
            vec![],
        );
        let ViewNode::Element { typed_attrs, .. } = &mut null_node else {
            unreachable!();
        };
        typed_attrs.extend([("id".into(), Value::Null), ("class".into(), Value::Null)]);
        let mut bool_node = element(
            "bool",
            "view",
            &[
                ("id", "legacy-id"),
                ("class", "legacy-class"),
                ("data-number", "1.0"),
                ("data-object", "legacy-object"),
                ("data-array", "legacy-array"),
                ("title", "{{mustNotRun()}}"),
            ],
            vec![],
        );
        let ViewNode::Element { typed_attrs, .. } = &mut bool_node else {
            unreachable!();
        };
        typed_attrs.extend([
            ("id".into(), json!(false)),
            ("class".into(), json!(false)),
            ("data-number".into(), json!(1.0)),
            ("data-object".into(), json!({"value": false})),
            ("data-array".into(), json!([1, 2])),
            ("data-null".into(), Value::Null),
            ("title".into(), json!("{{alreadyEvaluated()}}")),
        ]);
        let mut number_node = element(
            "number",
            "view",
            &[("id", "numeric-legacy"), ("class", "numeric-legacy")],
            vec![],
        );
        let ViewNode::Element { typed_attrs, .. } = &mut number_node else {
            unreachable!();
        };
        typed_attrs.extend([("id".into(), json!(1.0)), ("class".into(), json!(-0.0))]);
        let document = document(vec![null_node, bool_node, number_node]);
        let before = document.clone();
        let tree = ViewDocumentQuery::from_document(&document).unwrap();
        for source in [
            "#false",
            ".false",
            "[data-object]",
            "[data-array]",
            "[data-number=1.0]",
            "[title='{{mustNotRun()}}']",
        ] {
            assert_eq!(
                ids(tree.query(source, true, None).unwrap()),
                ["bool"],
                "{source}"
            );
        }
        for source in [
            "#legacy-id",
            ".legacy-class",
            "[id=false]",
            "[class=false]",
            "[id='']",
            "[class='']",
            "[data-null]",
            "[data-number=1]",
            "[title='{{alreadyEvaluated()}}']",
        ] {
            assert!(
                tree.query(source, true, None).unwrap().is_empty(),
                "{source}"
            );
        }
        for source in ["#1", ".0", "#1.0"] {
            assert_eq!(ids(tree.query(source, true, None).unwrap()), ["number"]);
        }
        assert_eq!(
            ids(tree
                .query("[id=legacy-id][class=legacy-class]", true, None)
                .unwrap()),
            ["null", "bool"]
        );
        assert_eq!(
            ids(tree.query("[id][class]", true, None).unwrap()),
            ["null", "bool", "number"]
        );
        assert_eq!(tree.nodes[0].id.as_deref(), Some(""));
        assert!(tree.nodes[0].classes.is_empty());
        let ViewQueryNode::Occurrence(result) = tree.query("#false", false, None).unwrap()[0]
        else {
            unreachable!();
        };
        let ViewNode::Element { typed_attrs, .. } = result.node() else {
            unreachable!();
        };
        assert_eq!(typed_attrs["data-object"], json!({"value": false}));
        assert_eq!(typed_attrs["data-array"], json!([1, 2]));
        assert_eq!(document, before);
    }

    #[test]
    fn typed_only_identity_keeps_the_shared_class_fallback_without_inventing_attributes() {
        let mut node = element("typed-only", "view", &[], vec![]);
        let ViewNode::Element { typed_attrs, .. } = &mut node else {
            unreachable!();
        };
        typed_attrs.extend([
            ("id".into(), json!("generated")),
            ("class".into(), json!("alpha")),
            ("data-object".into(), json!({"value": false})),
        ]);
        let document = document(vec![node]);
        let tree = ViewDocumentQuery::from_document(&document).unwrap();
        for source in ["#generated", ".alpha", "[class]", "[class=alpha]"] {
            assert_eq!(ids(tree.query(source, true, None).unwrap()), ["typed-only"]);
        }
        for source in ["[id]", "[data-object]"] {
            assert!(tree.query(source, true, None).unwrap().is_empty());
        }
    }

    #[test]
    fn scalar_identity_rejection_does_not_reject_unrelated_component_objects() {
        for (name, value) in [
            ("id", json!({"not": "scalar"})),
            ("id", json!([1])),
            ("class", json!({"not": "scalar"})),
            ("class", json!([1])),
        ] {
            let mut node = element("invalid", "view", &[], vec![]);
            let ViewNode::Element { typed_attrs, .. } = &mut node else {
                unreachable!();
            };
            typed_attrs.insert(name.into(), value);
            let document = document(vec![node]);
            document.validate().unwrap();
            assert_eq!(
                ViewDocumentQuery::from_document(&document).unwrap_err(),
                ViewQueryError::InvalidScalarAttribute {
                    occurrence_id: "invalid".into(),
                    name: name.into(),
                }
            );
        }
    }

    #[test]
    fn invalid_document_is_rejected_before_indexing() {
        let document = document(vec![text("same-occurrence"), text("same-occurrence")]);
        assert!(matches!(
            ViewDocumentQuery::from_document(&document),
            Err(ViewQueryError::InvalidDocument(_))
        ));
    }
}
