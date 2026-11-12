// One AppService owns these route channels. Native navigation binds a request
// to its actual page instance before onLoad; functions never cross the wire.
const __container_event_channels = (function() {
  const create = Object.create, define = Object.defineProperty, keys = Object.keys;
  const isArray = Array.isArray, text = String, apply = Reflect.apply;
  const stringify = JSON.stringify, parse = JSON.parse;
  const get = Function.prototype.call.bind(WeakMap.prototype.get);
  const set = Function.prototype.call.bind(WeakMap.prototype.set);
  const splice = Function.prototype.call.bind(Array.prototype.splice);
  const setPrototype = Object.setPrototypeOf;
  function queueArray() { return setPrototype([], null); }
  function copy(array) {
    const result = queueArray();
    for (let index = 0; index < array.length; index++) result[index] = array[index];
    return result;
  }
  function property(object, key, value, writable, enumerable, configurable) {
    const descriptor = create(null);
    descriptor.value=value; descriptor.writable=writable; descriptor.enumerable=enumerable; descriptor.configurable=configurable;
    define(object,key,descriptor);
  }
  const owners = new WeakMap(), opened = new WeakMap(), retired = new WeakSet();
  const isRetired = Function.prototype.call.bind(WeakSet.prototype.has);
  const markRetired = Function.prototype.call.bind(WeakSet.prototype.add);
  const pending = create(null), empty = Object.freeze(create(null));
  let live = 0;
  function error(message, code) {
    return {code:code || "ERR_INVALID_REQUEST", api:"EventChannel", errMsg:"EventChannel:fail " + message};
  }
  function name(value) {
    if (typeof value !== "string" || !value.length || value.length > 1024) throw error("invalid event name");
    return value;
  }
  function retain(owner, state) {
    if (!owner || typeof owner !== "object") return;
    if (isRetired(retired, owner)) throw error("page has unloaded", "ERR_PAGE_UNLOADED");
    let list = get(owners, owner);
    if (!list) { list = queueArray(); set(owners, owner, list); }
    list[list.length] = state;
    state.owners[state.owners.length] = owner;
  }
  function close(state) {
    if (state.closed) return;
    state.closed = true;
    for (let index = 0; index < state.owners.length; index++) {
      const list = get(owners, state.owners[index]);
      if (!list) continue;
      for (let at = list.length - 1; at >= 0; at--) if (list[at] === state) splice(list, at, 1);
    }
    state.owners = queueArray();
    state.listeners = create(null);
    state.queue = create(null);
    state.queued = state.count = 0;
    live--;
  }
  function check(state) {
    if (state.closed) throw error("page has unloaded", "ERR_PAGE_UNLOADED");
  }
  function report(failure) { try { __container_report_error(failure); } catch (_) {} }
  function dispatch(state, event, args) {
    const listeners = state.listeners[event];
    let found = false;
    if (listeners) {
      // Snapshot the current registration frontier. A once listener retires
      // before invocation so recursive emits cannot invoke it a second time.
      const frontier = copy(listeners);
      for (let index = 0; index < frontier.length && !state.closed; index++) {
        const listener = frontier[index];
        if (!listener.active) continue;
        found = true;
        if (listener.once) { listener.active = false; state.count--; }
        try {
          __container_turn_scheduler.withCapturedOwner(listener.owner, function() { apply(listener.fn, state.channel, args); });
        } catch (failure) { report(failure); }
      }
      const current = state.listeners[event];
      if (current) {
        for (let index = current.length - 1; index >= 0; index--) if (!current[index].active) splice(current, index, 1);
        if (!current.length) delete state.listeners[event];
      }
    }
    if (!found && !state.closed) {
      if (state.queued >= 64) throw error("pending event limit exceeded", "ERR_RESOURCE_LIMIT");
      const queue = state.queue[event] || (state.queue[event] = queueArray());
      queue[queue.length] = args;
      state.queued++;
    }
  }
  function listen(state, event, fn, once) {
    check(state); name(event);
    if (typeof fn !== "function") throw error("listener must be a function");
    if (state.count >= 128) throw error("listener limit exceeded", "ERR_RESOURCE_LIMIT");
    const list = state.listeners[event] || (state.listeners[event] = queueArray());
    // The listener's registration frame is independent of the later emitter.
    // Keep this snapshot private alongside the existing listener lifecycle.
    list[list.length] = {fn:fn, once:once, active:true, owner:__container_turn_scheduler.captureOwner()}; state.count++;
    const queue = state.queue[event];
    if (queue) {
      delete state.queue[event]; state.queued -= queue.length;
      for (let index = 0; index < queue.length && !state.closed; index++) dispatch(state, event, queue[index]);
    }
  }
  function make(owner) {
    if (live >= 256) throw error("active channel limit exceeded", "ERR_RESOURCE_LIMIT");
    const state = create(null);
    state.listeners=create(null);state.queue=create(null);state.owners=queueArray();state.count=0;state.queued=0;state.closed=false;state.depth=0;
    const channel = create(null); state.channel = channel;
    channel.emit = function(event, ...args) {
      check(state); name(event);
      if (args.length > 32) throw error("argument limit exceeded", "ERR_RESOURCE_LIMIT");
      if (state.depth >= 64) throw error("dispatch depth exceeded", "ERR_RESOURCE_LIMIT");
      state.depth++;
      try { dispatch(state, event, args); } finally { state.depth--; }
    };
    channel.on = function(event, fn) { listen(state, event, fn, false); };
    channel.once = function(event, fn) { listen(state, event, fn, true); };
    channel.off = function(event, fn) {
      check(state); name(event);
      if (fn !== undefined && typeof fn !== "function") throw error("listener must be a function");
      const list = state.listeners[event];
      if (!list) return;
      for (let index = list.length - 1; index >= 0; index--) {
        const listener = list[index];
        if (fn === undefined || listener.fn === fn) {
          if (listener.active) state.count--;
          listener.active = false; splice(list, index, 1);
        }
      }
      if (!list.length) delete state.listeners[event];
    };
    live++;
    try { retain(owner, state); } catch (failure) { close(state); throw failure; }
    return state;
  }
  function currentPage() {
    const active = __container_observer_owner(null);
    if (active && !active.__container_is_component) return active;
    if (active && active.__container_page_id != null) return __host_page_lookup(text(active.__container_page_id));
    const pages = __host_current_pages === null ? globalThis.__container_current_page_instances : __host_current_pages;
    if (pages && pages.length) return pages[pages.length - 1];
    return null;
  }
  return {
    prepare:function(options, owner) {
      try {
        const encoded = stringify(options);
        if (typeof encoded !== "string" || encoded.length > 1048576) throw null;
        const value = parse(encoded);
        if (!value || typeof value !== "object" || isArray(value)) throw null;
        const prepared = create(null); prepared.options = value;
        if (owner !== undefined) prepared.owner = parse(stringify(owner));
        return prepared;
      } catch (_) { throw error("options are not serializable"); }
    },
    discard:function(id) {
      const key=text(id), state=pending[key];
      if (state) { delete pending[key]; close(state); }
    },
    start:function(id, options) {
      const events = options.events;
      if (events !== undefined && (!events || typeof events !== "object" || isArray(events))) throw error("events must be an object");
      const names = events === undefined ? [] : keys(events);
      if (names.length > 128) throw error("listener limit exceeded", "ERR_RESOURCE_LIMIT");
      // Validate before allocation: an invalid options.events cannot leak one
      // active channel or partially register callbacks.
      for (let index = 0; index < names.length; index++) {
        name(names[index]);
        if (typeof events[names[index]] !== "function") throw error("listener must be a function");
      }
      const state = make(currentPage());
      try {
        for (let index = 0; index < names.length; index++) listen(state, names[index], events[names[index]], false);
        pending[text(id)] = state;
      } catch (failure) { close(state); throw failure; }
    },
    bind:function(id, pageId) {
      const state = pending[text(id)];
      if (!state) return false;
      check(state);
      const page = __host_page_receiver(text(pageId));
      if (!page || get(opened, page)) throw error("invalid target page");
      retain(page, state); set(opened, page, state);
      return true;
    },
    settle:function(id, failed, value) {
      const key = text(id), state = pending[key];
      if (!state) return {failed:failed,value:value};
      delete pending[key];
      if (failed) { close(state); return {failed:true,value:value}; }
      if (state.closed) return {failed:true,value:error("page has unloaded", "ERR_PAGE_UNLOADED")};
      if (!value || typeof value !== "object" || isArray(value)) { close(state); return {failed:true,value:error("invalid navigation result", "ERR_INVALID_RESPONSE")}; }
      property(value,"eventChannel",state.channel,true,true,true);
      return {failed:false,value:value};
    },
    install:function(page) {
      property(page,"getOpenerEventChannel",function() {
        if (isRetired(retired, this)) throw error("page has unloaded", "ERR_PAGE_UNLOADED");
        const receiver = this && this.__container_is_component && this.__container_page_id != null
          ? __host_page_lookup(text(this.__container_page_id)) : this;
        const state = receiver && get(opened, receiver);
        return state ? state.channel : empty;
      },false,false,false);
    },
    retire:function(page) {
      if (!page || typeof page !== "object") return;
      markRetired(retired, page);
      const list = get(owners, page);
      if (list) {
        const frontier = copy(list);
        for (let index = 0; index < frontier.length; index++) close(frontier[index]);
      }
    }
  };
})();
