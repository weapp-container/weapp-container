// App-wide notifications belong to this realm, independently of Page hooks.
// Native code retains dispatch before any application runs; public diagnostic
// aliases and page properties never choose the receiver supplied to callbacks.
const __container_lifecycle_notifications = (function() {
  const apply = Reflect.apply;
  const splice = Function.prototype.call.bind(Array.prototype.splice);
  const slice = Function.prototype.call.bind(Array.prototype.slice);
  const weakGet = Function.prototype.call.bind(WeakMap.prototype.get);
  const weakSet = Function.prototype.call.bind(WeakMap.prototype.set);
  const weakDelete = Function.prototype.call.bind(WeakMap.prototype.delete);
  const TypeErrorValue = TypeError, ErrorValue = Error;
  const states = new WeakMap();
  const lists = __host_create(null);
  const pending = __host_create(null);
  const admitted = __host_create(null);
  const generations = __host_create(null);
  const apiNames = __host_create(null);
  const entries = [['AppShow', 'show'], ['AppHide', 'hide'], ['BeforePageUnload', 'beforePageUnload'], ['AfterPageUnload', 'afterPageUnload']];
  let session = false;
  let retired = false;
  for (const entry of entries) {
    lists[entry[1]] = Object.setPrototypeOf([], null);
    generations[entry[1]] = 0;
    apiNames[entry[1]] = ['wx.on' + entry[0], 'wx.off' + entry[0]];
  }
  function put(object, key, value) {
    const descriptor = __host_create(null);
    descriptor.value = value;
    descriptor.writable = descriptor.enumerable = descriptor.configurable = true;
    __host_define(object, key, descriptor);
  }
  function own(object, key) {
    if (!object || typeof object !== 'object') return undefined;
    const descriptor = __host_get_own(object, key);
    return descriptor && __host_get_own(descriptor, 'value') ? descriptor.value : undefined;
  }
  function enabled(value) { return value === 'full' || value === 'partial'; }
  function install(policy) {
    const grades = __host_create(null);
    // Complete private admission changes precede policy projection. Withdrawal
    // belongs only to this event's public list, never route pending/states.
    for (let index = 0; index < entries.length; index += 1) {
      const name = entries[index][1], pair = apiNames[name];
      const on = own(policy, pair[0]), off = own(policy, pair[1]);
      put(grades, pair[0], on); put(grades, pair[1], off);
      put(admitted, pair[0], enabled(on)); put(admitted, pair[1], enabled(off));
      if (!enabled(on)) { lists[name].length = 0; generations[name] += 1; }
    }
    for (let index = 0; index < entries.length; index += 1) {
      const pair = apiNames[entries[index][1]];
      put(policy, pair[0], admitted[pair[0]] ? grades[pair[0]] : 'unsupported');
      put(policy, pair[1], admitted[pair[1]] ? grades[pair[1]] : 'unsupported');
    }
  }
  function require(api) {
    if (admitted[api]) return;
    const error = __host_create(null);
    put(error, 'errMsg', api + ':fail unsupported');
    put(error, 'code', 'ERR_UNSUPPORTED_CAPABILITY'); put(error, 'api', api);
    throw error;
  }
  function livePage(id) {
    const identity = own(__receiver_pages, id);
    const page = identity && identity.receiver;
    return identity && !identity.retired && identity.pageId === id && identity.scopeId === null
      && weakGet(__receiver_weak, page) === identity ? page : undefined;
  }
  function pageForHook(id, index) {
    const page = livePage(__host_string(id));
    if (page) return page;
    if (session) throw new ErrorValue('native page receiver unavailable');
    // Standalone engines also support invoking a Page definition before any
    // concrete host stack exists. Session hooks always require an incarnation.
    return own(__host_page_definitions, __host_string(index));
  }
  function add(name, callback) {
    require(apiNames[name][0]);
    if (typeof callback !== 'function') throw new TypeErrorValue('listener must be a function');
    if (retired) throw new ErrorValue('application notifications are retired');
    const list = lists[name];
    for (let i = 0; i < list.length; i += 1) if (list[i] === callback) return;
    put(list, __host_string(list.length), callback);
  }
  function remove(name, callback) {
    require(apiNames[name][1]);
    const list = lists[name];
    if (callback === undefined) { splice(list, 0, list.length); return; }
    if (typeof callback !== 'function') throw new TypeErrorValue('listener must be a function');
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] === callback) { splice(list, i, 1); return; }
    }
  }
  function report(error) {
    try { __container_report_error(error); } catch (_) {}
  }
  function pageUnloadError(error) {
    // Standalone JsEngine callers retain their original exception contract.
    // Session owns the committed transition and finishes retirement itself.
    if (!session) throw error;
    report(error);
    return null;
  }
  function emit(name, event) {
    if (retired || !admitted[apiNames[name][0]]) return;
    const callbacks = slice(lists[name]);
    const generation = generations[name];
    for (let i = 0; i < callbacks.length; i += 1) {
      if (retired || !admitted[apiNames[name][0]] || generations[name] !== generation) break;
      try {
        __container_turn_scheduler.withCapturedOwner(null, function() { apply(callbacks[i], __receiver_global, [event()]); });
      }
      catch (error) { report(error); }
    }
    if (callbacks.length) {
      // This is a trace only. Queue tampering cannot prevent notification.
      try { put(__container_events, __host_string(__container_events.length), { type: 'app.listener', name: name, count: callbacks.length }); }
      catch (_) {}
    }
  }
  function unloadEvent(record, before) {
    const event = {};
    put(event, 'path', record.path);
    put(event, 'routeEventId', record.routeEventId);
    if (before) put(event, 'page', record.page);
    return event;
  }
  function dispatch(name, payload) {
    if (name === 'session') { session = true; __container_media_queries.session(); __container_intersections.session(); __container_selector_queries.enable(); __container_owned_canvases.enable(); return true; }
    if (name === 'retire') {
      retired = true;
      for (let index = 0; index < entries.length; index += 1) {
        const name = entries[index][1]; lists[name].length = 0; generations[name] += 1;
      }
      __container_turn_scheduler.retire();
      __container_buffer_urls.retire();
      __container_routes.retire();
      __container_error_notifications.retire();
      __container_page_not_found.retire();
      __container_unhandled_rejections.retire();
      __container_window_resize.retire();
      __container_host_layout.retire();
      __container_finite_notifications.retire();
      __container_log_manager.retire();
      __container_performance.retire();
      __container_media_queries.retire();
      __container_intersections.retire();
      __container_selector_queries.retire();
      __container_owned_canvases.retire();
      const keys = __host_keys(pending);
      for (let i = 0; i < keys.length; i += 1) delete pending[keys[i]];
      return true;
    }
    if (retired) return false;
    if (name === 'windowResize') return __container_window_resize.dispatch(payload);
    if (name === 'hostLayoutChange') return __container_host_layout.dispatch(payload);
    if (name === 'mediaQuery') return __container_media_queries.dispatch(payload);
    if (name === 'intersectionReject') return __container_intersections.reject(payload);
    if (name === 'intersectionQuery') return __container_intersections.dispatch(payload);
    if (name === 'selectorQuery') return __container_selector_queries.deliver(payload);
    if (name === 'ownedCanvas') return __container_owned_canvases.deliver(payload);
    if (name === 'show' || name === 'hide') {
      __container_turn_scheduler.visibility(name === 'show');
      emit(name, function() { return payload; });
      return true;
    }
    const id = own(payload, 'pageId');
    const path = own(payload, 'path');
    const routeEventId = own(payload, 'routeEventId');
    if (typeof id !== 'string' || typeof path !== 'string' || typeof routeEventId !== 'string' || !routeEventId) return false;
    if (name === 'beforePageUnload') {
      const page = livePage(id);
      const identity = page && weakGet(__receiver_weak, page);
      if (!identity || identity.retired || identity.pageId !== id || identity.scopeId !== null || weakGet(states, page)) return false;
      const record = __host_create(null);
      record.page = page;
      record.identity = identity;
      record.path = path;
      record.routeEventId = routeEventId;
      record.finished = false;
      // Consume before callbacks, including callbacks which throw or navigate.
      weakSet(states, page, record);
      put(pending, id, record);
      emit(name, function() { return unloadEvent(record, true); });
      return true;
    }
    if (name === 'cancelPageUnload') {
      const record = own(pending, id);
      if (!record || record.finished || record.path !== path || record.routeEventId !== routeEventId
          || record.identity.retired || livePage(id) !== record.page) return false;
      // A failed structural transition leaves this incarnation live. Release
      // only that attempt so a later route obtains its own before/after ID.
      delete pending[id];
      weakDelete(states, record.page);
      return true;
    }
    if (name === 'afterPageUnload') {
      const record = own(pending, id);
      if (!record || record.finished || record.path !== path || record.routeEventId !== routeEventId
          || !record.identity.retired || weakGet(__receiver_weak, record.page) !== record.identity) return false;
      record.finished = true;
      delete pending[id];
      emit(name, function() { return unloadEvent(record, false); });
      return true;
    }
    return false;
  }
  for (const entry of entries) {
    put(wx, 'on' + entry[0], function(callback) { add(entry[1], callback); });
    put(wx, 'off' + entry[0], function(callback) { remove(entry[1], callback); });
  }
  // Standalone engine embedders retain their original callable hook contract.
  // Session mode uses the native dispatcher after the App hook, including its
  // error path, so mutable compatibility globals cannot suppress listeners.
  const invoke = globalThis.__container_invoke_app;
  globalThis.__container_invoke_app = function(name, args) {
    let hookFailed = false;
    try { return apply(invoke, __receiver_global, [name, args]); }
    catch (error) { hookFailed = true; throw error; }
    finally {
      if (!session && (name === 'onShow' || name === 'onHide')) {
        try { dispatch(name === 'onShow' ? 'show' : 'hide', args && args.length ? args[0] : {}); }
        catch (error) { if (hookFailed) report(error); else throw error; }
      }
    }
  };
  install(__container_capabilities);
  return { install: install, dispatch: dispatch, pageForHook: pageForHook, pageUnloadError: pageUnloadError };
})();
