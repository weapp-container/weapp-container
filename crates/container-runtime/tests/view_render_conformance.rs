//! The isolated renderer must preserve the portable WXML contract before the
//! production Session may replace its existing evaluator. This is a local IR
//! differential baseline, not a WeChat DevTools or WXS dialect oracle.

#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_core::{
    ViewCompiledExpression, ViewCompiledSource, ViewEngine, ViewExecutionBudget, ViewModuleSource,
    ViewRenderBatch, ViewRenderDocument, ViewRenderTask,
};
use container_ir::{
    decode_wxml, evaluate_wxml_with_templates_from_source, parse_wxml,
    project_wxml_slots_with_options, ContainerManifestV1, WxmlAst, WxmlNode,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};

struct Case {
    name: &'static str,
    source: &'static str,
    data: Value,
    imports: Vec<(&'static str, &'static str)>,
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "typed-properties-and-interpolation",
            source: r#"<custom title="{{name}}" count="{{count}}" active="{{active}}" object="{{object}}" absent="{{absent}}" mixed="n={{count}}">{{name}}:{{count}}:{{active}}:{{absent}}:{{object}}</custom>"#,
            data: json!({"name":"{{literal}}", "count":42, "active":false,
                "object":{"nested":[true, 3]}, "absent":null}),
            imports: vec![],
        },
        Case {
            name: "mustache-strings-and-objects",
            source: r#"<view title="{{'}}'}}">{{({a: {b: value}}).a.b}}/{{ 'a}}b' }}</view>"#,
            data: json!({"value":"ok"}),
            imports: vec![],
        },
        Case {
            name: "binding-results-are-never-parsed-as-source",
            source: r#"<view title="{{unfinished}}" data-empty="{{empty}}">{{unfinished}}/{{empty}}</view>"#,
            data: json!({"unfinished":"{{broken","empty":"{{}}"}),
            imports: vec![],
        },
        Case {
            name: "undefined-object-members-and-array-slots",
            source: r#"<view data-object="{{({present:1,missing:absent})}}" data-array="{{[absent,1]}}">{{({present:1,missing:absent})}}/{{[absent,1]}}</view>"#,
            data: json!({}),
            imports: vec![],
        },
        Case {
            name: "object-text-keeps-portable-key-order",
            source: r#"<view data-object="{{object}}">{{object}}</view>"#,
            data: json!({"object":{"10":"a","2":"b","01":"c","😀":1,"\u{e000}":2}}),
            imports: vec![],
        },
        Case {
            name: "conditional-chain-formatting-and-comments",
            source: "<view wx:if=\"{{a}}\">A</view>\n<!-- separator -->\n<view wx:elif=\"{{b}}\">B</view>\n<view wx:else>C</view>",
            data: json!({"a":false,"b":true}),
            imports: vec![],
        },
        Case {
            name: "keyed-loop-condition-and-custom-aliases",
            source: r#"<view wx:for="{{items}}" wx:for-item="row" wx:for-index="pos" wx:key="id" wx:if="{{row.visible}}" data-row="{{row}}"><text>{{pos}}:{{row.label}}</text></view>"#,
            data: json!({"items":[{"id":"甲","label":"{{literal}}","visible":true},
                {"id":"乙","label":"hidden","visible":false},
                {"id":"丙","label":"last","visible":true}]}),
            imports: vec![],
        },
        Case {
            name: "independent-repeats-and-object-loop",
            source: r#"<view wx:for="{{items}}" wx:key="*this">{{item}}</view><view wx:for="{{items}}" wx:key="*this">{{item}}</view><text wx:for="{{record}}">{{index}}={{item}}</text>"#,
            data: json!({"items":["a","b"],"record":{"first":1,"second":2}}),
            imports: vec![],
        },
        Case {
            name: "nested-loop-lexical-data",
            source: r#"<block wx:for="{{groups}}" wx:for-item="group" wx:key="id"><view wx:for="{{group.items}}" wx:key="*this">{{group.id}}/{{index}}/{{item}}</view></block>"#,
            data: json!({"groups":[{"id":"left","items":[1,2]},{"id":"right","items":[3]}]}),
            imports: vec![],
        },
        Case {
            name: "whitespace-and-events",
            source: "\n <view bindtap=\"{{handler}}\" capture-catch:tap=\"onTap\" data-id=\"{{id}}\">\n<text>\n  {{label}}\n</text> <view/>\n</view>\n",
            data: json!({"handler":"handle","id":7,"label":"visible"}),
            imports: vec![],
        },
        Case {
            name: "local-dynamic-template-and-spread",
            source: r#"<template name="row"><view data-value="{{value}}">{{label}}/{{value}}</view></template><template is="{{which}}" data="{{...row, value: override}}"/>"#,
            data: json!({"which":"row","row":{"label":"row","value":1},"override":2}),
            imports: vec![],
        },
        Case {
            name: "repeat-template-roots-and-unicode-identity",
            source: r#"<import src="../../shared/行.wxml"/><template wx:for="{{items}}" wx:key="id" is="行" data="{{...item}}"/>"#,
            data: json!({"items":[{"id":"甲","label":"first"},{"id":"乙","label":"second"}]}),
            imports: vec![("shared/行.wxml",r#"<template name="行"><text>{{id}}</text><view>{{label}}</view></template>"#)],
        },
        Case {
            name: "relative-include-and-template-declaration-owner",
            source: r#"<import src="../../shared/item.wxml"/><template is="row" data="{{label: label}}"/><include src="../../shared/footer.wxml"/>"#,
            data: json!({"label":"from-page"}),
            imports: vec![
                ("shared/item.wxml",r#"<template name="row"><include src="./body.wxml"/></template>"#),
                ("shared/body.wxml",r#"<view>{{label}}</view>"#),
                ("shared/footer.wxml",r#"<text>footer={{label}}</text>"#),
            ],
        },
        Case {
            // The existing portable evaluator retains caller values as a
            // fallback. Preserve and expose that contract here; this test is
            // not evidence of the official template data isolation semantics.
            name: "template-data-existing-fallback",
            source: r#"<template name="row"><text>{{outer}}/{{inner}}</text></template><template is="row" data="{{inner: inner}}"/>"#,
            data: json!({"outer":"caller-fallback","inner":"visible"}),
            imports: vec![],
        },
    ]
}

fn budget() -> ViewExecutionBudget {
    // This test verifies semantics, not latency. Native debug/CI compilation
    // and transporting a whole batch must not use a performance acceptance cap.
    ViewExecutionBudget::new(Duration::from_secs(5))
}

fn javascript_numbers(value: &mut Value) {
    // JSON 42 and 42.0 carry the same JavaScript Number. serde_json keeps
    // their integer/float storage variants distinct in PartialEq; normalize
    // only those variants, retaining every string, type and identity field.
    match value {
        Value::Number(number) => *value = json!(number.as_f64().unwrap()),
        Value::Array(values) => values.iter_mut().for_each(javascript_numbers),
        Value::Object(values) => values.values_mut().for_each(javascript_numbers),
        _ => {}
    }
}

fn verify_parsed_ir_contract(engine: &mut dyn ViewEngine) {
    let source_path = "pages/home/index.wxml";
    for case in cases() {
        let ast = parse_wxml(case.source).expect(case.name);
        let mut templates = case
            .imports
            .into_iter()
            .map(|(id, source)| (id.to_owned(), parse_wxml(source).expect(case.name)))
            .collect::<BTreeMap<_, _>>();
        templates.insert(source_path.into(), ast.clone());
        let expected = evaluate_wxml_with_templates_from_source(
            &ast,
            &case.data,
            &templates,
            Some(source_path),
        )
        .expect(case.name);
        let batch = ViewRenderBatch {
            documents: templates
                .into_iter()
                .map(|(id, ast)| ViewRenderDocument {
                    compilation: None,
                    document_id: id,
                    ast: serde_json::to_value(ast).unwrap(),
                    bindings: BTreeMap::new(),
                })
                .collect(),
            tasks: vec![ViewRenderTask {
                task_id: case.name.into(),
                scope_id: format!("page:ir-contract:{}", case.name),
                document_id: source_path.into(),
                data: case.data,
            }],
        };
        let output = engine.render_batch(&batch, &budget()).expect(case.name);
        assert_eq!(output.len(), 1, "{}", case.name);
        let actual: WxmlAst = serde_json::from_value(output[0].ast.clone()).expect(case.name);
        let mut actual = serde_json::to_value(actual).unwrap();
        let mut expected = serde_json::to_value(expected).unwrap();
        javascript_numbers(&mut actual);
        javascript_numbers(&mut expected);
        assert_eq!(actual, expected, "{}", case.name);
    }
}

fn verify_keyed_reorder_and_slot_projection(engine: &mut dyn ViewEngine) {
    let caller = parse_wxml(r#"<wrapper><view wx:for="{{rows}}" wx:key="id" slot="body" data-id="{{item.id}}" data-row="{{item}}">{{item.label}}</view></wrapper>"#).unwrap();
    let callee =
        parse_wxml(r#"<view><slot name="body"><text>fallback={{fallback}}</text></slot></view>"#)
            .unwrap();
    let documents = vec![
        ViewRenderDocument {
            compilation: None,
            document_id: "pages/home/index.wxml".into(),
            ast: serde_json::to_value(caller).unwrap(),
            bindings: BTreeMap::new(),
        },
        ViewRenderDocument {
            compilation: None,
            document_id: "components/wrapper/index.wxml".into(),
            ast: serde_json::to_value(callee).unwrap(),
            bindings: BTreeMap::new(),
        },
    ];
    let render = |engine: &mut dyn ViewEngine, rows: Value| {
        let batch = ViewRenderBatch {
            documents: documents.clone(),
            tasks: vec![
                ViewRenderTask {
                    task_id: "caller".into(),
                    scope_id: "page:1".into(),
                    document_id: "pages/home/index.wxml".into(),
                    data: json!({"rows":rows}),
                },
                ViewRenderTask {
                    task_id: "callee".into(),
                    scope_id: "page:1/component:wrapper".into(),
                    document_id: "components/wrapper/index.wxml".into(),
                    data: json!({"fallback":"component-only"}),
                },
            ],
        };
        let output = engine.render_batch(&batch, &budget()).unwrap();
        let caller: WxmlAst = serde_json::from_value(output[0].ast.clone()).unwrap();
        let callee: WxmlAst = serde_json::from_value(output[1].ast.clone()).unwrap();
        let children = match &caller.nodes[0] {
            container_ir::WxmlNode::Element { children, .. } => children,
            _ => panic!("component host"),
        };
        project_wxml_slots_with_options(&callee, children, true).unwrap()
    };
    let first = render(
        engine,
        json!([{"id":"a","label":"A"},{"id":"b","label":"B"}]),
    );
    let second = render(
        engine,
        json!([{"id":"b","label":"B"},{"id":"a","label":"A"}]),
    );
    fn children(ast: &WxmlAst) -> &[container_ir::WxmlNode] {
        match &ast.nodes[0] {
            container_ir::WxmlNode::Element { children, .. } => children,
            _ => panic!("projected root"),
        }
    }
    assert_eq!(children(&first)[0], children(&second)[1]);
    assert_eq!(children(&first)[1], children(&second)[0]);
    let empty = render(engine, json!([]));
    fn text(nodes: &[container_ir::WxmlNode]) -> String {
        nodes
            .iter()
            .map(|node| match node {
                container_ir::WxmlNode::Text { value, .. } => value.clone(),
                container_ir::WxmlNode::Element { children, .. } => text(children),
                _ => String::new(),
            })
            .collect()
    }
    assert_eq!(text(children(&empty)), "fallback=component-only");
    let literal = render(engine, json!([{"id":"a","label":"{{fallback}}"}]));
    assert_eq!(text(children(&literal)), "{{fallback}}");
    match &children(&literal)[0] {
        container_ir::WxmlNode::Element { bound_values, .. } => {
            assert_eq!(
                bound_values["data-row"],
                json!({"id":"a","label":"{{fallback}}"})
            );
        }
        _ => panic!("typed projected element"),
    }
}

fn verify_packer_program(engine: &mut dyn ViewEngine) {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/fixtures/isolated-view-render/golden-program.json"
    )))
    .unwrap();
    let manifest: ContainerManifestV1 =
        serde_json::from_value(fixture["manifest"].clone()).unwrap();
    manifest.validate().unwrap();
    manifest.verify_integrity().unwrap();
    let blobs = fixture["blobs"].as_object().unwrap();
    for (hash, source) in blobs {
        assert_eq!(
            container_ir::hex_digest(source.as_str().unwrap().as_bytes()),
            *hash
        );
    }
    let source = |hash: &str| {
        blobs[hash.strip_prefix("sha256:").unwrap_or(hash)]
            .as_str()
            .unwrap()
    };
    let compilation = manifest.view_compilation.as_ref().unwrap();
    let executable = |hash: &str, helper: &str| ViewCompiledSource {
        code: source(hash).into(),
        helper: helper.into(),
        abi: compilation.abi.clone(),
    };
    let modules = manifest
        .view_scripts
        .iter()
        .map(|module| {
            let compiled = compilation
                .modules
                .iter()
                .find(|item| item.id == module.id)
                .unwrap();
            ViewModuleSource {
                compilation: Some(executable(&compiled.executable_sha256, &compiled.helper)),
                id: module.id.clone(),
                source: source(&module.sha256).into(),
                dependencies: module.dependencies.clone(),
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(modules.len(), 6);
    assert!(manifest
        .modules
        .iter()
        .all(|module| !module.id.ends_with(".wxs")));
    let documents = manifest
        .templates
        .iter()
        .map(|template| {
            let ast = decode_wxml(source(&template.wxml_ast).as_bytes()).unwrap();
            let document_id = template.id.strip_prefix("template:").unwrap();
            let compiled = compilation
                .documents
                .iter()
                .find(|item| item.document_id == document_id)
                .unwrap();
            ViewRenderDocument {
                compilation: Some(
                    compiled
                        .expressions
                        .iter()
                        .map(|item| ViewCompiledExpression {
                            source: item.source.clone(),
                            shorthand: item.shorthand,
                            compilation: executable(&item.executable_sha256, &item.helper),
                        })
                        .collect(),
                ),
                document_id: document_id.into(),
                ast: serde_json::to_value(ast).unwrap(),
                bindings: template.wxs_modules.clone(),
            }
        })
        .collect();
    engine.load_modules(&modules, &budget()).unwrap();
    let batch = ViewRenderBatch {
        documents,
        tasks: vec![ViewRenderTask {
            task_id: "packed-program".into(),
            scope_id: "page:packed-program".into(),
            document_id: fixture["render"]["documentId"].as_str().unwrap().into(),
            data: fixture["render"]["data"].clone(),
        }],
    };
    fn text(nodes: &[WxmlNode]) -> String {
        nodes
            .iter()
            .map(|node| match node {
                WxmlNode::Text { value, .. } => value.clone(),
                WxmlNode::Element { children, .. } => text(children),
                _ => String::new(),
            })
            .collect()
    }
    let first = engine.render_batch(&batch, &budget()).unwrap();
    let first_ast: WxmlAst = serde_json::from_value(first[0].ast.clone()).unwrap();
    assert_eq!(
        text(&first_ast.nodes),
        fixture["render"]["expectedText"].as_str().unwrap()
    );
    // Resetting this occurrence must restore the module counter while using
    // the same verified module/document graph, without running AppService.
    engine
        .release_scopes(&["page:packed-program".into()], &budget())
        .unwrap();
    let after_release = engine.render_batch(&batch, &budget()).unwrap();
    assert_eq!(after_release, first);
}

#[cfg(feature = "quickjs-native")]
#[test]
fn quickjs_preserves_parsed_wxml_ir_and_projection() {
    let mut engine = container_engine_quickjs::QuickJsViewEngine::new(Default::default()).unwrap();
    verify_parsed_ir_contract(&mut engine);
    verify_keyed_reorder_and_slot_projection(&mut engine);
}

#[cfg(feature = "v8-native")]
#[test]
fn v8_preserves_parsed_wxml_ir_and_projection() {
    let mut engine = container_engine_v8::V8ViewEngine::new(Default::default()).unwrap();
    verify_parsed_ir_contract(&mut engine);
    verify_keyed_reorder_and_slot_projection(&mut engine);
}

#[cfg(feature = "quickjs-native")]
#[test]
fn quickjs_executes_verified_packer_wxml_wxs_program() {
    let mut engine = container_engine_quickjs::QuickJsViewEngine::new(Default::default()).unwrap();
    verify_packer_program(&mut engine);
}

#[cfg(feature = "v8-native")]
#[test]
fn v8_executes_verified_packer_wxml_wxs_program() {
    let mut engine = container_engine_v8::V8ViewEngine::new(Default::default()).unwrap();
    verify_packer_program(&mut engine);
}
