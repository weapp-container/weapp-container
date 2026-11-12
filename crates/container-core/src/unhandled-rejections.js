// Actual native rejection callbacks enter track(); only the native microtask
// checkpoint enters flush(). Neither transport is exported to application code.
const __container_unhandled_rejections = (function() {
  const create = Object.create, define = Object.defineProperty, getOwn = Object.getOwnPropertyDescriptor;
  const apply = Reflect.apply, TypeErrorValue = TypeError, ErrorValue = Error;
  const report = __container_report_error, root = globalThis;
  let listeners = create(null), listenerCount = 0, generation = 0;
  let pending = create(null), pendingCount = 0, captured = null, capturedCount = 0;
  let app = null, on = false, off = false, retired = false, flushing = false;
  const maxPending = 4096;
  function put(object, key, value) {
    const descriptor = create(null); descriptor.value = value;
    descriptor.writable = descriptor.enumerable = descriptor.configurable = true;
    define(object, key, descriptor);
  }
  function own(object, key) {
    if (object === null || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
    const descriptor = getOwn(object, key);
    return descriptor && getOwn(descriptor, 'value') ? descriptor.value : undefined;
  }
  function admitted(value) { return value === 'full' || value === 'partial'; }
  function install(policy) {
    const nextOn = admitted(own(policy, 'wx.onUnhandledRejection'));
    const nextOff = admitted(own(policy, 'wx.offUnhandledRejection'));
    on = nextOn; off = nextOff;
    if (!on) { listeners = create(null); listenerCount = 0; generation += 1; }
    // Producer timing has not been certified against a fixed WeChat oracle.
    // Preserve Partial until that boundary and actual native tests are reviewed.
    put(policy, 'wx.onUnhandledRejection', on ? 'partial' : 'unsupported');
    put(policy, 'wx.offUnhandledRejection', off ? own(policy, 'wx.offUnhandledRejection') : 'unsupported');
  }
  function require(api, enabled) {
    if (enabled) return;
    const error = create(null); put(error, 'errMsg', api + ':fail unsupported');
    put(error, 'code', 'ERR_UNSUPPORTED_CAPABILITY'); put(error, 'api', api); throw error;
  }
  function add(callback) {
    require('wx.onUnhandledRejection', on);
    if (typeof callback !== 'function') throw new TypeErrorValue('listener must be a function');
    if (retired) throw new ErrorValue('unhandled rejection notifications are retired');
    for (let index = 0; index < listenerCount; index += 1) if (listeners[index] === callback) return;
    put(listeners, listenerCount++, callback);
  }
  function remove(callback) {
    require('wx.offUnhandledRejection', off);
    if (callback === undefined) { listeners = create(null); listenerCount = 0; return; }
    if (typeof callback !== 'function') throw new TypeErrorValue('listener must be a function');
    for (let index = 0; index < listenerCount; index += 1) {
      if (listeners[index] !== callback) continue;
      for (let next = index + 1; next < listenerCount; next += 1) listeners[next - 1] = listeners[next];
      delete listeners[--listenerCount]; return;
    }
  }
  function cancel(records, count, promise) {
    for (let index = 0; index < count; index += 1) {
      const entry = records[index];
      if (entry.active && entry.promise === promise) { entry.active = false; return true; }
    }
    return false;
  }
  function capturing() {
    return typeof __container_conformance_exceptions !== "undefined" && __container_conformance_exceptions && __container_conformance_exceptions.active();
  }
  function track(promise, reason, handled) {
    if (retired && !capturing()) return;
    if (handled) {
      cancel(pending, pendingCount, promise);
      if (captured) cancel(captured, capturedCount, promise);
      return;
    }
    for (let index = 0; index < pendingCount; index += 1) {
      const entry = pending[index]; if (entry.active && entry.promise === promise) return;
    }
    // Compact handled entries before admitting another retained value. A full
    // registry fails the native checkpoint explicitly; it never silently drops.
    let active = 0;
    for (let index = 0; index < pendingCount; index += 1) {
      if (pending[index].active) put(pending, active++, pending[index]);
    }
    for (let index = active; index < pendingCount; index += 1) delete pending[index];
    pendingCount = active;
    if (pendingCount + capturedCount >= maxPending) throw new ErrorValue('unhandled rejection capture budget exceeded');
    const entry = create(null); entry.promise = promise; entry.reason = reason; entry.active = true;
    put(pending, pendingCount++, entry);
  }
  function invoke(callback, receiver, entry) {
    // Keep the native Promise and arbitrary reason identities. JSON/string
    // projection would destroy Error objects and primitive rejection values.
    const event = {}; put(event, 'promise', entry.promise); put(event, 'reason', entry.reason);
    try {
      __container_turn_scheduler.withCapturedOwner(null, function() { apply(callback, receiver, [event]); });
    } catch (error) { try { report(error); } catch (_) {} }
  }
  function flush() {
    if (flushing || (retired && !capturing())) return;
    flushing = true; captured = pending; capturedCount = pendingCount;
    pending = create(null); pendingCount = 0;
    try {
      for (let index = 0; index < capturedCount; index += 1) {
        const entry = captured[index];
        if (retired && !capturing()) break;
        if (!entry.active) continue;
        entry.active = false;
        __container_error_notifications.capture(entry.reason);
        if (retired) continue;
        const snapshot = create(null), count = listenerCount, admittedGeneration = generation;
        for (let next = 0; next < count; next += 1) put(snapshot, next, listeners[next]);
        const receiver = app;
        try {
          const hook = receiver && receiver.onUnhandledRejection;
          if (!retired && typeof hook === 'function') invoke(hook, receiver, entry);
        } catch (error) { try { report(error); } catch (_) {} }
        for (let next = 0; next < count; next += 1) {
          if (retired || !on || generation !== admittedGeneration) break;
          invoke(snapshot[next], root, entry);
        }
      }
    } finally { captured = null; capturedCount = 0; flushing = false; }
  }
  function bindApp(receiver) { if (!retired) app = receiver; }
  function retire() {
    retired = true; generation += 1; listeners = create(null); listenerCount = 0;
    // Retire public delivery immediately. The native proof interval remains
    // live through the final checkpoint, including promises created by unload.
    // Preserve handled-cancellation until that checkpoint; never guess early.
    app = null;
    if (!capturing()) {
      pending = create(null); pendingCount = 0;
      if (captured) for (let index = 0; index < capturedCount; index += 1) captured[index].active = false;
    }
  }
  put(wx, 'onUnhandledRejection', function(callback) { add(callback); });
  put(wx, 'offUnhandledRejection', function(callback) { remove(callback); });
  install(__container_capabilities);
  return { install: install, bindApp: bindApp, retire: retire, track: track, flush: flush };
})();
