// Error listener ownership is private to this bootstrap realm. The public
// handler array is a diagnostic snapshot, never registration authority.
// Stage one preserves the existing wx string projection; App.onError and the
// remaining uncaught-source/payload work keep wx.onError Partial.
const __container_error_notifications = (function() {
  const apply = Reflect.apply;
  const getOwn = Object.getOwnPropertyDescriptor;
  const getPrototype = Object.getPrototypeOf;
  const define = Object.defineProperty;
  const create = Object.create;
  const string = String;
  const TypeErrorValue = TypeError;
  const ErrorValue = Error;
  // Standard Error names live on their prototypes. Capture those identities
  // before guest code runs; never read a guest prototype's name/getter here.
  const errorPrototypes = [Error.prototype, EvalError.prototype, RangeError.prototype,
    ReferenceError.prototype, SyntaxError.prototype, TypeError.prototype, URIError.prototype];
  const errorNames = ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError'];
  const root = globalThis;
  let callbacks = create(null);
  let length = 0;
  let generation = 0;
  let retired = false;
  let reporting = false;
  let on = true;
  let off = true;
  function own(object, key) {
    if (object === null || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
    const descriptor = getOwn(object, key);
    return descriptor && getOwn(descriptor, 'value') ? descriptor.value : undefined;
  }
  function put(object, key, value) {
    const descriptor = create(null);
    descriptor.value = value;
    descriptor.writable = descriptor.enumerable = descriptor.configurable = true;
    define(object, key, descriptor);
  }
  function text(value, fallback) {
    const kind = typeof value;
    return value === null || (kind !== 'object' && kind !== 'function' && kind !== 'undefined') ? string(value) : fallback;
  }
  function normalize(error, source) {
    const record = create(null);
    let message = text(error, 'Error');
    let name = 'Error';
    let stack;
    try {
      message = text(own(error, 'message'), message);
      const ownName = own(error, 'name');
      if (ownName === undefined && error !== null && (typeof error === 'object' || typeof error === 'function')) {
        const prototype = getPrototype(error);
        for (let index = 0; index < errorPrototypes.length; index += 1) {
          if (prototype === errorPrototypes[index]) { name = errorNames[index]; break; }
        }
      } else name = text(ownName, name);
      stack = own(error, 'stack');
    } catch (_) {
      // Hostile accessors/proxies cannot replace the triggering exception.
    }
    put(record, 'message', message);
    put(record, 'name', name);
    if (typeof stack === 'string') put(record, 'stack', stack);
    if (source) put(record, 'source', source);
    return record;
  }
  function diagnostic(record) {
    // This queue is compatibility transport. Frozen/replaced aliases and
    // inherited setters cannot control notification delivery.
    try { put(__container_errors, string(__container_errors.length), record); } catch (_) {}
  }
  function callbackDiagnostic(error) {
    // This compatibility path belongs only to API callback reporting. Its
    // historical getters/coercions and mutable queue may fail; callers retain
    // their existing unreportable-value fallback. None of these reads choose
    // the private listener payload or registration authority.
    const value = error || {};
    const record = create(null);
    put(record, 'message', string(value.message || value));
    put(record, 'name', string(value.name || 'Error'));
    if (value.stack) put(record, 'stack', string(value.stack));
    __container_errors.push(record);
  }
  function snapshot() {
    const result = create(null);
    for (let index = 0; index < length; index += 1) put(result, string(index), callbacks[index]);
    put(result, 'length', length);
    return result;
  }
  function publish() {
    try {
      const copy = [];
      for (let index = 0; index < length; index += 1) put(copy, string(index), callbacks[index]);
      put(root, '__container_error_handlers', copy);
    } catch (_) {}
  }
  function clear(invalidate) {
    callbacks = create(null);
    length = 0;
    if (invalidate) generation += 1;
    publish();
  }
  function enabled(value) { return value === 'full' || value === 'partial'; }
  function install(policy) {
    const nextOn = enabled(own(policy, 'wx.onError'));
    const nextOff = enabled(own(policy, 'wx.offError'));
    // Registration owns delivery. Older packs declare only onError, so the
    // absence/revocation of the optional removal API cannot revoke listeners.
    // Terminal owner cleanup is unconditional and never calls public offError.
    if (!nextOn) clear(true);
    put(policy, 'wx.onError', nextOn ? 'partial' : 'unsupported');
    put(policy, 'wx.offError', nextOff ? own(policy, 'wx.offError') : 'unsupported');
    on = nextOn;
    off = nextOff;
  }
  function unsupported(api) {
    const error = create(null);
    put(error, 'errMsg', api + ':fail unsupported');
    put(error, 'code', 'ERR_UNSUPPORTED_CAPABILITY');
    put(error, 'api', api);
    diagnostic(error);
    return error;
  }
  function add(callback) {
    if (!on) throw unsupported('wx.onError');
    if (typeof callback !== 'function') throw new TypeErrorValue('listener must be a function');
    if (retired) throw new ErrorValue('error notifications are retired');
    // One registration per function, matching the other private App listener
    // hubs. Device-specific duplicate registration semantics are not claimed.
    for (let index = 0; index < length; index += 1) if (callbacks[index] === callback) return;
    put(callbacks, string(length++), callback);
    publish();
  }
  function remove(callback) {
    if (!off) throw unsupported('wx.offError');
    if (callback === undefined) { clear(); return; }
    if (typeof callback !== 'function') throw new TypeErrorValue('listener must be a function');
    for (let index = 0; index < length; index += 1) {
      if (callbacks[index] !== callback) continue;
      for (let next = index + 1; next < length; next += 1) callbacks[next - 1] = callbacks[next];
      delete callbacks[--length];
      publish();
      return;
    }
  }
  function report(error, callbackCompatibility) {
    // A listener or diagnostic getter can call this reporter again. Suppress
    // that nested delivery before reading the new value, so recursion cannot
    // consume the original exception or grow an unbounded notification tree.
    if (reporting) {
      if (__container_conformance_runtime_logs) __container_conformance_runtime_logs.invalidate();
      // Notification recursion deliberately suppresses delivery. A proof interval
      // cannot certify a complete empty stream after that lost nested report.
      if (typeof __container_conformance_exceptions !== "undefined" && __container_conformance_exceptions) __container_conformance_exceptions.invalidate();
      return null;
    }
    reporting = true;
    try {
      const record = normalize(error);
      capture(error, record);
      const pending = snapshot();
      const admitted = generation;
      let diagnosticFailed = false;
      let diagnosticError;
      if (callbackCompatibility) {
        try { callbackDiagnostic(error); }
        catch (failure) { diagnosticFailed = true; diagnosticError = failure; }
      } else diagnostic(record);
      for (let index = 0; index < pending.length; index += 1) {
        // Ordinary on/off mutation observes this dispatch's snapshot. Policy
        // revocation and terminal retirement cancel the remaining callbacks.
        if (retired || !on || generation !== admitted) break;
        try {
          __container_turn_scheduler.withCapturedOwner(null, function() { apply(pending[index], root, [record.message]); });
        }
        catch (listenerError) { const failure = normalize(listenerError, 'error-listener'); capture(listenerError, failure); diagnostic(failure); }
      }
      // A frozen diagnostic queue or throwing diagnostic getter must not skip
      // the private notification. Re-throw only at the API compatibility entry,
      // where the pre-existing callback helper owns the terminal fallback.
      if (diagnosticFailed) throw diagnosticError;
      return record;
    } finally { reporting = false; }
  }
  function capture(error, normalized) {
    if (__container_conformance_runtime_logs) __container_conformance_runtime_logs.exception((normalized || normalize(error)).message);
    if (typeof __container_conformance_exceptions !== "undefined" && __container_conformance_exceptions) __container_conformance_exceptions.record((normalized || normalize(error)).message);
  }
  function retire() {
    retired = true;
    clear(true);
  }
  put(wx, 'onError', function(callback) { add(callback); });
  put(wx, 'offError', function(callback) { remove(callback); });
  install(__container_capabilities);
  const bindTimer = own(root, '__container_bind_timer_error_reporter');
  if (typeof bindTimer === 'function') apply(bindTimer, root, [report]);
  delete root.__container_bind_timer_error_reporter;
  return { capture: capture, report: report, reportApiCallback: function(error) { return report(error, true); }, install: install, retire: retire };
})();
