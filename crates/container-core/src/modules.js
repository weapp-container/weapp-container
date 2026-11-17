// Factories are registered before execution. A local require never crosses FFI.
const __container_module_owner = (() => {
  "use strict";
  const records = Object.create(null);
  const publicRecords = Object.create(null);
  const byNumber = Object.create(null);
  const publicByNumber = Object.create(null);
  const own = Function.call.bind(Object.prototype.hasOwnProperty);
  const apply = Reflect.apply, create = Object.create, define = Object.defineProperty;
  const compile = Function, split = Function.call.bind(String.prototype.split);
  const replace = Function.call.bind(String.prototype.replace), slice = Function.call.bind(String.prototype.slice);
  const starts = Function.call.bind(String.prototype.startsWith), includes = Function.call.bind(String.prototype.includes);
  const last = Function.call.bind(String.prototype.lastIndexOf), arrayIncludes = Function.call.bind(Array.prototype.includes);
  const isArray = Array.isArray, ownDescriptor = Object.getOwnPropertyDescriptor;
  const named = globalThis.__container_evaluate_named_module;
  const report = globalThis.__container_report_error;
  const measured = typeof __container_performance === "object" ? __container_performance.measureScript : (_, run) => run();
  const legacy = create(null);
  function put(array, value) { define(array, array.length, {__proto__:null,value:value,writable:true,configurable:true,enumerable:true}); }
  function value(source, key) { const d = ownDescriptor(source, key); return d && own(d, "value") ? d.value : undefined; }
  const diagnostics = create(null);
  globalThis.__container_modules = diagnostics;
  // This compatibility view is never read by native module calls. A guest
  // may freeze or replace it without turning successful code into a retry.
  function publish(number, exports) {
    try { define(diagnostics, number, {__proto__:null,value:exports,writable:true,configurable:true,enumerable:true}); } catch (_) {}
  }
  function unpublish(number) { try { delete diagnostics[number]; } catch (_) {} }
  globalThis.__container_legacy_registration_depth = 0;
  globalThis.__container_page_module_definitions = Object.create(null);
  globalThis.__container_page_module_registrations = function() {
    return globalThis.__container_page_module_definitions;
  };
  const fail = message => {
    const error = new Error(message);
    error.code = "ERR_MODULE_LOAD";
    throw error;
  };
  function normalize(value) {
    const parts = [];
    for (const part of split(value,"/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) return null;
        parts.pop();
      } else put(parts, part);
    }
    return parts.join("/");
  }
  function resolve(record, specifier) {
    function lookup(id) { return own(records, id) ? records[id] : !record.trusted && own(publicRecords, id) ? publicRecords[id] : null; }
    if (typeof specifier !== "string" || !specifier.length) fail("require specifier must be a nonempty string");
    if (arrayIncludes(record.dependencies, specifier) && lookup(specifier)) return lookup(specifier);
    const file = replace(record.id, /^module:/, "");
    const dirname = includes(file, "/") ? slice(file, 0, last(file, "/")) : "";
    const bases = starts(specifier, ".") ? [dirname + "/" + specifier]
      : starts(specifier, "/") ? [slice(specifier, 1)]
      : [specifier, "miniprogram_npm/" + specifier, "node_modules/" + specifier];
    for (const base of bases) {
      const path = normalize(base);
      if (path == null) continue;
      const candidates = [path];
      if (!/\.[^/]+$/.test(path)) {
        for (const suffix of [".js", ".mjs", ".cjs", ".json"]) put(candidates, path + suffix);
        for (const suffix of [".js", ".mjs", ".cjs", ".json"]) put(candidates, path + "/index" + suffix);
      }
      for (const candidate of candidates) {
        for (const id of ["module:" + candidate, candidate]) {
          if (!lookup(id)) continue;
          if (!arrayIncludes(record.dependencies, id)) fail("module " + record.id + " dependency " + id + " is missing from the manifest graph");
          return lookup(id);
        }
      }
    }
    fail("module " + record.id + " cannot resolve dependency " + specifier);
  }
  function evaluate(record) {
    if (!record) fail("module is not registered");
    // CommonJS cycles observe the same partially initialized exports object.
    if (record.state === "evaluating" || record.state === "evaluated") return record.module.exports;
    // Legacy eager registration owns an atomic rollback boundary. Starting a
    // new cached factory inside it could leave a successful cache pointing at
    // definitions later removed by the legacy transaction. Existing caches
    // are safe to read, including a CommonJS cycle already being evaluated.
    if (globalThis.__container_legacy_registration_depth > 0) {
      fail("cannot start cached module " + record.id + " inside a legacy registration transaction");
    }
    record.module = { id: record.id, exports: {}, loaded: false };
    record.state = "evaluating";
    publish(record.number, record.module.exports);
    const require = specifier => evaluate(resolve(record, specifier));
    try {
      const run = () => apply(named, undefined, [record.id, () => {
        apply(record.factory, record.module.exports, [require, record.module, record.module.exports]);
      }, true]);
      if (record.trusted) measured(record.id, run); else run();
      record.module.loaded = true;
      record.state = "evaluated";
      publish(record.number, record.module.exports);
      return record.module.exports;
    } catch (error) {
      // Failed modules are retryable, while successfully evaluated dependencies
      // retain their cache, matching the CommonJS execution boundary.
      record.state = "registered";
      record.module = null;
      unpublish(record.number);
      throw error;
    }
  }
  function register(id, number, dependencies, format, factory, trusted) {
    const owned = trusted ? records : publicRecords, numbered = trusted ? byNumber : publicByNumber;
    if (own(owned, id)) fail("module " + id + " is already registered");
    const record = { id, number, dependencies, format, factory, trusted, state: "registered", module: null };
    owned[id] = record;
    numbered[number] = record;
  }
  globalThis.__container_define_module = function(id, number, dependencies, format, factory) {
    register(id, number, dependencies, format, factory, false);
  };
  globalThis.__container_validate_module_sources = function(sources, jsonSources) {
    // Validate in the selected JS engine: Rust's JSON value type has a
    // narrower number/UTF-16 domain than ECMAScript JSON.parse.
    for (const source of jsonSources || []) JSON.parse(source);
    for (const source of sources) new Function("require", "module", "exports", source);
    return null;
  };
  globalThis.__container_evaluate_module = function(id) { evaluate(own(records, id) ? records[id] : publicRecords[id]); return null; };
  function exportsFor(number) {
    return own(byNumber, number) ? evaluate(byNumber[number]) : own(legacy, number) ? legacy[number] : undefined;
  }
  globalThis.__container_module_exports = function(number) {
    return own(byNumber, number) || own(legacy, number) ? exportsFor(number)
      : own(publicByNumber, number) ? evaluate(publicByNumber[number]) : diagnostics[number];
  };
  // This transport is lexical, reachable only through the retained native
  // installer. The application aliases above cannot create trusted records.
  function command(input) {
    const operation = value(input, "operation"), id = value(input, "id");
    if (operation === "evaluate") {
      try { evaluate(records[id]); return true; }
      catch (error) { try { apply(report, globalThis, [error]); } finally { throw error; } }
    }
    const source = value(input, "source"), number = value(input, "number");
    if (typeof id !== "string" || typeof source !== "string" || typeof number !== "number") fail("invalid native module command");
    if (operation === "register") {
      const dependencies = value(input, "dependencies"), format = value(input, "format");
      if (!isArray(dependencies)) fail("invalid native module dependencies");
      const owned = [];
      for (let index = 0; index < dependencies.length; index++) {
        if (typeof dependencies[index] !== "string") fail("invalid native module dependency");
        put(owned, dependencies[index]);
      }
      register(id, number, owned, format, compile("require", "module", "exports", source), true);
      return true;
    }
    if (operation === "eager" || operation === "anonymous") {
      const factory = compile("module", "exports", source), module = {exports:{}};
      const run = () => apply(factory, globalThis, [module, module.exports]);
      if (operation === "eager") measured(id, () => apply(named, undefined, [id, run, false])); else run();
      legacy[number] = module.exports;
      publish(number, module.exports);
      return true;
    }
    fail("unknown native module command");
  }
  return { command:command, exports:exportsFor };
})();
