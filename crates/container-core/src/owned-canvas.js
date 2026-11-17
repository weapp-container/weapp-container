// Session page canvases use the same retained receiver boundary as selectors.
// No public event, options.owner or mutable receiver property authorizes paint.
const __container_owned_canvases = (function() {
  const captureCurrent = globalThis.__container_api_owner_for_observer;
  const PromiseCtor = Promise;
  const then = Function.prototype.call.bind(Promise.prototype.then);
  const push = Function.prototype.call.bind(Array.prototype.push);
  const splice = Function.prototype.call.bind(Array.prototype.splice);
  const parse = JSON.parse;
  const integer = BigInt;
  const apply = Reflect.apply;
  const setPrototype = Object.setPrototypeOf;
  const pending = __host_create(null);
  const queued = setPrototype([], null);
  const delivered = __host_create(null), deliveredOrder = setPrototype([], null);
  let session = false, retired = false, sequence = 0n, contextSequence = 0n;
  let bytes = 0, items = 0, count = 0;
  const MAX_PENDING = 256, MAX_BYTES = 16 * 1024 * 1024, MAX_ITEMS = 1000000;
  const envelopeMeasurements = setPrototype([], null);
  function put(object, key, value) {
    __host_define(object, key, {__proto__:null,value:value,writable:true,enumerable:true,configurable:true});
  }
  function fail(message, code) {
    return {code:code || 'ERR_CANCELLED',api:'wx.canvas.draw',errMsg:'wx.canvas.draw:fail '+message};
  }
  function owner(receiver) {
    if (!receiver || typeof receiver !== 'object') return null;
    const identity = __receiver_get(__receiver_weak, receiver);
    if (!identity || identity.retired) return null;
    const page = __receiver_value(__receiver_pages, identity.pageId);
    if (!page || page.retired || page.scopeId !== null
        || __receiver_get(__receiver_weak, page.receiver) !== page) return null;
    if (identity.scopeId === null ? identity !== page
        : __receiver_value(__receiver_scopes, identity.scopeId) !== identity || identity.pageToken !== page.token) return null;
    return {__proto__:null,receiver:receiver,identity:identity,page:page};
  }
  function live(record) {
    const current = record && owner(record.receiver);
    return current && current.identity === record.identity && current.page === record.page;
  }
  function proof(record) {
    const scopes = __host_create(null);
    if (record.identity.scopeId !== null) put(scopes, record.identity.scopeId, record.identity.token);
    return {pageToken:record.page.token,scopes:scopes};
  }
  function wireEnvelope(requests) {
    return {__proto__:null,requests:requests};
  }
  function measure(source) {
    const measurement = __host_create(null);
    const encoded = __receiver_snapshot_json(source, MAX_ITEMS, measurement);
    return {__proto__:null,items:measurement.items,bytes:encoded.length * 2};
  }
  const nullMeasurement = measure(null);
  function envelopeMeasurement(length) {
    let measurement = __receiver_value(envelopeMeasurements, __host_string(length));
    if (measurement) return measurement;
    const placeholders = setPrototype([], null);
    for (let i=0;i<length;i++) push(placeholders,null);
    const encoded = measure(wireEnvelope(placeholders));
    // Replace measured null values with measured requests. This derives all
    // wrapper/array/delimiter costs from the actual capture serializer, rather
    // than duplicating its traversal or hard-coding envelope constants.
    measurement = {__proto__:null,
      items:encoded.items - length * nullMeasurement.items,
      bytes:encoded.bytes - length * nullMeasurement.bytes};
    put(envelopeMeasurements,__host_string(length),measurement);
    return measurement;
  }
  function prepareAppend(request) {
    if (count >= MAX_PENDING || queued.length >= MAX_PENDING) throw fail('owned canvas pending request budget exceeded','ERR_RESOURCE_LIMIT');
    if (sequence >= 18446744073709551615n) throw fail('owned canvas request identity exhausted','ERR_RESOURCE_LIMIT');
    setPrototype(request, null);
    put(request, 'sequence', __host_string(sequence + 1n));
    const singleton = setPrototype([], null);
    push(singleton,request);
    let encoded;
    // A singleton uses the real capture nesting, including the depth limit.
    try { encoded = measure(wireEnvelope(singleton)); }
    catch (_) { throw fail('owned canvas request snapshot budget exceeded','ERR_RESOURCE_LIMIT'); }
    const singleEnvelope = envelopeMeasurement(1);
    const charge = {__proto__:null,request:request,
      items:encoded.items - singleEnvelope.items,
      bytes:encoded.bytes - singleEnvelope.bytes};
    const envelope = envelopeMeasurement(queued.length + 1);
    if (items + charge.items + envelope.items > MAX_ITEMS) throw fail('owned canvas pending item budget exceeded','ERR_RESOURCE_LIMIT');
    if (bytes + charge.bytes + envelope.bytes > MAX_BYTES) throw fail('owned canvas pending byte budget exceeded','ERR_RESOURCE_LIMIT');
    return charge;
  }
  function commitAppend(entry) {
    // Admission and all guest-independent Promise setup have completed. No
    // callback, accessor, constructor or job checkpoint occurs in this move.
    push(queued,entry);
    sequence += 1n;bytes += entry.bytes;items += entry.items;
  }

  function context(canvasId, receiver) {
    if (!session) return null;
    if (retired) return {__proto__:null,failure:fail('owned canvas realm was retired')};
    const requested = receiver === undefined ? captureCurrent() : receiver;
    let captured = owner(requested);
    if (receiver === undefined && requested == null && !captured) {
      const pages = __host_current_pages === null ? __receiver_current_pages : __host_current_pages;
      if (pages && pages.length) captured = owner(pages[pages.length - 1]);
      // Preserve the original pre-Page independent-surface extension. This
      // context never gains page authority when a Page later appears.
      else return null;
    }
    if (!captured) return {__proto__:null,failure:fail('owned canvas has no live captured Page receiver')};
    if (typeof canvasId !== 'string' || !canvasId || canvasId.length > 256) throw fail('invalid canvasId','ERR_INVALID_REQUEST');
    if (contextSequence >= 18446744073709551615n) throw fail('owned canvas context identity exhausted','ERR_RESOURCE_LIMIT');
    const id = __host_string(contextSequence + 1n);
    const prepared = prepareAppend({kind:'context',context:id,canvasId:canvasId,
      owner:{pageId:captured.identity.pageId,scopeId:captured.identity.scopeId},receivers:proof(captured)});
    commitAppend(prepared);
    contextSequence += 1n;
    return {__proto__:null,id:id,owner:captured};
  }
  function draw(context, options, callback) {
    if (retired || context.failure || !live(context.owner)) throw context.failure || fail('owned canvas receiver was retired');
    const ticket = 'canvas:' + __host_string(sequence + 1n);
    // All commands/options were already snapshotted by the common facade.
    // Callbacks stay inside this closure, outside request serialization.
    const request = {kind:'draw',context:context.id,ticket:ticket,
      owner:{pageId:context.owner.identity.pageId,scopeId:context.owner.identity.scopeId},
      receivers:proof(context.owner),options:{canvasId:options.canvasId,reserve:options.reserve,commands:options.commands}};
    if (count >= MAX_PENDING) throw fail('owned canvas callback budget exceeded','ERR_RESOURCE_LIMIT');
    const prepared = prepareAppend(request);
    let resolve, reject;
    const promise = new PromiseCtor(function(yes,no){resolve=yes;reject=no;});
    __host_define(promise,'constructor',{__proto__:null,value:undefined});
    // Legacy callback callers may ignore the compatibility Promise extension.
    // Both constructors are intrinsic: the own undefined constructor also
    // excludes mutable Promise species from the retained then operation.
    then(promise,undefined,function(){});
    put(pending,ticket,{__proto__:null,resolve:resolve,reject:reject,callback:callback,owner:context.owner});count += 1;
    commitAppend(prepared);
    return promise;
  }
  function capture(request) {
    const cursor = integer(__receiver_value(request,'after'));
    while (queued.length && integer(queued[0].request.sequence) <= cursor) {
      bytes -= queued[0].bytes;items -= queued[0].items;splice(queued,0,1);
    }
    const requests = setPrototype([],null);
    for (let i=0;i<queued.length;i++) push(requests,queued[i].request);
    return __receiver_snapshot_json(wireEnvelope(requests),MAX_ITEMS);
  }

  function deliver(payload) {
    const ticket=__receiver_value(payload,'ticket'),record=__receiver_value(pending,ticket);
    if(retired)return false;
    if(!record)return __receiver_value(delivered,ticket) === true;
    delete pending[ticket];count -= 1;
    put(delivered,ticket,true);push(deliveredOrder,ticket);
    if(deliveredOrder.length>MAX_PENDING){delete delivered[deliveredOrder[0]];splice(deliveredOrder,0,1);}
    const error=__receiver_value(payload,'error');
    if(error!=null)record.reject(parse(__receiver_snapshot_json(error)));
    else if(!live(record.owner))record.reject(fail('owned canvas receiver was retired before delivery'));
    else {
      const result=parse(__receiver_snapshot_json(__receiver_value(payload,'result')));
      record.resolve(result);
      if(typeof record.callback==='function')try{__container_turn_scheduler.withOwner(record.owner.receiver,function(){apply(record.callback,undefined,[result]);});}
      catch(error){try{__container_report_error(error);}catch(_){}}
    }
    return true;
  }
  function retire() {
    retired=true;splice(queued,0,queued.length);bytes=0;items=0;
    const keys=__host_keys(pending);
    for(let i=0;i<keys.length;i++){const record=__receiver_value(pending,keys[i]);delete pending[keys[i]];record.reject(fail('owned canvas realm was retired'));}
    count=0;
    const receipts=__host_keys(delivered);
    for(let i=0;i<receipts.length;i++)delete delivered[receipts[i]];
    splice(deliveredOrder,0,deliveredOrder.length);
  }
  return {context:context,draw:draw,capture:capture,deliver:deliver,retire:retire,enable:function(){session=true;}};
})();
