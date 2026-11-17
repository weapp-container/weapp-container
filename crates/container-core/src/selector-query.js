// Basic SelectorQuery owns callbacks and receiver incarnations in this realm.
// Session requests and deliveries use retained native transports. Compatibility
// globals are diagnostics/standalone extensions and never carry this authority.
const __container_selector_queries = (function() {
  const PromiseCtor = Promise;
  const then = Function.prototype.call.bind(Promise.prototype.then);
  const resolvePromise = Function.prototype.call.bind(Promise.resolve, Promise);
  const rejectPromise = Function.prototype.call.bind(Promise.reject, Promise);
  const apply = Reflect.apply;
  const setPrototype = Object.setPrototypeOf;
  const push = Function.prototype.call.bind(Array.prototype.push);
  const splice = Function.prototype.call.bind(Array.prototype.splice);
  const parse = JSON.parse;
  const integer = BigInt;
  const trim = Function.prototype.call.bind(String.prototype.trim);
  const captureCurrent = globalThis.__container_api_owner_for_observer;
  const runOwner = __container_turn_scheduler.withOwner;
  const domEnabled = globalThis.__container_dom_query_enabled;
  const domRevision = globalThis.__container_dom_query_revision;
  const legacyCall = __container_api_call;
  const report = __container_report_error;
  const pending = __host_create(null);
  const queued = list();
  let session = false, retired = false, sequence = 0n, count = 0;
  function put(object,key,value) { __host_define(object,key,{__proto__:null,value:value,writable:true,enumerable:true,configurable:true}); }
  function own(object,key) { return __receiver_value(object,key); }
  function list() { return setPrototype([],null); }
  function safePromise(promise) { __host_define(promise,'constructor',{__proto__:null,value:undefined});return promise; }
  function chain(promise,yes,no) { return safePromise(then(promise,yes,no)); }
  function resolved(value) { return safePromise(resolvePromise(value)); }
  function rejected(error) { return safePromise(rejectPromise(error)); }
  function error(code,message) {
    const value={code:code,api:'wx.createSelectorQuery',errMsg:'wx.createSelectorQuery:fail '+message};
    try { push(__container_errors,value); } catch (_) {}
    return value;
  }
  function owner(receiver) {
    if (!receiver || typeof receiver!=='object') return null;
    const identity=__receiver_get(__receiver_weak,receiver);
    if(!identity || identity.retired) return null;
    const pageIdentity=own(__receiver_pages,identity.pageId);
    if(!pageIdentity || pageIdentity.retired || pageIdentity.scopeId!==null
      || __receiver_get(__receiver_weak,pageIdentity.receiver)!==pageIdentity) return null;
    if(identity.scopeId===null ? identity!==pageIdentity
      : own(__receiver_scopes,identity.scopeId)!==identity || identity.pageToken!==pageIdentity.token) return null;
    return {receiver:receiver,identity:identity,pageIdentity:pageIdentity,page:pageIdentity.receiver,
      pageId:identity.pageId,scopeId:identity.scopeId};
  }
  function live(record) {
    const current=record && owner(record.receiver);
    return current && current.identity===record.identity && current.pageIdentity===record.pageIdentity;
  }
  function currentPages() {
    return __host_current_pages===null ? __receiver_current_pages : __host_current_pages;
  }
  function currentPageOwner() {
    const pages=currentPages();
    if(session && pages && pages.length) return owner(pages[pages.length-1]);
    return null;
  }
  function validate(record) {
    if(retired) throw error('ERR_CANCELLED','query realm is retired');
    if(record.revision!==domRevision()) throw error('ERR_CANCELLED','query rendering profile changed');
    if((record.dom || record.owner) && !live(record.owner)) throw error('ERR_CANCELLED','query owner is unavailable');
    const scopes=record.scopes||[];
    for(let i=0;i<scopes.length;i++)if(!live(scopes[i]))throw error('ERR_CANCELLED','query scope was disposed');
    const pages=currentPages();
    if(record.owner && pages && (!pages.length
      || pages[pages.length-1]!==record.owner.page)) throw error('ERR_CANCELLED','query owner is not the current page');
  }
  function callback(fn,value,record) {
    validate(record);
    if(typeof fn!=='function') return;
    try {
      const call=function(){apply(fn,undefined,[value]);};
      if(record.callbackOwner) runOwner(record.callbackOwner.receiver,call); else call();
    } catch(thrown) { try {report(thrown);} catch (_) {} }
  }
  function submit(record,queries) {
    if(!session) return legacyCall('wx.createSelectorQuery',{queries:queries},record.owner?{pageId:record.owner.pageId,scopeId:record.owner.scopeId}:undefined);
    if(count>=256) return rejected(error('ERR_INVALID_REQUEST','query callback budget exceeded'));
    if(sequence>=18446744073709551615n) return rejected(error('ERR_INVALID_REQUEST','query identity exhausted'));
    const seq=__host_string(++sequence),ticket='selector:'+seq;
    const request=__host_create(null);request.sequence=seq;request.ticket=ticket;
    request.owner=record.owner?{pageId:record.owner.pageId,scopeId:record.owner.scopeId}:null;
    request.options={queries:queries};
    const scopes=__host_create(null);
    if(record.owner && record.owner.scopeId!==null)put(scopes,record.owner.scopeId,record.owner.identity.token);
    for(let i=0;i<record.scopes.length;i++){const scope=record.scopes[i];if(scope.scopeId!==null)put(scopes,scope.scopeId,scope.identity.token);}
    request.receivers=record.owner?{pageToken:record.owner.pageIdentity.token,scopes:scopes}:null;
    // Reject oversized/invalid input before publishing either pending callback
    // state or a native request. Own-data encoding never invokes toJSON.
    if(__receiver_snapshot_json(request).length>1024*1024) return rejected(error('ERR_INVALID_REQUEST','query request exceeds its byte budget'));
    const promise=safePromise(new PromiseCtor(function(resolve,reject){put(pending,ticket,{resolve:resolve,reject:reject});}));
    push(queued,request);count+=1;
    return promise;
  }
  function executionPromise(promise) {
    // Keep the existing portable Promise extension. The locked declaration and
    // current official docs say NodesRef but name no selection, while the
    // official adapter returns undefined. Do not invent a selection cursor.
    put(promise,'then',function(yes,no){return chain(promise,yes,no);});
    put(promise,'catch',function(no){return chain(promise,undefined,no);});
    put(promise,'finally',function(fn){
      if(typeof fn!=='function')return chain(promise);
      return chain(promise,function(value){return chain(resolved(fn()),function(){return value;});},
        function(failure){return chain(resolved(fn()),function(){throw failure;});});
    });
    // Callback-only callers may ignore the portable Promise extension.
    chain(promise,undefined,function(){});
    return promise;
  }
  function create(preferredReceiver) {
    let scope=null,invalidScope=false,callbackOwner=owner(preferredReceiver)||owner(captureCurrent()),last=null;
    // The captured Page fences a context-free Session query to its original
    // incarnation. It does not invent a synchronous callback entry context.
    const fallbackOwner=currentPageOwner();
    const revision=domRevision(),dom=domEnabled(),operations=list();
    function enqueue(selection,operation,fields,fn) {
      const frozen=fields==null?null:parse(__receiver_snapshot_json(fields));
      push(operations,{selection:selection,query:{selector:selection.selector,target:selection.target,all:selection.all,fields:frozen,operation:operation},callback:typeof fn==='function'?fn:null});
      return api;
    }
    function nodes(selection,remember) {
      // A retained reference owns its selection scope. Later in() calls only
      // affect subsequently created references, as in the official adapter.
      put(selection,'scope',scope);put(selection,'invalidScope',invalidScope);
      if(remember)last=selection;
      const ref={
        boundingClientRect:function(fieldsOrCallback,fn){return typeof fieldsOrCallback==='function'
          ?enqueue(selection,'boundingClientRect',null,fieldsOrCallback):enqueue(selection,'boundingClientRect',fieldsOrCallback,fn);},
        scrollOffset:function(fn){return enqueue(selection,'scrollOffset',null,fn);},
        fields:function(fields,fn){return enqueue(selection,'fields',fields,fn);},
        node:function(fn){return enqueue(selection,'node',null,fn);},
        in:function(value){
          api.in(value);put(selection,'scope',scope);put(selection,'invalidScope',invalidScope);return ref;
        },
        exec:function(fn){if(!operations.length)enqueue(selection,'boundingClientRect',null,null);return api.exec(fn);},
        select:function(value){return api.select(value);},selectAll:function(value){return api.selectAll(value);},
        selectViewport:function(){return api.selectViewport();}
      };
      return ref;
    }
    function selection(selector,all) {
      if(typeof selector!=='string') throw error('ERR_INVALID_REQUEST','selector must be a string');
      return nodes({selector:selector,target:'node',all:all},true);
    }
    const api={
      select:function(selector){return selection(selector,false);},
      selectAll:function(selector){return selection(selector,true);},
      selectViewport:function(){return nodes({selector:null,target:'viewport',all:false},true);},
      in:function(receiver){
        if(receiver==null){scope=null;invalidScope=false;return api;}
        const next=owner(receiver);
        const authority=callbackOwner||fallbackOwner;
        invalidScope=!next || !!(authority && next.pageIdentity!==authority.pageIdentity);
        scope=invalidScope?null:next;
        if(!callbackOwner && next && !invalidScope)callbackOwner=next;
        return api;
      },
      exec:function(fn){
        if(!operations.length && last)enqueue(last,'boundingClientRect',null,null);
        const batch=splice(operations,0,operations.length);last=null;
        const scopes=list();
        for(let i=0;i<batch.length;i++)if(batch[i].selection.scope)push(scopes,batch[i].selection.scope);
        const record={owner:callbackOwner||fallbackOwner,callbackOwner:callbackOwner,scopes:scopes,revision:revision,dom:dom};
        let promise;
        try {
          validate(record);
          if(own(__container_capabilities,'wx.createSelectorQuery')==='unsupported')throw error('ERR_UNSUPPORTED_CAPABILITY','unsupported');
          if(!batch.length && invalidScope)throw error('ERR_INVALID_REQUEST','query scope is unavailable');
          const queries=list();
          for(let i=0;i<batch.length;i++){
            const query=batch[i].query,selection=batch[i].selection;
            if(selection.invalidScope)throw error('ERR_INVALID_REQUEST','query scope is unavailable');
            if(query.target!=='viewport' && (!query.selector || !trim(query.selector)))throw error('ERR_INVALID_REQUEST','selector is required');
            put(query,'scopeId',selection.scope?selection.scope.scopeId:null);
            push(queries,query);
          }
          const result=batch.length?submit(record,queries):resolved(session?{__proto__:null,values:[]}:[]);
          promise=chain(result,function(outcome){
            const values=session?outcome.values:outcome;
            validate(record);
            if(!__host_is_array(values) || values.length!==batch.length)throw error('ERR_INVALID_REQUEST','provider returned an invalid result batch');
            for(let i=0;i<batch.length;i++)callback(batch[i].callback,values[i],record);
            callback(fn,values,record);
            return values;
          },function(failure){validate(record);throw failure;});
        } catch(failure) {promise=rejected(failure);}
        return executionPromise(promise);
      }
    };
    return api;
  }
  function capture(request) {
    const after=own(request,'after');
    if(typeof after!=='string')throw 'invalid selector request cursor';
    const cursor=integer(after);
    while(queued.length && integer(queued[0].sequence)<=cursor)splice(queued,0,1);
    return __receiver_snapshot_json({requests:queued});
  }
  function deliver(payload) {
    const ticket=own(payload,'ticket'),state=own(pending,ticket);
    if(!state || retired)return false;
    // Claim this native delivery once before any Promise job/callback runs.
    delete pending[ticket];count-=1;
    const failure=own(payload,'error');
    if(failure!=null)state.reject(failure);else state.resolve({__proto__:null,values:own(payload,'result')});
    return true;
  }
  function retire() {
    retired=true;splice(queued,0,queued.length);
    const tickets=__host_keys(pending);
    for(let i=0;i<tickets.length;i++){
      const state=own(pending,tickets[i]);delete pending[tickets[i]];
      state.reject(error('ERR_CANCELLED','query realm is retired'));
    }
    count=0;
  }
  return {create:create,capture:capture,deliver:deliver,retire:retire,enable:function(){session=true;}};
})();
