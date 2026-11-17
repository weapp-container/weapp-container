// Installed only in the testing distribution, before the timer scheduler.
// The control function is retained by Rust and never published to the guest.
(function() {
  const NativeDate = Date;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const construct = Reflect.construct;
  const nativeNow = NativeDate.now;
  const performanceNow = globalThis.__container_host_performance_now;
  let current = null;
  let origin = null;
  let timerReady;
  let invokePage;
  let invokeComponent;
  const receivers = new Map();
  let nextReceiver = 0;
  function now() { return current === null ? nativeNow() : current; }
  function ControlledDate(...args) {
    if (!new.target) return new NativeDate(now()).toString();
    return construct(NativeDate, args.length ? args : [now()], new.target);
  }
  Object.setPrototypeOf(ControlledDate, NativeDate);
  ControlledDate.prototype = NativeDate.prototype;
  ControlledDate.now = now;
  globalThis.Date = ControlledDate;
  // Keep the scheduler's private native clock real. Only guest observations
  // of elapsed time follow the virtual session clock.
  globalThis.performance = Object.freeze({
    now() { return current === null ? performanceNow() : current - origin; },
    get timeOrigin() { return origin === null ? now() - performanceNow() : origin; }
  });
  return function(encoded) {
    const input = parse(encoded);
    let value;
    if (input.action === 'bind') {
      timerReady = globalThis.__container_scheduler_timer_ready;
    } else if (input.action === 'bindMethods') {
      invokePage = globalThis.__container_invoke_page_instance;
      invokeComponent = globalThis.__container_invoke_component;
    } else if (input.action === 'clock') {
      if (!Number.isSafeInteger(input.now) || input.now < 0 || (current !== null && input.now < current)) {
        throw new RangeError('test clock must be a nonnegative, monotonic safe integer');
      }
      if (origin === null) origin = input.now;
      current = input.now;
      value = current;
    } else if (input.action === 'pending') {
      value = timerReady();
    } else if (input.action === 'component') {
      const receiver = globalThis.__container_component_scopes[input.scope];
      if (!receiver || receiver.__container_disposed) throw new Error('component instance was retired');
      value = String(++nextReceiver);
      receivers.set(value, { receiver, scope: input.scope, pageId: input.pageId });
    } else {
      const saved = input.receiver == null ? null : receivers.get(input.receiver);
      if (input.receiver != null && (!saved || saved.pageId !== input.pageId || globalThis.__container_component_scopes[saved.scope] !== saved.receiver)) {
        throw new Error('component instance was retired');
      }
      const receiver = saved ? saved.receiver : globalThis.__container_page_instances[String(input.pageId)];
      if (!receiver || receiver.__container_disposed) throw new Error('page instance was retired');
      if (input.action === 'call') {
        if (typeof receiver[input.method] !== 'function') throw new Error('page method not found: ' + input.method);
        value = saved
          ? invokeComponent(receiver.__container_component_index, input.method, input.args || [])
          : invokePage(input.pageId, receiver.__container_page_index, input.method, input.args || []);
        if (value && typeof value.then === 'function') throw new TypeError('callMethod returns synchronous values; observe asynchronous effects with flush');
      } else if (input.action === 'data') {
        value = receiver.data;
      } else throw new Error('unknown testing action');
    }
    return stringify({ present: value !== undefined, value: value });
  };
})()
