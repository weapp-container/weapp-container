// One registration owner for the existing PageNotFound compatibility dispatch.
// This does not implement missing-route production or its recovery semantics.
const __container_page_not_found = (function() {
  const apply = Reflect.apply;
  const create = Object.create;
  const define = Object.defineProperty;
  const getOwn = Object.getOwnPropertyDescriptor;
  const string = String;
  const TypeErrorValue = TypeError;
  const ErrorValue = Error;
  const root = globalThis;
  const clone = __container_clone;
  const report = __container_report_error;
  let callbacks = create(null);
  let length = 0;
  let generation = 0;
  let retired = false;
  let on = false;
  let off = false;

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
  function snapshot() {
    const result = create(null);
    for (let index = 0; index < length; index += 1) put(result, string(index), callbacks[index]);
    put(result, 'length', length);
    return result;
  }
  function publish() {
    // The historical public array is a projection, never a registration owner.
    // Replaced/frozen aliases and proxy traps cannot prevent private cleanup.
    try {
      const diagnostic = own(root, '__container_app_listeners');
      if (!diagnostic || typeof diagnostic !== 'object') return;
      const copy = [];
      for (let index = 0; index < length; index += 1) put(copy, string(index), callbacks[index]);
      put(diagnostic, 'pageNotFound', copy);
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
    const nextOn = enabled(own(policy, 'wx.onPageNotFound'));
    const nextOff = enabled(own(policy, 'wx.offPageNotFound'));
    // Legacy packs can declare only registration. Public removal admission is
    // independent; terminal owner cleanup never depends on either wx method.
    // Diagnostic publication may enter guest Proxy traps. Revoke admission
    // before touching that projection so reentry cannot retain a stale grant.
    on = nextOn;
    off = nextOff;
    if (!nextOn) clear(true);
    put(policy, 'wx.onPageNotFound', nextOn ? 'partial' : 'unsupported');
    put(policy, 'wx.offPageNotFound', nextOff ? own(policy, 'wx.offPageNotFound') : 'unsupported');
  }
  function require(api, admitted) {
    if (admitted) return;
    const failure = create(null);
    put(failure, 'errMsg', api + ':fail unsupported');
    put(failure, 'code', 'ERR_UNSUPPORTED_CAPABILITY');
    put(failure, 'api', api);
    throw failure;
  }
  function add(callback) {
    require('wx.onPageNotFound', on);
    if (typeof callback !== 'function') throw new TypeErrorValue('callback must be a function');
    if (retired) throw new ErrorValue('page-not-found notifications are retired');
    for (let index = 0; index < length; index += 1) if (callbacks[index] === callback) return;
    put(callbacks, string(length++), callback);
    publish();
  }
  function remove(callback) {
    require('wx.offPageNotFound', off);
    if (callback === undefined) { clear(); return; }
    if (typeof callback !== 'function') throw new TypeErrorValue('callback must be a function');
    for (let index = 0; index < length; index += 1) {
      if (callbacks[index] !== callback) continue;
      for (let next = index + 1; next < length; next += 1) callbacks[next - 1] = callbacks[next];
      delete callbacks[--length];
      publish();
      return;
    }
  }
  function dispatch(args) {
    const values = [];
    if (retired || !on) return values;
    const pending = snapshot();
    const admitted = generation;
    let called = 0;
    for (let index = 0; index < pending.length; index += 1) {
      // Ordinary on/off mutation observes the existing dispatch snapshot.
      // Trusted registration revocation and owner retirement cancel its tail.
      if (retired || !on || generation !== admitted) break;
      called += 1;
      try {
        const result = __container_turn_scheduler.withCapturedOwner(null, function() {
          return apply(pending[index], root, args || []);
        });
        put(values, string(values.length), clone(result));
      } catch (error) { try { report(error); } catch (_) {} }
    }
    if (called) {
      try { put(__container_events, string(__container_events.length), { type: 'app.listener', name: 'pageNotFound', count: called }); }
      catch (_) {}
    }
    return values;
  }
  function retire() {
    retired = true;
    clear(true);
  }
  install(__container_capabilities);
  return { add: add, remove: remove, dispatch: dispatch, install: install, retire: retire };
})();
