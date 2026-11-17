// Only these two functions retain the native owner callback. No public map
// stores lease bytes or a transport that can bypass their own admission.
const __container_buffer_urls = (function() {
  const transport = globalThis.__container_host_buffer_url;
  delete globalThis.__container_host_buffer_url;
  const define = Object.defineProperty, get = Object.getOwnPropertyDescriptor;
  const apply = Reflect.apply, parse = JSON.parse;
  const U8 = Uint8Array;
  const bufferLength = get(ArrayBuffer.prototype, "byteLength").get;
  const typed = Object.getPrototypeOf(U8.prototype);
  const typedTag = get(typed, Symbol.toStringTag).get;
  const typedBuffer = get(typed, "buffer").get;
  const typedOffset = get(typed, "byteOffset").get;
  const typedLength = get(typed, "byteLength").get;
  const allowed = Object.create(null);
  for (const name of ["Int8Array","Uint8Array","Uint8ClampedArray","Int16Array","Uint16Array","Int32Array","Uint32Array","Float32Array","Float64Array"]) allowed[name] = true;
  const digits = "0123456789abcdef";
  let retired=false, createAllowed=false, revokeAllowed=false;
  function own(policy,name) { const descriptor=get(policy,name); return descriptor ? descriptor.value : undefined; }
  function install(policy) {
    const create=own(policy,"wx.createBufferURL"),revoke=own(policy,"wx.revokeBufferURL");
    createAllowed=!retired && (create === "full" || create === "partial");
    revokeAllowed=!retired && (revoke === "full" || revoke === "partial");
    define(policy,"wx.createBufferURL",{__proto__:null,value:createAllowed?create:"unsupported",enumerable:true,configurable:true,writable:true});
    define(policy,"wx.revokeBufferURL",{__proto__:null,value:revokeAllowed?revoke:"unsupported",enumerable:true,configurable:true,writable:true});
  }
  function retire() { retired=true;createAllowed=revokeAllowed=false; }
  function fail(name, message, code) { throw {__proto__:null,code:code || "ERR_INVALID_REQUEST",errMsg:name+":fail "+message}; }
  function invoke(name, operation, wire) {
    if (typeof transport !== "function") fail(name,"native byte owner unavailable","ERR_UNSUPPORTED_CAPABILITY");
    const response = parse(transport(operation, wire));
    if (!response || response.ok !== true) throw response && response.error || {code:"ERR_INVALID_REQUEST",errMsg:name+":fail invalid owner response"};
    return response.value;
  }
  function admission(name) { if (retired || !(name === "wx.createBufferURL" ? createAllowed : revokeAllowed)) fail(name,"unsupported","ERR_UNSUPPORTED_CAPABILITY"); }
  define(wx,"createBufferURL",{enumerable:true,configurable:true,writable:true,value:function(input) {
    const name="wx.createBufferURL"; admission(name);
    let buffer=input, offset=0, length;
    try { length=apply(bufferLength,input,[]); }
    catch (_) {
      let tag;
      try { tag=apply(typedTag,input,[]); } catch (_) { fail(name,"buffer must be an ArrayBuffer or supported TypedArray"); }
      if (allowed[tag] !== true) fail(name,"buffer must be an ArrayBuffer or supported TypedArray");
      buffer=apply(typedBuffer,input,[]); offset=apply(typedOffset,input,[]); length=apply(typedLength,input,[]);
      // Shared memory cannot provide one immutable, race-free creation snapshot.
      try { apply(bufferLength,buffer,[]); } catch (_) { fail(name,"shared buffers are unsupported"); }
    }
    if (length > 8388608) fail(name,"buffer exceeds 8 MiB byte budget");
    // Constructing the intrinsic view also rejects detached ArrayBuffers.
    const bytes=new U8(buffer,offset,length); let wire="";
    for (let i=0;i<length;i+=1) { const byte=bytes[i]; wire+=digits[byte >>> 4]+digits[byte & 15]; }
    const url=invoke(name,"create",wire);
    if (typeof url !== "string") fail(name,"invalid owner URL");
    return url;
  }});
  define(wx,"revokeBufferURL",{enumerable:true,configurable:true,writable:true,value:function(url) {
    const name="wx.revokeBufferURL"; admission(name);
    if (typeof url !== "string") fail(name,"url must be a string");
    if (url.length > 128) return; // Every owner URL is 59 ASCII characters; an oversized unknown URL is a no-op.
    invoke(name,"revoke",url);
  }});
  install(__container_capabilities);
  return {install:install,retire:retire};
})();
