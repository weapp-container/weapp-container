// Dedicated LogManager producer; only the native journal owns retained records.
// Projection is a bounded, non-recursive own-descriptor graph, never console text.
const __container_log_manager = (function() {
  const writer = globalThis.__container_host_log_manager_write;
  delete globalThis.__container_host_log_manager_write;
  const create = Object.create, define = Object.defineProperty;
  const own = Object.getOwnPropertyDescriptor, keys = Reflect.ownKeys;
  const apply = Reflect.apply, json = JSON.stringify, string = String;
  const charCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt);
  const TypeErrorClass = TypeError;
  const isArray = Array.isArray, setPrototype = Object.setPrototypeOf;
  const WeakMapClass = WeakMap, MapClass = Map;
  const weakGet = Function.prototype.call.bind(WeakMap.prototype.get);
  const weakSet = Function.prototype.call.bind(WeakMap.prototype.set);
  const mapGet = Function.prototype.call.bind(Map.prototype.get);
  const mapSet = Function.prototype.call.bind(Map.prototype.set);
  const symbolDescription = own(Symbol.prototype, 'description').get;
  const abLength = own(ArrayBuffer.prototype, 'byteLength').get;
  const Bytes = Uint8Array;
  const mapEach = Map.prototype.forEach, setEach = Set.prototype.forEach;
  const dateTime = Date.prototype.getTime;
  const wrappers = new WeakMapClass();
  const error = __container_error;
  const policy = object();
  let retired = false, generation = 0;
  const limit = 102400;
  const budget = object();
  const admissionNames = list();
  push(admissionNames, 'wx.getLogManager');
  push(admissionNames, 'object:LogManager.debug');
  push(admissionNames, 'object:LogManager.info');
  push(admissionNames, 'object:LogManager.log');
  push(admissionNames, 'object:LogManager.warn');
  let active = false, automatic = false, writing = false;
  function put(target, key, value) {
    define(target, key, {__proto__:null,value:value,writable:true,enumerable:true,configurable:true});
  }
  function object() { return create(null); }
  function list() { return setPrototype([], null); }
  function push(target, value) { put(target, string(target.length), value); }
  function bytes(text) {
    let total = 0;
    for (let i = 0; i < text.length; i += 1) {
      const c = charCodeAt(text, i);
      if (c < 128) total += 1;
      else if (c < 2048) total += 2;
      else if (c >= 55296 && c <= 56319 && i + 1 < text.length && charCodeAt(text, i + 1) >= 56320 && charCodeAt(text, i + 1) <= 57343) { total += 4; i += 1; }
      else total += 3;
    }
    return total;
  }
  function safeText(value) {
    let malformed = false;
    for (let i = 0; i < value.length; i += 1) {
      const c = charCodeAt(value, i);
      if (c >= 55296 && c <= 56319) {
        const next = i + 1 < value.length ? charCodeAt(value, i + 1) : 0;
        if (next >= 56320 && next <= 57343) i += 1;
        else malformed = true;
      } else if (c >= 56320 && c <= 57343) malformed = true;
    }
    if (!malformed) return value;
    // Rust/JSON strings require Unicode scalar values. A tagged code-unit
    // encoding preserves malformed UTF16 instead of replacement characters.
    const encoded = object(), alphabet = '0123456789abcdef';
    let hex = '';
    for (let i = 0; i < value.length; i += 1) {
      const c = charCodeAt(value, i);
      hex += alphabet[(c >>> 12) & 15] + alphabet[(c >>> 8) & 15] + alphabet[(c >>> 4) & 15] + alphabet[c & 15];
    }
    put(encoded, 'utf16', hex);
    return encoded;
  }
  function project(args) {
    const graph = object(), roots = list(), nodes = list(), pending = list();
    const seen = new MapClass();
    let charged = 0;
    function add(value) {
      if (nodes.length >= 8192) throw budget;
      const type = typeof value;
      if ((value !== null && (type === 'object' || type === 'function')) || type === 'symbol') {
        const previous = mapGet(seen, value);
        if (previous !== undefined) return previous;
      }
      const id = nodes.length, node = object();
      push(nodes, node);
      put(node, 'type', value === null ? 'null' : type);
      if (value === null || type === 'undefined') return id;
      if (type === 'string') { charged += value.length; if (charged > limit) throw budget; put(node, 'value', safeText(value)); }
      else if (type === 'number') put(node, 'value', value !== value ? 'NaN' : value === 1/0 ? 'Infinity' : value === -1/0 ? '-Infinity' : value === 0 && 1/value < 0 ? '-0' : value);
      else if (type === 'boolean') put(node, 'value', value);
      else if (type === 'bigint') { const text = string(value); charged += text.length; if (charged > limit) throw budget; put(node, 'value', text); }
      else {
        mapSet(seen, value, id);
        if (type === 'symbol') { const description = apply(symbolDescription, value, []); if (description !== undefined) { charged += description.length; if (charged > limit) throw budget; put(node, 'description', safeText(description)); } }
        else push(pending, [value, node]);
      }
      return id;
    }
    for (let i = 0; i < args.length; i += 1) push(roots, add(args[i]));
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const value = pending[cursor][0], node = pending[cursor][1];
      const properties = list();
      put(node, 'properties', properties);
      try {
        if (isArray(value)) put(node, 'type', 'array');
        else {
          // Brand-check captured intrinsics; guest getters/toJSON never run.
          try {
            const length = apply(abLength, value, []), data = list(), view = new Bytes(value);
            if (length > limit) throw budget;
            for (let i = 0; i < length; i += 1) push(data, view[i]);
            put(node, 'type', 'arrayBuffer'); put(node, 'bytes', data);
          } catch (failure) { if (failure === budget) throw failure; }
          try { const entries = list(); apply(mapEach, value, [function(v, k) { const pair = list(); push(pair, add(k)); push(pair, add(v)); push(entries, pair); }]); put(node, 'type', 'map'); put(node, 'entries', entries); } catch (failure) { if (failure === budget) throw failure; }
          try { const entries = list(); apply(setEach, value, [function(v) { push(entries, add(v)); }]); put(node, 'type', 'set'); put(node, 'entries', entries); } catch (failure) { if (failure === budget) throw failure; }
          try { const time = apply(dateTime, value, []); put(node, 'type', 'date'); put(node, 'time', time === time ? time : 'NaN'); } catch (failure) { if (failure === budget) throw failure; }
        }
        const names = keys(value);
        if (names.length > 8192) throw budget;
        for (let i = 0; i < names.length; i += 1) {
          const key = names[i], descriptor = own(value, key);
          if (!descriptor) continue;
          const entry = object();
          put(entry, 'key', add(key));
          const data = own(descriptor, 'value');
          if (data) put(entry, 'value', add(data.value));
          else { put(entry, 'accessor', true); put(entry, 'get', typeof descriptor.get === 'function'); put(entry, 'set', typeof descriptor.set === 'function'); }
          put(entry, 'enumerable', descriptor.enumerable === true);
          push(properties, entry);
        }
      } catch (failure) { if (failure === budget) throw failure; put(node, 'uninspectable', true); }
    }
    put(graph, 'roots', roots); put(graph, 'nodes', nodes);
    const encoded = json(graph);
    return bytes(encoded) <= limit ? encoded : null;
  }
  function install(source) {
    generation += 1;
    for (let i = 0; i < admissionNames.length; i += 1) {
      const name = admissionNames[i];
      const descriptor = own(source, name), data = descriptor && own(descriptor, 'value');
      put(policy, name, !!data && (data.value === 'full' || data.value === 'partial'));
    }
  }
  // The captured native liveness check cannot be revived by trusted reinstallation
  // after host-only terminal retirement; it does not invoke guest code.
  function permitted(name) { return !retired && policy[name] === true && typeof writer === 'function' && writer() === true; }
  function retire() { generation += 1; retired = true; active = automatic = false; }
  function emit(level, kind, name, args) {
    if (!active || writing || !permitted('wx.getLogManager') || typeof writer !== 'function') return;
    writing = true;
    const admitted = generation;
    try {
      let argumentsJson;
      try { argumentsJson = project(args); } catch (_) { argumentsJson = null; }
      if (generation !== admitted || !permitted('wx.getLogManager')) return;
      // A rejected wire accounts a dropped record in the native journal.
      if (argumentsJson === null) { writer(''); return; }
      const prefix = '{"version":1,"source":"logManager","level":' + json(level) + ',"kind":' + json(kind) + ',"name":' + json(name) + ',"arguments":';
      writer(prefix + argumentsJson + '}');
    } catch (_) { /* Diagnostics cannot replace the ordinary return/exception. */ }
    finally { writing = false; }
  }
  const manager = object();
  for (const level of ['debug', 'info', 'log', 'warn']) {
    define(manager, level, {__proto__:null,enumerable:true,value:function(...args) {
      const name = 'object:LogManager.' + level;
      if (!permitted('wx.getLogManager') || !permitted(name)) throw error(name, 'unsupported');
      emit(level, 'explicit', 'LogManager.' + level, args);
    }});
  }
  function factory(option) {
    if (!permitted('wx.getLogManager')) throw error('wx.getLogManager', 'unsupported');
    let level = 0;
    if (option !== undefined) {
      if (!option || typeof option !== 'object') throw new TypeErrorClass('getLogManager: invalid options');
      const descriptor = own(option, 'level');
      if (descriptor) { const data = own(descriptor, 'value'); if (!data || (data.value !== 0 && data.value !== 1 && data.value !== undefined)) throw new TypeErrorClass('getLogManager: invalid level'); level = data.value === 1 ? 1 : 0; }
    }
    if (!permitted('wx.getLogManager')) throw error('wx.getLogManager', 'unsupported');
    active = true; automatic = level === 0;
    return manager;
  }
  // Runtime-owned, immutable factory prevents stale object-factory injection.
  define(wx, 'getLogManager', {__proto__:null,enumerable:true,value:factory});
  function trace(kind, name, args) { if (automatic) emit('log', kind, name, args || []); }
  function instrument(unwrap) {
    if (typeof unwrap === 'string') { const d = own(wx, unwrap); return d && (weakGet(wrappers, d.value) || d.value); }
    const names = keys(wx);
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (typeof name !== 'string' || name === 'getLogManager') continue;
      const descriptor = own(wx, name);
      if (!descriptor || !own(descriptor, 'value') || typeof descriptor.value !== 'function' || (!descriptor.writable && !descriptor.configurable)) continue;
      const original = descriptor.value;
      if (weakGet(wrappers, original)) continue;
      const wrapped = function(...args) { trace('api', 'wx.' + name, args); return apply(original, this, args); };
      weakSet(wrappers, wrapped, original);
      descriptor.value = wrapped;
      define(wx, name, descriptor);
    }
  }
  // Host bridge captures and deletes this before application execution.
  globalThis.__container_log_manager_instrument = instrument;
  install(__container_capabilities);
  return { trace:trace, instrument:instrument, install:install, retire:retire };
})();
