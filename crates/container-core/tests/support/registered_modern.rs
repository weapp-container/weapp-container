macro_rules! registered_modern_safety_tests {
    ($new:expr) => {
        use container_core::{ViewEngine,ViewModuleSource,ViewRenderDocument,ViewDocumentProgram,ViewRenderTask,ViewExecutionBudget,ViewEngineErrorCode};
        use serde_json::json;
        use std::{collections::BTreeMap,time::Duration};
        fn budget()->ViewExecutionBudget {ViewExecutionBudget::new(Duration::from_secs(2))}
        fn module(source:&str)->ViewModuleSource {
            ViewModuleSource{id:"modern:unit.mjs".into(),source:source.into(),dependencies:vec![],compilation:None}
        }
        fn document(expression:&str)->ViewRenderDocument {
            ViewRenderDocument { document_id:"page.wxml".into(),bindings:BTreeMap::from([("tools".into(),"modern:unit.mjs".into())]),compilation:None,
                ast:json!({"version":1,"nodes":[{"kind":"element","tag":"view","attrs":{"payload":expression},"children":[],"bindings":[]}]}) }
        }
        fn tasks(attack:bool)->Vec<ViewRenderTask> {vec![ViewRenderTask {task_id:"r".into(),scope_id:"s".into(),document_id:"page.wxml".into(),data:json!({"attack":attack})}]}
        #[test]
        fn registered_modern_prototype_mutation_cannot_corrupt_cache_registration_error_or_release() {
            let mut engine=$new;
            let source=include_str!(concat!(env!("CARGO_MANIFEST_DIR"),"/../container-core/tests/support/modern_attack.js"));
            let source=format!("{source}\nlet formatCalls=0; let formatReason=''; let storedPrepare; let storedLimit; const readDescriptor=Object.getOwnPropertyDescriptor; module.exports['page.wxml'].tools.installErrorHook=function(){{storedPrepare=function(error){{formatCalls++;formatReason=error.message;return 'must not execute'}};storedLimit=function(){{formatCalls++;formatReason='stackTraceLimit getter';return 10}};Error.prepareStackTrace=storedPrepare;define(Error,'stackTraceLimit',trustedSetPrototype({{get:storedLimit,configurable:true}},null));return 0}};module.exports['page.wxml'].tools.formatCalls=function(){{return formatCalls}};module.exports['page.wxml'].tools.formatReason=function(){{return formatReason}};module.exports['page.wxml'].tools.restoreCheck=function(){{return Error.prepareStackTrace===storedPrepare && readDescriptor(Error,'stackTraceLimit').get===storedLimit}};module.exports['page.wxml'].tools.fireError=function(){{define(Error,'stackTraceLimit',trustedSetPrototype({{value:10,writable:true,configurable:true}},null));var e=new Error('guest-visible-error');void e.stack;return formatCalls}};");
            engine.load_modules(&[module(&source)],&budget()).unwrap();
            let handle=engine.register_documents(&ViewDocumentProgram::new(vec![document("{{attack ? tools.attack() : tools.read()}}")]),&budget()).unwrap();
            for (attack,expected) in [(true,1),(false,2),(false,3)] {
                let result=engine.render_registered_batch(&handle,&tasks(attack),&budget()).unwrap();
                assert_eq!(result[0].ast["nodes"][0]["boundValues"]["payload"]["n"],expected);
            }
            let hook=engine.register_documents(&ViewDocumentProgram::new(vec![document("{{attack ? tools.installErrorHook() : 0}}/{{tools.formatCalls()}}/{{tools.formatReason()}}")]),&budget()).unwrap();
            assert_eq!(engine.render_registered_batch(&hook,&tasks(true),&budget()).unwrap()[0].ast["nodes"][0]["attrs"]["payload"],"0/0/");
            let invalid=engine.register_documents(&ViewDocumentProgram::new(vec![document("{{)}}")]),&budget()).unwrap_err();
            assert!(invalid.is_document_program_rejection());
            assert_eq!(engine.render_registered_batch(&hook,&tasks(false),&budget()).unwrap()[0].ast["nodes"][0]["attrs"]["payload"],"0/0/","static rejection must never read stack or run app prepareStackTrace");
            let proof=engine.register_documents(&ViewDocumentProgram::new(vec![document("{{tools.restoreCheck()}}/{{tools.fireError()}}")]),&budget()).unwrap();
            assert_eq!(engine.render_registered_batch(&proof,&tasks(false),&budget()).unwrap()[0].ast["nodes"][0]["attrs"]["payload"],"true/1","context-only guard must restore app hooks and exact public descriptors");
            let next=engine.register_documents(&ViewDocumentProgram::new(vec![document("{{tools.read()}}")]),&budget()).unwrap();
            assert_eq!(engine.render_registered_batch(&next,&tasks(false),&budget()).unwrap()[0].ast["nodes"][0]["boundValues"]["payload"]["n"],4);
            assert_eq!(engine.render_registered_batch(&handle,&tasks(false),&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            engine.release_scopes(&["s".into()],&budget()).unwrap();
            assert_eq!(engine.render_registered_batch(&next,&tasks(false),&budget()).unwrap()[0].ast["nodes"][0]["boundValues"]["payload"]["n"],1,"release resets occurrence caches, not the static program");
            engine.reset().unwrap();
            assert_eq!(engine.render_registered_batch(&next,&tasks(false),&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
        }
        #[test]
        fn registered_modern_nonconfigurable_error_properties_and_missing_ast_getters_are_not_invoked() {
            let mut engine=$new;
            engine.load_modules(&[module(r#"
                let calls=0;const define=Object.defineProperty;const nullProto=Object.setPrototypeOf;
                const hook=()=>{calls++;return 'app stack hook'};
                function install(){
                    Error.prepareStackTrace=hook;
                    define(Error,'prepareStackTrace',nullProto({get(){calls++;return hook},configurable:false},null));
                    define(Error,'stackTraceLimit',nullProto({get(){calls++;return 10},configurable:false},null));
                    const names=['children','attributes','attrs','bindings','compiled','imports','boundValues','directives','programId'];
                    for(let i=0;i<names.length;i++)define(Object.prototype,names[i],nullProto({get(){calls++;throw new Error('inherited static getter')},configurable:true},null));
                    return 0;
                }
                module.exports={'page.wxml':{tools:{install,read(){return calls}}}};
            "#)],&budget()).unwrap();
            let old=engine.register_documents(&ViewDocumentProgram::new(vec![document("{{attack ? tools.install() : tools.read()}}")]),&budget()).unwrap();
            assert_eq!(engine.render_registered_batch(&old,&tasks(true),&budget()).unwrap()[0].ast["nodes"][0]["boundValues"]["payload"],0);
            let rejected=engine.register_documents(&ViewDocumentProgram::new(vec![document("{{)}}")]),&budget()).unwrap_err();
            assert!(rejected.is_document_program_rejection());
            assert_eq!(engine.render_registered_batch(&old,&tasks(false),&budget()).unwrap()[0].ast["nodes"][0]["boundValues"]["payload"],0);
            let next=engine.register_documents(&ViewDocumentProgram::new(vec![document("{{tools.read()+1}}")]),&budget()).unwrap();
            assert_eq!(engine.render_registered_batch(&next,&tasks(false),&budget()).unwrap()[0].ast["nodes"][0]["boundValues"]["payload"],1,"missing AST fields must never consult Object.prototype");
        }
    }
}
