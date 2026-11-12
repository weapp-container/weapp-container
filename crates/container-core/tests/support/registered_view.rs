// Shared by both actually linked engines and both execution profiles.
// These are container contracts, not official WXS or device/performance proof.
macro_rules! registered_view_contract_tests {
    ($new:expr, $modern:expr) => {
        use container_core::{ViewEngine, ViewEngineErrorCode, ViewExecutionBudget, ViewModuleSource,
            ViewDocumentProgram, ViewRenderBatch, ViewRenderDocument, ViewRenderTask};
        use serde_json::{json,Value};
        use std::{collections::BTreeMap,sync::atomic::Ordering,time::Duration};

        fn budget() -> ViewExecutionBudget { ViewExecutionBudget::new(Duration::from_secs(2)) }
        fn modules() -> Vec<ViewModuleSource> {
            vec![ViewModuleSource {
                id: if $modern {"modern:unit.mjs"} else {"wxs:counter.wxs"}.into(),
                source: if $modern {
                    "var n=0;var api={next:function(){return ++n},touch:function(v){v.x++;return v.x},read:function(v){return v.x}};module.exports={'page.wxml':{tools:api},'shared.wxml':{tools:api}}"
                } else {"var n=0;exports.next=function(){return ++n};exports.touch=function(v){v.x++;return v.x};exports.read=function(v){return v.x}"}.into(),
                dependencies:vec![],compilation:None,
            }]
        }
        fn document(source:&str) -> ViewRenderDocument {
            ViewRenderDocument {
                document_id:"page.wxml".into(), ast:json!({"version":1,"nodes":[
                    {"kind":"comment","value":"immutable static bytes ".repeat(256)},
                    {"kind":"text","value":source,"bindings":[]}
                ]}),
                bindings:BTreeMap::from([("tools".into(),if $modern {"modern:unit.mjs"} else {"wxs:counter.wxs"}.into())]),
                compilation:None,
            }
        }
        fn tasks(data:Value) -> Vec<ViewRenderTask> {
            vec![ViewRenderTask {task_id:"render".into(),scope_id:"scope".into(),document_id:"page.wxml".into(),data}]
        }
        fn text(results:&[container_core::ViewRenderResult]) -> &str {
            results[0].ast["nodes"][1]["value"].as_str().unwrap()
        }
        #[test]
        fn registered_static_program_crosses_once_dynamic_batches_stay_stateful() {
            let mut engine=$new; engine.load_modules(&modules(),&budget()).unwrap();
            let mut original=document("{{tools.next()}}/{{value}}");
            let program=ViewDocumentProgram::new(vec![original.clone()]);
            let handle=engine.register_documents(&program,&budget()).unwrap();
            let registration=engine.last_timings().unwrap();
            assert_eq!(registration.document_registrations,1);
            assert_eq!(registration.registered_render_batches,0);
            original.ast["nodes"][1]["value"]=json!("caller changed its separate original");
            for (value,expected) in [("A","1/A"),("B","2/B"),("A","3/A")] {
                let output=engine.render_registered_batch(&handle,&tasks(json!({"value":value})),&budget()).unwrap();
                assert_eq!(text(&output),expected);
                let warm=engine.last_timings().unwrap();
                assert_eq!(warm.document_registrations,0);
                assert_eq!(warm.registered_render_batches,1);
                assert!(warm.input_bytes*10<registration.input_bytes,"warm tasks must not transport the static AST");
            }
            let output=engine.render_batch(&ViewRenderBatch{documents:program.documents().to_vec(),tasks:tasks(json!({"value":"C"}))},&budget()).unwrap();
            assert_eq!(text(&output),"4/C","compatibility entrypoint has the same occurrence cache");
            let output=engine.render_registered_batch(&handle,&tasks(json!({"value":"D"})),&budget()).unwrap();
            assert_eq!(text(&output),"5/D");
        }
        #[test]
        fn registered_candidate_failure_is_atomic_and_valid_replacement_retires_old_handle() {
            let mut engine=$new;engine.load_modules(&modules(),&budget()).unwrap();
            let handle=engine.register_documents(&ViewDocumentProgram::new(vec![document("{{tools.next()}}")]),&budget()).unwrap();
            assert_eq!(text(&engine.render_registered_batch(&handle,&tasks(json!({})),&budget()).unwrap()),"1");
            let broken=ViewDocumentProgram::new(vec![document("{{)}}")]);
            assert!(engine.register_documents(&broken,&budget()).unwrap_err().is_document_program_rejection());
            assert_eq!(text(&engine.render_registered_batch(&handle,&tasks(json!({})),&budget()).unwrap()),"2");
            let replacement=engine.register_documents(&ViewDocumentProgram::new(vec![document("{{tools.next()}}/new")]),&budget()).unwrap();
            assert_eq!(engine.render_registered_batch(&handle,&tasks(json!({})),&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            assert_eq!(text(&engine.render_registered_batch(&replacement,&tasks(json!({})),&budget()).unwrap()),"3/new");
        }
        #[test]
        fn registered_capability_is_bound_to_provider_realm_module_epoch_reset_and_dispose() {
            let mut engine=$new;let mut other=$new;
            engine.load_modules(&modules(),&budget()).unwrap();other.load_modules(&modules(),&budget()).unwrap();
            let p=ViewDocumentProgram::new(vec![document("{{tools.next()}}")]);
            let h=engine.register_documents(&p,&budget()).unwrap();let other_h=other.register_documents(&p,&budget()).unwrap();
            assert_eq!(other.render_registered_batch(&h,&tasks(json!({})),&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            assert_eq!(engine.render_registered_batch(&other_h,&tasks(json!({})),&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            assert!(other.last_timings().is_none(),"foreign handle must be rejected before VM work");
            engine.load_modules(&modules(),&budget()).unwrap();
            assert_eq!(engine.render_registered_batch(&h,&tasks(json!({})),&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            let h=engine.register_documents(&p,&budget()).unwrap();engine.reset().unwrap();
            assert_eq!(engine.render_registered_batch(&h,&tasks(json!({})),&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            assert!(engine.last_timings().is_none(),"reset must reject the old realm capability before VM entry");
            engine.load_modules(&modules(),&budget()).unwrap();let h=engine.register_documents(&p,&budget()).unwrap();engine.dispose();
            assert_eq!(engine.render_registered_batch(&h,&tasks(json!({})),&budget()).unwrap_err().code,ViewEngineErrorCode::RequiresReset);
        }
        #[test]
        fn registered_dynamic_validation_precedes_all_stateful_calls_and_empty_tasks_do_not_initialize() {
            let mut engine=$new;engine.load_modules(&modules(),&budget()).unwrap();
            let h=engine.register_documents(&ViewDocumentProgram::new(vec![document("{{tools.next()}}")]),&budget()).unwrap();
            assert!(engine.render_registered_batch(&h,&[],&budget()).unwrap().is_empty());
            let mut bad=tasks(json!({}));bad.push(bad[0].clone());
            assert_eq!(engine.render_registered_batch(&h,&bad,&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            let mut bad=tasks(json!({}));bad[0].document_id="undeclared.wxml".into();
            assert_eq!(engine.render_registered_batch(&h,&bad,&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            assert_eq!(text(&engine.render_registered_batch(&h,&tasks(json!({})),&budget()).unwrap()),"1");
        }
        #[test]
        fn registered_cancel_and_zero_deadline_poison_only_view_and_never_revive_old_handles() {
            let mut engine=$new;engine.load_modules(&modules(),&budget()).unwrap();
            let p=ViewDocumentProgram::new(vec![document("{{tools.next()}}")]);
            let h=engine.register_documents(&p,&budget()).unwrap();
            let cancel=budget();cancel.cancellation.store(true,Ordering::Release);
            assert_eq!(engine.render_registered_batch(&h,&tasks(json!({})),&cancel).unwrap_err().code,ViewEngineErrorCode::Cancelled);
            assert_eq!(engine.render_registered_batch(&h,&tasks(json!({})),&budget()).unwrap_err().code,ViewEngineErrorCode::RequiresReset);
            engine.reset().unwrap();engine.load_modules(&modules(),&budget()).unwrap();let h=engine.register_documents(&p,&budget()).unwrap();
            let zero=ViewExecutionBudget::new(Duration::ZERO);
            assert_eq!(engine.render_registered_batch(&h,&tasks(json!({})),&zero).unwrap_err().code,ViewEngineErrorCode::Timeout);
            assert_eq!(engine.register_documents(&p,&budget()).unwrap_err().code,ViewEngineErrorCode::RequiresReset);
        }
        #[test]
        fn registered_failed_module_load_preserves_handle_and_compiled_empty_never_falls_back() {
            let mut engine=$new;engine.load_modules(&modules(),&budget()).unwrap();
            let program=ViewDocumentProgram::new(vec![document("{{tools.next()}}")]);let handle=engine.register_documents(&program,&budget()).unwrap();
            assert_eq!(text(&engine.render_registered_batch(&handle,&tasks(json!({})),&budget()).unwrap()),"1");
            let mut bad_modules=modules();bad_modules[0].source="exports.value=)".into();
            assert!(engine.load_modules(&bad_modules,&budget()).is_err());
            let mut compiled_empty=document("{{tools.next()}}");compiled_empty.compilation=Some(Vec::new());
            let error=engine.register_documents(&ViewDocumentProgram::new(vec![compiled_empty]),&budget()).unwrap_err();
            assert!(error.is_document_program_rejection());
            assert_eq!(error.code,ViewEngineErrorCode::InvalidBatch);
            assert_eq!(text(&engine.render_registered_batch(&handle,&tasks(json!({})),&budget()).unwrap()),"2");
        }
        #[test]
        fn registered_profile_preserves_argument_copy_or_same_batch_snapshot_without_extra_calls() {
            let mut engine=$new;engine.load_modules(&modules(),&budget()).unwrap();
            let h=engine.register_documents(&ViewDocumentProgram::new(vec![document("{{tools.touch(row)}}/{{tools.read(row)}}")]),&budget()).unwrap();
            let data=json!({"row":{"x":1}});
            for _ in 0..3 {
                let output=engine.render_registered_batch(&h,&tasks(data.clone()),&budget()).unwrap();
                assert_eq!(text(&output),if $modern {"2/2"} else {"2/1"});
                assert_eq!(data["row"]["x"],1,"AppService input is never mutated");
            }
        }
        #[test]
        fn registered_templates_imports_and_loop_order_keep_static_registry_and_scope_state() {
            let mut engine=$new;engine.load_modules(&modules(),&budget()).unwrap();
            let element=|tag:&str,attrs:Value,children:Vec<Value>| json!({"kind":"element","tag":tag,"attrs":attrs,"children":children,"bindings":[]});
            let mut page=document("unused");
            page.ast["nodes"]=json!([
                element("import",json!({"src":"./shared.wxml"}),vec![]),
                element("template",json!({"is":"row","wx:for":"{{rows}}"}),vec![]),
                {"kind":"text","value":"{{tools.next()}}","bindings":[]}
            ]);
            let mut shared=document("unused");shared.document_id="shared.wxml".into();
            shared.ast["nodes"]=json!([element("template",json!({"name":"row"}),vec![json!({"kind":"text","value":"{{tools.next()}}/","bindings":[]})])]);
            let h=engine.register_documents(&ViewDocumentProgram::new(vec![page,shared]),&budget()).unwrap();
            fn collect(nodes:&Value,out:&mut String) {
                for node in nodes.as_array().unwrap() {
                    if node["kind"]=="text" {out.push_str(node["value"].as_str().unwrap())}
                    else if node["kind"]=="element" {collect(&node["children"],out)}
                }
            }
            for expected in ["1/2/3","4/5/6","7/8/9"] {
                let output=engine.render_registered_batch(&h,&tasks(json!({"rows":[{},{}]})),&budget()).unwrap();
                let mut result=String::new();collect(&output[0].ast["nodes"],&mut result);assert_eq!(result,expected);
            }
        }
        #[test]
        fn registered_static_graph_and_size_are_validated_before_replacing_accepted_program() {
            let mut engine=$new;engine.load_modules(&modules(),&budget()).unwrap();
            let p=ViewDocumentProgram::new(vec![document("{{tools.next()}}")]);let h=engine.register_documents(&p,&budget()).unwrap();
            let mut bad=document("x");bad.ast["nodes"]=json!([{"kind":"element","tag":"include","attrs":{"src":"./missing.wxml"},"bindings":[],"children":[]}]);
            assert_eq!(engine.register_documents(&ViewDocumentProgram::new(vec![bad]),&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            let huge=ViewDocumentProgram::new(vec![document(&"x".repeat(container_core::MAX_VIEW_DOCUMENT_PROGRAM_BYTES))]);
            assert_eq!(engine.register_documents(&huge,&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            assert_eq!(text(&engine.render_registered_batch(&h,&tasks(json!({})),&budget()).unwrap()),"1");
        }
    }
}
