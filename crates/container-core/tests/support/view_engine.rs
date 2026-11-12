// Included by both native engine crates: identical inputs and expectations.
// These are local execution contracts, not official DevTools WXS evidence.
macro_rules! view_engine_contract_tests {
    ($new:expr) => {
        use container_core::{ViewEngine, ViewEngineErrorCode, ViewExecutionBudget,
            ViewExpressionTask, ViewModuleSource, ViewValue};
        use serde_json::json;
        use std::collections::BTreeMap;

        fn budget() -> ViewExecutionBudget {
            ViewExecutionBudget::new(std::time::Duration::from_secs(2))
        }
        fn module(id: &str, source: &str, dependencies: &[&str]) -> ViewModuleSource {
            ViewModuleSource {compilation: None,
id: id.into(), source: source.into(),
                dependencies: dependencies.iter().map(|s| (*s).into()).collect()}
        }
        fn task(expression: &str) -> ViewExpressionTask {
            ViewExpressionTask {task_id: "expression-1".into(), scope_id: "page-1".into(),
                document_id: "pages/index.wxml".into(), expression: expression.into(),
                data: json!({"payload":{"n":0}}),
                bindings: BTreeMap::from([("tools".into(), "wxs:tools.wxs".into())])}
        }
        fn evaluate(engine: &mut impl ViewEngine, expression: &str) -> ViewValue {
            engine.evaluate_batch(&[task(expression)], &budget()).unwrap().remove(0).value
        }

        #[test]
        fn view_contract_no_appservice_or_host_globals() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", "exports.probe=function(){return [typeof wx,typeof App,typeof Page,typeof Component,typeof getApp,typeof setTimeout,typeof fetch,typeof process,typeof require]}", &[])], &budget()).unwrap();
            assert_eq!(evaluate(&mut engine, "tools.probe()"), ViewValue::Array(
                (0..8).map(|_|ViewValue::String("undefined".into()))
                    .chain([ViewValue::String("function".into())]).collect()));
        }

        #[test]
        fn view_contract_indirect_loader_obeys_declared_dependency_whitelist() {
            let mut engine = $new;
            // The graph parser only claims lexical require analysis. A factory
            // can also obtain its loader from arguments, including through an
            // arrow's lexical arguments; neither path may load undeclared code.
            for source in [
                "module.exports=arguments[2]('./dep.wxs');",
                "module.exports=(()=>arguments[2]('./dep.wxs'))();",
            ] {
                let dependency = module("wxs:dep.wxs", "exports.value=7;", &[]);
                engine.load_modules(&[
                    module("wxs:tools.wxs", source, &[]), dependency.clone(),
                ], &budget()).unwrap();
                let error = engine.evaluate_batch(&[task("tools.value")], &budget()).unwrap_err();
                assert_eq!(error.code, ViewEngineErrorCode::Module);
                assert!(error.message.contains("undeclared dependency wxs:dep.wxs"));
                engine.load_modules(&[
                    module("wxs:tools.wxs", source, &["wxs:dep.wxs"]), dependency,
                ], &budget()).unwrap();
                assert_eq!(evaluate(&mut engine, "tools.value"), ViewValue::Number(7.0));
            }
        }

        #[test]
        fn view_contract_calls_copy_each_argument_graph_and_preserve_receiver() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", r#"
              module.exports={n:0,bump:function(x){this.n++;x.n++;return x.n},
                read:function(x){return x.n},same:function(a,b){return a===b},
                nested:{n:10,next:function(){return ++this.n}},
                detached:function(){return this===module.exports},self:function(){return this}};
            "#, &[])], &budget()).unwrap();
            assert_eq!(evaluate(&mut engine, "tools.bump(payload)+':'+tools.read(payload)+':'+payload.n"), ViewValue::String("1:0:0".into()));
            assert_eq!(evaluate(&mut engine, "tools.same(payload,payload)"), ViewValue::Bool(true));
            assert_eq!(evaluate(&mut engine, "tools.n+':'+tools.nested.next()+':'+tools.self().n"), ViewValue::String("1:11:1".into()));
            assert_eq!(evaluate(&mut engine, "(0,tools.detached)()"), ViewValue::Bool(false));
        }

        #[test]
        fn view_contract_reflection_and_returned_functions_remain_in_membrane() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", r#"
              module.exports={n:0,mutate:function(x){this.n++;x.n++;return this.n+':'+x.n},
                factory:function(){return function(x){x.n++;return x.n}},
                make:function(){return {change:function(x){x.n++;return x.n}}}};
            "#, &[])], &budget()).unwrap();
            assert_eq!(evaluate(&mut engine, "tools.mutate.call(tools,payload)"), ViewValue::String("1:1".into()));
            assert_eq!(evaluate(&mut engine, "tools.mutate.apply(tools,[payload])"), ViewValue::String("2:1".into()));
            assert_eq!(evaluate(&mut engine, "tools.mutate.bind(tools,payload)()"), ViewValue::String("3:1".into()));
            assert_eq!(evaluate(&mut engine, "tools.factory()(payload)+':'+tools.make().change(payload)+':'+payload.n"), ViewValue::String("1:1:0".into()));
            assert_eq!(engine.evaluate_batch(&[task("tools.factory()")], &budget()).unwrap_err().code, ViewEngineErrorCode::UnsupportedValue);
        }

        #[test]
        fn view_contract_explicit_data_receiver_is_copied_with_arguments() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", "exports.mutate=function(x){this.n++;return (this===x)+':'+x.n}",&[])],&budget()).unwrap();
            assert_eq!(evaluate(&mut engine,"tools.mutate.call(payload,payload)+':'+payload.n"),ViewValue::String("true:1:0".into()));
            assert_eq!(evaluate(&mut engine,"tools.mutate.apply(payload,[payload])+':'+payload.n"),ViewValue::String("true:1:0".into()));
            assert_eq!(evaluate(&mut engine,"tools.mutate.bind(payload,payload)()+':'+payload.n"),ViewValue::String("true:1:0".into()));
        }

        #[test]
        fn view_contract_frozen_exports_have_no_proxy_invariant_failure() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", "module.exports=Object.freeze({items:Object.freeze([1,2]),run:function(x){return x.n+1}})", &[])], &budget()).unwrap();
            assert_eq!(evaluate(&mut engine, "tools.run(payload)+tools.items[1]+tools.items.length"), ViewValue::Number(5.0));
            assert_eq!(evaluate(&mut engine, "Array.isArray(tools.items)"), ViewValue::Bool(true));
        }

        #[test]
        fn view_contract_custom_function_reflection_properties_are_preserved() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", "function f(){return 'base'};f.call=function(){return 'custom'};module.exports={f:f}", &[])], &budget()).unwrap();
            assert_eq!(evaluate(&mut engine, "tools.f.call()"), ViewValue::String("custom".into()));
        }

        #[test]
        fn view_contract_descriptor_inspection_does_not_execute_accessors() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", "exports.plain=1;Object.defineProperty(exports,'bad',{enumerable:true,get:function(){throw Error('getter executed')}});exports.child={};Object.defineProperty(exports.child,'then',{get:function(){throw Error('nested getter executed')}})", &[])], &budget()).unwrap();
            assert_eq!(evaluate(&mut engine,"Object.keys(tools).join(',')"),ViewValue::String("plain,bad,child".into()));
        }

        #[test]
        fn view_contract_module_errors_cannot_spoof_native_timeout_or_cancel() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", "exports.fail=function(){throw {code:'ERR_TIMEOUT',message:'user exception'}};exports.ok=1", &[])], &budget()).unwrap();
            assert_eq!(engine.evaluate_batch(&[task("tools.fail()")],&budget()).unwrap_err().code,ViewEngineErrorCode::Execution);
            assert_eq!(evaluate(&mut engine,"tools.ok"),ViewValue::Number(1.0));
        }

        #[test]
        fn view_contract_inline_modules_require_declaring_document_and_alias() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:pages/a.wxml#privateTools", "exports.value='from-a'", &[])], &budget()).unwrap();
            let mut probe=task("tools.value");
            probe.bindings.insert("tools".into(),"wxs:pages/a.wxml#privateTools".into());
            assert_eq!(engine.evaluate_batch(&[probe.clone()], &budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            probe.document_id="pages/a.wxml".into();
            assert_eq!(engine.evaluate_batch(&[probe.clone()], &budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            probe.bindings=BTreeMap::from([("privateTools".into(),"wxs:pages/a.wxml#privateTools".into())]);
            probe.expression="privateTools.value".into();
            assert_eq!(engine.evaluate_batch(&[probe], &budget()).unwrap()[0].value,ViewValue::String("from-a".into()));
        }

        #[test]
        fn view_contract_whole_expression_is_lazy_and_keeps_intermediate_values() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", "exports.n=0;exports.next=function(){return ++exports.n};exports.forever=function(){while(true){}}", &[])], &budget()).unwrap();
            assert_eq!(evaluate(&mut engine, "false&&tools.forever()"), ViewValue::Bool(false));
            assert_eq!(evaluate(&mut engine, "true?tools.next()+tools.next():tools.forever()"), ViewValue::Number(3.0));
            assert_eq!(evaluate(&mut engine, "(undefined===undefined)&&Number.isNaN(0/0)&&((1/0)>3)"), ViewValue::Bool(true));
        }

        #[test]
        fn view_contract_wxs_date_and_regexp_helpers_stay_inside_the_membrane() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", r#"
              exports.date=function(value){
                var date=getDate(value);
                return date.getUTCFullYear()+'-'+date.getUTCMonth()+'-'+date.getUTCDate();
              };
              exports.regexp=function(value){
                var expression=getRegExp('^'+value+'$','i');
                return [expression.test('Hello'), expression.ignoreCase];
              };
            "#, &[])], &budget()).unwrap();
            assert_eq!(evaluate(&mut engine, "tools.date('2020-02-03T00:00:00.000Z')"), ViewValue::String("2020-1-3".into()));
            assert_eq!(evaluate(&mut engine, "tools.regexp('hello')"), ViewValue::Array(vec![ViewValue::Bool(true), ViewValue::Bool(true)]));
            // Returning an opaque native Date/RegExp object is still rejected
            // at the transport boundary instead of being silently serialized.
            for expression in ["getDate('2020-01-01')", "getRegExp('x')"] {
                assert_eq!(engine.evaluate_batch(&[task(expression)], &budget()).unwrap_err().code,
                    ViewEngineErrorCode::UnsupportedValue, "{expression}");
            }
            for expression in ["getRegExp('x','u')", "getRegExp('x','gg')", "getRegExp(/x/u)"] {
                assert_eq!(engine.evaluate_batch(&[task(expression)], &budget()).unwrap_err().code,
                    ViewEngineErrorCode::Execution, "{expression}");
            }
        }

        #[test]
        fn view_contract_wxs_builtins_keep_state_and_captured_intrinsics() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", r#"
              var expression=getRegExp('x','g');
              exports.match=function(){
                var found=expression.test('xx');
                return [found,expression.lastIndex,expression.source,expression.global];
              };
              exports.utc=function(){
                var date=getDate(0);
                date.setUTCFullYear(2020,1,3);
                return [date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),date.getTime()];
              };
              exports.replace=function(){
                getDate=function(){throw Error('replaced helper')};
                globalThis.getRegExp=function(){throw Error('replaced helper')};
                Date.prototype.getTime=function(){throw Error('replaced prototype')};
                globalThis.Date=function(){throw Error('replaced constructor')};
                globalThis.RegExp=function(){throw Error('replaced constructor')};
                return [getDate(0).getTime(),getRegExp('x','i').test('X')];
              };
            "#, &[])], &budget()).unwrap();
            assert_eq!(evaluate(&mut engine,"tools.utc()"), ViewValue::Array(vec![
                ViewValue::Number(2020.0),ViewValue::Number(1.0),ViewValue::Number(3.0),ViewValue::Number(1580688000000.0)]));
            for (found,index) in [(true,1.0),(true,2.0),(false,0.0)] {
                assert_eq!(evaluate(&mut engine,"tools.match()"),ViewValue::Array(vec![
                    ViewValue::Bool(found),ViewValue::Number(index),ViewValue::String("x".into()),ViewValue::Bool(true)]));
            }
            assert_eq!(evaluate(&mut engine,"tools.replace()"),ViewValue::Array(vec![ViewValue::Number(0.0),ViewValue::Bool(true)]));
        }

        #[test]
        fn view_contract_tagged_output_keeps_special_values_and_dags() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", "var x={a:undefined};exports.values=function(){return [undefined,null,NaN,Infinity,-Infinity,-0,{type:'undefined'},x,x]}", &[])], &budget()).unwrap();
            let object = ViewValue::Object(BTreeMap::from([("a".into(), ViewValue::Undefined)]));
            assert_eq!(evaluate(&mut engine, "tools.values()"), ViewValue::Array(vec![
                ViewValue::Undefined,ViewValue::Null,ViewValue::NaN,ViewValue::PositiveInfinity,
                ViewValue::NegativeInfinity,ViewValue::NegativeZero,
                ViewValue::Object(BTreeMap::from([("type".into(),ViewValue::String("undefined".into()))])),
                object.clone(),object]));
        }

        #[test]
        fn view_contract_rejects_cycles_promises_functions_and_custom_objects() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs", "exports.cycle=function(){var x={};x.self=x;return x};exports.f=function(){};exports.json={toJSON:function(){throw Error('must not execute toJSON')}}", &[])], &budget()).unwrap();
            for expression in ["tools.cycle()", "tools.f", "Promise.resolve(1)", "({then:function(){}})", "new Date()", "tools.json"] {
                let error = engine.evaluate_batch(&[task(expression)], &budget()).unwrap_err();
                assert_eq!(error.code,ViewEngineErrorCode::UnsupportedValue,"{expression}: {error}");
            }
        }

        #[test]
        fn view_contract_scopes_and_document_aliases_are_independent() {
            let mut engine = $new;
            engine.load_modules(&[
                module("wxs:tools.wxs", "exports.n=0;exports.next=function(){return ++exports.n}", &[]),
                module("wxs:imported.wxs", "exports.n=100;exports.next=function(){return ++exports.n}", &[])], &budget()).unwrap();
            let first = task("tools.next()");
            let mut imported = first.clone(); imported.task_id="imported".into();
            imported.document_id="templates/card.wxml".into();
            imported.bindings.insert("tools".into(),"wxs:imported.wxs".into());
            let mut component=first.clone(); component.task_id="component".into(); component.scope_id="component-1".into();
            let mut repeated=first.clone(); repeated.task_id="repeat".into();
            let results=engine.evaluate_batch(&[first,imported,component,repeated],&budget()).unwrap();
            assert_eq!(results.iter().map(|r|r.value.clone()).collect::<Vec<_>>(),
                vec![ViewValue::Number(1.0),ViewValue::Number(101.0),ViewValue::Number(1.0),ViewValue::Number(2.0)]);
            let mut shadowed=task("tools.next()"); shadowed.data=json!({"tools":{"next":"page data"}});
            assert_eq!(engine.evaluate_batch(&[shadowed],&budget()).unwrap()[0].value,ViewValue::Number(3.0));
        }

        #[test]
        fn view_contract_module_cycles_exports_rebinding_and_falsy_cache() {
            let mut engine = $new;
            engine.load_modules(&[
                module("wxs:tools.wxs", "exports.old='old';var b=require('./b.wxs');module.exports={seen:b.seen,b:b.a};exports={wrong:true}", &["wxs:b.wxs"]),
                module("wxs:b.wxs", "var a=require('./tools.wxs');exports.seen=a.old;exports.a=a", &["wxs:tools.wxs"])], &budget()).unwrap();
            assert_eq!(evaluate(&mut engine,"tools.seen+':'+tools.b.old+':'+typeof tools.wrong"),ViewValue::String("old:old:undefined".into()));
            for (source, expected) in [("module.exports=0",ViewValue::Number(0.0)),("module.exports=false",ViewValue::Bool(false)),("module.exports=null",ViewValue::Null),("module.exports=''",ViewValue::String(String::new()))] {
                engine.load_modules(&[module("wxs:tools.wxs",source,&[])],&budget()).unwrap();
                assert_eq!(evaluate(&mut engine,"tools"),expected);
                assert_eq!(evaluate(&mut engine,"tools"),expected);
            }
        }

        #[test]
        fn view_contract_failed_module_retries_and_keeps_successful_dependencies() {
            let mut engine = $new;
            engine.load_modules(&[
                module("wxs:tools.wxs", "var d=require('./state.wxs');if(++d.n===1)throw Error('first');exports.n=d.n", &["wxs:state.wxs"]),
                module("wxs:state.wxs", "exports.n=0", &[])], &budget()).unwrap();
            assert_eq!(engine.evaluate_batch(&[task("tools.n")],&budget()).unwrap_err().code,ViewEngineErrorCode::Execution);
            assert_eq!(evaluate(&mut engine,"tools.n"),ViewValue::Number(2.0));
        }

        #[test]
        fn view_contract_requires_declared_relative_dependency_graph() {
            let mut engine = $new;
            for request in ["./other.wxs","../outside.wxs","/absolute.wxs","./other.js"] {
                let source=format!("module.exports=require({})",serde_json::to_string(request).unwrap());
                engine.load_modules(&[module("wxs:tools.wxs",&source,&[]),module("wxs:other.wxs","module.exports=1",&[])],&budget()).unwrap();
                assert_eq!(engine.evaluate_batch(&[task("tools")],&budget()).unwrap_err().code,ViewEngineErrorCode::Module);
            }
            engine.load_modules(&[module("wxs:tools.wxs","module.exports=require('./other.wxs')",&["wxs:other.wxs"]),module("wxs:other.wxs","module.exports=7",&[])],&budget()).unwrap();
            assert_eq!(evaluate(&mut engine,"tools"),ViewValue::Number(7.0));
        }

        #[test]
        fn view_contract_invalid_candidate_and_batches_preserve_previous_registry() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs","exports.n=1",&[])],&budget()).unwrap();
            assert!(engine.load_modules(&[module("wxs:tools.wxs","function(",&[])],&budget()).is_err());
            assert_eq!(evaluate(&mut engine,"tools.n"),ViewValue::Number(1.0));
            let first=task("tools.n");
            assert_eq!(engine.evaluate_batch(&[first.clone(),first],&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            let mut other=task("tools.n"); other.task_id="other".into();
            other.bindings=BTreeMap::new();
            assert_eq!(engine.evaluate_batch(&[other],&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            assert_eq!(evaluate(&mut engine,"tools.n"),ViewValue::Number(1.0));
        }

        #[test]
        fn view_contract_recursive_entrypoints_cannot_replace_module_registry() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs","exports.n=1;exports.replace=function(){return globalThis.__weappContainer_view_load([{id:'wxs:tools.wxs',source:'exports.n=999',dependencies:[]}]).ok}",&[])],&budget()).unwrap();
            assert_eq!(evaluate(&mut engine,"typeof __weappContainer_view_load"),ViewValue::String("undefined".into()));
            assert_eq!(evaluate(&mut engine,"tools.replace()"),ViewValue::Bool(false));
            assert_eq!(evaluate(&mut engine,"tools.n"),ViewValue::Number(1.0));
            assert_eq!(evaluate(&mut engine,"globalThis.__weappContainer_view_evaluate([]).error.code"),ViewValue::String("ERR_VIEW_INVALID_BATCH".into()));
        }

        #[test]
        fn view_contract_reset_and_dispose_clear_all_modules_and_scopes() {
            let mut engine = $new;
            engine.load_modules(&[module("wxs:tools.wxs","exports.n=0;exports.next=function(){return ++exports.n}",&[])],&budget()).unwrap();
            assert_eq!(evaluate(&mut engine,"tools.next()"),ViewValue::Number(1.0));
            engine.reset().unwrap();
            assert_eq!(engine.evaluate_batch(&[task("tools.next()")],&budget()).unwrap_err().code,ViewEngineErrorCode::InvalidBatch);
            engine.load_modules(&[module("wxs:tools.wxs","exports.n=0;exports.next=function(){return ++exports.n}",&[])],&budget()).unwrap();
            assert_eq!(evaluate(&mut engine,"tools.next()"),ViewValue::Number(1.0));
            engine.dispose();
            assert_eq!(engine.evaluate_batch(&[task("tools.n")],&budget()).unwrap_err().code,ViewEngineErrorCode::RequiresReset);
        }
    };
}
