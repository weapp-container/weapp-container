// Feature-only complete journal, retained before any application module.
// Console diagnostics and public compatibility arrays cannot drain these cells.
const __container_conformance_runtime_logs = (function() {
  const create = Object.create, define = Object.defineProperty, own = Object.getOwnPropertyDescriptor;
  const prototype = Object.getPrototypeOf, keys = Reflect.ownKeys, stringify = JSON.stringify, apply = Reflect.apply;
  const isArray = Array.isArray, finite = Number.isFinite, is = Object.is;
  const indexOf = String.prototype.indexOf, trim = String.prototype.trim, string = String, safeInteger = Number.isSafeInteger, ErrorValue = Error;
  const nativeStackGetter = (own(new ErrorValue(),'stack') || create(null)).get
    || (own(ErrorValue.prototype,'stack') || create(null)).get;
  const nativePrepareStackGetter = (own(ErrorValue,'prepareStackTrace') || create(null)).get;
  // Projection failures must not construct Errors after guest code can install
  // Error.prepareStackTrace; even the act of allocating an Error may run it.
  const projectionFailure=create(null);
  let entries = create(null), retained = 0, textUnits = 0, sequence = 0, start = 0, resetCursor = 0, generation = 0, overflow = false, formatting = false;
  function put(o,k,v) { define(o,k,{__proto__:null,value:v,enumerable:true,writable:true,configurable:true}); }
  function field(o,k) { const d = o && typeof o === 'object' ? own(o,k) : undefined; return d && own(d,'value') ? d.value : undefined; }
  function inheritedField(value,key) {
    const receiver=value;
    for(let depth=0;value && depth<32;depth++,value=prototype(value)) {
      const d=own(value,key);if(d){
        if(own(d,'value'))return d.value;
        if(key==='prepareStackTrace' && nativePrepareStackGetter && d.get===nativePrepareStackGetter)return apply(nativePrepareStackGetter,receiver,[]);
        // QuickJS retains an intrinsic lazy stack getter on Error.prototype.
        // Only the captured primordial getter may execute during projection.
        if(key==='stack' && nativeStackGetter && d.get===nativeStackGetter){
          if(inheritedField(ErrorValue,'prepareStackTrace')!==undefined)throw projectionFailure;
          return apply(nativeStackGetter,receiver,[]);
        }
        throw projectionFailure;
      }
    }
  }
  function hasEnumerableFields(value) {
    const names=keys(value);for(let at=0;at<names.length;at++)if(typeof names[at]==='string' && own(value,names[at]).enumerable)return true;
    return false;
  }
  function copy(value, depth, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && finite(value) && !is(value,-0)) return value;
    if (!value || typeof value !== 'object' || depth > 32) throw projectionFailure;
    for (let at=0;at<depth;at++) if (seen[at] === value) throw projectionFailure;
    const next = create(null), output = create(null), names = keys(value);
    for (let at=0;at<depth;at++) put(next,at,seen[at]); put(next,depth,value);
    const list = isArray(value); let length = list ? field(value,'length') : undefined;
    if (names.length > 4096 || list && length > 4096) throw projectionFailure;
    // A null-prototype array-like projection is encoded explicitly below.
    for (let at=0;at<names.length;at++) {
      const key = names[at]; if (list && key === 'length') continue;
      const d = own(value,key); if (!d || !d.enumerable) continue;
      if (typeof key !== 'string' || !own(d,'value')) throw projectionFailure;
      put(output,key,copy(d.value,depth+1,next));
    }
    if (!list) return output;
    const array = []; put(array,'toJSON',undefined);
    for (let at=0;at<length;at++) { if (!own(output,string(at))) throw projectionFailure; put(array,at,output[at]); }
    return array;
  }
  function text(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      if(inheritedField(ErrorValue,'prepareStackTrace')!==undefined)throw projectionFailure;
      const name=inheritedField(value,'name'), message=inheritedField(value,'message'), stack=inheritedField(value,'stack');
      const summary=(typeof name==='string'?name:'')+(typeof name==='string' && typeof message==='string'?': ':'')+(typeof message==='string'?message:'');
      if (summary) return typeof stack==='string' && stack ? (apply(indexOf,stack,[summary])===0 ? stack : summary+'\n'+stack) : summary;
      if (!hasEnumerableFields(value)) return '';
    }
    if (value === undefined || typeof value === 'symbol') return '';
    if (typeof value === 'bigint') return string(value);
    if (typeof value === 'number') return stringify(value);
    return stringify(copy(value,0,[]));
  }
  function record(level,message) {
    if (!safeInteger(sequence+1)) { overflow=true; return; }
    const cursor=sequence++;
    if (typeof message!=='string' || textUnits+message.length>65536 || retained>=1024) { overflow=true; return; }
    const entry=create(null); put(entry,'cursor',cursor); put(entry,'level',level); put(entry,'text',message); put(entries,retained++,entry);textUnits+=message.length;
  }
  function console(level,args) {
    if (formatting) { overflow=true; return; }
    formatting=true;
    try {
      let message=''; for(let at=0;at<args.length;at++) message+=(at?' ':'')+text(args[at]);
      message=apply(trim,message,[]);
      if (!message) message=stringify(copy({type:level,args:args},0,[]));
      record(level,message);
    } catch (_) { overflow=true; sequence++; }
    finally { formatting=false; }
  }
  function exception(message) { record('exception',message); }
  function snapshot(reset) {
    if (reset === true) { resetCursor=sequence;generation++; }
    const output=create(null), list=[];put(list,'toJSON',undefined);
    for(let at=0;at<retained;at++) put(list,at,entries[at]);
    put(output,'kind','runtime-logs');put(output,'generation',generation);put(output,'startCursor',start);put(output,'endCursor',sequence);
    put(output,'resetCursor',resetCursor);put(output,'entries',list);put(output,'complete',!overflow);put(output,'overflow',overflow);
    return stringify(output);
  }
  return {console:console,exception:exception,snapshot:snapshot,invalidate:function(){overflow=true}};
})();
