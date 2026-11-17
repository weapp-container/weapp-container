use super::QuickJsEngine as Engine;
use container_core::{CallTarget, JsEngine, ModuleId};
use serde_json::{json, Value};

fn fixture() -> (Engine, ModuleId) {
    let mut engine = Engine::default();
    let module = engine.load_module(br#"
      const trace = [];
      let resultChannel, targetChannel, promiseChannel;
      Page({data:{},onUnload:function(){trace.push('home-unload');}});
      Page({data:{},onLoad:function(){
        trace.push('load');
        targetChannel = this.getOpenerEventChannel();
        targetChannel.emit('ready',7);
        targetChannel.emit('early',8);
        targetChannel.on('answer',function(value){trace.push('answer:'+value);});
      },onUnload:function(){
        this.getOpenerEventChannel().emit('closing',10);
        trace.push('detail-unload');
        throw new Error('unload fixture');
      }});
      __container_set_current_pages([0],[{index:0,instanceId:11,route:'home'}]);
      exports.start = function(url) {
        wx.navigateTo({url:url || '/detail',events:{ready:function(value){trace.push('ready:'+value);}},
          success:function(value){
            trace.push('success'); resultChannel=value.eventChannel;
            resultChannel.on('early',function(value){trace.push('early:'+value);});
            resultChannel.on('closing',function(value){trace.push('closing:'+value);});
            resultChannel.emit('answer',9);
          },complete:function(){trace.push('complete');}
        }).then(function(value){promiseChannel=value.eventChannel;trace.push('promise');},function(value){trace.push('failed:'+value.code);});
        return __container_api_id;
      };
      exports.attach = function(id, pageId) {
        __container_set_current_pages([0,1],[{index:0,instanceId:11,route:'home'},{index:1,instanceId:pageId,route:'detail'}]);
        return null;
      };
      exports.status = function(){return {trace:trace,same:resultChannel===targetChannel && resultChannel===promiseChannel};};
      exports.stale = function(){
        const results=[];
        for(const channel of [targetChannel,resultChannel]) {
          if(!channel)continue;
          try{channel.emit('closing',99);results.push('unexpected');}catch(error){results.push(error.code);}
        }
        return {results:results};
      };
      function localChannel() {
        return getCurrentPages()[1].getOpenerEventChannel();
      }
      exports.empty = function(){const channel=getCurrentPages()[0].getOpenerEventChannel();return {keys:Object.keys(channel),emit:typeof channel.emit};};
      exports.local = function(){
        const channel = localChannel();
        const log=[];
        channel.emit('queued',1);channel.emit('queued',2);channel.emit('queued',3);
        channel.once('queued',function(value){log.push('once:'+value);channel.emit('nested','inside');});
        channel.on('queued',function(value){log.push('on:'+value);});
        channel.on('nested',function(value){log.push('nested:'+value);});
        function duplicate(value){log.push('duplicate:'+value);}
        channel.on('__proto__',duplicate);channel.on('__proto__',duplicate);
        channel.emit('__proto__',4);channel.off('__proto__',duplicate);channel.emit('__proto__',5);
        channel.once('recursive',function(value){log.push('recursive:'+value);channel.emit('recursive',value+1);});
        channel.emit('recursive',6);channel.on('recursive',function(value){log.push('recursive-late:'+value);});
        channel.on('throws',function(){throw new Error('listener failed');});
        channel.on('throws',function(){log.push('after-throw');});channel.emit('throws');
        channel.on('off',duplicate);channel.off('off');channel.emit('off',7);
        channel.on('off',function(value){log.push('off-late:'+value);});
        return {log:log,same:channel===getCurrentPages()[1].getOpenerEventChannel(),errors:__container_errors.length};
      };
      exports.bounds = function(){
        const channel=localChannel(), results=[];
        for(let i=0;i<64;i++)channel.emit('bounded',i);
        try{channel.emit('bounded',64);}catch(error){results.push(error.code);}
        let sum=0;channel.on('bounded',function(value){sum+=value;});
        channel.emit('bounded',64);
        try{channel.on('bad',42);}catch(error){results.push(error.code);}
        try{channel.emit('');}catch(error){results.push(error.code);}
        return {results:results,sum:sum};
      };
      exports.invalid = function(){
        const before=__container_api_id;
        let failure;
        const result=wx.navigateTo({url:'/detail',events:{bad:42},fail:function(value){failure=value.code;}});
        result.catch(function(){});
        return {before:before,after:__container_api_id};
      };
      let serializationFailures=0;
      exports.badSerialization = function(){
        for(let index=0;index<300;index++){
          const options={url:'/detail',fail:function(error){if(error.code==='ERR_INVALID_REQUEST')serializationFailures++;}};
          if(index%3===0)options.cyclic=options;
          if(index%3===1)options.toJSON=function(){throw new Error('throwing toJSON');};
          if(index%3===2)Object.defineProperty(options,'events',{enumerable:true,get:function(){throw new Error('throwing events getter');}});
          wx.navigateTo(options).catch(function(){});
        }
      };
      exports.observerCleanupFailure = function(){
        const page=getCurrentPages()[1], channel=page.getOpenerEventChannel();
        page.createIntersectionObserver();
        const originalPush=__container_events.push;
        let failure, state='live';
        try {
          __container_events.push=function(){throw new Error('cleanup-queue-unavailable');};
          __container_invoke_page_instance(22,1,'onUnload',[]);
        } catch(error) { failure=error.message; }
        finally { __container_events.push=originalPush; }
        try { channel.emit('after-failed-cleanup'); }
        catch(error) { state=error.code; }
        return {failure:failure,state:state};
      };
      exports.failedEnqueue = function(){
        const originalPush=__container_events.push;
        let failures=0;
        try{
          __container_events.push=function(){throw new Error('queue unavailable');};
          for(let index=0;index<300;index++)try{wx.navigateTo({url:'/detail'});}catch(_){failures++;}
        }finally{__container_events.push=originalPush;}
        return failures;
      };
      exports.serializationState=function(){return {failures:serializationFailures,pending:Object.keys(__container_api_pending).length};};
      exports.spoof = function(){
        const channel=getCurrentPages()[1].getOpenerEventChannel();
        const originalWeakGet=WeakMap.prototype.get,originalKeys=Object.keys,originalApply=Reflect.apply;
        WeakMap.prototype.get=function(){throw new Error('weak get replaced');};
        Object.keys=function(){throw new Error('keys replaced');};
        Reflect.apply=function(){throw new Error('apply replaced');};
        let observed;
        try{channel.on('intrinsics',function(value){observed=value;});channel.emit('intrinsics',17);}
        finally{WeakMap.prototype.get=originalWeakGet;Object.keys=originalKeys;Reflect.apply=originalApply;}
        return observed;
      };
    "#).unwrap();
    (engine, module)
}

fn module(engine: &mut Engine, id: ModuleId, export: &str, args: Vec<Value>) -> Value {
    engine
        .call(
            CallTarget::Module {
                id,
                export: export.into(),
            },
            args,
        )
        .unwrap()
        .remove(0)
}

fn global(engine: &mut Engine, name: &str, args: Vec<Value>) -> Value {
    engine
        .call(CallTarget::Global { name: name.into() }, args)
        .unwrap()
        .remove(0)
}

fn bind(engine: &mut Engine, id: ModuleId, request: Value, page: u64) -> Value {
    module(engine, id, "attach", vec![request.clone(), json!(page)]);
    json!(engine
        .bind_event_channel(request.as_u64().unwrap(), page)
        .unwrap())
}

fn local_pair(engine: &mut Engine, id: ModuleId) {
    let request = module(engine, id, "start", vec![]);
    assert_eq!(bind(engine, id, request, 22), json!(true));
}

#[test]
fn event_channel_connects_before_on_load_and_keeps_callback_promise_identity() {
    let (mut engine, id) = fixture();
    let request = module(&mut engine, id, "start", vec![]);
    let events = engine.drain_host_events().unwrap();
    assert_eq!(events[0]["events"][0]["name"], "wx.navigateTo");
    assert_eq!(events[0]["events"][0]["options"]["events"], json!({}));
    assert_eq!(bind(&mut engine, id, request.clone(), 22), json!(true));
    global(
        &mut engine,
        "__container_invoke_page_instance",
        vec![json!(22), json!(1), json!("onLoad"), json!([])],
    );
    global(
        &mut engine,
        "__container_resolve_api",
        vec![request, json!({"errMsg":"navigateTo:ok"}), Value::Null],
    );
    engine.drain_microtasks().unwrap();
    let status = module(&mut engine, id, "status", vec![]);
    assert_eq!(
        status["trace"],
        json!(["load", "ready:7", "success", "early:8", "answer:9", "complete", "promise"])
    );
    assert_eq!(status["same"], true);
    assert!(engine
        .call(
            CallTarget::Global {
                name: "__container_invoke_page_instance".into()
            },
            vec![json!(22), json!(1), json!("onUnload"), json!([])]
        )
        .is_err());
    assert_eq!(
        module(&mut engine, id, "stale", vec![])["results"],
        json!(["ERR_PAGE_UNLOADED", "ERR_PAGE_UNLOADED"])
    );
    assert_eq!(
        module(&mut engine, id, "status", vec![])["trace"],
        json!([
            "load",
            "ready:7",
            "success",
            "early:8",
            "answer:9",
            "complete",
            "promise",
            "closing:10",
            "detail-unload"
        ])
    );
}

#[test]
fn event_channel_once_cache_off_duplicates_and_reentrant_dispatch() {
    let (mut engine, id) = fixture();
    assert_eq!(
        module(&mut engine, id, "empty", vec![]),
        json!({"keys":[],"emit":"undefined"})
    );
    local_pair(&mut engine, id);
    let result = module(&mut engine, id, "local", vec![]);
    assert_eq!(
        result["log"],
        json!([
            "once:1",
            "on:2",
            "on:3",
            "nested:inside",
            "duplicate:4",
            "duplicate:4",
            "recursive:6",
            "recursive-late:7",
            "after-throw",
            "off-late:7"
        ])
    );
    assert_eq!(result["same"], true);
    assert_eq!(result["errors"], 1);
}

#[test]
fn event_channel_bounded_queue_recovers_and_intrinsics_are_captured() {
    let (mut engine, id) = fixture();
    local_pair(&mut engine, id);
    assert_eq!(
        module(&mut engine, id, "bounds", vec![]),
        json!({"results":["ERR_RESOURCE_LIMIT","ERR_INVALID_REQUEST","ERR_INVALID_REQUEST"],"sum":2080})
    );
    assert_eq!(module(&mut engine, id, "spoof", vec![]), json!(17));
}

#[test]
fn event_channel_failed_navigation_retires_target_and_does_not_deliver_cached_success() {
    let (mut engine, id) = fixture();
    let request = module(&mut engine, id, "start", vec![]);
    bind(&mut engine, id, request.clone(), 22);
    global(
        &mut engine,
        "__container_invoke_page_instance",
        vec![json!(22), json!(1), json!("onLoad"), json!([])],
    );
    global(
        &mut engine,
        "__container_resolve_api",
        vec![
            request,
            Value::Null,
            json!({"code":"ERR_TIMEOUT","errMsg":"navigateTo:fail timeout"}),
        ],
    );
    engine.drain_microtasks().unwrap();
    assert_eq!(
        module(&mut engine, id, "stale", vec![])["results"],
        json!(["ERR_PAGE_UNLOADED"])
    );
    assert_eq!(
        module(&mut engine, id, "status", vec![])["trace"],
        json!(["load", "ready:7", "complete", "failed:ERR_TIMEOUT"])
    );
}

#[test]
fn event_channel_appservice_instances_do_not_share_callbacks_or_channels() {
    let (mut first, first_id) = fixture();
    let (mut second, second_id) = fixture();
    assert_eq!(module(&mut first, first_id, "start", vec![]), json!(1));
    assert_eq!(bind(&mut second, second_id, json!(1), 22), json!(false));
    assert_eq!(
        module(&mut second, second_id, "status", vec![])["trace"],
        json!([])
    );
    module(&mut second, second_id, "invalid", vec![]);
    second.drain_microtasks().unwrap();
    assert!(second
        .drain_host_events()
        .unwrap()
        .iter()
        .all(|batch| batch["events"].as_array().is_none_or(Vec::is_empty)));
}

#[test]
fn event_channel_failed_serialization_never_allocates_pending_calls_or_exhausts_channels() {
    let (mut engine, id) = fixture();
    module(&mut engine, id, "badSerialization", vec![]);
    engine.drain_microtasks().unwrap();
    assert_eq!(
        module(&mut engine, id, "serializationState", vec![]),
        json!({"failures":300,"pending":0})
    );
    assert!(engine
        .drain_host_events()
        .unwrap()
        .iter()
        .all(|batch| batch["events"].as_array().is_none_or(Vec::is_empty)));
    let request = module(&mut engine, id, "start", vec![]);
    assert_eq!(bind(&mut engine, id, request.clone(), 22), json!(true));
    global(
        &mut engine,
        "__container_invoke_page_instance",
        vec![json!(22), json!(1), json!("onLoad"), json!([])],
    );
    global(
        &mut engine,
        "__container_resolve_api",
        vec![request, json!({"errMsg":"navigateTo:ok"}), Value::Null],
    );
    engine.drain_microtasks().unwrap();
    assert_eq!(module(&mut engine, id, "status", vec![])["same"], true);
}

#[test]
fn event_channel_failed_enqueue_releases_every_new_channel_and_pending_call() {
    let (mut engine, id) = fixture();
    assert_eq!(module(&mut engine, id, "failedEnqueue", vec![]), json!(300));
    assert_eq!(
        module(&mut engine, id, "serializationState", vec![]),
        json!({"failures":0,"pending":0})
    );
    let request = module(&mut engine, id, "start", vec![]);
    assert_eq!(bind(&mut engine, id, request.clone(), 22), json!(true));
    global(
        &mut engine,
        "__container_resolve_api",
        vec![request, json!({"errMsg":"navigateTo:ok"}), Value::Null],
    );
    engine.drain_microtasks().unwrap();
    assert_eq!(
        module(&mut engine, id, "serializationState", vec![])["pending"],
        0
    );
}

#[test]
fn event_channel_retires_even_when_observer_cleanup_enqueue_throws() {
    let (mut engine, id) = fixture();
    local_pair(&mut engine, id);
    assert_eq!(
        module(&mut engine, id, "observerCleanupFailure", vec![]),
        json!({"failure":"cleanup-queue-unavailable","state":"ERR_PAGE_UNLOADED"})
    );
}
