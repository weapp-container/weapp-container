// Synchronous ECMAScript View profile. This realm deliberately keeps standard
// intrinsics mutable and never loads the WXS property ABI or its copy membrane.
// Only complete JSON batches cross the native boundary; this is not a security
// sandbox. Every transport operation below captures its intrinsic before code
// can run. Transport records/arrays have null prototypes, including replies, so
// inherited getters, iterators and toJSON hooks cannot corrupt later turns.
(function () {
  "use strict";
  const root = globalThis;
  // QuickJS ignores sourceURL comments in Function bodies. The engine supplies
  // a compiler during bootstrap only; capture it privately and remove the
  // global before any app unit can execute. It is used only for bundled units,
  // never for individual render nodes or value transport.
  const nativeModuleCompiler = root.__weappContainer_compileModernFactory;
  delete root.__weappContainer_compileModernFactory;
  const NativeFunction = Function,
    NativeProxy = Proxy,
    NativeMap = Map;
  const NativeWeakMap = WeakMap,
    NativeError = Error,
    NativeArray = Array;
  const apply = Reflect.apply,
    nativeDefine = Object.defineProperty;
  const create = Object.create,
    getPrototype = Object.getPrototypeOf;
  const setPrototype = Object.setPrototypeOf,
    descriptor = Object.getOwnPropertyDescriptor;
  const objectPrototype = Object.prototype,
    array = Array.isArray;
  const keys = Object.keys,
    stringify = JSON.stringify,
    finite = Number.isFinite;
  const NativeString = String,
    is = Object.is;
  const unscopables = Symbol.unscopables;
  const mathMax = Math.max,
    mathMin = Math.min;
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const uncurry =
    (fn) =>
    (receiver, ...args) =>
      apply(fn, receiver, args);
  const own = uncurry(Object.prototype.hasOwnProperty);
  const mapGet = uncurry(Map.prototype.get),
    mapSet = uncurry(Map.prototype.set);
  const mapHas = uncurry(Map.prototype.has),
    mapDelete = uncurry(Map.prototype.delete);
  const mapSize = uncurry(descriptor(Map.prototype, "size").get);
  const mapIterator = uncurry(Map.prototype.keys);
  const iteratorNext = uncurry(getPrototype(new NativeMap().keys()).next);
  const weakHas = uncurry(WeakMap.prototype.has),
    weakGet = uncurry(WeakMap.prototype.get);
  const weakSet = uncurry(WeakMap.prototype.set),
    weakDelete = uncurry(WeakMap.prototype.delete);
  const stringSlice = uncurry(String.prototype.slice),
    stringIndexOf = uncurry(String.prototype.indexOf);
  const stringStartsWith = uncurry(String.prototype.startsWith),
    stringEndsWith = uncurry(String.prototype.endsWith);
  const stringTrim = uncurry(String.prototype.trim),
    stringCodePointAt = uncurry(String.prototype.codePointAt);
  const regexpExec = uncurry(RegExp.prototype.exec),
    nativeSort = uncurry(Array.prototype.sort);

  function define(target, name, fields) {
    // ToPropertyDescriptor consults inherited get/set/value fields as well.
    // This boundary accepts only trusted descriptor records, including native
    // getOwnPropertyDescriptor results, and removes their mutable prototype.
    return nativeDefine(target, name, setPrototype(fields, null));
  }
  function list(...values) {
    return setPrototype(values, null);
  }
  function recordOf(fields) {
    const result = create(null),
      names = keys(fields);
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      define(result, name, descriptor(fields, name));
    }
    return result;
  }
  function push(value, ...items) {
    for (let index = 0; index < items.length; index++)
      define(value, value.length, {
        value: items[index],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    return value.length;
  }
  function append(value, items) {
    for (let index = 0; index < items.length; index++)
      push(value, items[index]);
    return value;
  }
  function appended(value, item) {
    const result = list();
    append(result, value);
    push(result, item);
    return result;
  }
  function pop(value) {
    if (!value.length) return undefined;
    const item = value[value.length - 1];
    value.length--;
    return item;
  }
  function map(value, callback) {
    const result = list();
    for (let index = 0; index < value.length; index++)
      push(result, callback(value[index], index, value));
    return result;
  }
  function some(value, callback) {
    for (let index = 0; index < value.length; index++)
      if (callback(value[index], index, value)) return true;
    return false;
  }
  function every(value, callback) {
    for (let index = 0; index < value.length; index++)
      if (!callback(value[index], index, value)) return false;
    return true;
  }
  function includes(value, item) {
    if (typeof value === "string") return stringIndexOf(value, item) >= 0;
    return some(value, (candidate) => candidate === item);
  }
  function slice(value, start, end) {
    if (typeof value === "string") return stringSlice(value, start, end);
    const result = list(),
      length = value.length;
    start =
      start === undefined
        ? 0
        : start < 0
          ? mathMax(0, length + start)
          : mathMin(length, start);
    end =
      end === undefined
        ? length
        : end < 0
          ? mathMax(0, length + end)
          : mathMin(length, end);
    for (let index = start; index < end; index++) push(result, value[index]);
    return result;
  }
  function split(value, separator) {
    const result = list();
    let start = 0,
      next;
    while ((next = stringIndexOf(value, separator, start)) >= 0) {
      push(result, stringSlice(value, start, next));
      start = next + separator.length;
    }
    push(result, stringSlice(value, start));
    return result;
  }
  function join(value, separator) {
    let result = "";
    for (let index = 0; index < value.length; index++)
      result += (index ? separator : "") + value[index];
    return result;
  }
  function sort(value, compare) {
    return nativeSort(value, compare);
  }
  function test(pattern, value) {
    return regexpExec(pattern, value) !== null;
  }
  function mapKeys(value) {
    const result = list(),
      iterator = mapIterator(value);
    let next;
    while (!(next = iteratorNext(iterator)).done) push(result, next.value);
    return result;
  }
  function replacePrefix(value) {
    if (stringStartsWith(value, "./")) value = stringSlice(value, 2);
    if (stringStartsWith(value, "/")) value = stringSlice(value, 1);
    return value;
  }
  // Input parsing stays native. Metadata removes prototype lookups left by the
  // parser while task.data keeps normal JS data in this realm. Replies are
  // encoded privately: QuickJS's native JSON writer uses a mutable Array stack
  // internally and can invoke an inherited index setter even for safe replies.
  function metadata(value, depth = 0) {
    if (depth > 256) invalid("maximum transport depth exceeded");
    if (value === null || typeof value !== "object") return value;
    if (array(value)) {
      const result = list();
      for (let index = 0; index < value.length; index++)
        push(result, metadata(value[index], depth + 1));
      return result;
    }
    const result = create(null),
      names = keys(value);
    const task =
      own(value, "taskId") && own(value, "scopeId") && own(value, "documentId");
    for (let index = 0; index < names.length; index++) {
      const key = names[index];
      define(result, key, {
        value:
          task && key === "data" ? value[key] : metadata(value[key], depth + 1),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  }
  let modules = new NativeMap(),
    scopes = new NativeMap(),
    expressionCache = new NativeMap();
  const internalErrors = new NativeWeakMap(),
    MAX_EXPRESSIONS = 4096;
  let busy = false;
  function fail(code, message) {
    const error = new NativeError(message);
    weakSet(internalErrors, error, code);
    throw error;
  }
  function invalid(message) {
    fail("ERR_VIEW_INVALID_BATCH", message);
  }
  function unsupported(message) {
    fail("ERR_VIEW_UNSUPPORTED_VALUE", message);
  }
  // ECMAScript strings may contain unpaired UTF-16 surrogates internally, but
  // the Rust/JSON sink stores Unicode scalar values. Reject only at that sink;
  // do not silently replace user data or restrict ordinary JS computations.
  function scalarString(value) {
    for (let index = 0; index < value.length; index++) {
      const code = stringCodePointAt(value, index);
      if (code >= 0xd800 && code <= 0xdfff) return false;
      if (code >= 0x10000) index++;
    }
    return true;
  }
  function sinkString(value) {
    if (!scalarString(value))
      unsupported("unpaired UTF-16 surrogate cannot enter a View transport sink");
    return value;
  }
  function diagnosticString(value) {
    if (scalarString(value)) return value;
    const hex = "0123456789abcdef";
    let result = "";
    for (let index = 0; index < value.length; index++) {
      const code = stringCodePointAt(value, index);
      if (code >= 0xd800 && code <= 0xdfff)
        result +=
          "\\u" +
          hex[(code >> 12) & 15] +
          hex[(code >> 8) & 15] +
          hex[(code >> 4) & 15] +
          hex[code & 15];
      else {
        result += stringSlice(value, index, index + (code >= 0x10000 ? 2 : 1));
        if (code >= 0x10000) index++;
      }
    }
    return result;
  }
  function errorString(error, field) {
    try {
      const value = error === null || error === undefined ? undefined : error[field];
      return typeof value === "string" ? diagnosticString(value) : undefined;
    } catch (_) {
      return undefined;
    }
  }
  function replyError(error) {
    let message = errorString(error, "message");
    if (message === undefined) {
      try {
        message = diagnosticString(NativeString(error));
      } catch (_) {
        message = "View execution failed";
      }
    }
    return recordOf({
      ok: false,
      error: recordOf({
        code:
          error !== null &&
          (typeof error === "object" || typeof error === "function") &&
          weakHas(internalErrors, error)
            ? weakGet(internalErrors, error)
            : "ERR_VIEW_EXECUTION",
        message,
        stack: errorString(error, "stack"),
      }),
    });
  }
  function guarded(run, input, staticRegistration) {
    if (busy)
      return jsonText(
        recordOf({
          ok: false,
          error: recordOf({
            code: "ERR_VIEW_INVALID_BATCH",
            message: "reentrant View execution is forbidden",
          }),
        }),
      );
    busy = true;
    try {
      return jsonText(run(metadata(input)));
    } catch (error) {
      return jsonText(staticRegistration ? registrationError(error) : replyError(error));
    } finally {
      busy = false;
    }
  }
  function nonempty(value) {
    return typeof value === "string" && value.length > 0;
  }
  function validId(id) {
    if (!nonempty(id) || !stringStartsWith(id, "modern:")) return false;
    const path = stringSlice(id, 7);
    return (
      path.length > 0 &&
      !test(/[\\#?:\u0000-\u001f\u007f-\u009f]/, path) &&
      !stringStartsWith(path, "/") &&
      every(split(path, "/"), (part) => part && part !== "." && part !== "..")
    );
  }
  function load(input) {
    if (!array(input)) invalid("module batch must be an array");
    const candidate = new NativeMap();
    for (let index = 0; index < input.length; index++) {
      const item = input[index];
      if (
        !item ||
        !validId(item.id) ||
        typeof item.source !== "string" ||
        !array(item.dependencies) ||
        item.dependencies.length ||
        item.compilation !== undefined ||
        mapHas(candidate, item.id)
      )
        invalid("invalid or duplicate bundled modern View module");
      let factory;
      try {
        const filename = "weapp-view:///" + item.id + ".js";
        factory =
          typeof nativeModuleCompiler === "function"
            ? nativeModuleCompiler(
                '(function anonymous(module,exports\n) {\n"use strict";\n' +
                  item.source +
                  "\n})",
                filename,
              )
            : new NativeFunction(
                "module",
                "exports",
                '"use strict";\n' +
                  item.source +
                  "\n//# sourceURL=" +
                  filename +
                  "\n",
              );
      } catch (error) {
        fail(
          "ERR_VIEW_MODULE",
          "cannot compile " + item.id + ": " + error.message,
        );
      }
      mapSet(candidate, item.id, factory);
    }
    modules = candidate;
    registeredDocuments = null;
    scopes = new NativeMap();
    expressionCache = new NativeMap();
    return recordOf({ ok: true });
  }
  function compileExpression(source, _compilation, shorthand, document) {
    const key = jsonText(list(document, shorthand, source));
    if (mapHas(expressionCache, key)) return mapGet(expressionCache, key);
    let run;
    try {
      run = new NativeFunction(
        "scope",
        "with(scope){return (\n" +
          source +
          "\n);}\n" +
          "//# sourceURL=weapp-view:///expression/" +
          document +
          ".js\n",
      );
    } catch (error) {
      if (!shorthand) throw error;
      run = new NativeFunction(
        "scope",
        "with(scope){return ({\n" +
          source +
          "\n});}\n" +
          "//# sourceURL=weapp-view:///expression/" +
          document +
          ".js\n",
      );
    }
    if (mapSize(expressionCache) >= MAX_EXPRESSIONS)
      mapDelete(
        expressionCache,
        iteratorNext(mapIterator(expressionCache)).value,
      );
    mapSet(expressionCache, key, run);
    return run;
  }
  function newScope() {
    const cache = new NativeMap(),
      documents = new NativeMap();
    function requireUnit(id) {
      if (mapHas(cache, id)) return mapGet(cache, id).exports;
      if (!mapHas(modules, id))
        fail("ERR_VIEW_MODULE", "unknown modern View module " + id);
      const module = recordOf({ exports: create(null) });
      mapSet(cache, id, module);
      try {
        apply(mapGet(modules, id), undefined, list(module, module.exports));
      } catch (error) {
        mapDelete(cache, id);
        throw error;
      }
      return module.exports;
    }
    function raw(task, run) {
      const data = task.data;
      const lexical = new NativeProxy(create(null), {
        has() {
          return true;
        },
        get(_target, key) {
          if (key === unscopables) return undefined;
          if (own(task.bindings, key)) {
            if(task.onExternalRead) task.onExternalRead();
            const unit = requireUnit(task.bindings[key]);
            if (
              !unit ||
              !own(unit, task.documentId) ||
              !unit[task.documentId] ||
              !own(unit[task.documentId], key)
            )
              fail(
                "ERR_VIEW_MODULE",
                "modern namespace mapping does not match declaring document",
              );
            return unit[task.documentId][key];
          }
          if (own(data, key)) return data[key];
          if (
            typeof key === "string" &&
            stringStartsWith(key, "__weappContainer_")
          )
            return undefined;
          if(task.onExternalRead) task.onExternalRead();
          return root[key];
        },
      });
      return apply(run, undefined, list(lexical));
    }
    function encode(value, active) {
      switch (typeof value) {
        case "undefined":
          return recordOf({ type: "undefined" });
        case "boolean":
          return recordOf({ type: "bool", value });
        case "string":
          return recordOf({ type: "string", value: sinkString(value) });
        case "number":
          if (value !== value) return recordOf({ type: "nan" });
          if (value === Infinity) return recordOf({ type: "positiveInfinity" });
          if (value === -Infinity)
            return recordOf({ type: "negativeInfinity" });
          if (is(value, -0)) return recordOf({ type: "negativeZero" });
          return recordOf({ type: "number", value });
        case "object":
          break;
        default:
          unsupported("View result contains a function, symbol or bigint");
      }
      if (value === null) return recordOf({ type: "null" });
      // Inherited then/toJSON hooks on mutable standard prototypes are never
      // transport hooks. Explicit thenables and opaque native values fail.
      if (own(value, "then") && typeof value.then === "function")
        unsupported("async View results are unsupported");
      const proto = getPrototype(value);
      if (!array(value) && proto !== objectPrototype && proto !== null)
        unsupported("non-data View result");
      if (weakHas(active, value)) unsupported("cyclic View result");
      weakSet(active, value, true);
      let result;
      if (array(value)) {
        const values = list();
        for (let index = 0; index < value.length; index++)
          push(values, encode(value[index], active));
        result = recordOf({ type: "array", value: values });
      } else {
        const values = create(null),
          names = keys(value);
        for (let index = 0; index < names.length; index++)
          values[sinkString(names[index])] = encode(value[names[index]], active);
        result = recordOf({ type: "object", value: values });
      }
      weakDelete(active, value);
      return result;
    }
    function encoded(value) {
      return encode(value, new NativeWeakMap());
    }
    return recordOf({ documents, raw, encoded });
  }
  function evaluate(input) {
    if (!array(input)) invalid("expression batch must be an array");
    const ids = new NativeMap(),
      prepared = list(),
      pendingScopes = new NativeMap(),
      pendingDocuments = new NativeMap();
    for (let index = 0; index < input.length; index++) {
      const task = input[index];
      if (
        !task ||
        !nonempty(task.taskId) ||
        !nonempty(task.scopeId) ||
        !documentId(task.documentId) ||
        !nonempty(task.expression) ||
        !record(task.data) ||
        !stringMap(task.bindings) ||
        mapHas(ids, task.taskId)
      )
        invalid("invalid or duplicate expression task");
      mapSet(ids, task.taskId, true);
      validateBindings(task.bindings);
      const run = compileExpression(
        task.expression,
        undefined,
        false,
        task.documentId,
      );
      let scope =
        mapGet(scopes, task.scopeId) || mapGet(pendingScopes, task.scopeId);
      if (!scope) {
        scope = newScope();
        mapSet(pendingScopes, task.scopeId, scope);
      }
      const fingerprint = jsonText(
        map(orderedKeys(task.bindings), (name) =>
          list(name, task.bindings[name]),
        ),
      );
      if (
        mapHas(scope.documents, task.documentId) &&
        mapGet(scope.documents, task.documentId) !== fingerprint
      ) {
        invalid("document bindings changed without module reload");
      }
      const pendingKey = jsonText(list(task.scopeId, task.documentId));
      if (
        mapHas(pendingDocuments, pendingKey) &&
        mapGet(pendingDocuments, pendingKey) !== fingerprint
      ) {
        invalid("document bindings disagree within the batch");
      }
      mapSet(pendingDocuments, pendingKey, fingerprint);
      push(prepared, recordOf({ task, run, scope, fingerprint }));
    }
    const results = list();
    for (let index = 0; index < prepared.length; index++) {
      const item = prepared[index],
        task = item.task;
      mapSet(scopes, task.scopeId, item.scope);
      mapSet(item.scope.documents, task.documentId, item.fingerprint);
    }
    for (let index = 0; index < prepared.length; index++) {
      const item = prepared[index],
        task = item.task,
        scope = item.scope;
      push(
        results,
        recordOf({
          taskId: task.taskId,
          value: scope.encoded(scope.raw(task, item.run)),
        }),
      );
    }
    return recordOf({ ok: true, results });
  }
  function validateBindings(bindings) {
    const names = keys(bindings);
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      if (!validAlias(name) || !mapHas(modules, bindings[name]))
        invalid("invalid modern lexical binding");
    }
  }

  // The traversal below mirrors the legacy WXML contract. Its control flow,
  // lexical document provenance and typed render sinks stay shared in behavior;
  // all host method calls use captured intrinsics rather than mutable globals.
  function record(value) {
    return value !== null && typeof value === "object" && !array(value);
  }
  function stringMap(value) {
    return (
      record(value) &&
      every(keys(value), (key) => typeof value[key] === "string")
    );
  }
  function copyRecord(value) {
    const result = create(null);
    {
      const __items0 = keys(value);
      for (let __index0 = 0; __index0 < __items0.length; __index0++) {
        const key = __items0[__index0];
        result[key] = value[key];
      }
    }
    return result;
  }
  function documentId(value) {
    return (
      nonempty(value) &&
      stringEndsWith(value, ".wxml") &&
      !test(/[\\#?:\u0000-\u001f\u007f-\u009f]/, value) &&
      !stringStartsWith(value, "/") &&
      every(split(value, "/"), (part) => part && part !== "." && part !== "..")
    );
  }
  function utf8Length(value) {
    let length = 0;
    for (let index = 0; index < value.length; index++) {
      const code = stringCodePointAt(value, index);
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
    return parent + "/" + kind + utf8Length(value) + ":" + value;
  }
  function compareKeys(left, right) {
    // Rust's BTreeMap follows UTF-8 scalar ordering, including astral keys.
    let a = 0,
      b = 0;
    while (a < left.length && b < right.length) {
      const x = stringCodePointAt(left, a),
        y = stringCodePointAt(right, b);
      if (x !== y) return x < y ? -1 : 1;
      a += x >= 0x10000 ? 2 : 1;
      b += y >= 0x10000 ? 2 : 1;
    }
    return a < left.length ? 1 : b < right.length ? -1 : 0;
  }
  function orderedKeys(value) {
    return sort(keys(value), compareKeys);
  }
  // Serialize trusted normalized output without invoking toJSON, inherited
  // array setters, user iterators or mutable JSON globals. Primitive quoting
  // uses the captured native writer; it never pushes an object on its stack.
  function jsonText(value) {
    if (array(value)) {
      let result = "[";
      for (let index = 0; index < value.length; index++) {
        const encoded = jsonText(value[index]);
        result +=
          (index ? "," : "") + (encoded === undefined ? "null" : encoded);
      }
      return result + "]";
    }
    if (record(value)) {
      let result = "{",
        count = 0;
      const names = orderedKeys(value);
      for (let index = 0; index < names.length; index++) {
        const name = names[index],
          encoded = jsonText(value[name]);
        if (encoded === undefined) continue;
        result += (count++ ? "," : "") + stringify(sinkString(name)) + ":" + encoded;
      }
      return result + "}";
    }
    return stringify(typeof value === "string" ? sinkString(value) : value);
  }
  function validBindings(value) {
    if (!array(value)) return false;
    const found = new NativeMap();
    {
      const __items1 = value;
      for (let __index1 = 0; __index1 < __items1.length; __index1++) {
        const binding = __items1[__index1];
        if (!nonempty(binding) || mapHas(found, binding)) return false;
        mapSet(found, binding, true);
      }
    }
    return true;
  }
  function validAlias(value) {
    return (
      typeof value === "string" &&
      test(identifier, value) &&
      !includes(
        " break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield await ",
        " " + value + " ",
      )
    );
  }
  function resolveDocument(from, request, documents) {
    if (!nonempty(request) || test(/[\\#?\u0000-\u001f]/, request))
      invalid("invalid WXML document reference");
    const source = stringTrim(request);
    const relative = stringStartsWith(source, "template:")
      ? slice(source, 9)
      : source;
    const parts = stringStartsWith(relative, "/")
      ? list()
      : slice(split(from, "/"), 0, -1);
    {
      const __items2 = split(relative, "/");
      for (let __index2 = 0; __index2 < __items2.length; __index2++) {
        const part = __items2[__index2];
        if (!part || part === ".") continue;
        if (part === "..") {
          if (!parts.length)
            invalid("WXML document reference escapes the package root");
          pop(parts);
        } else push(parts, part);
      }
    }
    const resolved = join(parts, "/");
    if (mapHas(documents, resolved)) return resolved;
    // Preserve the existing IR evaluator's package-relative map alias.
    const direct = replacePrefix(relative);
    if (documentId(direct) && mapHas(documents, direct)) return direct;
    invalid("WXML document target not found: " + source);
  }
  function mustaches(source, metadataOnly) {
    const pieces = list();
    let cursor = 0;
    while (cursor < source.length) {
      const start = stringIndexOf(source, "{{", cursor);
      if (start < 0) {
        push(pieces, recordOf({ literal: slice(source, cursor) }));
        break;
      }
      if (start > cursor)
        push(pieces, recordOf({ literal: slice(source, cursor, start) }));
      let quote = "",
        escaped = false,
        braces = 0,
        end = -1;
      for (let index = start + 2; index < source.length; index++) {
        const character = source[index];
        if (quote) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === quote) quote = "";
        } else if (character === "'" || character === '"' || character === "`")
          quote = character;
        else if (character === "{") braces++;
        else if (character === "}" && braces) braces--;
        else if (character === "}" && source[index + 1] === "}") {
          end = index;
          break;
        }
      }
      if (end < 0) {
        if (metadataOnly) break;
        invalid("unterminated WXML mustache expression");
      }
      const expression = stringTrim(slice(source, start + 2, end));
      if (!expression && !metadataOnly)
        invalid("empty WXML mustache expression");
      push(pieces, recordOf({ expression }));
      cursor = end + 2;
    }
    return pieces;
  }
  function directiveExpression(value) {
    if (typeof value !== "string") return undefined;
    let source = stringTrim(value);
    if (stringStartsWith(source, "{{") && stringEndsWith(source, "}}"))
      source = stringTrim(slice(source, 2, -2));
    return source || undefined;
  }
  function normalizedDirectives(node) {
    const result = copyRecord(node.directives || create(null));
    // Normalized directives are authoritative. A loop's recursive clean node
    // deliberately retains its source attrs while removing forExpr here.
    if (node.directives !== undefined) return result;
    {
      const __items3 = list(
        list("ifExpr", "wx:if"),
        list("elifExpr", "wx:elif"),
        list("forExpr", "wx:for"),
        list("forItem", "wx:for-item"),
        list("forIndex", "wx:for-index"),
        list("forKey", "wx:key"),
      );
      for (let __index3 = 0; __index3 < __items3.length; __index3++) {
        const pair = __items3[__index3];
        if (!own(result, pair[0]) && own(node.attrs, pair[1])) {
          const value = directiveExpression(node.attrs[pair[1]]);
          if (value !== undefined) result[pair[0]] = value;
        }
      }
    }
    if (!own(result, "elseBranch") && own(node.attrs, "wx:else"))
      result.elseBranch = true;
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
      prepare = apply(nativePrepareGet, NativeError, list());
      apply(nativePrepareSet, NativeError, list(undefined));
    }
    if (nativeLimitGet) {
      limit = apply(nativeLimitGet, NativeError, list());
      apply(nativeLimitSet, NativeError, list(0));
    }
    try { return run(); }
    finally {
      if (nativeLimitSet) apply(nativeLimitSet, NativeError, list(limit));
      if (nativePrepareSet) apply(nativePrepareSet, NativeError, list(prepare));
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
    return recordOf({ok: false, documentProgramRejected: weakHas(internalErrors, error),
      error: recordOf({code: weakHas(internalErrors, error) ? weakGet(internalErrors, error) : "ERR_VIEW_EXECUTION",
        message: diagnosticString(staticErrorMessage(error))})});
  }
  function prepareDocuments(inputDocuments) {
    if (!array(inputDocuments)) invalid("document program requires documents");
      const documents = new NativeMap(),
        expressions = new NativeMap(),
        definitions = new NativeMap();
      function compile(source, shorthand, document) {
        const localKey = (shorthand ? "data:" : "expr:") + source;
        let local = mapGet(expressions, document.documentId);
        if (!local) { local = new NativeMap(); mapSet(expressions, document.documentId, local); }
        if (mapHas(local, localKey)) return mapGet(local, localKey);
        let run;
        try {
          run = compileExpression(
            source,
            undefined,
            shorthand,
            document.documentId,
          );
        } catch (error) {
          if (weakHas(internalErrors, error)) throw error;
          if (error === null || typeof error !== "object" || getPrototype(error) !== nativeSyntaxErrorPrototype) throw error;
          fail(
            "ERR_VIEW_EXECUTION",
            "invalid WXML expression: " + staticErrorMessage(error),
          );
        }
        mapSet(local, localKey, run);
        return run;
      }
      function scanInterpolations(source, document) {
        {
          const __items4 = mustaches(source);
          for (let __index4 = 0; __index4 < __items4.length; __index4++) {
            const piece = __items4[__index4];
            if (own(piece, "expression"))
              compile(piece.expression, false, document);
          }
        }
      }
      function dataExpression(source) {
        const expression = directiveExpression(source);
        if (!expression)
          invalid("WXML template data expression cannot be empty");
        return expression;
      }
      function validateSourceOrigin(node, document) {
        if (
          node.lexicalOrigin !== undefined &&
          node.lexicalOrigin !== null &&
          (!record(node.lexicalOrigin) ||
            keys(node.lexicalOrigin).length !== 1 ||
            !documentId(node.lexicalOrigin.documentId) ||
            node.lexicalOrigin.documentId !== document.documentId)
        )
          invalid(
            "WXML source lexical origin disagrees with its declaring document",
          );
      }
      function validateNodes(nodes, depth, document, aliases) {
        if (!array(nodes) || depth > 128)
          invalid("invalid WXML nodes or maximum source depth exceeded");
        {
          const __items5 = nodes;
          for (let __index5 = 0; __index5 < __items5.length; __index5++) {
            const node = __items5[__index5];
            if (!record(node) || !nonempty(node.kind))
              invalid("invalid WXML node");
            validateSourceOrigin(node, document);
            if (node.kind === "comment") {
              if (typeof node.value !== "string")
                invalid("invalid WXML comment");
              continue;
            }
            if (node.kind === "text") {
              if (
                typeof node.value !== "string" ||
                !validBindings(node.bindings)
              )
                invalid("invalid WXML text");
              scanInterpolations(node.value, document);
              continue;
            }
            if (
              node.kind !== "element" ||
              !nonempty(node.tag) ||
              test(/\s/, node.tag) ||
              !stringMap(node.attrs) ||
              some(
                keys(node.attrs),
                (name) => !nonempty(name) || test(/\s/, name),
              ) ||
              !validBindings(node.bindings) ||
              (node.boundValues !== undefined && !record(node.boundValues)) ||
              (node.key !== undefined &&
                node.key !== null &&
                typeof node.key !== "string") ||
              (node.keyScope !== undefined &&
                node.keyScope !== null &&
                typeof node.keyScope !== "string") ||
              (node.sourceSite !== undefined &&
                node.sourceSite !== null &&
                typeof node.sourceSite !== "string") ||
              (node.directives !== undefined && !record(node.directives))
            )
              invalid("invalid WXML element");
            if (!array(node.children))
              invalid("WXML element requires children");
            if (node.tag === "wxs") {
              if (
                some(
                  node.children,
                  (child) =>
                    !record(child) ||
                    child.kind !== "text" ||
                    typeof child.value !== "string" ||
                    !validBindings(child.bindings),
                )
              )
                invalid("View declarations require raw text");
              {
                const __items6 = node.children;
                for (let __index6 = 0; __index6 < __items6.length; __index6++) {
                  const child = __items6[__index6];
                  validateSourceOrigin(child, document);
                }
              }
              const alias = node.attrs.module;
              if (
                !validAlias(alias) ||
                mapHas(aliases, alias) ||
                !own(document.bindings, alias)
              )
                invalid(
                  "invalid, duplicate or unbound modern View declaration",
                );
              mapSet(aliases, alias, true);
              continue;
            }
            const directives = normalizedDirectives(node);
            {
              const __items7 = list(
                "ifExpr",
                "elifExpr",
                "forExpr",
                "forItem",
                "forIndex",
                "forKey",
              );
              for (let __index7 = 0; __index7 < __items7.length; __index7++) {
                const name = __items7[__index7];
                if (
                  own(directives, name) &&
                  typeof directives[name] !== "string"
                )
                  invalid("invalid WXML directive");
              }
            }
            if (
              own(directives, "elseBranch") &&
              typeof directives.elseBranch !== "boolean"
            )
              invalid("invalid WXML else directive");
            if (own(directives, "events") && !stringMap(directives.events))
              invalid("invalid WXML event directives");
            if (
              (own(directives, "ifExpr") && own(directives, "elifExpr")) ||
              (directives.elseBranch &&
                (own(directives, "ifExpr") || own(directives, "elifExpr"))) ||
              (!own(directives, "forExpr") &&
                (own(directives, "forItem") || own(directives, "forIndex")))
            )
              invalid("inconsistent WXML control directives");
            {
              const __items8 = list("ifExpr", "elifExpr", "forExpr");
              for (let __index8 = 0; __index8 < __items8.length; __index8++) {
                const name = __items8[__index8];
                if (directives[name])
                  compile(directives[name], false, document);
              }
            }
            if (directives.forKey && includes(directives.forKey, "."))
              compile(directives.forKey, false, document);
            {
              const __items9 = keys(node.attrs);
              for (let __index9 = 0; __index9 < __items9.length; __index9++) {
                const name = __items9[__index9];
                if (
                  stringStartsWith(name, "wx:") ||
                  (node.boundValues && own(node.boundValues, name))
                )
                  continue;
                if (node.tag === "template" && name === "data")
                  compile(dataExpression(node.attrs[name]), true, document);
                else scanInterpolations(node.attrs[name], document);
              }
            }
            validateNodes(node.children, depth + 1, document, aliases);
          }
        }
      }
      // Register every document before resolving any relative import/include.
      {
        const __items10 = inputDocuments;
        for (let __index10 = 0; __index10 < __items10.length; __index10++) {
          const document = __items10[__index10];
          if (
            !record(document) ||
            !documentId(document.documentId) ||
            mapHas(documents, document.documentId) ||
            !record(document.ast) ||
            document.ast.version !== 1 ||
            !stringMap(document.bindings)
          )
            invalid("invalid or duplicate render document");
          validateBindings(document.bindings);
          if (document.compilation !== undefined)
            invalid("modern documents cannot use the WXS helper ABI");
          mapSet(documents, document.documentId, document);
        }
      }
      {
        const __items11 = inputDocuments;
        for (let __index11 = 0; __index11 < __items11.length; __index11++) {
          const document = __items11[__index11];
          validateNodes(document.ast.nodes, 0, document, new NativeMap());
        }
      }
      function collect(document, nodes, output, stack, declarationPass) {
        if (declarationPass) {
          {
            const __items12 = nodes;
            for (let __index12 = 0; __index12 < __items12.length; __index12++) {
              const node = __items12[__index12];
              if (node.kind !== "element" || node.tag === "wxs") continue;
              if (
                node.tag === "template" &&
                own(node.attrs, "name") &&
                stringTrim(node.attrs.name)
              ) {
                mapSet(
                  output,
                  node.attrs.name,
                  recordOf({ document, nodes: node.children }),
                );
              }
              collect(document, node.children, output, stack, true);
            }
          }
          return;
        }
        // Local declarations are visible even when their call precedes them.
        collect(document, nodes, output, stack, true);
        {
          const __items13 = nodes;
          for (let __index13 = 0; __index13 < __items13.length; __index13++) {
            const node = __items13[__index13];
            if (node.kind !== "element" || node.tag === "wxs") continue;
            if (node.tag === "import" || node.tag === "include") {
              if (!own(node.attrs, "src"))
                invalid("WXML " + node.tag + " requires src");
              const target = resolveDocument(
                document,
                node.attrs.src,
                documents,
              );
              const edge = node.tag + ":" + target;
              if (includes(stack, edge) || stack.length >= 32)
                invalid("WXML document dependency cycle or depth exceeded");
              collect(
                target,
                mapGet(documents, target).ast.nodes,
                output,
                appended(stack, edge),
                false,
              );
            }
            collect(document, node.children, output, stack, false);
          }
        }
      }
      {
        const __items14 = inputDocuments;
        for (let __index14 = 0; __index14 < __items14.length; __index14++) {
          const document = __items14[__index14];
          const names = new NativeMap();
          collect(
            document.documentId,
            document.ast.nodes,
            names,
            list(),
            false,
          );
          mapSet(definitions, document.documentId, names);
        }
      }
    const fingerprints = new NativeMap();
    for (let index = 0; index < inputDocuments.length; index++) {
      const document = inputDocuments[index];
      mapSet(fingerprints, document.documentId, jsonText(map(orderedKeys(document.bindings),
        alias => list(alias, document.bindings[alias]))));
    }
    return function renderTasks(inputTasks) {
      if (!array(inputTasks)) invalid("registered render requires tasks");
      const ids = new NativeMap(),
        pendingScopes = new NativeMap(),
        prepared = list();
      {
        const __items15 = inputTasks;
        for (let __index15 = 0; __index15 < __items15.length; __index15++) {
          const task = __items15[__index15];
          if (
            !record(task) ||
            !nonempty(task.taskId) ||
            !nonempty(task.scopeId) ||
            mapHas(ids, task.taskId) ||
            !mapHas(documents, task.documentId) ||
            !record(task.data)
          )
            invalid("invalid or duplicate render task");
          mapSet(ids, task.taskId, true);
          let scope =
            mapGet(scopes, task.scopeId) || mapGet(pendingScopes, task.scopeId);
          if (!scope) {
            scope = newScope();
            mapSet(pendingScopes, task.scopeId, scope);
          }
          {
            const __items16 = inputDocuments;
            for (let __index16 = 0; __index16 < __items16.length; __index16++) {
              const document = __items16[__index16];
              const fingerprint = mapGet(fingerprints, document.documentId);
              if (
                mapHas(scope.documents, document.documentId) &&
                mapGet(scope.documents, document.documentId) !== fingerprint
              )
                invalid("document bindings changed without module reload");
            }
          }
          push(prepared, recordOf({ task, scope }));
        }
      }
      // No stateful module runs before the entire input and graph are checked.
      {
        const __items17 = prepared;
        for (let __index17 = 0; __index17 < __items17.length; __index17++) {
          const item = __items17[__index17];
          mapSet(scopes, item.task.scopeId, item.scope);
          {
            const __items18 = inputDocuments;
            for (let __index18 = 0; __index18 < __items18.length; __index18++) {
              const document = __items18[__index18];
              mapSet(
                item.scope.documents,
                document.documentId,
                mapGet(fingerprints, document.documentId),
              );
            }
          }
        }
      }
      function jsonValue(scope, value) {
        function decode(tag) {
          switch (tag.type) {
            case "undefined":
            case "null":
              return null;
            case "bool":
            case "number":
            case "string":
              return tag.value;
            case "negativeZero":
              return 0;
            case "array":
              return map(tag.value, decode);
            case "object": {
              const result = create(null);
              {
                const __items19 = orderedKeys(tag.value);
                for (
                  let __index19 = 0;
                  __index19 < __items19.length;
                  __index19++
                ) {
                  const key = __items19[__index19];
                  if (tag.value[key].type !== "undefined")
                    result[key] = decode(tag.value[key]);
                }
              }
              return result;
            }
            default:
              unsupported(
                "non-finite WXML values cannot enter a JSON attribute",
              );
          }
        }
        return decode(scope.encoded(value));
      }
      function textValue(scope, value) {
        if (value === undefined || value === null) return "";
        if (typeof value === "number" && !finite(value))
          unsupported(
            "non-finite WXML expression result cannot enter render text",
          );
        if (
          typeof value === "string" ||
          typeof value === "boolean" ||
          typeof value === "number"
        )
          return NativeString(value);
        return jsonText(jsonValue(scope, value));
      }
      const results = list();
      {
        const __items20 = prepared;
        for (let __index20 = 0; __index20 < __items20.length; __index20++) {
          const item = __items20[__index20];
          const task = item.task,
            scope = item.scope;
          const tracer=bindingTracer(task.data), attributeSources=list();
          let lastSource=null;
          function expression(source,data,document,shorthand) {
            const definition=mapGet(documents,document), tracked=tracer.begin(data);let value;
            try {value=scope.raw(recordOf({data:tracked,documentId:document,bindings:definition.bindings,onExternalRead:()=>tracer.external()}),compile(source,shorthand,definition));}
            finally {lastSource=tracer.end(value);}
            return value;
          }
          function attributeSource(site,name,source) {push(attributeSources,recordOf({sourceSite:site,attribute:name,paths:source?source.paths:list(),directPath:source&&source.origin&&source.origin.path||null,supported:!!source&&source.supported}));}
          function interpolate(source, data, document) {
            let output = "";
            {
              const __items21 = mustaches(source);
              for (
                let __index21 = 0;
                __index21 < __items21.length;
                __index21++
              ) {
                const piece = __items21[__index21];
                output += own(piece, "literal")
                  ? piece.literal
                  : textValue(
                      scope,
                      expression(piece.expression, data, document, false),
                    );
              }
            }
            return output;
          }
          function enter(environment, edge, document) {
            if (
              includes(environment.stack, edge) ||
              environment.stack.length >= 32
            )
              invalid("WXML template/include cycle or depth exceeded");
            return recordOf({
              document,
              definitions: environment.definitions,
              stack: appended(environment.stack, edge),
            });
          }
          function stripControls(nodes) {
            {
              const __items22 = nodes;
              for (
                let __index22 = 0;
                __index22 < __items22.length;
                __index22++
              ) {
                const node = __items22[__index22];
                if (node.kind !== "element") continue;
                {
                  const __items23 = list(
                    "ifExpr",
                    "elifExpr",
                    "elseBranch",
                    "forExpr",
                    "forItem",
                    "forIndex",
                    "forKey",
                  );
                  for (
                    let __index23 = 0;
                    __index23 < __items23.length;
                    __index23++
                  ) {
                    const name = __items23[__index23];
                    delete node.directives[name];
                  }
                }
                stripControls(node.children);
              }
            }
            return nodes;
          }
          function nodes(source, data, environment, site, whitespace) {
            const output = list();
            let conditional = false,
              taken = false;
            for (let index = 0; index < source.length; index++) {
              const node = source[index],
                nextSite = sourceSite(site, "node", NativeString(index));
              const separator =
                node.kind === "comment" ||
                (node.kind === "text" && !stringTrim(node.value));
              if (separator || node.kind !== "element") {
                append(
                  output,
                  one(node, data, environment, nextSite, whitespace),
                );
                if (!separator) {
                  conditional = false;
                  taken = false;
                }
                continue;
              }
              const directives = normalizedDirectives(node);
              if (directives.forExpr) {
                conditional = false;
                taken = false;
                append(
                  output,
                  one(node, data, environment, nextSite, whitespace),
                );
                continue;
              }
              if (
                !directives.ifExpr &&
                !directives.elifExpr &&
                !directives.elseBranch
              ) {
                conditional = false;
                taken = false;
                append(
                  output,
                  one(node, data, environment, nextSite, whitespace),
                );
                continue;
              }
              if (directives.ifExpr) {
                conditional = true;
                taken = false;
              } else if (!conditional)
                invalid(
                  "wx:elif/wx:else must follow wx:if in the same sibling list",
                );
              if (taken) continue;
              if (directives.ifExpr || directives.elifExpr) {
                if (
                  !expression(
                    directives.ifExpr || directives.elifExpr,
                    data,
                    environment.document,
                    false,
                  )
                )
                  continue;
              }
              taken = true;
              append(
                output,
                one(node, data, environment, nextSite, whitespace),
              );
            }
            return output;
          }
          function one(node, data, environment, site, whitespace) {
            const document = environment.document;
            // Lexical document provenance is separate from source occurrence,
            // component configuration and the scope which owns a slot listener.
            // It never chooses expression bindings: environment.document does.
            const lexicalOrigin = recordOf({ documentId: document });
            if (node.kind === "comment")
              return list(
                recordOf({ kind: "comment", value: node.value, lexicalOrigin }),
              );
            if (node.kind === "text") {
              if (
                !whitespace &&
                !node.bindings.length &&
                !stringTrim(node.value) &&
                test(/[\r\n]/, node.value)
              )
                return list();
              const bindings = new NativeMap();
              {
                const __items24 = node.bindings;
                for (
                  let __index24 = 0;
                  __index24 < __items24.length;
                  __index24++
                ) {
                  const value = __items24[__index24];
                  mapSet(bindings, value, true);
                }
              }
              {
                const __items25 = mustaches(node.value);
                for (
                  let __index25 = 0;
                  __index25 < __items25.length;
                  __index25++
                ) {
                  const piece = __items25[__index25];
                  if (piece.expression)
                    mapSet(bindings, piece.expression, true);
                }
              }
              return list(
                recordOf({
                  kind: "text",
                  value: interpolate(node.value, data, document),
                  bindings: sort(mapKeys(bindings), compareKeys),
                  lexicalOrigin,
                }),
              );
            }
            if (node.tag === "wxs") return list();
            site = node.sourceSite || site;
            const directives = normalizedDirectives(node);
            if (directives.forExpr) {
              const collection = expression(
                  directives.forExpr,
                  data,
                  document,
                  false,
                ),
                entries = list();
              if (array(collection)) {
                for (let index = 0; index < collection.length; index++)
                  push(entries, list(index, collection[index]));
              } else if (record(collection)) {
                const __items26 = orderedKeys(collection);
                for (
                  let __index26 = 0;
                  __index26 < __items26.length;
                  __index26++
                ) {
                  const key = __items26[__index26];
                  push(entries, list(key, collection[key]));
                }
              }
              const output = list();
              {
                const __items27 = entries;
                for (
                  let __index27 = 0;
                  __index27 < __items27.length;
                  __index27++
                ) {
                  const entry = __items27[__index27];
                  const context = copyRecord(data);
                  context[directives.forItem || "item"] = entry[1];
                  context[directives.forIndex || "index"] = entry[0];
                  tracer.iteration(context,data,directives.forItem||"item",entry[1],directives.forIndex||"index",entry[0],collection);
                  const clean = copyRecord(directives);
                  {
                    const __items28 = list(
                      "forExpr",
                      "forItem",
                      "forIndex",
                      "forKey",
                    );
                    for (
                      let __index28 = 0;
                      __index28 < __items28.length;
                      __index28++
                    ) {
                      const name = __items28[__index28];
                      delete clean[name];
                    }
                  }
                  let key = null;
                  if (directives.forKey !== undefined) {
                    const name = directives.forKey;
                    let value;
                    if (name === "*this") value = entry[1];
                    else if (!includes(name, "."))
                      value =
                        record(entry[1]) && own(entry[1], name)
                          ? entry[1][name]
                          : null;
                    else value = expression(name, context, document, false);
                    key = textValue(scope, value);
                  }
                  const iteration = recordOf({
                    kind: "element",
                    tag: node.tag,
                    attrs: node.attrs,
                    bindings: node.bindings,
                    boundValues: node.boundValues || create(null),
                    directives: clean,
                    key,
                    keyScope: key === null ? null : site,
                    lexicalOrigin,
                    children: node.children,
                  });
                  // attrs still contain wx:for. Mark normalized control metadata
                  // as authoritative so the recursive pass cannot apply it twice.
                  const iterationSite = sourceSite(
                    site,
                    key === null ? "repeat-index" : "repeat-key",
                    key === null ? textValue(scope, entry[0]) : key,
                  );
                  append(
                    output,
                    nodes(
                      list(iteration),
                      context,
                      environment,
                      iterationSite,
                      whitespace,
                    ),
                  );
                }
              }
              return output;
            }
            let expanded = null;
            if (node.tag === "import" || node.tag === "include") {
              const target = resolveDocument(
                document,
                node.attrs.src,
                documents,
              );
              expanded =
                node.tag === "import"
                  ? list()
                  : nodes(
                      mapGet(documents, target).ast.nodes,
                      data,
                      enter(environment, "include:" + target, target),
                      sourceSite(site, "include", target),
                      whitespace,
                    );
            } else if (node.tag === "template") {
              if (own(node.attrs, "name")) expanded = list();
              else if (own(node.attrs, "is")) {
                const name = stringTrim(
                  interpolate(node.attrs.is, data, document),
                );
                const definition = mapGet(environment.definitions, name);
                if (!definition)
                  invalid("WXML template target not found: " + name);
                let context = data;
                if (own(node.attrs, "data")) {
                  const values = expression(
                    dataExpression(node.attrs.data),
                    data,
                    document,
                    true,
                  );
                  if (!record(values))
                    invalid("WXML template data must evaluate to an object");
                  context = copyRecord(data);
                  {
                    const __items29 = keys(values);
                    for (
                      let __index29 = 0;
                      __index29 < __items29.length;
                      __index29++
                    ) {
                      const key = __items29[__index29];
                      context[key] = values[key];
                    }
                  }
                  tracer.template(context,data,values,dataExpression(node.attrs.data),lastSource);
                }
                const edge = "template:" + definition.document + ":" + name;
                expanded = stripControls(
                  nodes(
                    definition.nodes,
                    context,
                    enter(environment, edge, definition.document),
                    sourceSite(site, "template", edge),
                    whitespace,
                  ),
                );
              }
            }
            if (expanded !== null) {
              if (
                node.key !== undefined &&
                node.key !== null &&
                expanded.length
              )
                return list(
                  recordOf({
                    kind: "element",
                    tag: "block",
                    attrs: create(null),
                    boundValues: create(null),
                    bindings: list(),
                    directives: create(null),
                    key: node.key,
                    keyScope: node.keyScope || null,
                    sourceSite: site,
                    lexicalOrigin,
                    children: expanded,
                  }),
                );
              return expanded;
            }
            const attrs = create(null),
              boundValues = create(null),
              bindings = new NativeMap();
            {
              const __items30 = node.bindings;
              for (
                let __index30 = 0;
                __index30 < __items30.length;
                __index30++
              ) {
                const binding = __items30[__index30];
                mapSet(bindings, binding, true);
              }
            }
            {
              const __items31 = orderedKeys(node.attrs);
              for (
                let __index31 = 0;
                __index31 < __items31.length;
                __index31++
              ) {
                const name = __items31[__index31];
                const source = node.attrs[name];
                if (stringStartsWith(name, "wx:")) attrs[name] = source;
                else if (node.boundValues && own(node.boundValues, name)) {
                  attrs[name] = source;
                  boundValues[name] = node.boundValues[name];
                  attributeSource(site,name,null);
                } else {
                  const pieces = mustaches(source);
                  if (pieces.length === 1 && own(pieces[0], "expression")) {
                    const value = expression(
                      pieces[0].expression,
                      data,
                      document,
                      false,
                    );
                    const sourceProvenance=lastSource;
                    const normalized = jsonValue(scope, value);
                    attributeSource(site,name,sourceProvenance);
                    attrs[name] =
                      value === undefined || value === null
                        ? ""
                        : typeof value === "object"
                          ? jsonText(normalized)
                          : textValue(scope, value);
                    boundValues[name] = normalized;
                  } else attrs[name] = interpolate(source, data, document);
                }
                {
                  const __items32 = mustaches(attrs[name], true);
                  for (
                    let __index32 = 0;
                    __index32 < __items32.length;
                    __index32++
                  ) {
                    const piece = __items32[__index32];
                    if (piece.expression)
                      mapSet(bindings, piece.expression, true);
                  }
                }
              }
            }
            return list(
              recordOf({
                kind: "element",
                tag: node.tag,
                attrs,
                boundValues,
                bindings: sort(mapKeys(bindings), compareKeys),
                directives,
                key: node.key === undefined ? null : node.key,
                keyScope: node.keyScope || null,
                sourceSite: site,
                lexicalOrigin,
                children: nodes(
                  node.children,
                  data,
                  environment,
                  site,
                  whitespace || node.tag === "text",
                ),
              }),
            );
          }
          const environment = recordOf({
            document: task.documentId,
            definitions: mapGet(definitions, task.documentId),
            stack: list(),
          });
          push(
            results,
            recordOf({
              taskId: task.taskId,
              attributeSources,
              ast: recordOf({
                version: 1,
                nodes: nodes(
                  mapGet(documents, task.documentId).ast.nodes,
                  task.data,
                  environment,
                  sourceSite("", "document", task.documentId),
                  false,
                ),
              }),
            }),
          );
        }
      }
      return recordOf({ ok: true, results });
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
      registeredDocuments = recordOf({programId: input.programId, render: candidate});
      return recordOf({ok: true, programId: input.programId});
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
    if (!array(input)) invalid("scope release batch must be an array");
    const ids = new NativeMap();
    for (let index = 0; index < input.length; index++) {
      const id = input[index];
      if (!nonempty(id) || mapHas(ids, id))
        invalid("invalid or duplicate scope release");
      mapSet(ids, id, true);
    }
    for (let index = 0; index < input.length; index++)
      mapDelete(scopes, input[index]);
    return recordOf({ ok: true });
  }
  define(root, "__weappContainer_view_load", {
    value: (input) => guarded(load, input),
    writable: false,
    configurable: false,
  });
  define(root, "__weappContainer_view_evaluate", {
    value: (input) => guarded(evaluate, input),
    writable: false,
    configurable: false,
  });
  define(root, "__weappContainer_view_register_documents", {
    value: input => staticErrorIsolation(() => guarded(registerDocuments, input, true)), writable: false, configurable: false,
  });
  define(root, "__weappContainer_view_render_registered", {
    value: input => guarded(renderRegistered, input), writable: false, configurable: false,
  });
  define(root, "__weappContainer_view_render", {
    value: (input) => guarded(render, input),
    writable: false,
    configurable: false,
  });
  define(root, "__weappContainer_view_release_scopes", {
    value: (input) => guarded(releaseScopes, input),
    writable: false,
    configurable: false,
  });
})();
