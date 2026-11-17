// Native-retained turn scheduling. Public wx methods never carry host authority.
const __container_turn_scheduler = (function() {
  const apply = Reflect.apply;
  const create = Object.create;
  const define = Object.defineProperty;
  const getOwn = Object.getOwnPropertyDescriptor;
  const read = Reflect.get;
  const weakGet = Function.prototype.call.bind(WeakMap.prototype.get);
  const finite = Number.isFinite;
  const integer = Number.isSafeInteger;
  const TypeErrorValue = TypeError;
  const RangeErrorValue = RangeError;
  const ErrorValue = Error;
  const root = globalThis;
  const clockFunction = __host_scheduler_clock;
  const runApiOwner = root.__container_run_with_api_owner;
  const timerReady = root.__container_scheduler_timer_ready;
  delete root.__container_scheduler_timer_ready;
  const maximumPending = 1024;
  const maximumDispatch = 64;
  const tasks = create(null);
  let head = null;
  let tail = null;
  let count = 0;
  let nextId = 0;
  let lastClock = 0;
  let active = null;
  let owner = null;
  let paused = false;
  let retired = false;
  let tickOn = false;
  let idleOn = false;
  let cancelOn = false;
  function own(value, key) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    const descriptor = getOwn(value, key);
    return descriptor && getOwn(descriptor, 'value') ? descriptor.value : undefined;
  }
  function put(value, key, item) {
    const descriptor = create(null);
    descriptor.value = item;
    descriptor.writable = descriptor.enumerable = descriptor.configurable = true;
    define(value, key, descriptor);
  }
  function now() {
    if (typeof clockFunction !== 'function') throw new ErrorValue('native scheduler clock unavailable');
    const value = apply(clockFunction, root, []);
    if (typeof value !== 'number' || !finite(value) || value < 0 || value > 9007199254740991) {
      throw new RangeErrorValue('invalid native scheduler clock');
    }
    if (value > lastClock) lastClock = value;
    return lastClock;
  }
  function live(entry) {
    if (!entry) return true;
    if (entry.retired || weakGet(__receiver_weak, entry.receiver) !== entry) return false;
    const page = own(__receiver_pages, entry.pageId);
    if (!page || page.retired || page.token !== (entry.scopeId === null ? entry.token : entry.pageToken)) return false;
    return entry.scopeId === null || own(__receiver_scopes, entry.scopeId) === entry;
  }
  function withCapturedOwner(entry, thunk) {
    const previous = owner;
    owner = entry;
    try { return apply(runApiOwner, root, [entry ? entry.receiver : null, thunk]); }
    finally { owner = previous; }
  }
  function withOwner(receiver, thunk) {
    const previous = owner;
    owner = receiver && (typeof receiver === 'object' || typeof receiver === 'function')
      ? weakGet(__receiver_weak, receiver) || null : null;
    try { return apply(runApiOwner, root, [receiver, thunk]); }
    finally { owner = previous; }
  }
  function invokeOwned(receiver, callback, args) {
    return withOwner(receiver, function() { return apply(callback, receiver, args || []); });
  }
  function remove(record) {
    if (tasks[record.id] !== record) return;
    if (record.previous) record.previous.next = record.next;
    else head = record.next;
    if (record.next) record.next.previous = record.previous;
    else tail = record.previous;
    delete tasks[record.id];
    count -= 1;
    record.previous = record.next = null;
  }
  function prune(kind) {
    let record = head;
    while (record) {
      const next = record.next;
      if ((kind && record.kind === kind) || !live(record.owner)) remove(record);
      record = next;
    }
  }
  function unsupported(name) {
    const failure = create(null);
    put(failure, 'errMsg', name + ':fail unsupported');
    put(failure, 'code', 'ERR_UNSUPPORTED_CAPABILITY');
    put(failure, 'api', name);
    throw failure;
  }
  function register(kind, callback, options) {
    if (retired) throw new ErrorValue('turn scheduler is retired');
    if (kind === 'tick' ? !tickOn : !idleOn) unsupported(kind === 'tick' ? 'wx.nextTick' : 'wx.requestIdleCallback');
    if (typeof callback !== 'function') throw new TypeErrorValue('callback must be a function');
    let deadline = null;
    const admittedOwner = owner;
    if (kind === 'idle') {
      if (options !== undefined && (options === null || typeof options !== 'object')) throw new TypeErrorValue('idle options must be an object');
      const timeout = options === undefined ? undefined : read(options, 'timeout');
      if (timeout !== undefined && (typeof timeout !== 'number' || !finite(timeout) || timeout < 0 || timeout > 9007199254740991)) {
        throw new RangeErrorValue('idle timeout must be a finite non-negative number');
      }
      const current = now();
      if (timeout !== undefined) deadline = current + timeout;
      if (deadline !== null && (!finite(deadline) || deadline > 9007199254740991)) throw new RangeErrorValue('idle timeout is out of range');
    }
    // Documented option getters may reenter a trusted callback. Recheck admission after
    // validation and keep the original private synchronous owner snapshot.
    if (retired) throw new ErrorValue('turn scheduler is retired');
    if (kind === 'tick' ? !tickOn : !idleOn) unsupported(kind === 'tick' ? 'wx.nextTick' : 'wx.requestIdleCallback');
    prune(null);
    if (count >= maximumPending) throw new RangeErrorValue('turn scheduler pending task budget exceeded');
    if (nextId >= 9007199254740991) throw new RangeErrorValue('turn scheduler identifiers exhausted');
    const record = create(null);
    record.id = ++nextId;
    record.kind = kind;
    record.callback = callback;
    record.deadline = deadline;
    record.owner = admittedOwner;
    record.previous = tail;
    record.next = null;
    if (tail) tail.next = record; else head = record;
    tail = record;
    tasks[record.id] = record;
    count += 1;
    return record.id;
  }
  function cancel(id) {
    if (!cancelOn) unsupported('wx.cancelIdleCallback');
    if (typeof id !== 'number' || !integer(id) || id < 1) throw new TypeErrorValue('idle callback identifier must be a positive safe integer');
    const record = tasks[id];
    if (record && record.kind === 'idle') remove(record);
  }
  function install(policy) {
    function enabled(name) { const value = own(policy, name); return value === 'partial' || value === 'full'; }
    tickOn = enabled('wx.nextTick');
    idleOn = enabled('wx.requestIdleCallback');
    cancelOn = enabled('wx.cancelIdleCallback');
    if (!tickOn) prune('tick');
    if (!idleOn) prune('idle');
    put(policy, 'wx.nextTick', tickOn ? 'partial' : 'unsupported');
    put(policy, 'wx.requestIdleCallback', idleOn ? 'partial' : 'unsupported');
    // Cancellation owns the actual pending record; an incomplete idle producer
    // does not lower this method's independent manifest/host/provider minimum.
    const cancelSupport = own(policy, 'wx.cancelIdleCallback') === 'full' ? 'full' : 'partial';
    put(policy, 'wx.cancelIdleCallback', cancelOn ? cancelSupport : 'unsupported');
  }
  function pendingTick() {
    let record = head;
    while (record) { if (record.kind === 'tick' && live(record.owner)) return true; record = record.next; }
    return false;
  }
  function begin(request) {
    if (active) throw new ErrorValue('scheduler poll is already active');
    const limit = own(request, 'limit');
    const budget = own(request, 'idleBudgetMs');
    if (!integer(limit) || limit < 1 || limit > maximumDispatch) throw new RangeErrorValue('invalid scheduler dispatch limit');
    if (budget !== null && (typeof budget !== 'number' || !finite(budget) || budget <= 0 || budget > 50)) throw new RangeErrorValue('invalid idle opportunity budget');
    prune(null);
    const turn = create(null);
    turn.ticks = create(null); turn.idles = create(null);
    turn.tickLength = 0; turn.idleLength = 0;
    turn.tickIndex = 0; turn.idleIndex = 0;
    turn.limit = limit; turn.called = 0; turn.didTick = false; turn.didIdle = false;
    turn.idleEnd = budget === null ? null : now() + budget;
    let record = head;
    while (record) {
      if (record.kind === 'tick') turn.ticks[turn.tickLength++] = record;
      else turn.idles[turn.idleLength++] = record;
      record = record.next;
    }
    active = turn;
    return '{"begun":true}';
  }
  function invoke(record, turn, timedOut) {
    remove(record);
    turn.called += 1;
    if (record.kind === 'tick') turn.didTick = true; else turn.didIdle = true;
    const args = [];
    if (record.kind === 'idle') {
      const result = create(null);
      put(result, 'errMsg', 'requestIdleCallback:ok');
      put(args, '0', result);
    }
    withOwner(record.owner && record.owner.receiver, function() {
      try { apply(record.callback, root, args); }
      catch (error) { try { __container_error_notifications.report(error); } catch (_) {} }
    });
    return '{"called":true,"kind":"' + (record.kind === 'tick' ? 'nextTick' : 'idle') + '","timedOut":' + (timedOut ? 'true' : 'false') + '}';
  }
  function task(request) {
    const turn = active;
    if (!turn) throw new ErrorValue('scheduler poll is not active');
    if (retired || paused || turn.called >= turn.limit || turn.didIdle) return '{"called":false}';
    while (turn.tickIndex < turn.tickLength) {
      const record = turn.ticks[turn.tickIndex++];
      if (tasks[record.id] !== record) continue;
      if (!live(record.owner)) { remove(record); continue; }
      return invoke(record, turn, false);
    }
    if (turn.idleLength === 0) return '{"called":false}';
    const current = now();
    const allowIdle = own(request, 'allowIdle') === true && turn.idleEnd !== null && current < turn.idleEnd
      && !turn.didTick && !pendingTick() && typeof timerReady === 'function' && !apply(timerReady, root, []);
    while (turn.idleIndex < turn.idleLength) {
      const record = turn.idles[turn.idleIndex++];
      if (tasks[record.id] !== record) continue;
      if (!live(record.owner)) { remove(record); continue; }
      const timedOut = record.deadline !== null && record.deadline <= current;
      if (timedOut || allowIdle) return invoke(record, turn, timedOut);
    }
    return '{"called":false}';
  }
  function capture(request) {
    const action = own(request, 'action');
    if (action === 'status') {
      prune(null);
      return '{"ready":' + (!retired && !paused && pendingTick() ? 'true' : 'false') + '}';
    }
    if (action === 'begin') return begin(request);
    if (action === 'task') return task(request);
    if (action === 'end') { active = null; return '{"ended":true}'; }
    throw new ErrorValue('invalid native scheduler action');
  }
  function retire() {
    retired = true;
    let record = head;
    while (record) { const next = record.next; remove(record); record = next; }
  }
  put(wx, 'nextTick', function(callback) { register('tick', callback); });
  put(wx, 'requestIdleCallback', function(callback, options) { return register('idle', callback, options); });
  put(wx, 'cancelIdleCallback', function(id) { cancel(id); });
  install(__container_capabilities);
  return { capture:capture, install:install, retire:retire, withOwner:withOwner, invokeOwned:invokeOwned,
    captureOwner:function() { return owner; },
    captureReceiverOwner:function(receiver) {
      return receiver && (typeof receiver === 'object' || typeof receiver === 'function')
        ? weakGet(__receiver_weak, receiver) || null : null;
    }, withCapturedOwner:withCapturedOwner,
    visibility:function(visible) { paused = !visible; } };
})();
