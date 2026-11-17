use super::*;
use container_core::ViewExecutionBudget;
use container_ir::{parse_wxml, Component, Style, StyleScope};

const PAGE: &str = "template:pages/index/index.wxml";
const CARD: &str = "template:components/card/index.wxml";
type Presentation = (WxmlAst, BTreeMap<String, RenderOwnership>);

fn relation(owner: &str, targets: &[(&str, &str)], multiple: bool) -> Component {
    Component {
        id: format!("components:{owner}"),
        owner: owner.into(),
        using_components: targets
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect(),
        multiple_slots: Some(multiple),
    }
}

fn fixture(page: &str, card: &str) -> (Session, BTreeMap<String, WxmlAst>) {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "declarative-occurrence-fixture".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    manifest.components.push(relation(
        "pages/index/index.json",
        &[("card", "/components/card/index")],
        false,
    ));
    let templates = BTreeMap::from([
        (PAGE.into(), parse_wxml(page).unwrap()),
        (CARD.into(), parse_wxml(card).unwrap()),
    ]);
    let mut session = Session::new(manifest, SessionConfig::default()).unwrap();
    prepare_view_program(&mut session, &templates);
    (session, templates)
}

fn prepare_view_program(session: &mut Session, templates: &BTreeMap<String, WxmlAst>) {
    session.manifest.templates = templates
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
    session
        .view_execution
        .borrow_mut()
        .prepare_modules(
            &session.manifest,
            &BTreeMap::new(),
            &ViewExecutionBudget::default(),
        )
        .unwrap();
}

fn render(
    session: &mut Session,
    page: Option<PageId>,
    templates: &BTreeMap<String, WxmlAst>,
    data: Value,
) -> Result<Presentation, BridgeError> {
    prepare_view_program(session, templates);
    let source = &templates[PAGE];
    let ast = if let Some(page) = page {
        session.evaluate_page_template(page, PAGE, source, &data, templates)?
    } else {
        session.evaluate_standalone_template(None, PAGE, source, &data, templates)?
    };
    session.declarative_component_tree(page, &ast, PAGE, templates, None)
}

fn work(session: &Session, page: Option<PageId>) -> &RenderWork {
    page.map(|page| &session.component_pages[&page].render_work)
        .unwrap_or(&session.standalone_render_work)
}

fn id_paths(ast: &WxmlAst) -> BTreeMap<String, String> {
    fn visit(nodes: &[WxmlNode], parent: &str, output: &mut BTreeMap<String, String>) {
        for (index, node) in nodes.iter().enumerate() {
            let path = node_path(node, parent, index);
            if let WxmlNode::Element {
                attrs, children, ..
            } = node
            {
                if let Some(id) = attrs.get("id") {
                    assert!(
                        output.insert(id.clone(), path.clone()).is_none(),
                        "duplicate id {id}"
                    );
                }
                visit(children, &path, output);
            }
        }
    }
    let mut output = BTreeMap::new();
    visit(&ast.nodes, "", &mut output);
    output
}

#[test]
fn declarative_slots_preserve_declaring_component_map_and_skip_unused_light() {
    let (mut session, mut templates) = fixture(
        "<card><light slot=\"content\"/><text slot=\"content\" id=\"page-listener\" bindtap=\"pageTap\">page</text><unused slot=\"unused\"/></card>",
        "<view><light/><slot name=\"content\"/><slot name=\"fallback\"><fallback/></slot></view>",
    );
    session.manifest.components[0]
        .using_components
        .extend(BTreeMap::from([
            ("light".into(), "/components/public/index".into()),
            ("unused".into(), "/missing/unused".into()),
        ]));
    session.manifest.components.push(relation(
        "components/card/index.json",
        &[
            ("light", "/components/private/index"),
            ("fallback", "/components/fallback/index"),
        ],
        true,
    ));
    for (path, id) in [
        ("public", "public"),
        ("private", "private"),
        ("fallback", "fallback"),
    ] {
        templates.insert(
            format!("template:components/{path}/index.wxml"),
            parse_wxml(&format!("<text id=\"{id}\">{id}</text>")).unwrap(),
        );
    }
    let page = Some(PageId(1));
    let (ast, ownership) = render(&mut session, page, &templates, json!({})).unwrap();
    let ids = id_paths(&ast);
    assert_eq!(
        ids.keys().map(String::as_str).collect::<Vec<_>>(),
        ["fallback", "page-listener", "private", "public"]
    );
    assert!(ownership[&ids["page-listener"]].event_owner.is_none());
    let public_owner = ownership[&ids["public"]].event_owner.as_deref().unwrap();
    let private_owner = ownership[&ids["private"]].event_owner.as_deref().unwrap();
    assert!(public_owner.contains("components/public/index.wxml"));
    assert!(private_owner.contains("components/private/index.wxml"));
    assert_ne!(public_owner, private_owner);
    let scopes = work(&session, page).scope_ids();
    assert_eq!(scopes.len(), 5); // Page, card, public, private and fallback.
    assert!(!scopes.iter().any(|scope| scope.contains("unused")));
}

#[test]
fn declarative_keyed_reorders_reuse_work_and_removed_occurrences_are_released() {
    let (mut session, templates) = fixture(
        "<card wx:for=\"{{items}}\" wx:key=\"id\" value=\"{{item.value}}\"/>",
        "<text>{{value}}</text>",
    );
    let page = Some(PageId(2));
    let a = json!({"items":[{"id":"a","value":"A"},{"id":"b","value":"B"}]});
    let b = json!({"items":[{"id":"b","value":"B"},{"id":"a","value":"A"}]});
    render(&mut session, page, &templates, a.clone()).unwrap();
    let initial = work(&session, page).scope_ids();
    assert_eq!(initial.len(), 3);
    assert_eq!(work(&session, page).completed_evaluations(), 3);
    render(&mut session, page, &templates, b).unwrap();
    assert_eq!(work(&session, page).scope_ids(), initial);
    assert_eq!(work(&session, page).completed_evaluations(), 4);
    render(
        &mut session,
        page,
        &templates,
        json!({"items":[{"id":"a","value":"A"}]}),
    )
    .unwrap();
    assert_eq!(work(&session, page).scope_ids().len(), 2);
    render(&mut session, page, &templates, a).unwrap();
    assert_eq!(work(&session, page).scope_ids(), initial);
    assert_eq!(work(&session, page).completed_evaluations(), 7);
}

#[test]
fn standalone_work_is_retained_and_a_b_a_is_three_updates() {
    let (mut session, templates) = fixture("<card value=\"{{value}}\"/>", "<text>{{value}}</text>");
    for (value, evaluations) in [("A", 2), ("A", 2), ("B", 4), ("A", 6)] {
        render(&mut session, None, &templates, json!({"value":value})).unwrap();
        assert_eq!(work(&session, None).completed_evaluations(), evaluations);
    }
    session.manifest.styles.push(Style {
        id: "style:app.wxss".into(),
        wxss_ir: format!("sha256:{}", "0".repeat(64)),
        scope: StyleScope::App,
    });
    render(&mut session, None, &templates, json!({"value":"A"})).unwrap();
    assert_eq!(work(&session, None).completed_evaluations(), 6);
    assert!(session.component_pages.is_empty());
    assert!(work(&session, None).scope_ids().contains("standalone"));
}

#[test]
fn declarative_errors_are_not_replayed_and_candidate_work_is_isolated() {
    let (mut live, templates) = fixture(
        "<card bad=\"{{bad}}\"/>",
        "<text wx:if=\"{{bad}}\">{{bad.call()}}</text><text wx:else>ok</text>",
    );
    let page_id = PageId(3);
    let page = Some(page_id);
    render(&mut live, page, &templates, json!({"bad":false})).unwrap();
    assert_eq!(work(&live, page).completed_evaluations(), 2);
    let mut candidate = Session::new(live.manifest.clone(), SessionConfig::default()).unwrap();
    prepare_view_program(&mut candidate, &templates);
    let data = json!({"bad":true});
    let ast = candidate
        .preview_page_template(&live, page_id, PAGE, &templates[PAGE], &data, &templates)
        .unwrap();
    assert!(candidate
        .declarative_component_tree(page, &ast, PAGE, &templates, Some(&live))
        .is_err());
    assert_eq!(work(&live, page).completed_evaluations(), 2);
    let error = render(&mut live, page, &templates, data.clone()).unwrap_err();
    assert_eq!(work(&live, page).completed_evaluations(), 4);
    assert_eq!(
        render(&mut live, page, &templates, data).unwrap_err(),
        error
    );
    assert_eq!(work(&live, page).completed_evaluations(), 4);
    render(&mut live, page, &templates, json!({"bad":false})).unwrap();
    assert_eq!(work(&live, page).completed_evaluations(), 6);
}

#[test]
fn declarative_missing_targets_fail_explicitly_instead_of_becoming_native_tags() {
    let (mut session, mut templates) = fixture("<card/>", "<text>present</text>");
    templates.remove(CARD);
    assert_eq!(
        render(&mut session, None, &templates, json!({}))
            .unwrap_err()
            .code,
        BridgeErrorCode::ModuleLoad
    );
    session.manifest.components[0]
        .using_components
        .insert("card".into(), "plugin://unavailable/card".into());
    assert_eq!(
        render(&mut session, None, &templates, json!({}))
            .unwrap_err()
            .code,
        BridgeErrorCode::UnsupportedCapability
    );
}
