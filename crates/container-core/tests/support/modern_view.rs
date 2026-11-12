// Included by both real native engine providers. This verifies the modern
// profile contract; it is not official WeChat WXS or device evidence.
macro_rules! modern_view_contract_tests {
    ($new:expr) => {
        use container_core::{
            ViewEngine, ViewEngineErrorCode, ViewExecutionBudget, ViewExpressionTask,
            ViewModuleSource, ViewRenderBatch, ViewRenderDocument, ViewRenderTask, ViewValue,
        };
        use serde_json::{json, Value};
        use std::collections::BTreeMap;

        fn budget() -> ViewExecutionBudget {
            ViewExecutionBudget::new(std::time::Duration::from_secs(2))
        }

        fn module(source: &str) -> ViewModuleSource {
            ViewModuleSource {
                id: "modern:unit.mjs".into(),
                source: source.into(),
                dependencies: Vec::new(),
                compilation: None,
            }
        }

        fn text(source: &str) -> Value {
            json!({"kind":"text","value":source,"bindings":[]})
        }

        fn element(tag: &str, attrs: Value, children: Vec<Value>) -> Value {
            json!({"kind":"element","tag":tag,"attrs":attrs,"bindings":[],"children":children})
        }

        fn document(id: &str, nodes: Vec<Value>) -> ViewRenderDocument {
            ViewRenderDocument {
                document_id: id.into(),
                ast: json!({"version":1,"nodes":nodes}),
                bindings: BTreeMap::from([("tools".into(), "modern:unit.mjs".into())]),
                compilation: None,
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

        fn batch(nodes: Vec<Value>, data: Value) -> ViewRenderBatch {
            ViewRenderBatch {
                documents: vec![document("page.wxml", nodes)],
                tasks: vec![task("render", "page", "page.wxml", data)],
            }
        }

        fn rendered_text(ast: &Value) -> String {
            fn visit(nodes: &[Value], result: &mut String) {
                for node in nodes {
                    if node["kind"] == "text" {
                        result.push_str(node["value"].as_str().unwrap());
                    } else if node["kind"] == "element" {
                        visit(node["children"].as_array().unwrap(), result);
                    }
                }
            }
            let mut result = String::new();
            visit(ast["nodes"].as_array().unwrap(), &mut result);
            result
        }

        #[test]
        fn modern_source_url_stack_preserves_factory_line() {
            let mut engine = $new;
            engine.load_modules(&[module("const marker = 1;\nfunction failMarker() {\n  throw new Error('modern-stack-marker');\n}\nmodule.exports={'page.wxml':{tools:{failMarker}}};")], &budget()).unwrap();
            let error = engine.render_batch(&batch(vec![text("{{tools.failMarker()}}")], json!({})), &budget()).unwrap_err();
            let stack = error.stack.expect("native modern stack");
            eprintln!("MODERN_STACK_BEGIN\n{stack}\nMODERN_STACK_END");
            assert!(stack.contains("weapp-view:///modern:unit.mjs.js:6:"), "{stack}");
            assert!(stack.contains("modern-stack-marker") || error.message.contains("modern-stack-marker"));
        }

        #[test]
        fn modern_native_compiler_hook_is_not_app_visible() {
            let mut engine = $new;
            engine.load_modules(&[module("if ('__weappContainer_compileModernFactory' in globalThis) throw new Error('compiler leaked'); module.exports={'page.wxml':{tools:{ok(){return true}}}};")], &budget()).unwrap();
            let output=engine.render_batch(&batch(vec![text("{{tools.ok()}}/{{typeof __weappContainer_compileModernFactory}}")],json!({})), &budget()).unwrap();
            assert_eq!(rendered_text(&output[0].ast),"true/undefined");
        }

        #[test]
        fn modern_actual_rolldown_bundle_keeps_typescript_live_bindings_cycles_and_tdz() {
            let mut engine = $new;
            // These are exact golden bytes from the public pack compiler, not
            // hand-written CommonJS approximations of ESM/TypeScript behavior.
            let source = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tools/container-manifest/test/fixtures/modern-esm-conformance/compiled.cjs"));
            engine.load_modules(&[module(source)], &budget()).unwrap();
            let expr_task = |expression: &str| ViewExpressionTask {
                task_id:"esm".into(), scope_id:"page".into(), document_id:"page.wxml".into(),
                expression:expression.into(), data:json!({}),
                bindings:BTreeMap::from([("tools".into(),"modern:unit.mjs".into()),("shared".into(),"modern:unit.mjs".into())]),
            };
            let expressions = [
                "tools.exercise()", "shared.counter", "shared.bump()", "tools.readImported()", "tools.exercise()", "shared.counter",
            ];
            let expected = [
                ViewValue::String("before=0;after=1;sum=6;unit=points;cycle=a:b:a".into()),
                ViewValue::Number(1.0), ViewValue::Number(2.0), ViewValue::Number(2.0),
                ViewValue::String("before=2;after=3;sum=6;unit=points;cycle=a:b:a".into()), ViewValue::Number(3.0),
            ];
            for (expression, expected) in expressions.into_iter().zip(expected) {
                assert_eq!(engine.evaluate_batch(&[expr_task(expression)], &budget()).unwrap()[0].value, expected);
            }
            let mut doc=document("page.wxml",vec![text("{{tools.readImported()}}/{{shared.counter}}")]);
            doc.bindings.insert("shared".into(),"modern:unit.mjs".into());
            let rendered=engine.render_batch(&ViewRenderBatch{documents:vec![doc],tasks:vec![task("render","page","page.wxml",json!({}))]},&budget()).unwrap();
            assert_eq!(rendered_text(&rendered[0].ast),"3/3");
            let tdz = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tools/container-manifest/test/fixtures/modern-esm-conformance/compiled-tdz.cjs"));
            engine.load_modules(&[module(tdz)], &budget()).unwrap();
            let caught = engine.evaluate_batch(&[expr_task("(()=>{try{void tools;return false}catch(error){return error instanceof ReferenceError}})()")], &budget()).unwrap();
            assert_eq!(caught[0].value, ViewValue::Bool(true));
            let error = engine.evaluate_batch(&[expr_task("tools.value")], &budget()).unwrap_err();
            assert_eq!(error.code, ViewEngineErrorCode::Execution);
            assert!(error.message.to_ascii_lowercase().contains("initializ"), "{}", error.message);
        }

        #[test]
        fn modern_classes_namespaces_and_snapshot_have_standard_identity() {
            let mut engine = $new;
            engine.load_modules(&[module(r#"
                class Box { constructor(x){this.x=x} }
                const arr=[];
                function change(value){value.n++;return value.n}
                function features(){
                  const source={a:2,b:3};const {a,...rest}=source;
                  let result=0;for(const x of [a,...[rest.b]])result+=x;
                  return `${result}/${source.missing?.name ?? 'empty'}/${new Map([['n',7]]).get('n')}/${String(1n+2n)}`;
                }
                module.exports={'page.wxml':{tools:{Box,arr,change,features}}};
            "#)], &budget()).unwrap();
            let output=engine.render_batch(&batch(vec![text(
                "{{new tools.Box(7).x}}/{{tools.arr.constructor===Array}}/{{tools.change(payload)}}/{{payload.n}}/{{tools.features()}}"
            )],json!({"payload":{"n":1}})),&budget()).unwrap();
            assert_eq!(rendered_text(&output[0].ast),"7/true/2/2/5/empty/7/3");
            let fresh=engine.render_batch(&batch(vec![text("{{payload.n}}")],json!({"payload":{"n":1}})),&budget()).unwrap();
            assert_eq!(rendered_text(&fresh[0].ast),"1");
        }

        #[test]
        fn modern_mutable_intrinsics_preserve_transport_next_turns_and_scope_release() {
            let mut engine = $new;
            engine.load_modules(&[module(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../container-core/tests/support/modern_attack.js")))],&budget()).unwrap();
            let input=batch(vec![element("view",json!({"payload":"{{tools.attack()}}"}),vec![])],json!({}));
            let output=engine.render_batch(&input,&budget()).unwrap();
            assert_eq!(output[0].ast["nodes"][0]["boundValues"]["payload"],json!({"n":1,"rows":[1,2]}));
            let next=batch(vec![element("view",json!({"payload":"{{tools.read()}}"}),vec![])],json!({}));
            let output=engine.render_batch(&next,&budget()).unwrap();
            assert_eq!(output[0].ast["nodes"][0]["boundValues"]["payload"],json!({"n":2,"rows":[3,4]}));
            let flipped=engine.render_batch(&batch(vec![text("{{tools.flipDescriptors()}}")],json!({})),&budget()).unwrap();
            assert_eq!(rendered_text(&flipped[0].ast),"flipped");
            let user_string=engine.render_batch(&batch(vec![text("{{String(0)}}")],json!({})),&budget()).unwrap_err();
            assert_eq!(user_string.code,ViewEngineErrorCode::Execution);
            assert!(user_string.message.contains("poisoned transport intrinsic"));
            let invalid=ViewRenderBatch{documents:vec![],tasks:vec![task("bad","page","missing.wxml",json!({}))]};
            assert_eq!(engine.render_batch(&invalid,&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            engine.release_scopes(&["page".into()],&budget()).unwrap();
            let output=engine.render_batch(&next,&budget()).unwrap();
            assert_eq!(output[0].ast["nodes"][0]["boundValues"]["payload"],json!({"n":1,"rows":[3,4]}));
        }

        #[test]
        fn modern_native_json_transport_preserves_scalars_and_rejects_unpaired_surrogates() {
            let mut engine = $new;
            let source = concat!(
                include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../container-core/tests/support/modern_attack.js")),
                r#"
                const cleanSetPrototype = Object.setPrototypeOf;
                const tools = module.exports['page.wxml'].tools;
                tools.payload = function () { return cleanSetPrototype(['"\\\n\r\t\b\f\u0000\u001f/中文\u2028\u2029\ud83d\ude80', null, true, 1], null); };
                tools.lone = function () { return '\ud800'; };
                tools.badKey = function () { return {['\udfff']:1}; };
                tools.internal = function () { return '\ud800'.length; };
                tools.fail = function () { throw new Error('broken:\ud800'); };
                tools.hostileError = function () { throw {get message(){throw 1},get stack(){throw 2},toString(){throw 3}}; };
                "#
            );
            engine.load_modules(&[module(source)], &budget()).unwrap();
            engine.render_batch(&batch(vec![element("view", json!({"payload":"{{tools.attack()}}"}),vec![])],json!({})), &budget()).unwrap();
            let expected = "\"\\\n\r\t\u{8}\u{c}\0\u{1f}/中文\u{2028}\u{2029}🚀";
            let expression_task = |expression: &str| ViewExpressionTask {
                task_id: "encode".into(), scope_id:"page".into(), document_id:"page.wxml".into(), expression:expression.into(),
                data:json!({}), bindings:BTreeMap::from([("tools".into(),"modern:unit.mjs".into())]),
            };
            let evaluated = engine.evaluate_batch(&[expression_task("tools.payload()")], &budget()).unwrap();
            assert_eq!(evaluated[0].value, ViewValue::Array(vec![ViewValue::String(expected.into()),ViewValue::Null,ViewValue::Bool(true),ViewValue::Number(1.0)]));
            let rendered = engine.render_batch(&batch(vec![element("view",json!({"payload":"{{tools.payload()}}"}),vec![text("{{tools.payload()[0]}}")])],json!({})), &budget()).unwrap();
            assert_eq!(rendered[0].ast["nodes"][0]["boundValues"]["payload"],json!([expected,null,true,1]));
            assert_eq!(rendered_text(&rendered[0].ast),expected);
            for expression in ["tools.lone()", "tools.badKey()"] {
                let error=engine.evaluate_batch(&[expression_task(expression)], &budget()).unwrap_err();
                assert_eq!(error.code,ViewEngineErrorCode::UnsupportedValue);
                assert!(error.message.contains("UTF-16"));
            }
            for node in [text("{{tools.lone()}}"),element("view",json!({"payload":"{{tools.lone()}}"}),vec![])] {
                assert_eq!(engine.render_batch(&batch(vec![node],json!({})), &budget()).unwrap_err().code,ViewEngineErrorCode::UnsupportedValue);
            }
            assert_eq!(engine.evaluate_batch(&[expression_task("tools.internal()")], &budget()).unwrap()[0].value,ViewValue::Number(1.0));
            let error=engine.evaluate_batch(&[expression_task("tools.fail()")], &budget()).unwrap_err();
            assert_eq!(error.code,ViewEngineErrorCode::Execution);
            assert!(error.message.contains("broken:\\ud800"),"{}",error.message);
            assert_eq!(engine.evaluate_batch(&[expression_task("tools.hostileError()")], &budget()).unwrap_err().code,ViewEngineErrorCode::Execution);
            engine.release_scopes(&["page".into()],&budget()).unwrap();
            engine.load_modules(&[module("module.exports={'page.wxml':{tools:{payload(){return ['reloaded']}}}};")], &budget()).unwrap();
            assert_eq!(engine.evaluate_batch(&[expression_task("tools.payload()[0]")], &budget()).unwrap()[0].value,ViewValue::String("reloaded".into()));
            engine.reset().unwrap();
            engine.load_modules(&[module("module.exports={'page.wxml':{tools:{payload(){return ['reset']}}}};")], &budget()).unwrap();
            assert_eq!(engine.evaluate_batch(&[expression_task("tools.payload()[0]")], &budget()).unwrap()[0].value,ViewValue::String("reset".into()));
        }

        #[test]
        fn modern_lazy_loops_templates_and_includes_keep_lexical_provenance() {
            let mut engine = $new;
            engine.load_modules(&[module(r#"
                let n=0;const tools={next(label){return label+':'+(++n)},forever(){while(true){}}};
                module.exports={'page.wxml':{tools},'shared/row.wxml':{tools}};
            "#)],&budget()).unwrap();
            let documents=vec![
                document("page.wxml",vec![
                    element("text",json!({"wx:if":"{{false}}"}),vec![text("{{tools.forever()}}")]),
                    element("text",json!({"wx:else":""}),vec![text("{{tools.next('start')}};")]),
                    element("import",json!({"src":"shared/row.wxml"}),vec![]),
                    element("template",json!({"is":"row","wx:for":"{{rows}}","wx:for-item":"row","wx:key":"id","wx:if":"{{row.visible}}","data":"{{...row}}"}),vec![]),
                ]),
                document("shared/row.wxml",vec![element("template",json!({"name":"row"}),vec![
                    element("view",json!({"data-object":"{{({id,label})}}"}),vec![text("{{tools.next(label)}};")]),
                ])]),
            ];
            let output=engine.render_batch(&ViewRenderBatch{documents,tasks:vec![task("render","page","page.wxml",json!({"rows":[
                {"id":"a","label":"A","visible":true},{"id":"b","label":"B","visible":false},{"id":"c","label":"C","visible":true}
            ]}))]},&budget()).unwrap();
            assert_eq!(rendered_text(&output[0].ast),"start:1;A:2;C:3;");
            let nodes=output[0].ast["nodes"].as_array().unwrap();
            assert_eq!(nodes[1]["lexicalOrigin"]["documentId"],"page.wxml");
            assert_eq!(nodes[1]["children"][0]["lexicalOrigin"]["documentId"],"shared/row.wxml");
            assert_eq!(nodes[1]["children"][0]["boundValues"]["data-object"],json!({"id":"a","label":"A"}));
        }

        #[test]
        fn modern_occurrences_share_unit_namespaces_and_release_independently() {
            let mut engine = $new;
            engine.load_modules(&[module("let n=0;const tools={next(){return ++n}};module.exports={'page.wxml':{tools,other:tools}};")],&budget()).unwrap();
            let mut doc=document("page.wxml",vec![text("{{tools===other}}/{{tools.next()}}/{{other.next()}}")]);
            doc.bindings.insert("other".into(),"modern:unit.mjs".into());
            let mut input=ViewRenderBatch{documents:vec![doc],tasks:vec![task("a","first","page.wxml",json!({})),task("b","second","page.wxml",json!({}))]};
            let result=engine.render_batch(&input,&budget()).unwrap();
            assert_eq!(rendered_text(&result[0].ast),"true/1/2");
            assert_eq!(rendered_text(&result[1].ast),"true/1/2");
            engine.release_scopes(&["first".into()],&budget()).unwrap();
            let result=engine.render_batch(&input,&budget()).unwrap();
            assert_eq!(rendered_text(&result[0].ast),"true/1/2");
            assert_eq!(rendered_text(&result[1].ast),"true/3/4");
            input.tasks[0].scope_id="second".into();
            input.tasks.truncate(1);
            let result=engine.render_batch(&input,&budget()).unwrap();
            assert_eq!(rendered_text(&result[0].ast),"true/5/6");
        }

        #[test]
        fn modern_opaque_async_cyclic_and_bigint_sinks_fail_explicitly() {
            for source in ["Promise.resolve(1)","new Map()","1n","(()=>{const x={};x.self=x;return x})()","({then(){}})"] {
                let mut engine = $new;
                let source=format!("module.exports={{'page.wxml':{{tools:{{value(){{return {source}}}}}}}}};");
                engine.load_modules(&[module(&source)],&budget()).unwrap();
                let error=engine.render_batch(&batch(vec![element("view",json!({"payload":"{{tools.value()}}"}),vec![])],json!({})),&budget()).unwrap_err();
                assert_eq!(error.code,ViewEngineErrorCode::UnsupportedValue);
            }
        }

        #[test]
        fn modern_invalid_batches_execute_no_prior_stateful_task() {
            let mut engine = $new;
            engine.load_modules(&[module("let n=0;module.exports={'page.wxml':{tools:{next(){return ++n}}}};")],&budget()).unwrap();
            let mut input=batch(vec![text("{{tools.next()}}")],json!({}));
            input.tasks.push(task("bad","page","missing.wxml",json!({})));
            assert_eq!(engine.render_batch(&input,&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            input.tasks.pop();
            assert_eq!(rendered_text(&engine.render_batch(&input,&budget()).unwrap()[0].ast),"1");
            let invalid=ViewModuleSource{id:"wxs:legacy.wxs".into(),source:"".into(),dependencies:vec![],compilation:None};
            assert_eq!(engine.load_modules(&[invalid],&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            assert_eq!(rendered_text(&engine.render_batch(&input,&budget()).unwrap()[0].ast),"2");
        }

        #[test]
        fn modern_timeout_disposes_only_its_realm_and_reset_preserves_profile() {
            let mut engine = $new;
            engine.load_modules(&[module("module.exports={'page.wxml':{tools:{run(){while(true){}}}}};")],&budget()).unwrap();
            assert_eq!(engine.render_batch(&batch(vec![text("{{tools.run()}}")],json!({})),&ViewExecutionBudget::new(std::time::Duration::from_millis(10))).unwrap_err().code,ViewEngineErrorCode::Timeout);
            assert_eq!(engine.load_modules(&[],&budget()).unwrap_err().code,ViewEngineErrorCode::RequiresReset);
            engine.reset().unwrap();
            engine.load_modules(&[],&budget()).unwrap();
            let task=ViewExpressionTask{task_id:"fresh".into(),scope_id:"page".into(),document_id:"page.wxml".into(),expression:"[].constructor===Array && !Object.isFrozen(Array.prototype)".into(),data:json!({}),bindings:BTreeMap::new()};
            let result=engine.evaluate_batch(&[task],&budget()).unwrap();
            assert_eq!(result[0].value,ViewValue::Bool(true));
        }
    }
}
