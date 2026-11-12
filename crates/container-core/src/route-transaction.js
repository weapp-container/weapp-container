// The native engine installs a synchronous validator before guest evaluation.
// Dispatch closures remain in the production lexical scope and native retained
// handles; only primitive rewrite options cross into the Session-owned lease.
const __container_routes = (function() {
  const apply = Reflect.apply;
  const create = Object.create;
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  const parse = JSON.parse;
  const Failure = Error;
  const TypeFailure = TypeError;
  const slice = Function.prototype.call.bind(Array.prototype.slice);
  const splice = Function.prototype.call.bind(Array.prototype.splice);
  const setPrototype = Object.setPrototypeOf;
  const global = globalThis;
  const namespace = global.wx;
  const validate = global.__container_host_route_rewrite;
  const report = global.__container_report_error;
  delete global.__container_host_route_rewrite;
  if (typeof validate !== 'function') {
    throw new Failure('route transactions require native synchronous installation');
  }
  const beforeListeners = setPrototype([], null);
  const afterListeners = setPrototype([], null);
  let retired = false;
  let dispatching = false;
  let current = false;
  // This policy is copied only during bootstrap or retained host installation.
  // The public capability map remains diagnostic and never authorizes a call.
  let admitted = create(null);
  let generation = create(null);
  const names = ['wx.onBeforeAppRoute', 'wx.offBeforeAppRoute', 'wx.onAppRoute', 'wx.offAppRoute', 'wx.rewriteRoute'];

  function put(object, name, value) {
    const property = create(null);
    property.value = value;
    property.writable = property.configurable = property.enumerable = true;
    define(object, name, property);
  }
  function own(object, name) {
    if (!object || typeof object !== 'object') return undefined;
    const property = descriptor(object, name);
    return property && property.value;
  }
  function data(object, name) {
    const property = descriptor(object, name);
    if (property && !descriptor(property, 'value')) {
      throw new TypeFailure('rewriteRoute options must contain own data fields');
    }
    return property && property.value;
  }
  function error(message, code) {
    const result = create(null);
    put(result, 'errMsg', 'rewriteRoute:fail ' + message);
    if (code) put(result, 'code', code);
    return result;
  }
  function invoke(callback, value) {
    if (typeof callback !== 'function') return;
    try { apply(callback, global, [value]); }
    catch (failure) {
      if (typeof report === 'function') {
        const caller = current;
        const owner = generation;
        current = false;
        try { apply(report, global, [failure]); } catch (_) {}
        finally { current = caller && !retired && owner === generation; }
      }
    }
  }
  function copyResult(result) {
    const copied = create(null);
    put(copied, 'errMsg', own(result, 'errMsg'));
    const code = own(result, 'code');
    if (typeof code === 'string') put(copied, 'code', code);
    return copied;
  }
  function settle(options, result, accepted) {
    const caller = current;
    const owner = generation;
    // A callback settlement is not another onBeforeAppRoute listener entry.
    current = false;
    try {
      invoke(own(options, accepted ? 'success' : 'fail'), copyResult(result));
      invoke(own(options, 'complete'), copyResult(result));
    } finally { current = caller && !retired && owner === generation; }
  }
  function supported(name) { return own(admitted, name) === true; }
  function require(name) {
    if (supported(name)) return;
    const failure = new Failure(name + ':fail unsupported');
    put(failure, 'code', 'ERR_UNSUPPORTED_CAPABILITY');
    put(failure, 'errMsg', name + ':fail unsupported');
    throw failure;
  }
  function install(capabilities) {
    const next = create(null);
    const requested = create(null);
    for (let i = 0; i < names.length; i += 1) {
      const value = own(capabilities, names[i]);
      put(next, names[i], value === 'partial' || value === 'full');
      put(requested, names[i], value);
    }
    // A listener pair is admitted together. Revoking off must not leave a
    // live registration which can no longer be released or be registered anew.
    const before = own(next, names[0]) && own(next, names[1]);
    const after = own(next, names[2]) && own(next, names[3]);
    put(next, names[0], before); put(next, names[1], before);
    put(next, names[2], after); put(next, names[3], after);
    admitted = next;
    generation = create(null);
    current = false;
    if (!before) { current = false; splice(beforeListeners, 0, beforeListeners.length); }
    if (!after) splice(afterListeners, 0, afterListeners.length);
    for (let i = 0; i < names.length; i += 1) {
      // Producer parity does not cap a complete removal method. The peer
      // remains an admission gate, while this method keeps its own policy minimum.
      const cleanup = i === 1 || i === 3;
      const support = cleanup && own(requested, names[i]) === 'full' ? 'full' : 'partial';
      put(capabilities, names[i], supported(names[i]) ? support : 'unsupported');
    }
    return true;
  }
  function rewrite(options) {
    let result;
    let accepted = false;
    try {
      if (!supported('wx.rewriteRoute')) {
        result = error('unsupported', 'ERR_UNSUPPORTED_CAPABILITY');
      } else if (retired || !current) {
        result = error('only allowed in a onBeforeAppRoute callback', 'ERR_INVALID_STATE');
      } else if (!options || typeof options !== 'object') {
        result = error('options must be an object', 'ERR_INVALID_REQUEST');
      } else {
        const url = data(options, 'url');
        const preserveQuery = data(options, 'preserveQuery');
        if (typeof url !== 'string' || !url.length
            || (preserveQuery !== undefined && typeof preserveQuery !== 'boolean')) {
          result = error('invalid url or preserveQuery', 'ERR_INVALID_REQUEST');
        } else {
          // Native owns the active event, source identity, parsed query, route
          // kind, app/subpackage constraints and successful-rewrite reservation.
          // No callback/toJSON/object enters this transport.
          const response = parse(apply(validate, undefined, [url, preserveQuery === true]));
          accepted = own(response, 'ok') === true;
          const message = own(response, 'errMsg');
          const code = own(response, 'code');
          if (typeof message !== 'string' || (code !== undefined && typeof code !== 'string')) {
            result = error('invalid native result', 'ERR_ENGINE');
            accepted = false;
          } else {
            result = create(null);
            put(result, 'errMsg', message);
            if (typeof code === 'string') put(result, 'code', code);
          }
        }
      }
    } catch (_) { result = error('invalid request or native validation failure', 'ERR_INVALID_REQUEST'); }
    settle(options, result, accepted);
    // Fixed typings define void; there is no generic host-call Promise here.
  }
  function add(list, callback) {
    if (typeof callback !== 'function') throw new TypeFailure('listener must be a function');
    if (retired) throw new Failure('route notifications are retired');
    for (let i = 0; i < list.length; i += 1) if (list[i] === callback) return;
    put(list, list.length, callback);
  }
  function remove(list, callback) {
    if (callback === undefined) { splice(list, 0, list.length); return; }
    if (typeof callback !== 'function') throw new TypeFailure('listener must be a function');
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] === callback) { splice(list, i, 1); return; }
    }
  }
  function dispatch(list, eventJson, before) {
    const capability = before ? 'wx.onBeforeAppRoute' : 'wx.onAppRoute';
    if (retired || !supported(capability)) return false;
    if (dispatching) throw new Failure('route dispatch cannot nest');
    if (typeof eventJson !== 'string') throw new TypeFailure('native route event must be JSON text');
    // Validate JSON before any callback; parse separately for every listener.
    parse(eventJson);
    dispatching = true;
    const owner = generation;
    try {
      const listeners = slice(list);
      for (let i = 0; i < listeners.length && !retired && supported(capability) && owner === generation; i += 1) {
        current = before;
        try {
          __container_turn_scheduler.withCapturedOwner(null, function() { invoke(listeners[i], parse(eventJson)); });
        }
        finally { current = false; }
      }
    } finally { current = false; dispatching = false; }
    return !retired;
  }
  function retire() {
    retired = true;
    current = false;
    splice(beforeListeners, 0, beforeListeners.length);
    splice(afterListeners, 0, afterListeners.length);
  }
  put(namespace, 'onBeforeAppRoute', function(callback) { require('wx.onBeforeAppRoute'); add(beforeListeners, callback); });
  put(namespace, 'offBeforeAppRoute', function(callback) { require('wx.offBeforeAppRoute'); remove(beforeListeners, callback); });
  put(namespace, 'onAppRoute', function(callback) { require('wx.onAppRoute'); add(afterListeners, callback); });
  put(namespace, 'offAppRoute', function(callback) { require('wx.offAppRoute'); remove(afterListeners, callback); });
  put(namespace, 'rewriteRoute', rewrite);
  install(__container_capabilities);
  // The native engine retains these closures; guest code receives no alias.
  return {install:install, before:function(eventJson) { return dispatch(beforeListeners, eventJson, true); },
    after:function(eventJson) { return dispatch(afterListeners, eventJson, false); }, retire:retire};
})();
