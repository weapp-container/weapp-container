// Included by each native engine in a separate module with an engine factory.
// These are shared execution contracts, not official DevTools WXS evidence.
macro_rules! view_render_contract_tests {
    ($new:expr) => {
        use container_core::{
            ViewEngine, ViewEngineErrorCode, ViewExecutionBudget, ViewExpressionTask,
            ViewModuleSource, ViewRenderBatch, ViewRenderDocument, ViewRenderTask, ViewValue,
        };
        use serde_json::{json, Map, Value};
        use std::collections::{BTreeMap, BTreeSet};

        fn budget() -> ViewExecutionBudget {
            ViewExecutionBudget::new(std::time::Duration::from_secs(2))
        }

        #[test]
        fn provider_timings_measure_native_stages_without_reexecuting_stateful_calls() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:shared/timing.wxs", "var calls=0;exports.next=function(){return ++calls;};")], &budget()).unwrap();
            let loaded = engine.last_timings().expect("native provider timings");
            assert_eq!(loaded.batches, 1);
            assert_eq!(loaded.compile_ns, None, "lazy compilation is not an isolated native boundary");
            let tasks = vec![ViewExpressionTask {
                task_id:"timing".into(),scope_id:"page:timing".into(),document_id:"pages/timing.wxml".into(),
                expression:"counter.next()".into(),data:json!({}),bindings:BTreeMap::from([("counter".into(),"wxs:shared/timing.wxs".into())]),
            }];
            assert_eq!(engine.evaluate_batch(&tasks,&budget()).unwrap()[0].value,ViewValue::Number(1.0));
            let measured=engine.last_timings().unwrap();
            let sum=measured.input_encode_ns.saturating_add(measured.vm_input_parse_ns)
                .saturating_add(measured.execute_including_lazy_compile_ns)
                .saturating_add(measured.vm_output_encode_ns).saturating_add(measured.output_decode_ns);
            assert!(measured.elapsed_ns>=sum,"non-overlapping stages must fit the batch elapsed time: {measured:?}");
            assert_eq!(measured.compile_ns,None);
            assert_eq!(engine.last_timings(),Some(measured));
            assert_eq!(engine.evaluate_batch(&tasks,&budget()).unwrap()[0].value,ViewValue::Number(2.0));
        }

        fn module(id: &str, source: &str) -> ViewModuleSource {
            ViewModuleSource {
                compilation: None,
id: id.into(),
                source: source.into(),
                dependencies: Vec::new(),
            }
        }

        fn text(value: &str) -> Value {
            json!({"kind":"text", "value":value, "bindings":[]})
        }

        fn expression(value: &str) -> &str {
            value
                .strip_prefix("{{")
                .and_then(|value| value.strip_suffix("}}"))
                .unwrap_or(value)
                .trim()
        }

        fn element(tag: &str, attrs: &[(&str, &str)], children: Vec<Value>) -> Value {
            let attrs: Map<String, Value> = attrs
                .iter()
                .map(|(name, value)| ((*name).into(), Value::String((*value).into())))
                .collect();
            let mut directives = Map::new();
            for (name, value) in &attrs {
                let value = value.as_str().unwrap();
                let field = match name.as_str() {
                    "wx:if" => "ifExpr",
                    "wx:elif" => "elifExpr",
                    "wx:for" => "forExpr",
                    "wx:for-item" => "forItem",
                    "wx:for-index" => "forIndex",
                    "wx:key" => "forKey",
                    "wx:else" => {
                        directives.insert("elseBranch".into(), Value::Bool(true));
                        continue;
                    }
                    _ => continue,
                };
                directives.insert(field.into(), Value::String(expression(value).into()));
            }
            json!({"kind":"element", "tag":tag, "attrs":attrs,
                "bindings":[], "directives":directives, "children":children})
        }

        fn document(
            id: &str,
            nodes: Vec<Value>,
            bindings: &[(&str, &str)],
        ) -> ViewRenderDocument {
            ViewRenderDocument {
                compilation: None,
document_id: id.into(),
                ast: json!({"version":1,"nodes":nodes}),
                bindings: bindings
                    .iter()
                    .map(|(alias, module)| ((*alias).into(), (*module).into()))
                    .collect(),
            }
        }

        fn task(id: &str, scope: &str, document: &str, data: Value) -> ViewRenderTask {
            ViewRenderTask {
                task_id: id.into(),
                scope_id: scope.into(),
                document_id: document.into(),
                data,
            }
        }

        fn batch(document: ViewRenderDocument, data: Value) -> ViewRenderBatch {
            let id = document.document_id.clone();
            ViewRenderBatch {
                documents: vec![document],
                tasks: vec![task("render-1", "page-1", &id, data)],
            }
        }

        fn rendered_text(ast: &Value) -> String {
            fn visit(nodes: &[Value], output: &mut String) {
                for node in nodes {
                    match node["kind"].as_str() {
                        Some("text") => output.push_str(node["value"].as_str().unwrap()),
                        Some("element") => visit(node["children"].as_array().unwrap(), output),
                        _ => {}
                    }
                }
            }
            let mut output = String::new();
            visit(ast["nodes"].as_array().unwrap(), &mut output);
            output
        }

        fn counter_document() -> ViewRenderDocument {
            document(
                "pages/index.wxml",
                vec![text("{{tools.next()}}")],
                &[("tools", "wxs:tools.wxs")],
            )
        }

        fn load_counter(engine: &mut impl ViewEngine) {
            engine
                .load_modules(
                    &[module(
                        "wxs:tools.wxs",
                        "exports.n=0;exports.next=function(){return ++exports.n}",
                    )],
                    &budget(),
                )
                .unwrap();
        }

        #[test]
        fn view_render_contract_keeps_lexical_documents_separate_from_occurrence_sites() {
            let mut engine = $new;
            engine.load_modules(&[
                module("wxs:page.wxs", "exports.label=function(){return 'page'}"),
                module("wxs:shared.wxs", "exports.label=function(){return 'shared'}"),
                module("wxs:include.wxs", "exports.label=function(){return 'include'}"),
            ], &budget()).unwrap();
            let docs = vec![
                document("pages/index.wxml", vec![
                    element("import", &[("src", "../shared/templates.wxml")], vec![]),
                    element("template", &[("is", "row"), ("wx:for", "{{rows}}"), ("wx:key", "id")], vec![]),
                    element("include", &[("src", "../shared/include.wxml")], vec![]),
                    text("{{tools.label()}}"),
                    json!({"kind":"comment","value":"page comment"}),
                ], &[("tools", "wxs:page.wxs")]),
                document("shared/templates.wxml", vec![
                    element("template", &[("name", "row")], vec![
                        element("text", &[("id", "shared")], vec![text("{{tools.label()}}")]),
                        json!({"kind":"comment","value":"shared comment"}),
                    ]),
                ], &[("tools", "wxs:shared.wxs")]),
                document("shared/include.wxml", vec![
                    element("text", &[("id", "included")], vec![text("{{tools.label()}}")]),
                ], &[("tools", "wxs:include.wxs")]),
            ];
            let result = engine.render_batch(&ViewRenderBatch { documents:docs,
                tasks:vec![task("origins", "page:origins", "pages/index.wxml", json!({"rows":[{"id":"a"}]}))]
            }, &budget()).unwrap();
            assert_eq!(rendered_text(&result[0].ast), "sharedincludepage");
            let nodes = result[0].ast["nodes"].as_array().unwrap();
            // The synthetic keyed block belongs to the invocation document;
            // its expanded children belong to the template declaration.
            assert_eq!(nodes[0]["tag"], "block");
            assert_eq!(nodes[0]["lexicalOrigin"]["documentId"], "pages/index.wxml");
            assert_eq!(nodes[0]["children"][0]["lexicalOrigin"]["documentId"], "shared/templates.wxml");
            assert_eq!(nodes[0]["children"][0]["children"][0]["lexicalOrigin"]["documentId"], "shared/templates.wxml");
            assert_eq!(nodes[0]["children"][1]["lexicalOrigin"]["documentId"], "shared/templates.wxml");
            assert_eq!(nodes[1]["lexicalOrigin"]["documentId"], "shared/include.wxml");
            assert_eq!(nodes[2]["lexicalOrigin"]["documentId"], "pages/index.wxml");
            assert_eq!(nodes[3]["lexicalOrigin"]["documentId"], "pages/index.wxml");
            assert_ne!(nodes[0]["sourceSite"], nodes[0]["children"][0]["sourceSite"]);
        }

        #[test]
        fn view_render_contract_lazy_branches_and_loop_occurrences_keep_call_order() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", r#"
                exports.n=0;
                exports.next=function(label){return label+':'+(++exports.n)};
                exports.forever=function(){while(true){}};
            "#)], &budget()).unwrap();
            let doc = document("pages/index.wxml", vec![
                element("text", &[("wx:if", "{{false&&tools.forever()}}")], vec![text("{{tools.forever()}}")]),
                element("text", &[("wx:elif", "{{tools.next('if')==='if:1'}}")], vec![text("{{tools.next('then')}}")]),
                element("text", &[("wx:elif", "{{tools.forever()}}")], vec![text("never")]),
                element("text", &[("wx:else", "")], vec![text("{{tools.forever()}}")]),
                element("text", &[("wx:for", "{{rows}}"), ("wx:for-item", "row"), ("wx:for-index", "position"), ("wx:if", "{{row.visible}}")],
                    vec![text("{{position}}={{tools.next(row.id)}};")]),
                text("{{false?tools.forever():tools.next('after')}}"),
            ], &[("tools", "wxs:tools.wxs")]);
            let result = engine.render_batch(&batch(doc, json!({"rows":[
                {"id":"a","visible":true}, {"id":"hidden","visible":false}, {"id":"c","visible":true}
            ]})), &budget()).unwrap();
            assert_eq!(result.len(), 1);
            assert_eq!(result[0].task_id, "render-1");
            assert_eq!(rendered_text(&result[0].ast), "then:20=a:3;2=c:4;after:5");
        }

        #[test]
        fn view_render_contract_import_and_include_use_declaring_document_aliases() {
            let mut engine = $new;
            engine.load_modules(&[
                module("wxs:pages/index.wxml#tools", "exports.label='page'"),
                module("wxs:fragments/part.wxml#tools", "exports.label='part'"),
                module("wxs:fragments/leaf.wxml#tools", "exports.label='leaf'"),
                module("wxs:templates/cards.wxml#tools", "exports.label='card'"),
            ], &budget()).unwrap();
            let docs = vec![
                document("pages/index.wxml", vec![
                    element("import", &[("src", "../templates/cards.wxml")], vec![]),
                    text("{{tools.label}}/"),
                    element("include", &[("src", "../fragments/part.wxml")], vec![]),
                    element("template", &[("is", "card"), ("data", "{{label:'template-data'}}")], vec![]),
                ], &[("tools", "wxs:pages/index.wxml#tools")]),
                document("fragments/part.wxml", vec![
                    text("{{tools.label}}/"),
                    element("include", &[("src", "./leaf.wxml")], vec![]),
                ], &[("tools", "wxs:fragments/part.wxml#tools")]),
                document("fragments/leaf.wxml", vec![text("{{tools.label}}/")],
                    &[("tools", "wxs:fragments/leaf.wxml#tools")]),
                document("templates/cards.wxml", vec![
                    element("template", &[("name", "card")], vec![text("{{tools.label}}:{{label}}")]),
                ], &[("tools", "wxs:templates/cards.wxml#tools")]),
            ];
            let result = engine.render_batch(&ViewRenderBatch {
                documents: docs,
                tasks: vec![task("page", "page-1", "pages/index.wxml", json!({"label":"page-data"}))],
            }, &budget()).unwrap();
            assert_eq!(rendered_text(&result[0].ast), "page/part/leaf/card:template-data");
        }

        #[test]
        fn view_render_contract_loop_scope_reaches_template_data_and_nested_includes() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs",
                "exports.n=0;exports.label=function(label){return label+':'+(++exports.n)}")], &budget()).unwrap();
            let docs = vec![
                document("pages/home/index.wxml", vec![
                    element("template", &[("name", "row")], vec![
                        element("include", &[("src", "../../fragments/detail.wxml")], vec![]),
                    ]),
                    element("template", &[("wx:for", "{{rows}}"), ("wx:for-item", "row"),
                        ("wx:for-index", "position"), ("wx:if", "{{row.visible}}"),
                        ("is", "row"), ("data", "{{...row,position:position}}")], vec![]),
                ], &[]),
                document("fragments/detail.wxml", vec![
                    element("include", &[("src", "./label.wxml")], vec![]),
                ], &[]),
                document("fragments/label.wxml", vec![text("{{position}}={{tools.label(label)}};")],
                    &[("tools", "wxs:tools.wxs")]),
            ];
            let result = engine.render_batch(&ViewRenderBatch {
                documents: docs,
                tasks: vec![task("page", "page-1", "pages/home/index.wxml", json!({"rows":[
                    {"label":"a","visible":true}, {"label":"hidden","visible":false}, {"label":"c","visible":true}
                ]}))],
            }, &budget()).unwrap();
            assert_eq!(rendered_text(&result[0].ast), "0=a:1;2=c:2;");
        }

        #[test]
        fn view_render_contract_page_component_scopes_and_released_caches_are_independent() {
            let mut engine = $new;
            load_counter(&mut engine);
            let mut input = ViewRenderBatch {
                documents: vec![counter_document()],
                tasks: vec![
                    task("page", "page-1", "pages/index.wxml", json!({})),
                    task("component", "component-1", "pages/index.wxml", json!({})),
                    task("hidden-page", "page-2", "pages/index.wxml", json!({})),
                    task("same-page", "page-1", "pages/index.wxml", json!({})),
                ],
            };
            let values = |results: Vec<container_core::ViewRenderResult>| results.iter()
                .map(|result| rendered_text(&result.ast)).collect::<Vec<_>>();
            assert_eq!(values(engine.render_batch(&input, &budget()).unwrap()), ["1", "1", "1", "2"]);
            engine.release_scopes(&["page-1".into()], &budget()).unwrap();
            input.tasks.pop();
            assert_eq!(values(engine.render_batch(&input, &budget()).unwrap()), ["1", "2", "2"]);
            engine.release_scopes(&[], &budget()).unwrap();
            assert_eq!(values(engine.render_batch(&input, &budget()).unwrap()), ["2", "3", "3"]);
        }

        #[test]
        fn view_render_contract_expression_and_render_batches_share_the_same_scope_cache() {
            let mut engine = $new;
            load_counter(&mut engine);
            let input = batch(counter_document(), json!({}));
            assert_eq!(rendered_text(&engine.render_batch(&input, &budget()).unwrap()[0].ast), "1");
            let expression = ViewExpressionTask {
                task_id: "probe".into(), scope_id: "page-1".into(),
                document_id: "pages/index.wxml".into(), expression: "tools.next()".into(),
                data: json!({}), bindings: BTreeMap::from([("tools".into(), "wxs:tools.wxs".into())]),
            };
            assert_eq!(engine.evaluate_batch(&[expression], &budget()).unwrap()[0].value, ViewValue::Number(2.0));
            assert_eq!(rendered_text(&engine.render_batch(&input, &budget()).unwrap()[0].ast), "3");
        }

        #[test]
        fn view_render_contract_pure_attributes_keep_json_types_and_mixed_literals_stay_strings() {
            let mut engine = $new;
            let doc = document("pages/index.wxml", vec![element("card", &[
                ("object", "{{object}}"), ("array", "{{array}}"), ("boolean", "{{false}}"),
                ("number", "{{7}}"), ("number-string", "{{numberString}}"), ("nullable", "{{null}}"),
                ("mixed", "x{{false}}"), ("spaced", " {{false}} "), ("literal", "false"),
            ], vec![])], &[]);
            let data = json!({"object":{"label":"{{secret}}"},"array":[1,false,{"x":2}],"numberString":"0042"});
            let result = engine.render_batch(&batch(doc, data.clone()), &budget()).unwrap();
            let node = &result[0].ast["nodes"][0];
            let bound = node["boundValues"].as_object().unwrap();
            assert_eq!(bound.len(), 6);
            assert_eq!(bound["object"], data["object"]);
            assert_eq!(bound["array"], data["array"]);
            assert_eq!(bound["boolean"], false);
            assert_eq!(bound["number"].as_f64(), Some(7.0));
            assert_eq!(bound["number-string"], "0042");
            assert!(bound["nullable"].is_null());
            assert_eq!(node["attrs"]["object"], serde_json::to_string(&data["object"]).unwrap());
            assert_eq!(node["attrs"]["boolean"], "false");
            assert_eq!(node["attrs"]["nullable"], "");
            assert_eq!(node["attrs"]["mixed"], "xfalse");
            assert_eq!(node["attrs"]["spaced"], " false ");
            assert_eq!(node["attrs"]["literal"], "false");
        }

        #[test]
        fn view_render_contract_quoted_delimiters_and_returned_bindings_are_not_reinterpreted() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", "exports.label=function(){return '{{secret}}'}")], &budget()).unwrap();
            let doc = document("pages/index.wxml", vec![element("text", &[
                ("title", "{{tools.label()}}"), ("quoted", "{{ 'a}}b' }}"),
            ], vec![text("{{tools.label()}}/{{'a}}b'}}/{{({outer:{value:7}}).outer.value}}")])], &[("tools", "wxs:tools.wxs")]);
            let result = engine.render_batch(&batch(doc, json!({"secret":"must-not-leak"})), &budget()).unwrap();
            assert_eq!(rendered_text(&result[0].ast), "{{secret}}/a}}b/7");
            assert_eq!(result[0].ast["nodes"][0]["boundValues"]["title"], "{{secret}}");
            assert_eq!(result[0].ast["nodes"][0]["boundValues"]["quoted"], "a}}b");
        }

        #[test]
        fn view_render_contract_wxs_calls_copy_data_and_keep_the_module_receiver() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", r#"
                exports.n=0;exports.mutate=function(value){this.n++;value.n++;return this.n+':'+value.n};
                exports.make=function(){return {read:function(){return 7}}};
            "#)], &budget()).unwrap();
            let doc = document("pages/index.wxml", vec![text(
                "{{tools.mutate(payload)}}/{{payload.n}}/{{tools.make().read()}}"
            )], &[("tools", "wxs:tools.wxs")]);
            let input = batch(doc, json!({"payload":{"n":0}}));
            assert_eq!(rendered_text(&engine.render_batch(&input, &budget()).unwrap()[0].ast), "1:1/0/7");
            assert_eq!(rendered_text(&engine.render_batch(&input, &budget()).unwrap()[0].ast), "2:1/0/7");
        }

        #[test]
        fn view_render_contract_keys_and_source_sites_survive_filtering_and_reordering() {
            let mut engine = $new;
            let doc = document("pages/index.wxml", vec![
                element("view", &[("wx:if", "{{visible}}")], vec![]),
                element("view", &[("wx:for", "{{rows}}"), ("wx:key", "id"), ("id", "{{item.id}}")],
                    vec![element("text", &[], vec![text("{{item.label}}")])]),
            ], &[]);
            let first = engine.render_batch(&batch(doc.clone(), json!({"visible":true,"rows":[
                {"id":"a","label":"A"},{"id":"b","label":"B"}
            ]})), &budget()).unwrap().remove(0).ast;
            let next = engine.render_batch(&batch(doc, json!({"visible":false,"rows":[
                {"id":"b","label":"B"},{"id":"a","label":"A"}
            ]})), &budget()).unwrap().remove(0).ast;
            assert_eq!(first["nodes"][1], next["nodes"][1]);
            assert_eq!(first["nodes"][2], next["nodes"][0]);
            assert_eq!(first["nodes"][1]["key"], "a");
            assert_eq!(first["nodes"][2]["key"], "b");
            for node in &first["nodes"].as_array().unwrap()[1..] {
                assert!(node["keyScope"].as_str().is_some_and(|value| !value.is_empty()));
                let site = node["sourceSite"].as_str().unwrap();
                assert!(!site.is_empty());
                assert_ne!(node["children"][0]["sourceSite"].as_str().unwrap(), site);
            }
        }

        #[test]
        fn view_render_contract_template_and_include_invocations_namespace_inner_repeats() {
            let mut engine = $new;
            let repeat = element("text", &[("wx:for", "{{rows}}"), ("wx:key", "*this")], vec![text("{{item}}")]);
            let docs = vec![
                document("pages/index.wxml", vec![
                    element("template", &[("name", "list")], vec![repeat.clone()]),
                    element("template", &[("is", "list"), ("data", "{{rows:rows}}")], vec![]),
                    element("template", &[("is", "list"), ("data", "{{rows:rows}}")], vec![]),
                    element("include", &[("src", "../fragments/list.wxml")], vec![]),
                    element("include", &[("src", "../fragments/list.wxml")], vec![]),
                ], &[]),
                document("fragments/list.wxml", vec![repeat], &[]),
            ];
            let result = engine.render_batch(&ViewRenderBatch {documents:docs,
                tasks:vec![task("page", "page-1", "pages/index.wxml", json!({"rows":["a"]}))]}, &budget()).unwrap();
            fn collect(node: &Value, keys: &mut Vec<(String, String, String)>) {
                if let Some(key) = node["key"].as_str() {
                    keys.push((key.into(), node["keyScope"].as_str().unwrap().into(), node["sourceSite"].as_str().unwrap().into()));
                }
                if let Some(children) = node["children"].as_array() {
                    for child in children { collect(child, keys); }
                }
            }
            let mut keys = Vec::new();
            for node in result[0].ast["nodes"].as_array().unwrap() { collect(node, &mut keys); }
            assert_eq!(keys.len(), 4);
            assert!(keys.iter().all(|(key, _, _)| key == "a"));
            assert_eq!(keys.iter().map(|(_, scope, _)| scope).collect::<BTreeSet<_>>().len(), 4);
            assert_eq!(keys.iter().map(|(_, _, site)| site).collect::<BTreeSet<_>>().len(), 4);
        }

        #[test]
        fn view_render_contract_invalid_batches_execute_no_preceding_stateful_task() {
            let mut engine = $new;
            load_counter(&mut engine);
            let good = batch(counter_document(), json!({}));
            let mut candidates = Vec::new();
            let mut duplicate_task = good.clone();
            duplicate_task.tasks.push(duplicate_task.tasks[0].clone());
            candidates.push(duplicate_task);
            let mut duplicate_document = good.clone();
            duplicate_document.documents.push(duplicate_document.documents[0].clone());
            candidates.push(duplicate_document);
            let mut unknown_document = good.clone();
            unknown_document.tasks.push(task("missing", "page-1", "missing.wxml", json!({})));
            candidates.push(unknown_document);
            let mut wrong_data = good.clone();
            wrong_data.tasks.push(task("array-data", "page-1", "pages/index.wxml", json!([])));
            candidates.push(wrong_data);
            let mut wrong_alias = good.clone();
            wrong_alias.documents.push(document("other.wxml", vec![], &[("tools", "wxs:missing.wxs")]));
            candidates.push(wrong_alias);
            let mut malformed_ast = good.clone();
            malformed_ast.documents.push(document("other.wxml", vec![json!({"kind":"element","tag":"view","attrs":[],"children":[]})], &[]));
            candidates.push(malformed_ast);
            let mut forged_declared_document = good.clone();
            forged_declared_document.documents.push(document("other.wxml", vec![], &[]));
            forged_declared_document.documents[0].ast["nodes"][0]["lexicalOrigin"] = json!({"documentId":"other.wxml"});
            candidates.push(forged_declared_document);
            for origin in [
                json!({"documentId":"missing.wxml"}),
                json!({"documentId":"../pages/index.wxml"}),
                json!({"documentId":"pages/index.wxml", "owner":"not-a-document"}),
            ] {
                let mut malformed_origin = good.clone();
                malformed_origin.documents[0].ast["nodes"][0]["lexicalOrigin"] = origin;
                candidates.push(malformed_origin);
            }
            for candidate in candidates {
                assert_eq!(engine.render_batch(&candidate, &budget()).unwrap_err().code, ViewEngineErrorCode::InvalidBatch);
            }
            assert_eq!(rendered_text(&engine.render_batch(&good, &budget()).unwrap()[0].ast), "1");
        }

        #[test]
        fn view_render_contract_inline_alias_ownership_and_release_inputs_fail_before_mutation() {
            let mut engine = $new;
            engine.load_modules(&[
                module("wxs:tools.wxs", "exports.n=0;exports.next=function(){return ++exports.n}"),
                module("wxs:private.wxml#privateTools", "exports.value=7"),
            ], &budget()).unwrap();
            let good = batch(counter_document(), json!({}));
            for (id, alias) in [("foreign.wxml", "privateTools"), ("private.wxml", "tools")] {
                let mut candidate = good.clone();
                candidate.documents.push(document(id, vec![], &[(alias, "wxs:private.wxml#privateTools")]));
                assert_eq!(engine.render_batch(&candidate, &budget()).unwrap_err().code, ViewEngineErrorCode::InvalidBatch);
            }
            assert_eq!(rendered_text(&engine.render_batch(&good, &budget()).unwrap()[0].ast), "1");
            assert_eq!(engine.release_scopes(&["page-1".into(), String::new()], &budget()).unwrap_err().code, ViewEngineErrorCode::InvalidBatch);
            assert_eq!(rendered_text(&engine.render_batch(&good, &budget()).unwrap()[0].ast), "2");
        }

        #[test]
        fn view_render_contract_invalid_expression_in_inactive_branch_is_precompiled() {
            let mut engine = $new;
            load_counter(&mut engine);
            let mut input = batch(counter_document(), json!({}));
            input.documents[0].ast["nodes"].as_array_mut().unwrap().push(
                element("text", &[("wx:if", "{{false}}")], vec![text("{{(}}")]),
            );
            assert!(engine.render_batch(&input, &budget()).is_err());
            assert_eq!(rendered_text(&engine.render_batch(&batch(counter_document(), json!({})), &budget()).unwrap()[0].ast), "1");
        }

        #[test]
        fn view_render_contract_json_attribute_sinks_reject_functions_cycles_and_async_values() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", r#"
                exports.fn=function(){};
                exports.cycle=function(){var value={};value.self=value;return value};
                exports.ok=7;
            "#)], &budget()).unwrap();
            for value in ["{{tools.fn}}", "{{tools.cycle()}}", "{{Promise.resolve(1)}}"] {
                let doc = document("pages/index.wxml", vec![element("card", &[("value", value)], vec![])], &[("tools", "wxs:tools.wxs")]);
                assert_eq!(engine.render_batch(&batch(doc, json!({})), &budget()).unwrap_err().code, ViewEngineErrorCode::UnsupportedValue);
            }
            let doc = document("pages/index.wxml", vec![text("{{tools.ok}}")], &[("tools", "wxs:tools.wxs")]);
            assert_eq!(rendered_text(&engine.render_batch(&batch(doc, json!({})), &budget()).unwrap()[0].ast), "7");
        }

        #[test]
        fn view_render_contract_execution_error_returns_no_partial_batch_and_keeps_realm_usable() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", "exports.n=0;exports.next=function(){return ++exports.n};exports.fail=function(){throw Error('render failed')}")], &budget()).unwrap();
            let input = ViewRenderBatch {
                documents: vec![counter_document(), document("failed.wxml", vec![text("{{tools.fail()}}")], &[("tools", "wxs:tools.wxs")])],
                tasks: vec![task("first", "page-1", "pages/index.wxml", json!({})), task("failed", "page-1", "failed.wxml", json!({}))],
            };
            let error = engine.render_batch(&input, &budget()).unwrap_err();
            assert_eq!(error.code, ViewEngineErrorCode::Execution);
            assert!(error.message.contains("render failed"));
            // State inside WXS is not transactional; only complete AST batches
            // may reach the host's frame commit boundary.
            assert_eq!(rendered_text(&engine.render_batch(&batch(counter_document(), json!({})), &budget()).unwrap()[0].ast), "2");
        }

        #[test]
        fn view_render_contract_timeout_discards_the_realm_without_a_partial_result() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", "exports.n=0;exports.next=function(){return ++exports.n};exports.forever=function(){while(true){}}")], &budget()).unwrap();
            let input = ViewRenderBatch {
                documents: vec![counter_document(), document("slow.wxml", vec![text("{{tools.forever()}}")], &[("tools", "wxs:tools.wxs")])],
                tasks: vec![task("first", "page-1", "pages/index.wxml", json!({})), task("slow", "page-1", "slow.wxml", json!({}))],
            };
            let short = ViewExecutionBudget::new(std::time::Duration::from_millis(30));
            assert_eq!(engine.render_batch(&input, &short).unwrap_err().code, ViewEngineErrorCode::Timeout);
            assert_eq!(std::sync::Arc::strong_count(&short.cancellation), 1);
            assert_eq!(engine.render_batch(&batch(counter_document(), json!({})), &budget()).unwrap_err().code, ViewEngineErrorCode::RequiresReset);
            engine.reset().unwrap();
            load_counter(&mut engine);
            assert_eq!(rendered_text(&engine.render_batch(&batch(counter_document(), json!({})), &budget()).unwrap()[0].ast), "1");
        }

        #[test]
        fn view_render_contract_cancellation_interrupts_render_and_releases_its_watchdog() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", "exports.forever=function(){while(true){}}")], &budget()).unwrap();
            let input = batch(document("pages/index.wxml", vec![text("{{tools.forever()}}")], &[("tools", "wxs:tools.wxs")]), json!({}));
            let execution = budget();
            let cancellation = std::sync::Arc::clone(&execution.cancellation);
            let cancel = std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(10));
                cancellation.store(true, std::sync::atomic::Ordering::Release);
            });
            let result = engine.render_batch(&input, &execution);
            cancel.join().unwrap();
            assert_eq!(result.unwrap_err().code, ViewEngineErrorCode::Cancelled);
            assert_eq!(std::sync::Arc::strong_count(&execution.cancellation), 1);
            assert_eq!(engine.release_scopes(&["page-1".into()], &budget()).unwrap_err().code, ViewEngineErrorCode::RequiresReset);
        }

        #[test]
        fn view_render_contract_dispose_rejects_render_and_scope_release() {
            let mut engine = $new;
            load_counter(&mut engine);
            let input = batch(counter_document(), json!({}));
            assert_eq!(rendered_text(&engine.render_batch(&input, &budget()).unwrap()[0].ast), "1");
            engine.dispose();
            assert_eq!(engine.render_batch(&input, &budget()).unwrap_err().code, ViewEngineErrorCode::RequiresReset);
            assert_eq!(engine.release_scopes(&["page-1".into()], &budget()).unwrap_err().code, ViewEngineErrorCode::RequiresReset);
        }
    };
}
