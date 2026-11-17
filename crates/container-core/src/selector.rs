//! Renderer-independent SelectorQuery grammar and ordered-tree matching.
//!
//! This preserves the existing portable query subset, including its differences
//! from CSS element selectors. Geometry, presentation leases and API ownership
//! remain the caller's responsibility. WXSS uses a separate language contract.

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectorError {
    Empty,
    Unsupported(String),
}

impl std::fmt::Display for SelectorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => f.write_str("selector must be non-empty"),
            Self::Unsupported(selector) => {
                write!(f, "unsupported selector syntax: {selector}")
            }
        }
    }
}

impl std::error::Error for SelectorError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectorCombinator {
    Descendant,
    Child,
    AdjacentSibling,
    GeneralSibling,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedSelector {
    compounds: Vec<ParsedCompound>,
    combinators: Vec<SelectorCombinator>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SelectorAttribute {
    name: String,
    value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedCompound {
    tag: Option<String>,
    id: Option<String>,
    classes: Vec<String>,
    attributes: Vec<SelectorAttribute>,
}

fn parse_compound_selector(selector: &str) -> Result<ParsedCompound, SelectorError> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err(SelectorError::Empty);
    }
    if selector == "*" {
        return Ok(ParsedCompound {
            tag: None,
            id: None,
            classes: Vec::new(),
            attributes: Vec::new(),
        });
    }
    let bytes = selector.as_bytes();
    let mut index = 0;
    let mut tag = None;
    let wildcard = bytes.first() == Some(&b'*');
    if wildcard {
        index = 1;
    }
    if !wildcard
        && bytes
            .get(index)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'-' || *byte == b'_')
    {
        let start = index;
        index += 1;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'-' | b'_'))
        {
            index += 1;
        }
        tag = Some(selector[start..index].to_owned());
    }
    let mut id = None;
    let mut classes = Vec::new();
    let mut attributes = Vec::new();
    while index < bytes.len() {
        match bytes[index] {
            b'#' | b'.' => {
                let prefix = bytes[index];
                index += 1;
                let start = index;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric()
                        || matches!(bytes[index], b'-' | b'_' | b'@'))
                {
                    index += 1;
                }
                if start == index {
                    return Err(SelectorError::Unsupported(selector.to_owned()));
                }
                let token = selector[start..index].to_owned();
                if prefix == b'#' {
                    if id.replace(token).is_some() {
                        return Err(SelectorError::Unsupported(selector.to_owned()));
                    }
                } else {
                    classes.push(token);
                }
            }
            b'[' => {
                let start = index + 1;
                let mut cursor = start;
                let mut quote = None;
                let mut end = None;
                while cursor < bytes.len() {
                    let byte = bytes[cursor];
                    if let Some(expected) = quote {
                        if byte == expected {
                            quote = None;
                        }
                    } else if byte == b'\'' || byte == b'"' {
                        quote = Some(byte);
                    } else if byte == b']' {
                        end = Some(cursor);
                        break;
                    }
                    cursor += 1;
                }
                let Some(end) = end.filter(|_| quote.is_none()) else {
                    return Err(SelectorError::Unsupported(selector.to_owned()));
                };
                let body = selector[start..end].trim();
                if body.is_empty() {
                    return Err(SelectorError::Unsupported(selector.to_owned()));
                }
                let (raw_name, raw_value) =
                    body.split_once('=').map_or((body, None), |(name, value)| {
                        (name.trim(), Some(value.trim()))
                    });
                if raw_name.is_empty()
                    || !raw_name.chars().all(|character| {
                        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':')
                    })
                {
                    return Err(SelectorError::Unsupported(selector.to_owned()));
                }
                let value = raw_value.map(|value| {
                    if value.len() >= 2
                        && ((value.starts_with('\"') && value.ends_with('\"'))
                            || (value.starts_with('\'') && value.ends_with('\'')))
                    {
                        value[1..value.len() - 1].to_owned()
                    } else {
                        value.to_owned()
                    }
                });
                attributes.push(SelectorAttribute {
                    name: raw_name.to_owned(),
                    value,
                });
                index = end + 1;
            }
            _ => return Err(SelectorError::Unsupported(selector.to_owned())),
        }
    }
    if tag.is_none() && id.is_none() && classes.is_empty() && attributes.is_empty() {
        return Err(SelectorError::Unsupported(selector.to_owned()));
    }
    Ok(ParsedCompound {
        tag,
        id,
        classes,
        attributes,
    })
}

// Preserve the existing SelectorQuery subset independently of WXSS. The list
// compiler splits commas before this parser, including commas inside quotes.
// This tokenizer intentionally retains the historical attribute-value limits;
// extending CSS grammar is separate from sharing the matching implementation.
fn parse_selector(selector: &str) -> Result<ParsedSelector, SelectorError> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err(SelectorError::Empty);
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
        if let Some(combinator) = match chars[index] {
            '>' => Some(SelectorCombinator::Child),
            '+' => Some(SelectorCombinator::AdjacentSibling),
            '~' => Some(SelectorCombinator::GeneralSibling),
            _ => None,
        } {
            if compounds.is_empty() || pending.is_some() {
                return Err(SelectorError::Unsupported(selector.to_owned()));
            }
            pending = Some(combinator);
            index += 1;
            continue;
        }
        if !compounds.is_empty() {
            let relation = pending
                .take()
                .or_else(|| had_space.then_some(SelectorCombinator::Descendant));
            let Some(relation) = relation else {
                return Err(SelectorError::Unsupported(selector.to_owned()));
            };
            combinators.push(relation);
        }
        let start = index;
        while index < chars.len()
            && !chars[index].is_whitespace()
            && !matches!(chars[index], '>' | '+' | '~' | ',')
        {
            index += 1;
        }
        if start == index {
            return Err(SelectorError::Unsupported(selector.to_owned()));
        }
        let compound: String = chars[start..index].iter().collect();
        // Parse once for the whole query, rather than reparsing every node.
        compounds.push(parse_compound_selector(&compound)?);
    }
    if compounds.is_empty() || pending.is_some() || combinators.len() + 1 != compounds.len() {
        return Err(SelectorError::Unsupported(selector.to_owned()));
    }
    Ok(ParsedSelector {
        compounds,
        combinators,
    })
}

/// A validated selector list. Parsing completes before any tree or scope is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledSelectorList {
    selectors: Vec<ParsedSelector>,
}

impl CompiledSelectorList {
    pub fn parse(source: &str) -> Result<Self, SelectorError> {
        Ok(Self {
            selectors: source
                .split(',')
                .map(parse_selector)
                .collect::<Result<_, _>>()?,
        })
    }
}

/// Borrowed query metadata, independent of layout and host node handles.
///
/// `id` is the adapter's selector identity; it need not equal an explicit
/// `attributes["id"]`. Declaration ownership is independent of tree ancestry,
/// including when a component projects content from another owner into a slot.
#[derive(Debug, Clone, Copy)]
pub struct SelectorNodeRef<'a> {
    pub tag: Option<&'a str>,
    pub id: Option<&'a str>,
    pub classes: &'a [String],
    pub attributes: &'a BTreeMap<String, String>,
    pub owner_scope: Option<&'a str>,
    pub component_scope: Option<&'a str>,
}

/// A finite, acyclic, immutable query tree for one accepted document.
///
/// Children must occupy contiguous indices in document order, including text
/// nodes. Return `None` only at or beyond the child count. The root is a query
/// boundary: adapters may supply a page root without adding it to event routing.
pub trait SelectorTree {
    type Node: Copy;

    fn root(&self) -> Self::Node;
    fn metadata(&self, node: Self::Node) -> SelectorNodeRef<'_>;
    fn child(&self, node: Self::Node, index: usize) -> Option<Self::Node>;
}

fn matches_compound(node: SelectorNodeRef<'_>, parsed: &ParsedCompound) -> bool {
    parsed
        .tag
        .as_deref()
        .is_none_or(|expected| node.tag == Some(expected))
        && parsed
            .id
            .as_deref()
            .is_none_or(|expected| node.id == Some(expected))
        && parsed
            .classes
            .iter()
            .all(|expected| node.classes.iter().any(|class| class == expected))
        && parsed.attributes.iter().all(|attribute| {
            if attribute.name == "class" {
                let actual = node.attributes.get("class").map(String::as_str);
                return match attribute.value.as_deref() {
                    Some(expected) => {
                        actual.is_some_and(|value| value == expected)
                            || (actual.is_none()
                                && !node.classes.is_empty()
                                && node.classes.join(" ") == expected)
                    }
                    None => actual.is_some() || !node.classes.is_empty(),
                };
            }
            let actual = node.attributes.get(&attribute.name).map(String::as_str);
            match attribute.value.as_deref() {
                Some(expected) => actual == Some(expected),
                None => actual.is_some(),
            }
        })
}

#[derive(Clone, Copy)]
struct Ancestor<N> {
    node: N,
    index_in_parent: Option<usize>,
}

fn matches_part<T: SelectorTree>(
    tree: &T,
    node: T::Node,
    ancestors: &[Ancestor<T::Node>],
    index_in_parent: Option<usize>,
    selector: &ParsedSelector,
    part: usize,
) -> bool {
    if !matches_compound(tree.metadata(node), &selector.compounds[part]) {
        return false;
    }
    if part == 0 {
        return true;
    }
    match selector.combinators[part - 1] {
        SelectorCombinator::Child => {
            let Some(parent_pos) = ancestors.len().checked_sub(1) else {
                return false;
            };
            let parent = ancestors[parent_pos];
            matches_part(
                tree,
                parent.node,
                &ancestors[..parent_pos],
                parent.index_in_parent,
                selector,
                part - 1,
            )
        }
        SelectorCombinator::Descendant => (0..ancestors.len()).rev().any(|position| {
            let ancestor = ancestors[position];
            matches_part(
                tree,
                ancestor.node,
                &ancestors[..position],
                ancestor.index_in_parent,
                selector,
                part - 1,
            )
        }),
        SelectorCombinator::AdjacentSibling => {
            let Some(parent) = ancestors.last() else {
                return false;
            };
            let Some(previous_index) = index_in_parent.and_then(|index| index.checked_sub(1))
            else {
                return false;
            };
            tree.child(parent.node, previous_index)
                .is_some_and(|previous| {
                    matches_part(
                        tree,
                        previous,
                        ancestors,
                        Some(previous_index),
                        selector,
                        part - 1,
                    )
                })
        }
        SelectorCombinator::GeneralSibling => {
            let Some(parent) = ancestors.last() else {
                return false;
            };
            let Some(index) = index_in_parent else {
                return false;
            };
            (0..index).rev().any(|candidate_index| {
                tree.child(parent.node, candidate_index)
                    .is_some_and(|candidate| {
                        matches_part(
                            tree,
                            candidate,
                            ancestors,
                            Some(candidate_index),
                            selector,
                            part - 1,
                        )
                    })
            })
        }
    }
}

fn collect_matches<T: SelectorTree>(
    tree: &T,
    node: T::Node,
    selectors: &[ParsedSelector],
    ancestors: &mut Vec<Ancestor<T::Node>>,
    index_in_parent: Option<usize>,
    output: &mut Vec<T::Node>,
) {
    if selectors.iter().any(|selector| {
        matches_part(
            tree,
            node,
            ancestors,
            index_in_parent,
            selector,
            selector.compounds.len() - 1,
        )
    }) {
        output.push(node);
    }
    ancestors.push(Ancestor {
        node,
        index_in_parent,
    });
    let mut index = 0;
    while let Some(child) = tree.child(node, index) {
        collect_matches(tree, child, selectors, ancestors, Some(index), output);
        index += 1;
    }
    ancestors.pop();
}

fn find_scope<T: SelectorTree>(tree: &T, node: T::Node, scope: &str) -> Option<T::Node> {
    let metadata = tree.metadata(node);
    if metadata.component_scope == Some(scope)
        || metadata
            .attributes
            .get("data-sim-scope")
            .is_some_and(|value| value == scope)
    {
        return Some(node);
    }
    let mut index = 0;
    while let Some(child) = tree.child(node, index) {
        if let Some(found) = find_scope(tree, child, scope) {
            return Some(found);
        }
        index += 1;
    }
    None
}

/// Match in pre-order DFS, emitting each node once even when list entries overlap.
///
/// A managed component scope restricts returned declaration owners only after
/// matching the complete scoped subtree. It does not prune slot content or
/// hide other owners from relationship matching. Legacy `data-sim-scope` roots
/// keep their historical subtree-only behavior. Unknown scopes return no nodes.
/// `all = false` truncates only after the ownership filter has been applied.
pub fn query<T: SelectorTree>(
    tree: &T,
    selector: &CompiledSelectorList,
    all: bool,
    scope: Option<&str>,
) -> Vec<T::Node> {
    let root = match scope {
        Some(scope) => match find_scope(tree, tree.root(), scope) {
            Some(root) => root,
            None => return Vec::new(),
        },
        None => tree.root(),
    };
    let mut matches = Vec::new();
    collect_matches(
        tree,
        root,
        &selector.selectors,
        &mut Vec::new(),
        None,
        &mut matches,
    );
    if let Some(scope) = scope.filter(|scope| tree.metadata(root).component_scope == Some(*scope)) {
        matches.retain(|node| tree.metadata(*node).owner_scope == Some(scope));
    }
    if !all {
        matches.truncate(1);
    }
    matches
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Node {
        id: String,
        tag: Option<String>,
        classes: Vec<String>,
        attributes: BTreeMap<String, String>,
        owner: Option<String>,
        scope: Option<String>,
        children: Vec<usize>,
    }

    impl Node {
        fn element(id: &str, tag: &str, classes: &[&str]) -> Self {
            Self {
                id: id.into(),
                tag: Some(tag.into()),
                classes: classes.iter().map(|value| (*value).into()).collect(),
                ..Self::default()
            }
        }
    }

    struct Tree(Vec<Node>);

    impl SelectorTree for Tree {
        type Node = usize;

        fn root(&self) -> Self::Node {
            0
        }

        fn metadata(&self, node: Self::Node) -> SelectorNodeRef<'_> {
            let node = &self.0[node];
            SelectorNodeRef {
                tag: node.tag.as_deref(),
                id: Some(&node.id),
                classes: &node.classes,
                attributes: &node.attributes,
                owner_scope: node.owner.as_deref(),
                component_scope: node.scope.as_deref(),
            }
        }

        fn child(&self, node: Self::Node, index: usize) -> Option<Self::Node> {
            self.0[node].children.get(index).copied()
        }
    }

    fn select(tree: &Tree, selector: &str, all: bool, scope: Option<&str>) -> Vec<usize> {
        query(
            tree,
            &CompiledSelectorList::parse(selector).unwrap(),
            all,
            scope,
        )
    }

    #[test]
    fn grammar_keeps_the_existing_subset_and_error_payloads() {
        for source in [
            "*",
            "*.card",
            "1view#1id.a@b",
            "view > text + .other ~ [flag]",
            "[data-x=]",
            "[data-x='']",
            "[data-x=x=y]",
            "[data:mode=on]",
            "view.card[flag]#hero",
            "view, text",
        ] {
            assert!(CompiledSelectorList::parse(source).is_ok(), "{source}");
        }
        for source in ["", "  ", ".a,", ",.a", "view,,text"] {
            assert_eq!(
                CompiledSelectorList::parse(source).unwrap_err(),
                SelectorError::Empty
            );
        }
        for source in [
            "#a#b",
            ":first-child",
            ".a\\:b",
            ".中文",
            "view >",
            "view >> text",
            "[data-x*=value]",
            "[data-x='a b']",
            "[data-x='a,b']",
            "[data-x='a>b']",
            "[data-x='a+b']",
            "[data-x='a~b']",
        ] {
            assert!(
                matches!(
                    CompiledSelectorList::parse(source),
                    Err(SelectorError::Unsupported(_))
                ),
                "{source}"
            );
        }
        assert_eq!(
            CompiledSelectorList::parse("[data-x='a b']").unwrap_err(),
            SelectorError::Unsupported("[data-x='a".into())
        );
        assert_eq!(
            CompiledSelectorList::parse(" view > ")
                .unwrap_err()
                .to_string(),
            "unsupported selector syntax: view >"
        );
        assert_eq!(
            SelectorError::Empty.to_string(),
            "selector must be non-empty"
        );
    }

    #[test]
    fn selector_identity_and_raw_attributes_remain_distinct() {
        let mut tree = Tree(vec![
            Node::element("root", "page", &[]),
            Node::element("generated", "view", &["card"]),
        ]);
        tree.0[0].children = vec![1];
        tree.0[1].attributes.insert("data-x".into(), String::new());
        tree.0[1].attributes.insert("data-y".into(), "x=y".into());
        for source in [
            "#generated",
            ".card",
            "[class]",
            "[class=card]",
            "[data-x=]",
            "[data-y=x=y]",
        ] {
            assert_eq!(select(&tree, source, true, None), [1], "{source}");
        }
        for source in ["[id]", "[id=generated]", "View", ".Card", "[class=Card]"] {
            assert!(select(&tree, source, true, None).is_empty(), "{source}");
        }
        tree.0[1].attributes.insert("class".into(), "other".into());
        assert_eq!(select(&tree, ".card", true, None), [1]);
        assert_eq!(select(&tree, "[class=other]", true, None), [1]);
        assert!(select(&tree, "[class=card]", true, None).is_empty());
        tree.0[1].attributes.insert("class".into(), String::new());
        assert_eq!(select(&tree, "[class]", true, None), [1]);
        assert_eq!(select(&tree, "[class='']", true, None), [1]);
        assert!(select(&tree, "[class=card]", true, None).is_empty());
    }

    #[test]
    fn text_nodes_participate_in_wildcards_and_sibling_positions() {
        let mut tree = Tree(vec![
            Node::element("root", "page", &[]),
            Node::element("first", "view", &["a"]),
            Node {
                id: "anonymous-text".into(),
                ..Node::default()
            },
            Node::element("last", "view", &["b"]),
        ]);
        tree.0[0].children = vec![1, 2, 3];
        assert_eq!(select(&tree, "*", true, None), [0, 1, 2, 3]);
        assert!(select(&tree, ".a + .b", true, None).is_empty());
        assert_eq!(select(&tree, ".a ~ .b", true, None), [3]);
        assert_eq!(select(&tree, ".a + * + .b", true, None), [3]);
        assert_eq!(select(&tree, "page > *", true, None), [1, 2, 3]);
    }

    #[test]
    fn selector_lists_preserve_dfs_order_without_deduplicating_public_ids() {
        let mut tree = Tree(vec![
            Node::element("root", "page", &[]),
            Node::element("z-parent", "view", &[]),
            Node::element("earlier", "text", &["m"]),
            Node::element("later", "view", &["m"]),
        ]);
        tree.0[0].children = vec![1, 3];
        tree.0[1].children = vec![2];
        let selector = "#later,.m,#earlier,.m";
        assert_eq!(select(&tree, selector, true, None), [2, 3]);
        assert_eq!(select(&tree, selector, false, None), [2]);
        tree.0[2].id = "duplicate".into();
        tree.0[3].id = "duplicate".into();
        assert_eq!(select(&tree, "#duplicate", true, None), [2, 3]);
        assert_eq!(select(&tree, "page", true, None), [0]);
    }

    #[test]
    fn ancestor_relations_retain_each_ancestors_sibling_position() {
        let mut tree = Tree(vec![
            Node::element("root", "page", &[]),
            Node::element("lead", "view", &["lead"]),
            Node::element("second", "view", &["second"]),
            Node::element("deep", "text", &["deep"]),
        ]);
        tree.0[0].children = vec![1, 2];
        tree.0[2].children = vec![3];
        for source in [
            ".lead + view > .deep",
            ".lead ~ view .deep",
            "page > .second > text",
        ] {
            assert_eq!(select(&tree, source, true, None), [3], "{source}");
        }
    }

    fn scoped_tree() -> Tree {
        let mut tree = Tree(vec![
            Node::element("page", "page", &["outside"]),
            Node::element("host", "panel", &["m"]),
            Node::element("light", "text", &["m"]),
            Node::element("owned", "view", &["m"]),
            Node::element("wrapper", "badge", &["wrapper", "m"]),
            Node::element("private", "text", &["m"]),
            Node::element("projected", "text", &["m"]),
            Node::element("other-page-child", "view", &["m"]),
        ]);
        tree.0[0].children = vec![1, 7];
        tree.0[1].children = vec![2, 3, 4];
        tree.0[1].scope = Some("S".into());
        tree.0[3].owner = Some("S".into());
        tree.0[4].owner = Some("T".into());
        tree.0[4].scope = Some("T".into());
        tree.0[4].children = vec![5, 6];
        tree.0[5].owner = Some("T".into());
        tree.0[6].owner = Some("S".into());
        tree
    }

    #[test]
    fn managed_scope_filters_declaration_owners_before_first_match_selection() {
        let mut tree = scoped_tree();
        assert_eq!(select(&tree, ".m", true, Some("S")), [3, 6]);
        assert_eq!(select(&tree, ".m", false, Some("S")), [3]);
        assert!(select(&tree, "panel", true, Some("S")).is_empty());
        assert_eq!(select(&tree, "panel > .m", true, Some("S")), [3]);
        tree.0[1].owner = Some("S".into());
        assert_eq!(select(&tree, "panel", false, Some("S")), [1]);
        assert_eq!(select(&tree, ".m", false, Some("S")), [1]);
    }

    #[test]
    fn scope_relationships_use_the_complete_subtree_but_never_outer_ancestors() {
        let tree = scoped_tree();
        assert_eq!(select(&tree, ".wrapper .m", true, Some("S")), [6]);
        assert_eq!(select(&tree, ".wrapper > .m", true, Some("S")), [6]);
        assert!(select(&tree, ".outside .m", true, Some("S")).is_empty());
        assert!(select(&tree, ".m", true, Some("missing")).is_empty());
        assert_eq!(select(&tree, ".m", true, None), [1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn legacy_scope_restricts_the_subtree_without_filtering_owners() {
        let mut tree = scoped_tree();
        tree.0[1].scope = None;
        tree.0[1]
            .attributes
            .insert("data-sim-scope".into(), "S".into());
        assert_eq!(select(&tree, ".m", true, Some("S")), [1, 2, 3, 4, 5, 6]);
        assert_eq!(select(&tree, ".m", false, Some("S")), [1]);
        tree.0[1].scope = Some("different-managed-scope".into());
        assert_eq!(select(&tree, ".m", true, Some("S")), [1, 2, 3, 4, 5, 6]);
    }
}
