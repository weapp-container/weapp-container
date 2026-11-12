//! Expand the selected stylesheet graph and evaluate conditional groups before
//! the ordinary selector cascade. Legacy v1 imports retain their recorded order.
use super::style_conditions::{media_matches, supports_matches};
use super::{lookup_render_blob, BridgeError, BridgeErrorCode, ContainerManifestV1};
use container_ir::{decode_wxss, Style, WxssIr, WxssRule};
use container_render_skia::Rect;
use std::collections::BTreeMap;
use std::sync::Arc;

const MAX_IMPORT_DEPTH: usize = 128;
const MAX_EXPANDED_STYLES: usize = 16_384;
const MAX_EXPANDED_BYTES: usize = 32 * 1024 * 1024;
const MAX_EXPANDED_ITEMS: usize = 65_536;

fn render_error(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Render, message)
}

pub(super) fn resolve_render_styles(
    manifest: &ContainerManifestV1,
    roots: &[String],
    blobs: &BTreeMap<String, Vec<u8>>,
    viewport: Rect,
) -> Result<WxssIr, BridgeError> {
    let mut records = BTreeMap::new();
    for style in &manifest.styles {
        let path = style
            .id
            .strip_prefix("style:")
            .ok_or_else(|| render_error(format!("invalid WXSS style id: {}", style.id)))?;
        let canonical = resolve_path("", path)?;
        if canonical != path || records.insert(canonical, style).is_some() {
            return Err(render_error(format!(
                "WXSS style id must be unique and normalized: {}",
                style.id
            )));
        }
    }
    let mut resolver = StyleResolver {
        records,
        blobs,
        viewport,
        decoded: BTreeMap::new(),
        active: Vec::new(),
        expanded: 0,
        budget: ExpansionBudget::default(),
        output: WxssIr::default(),
    };
    for root in roots {
        let path = root
            .strip_prefix("style:")
            .ok_or_else(|| render_error(format!("invalid WXSS root style id: {root}")))?;
        let canonical = resolve_path("", path)?;
        if canonical != path {
            return Err(render_error(format!(
                "WXSS root style id must be normalized: {root}"
            )));
        }
        resolver.expand(&canonical)?;
    }
    Ok(resolver.output)
}

struct StyleResolver<'a> {
    records: BTreeMap<String, &'a Style>,
    blobs: &'a BTreeMap<String, Vec<u8>>,
    viewport: Rect,
    decoded: BTreeMap<String, CachedStyle>,
    active: Vec<String>,
    expanded: usize,
    budget: ExpansionBudget,
    output: WxssIr,
}

struct CachedStyle {
    ir: Arc<WxssIr>,
    bytes: usize,
    items: usize,
}

// Charge every expansion, including repeated imports and inactive rule bodies.
// Serialized IR bytes bound cloned strings; item count separately bounds the
// allocation overhead of rules, selectors, declarations and legacy imports.
struct ExpansionBudget {
    remaining_bytes: usize,
    remaining_items: usize,
}

impl Default for ExpansionBudget {
    fn default() -> Self {
        Self {
            remaining_bytes: MAX_EXPANDED_BYTES,
            remaining_items: MAX_EXPANDED_ITEMS,
        }
    }
}

impl ExpansionBudget {
    fn check_bytes(&self, bytes: usize) -> Result<(), BridgeError> {
        if bytes > self.remaining_bytes {
            return Err(render_error("WXSS expanded byte budget exceeded"));
        }
        Ok(())
    }

    fn consume(&mut self, bytes: usize, items: usize) -> Result<(), BridgeError> {
        self.check_bytes(bytes)?;
        if items > self.remaining_items {
            return Err(render_error("WXSS expanded item budget exceeded"));
        }
        self.remaining_bytes -= bytes;
        self.remaining_items -= items;
        Ok(())
    }
}

fn style_item_count(ir: &WxssIr) -> Result<usize, BridgeError> {
    fn visit(rules: &[WxssRule], count: &mut usize) -> Result<(), BridgeError> {
        for rule in rules {
            for amount in [1, rule.selectors.len(), rule.declarations.len()] {
                *count = count
                    .checked_add(amount)
                    .filter(|count| *count <= MAX_EXPANDED_ITEMS)
                    .ok_or_else(|| render_error("WXSS expanded item budget exceeded"))?;
            }
            visit(&rule.nested, count)?;
        }
        Ok(())
    }
    let mut count = ir.imports.len();
    if count > MAX_EXPANDED_ITEMS {
        return Err(render_error("WXSS expanded item budget exceeded"));
    }
    visit(&ir.rules, &mut count)?;
    Ok(count)
}

impl StyleResolver<'_> {
    fn expand(&mut self, path: &str) -> Result<(), BridgeError> {
        if self.active.iter().any(|active| active == path) {
            let mut cycle = self.active.join(" -> ");
            cycle.push_str(" -> ");
            cycle.push_str(path);
            return Err(render_error(format!("WXSS import cycle: {cycle}")));
        }
        if self.active.len() >= MAX_IMPORT_DEPTH || self.expanded >= MAX_EXPANDED_STYLES {
            return Err(render_error(
                "WXSS import expansion exceeds the render limit",
            ));
        }
        self.expanded += 1;
        if !self.decoded.contains_key(path) {
            let record = self.records.get(path).ok_or_else(|| {
                render_error(format!("WXSS style:{path} is not declared in the manifest"))
            })?;
            let bytes = lookup_render_blob(self.blobs, &record.wxss_ir)?;
            // Reject an over-budget new source before JSON decoding allocates
            // its rule tree. Cached sources are charged again at every site.
            self.budget.check_bytes(bytes.len())?;
            let ir = decode_wxss(bytes).map_err(|error| {
                render_error(format!("style {} WXSS IR is invalid: {error}", record.id))
            })?;
            let items = style_item_count(&ir)?;
            self.decoded.insert(
                path.to_owned(),
                CachedStyle {
                    ir: Arc::new(ir),
                    bytes: bytes.len(),
                    items,
                },
            );
        }
        let cached = &self.decoded[path];
        self.budget.consume(cached.bytes, cached.items)?;
        // Share the immutable decoded tree across recursive expansions. Only
        // accepted output rules are cloned after their full cost is reserved.
        let ir = Arc::clone(&cached.ir);
        self.active.push(path.to_owned());
        for import in &ir.imports {
            // v1 cannot recover import positions or enclosing group context.
            // Preserve that legacy format, never claim reconstructed source.
            self.expand_import(path, import)?;
        }
        self.expand_rules(path, &ir.rules, true, 0)?;
        self.active.pop();
        Ok(())
    }

    fn expand_import(&mut self, owner: &str, prelude: &str) -> Result<(), BridgeError> {
        let (reference, condition) = parse_import(prelude).map_err(|error| {
            BridgeError::new(
                error.code,
                format!("style:{owner} @import {prelude:?}: {}", error.message),
            )
        })?;
        if !condition.is_empty() && !media_matches(condition, self.viewport)? {
            return Ok(());
        }
        let target = resolve_path(owner, reference)?;
        self.expand(&target)
    }

    fn expand_rules(
        &mut self,
        owner: &str,
        rules: &[WxssRule],
        top_level: bool,
        depth: usize,
    ) -> Result<(), BridgeError> {
        if depth >= MAX_IMPORT_DEPTH {
            return Err(render_error(
                "WXSS conditional nesting exceeds the render limit",
            ));
        }
        let mut imports_open = top_level;
        for rule in rules {
            if let Some(prelude) = &rule.at_rule {
                let (keyword, argument) = at_rule_parts(prelude)?;
                if keyword == "import" {
                    if !imports_open {
                        return Err(BridgeError::new(
                            BridgeErrorCode::UnsupportedCapability,
                            format!("style:{owner}: late or nested WXSS @import requires official placement semantics"),
                        ));
                    }
                    // Repeated imports intentionally participate in the cascade
                    // at each site. They are not globally deduplicated.
                    self.expand_import(owner, argument)?;
                    continue;
                }
                if keyword == "charset" && imports_open {
                    if !matches!(argument, "\"UTF-8\"" | "'UTF-8'" | "\"utf-8\"" | "'utf-8'") {
                        return Err(render_error("portable WXSS must use UTF-8"));
                    }
                    continue;
                }
                imports_open = false;
                match keyword.as_str() {
                    "media" => {
                        if media_matches(argument, self.viewport)? {
                            self.expand_rules(owner, &rule.nested, false, depth + 1)?;
                        }
                    }
                    "supports" => {
                        if supports_matches(argument)? {
                            self.expand_rules(owner, &rule.nested, false, depth + 1)?;
                        }
                    }
                    // Keep animation/font metadata out of the normal cascade.
                    // Their resource/execution adapters remain separate work.
                    "keyframes" | "-webkit-keyframes" | "font-face" => {
                        self.output.rules.push(rule.clone());
                    }
                    _ => {
                        return Err(BridgeError::new(
                            BridgeErrorCode::UnsupportedCapability,
                            format!("style:{owner}: unsupported WXSS at-rule @{keyword}"),
                        ))
                    }
                }
            } else {
                imports_open = false;
                if !rule.nested.is_empty() {
                    return Err(BridgeError::new(
                        BridgeErrorCode::UnsupportedCapability,
                        "nested selector rules require a CSS nesting adapter",
                    ));
                }
                self.output.rules.push(rule.clone());
            }
        }
        Ok(())
    }
}

fn at_rule_parts(prelude: &str) -> Result<(String, &str), BridgeError> {
    let value = prelude
        .trim()
        .strip_prefix('@')
        .ok_or_else(|| render_error("WXSS at-rule must begin with @"))?;
    let end = value
        .find(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_')
        .unwrap_or(value.len());
    if end == 0 {
        return Err(render_error("WXSS at-rule requires a keyword"));
    }
    Ok((value[..end].to_ascii_lowercase(), value[end..].trim()))
}

pub(super) fn parse_import(prelude: &str) -> Result<(&str, &str), BridgeError> {
    fn quoted(value: &str) -> Result<(&str, &str), BridgeError> {
        let quote = value
            .chars()
            .next()
            .filter(|quote| *quote == '\'' || *quote == '"')
            .ok_or_else(|| render_error("WXSS imports require a quoted path or url(...)"))?;
        let remaining = &value[quote.len_utf8()..];
        let end = remaining
            .find(quote)
            .ok_or_else(|| render_error("unterminated WXSS import path"))?;
        Ok((
            &remaining[..end],
            remaining[end + quote.len_utf8()..].trim(),
        ))
    }
    let value = prelude.trim();
    let (path, condition) = if value
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("url("))
    {
        let content = value[4..].trim_start();
        if content.starts_with(['\'', '"']) {
            let (path, remaining) = quoted(content)?;
            let condition = remaining
                .strip_prefix(')')
                .ok_or_else(|| render_error("malformed WXSS url import"))?
                .trim();
            (path, condition)
        } else {
            let end = content
                .find(')')
                .ok_or_else(|| render_error("unterminated WXSS url import"))?;
            let path = content[..end].trim();
            if path.chars().any(char::is_whitespace) || path.contains(['\'', '"', '(', ')']) {
                return Err(render_error("malformed WXSS url import path"));
            }
            (path, content[end + 1..].trim())
        }
    } else {
        quoted(value)?
    };
    if path.is_empty() || path.contains('\\') {
        return Err(render_error(
            "empty or escaped WXSS import paths are unsupported",
        ));
    }
    let qualifier_end = condition
        .find(|character: char| {
            !character.is_alphanumeric() && character != '-' && character != '_'
        })
        .unwrap_or(condition.len());
    let qualifier = &condition[..qualifier_end];
    if qualifier.eq_ignore_ascii_case("layer") || qualifier.eq_ignore_ascii_case("supports") {
        return Err(BridgeError::new(
            BridgeErrorCode::UnsupportedCapability,
            "WXSS import layers and supports qualifiers require a dedicated adapter",
        ));
    }
    Ok((path, condition))
}

pub(super) fn resolve_path(owner: &str, reference: &str) -> Result<String, BridgeError> {
    if reference.is_empty()
        || reference.starts_with("//")
        || reference.contains(['\\', ':', '?', '#'])
        || reference.chars().any(char::is_control)
    {
        return Err(render_error(format!(
            "WXSS import must reference a local packaged path: {reference:?}"
        )));
    }
    let mut segments = if reference.starts_with('/') {
        Vec::new()
    } else {
        owner
            .rsplit_once('/')
            .map(|(directory, _)| directory.split('/').collect())
            .unwrap_or_default()
    };
    for segment in reference.trim_start_matches('/').split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.pop().is_none() {
                    return Err(render_error(format!(
                        "WXSS import escapes the package root: {reference:?}"
                    )));
                }
            }
            segment => segments.push(segment),
        }
    }
    let path = segments.join("/");
    if !path.ends_with(".wxss") && !path.ends_with(".css") {
        return Err(render_error(format!(
            "WXSS import path must name a .wxss or .css file: {reference:?}"
        )));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{op, BridgeEnvelope, Session, SessionConfig};
    use container_ir::{parse_wxml, parse_wxss, Route, RouteKind, StyleScope, Template};
    use container_render_skia::{Color, Renderer};
    use serde_json::json;

    fn viewport() -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        }
    }

    fn manifest() -> ContainerManifestV1 {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "style-import-test".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.routes.push(Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "app.js".into(),
        });
        manifest
    }

    fn add_style(
        manifest: &mut ContainerManifestV1,
        blobs: &mut BTreeMap<String, Vec<u8>>,
        path: &str,
        source: &str,
    ) -> String {
        let bytes = parse_wxss(source).unwrap().canonical_json().unwrap();
        let pointer = format!("sha256:{}", container_ir::hex_digest(&bytes));
        blobs.insert(pointer.clone(), bytes);
        let id = format!("style:{path}");
        manifest.styles.push(Style {
            id: id.clone(),
            wxss_ir: pointer,
            scope: if path == "app.wxss" {
                StyleScope::App
            } else {
                StyleScope::Page
            },
        });
        id
    }

    #[test]
    fn reachable_imports_preserve_nested_and_repeated_cascade_without_other_pages() {
        let mut manifest = manifest();
        let mut blobs = BTreeMap::new();
        let page = add_style(
            &mut manifest,
            &mut blobs,
            "pages/index/index.wxss",
            "@import '../../shared/first.wxss'; @import url('/shared/second.wxss'); .page { color: black; }",
        );
        add_style(
            &mut manifest,
            &mut blobs,
            "shared/first.wxss",
            "@import './重复.wxss'; .first { color: red; }",
        );
        add_style(
            &mut manifest,
            &mut blobs,
            "shared/second.wxss",
            "@import url(./重复.wxss); .second { color: blue; }",
        );
        add_style(
            &mut manifest,
            &mut blobs,
            "shared/重复.wxss",
            ".repeat { color: green; }",
        );
        let other = add_style(
            &mut manifest,
            &mut blobs,
            "pages/other/index.wxss",
            ".other { color: white; }",
        );
        let resolved =
            resolve_render_styles(&manifest, std::slice::from_ref(&page), &blobs, viewport())
                .unwrap();
        assert!(resolved.imports.is_empty());
        assert_eq!(
            resolved
                .rules
                .iter()
                .map(|rule| rule.selectors[0].as_str())
                .collect::<Vec<_>>(),
            [".repeat", ".first", ".repeat", ".second", ".page"]
        );
        // Explicit styleIds now define an ordered root list, rather than a
        // manifest-order filter. Imported rules stay at each root's site.
        let reversed =
            resolve_render_styles(&manifest, &[other, page], &blobs, viewport()).unwrap();
        assert_eq!(reversed.rules[0].selectors, [".other"]);
        assert_eq!(reversed.rules.last().unwrap().selectors, [".page"]);
    }

    #[test]
    fn missing_cycle_invalid_utf8_and_unavailable_blobs_return_render_errors() {
        for (source, message) in [
            ("@import './missing.wxss';", "not declared"),
            ("@import './nested/../index.wxss';", "cycle"),
            ("@import '../../escape.wxss';", "escapes"),
            ("@import './shared.wxss' screen;", "not declared"),
        ] {
            let mut manifest = manifest();
            let mut blobs = BTreeMap::new();
            let root = add_style(&mut manifest, &mut blobs, "index.wxss", source);
            let error = resolve_render_styles(&manifest, &[root], &blobs, viewport()).unwrap_err();
            assert_eq!(error.code, BridgeErrorCode::Render);
            assert!(error.message.contains(message), "{source}: {error:?}");
        }
        let mut manifest = manifest();
        let mut blobs = BTreeMap::new();
        let root = add_style(&mut manifest, &mut blobs, "index.wxss", ".a { color:red; }");
        blobs.clear();
        assert_eq!(
            resolve_render_styles(&manifest, std::slice::from_ref(&root), &blobs, viewport())
                .unwrap_err()
                .code,
            BridgeErrorCode::Render
        );
        let pointer = manifest.styles[0].wxss_ir.clone();
        blobs.insert(pointer, vec![0xff]);
        assert_eq!(
            resolve_render_styles(&manifest, &[root], &blobs, viewport())
                .unwrap_err()
                .code,
            BridgeErrorCode::Render
        );
    }

    #[test]
    fn package_paths_and_import_preludes_reject_escape_remote_and_conditions() {
        assert_eq!(
            resolve_path("pages/index/index.wxss", "../../shared/样式.wxss").unwrap(),
            "shared/样式.wxss"
        );
        assert_eq!(
            resolve_path("pages/index/index.wxss", "/shared/样式.wxss").unwrap(),
            "shared/样式.wxss"
        );
        for path in [
            "../../../escape.wxss",
            "https://example.test/style.wxss",
            "//example.test/style.wxss",
            "../style.wxss?query",
            "../style.wxss#fragment",
            "../style\\escaped.wxss",
        ] {
            assert!(
                resolve_path("pages/index/index.wxss", path).is_err(),
                "{path}"
            );
        }
        for prelude in ["url('broken.wxss)", "'escaped\\ path.wxss'", "样式", ""] {
            assert!(parse_import(prelude).is_err(), "{prelude}");
        }
        assert_eq!(
            parse_import("'./shared.wxss' screen").unwrap(),
            ("./shared.wxss", "screen")
        );
        assert_eq!(
            parse_import("url('./shared.wxss') (min-width: 100px)").unwrap(),
            ("./shared.wxss", "(min-width: 100px)")
        );
    }

    #[test]
    fn conditional_imports_and_nested_media_reach_the_cascade_only_when_matched() {
        let mut manifest = manifest();
        let mut blobs = BTreeMap::new();
        let root = add_style(&mut manifest, &mut blobs, "app.wxss", "@import './wide.wxss' (min-width: 150px); .card { color: red; } @media (min-height: 150px) { .card { color: green; } @media (orientation: landscape) { .card { color: blue; } } }");
        add_style(
            &mut manifest,
            &mut blobs,
            "wide.wxss",
            ".wide { width: 40px; }",
        );
        let tall = Rect {
            width: 100.0,
            height: 200.0,
            ..viewport()
        };
        let wide = Rect {
            width: 200.0,
            height: 100.0,
            ..viewport()
        };
        let tall_ir =
            resolve_render_styles(&manifest, std::slice::from_ref(&root), &blobs, tall).unwrap();
        assert_eq!(tall_ir.rules.len(), 2);
        assert_eq!(tall_ir.rules[1].declarations[0].value, "green");
        let wide_ir = resolve_render_styles(&manifest, &[root], &blobs, wide).unwrap();
        assert_eq!(wide_ir.rules.len(), 2);
        assert_eq!(wide_ir.rules[0].selectors, [".wide"]);
        assert_eq!(wide_ir.rules[1].declarations[0].value, "red");
    }

    #[test]
    fn repeated_imports_reserve_cumulative_bytes_and_items_before_appending() {
        let mut manifest = manifest();
        let mut blobs = BTreeMap::new();
        add_style(
            &mut manifest,
            &mut blobs,
            "app.wxss",
            "@import './shared.wxss'; @import './shared.wxss'; @import './shared.wxss'; @import './shared.wxss'; .app { color: black; }",
        );
        add_style(
            &mut manifest,
            &mut blobs,
            "shared.wxss",
            ".first, .second { color: red; width: 1px; height: 1px; }",
        );
        let root_bytes = &blobs[&manifest.styles[0].wxss_ir];
        let shared_bytes = &blobs[&manifest.styles[1].wxss_ir];
        let root_items = style_item_count(&decode_wxss(root_bytes).unwrap()).unwrap();
        let shared_items = style_item_count(&decode_wxss(shared_bytes).unwrap()).unwrap();
        assert_eq!(
            shared_items, 6,
            "rule, two selectors and three declarations"
        );
        // Small injected budgets exercise the same production accounting
        // without allocating a 32-MiB expansion in the test process.
        for (remaining_bytes, remaining_items, expected) in [
            (
                root_bytes.len() + shared_bytes.len() * 2,
                MAX_EXPANDED_ITEMS,
                "byte budget",
            ),
            (
                MAX_EXPANDED_BYTES,
                root_items + shared_items * 2,
                "item budget",
            ),
        ] {
            let mut resolver = StyleResolver {
                records: manifest
                    .styles
                    .iter()
                    .map(|style| (style.id[6..].to_owned(), style))
                    .collect(),
                blobs: &blobs,
                viewport: viewport(),
                decoded: BTreeMap::new(),
                active: Vec::new(),
                expanded: 0,
                budget: ExpansionBudget {
                    remaining_bytes,
                    remaining_items,
                },
                output: WxssIr::default(),
            };
            let error = resolver.expand("app.wxss").unwrap_err();
            assert_eq!(error.code, BridgeErrorCode::Render);
            assert!(error.message.contains(expected), "{error:?}");
            assert_eq!(
                resolver.output.rules.len(),
                2,
                "third import cannot append any rule"
            );
            assert!(resolver
                .output
                .rules
                .iter()
                .all(|rule| rule.selectors == [".first", ".second"]));
            assert_eq!(resolver.decoded.len(), 2, "shared source stays cached");
        }
    }

    #[test]
    fn import_qualifiers_are_exact_case_insensitive_and_preserve_error_codes() {
        for qualifier in ["layer", "LAYER(theme)", "SUPPORTS(display: flex)"] {
            let mut manifest = manifest();
            let mut blobs = BTreeMap::new();
            let root = add_style(
                &mut manifest,
                &mut blobs,
                "app.wxss",
                &format!("@import './shared.wxss' {qualifier};"),
            );
            let error = resolve_render_styles(&manifest, &[root], &blobs, viewport()).unwrap_err();
            assert_eq!(
                error.code,
                BridgeErrorCode::UnsupportedCapability,
                "{qualifier}: {error:?}"
            );
            assert!(error.message.contains("style:app.wxss @import"));
        }
        for media_type in ["layer-device", "supports-device", "layer设备"] {
            let mut manifest = manifest();
            let mut blobs = BTreeMap::new();
            let root = add_style(
                &mut manifest,
                &mut blobs,
                "app.wxss",
                &format!("@import './missing.wxss' {media_type}; .app {{ color: red; }}"),
            );
            let resolved = resolve_render_styles(&manifest, &[root], &blobs, viewport()).unwrap();
            assert_eq!(resolved.rules.len(), 1);
            assert_eq!(resolved.rules[0].selectors, [".app"]);
        }
    }

    #[test]
    fn v2_invalid_import_positions_and_unknown_active_groups_are_explicit() {
        for source in [
            ".card { color: red; } @import './a.wxss';",
            "@media screen { @import './a.wxss'; }",
            "@supports (display: flex) { .card { display: flex; } }",
            "@layer test { .card { color: red; } }",
            "@imported './a.wxss';",
        ] {
            let mut manifest = manifest();
            let mut blobs = BTreeMap::new();
            let root = add_style(&mut manifest, &mut blobs, "app.wxss", source);
            let error = resolve_render_styles(&manifest, &[root], &blobs, viewport()).unwrap_err();
            assert_eq!(
                error.code,
                BridgeErrorCode::UnsupportedCapability,
                "{source}: {error:?}"
            );
        }
    }

    #[test]
    fn legacy_v1_imports_remain_readable_without_claiming_recovered_positions() {
        let mut manifest = manifest();
        let mut blobs = BTreeMap::new();
        let root = add_style(
            &mut manifest,
            &mut blobs,
            "app.wxss",
            ".card { color: red; }",
        );
        let mut legacy = parse_wxss(".card { color: red; }").unwrap();
        legacy.version = 1;
        legacy.imports.push("'./shared.wxss'".into());
        let bytes = legacy.canonical_json().unwrap();
        let pointer = format!("sha256:{}", container_ir::hex_digest(&bytes));
        manifest.styles[0].wxss_ir = pointer.clone();
        blobs.insert(pointer, bytes);
        add_style(
            &mut manifest,
            &mut blobs,
            "shared.wxss",
            ".shared { width: 40px; }",
        );
        let resolved = resolve_render_styles(&manifest, &[root], &blobs, viewport()).unwrap();
        assert_eq!(resolved.rules[0].selectors, [".shared"]);
        assert_eq!(resolved.rules[1].selectors, [".card"]);
    }

    #[test]
    fn css_styles_accepted_by_the_packer_do_not_poison_unrelated_roots() {
        let mut manifest = manifest();
        let mut blobs = BTreeMap::new();
        let root = add_style(
            &mut manifest,
            &mut blobs,
            "app.wxss",
            "@import './shared.css'; .app { color: red; }",
        );
        add_style(
            &mut manifest,
            &mut blobs,
            "shared.css",
            ".shared { width: 10px; }",
        );
        add_style(
            &mut manifest,
            &mut blobs,
            "unrelated.css",
            "@unsupported value;",
        );
        let resolved = resolve_render_styles(&manifest, &[root], &blobs, viewport()).unwrap();
        assert_eq!(resolved.rules.len(), 2);
        assert_eq!(resolved.rules[0].selectors, [".shared"]);
    }

    #[test]
    fn shared_import_reaches_layout_and_missing_blob_preserves_committed_frame() {
        let mut manifest = manifest();
        let mut blobs = BTreeMap::new();
        add_style(
            &mut manifest,
            &mut blobs,
            "pages/index/index.wxss",
            "@import '../../shared/theme.wxss'; .target { height:20px; }",
        );
        add_style(
            &mut manifest,
            &mut blobs,
            "shared/theme.wxss",
            ".target { width:40px; background:red; }",
        );
        add_style(
            &mut manifest,
            &mut blobs,
            "pages/other/index.wxss",
            ".target { width:99px; background:blue; }",
        );
        let shared_pointer = manifest.styles[1].wxss_ir.clone();
        let template = parse_wxml("<view id=\"panel\" class=\"target\"/>")
            .unwrap()
            .canonical_json()
            .unwrap();
        let template_pointer = format!("sha256:{}", container_ir::hex_digest(&template));
        blobs.insert(template_pointer.clone(), template);
        manifest.templates.push(Template {
            id: "template:pages/index/index.wxml".into(),
            wxml_ast: template_pointer,
            bindings: vec![],
            wxs_modules: Default::default(),
        });
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(manifest, SessionConfig::default()).unwrap();
        let request = |id, op, payload| BridgeEnvelope::request("session-1", id, op, payload);
        session.dispatch(request("init", op::APP_INIT, json!({})));
        session.dispatch(request(
            "page",
            op::PAGE_PUSH,
            json!({"path":"pages/index/index"}),
        ));
        let payload = json!({"templateId":"template:pages/index/index.wxml","frameId":1,"viewport":{"width":100,"height":100},"blobs":blobs});
        let commit = session.dispatch(request("frame", op::RENDER_COMMIT, payload.clone()));
        assert_eq!(commit.messages[0].payload["ok"], true, "{commit:?}");
        let frame = session.renderer().last_frame().unwrap();
        let panel = frame.query("#panel", false).unwrap()[0];
        assert_eq!((panel.bounds.width, panel.bounds.height), (40.0, 20.0));
        assert_eq!(
            panel.background,
            Some(Color {
                red: 255,
                green: 0,
                blue: 0,
                alpha: 255,
            })
        );
        let pixels = session.renderer().snapshot().unwrap().pixels;
        let mut invalid = payload;
        invalid["frameId"] = json!(2);
        invalid["blobs"]
            .as_object_mut()
            .unwrap()
            .remove(&shared_pointer);
        let rejected = session.dispatch(request("missing", op::RENDER_COMMIT, invalid));
        assert_eq!(rejected.messages[0].payload["error"]["code"], "ERR_RENDER");
        assert_eq!(session.renderer().last_frame().unwrap().frame_id, 1);
        assert_eq!(session.renderer().snapshot().unwrap().pixels, pixels);
    }
}
