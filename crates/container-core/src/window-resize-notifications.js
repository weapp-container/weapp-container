// One realm-owned listener registry receives actual committed host geometry.
// No guest alias, page incarnation, diagnostic queue or host subscription owns it.
const __container_window_resize = (function() {
  const apply = Reflect.apply;
  const create = Object.create;
  const define = Object.defineProperty;
  const getOwn = Object.getOwnPropertyDescriptor;
  const string = String;
  const isInteger = Number.isInteger;
  const TypeErrorValue = TypeError;
  const ErrorValue = Error;
  const root = globalThis;
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
  function clear(invalidate) {
    callbacks = create(null);
    length = 0;
    if (invalidate) generation += 1;
  }
  function enabled(value) { return value === 'full' || value === 'partial'; }
  function install(policy) {
    // Installation is host-owned. Neither a forged public capability map nor
    // a saved public function can restore admission after trusted withdrawal.
    on = enabled(own(policy, 'wx.onWindowResize'));
    off = enabled(own(policy, 'wx.offWindowResize'));
    if (!on) clear(true);
    put(policy, 'wx.onWindowResize', on ? own(policy, 'wx.onWindowResize') : 'unsupported');
    put(policy, 'wx.offWindowResize', off ? own(policy, 'wx.offWindowResize') : 'unsupported');
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
    require('wx.onWindowResize', on);
    if (typeof callback !== 'function') throw new TypeErrorValue('callback must be a function');
    if (retired) throw new ErrorValue('window-resize notifications are retired');
    for (let index = 0; index < length; index += 1) if (callbacks[index] === callback) return;
    put(callbacks, string(length++), callback);
  }
  function remove(callback) {
    require('wx.offWindowResize', off);
    if (callback === undefined) { clear(); return; }
    if (typeof callback !== 'function') throw new TypeErrorValue('callback must be a function');
    for (let index = 0; index < length; index += 1) {
      if (callbacks[index] !== callback) continue;
      for (let next = index + 1; next < length; next += 1) callbacks[next - 1] = callbacks[next];
      delete callbacks[--length];
      return;
    }
  }
  function event(width, height) {
    const value = {}, size = {};
    put(size, 'windowWidth', width);
    put(size, 'windowHeight', height);
    put(value, 'size', size);
    return value;
  }
  function dispatch(payload) {
    if (retired || !on) return false;
    const size = own(payload, 'size');
    const width = own(size, 'windowWidth'), height = own(size, 'windowHeight');
    if (!isInteger(width) || !isInteger(height) || width <= 0 || height <= 0) return false;
    const pending = create(null);
    const count = length;
    for (let index = 0; index < count; index += 1) put(pending, string(index), callbacks[index]);
    const admitted = generation;
    for (let index = 0; index < count; index += 1) {
      // Ordinary on/off mutation keeps this dispatch snapshot. Trusted policy
      // revocation and terminal owner retirement cancel its remaining tail.
      if (retired || !on || generation !== admitted) break;
      try {
        __container_turn_scheduler.withCapturedOwner(null, function() {
          apply(pending[index], root, [event(width, height)]);
        });
      } catch (error) { try { report(error); } catch (_) {} }
    }
    return true;
  }
  function retire() {
    retired = true;
    clear(true);
  }
  put(wx, 'onWindowResize', add);
  put(wx, 'offWindowResize', remove);
  install(__container_capabilities);
  return { dispatch: dispatch, install: install, retire: retire };
})();
