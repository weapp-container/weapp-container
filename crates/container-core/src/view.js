// A standalone View realm bootstrap. Deliberately does not import modules.js,
// AppService globals, providers, timers or a microtask runner. This is an
// execution boundary, not a claim of WeChat's complete WXS language dialect.
(function () {
  'use strict';
  const root = globalThis;
  const Object = root.Object;
  const Reflect = root.Reflect;
  const Symbol = root.Symbol;
  const String = root.String;
  const apply = Reflect.apply;
  const keys = Object.keys;
  const own = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  const define = Object.defineProperty;
  const create = Object.create;
  const getPrototype = Object.getPrototypeOf;
  const array = Array.isArray;
  const NativeFunction = Function;
  const NativeProxy = Proxy;
  const NativeMap = Map;
  const NativeWeakMap = WeakMap;
  const NativeArray = Array;
  const NativeError = Error;
  const NativeDate = Date;
  const NativeRegExp = RegExp;
  const stringify = JSON.stringify;
  const is = Object.is;
  const finite = Number.isFinite;
  const functionCall = Function.prototype.call;
  const functionApply = Function.prototype.apply;
  const functionBind = Function.prototype.bind;
  const objectPrototype = Object.prototype;
  const mapGet = Function.prototype.call.bind(Map.prototype.get);
  const mapSet = Function.prototype.call.bind(Map.prototype.set);
  const mapHas = Function.prototype.call.bind(Map.prototype.has);
  const mapDelete = Function.prototype.call.bind(Map.prototype.delete);
  const weakGet = Function.prototype.call.bind(WeakMap.prototype.get);
  const weakSet = Function.prototype.call.bind(WeakMap.prototype.set);
  const weakHas = Function.prototype.call.bind(WeakMap.prototype.has);
  const wrapperOrigins = new NativeWeakMap();
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  // The compiler changes property observations, never native prototypes.
  // Array species and native methods must keep their real constructors.
  const constructorTypes = new NativeMap([
    [Number.prototype, [Number, 'Number']], [String.prototype, [String, 'String']],
    [Boolean.prototype, [Boolean, 'Boolean']], [Object.prototype, [Object, 'Object']],
    [NativeFunction.prototype, [NativeFunction, 'Function']], [NativeArray.prototype, [NativeArray, 'Array']],
    [NativeDate.prototype, [NativeDate, 'Date']], [NativeRegExp.prototype, [NativeRegExp, 'RegExp']],
  ]);
  const descriptor = Object.getOwnPropertyDescriptor;
  const reflectKeys = Reflect.ownKeys;
  const extensible = Object.isExtensible;
  const writableIntrinsicProperties = new NativeWeakMap();
  for (const intrinsic of [Object, NativeArray, NativeMap, NativeWeakMap, String,
    Number, Boolean, NativeDate, NativeRegExp, NativeError]) {
    const prototype = intrinsic.prototype;
    if (!prototype) continue;
    const writable = new NativeMap();
    for (const key of reflectKeys(prototype)) {
      const property = descriptor(prototype, key);
      if (property && own(property, 'value') && property.writable) mapSet(writable, key, true);
    }
    weakSet(writableIntrinsicProperties, prototype, writable);
  }
  const setSloppy = new NativeFunction('base', 'key', 'value', 'base[key] = value; return value;');
  const setStrict = new NativeFunction('base', 'key', 'value', '"use strict"; base[key] = value; return value;');
  const removeSloppy = new NativeFunction('base', 'key', 'return delete base[key];');
  const removeStrict = new NativeFunction('base', 'key', '"use strict"; return delete base[key];');
  function propertyKey(base, key) {
    // Native property access rejects nullish bases before coercing the key.
    if (base === null || base === undefined) return base[key];
    return reflectKeys({[key]: null})[0];
  }
  function unwrapped(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function')
      && weakHas(wrapperOrigins, value) ? weakGet(wrapperOrigins, value) : value;
  }
  function propertyOwner(base, key) {
    let current = Object(unwrapped(base));
    while (current !== null) {
      const ownDescriptor = descriptor(current, key);
      if (ownDescriptor) return {owner: current, descriptor: ownDescriptor};
      current = getPrototype(current);
    }
    return null;
  }
  function dialectRead(base, rawKey) {
    const key = propertyKey(base, rawKey);
    const value = base[key];
    if (key !== 'constructor') return value;
    const raw = unwrapped(value);
    // Most overrides can be returned without any prototype walk. Getters and
    // own/inherited user properties remain authoritative, even if they return
    // one of the built-in constructor functions.
    if (![Number, String, Boolean, Object, NativeFunction, NativeArray, NativeDate, NativeRegExp].includes(raw)) return value;
    const found = propertyOwner(base, key);
    const type = found && mapGet(constructorTypes, found.owner);
    return type && found.descriptor.value === type[0] && raw === type[0] ? type[1] : value;
  }
  function dialectSet(reference, value, strict) {
    const base = reference.base, key = propertyKey(base, reference.key);
    // Intrinsics are frozen below to protect the transport. Ordinary objects
    // can still acquire own overrides of originally writable inherited data
    // properties (constructor, toString, push, etc.). Custom readonly
    // descriptors and accessors retain their native assignment behavior.
    if (base !== null
        && (typeof base === 'object' || typeof base === 'function')
        && !weakHas(wrapperOrigins, base) && !descriptor(base, key) && extensible(base)) {
      const found = propertyOwner(base, key);
      const writable = found && weakGet(writableIntrinsicProperties, found.owner);
      if (writable && mapHas(writable, key) && found.descriptor.writable === false) {
        define(base, key, {value, writable: true, enumerable: true, configurable: true});
        return value;
      }
    }
    return (strict ? setStrict : setSloppy)(base, key, value);
  }
  const dialectHelper = Object.freeze({
    read: dialectRead,
    callee(base, key) { return {fn: dialectRead(base, key), receiver: base}; },
    invoke(record, args) { return apply(record.fn, record.receiver, args); },
    // A reference retains the raw key. Native assignment coerces it after the
    // RHS; compound/update coerce independently on the read and write paths.
    reference(base, key) { return {base, key}; },
    get(reference) { return dialectRead(reference.base, reference.key); },
    set: dialectSet,
    update(reference, delta, prefix, strict) {
      let value = dialectRead(reference.base, reference.key);
      const previous = delta > 0 ? value++ : value--;
      dialectSet(reference, value, strict);
      return prefix ? value : previous;
    },
    remove(base, key, strict) { return (strict ? removeStrict : removeSloppy)(base, key); },
  });

  function compiledSource(value) {
    if (!value || value.abi !== '1.0' || typeof value.code !== 'string'
        || !identifier.test(value.helper) || !/^__wc/.test(value.helper)) invalid('invalid compiled View source or helper ABI');
    return value;
  }
  // Cache executable functions, never their stateful results. Registry reload
  // invalidates the cache; native dispose/reset replaces this entire closure.
  let expressionPrograms = new NativeMap();
  let expressionProgramCount = 0;
  function compileExpression(source, compilation, shorthand, documentId) {
    const key = stringify([documentId, source, !!shorthand, compilation]);
    if (mapHas(expressionPrograms, key)) return mapGet(expressionPrograms, key);
    const program = createExpression(source, compilation, shorthand);
    // Clear as a group instead of consulting user-visible iterator prototypes.
    if (expressionProgramCount >= 4096) {
      expressionPrograms = new NativeMap(); expressionProgramCount = 0;
    }
    mapSet(expressionPrograms, key, program); expressionProgramCount++;
    return program;
  }
  function createExpression(source, compilation, shorthand) {
    if (compilation !== undefined) {
      const compiled = compiledSource(compilation);
      // An inner lexical parameter beats the WXML `with` object's has trap.
      // The outer factory receives the helper without exposing a global name.
      const outer = new NativeFunction('scope',
        'with(scope){return ((' + compiled.helper + ') => (\n' + compiled.code + '\n));}');
      return function(scope) { return apply(apply(outer, undefined, [scope]), undefined, [dialectHelper]); };
    }
    try { return new NativeFunction('scope', 'with(scope){return (\n' + source + '\n);}'); }
    catch (error) {
      if (!shorthand) throw error;
      return new NativeFunction('scope', 'with(scope){return ({\n' + source + '\n});}');
    }
  }

  // WXS exposes these constructors through helper functions. Keeping the
  // helpers in the isolated realm makes their Date/RegExp objects available
  // to WXS code while the ordinary render sink still rejects opaque native
  // objects. This preserves the batched membrane boundary: callers must turn
  // the result into data (for example, a formatted string or a boolean match)
  // before it crosses back to Rust.
  function getDate(...args) { return new NativeDate(...args); }
  function getRegExp(pattern, flags) {
    // WXS documents only the ES5 g/i/m flags. Reject newer host-specific
    // flags instead of allowing QuickJS and V8 to diverge silently.
    if (flags !== undefined && (typeof flags !== 'string' || /[^gim]/.test(flags))) {
      throw new NativeError('WXS getRegExp flags must contain only g, i or m');
    }
    const expression = new NativeRegExp(pattern, flags);
    // Native RegExp can inherit flags from a RegExp-valued pattern when the
    // second argument is omitted. Check that effective value as well.
    if (/[^gim]/.test(expression.flags)) {
      throw new NativeError('WXS getRegExp flags must contain only g, i or m');
    }
    return expression;
  }
  // Module factories execute in the realm global rather than inside the WXML
  // expression `with` proxy. Install the helpers as immutable, non-enumerable
  // globals so both module code and expressions observe the same functions;
  // user modules cannot replace the host-provided capability.
  define(root, 'getDate', {value: getDate, writable: false, enumerable: false, configurable: false});
  define(root, 'getRegExp', {value: getRegExp, writable: false, enumerable: false, configurable: false});
  // The View transport relies on these intrinsics. This execution subset
  // deliberately freezes them instead of allowing modules to rewrite the
  // bridge's validation/serialization behavior. Global names remain separate
  // from AppService and no capabilities are installed here.
  for (const intrinsic of [Object, Function, Array, Map, WeakMap, String,
    Number, Boolean, NativeDate, NativeRegExp, Error, Reflect, JSON]) {
    // Function.prototype is not used for transport after the bound methods
    // above are captured. Leave it writable so functions can own customary
    // call/apply/bind properties without inherited non-writable interference.
    if (intrinsic.prototype && intrinsic !== NativeFunction) Object.freeze(intrinsic.prototype);
    Object.freeze(intrinsic);
  }
  let modules = new NativeMap();
  let scopes = new NativeMap();
  const internalErrors = new NativeWeakMap();
  let busy = false;

  function guarded(run, input, staticRegistration) {
    if (busy) return {ok: false, error: {
      code: 'ERR_VIEW_INVALID_BATCH', message: 'reentrant View execution is forbidden',
    }};
    busy = true;
    try { return run(input); }
    catch (error) { if (staticRegistration) return registrationError(error); throw error; }
    finally { busy = false; }
  }

  function fail(code, message) {
    const error = new NativeError(message);
    error.code = code;
    weakSet(internalErrors, error, code);
    throw error;
  }
  function invalid(message) { fail('ERR_VIEW_INVALID_BATCH', message); }
  function unsupported(message) { fail('ERR_VIEW_UNSUPPORTED_VALUE', message); }
  function replyError(error) {
    // Access may execute user getters. The native deadline remains armed until
    // this entire reply has been converted back to Rust.
    return {ok: false, error: {
      code: error !== null && (typeof error === 'object' || typeof error === 'function')
        && weakHas(internalErrors, error) ? weakGet(internalErrors, error) : 'ERR_VIEW_EXECUTION',
      message: typeof error?.message === 'string' ? error.message : String(error),
      stack: typeof error?.stack === 'string' ? error.stack : undefined,
    }};
  }
  function nonempty(value) { return typeof value === 'string' && value.length > 0; }
  function validId(id) {
    if (!nonempty(id) || !id.startsWith('wxs:') || /[\\\u0000-\u001f]/.test(id)) return false;
    const pieces = id.slice(4).split('#');
    if (pieces.length > 2 || (pieces.length === 2 && !identifier.test(pieces[1]))) return false;
    const path = pieces[0];
    if (!path || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')) return false;
    return pieces.length === 2 ? path.endsWith('.wxml') : path.endsWith('.wxs');
  }
  function resolve(from, request) {
    if (typeof request !== 'string' || !/^(\.\/|\.\.\/)/.test(request)
        || !request.endsWith('.wxs') || /[\\#?\u0000-\u001f]/.test(request)) {
      fail('ERR_VIEW_MODULE', 'require accepts declared relative .wxs dependencies only');
    }
    const path = from.slice(4).split('#')[0].split('/');
    path.pop();
    for (const part of request.split('/')) {
      if (part === '.') continue;
      if (part === '..') {
        if (!path.length) fail('ERR_VIEW_MODULE', 'require escapes the package root');
        path.pop();
      } else if (!part) {
        fail('ERR_VIEW_MODULE', 'empty require path segment');
      } else path.push(part);
    }
    const id = 'wxs:' + path.join('/');
    if (!validId(id)) fail('ERR_VIEW_MODULE', 'invalid require target');
    return id;
  }
  function load(input) {
    try {
      if (!array(input)) invalid('module batch must be an array');
      const candidate = new NativeMap();
      // Compile all factories before publishing, but initialize none of them.
      for (const item of input) {
        if (!item || !validId(item.id) || typeof item.source !== 'string'
            || !array(item.dependencies) || mapHas(candidate, item.id)) {
          invalid('invalid or duplicate View module');
        }
        const dependencies = new NativeMap();
        for (const dependency of item.dependencies) {
          if (!validId(dependency) || dependency.includes('#') || mapHas(dependencies, dependency)) {
            invalid('invalid or duplicate View module dependency');
          }
          mapSet(dependencies, dependency, true);
        }
        let factory;
        try {
          if (item.compilation !== undefined) {
            const compiled = compiledSource(item.compilation);
            factory = new NativeFunction('module', 'exports', 'require', compiled.helper, compiled.code + '\n');
          } else factory = new NativeFunction('module', 'exports', 'require', item.source + '\n');
        }
        catch (error) { fail('ERR_VIEW_MODULE', 'cannot compile ' + item.id + ': ' + error.message); }
        mapSet(candidate, item.id, {factory, dependencies, source: item.source, compiled: item.compilation !== undefined});
      }
      for (const item of input) {
        for (const dependency of item.dependencies) {
          if (!mapHas(candidate, dependency)) fail('ERR_VIEW_MODULE', 'missing dependency ' + dependency);
        }
      }
      modules = candidate;
      registeredDocuments = null;
      scopes = new NativeMap();
      expressionPrograms = new NativeMap(); expressionProgramCount = 0;
      return {ok: true};
    } catch (error) { return replyError(error); }
  }

  function newScope() {
    const cache = new NativeMap();
    const documents = new NativeMap();
    const wrapped = new NativeWeakMap();
    const original = new NativeWeakMap();
    function unwrap(value) {
      return value !== null && (typeof value === 'object' || typeof value === 'function')
        && weakHas(original, value) ? weakGet(original, value) : value;
    }
    // Clone the whole argument list at each invocation: repeated references
    // within one call survive; writes cannot leak into a later call or data.
    function clone(value, seen) {
      value = unwrap(value);
      if (value === null || ['undefined', 'string', 'boolean', 'number'].includes(typeof value)) return value;
      if (typeof value !== 'object') unsupported('View call arguments must contain data values only');
      if (weakHas(seen, value)) return weakGet(seen, value);
      if (typeof value.then === 'function') unsupported('async View values are unsupported');
      const proto = getPrototype(value);
      if (!array(value) && proto !== objectPrototype && proto !== null) unsupported('non-data View call argument');
      const copy = array(value) ? new NativeArray(value.length) : create(proto);
      weakSet(seen, value, copy);
      for (const key of keys(value)) define(copy, key, {
        value: clone(value[key], seen), enumerable: true, writable: true, configurable: true,
      });
      return copy;
    }
    function wrap(value) {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
      if (weakHas(original, value)) return value;
      if (weakHas(wrapped, value)) return weakGet(wrapped, value);
      // Creating a membrane/inspecting a descriptor must not read object
      // properties. Thenables are checked when copied or finally encoded.
      // A separate extensible facade avoids violating Proxy invariants for
      // frozen exports, including frozen function-valued properties.
      const target = typeof value === 'function' ? (() => {}) : array(value) ? [] : create(null);
      const invoke = (receiver, args) => {
        const seen = new NativeWeakMap();
        // Only WXS-owned receivers retain identity. An explicit data receiver
        // (fn.call(payload, payload)) belongs to the same copied argument graph.
        const ownedReceiver = receiver !== null && (typeof receiver === 'object' || typeof receiver === 'function')
          && weakHas(original, receiver);
        const copiedReceiver = ownedReceiver ? unwrap(receiver) : clone(receiver, seen);
        return wrap(apply(value, copiedReceiver, clone(args, seen)));
      };
      let callFacade, applyFacade, bindFacade;
      const handler = {
        get(_target, key) {
          const property = Reflect.get(value, key, value);
          // Reflection must preserve the receiver's module identity. Treating
          // it as an ordinary data argument would copy or reject its methods.
          if (typeof value === 'function') {
            if (key === 'call' && property === functionCall) return callFacade || (callFacade = (receiver, ...args) => invoke(receiver, args));
            if (key === 'apply' && property === functionApply) return applyFacade || (applyFacade = (receiver, args) => invoke(receiver, args == null ? [] : args));
            if (key === 'bind' && property === functionBind) return bindFacade || (bindFacade = (receiver, ...bound) =>
              (...args) => invoke(receiver, [...bound, ...args]));
          }
          return wrap(property);
        },
        has(_target, key) { return key in value; },
        ownKeys() { return Reflect.ownKeys(value); },
        getOwnPropertyDescriptor(_target, key) {
          if (array(value) && key === 'length') return {value: value.length, writable: true, enumerable: false, configurable: false};
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor) return undefined;
          // Descriptor inspection (Object.keys, getOwnPropertyDescriptors)
          // must never execute an exported accessor.
          if (own(descriptor, 'value')) return {value: wrap(descriptor.value),
            writable: descriptor.writable, enumerable: descriptor.enumerable, configurable: true};
          return {get: wrap(descriptor.get), set: wrap(descriptor.set),
            enumerable: descriptor.enumerable, configurable: true};
        },
        set() { unsupported('View expressions cannot write module exports'); },
        defineProperty() { unsupported('View expressions cannot redefine module exports'); },
        deleteProperty() { unsupported('View expressions cannot delete module exports'); },
        preventExtensions() { return false; },
      };
      if (typeof value === 'function') handler.apply = (_target, receiver, args) => invoke(receiver, args);
      const proxy = new NativeProxy(target, handler);
      weakSet(wrapped, value, proxy);
      weakSet(original, proxy, value);
      weakSet(wrapperOrigins, proxy, value);
      return proxy;
    }
    function requireModule(id) {
      if (mapHas(cache, id)) return mapGet(cache, id).exports;
      const definition = mapGet(modules, id);
      if (!definition) fail('ERR_VIEW_MODULE', 'unknown View module ' + id);
      const record = {exports: {}};
      mapSet(cache, id, record);
      const require = request => {
        const dependency = resolve(id, request);
        if (!mapHas(definition.dependencies, dependency)) fail('ERR_VIEW_MODULE', 'undeclared dependency ' + dependency);
        return requireModule(dependency);
      };
      try { apply(definition.factory, record.exports, definition.compiled
        ? [record, record.exports, require, dialectHelper] : [record, record.exports, require]); }
      catch (error) { mapDelete(cache, id); throw error; }
      return record.exports;
    }
    function encode(value, active) {
      value = unwrap(value);
      switch (typeof value) {
        case 'undefined': return {type: 'undefined'};
        case 'boolean': return {type: 'bool', value};
        case 'string': return {type: 'string', value};
        case 'number':
          if (value !== value) return {type: 'nan'};
          if (value === Infinity) return {type: 'positiveInfinity'};
          if (value === -Infinity) return {type: 'negativeInfinity'};
          if (is(value, -0)) return {type: 'negativeZero'};
          return {type: 'number', value};
        case 'object': break;
        default: unsupported('View result contains a function, symbol or bigint');
      }
      if (value === null) return {type: 'null'};
      if (typeof value.then === 'function') unsupported('async View results are unsupported');
      const proto = getPrototype(value);
      if (!array(value) && proto !== objectPrototype && proto !== null) unsupported('non-data View result');
      if (weakHas(active, value)) unsupported('cyclic View result');
      weakSet(active, value, true);
      let result;
      if (array(value)) {
        const values = [];
        for (let index = 0; index < value.length; index++) values.push(encode(value[index], active));
        result = {type: 'array', value: values};
      } else {
        const values = create(null);
        for (const key of keys(value)) values[key] = encode(value[key], active);
        result = {type: 'object', value: values};
      }
      active.delete(value);
      return result;
    }
    function raw(task, run) {
      const data = task.data;
      const lexical = new NativeProxy(create(null), {
        has() { return true; },
        get(_target, key) {
          if (key === Symbol.unscopables) return undefined;
          if (own(task.bindings, key)) { if (task.onExternalRead) task.onExternalRead(); return wrap(requireModule(task.bindings[key])); }
          if (own(data, key)) return data[key];
          if (typeof key === 'string' && key.startsWith('__weappContainer_')) return undefined;
          if (key === 'getDate') return getDate;
          if (key === 'getRegExp') return getRegExp;
          if (task.onExternalRead) task.onExternalRead();
          return root[key];
        },
      });
      return apply(run, undefined, [lexical]);
    }
    function encoded(value) { return encode(value, new NativeWeakMap()); }
    function evaluate(task, run) { return encoded(raw(task, run)); }
    return {documents, evaluate, raw, encoded};
  }

  function evaluate(input) {
    try {
      if (!array(input)) invalid('expression batch must be an array');
      const ids = new NativeMap();
      const pendingScopes = new NativeMap();
      const pendingDocuments = new NativeMap();
      const prepared = [];
      // Validate and compile every task before invoking any stateful WXS code.
      for (const task of input) {
        if (!task || !nonempty(task.taskId) || !nonempty(task.scopeId) || !nonempty(task.documentId)
            || typeof task.expression !== 'string' || !task.expression.trim()
            || !task.data || typeof task.data !== 'object' || array(task.data)
            || !task.bindings || typeof task.bindings !== 'object' || array(task.bindings)
            || mapHas(ids, task.taskId)) invalid('invalid or duplicate expression task');
        mapSet(ids, task.taskId, true);
        for (const alias of keys(task.bindings)) {
          if (!identifier.test(alias) || !mapHas(modules, task.bindings[alias])) invalid('invalid lexical WXS binding');
          const binding = task.bindings[alias];
          if (binding.includes('#') && binding !== 'wxs:' + task.documentId + '#' + alias) {
            invalid('inline WXS binding does not belong to this document and alias');
          }
        }
        let scope = mapGet(scopes, task.scopeId) || mapGet(pendingScopes, task.scopeId);
        if (!scope) { scope = newScope(); mapSet(pendingScopes, task.scopeId, scope); }
        const fingerprint = stringify(keys(task.bindings).sort().map(alias => [alias, task.bindings[alias]]));
        if (mapHas(scope.documents, task.documentId)
            && mapGet(scope.documents, task.documentId) !== fingerprint) invalid('document bindings changed without module reload');
        let pending = mapGet(pendingDocuments, task.scopeId);
        if (!pending) { pending = new NativeMap(); mapSet(pendingDocuments, task.scopeId, pending); }
        if (mapHas(pending, task.documentId) && mapGet(pending, task.documentId) !== fingerprint) {
          invalid('document bindings disagree within the batch');
        }
        mapSet(pending, task.documentId, fingerprint);
        let run;
        try { run = compileExpression(task.expression, undefined, false, task.documentId); }
        catch (error) { fail('ERR_VIEW_EXECUTION', 'invalid View expression: ' + error.message); }
        prepared.push({task, scope, run, fingerprint});
      }
      const results = [];
      for (const item of prepared) {
        mapSet(scopes, item.task.scopeId, item.scope);
        mapSet(item.scope.documents, item.task.documentId, item.fingerprint);
      }
      for (const item of prepared) results.push({taskId: item.task.taskId, value: item.scope.evaluate(item.task, item.run)});
      return {ok: true, results};
    } catch (error) { return replyError(error); }
  }

  // WXML control flow stays inside one native call. In particular, collecting
  // every binding into an eager expression batch would execute hidden branches
  // and lose loop/template data scopes and stateful WXS invocation order.
  function record(value) {
    return value !== null && typeof value === 'object' && !array(value);
  }
  function stringMap(value) {
    return record(value) && keys(value).every(key => typeof value[key] === 'string');
  }
  function copyRecord(value) {
    const result = create(null);
    for (const key of keys(value)) result[key] = value[key];
    return result;
  }
  function documentId(value) {
    return nonempty(value) && value.endsWith('.wxml') && !/[\\#?:\u0000-\u001f\u007f-\u009f]/.test(value)
      && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
  }
  function resolveWxsDeclaration(from, request) {
    if (!nonempty(request) || !request.endsWith('.wxs') || /[\\#?:\u0000-\u001f\u007f-\u009f]/.test(request)) invalid('invalid WXS declaration source');
    const parts = request.startsWith('/') ? [] : from.split('/').slice(0, -1);
    for (const part of request.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) invalid('WXS declaration escapes the package root');
        parts.pop();
      } else parts.push(part);
    }
    const target = 'wxs:' + parts.join('/');
    if (!validId(target)) invalid('invalid WXS declaration target');
    return target;
  }
  function utf8Length(value) {
    let length = 0;
    for (let index = 0; index < value.length; index++) {
      const code = value.codePointAt(index);
      length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      if (code >= 0x10000) index++;
    }
    return length;
  }

  // Evaluator-owned provenance; captured operations also work in the modern
  // realm where modules may replace native prototypes and serialization hooks.
  const bindingGet = Reflect.get, bindingOwnKeys = Reflect.ownKeys;
  const bindingString = String, bindingNumber = Number;
  const bindingExec = Function.prototype.call.bind(RegExp.prototype.exec);
  const bindingSetPrototype = Object.setPrototypeOf;
  const bindingSort = Function.prototype.call.bind(Array.prototype.sort);
  function bindingRecord(fields) {
    const output = create(null);
    const names = keys(fields);
    for (let index = 0; index < names.length; index++) output[names[index]] = fields[names[index]];
    return output;
  }
  function bindingList() { return bindingSetPrototype([], null); }
  // Encode only evaluator-owned scalar path parts. Native JSON writers may
  // use mutable Array intrinsics internally even for null-prototype inputs.
  function bindingPathKey(path) {
    let result = '[';
    for (let index = 0; index < path.length; index++)
      result += (index ? ',' : '') + stringify(path[index]);
    return result + ']';
  }
  function bindingOriginKey(origin) {
    return (origin.supported ? 'supported:' : 'unknown:') +
      (origin.path ? bindingPathKey(origin.path) : 'literal');
  }
  function bindingPush(target, value) { define(target, bindingString(target.length), {value, writable:true,enumerable:true,configurable:true}); }
  function bindingTracer(initial) {
    const contexts = new NativeWeakMap(), origins = new NativeWeakMap(), cache = new NativeWeakMap();
    let active = null;
    function literal() { return bindingRecord({paths: bindingList(), supported: true}); }
    function unknown() { return bindingRecord({paths: bindingList(), supported: false}); }
    function path(value) { const paths=bindingList(); bindingPush(paths,value); return bindingRecord({path:value,paths,supported:true}); }
    function copyPath(value, part) { const output=bindingList(); for(let index=0;index<value.length;index++) bindingPush(output,value[index]); bindingPush(output,part); return output; }
    function member(origin, key, isArray) {
      if (!origin || !origin.supported || !origin.path) return unknown();
      if (isArray) { const number=bindingNumber(key); if (number<0 || number%1!==0 || bindingString(number)!==bindingString(key)) return unknown(); return path(copyPath(origin.path,number)); }
      return path(copyPath(origin.path,bindingString(key)));
    }
    const initialOrigins=create(null), initialKeys=keys(initial);
    for(let index=0;index<initialKeys.length;index++) {const key=initialKeys[index], value=bindingList(); bindingPush(value,key); initialOrigins[key]=path(value);}
    weakSet(contexts,initial,initialOrigins);
    function observe(origin) {
      if(!active) return;
      if(!origin || !origin.supported) active.supported=false;
      else for(let index=0;index<origin.paths.length;index++) bindingPush(active.paths,origin.paths[index]);
    }
    function wrap(value,origin) {
      if(value===null || typeof value!=='object') return value;
      if(weakHas(origins,value)) return value;
      let entries=weakGet(cache,value);
      if(!entries) {entries=new NativeMap();weakSet(cache,value,entries);}
      // Paths are fresh null-prototype arrays and never contain guest objects.
      const key=bindingOriginKey(origin);
      if(mapHas(entries,key)) return mapGet(entries,key);
      const handler=bindingRecord({get(target,key) {
        if(typeof key==='symbol') return bindingGet(target,key,target);
        const next=member(origin,key,array(target));
        if(!own(target,key)) {if(active) active.supported=false;return bindingGet(target,key,target);}
        observe(next);return wrap(bindingGet(target,key,target),next);
      },ownKeys(target) {observe(origin);return bindingOwnKeys(target);}});
      const proxy=new NativeProxy(value,handler);weakSet(origins,proxy,origin);mapSet(entries,key,proxy);return proxy;
    }
    function contextOrigins(data) {return weakGet(contexts,data)||create(null);}
    return bindingRecord({
      begin(data) {
        active=bindingRecord({paths:bindingList(),supported:true});const roots=contextOrigins(data);
        return new NativeProxy(data,bindingRecord({get(target,key) {const origin=typeof key==='string'&&own(roots,key)?roots[key]:unknown();observe(origin);return wrap(bindingGet(target,key,target),origin);}}));
      },
      external() {if(active) active.supported=false;},
      end(value) {
        const result=active||unknown();active=null;const unique=new NativeMap(), paths=bindingList();
        for(let index=0;index<result.paths.length;index++) {const item=result.paths[index], key=bindingPathKey(item);if(!mapHas(unique,key)){mapSet(unique,key,true);bindingPush(paths,item);}}
        const filtered=bindingList();
        for(let index=0;index<paths.length;index++) {const item=paths[index];let prefix=false;
          for(let other=0;other<paths.length&&!prefix;other++) {const candidate=paths[other];if(candidate.length<=item.length) continue;let equal=true;for(let part=0;part<item.length;part++) if(item[part]!==candidate[part]){equal=false;break;}if(equal) prefix=true;}
          if(!prefix) bindingPush(filtered,item);
        }
        bindingSort(filtered,(a,b)=>compareKeys(bindingPathKey(a),bindingPathKey(b)));result.paths=filtered;result.origin=value&&typeof value==='object'?weakGet(origins,value):null;return result;
      },
      iteration(context,previous,itemName,item,indexName,index,collection) {
        const roots=copyRecord(contextOrigins(previous));const collectionOrigin=collection&&typeof collection==='object'?weakGet(origins,collection):null;
        roots[itemName]=item&&typeof item==='object'&&weakHas(origins,item)?weakGet(origins,item):member(collectionOrigin,index,array(collection));
        roots[indexName]=literal();weakSet(contexts,context,roots);
      },
      template(context,previous,values,source,trace) {
        const roots=copyRecord(contextOrigins(previous)), valueOrigin=weakGet(origins,values), names=keys(values);
        const safe=trace && trace.supported && !bindingExec(/[?&|+*\/=();]/,source) && !bindingExec(/\[\s*[A-Za-z_$]/,source);
        for(let index=0;index<names.length;index++){const key=names[index],value=values[key];roots[key]=!safe?unknown():value&&typeof value==='object'&&weakHas(origins,value)?weakGet(origins,value):member(valueOrigin,key,false);}
        weakSet(contexts,context,roots);
      },
    });
  }

  function sourceSite(parent, kind, value) {
    return parent + '/' + kind + utf8Length(value) + ':' + value;
  }
  function compareKeys(left, right) {
    // Rust's BTreeMap follows UTF-8 scalar ordering, including astral keys.
    let a = 0, b = 0;
    while (a < left.length && b < right.length) {
      const x = left.codePointAt(a), y = right.codePointAt(b);
      if (x !== y) return x < y ? -1 : 1;
      a += x >= 0x10000 ? 2 : 1; b += y >= 0x10000 ? 2 : 1;
    }
    return a < left.length ? 1 : b < right.length ? -1 : 0;
  }
  function orderedKeys(value) { return keys(value).sort(compareKeys); }
  function jsonText(value) {
    if (array(value)) return '[' + value.map(jsonText).join(',') + ']';
    if (record(value)) return '{' + orderedKeys(value).map(key => stringify(key) + ':' + jsonText(value[key])).join(',') + '}';
    return stringify(value);
  }
  function validBindings(value) {
    if (!array(value)) return false;
    const found = new NativeMap();
    for (const binding of value) {
      if (!nonempty(binding) || mapHas(found, binding)) return false;
      mapSet(found, binding, true);
    }
    return true;
  }
  function validAlias(value) {
    return typeof value === 'string' && identifier.test(value)
      && !(' break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield await ').includes(' ' + value + ' ');
  }
  function resolveDocument(from, request, documents) {
    if (!nonempty(request) || /[\\#?\u0000-\u001f]/.test(request)) invalid('invalid WXML document reference');
    const source = request.trim();
    const relative = source.startsWith('template:') ? source.slice(9) : source;
    const parts = relative.startsWith('/') ? [] : from.split('/').slice(0, -1);
    for (const part of relative.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) invalid('WXML document reference escapes the package root');
        parts.pop();
      } else parts.push(part);
    }
    const resolved = parts.join('/');
    if (mapHas(documents, resolved)) return resolved;
    // Preserve the existing IR evaluator's package-relative map alias.
    const direct = relative.replace(/^\.\//, '').replace(/^\//, '');
    if (documentId(direct) && mapHas(documents, direct)) return direct;
    invalid('WXML document target not found: ' + source);
  }
  function mustaches(source, metadataOnly) {
    const pieces = [];
    let cursor = 0;
    while (cursor < source.length) {
      const start = source.indexOf('{{', cursor);
      if (start < 0) { pieces.push({literal: source.slice(cursor)}); break; }
      if (start > cursor) pieces.push({literal: source.slice(cursor, start)});
      let quote = '', escaped = false, braces = 0, end = -1;
      for (let index = start + 2; index < source.length; index++) {
        const character = source[index];
        if (quote) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === quote) quote = '';
        } else if (character === "'" || character === '"' || character === '`') quote = character;
        else if (character === '{') braces++;
        else if (character === '}' && braces) braces--;
        else if (character === '}' && source[index + 1] === '}') { end = index; break; }
      }
      if (end < 0) {
        if (metadataOnly) break;
        invalid('unterminated WXML mustache expression');
      }
      const expression = source.slice(start + 2, end).trim();
      if (!expression && !metadataOnly) invalid('empty WXML mustache expression');
      pieces.push({expression}); cursor = end + 2;
    }
    return pieces;
  }
  function directiveExpression(value) {
    if (typeof value !== 'string') return undefined;
    let source = value.trim();
    if (source.startsWith('{{') && source.endsWith('}}')) source = source.slice(2, -2).trim();
    return source || undefined;
  }
  function normalizedDirectives(node) {
    const result = copyRecord(node.directives || create(null));
    // Normalized directives are authoritative. A loop's recursive clean node
    // deliberately retains its source attrs while removing forExpr here.
    if (node.directives !== undefined) return result;
    for (const pair of [['ifExpr', 'wx:if'], ['elifExpr', 'wx:elif'], ['forExpr', 'wx:for'],
      ['forItem', 'wx:for-item'], ['forIndex', 'wx:for-index'], ['forKey', 'wx:key']]) {
      if (!own(result, pair[0]) && own(node.attrs, pair[1])) {
        const value = directiveExpression(node.attrs[pair[1]]);
        if (value !== undefined) result[pair[0]] = value;
      }
    }
    if (!own(result, 'elseBranch') && own(node.attrs, 'wx:else')) result.elseBranch = true;
    return result;
  }
  // One bounded, realm-local document program. A failed ordinary candidate
  // never replaces this accepted registry; module reload clears it.
  let registeredDocuments = null;
  // QuickJS stores these hooks in context state and invokes prepareStackTrace
  // eagerly while creating even a native SyntaxError. Capture native accessors
  // before app code; an app may later shadow/nonconfigure the public properties.
  // V8's absent/data descriptors do not use this context-accessor branch.
  const prepareHook = descriptor(NativeError, "prepareStackTrace");
  const limitHook = descriptor(NativeError, "stackTraceLimit");
  const nativePrepareGet = prepareHook && typeof prepareHook.get === "function" && typeof prepareHook.set === "function" ? prepareHook.get : null;
  const nativePrepareSet = nativePrepareGet ? prepareHook.set : null;
  const nativeLimitGet = limitHook && typeof limitHook.get === "function" && typeof limitHook.set === "function" ? limitHook.get : null;
  const nativeLimitSet = nativeLimitGet ? limitHook.set : null;
  function staticErrorIsolation(run) {
    let prepare, limit;
    if (nativePrepareGet) {
      prepare = apply(nativePrepareGet, NativeError, []);
      apply(nativePrepareSet, NativeError, [undefined]);
    }
    if (nativeLimitGet) {
      limit = apply(nativeLimitGet, NativeError, []);
      apply(nativeLimitSet, NativeError, [0]);
    }
    try { return run(); }
    finally {
      if (nativeLimitSet) apply(nativeLimitSet, NativeError, [limit]);
      if (nativePrepareSet) apply(nativePrepareSet, NativeError, [prepare]);
    }
  }
  const nativeSyntaxErrorPrototype = root.SyntaxError.prototype;
  function staticErrorMessage(error) {
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      const property = descriptor(error, "message");
      if (property && own(property, "value") && typeof property.value === "string")
        return property.value;
    }
    return "View document program rejected";
  }
  function registrationError(error) {
    return {ok: false, documentProgramRejected: weakHas(internalErrors, error),
      error: {code: weakHas(internalErrors, error) ? weakGet(internalErrors, error) : "ERR_VIEW_EXECUTION",
        message: staticErrorMessage(error)}};
  }
  function prepareDocuments(inputDocuments) {
    if (!array(inputDocuments)) invalid("document program requires documents");
      const documents = new NativeMap(), expressions = new NativeMap(), definitions = new NativeMap();
      const compiledDocuments = new NativeMap();
      function compile(source, shorthand, document) {
        const localKey = (shorthand ? 'data:' : 'expr:') + source;
        let local = mapGet(expressions, document.documentId);
        if (!local) { local = new NativeMap(); mapSet(expressions, document.documentId, local); }
        if (mapHas(local, localKey)) return mapGet(local, localKey);
        let run;
        try {
          const compiled = mapGet(compiledDocuments, document.documentId);
          if (compiled) {
            if (!mapHas(compiled, localKey)) invalid('missing compiled WXML expression in ' + document.documentId);
            run = mapGet(compiled, localKey);
          } else run = compileExpression(source, undefined, shorthand, document.documentId);
        }
        catch (error) {
          if (weakHas(internalErrors, error)) throw error;
          if (error === null || typeof error !== 'object' || getPrototype(error) !== nativeSyntaxErrorPrototype) throw error;
          fail('ERR_VIEW_EXECUTION', 'invalid WXML expression: ' + staticErrorMessage(error));
        }
        mapSet(local, localKey, run);
        return run;
      }
      function scanInterpolations(source, document) {
        for (const piece of mustaches(source)) if (own(piece, 'expression')) compile(piece.expression, false, document);
      }
      function dataExpression(source) {
        const expression = directiveExpression(source);
        if (!expression) invalid('WXML template data expression cannot be empty');
        return expression;
      }
      function validateSourceOrigin(node, document) {
        if (node.lexicalOrigin !== undefined && node.lexicalOrigin !== null
              && (!record(node.lexicalOrigin) || keys(node.lexicalOrigin).length !== 1
                || !documentId(node.lexicalOrigin.documentId)
                || node.lexicalOrigin.documentId !== document.documentId)) invalid('WXML source lexical origin disagrees with its declaring document');
      }
      function validateNodes(nodes, depth, document, aliases) {
        if (!array(nodes) || depth > 128) invalid('invalid WXML nodes or maximum source depth exceeded');
        for (const node of nodes) {
          if (!record(node) || !nonempty(node.kind)) invalid('invalid WXML node');
          validateSourceOrigin(node, document);
          if (node.kind === 'comment') {
            if (typeof node.value !== 'string') invalid('invalid WXML comment');
            continue;
          }
          if (node.kind === 'text') {
            if (typeof node.value !== 'string' || !validBindings(node.bindings)) invalid('invalid WXML text');
            scanInterpolations(node.value, document); continue;
          }
          if (node.kind !== 'element' || !nonempty(node.tag) || /\s/.test(node.tag) || !stringMap(node.attrs)
            || keys(node.attrs).some(name => !nonempty(name) || /\s/.test(name)) || !validBindings(node.bindings)
            || (node.boundValues !== undefined && !record(node.boundValues))
            || (node.key !== undefined && node.key !== null && typeof node.key !== 'string')
            || (node.keyScope !== undefined && node.keyScope !== null && typeof node.keyScope !== 'string')
            || (node.sourceSite !== undefined && node.sourceSite !== null && typeof node.sourceSite !== 'string')
            || (node.directives !== undefined && !record(node.directives))) invalid('invalid WXML element');
          if (!array(node.children)) invalid('WXML element requires children');
          if (node.tag === 'wxs') {
            if (node.children.some(child => !record(child) || child.kind !== 'text' || typeof child.value !== 'string'
              || !validBindings(child.bindings))) {
              invalid('WXS declarations require raw text');
            }
            for (const child of node.children) validateSourceOrigin(child, document);
            const alias = node.attrs.module;
            if (!validAlias(alias) || mapHas(aliases, alias) || !own(document.bindings, alias)) invalid('invalid, duplicate or unbound WXS declaration');
            mapSet(aliases, alias, true);
            const source = node.children.map(child => child.value).join('');
            if (own(node.attrs, 'src')) {
              if (source.trim() || document.bindings[alias] !== resolveWxsDeclaration(document.documentId, node.attrs.src)) {
                invalid('external WXS declaration disagrees with its binding');
              }
            } else {
              const target = 'wxs:' + document.documentId + '#' + alias;
              if (document.bindings[alias] !== target || mapGet(modules, target).source !== source) {
                invalid('inline WXS declaration disagrees with its verified module');
              }
            }
            continue;
          }
          const directives = normalizedDirectives(node);
          for (const name of ['ifExpr', 'elifExpr', 'forExpr', 'forItem', 'forIndex', 'forKey']) {
            if (own(directives, name) && typeof directives[name] !== 'string') invalid('invalid WXML directive');
          }
          if (own(directives, 'elseBranch') && typeof directives.elseBranch !== 'boolean') invalid('invalid WXML else directive');
          if (own(directives, 'events') && !stringMap(directives.events)) invalid('invalid WXML event directives');
          if ((own(directives, 'ifExpr') && own(directives, 'elifExpr'))
            || (directives.elseBranch && (own(directives, 'ifExpr') || own(directives, 'elifExpr')))
            || (!own(directives, 'forExpr') && (own(directives, 'forItem') || own(directives, 'forIndex')))) invalid('inconsistent WXML control directives');
          for (const name of ['ifExpr', 'elifExpr', 'forExpr']) if (directives[name]) compile(directives[name], false, document);
          if (directives.forKey && directives.forKey.includes('.')) compile(directives.forKey, false, document);
          for (const name of keys(node.attrs)) {
            if (name.startsWith('wx:') || (node.boundValues && own(node.boundValues, name))) continue;
            if (node.tag === 'template' && name === 'data') compile(dataExpression(node.attrs[name]), true, document);
            else scanInterpolations(node.attrs[name], document);
          }
          validateNodes(node.children, depth + 1, document, aliases);
        }
      }
      // Register every document before resolving any relative import/include.
      for (const document of inputDocuments) {
        if (!record(document) || !documentId(document.documentId) || mapHas(documents, document.documentId)
          || !record(document.ast) || document.ast.version !== 1 || !stringMap(document.bindings)) invalid('invalid or duplicate render document');
        for (const alias of keys(document.bindings)) {
          const target = document.bindings[alias];
          if (!validAlias(alias) || !mapHas(modules, target)
            || (target.includes('#') && target !== 'wxs:' + document.documentId + '#' + alias)) invalid('invalid render document WXS binding');
        }
        if (document.compilation !== undefined) {
          if (!array(document.compilation)) invalid('invalid compiled WXML expression registry');
          const compiled = new NativeMap();
          for (const item of document.compilation) {
            if (!record(item) || !nonempty(item.source) || typeof item.shorthand !== 'boolean') invalid('invalid compiled WXML expression');
            const key = (item.shorthand ? 'data:' : 'expr:') + item.source;
            if (mapHas(compiled, key)) invalid('duplicate compiled WXML expression');
            mapSet(compiled, key, compileExpression(item.source, compiledSource(item.compilation), item.shorthand, document.documentId));
          }
          mapSet(compiledDocuments, document.documentId, compiled);
        }
        mapSet(documents, document.documentId, document);
      }
      for (const document of inputDocuments) validateNodes(document.ast.nodes, 0, document, new NativeMap());
      function collect(document, nodes, output, stack, declarationPass) {
        if (declarationPass) {
          for (const node of nodes) {
            if (node.kind !== 'element' || node.tag === 'wxs') continue;
            if (node.tag === 'template' && own(node.attrs, 'name') && node.attrs.name.trim()) {
              mapSet(output, node.attrs.name, {document, nodes: node.children});
            }
            collect(document, node.children, output, stack, true);
          }
          return;
        }
        // Local declarations are visible even when their call precedes them.
        collect(document, nodes, output, stack, true);
        for (const node of nodes) {
          if (node.kind !== 'element' || node.tag === 'wxs') continue;
          if (node.tag === 'import' || node.tag === 'include') {
            if (!own(node.attrs, 'src')) invalid('WXML ' + node.tag + ' requires src');
            const target = resolveDocument(document, node.attrs.src, documents);
            const edge = node.tag + ':' + target;
            if (stack.includes(edge) || stack.length >= 32) invalid('WXML document dependency cycle or depth exceeded');
            collect(target, mapGet(documents, target).ast.nodes, output, [...stack, edge], false);
          }
          collect(document, node.children, output, stack, false);
        }
      }
      for (const document of inputDocuments) {
        const names = new NativeMap();
        collect(document.documentId, document.ast.nodes, names, [], false);
        mapSet(definitions, document.documentId, names);
      }
    const fingerprints = new NativeMap();
    for (const document of inputDocuments) mapSet(fingerprints, document.documentId,
      stringify(orderedKeys(document.bindings).map(alias => [alias, document.bindings[alias]])));
    return function renderTasks(inputTasks) {
      if (!array(inputTasks)) invalid("registered render requires tasks");
      const ids = new NativeMap(), pendingScopes = new NativeMap(), prepared = [];
      for (const task of inputTasks) {
        if (!record(task) || !nonempty(task.taskId) || !nonempty(task.scopeId) || mapHas(ids, task.taskId)
          || !mapHas(documents, task.documentId) || !record(task.data)) invalid('invalid or duplicate render task');
        mapSet(ids, task.taskId, true);
        let scope = mapGet(scopes, task.scopeId) || mapGet(pendingScopes, task.scopeId);
        if (!scope) { scope = newScope(); mapSet(pendingScopes, task.scopeId, scope); }
        for (const document of inputDocuments) {
          const fingerprint = mapGet(fingerprints, document.documentId);
          if (mapHas(scope.documents, document.documentId)
            && mapGet(scope.documents, document.documentId) !== fingerprint) invalid('document bindings changed without module reload');
        }
        prepared.push({task, scope});
      }
      // No stateful module runs before the entire input and graph are checked.
      for (const item of prepared) {
        mapSet(scopes, item.task.scopeId, item.scope);
        for (const document of inputDocuments) mapSet(item.scope.documents, document.documentId,
          mapGet(fingerprints, document.documentId));
      }
      function jsonValue(scope, value) {
        function decode(tag) {
          switch (tag.type) {
            case 'undefined': case 'null': return null;
            case 'bool': case 'number': case 'string': return tag.value;
            case 'negativeZero': return 0;
            case 'array': return tag.value.map(decode);
            case 'object': {
              const result = create(null);
              for (const key of orderedKeys(tag.value)) {
                if (tag.value[key].type !== 'undefined') result[key] = decode(tag.value[key]);
              }
              return result;
            }
            default: unsupported('non-finite WXML values cannot enter a JSON attribute');
          }
        }
        return decode(scope.encoded(value));
      }
      function textValue(scope, value) {
        if (value === undefined || value === null) return '';
        if (typeof value === 'number' && !finite(value)) unsupported('non-finite WXML expression result cannot enter render text');
        if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return String(value);
        return jsonText(jsonValue(scope, value));
      }
      const results = [];
      for (const item of prepared) {
        const task = item.task, scope = item.scope;
        const tracer = bindingTracer(task.data), attributeSources = [];
        let lastSource = null;
        function expression(source, data, document, shorthand) {
          const definition = mapGet(documents, document);
          const tracked = tracer.begin(data);
          let value;
          try { value = scope.raw({data: tracked, bindings: definition.bindings, onExternalRead: () => tracer.external()}, compile(source, shorthand, definition)); }
          finally { lastSource = tracer.end(value); }
          return value;
        }
        function attributeSource(site, name, source) {
          attributeSources.push({sourceSite: site, attribute: name, paths: source ? source.paths : [], directPath: source && source.origin && source.origin.path || null, supported: !!source && source.supported});
        }
        function interpolate(source, data, document) {
          let output = '';
          for (const piece of mustaches(source)) output += own(piece, 'literal') ? piece.literal
            : textValue(scope, expression(piece.expression, data, document, false));
          return output;
        }
        function enter(environment, edge, document) {
          if (environment.stack.includes(edge) || environment.stack.length >= 32) invalid('WXML template/include cycle or depth exceeded');
          return {document, definitions: environment.definitions, stack: [...environment.stack, edge]};
        }
        function stripControls(nodes) {
          for (const node of nodes) {
            if (node.kind !== 'element') continue;
            for (const name of ['ifExpr', 'elifExpr', 'elseBranch', 'forExpr', 'forItem', 'forIndex', 'forKey']) delete node.directives[name];
            stripControls(node.children);
          }
          return nodes;
        }
        function nodes(source, data, environment, site, whitespace) {
          const output = [];
          let conditional = false, taken = false;
          for (let index = 0; index < source.length; index++) {
            const node = source[index], nextSite = sourceSite(site, 'node', String(index));
            const separator = node.kind === 'comment' || (node.kind === 'text' && !node.value.trim());
            if (separator || node.kind !== 'element') { output.push(...one(node, data, environment, nextSite, whitespace));
              if (!separator) { conditional = false; taken = false; } continue; }
            const directives = normalizedDirectives(node);
            if (directives.forExpr) { conditional = false; taken = false;
              output.push(...one(node, data, environment, nextSite, whitespace)); continue; }
            if (!directives.ifExpr && !directives.elifExpr && !directives.elseBranch) {
              conditional = false; taken = false; output.push(...one(node, data, environment, nextSite, whitespace)); continue;
            }
            if (directives.ifExpr) { conditional = true; taken = false; }
            else if (!conditional) invalid('wx:elif/wx:else must follow wx:if in the same sibling list');
            if (taken) continue;
            if (directives.ifExpr || directives.elifExpr) {
              if (!expression(directives.ifExpr || directives.elifExpr, data, environment.document, false)) continue;
            }
            taken = true; output.push(...one(node, data, environment, nextSite, whitespace));
          }
          return output;
        }
        function one(node, data, environment, site, whitespace) {
          const document = environment.document;
          // Lexical document provenance is separate from source occurrence,
          // component configuration and the scope which owns a slot listener.
          // It never chooses expression bindings: environment.document does.
          const lexicalOrigin = {documentId: document};
          if (node.kind === 'comment') return [{kind: 'comment', value: node.value, lexicalOrigin}];
          if (node.kind === 'text') {
            if (!whitespace && !node.bindings.length && !node.value.trim() && /[\r\n]/.test(node.value)) return [];
            const bindings = new NativeMap();
            for (const value of node.bindings) mapSet(bindings, value, true);
            for (const piece of mustaches(node.value)) if (piece.expression) mapSet(bindings, piece.expression, true);
            return [{kind: 'text', value: interpolate(node.value, data, document), bindings: [...bindings.keys()].sort(compareKeys), lexicalOrigin}];
          }
          if (node.tag === 'wxs') return [];
          site = node.sourceSite || site;
          const directives = normalizedDirectives(node);
          if (directives.forExpr) {
            const collection = expression(directives.forExpr, data, document, false), entries = [];
            if (array(collection)) { for (let index = 0; index < collection.length; index++) entries.push([index, collection[index]]); }
            else if (record(collection)) for (const key of orderedKeys(collection)) entries.push([key, collection[key]]);
            const output = [];
            for (const entry of entries) {
              const context = copyRecord(data);
              context[directives.forItem || 'item'] = entry[1]; context[directives.forIndex || 'index'] = entry[0];
              tracer.iteration(context, data, directives.forItem || 'item', entry[1], directives.forIndex || 'index', entry[0], collection);
              const clean = copyRecord(directives);
              for (const name of ['forExpr', 'forItem', 'forIndex', 'forKey']) delete clean[name];
              let key = null;
              if (directives.forKey !== undefined) {
                const name = directives.forKey;
                let value;
                if (name === '*this') value = entry[1];
                else if (!name.includes('.')) value = record(entry[1]) && own(entry[1], name) ? entry[1][name] : null;
                else value = expression(name, context, document, false);
                key = textValue(scope, value);
              }
              const iteration = {kind: 'element', tag: node.tag, attrs: node.attrs, bindings: node.bindings,
                boundValues: node.boundValues || create(null), directives: clean, key,
                keyScope: key === null ? null : site, lexicalOrigin, children: node.children};
              // attrs still contain wx:for. Mark normalized control metadata
              // as authoritative so the recursive pass cannot apply it twice.
              const iterationSite = sourceSite(site, key === null ? 'repeat-index' : 'repeat-key', key === null ? textValue(scope, entry[0]) : key);
              output.push(...nodes([iteration], context, environment, iterationSite, whitespace));
            }
            return output;
          }
          let expanded = null;
          if (node.tag === 'import' || node.tag === 'include') {
            const target = resolveDocument(document, node.attrs.src, documents);
            expanded = node.tag === 'import' ? [] : nodes(mapGet(documents, target).ast.nodes, data,
              enter(environment, 'include:' + target, target), sourceSite(site, 'include', target), whitespace);
          } else if (node.tag === 'template') {
            if (own(node.attrs, 'name')) expanded = [];
            else if (own(node.attrs, 'is')) {
              const name = interpolate(node.attrs.is, data, document).trim();
              const definition = mapGet(environment.definitions, name);
              if (!definition) invalid('WXML template target not found: ' + name);
              let context = data;
              if (own(node.attrs, 'data')) {
                const values = expression(dataExpression(node.attrs.data), data, document, true);
                if (!record(values)) invalid('WXML template data must evaluate to an object');
                context = copyRecord(data);
                for (const key of keys(values)) context[key] = values[key];
                tracer.template(context, data, values, dataExpression(node.attrs.data), lastSource);
              }
              const edge = 'template:' + definition.document + ':' + name;
              expanded = stripControls(nodes(definition.nodes, context, enter(environment, edge, definition.document),
                sourceSite(site, 'template', edge), whitespace));
            }
          }
          if (expanded !== null) {
            if (node.key !== undefined && node.key !== null && expanded.length) return [{kind: 'element', tag: 'block',
              attrs: create(null), boundValues: create(null), bindings: [], directives: create(null),
              key: node.key, keyScope: node.keyScope || null, sourceSite: site, lexicalOrigin, children: expanded}];
            return expanded;
          }
          const attrs = create(null), boundValues = create(null), bindings = new NativeMap();
          for (const binding of node.bindings) mapSet(bindings, binding, true);
          for (const name of orderedKeys(node.attrs)) {
            const source = node.attrs[name];
            if (name.startsWith('wx:')) attrs[name] = source;
            else if (node.boundValues && own(node.boundValues, name)) {
              attrs[name] = source; boundValues[name] = node.boundValues[name];
              attributeSource(site, name, null);
            } else {
              const pieces = mustaches(source);
              if (pieces.length === 1 && own(pieces[0], 'expression')) {
                const value = expression(pieces[0].expression, data, document, false);
                const sourceProvenance = lastSource;
                const normalized = jsonValue(scope, value);
                attributeSource(site, name, sourceProvenance);
                attrs[name] = value === undefined || value === null ? ''
                  : typeof value === 'object' ? jsonText(normalized) : textValue(scope, value);
                boundValues[name] = normalized;
              } else attrs[name] = interpolate(source, data, document);
            }
            for (const piece of mustaches(attrs[name], true)) if (piece.expression) mapSet(bindings, piece.expression, true);
          }
          return [{kind: 'element', tag: node.tag, attrs, boundValues, bindings: [...bindings.keys()].sort(compareKeys), directives,
            key: node.key === undefined ? null : node.key, keyScope: node.keyScope || null, sourceSite: site, lexicalOrigin,
            children: nodes(node.children, data, environment, site, whitespace || node.tag === 'text')}];
        }
        const environment = {document: task.documentId, definitions: mapGet(definitions, task.documentId), stack: []};
        const ast = {version: 1, nodes: nodes(mapGet(documents, task.documentId).ast.nodes, task.data, environment,
          sourceSite('', 'document', task.documentId), false)};
        results.push({taskId: task.taskId, ast, attributeSources});
      }
      return {ok: true, results};
    };
  }
  function render(input) {
    try {
      if (!record(input) || !array(input.documents) || !array(input.tasks))
        invalid("render batch requires documents and tasks");
      return prepareDocuments(input.documents)(input.tasks);
    } catch (error) { return replyError(error); }
  }
  function registerDocuments(input) {
    try {
      if (!record(input) || !nonempty(input.programId))
        invalid("document registration requires an opaque program id");
      const candidate = prepareDocuments(input.documents);
      registeredDocuments = {programId: input.programId, render: candidate};
      return {ok: true, programId: input.programId};
    } catch (error) { return registrationError(error); }
  }
  function renderRegistered(input) {
    try {
      if (!record(input) || !registeredDocuments || input.programId !== registeredDocuments.programId)
        invalid("document program is stale or unavailable");
      return registeredDocuments.render(input.tasks);
    } catch (error) { return replyError(error); }
  }

  function releaseScopes(input) {
    try {
      if (!array(input)) invalid('scope release batch must be an array');
      const ids = new NativeMap();
      for (const id of input) {
        if (!nonempty(id) || mapHas(ids, id)) invalid('invalid or duplicate scope release');
        mapSet(ids, id, true);
      }
      for (const id of input) mapDelete(scopes, id);
      return {ok: true};
    } catch (error) { return replyError(error); }
  }

  define(root, '__weappContainer_view_load', {value: input => guarded(load, input), writable: false, configurable: false});
  define(root, '__weappContainer_view_evaluate', {value: input => guarded(evaluate, input), writable: false, configurable: false});
  define(root, "__weappContainer_view_register_documents", {
    value: input => staticErrorIsolation(() => guarded(registerDocuments, input, true)), writable: false, configurable: false,
  });
  define(root, "__weappContainer_view_render_registered", {
    value: input => guarded(renderRegistered, input), writable: false, configurable: false,
  });
  define(root, '__weappContainer_view_render', {value: input => guarded(render, input), writable: false, configurable: false});
  define(root, '__weappContainer_view_release_scopes', {value: input => guarded(releaseScopes, input), writable: false, configurable: false});
})();
