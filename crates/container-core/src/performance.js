// Realm-owned performance timeline. The temporary native clock is captured
// before application code and then removed; guest Date/Promise replacements
// cannot forge elapsed time or change observer checkpoint scheduling.
// Only executed script evaluation and the actual appLaunch lifecycle are
// instrumented. Route, render, resource and package-download entries require
// their corresponding runtime/presenter instrumentation and are not advertised.
const __container_performance = (function() {
  "use strict";
  const now = globalThis.__container_host_performance_now;
  delete globalThis.__container_host_performance_now;
  const nativeActive = globalThis.__container_host_performance_active;
  delete globalThis.__container_host_performance_active;
  if (typeof now !== "function") throw new Error("native performance clock is unavailable");
  const apply = Function.call.bind(Function.prototype.apply);
  const array = Array.isArray;
  const integer = Number.isSafeInteger;
  const define = Object.defineProperty;
  const create = Object.create;
  const own = Object.getOwnPropertyDescriptor;
  const setPrototype = Object.setPrototypeOf;
  function privateArray() { return setPrototype([], null); }
  function data(target, key, value) {
    const descriptor = create(null);
    descriptor.value = value;
    descriptor.writable = descriptor.enumerable = descriptor.configurable = true;
    define(target, key, descriptor);
  }
  function ownData(target, key) {
    if (!target || (typeof target !== "object" && typeof target !== "function")) return undefined;
    const descriptor = own(target, key);
    return descriptor && own(descriptor, "value") ? descriptor.value : undefined;
  }
  function reportFailure(error) { try { report(error); } catch (_) {} }
  const report = __container_report_error;
  const string = String;
  const replace = Function.call.bind(String.prototype.replace);
  const enqueue = Function.call.bind(Promise.prototype.then);
  const checkpoint = Promise.resolve();
  define(checkpoint, "constructor", { value: undefined });
  const supported = ["navigation", "script"];
  const observers = privateArray();
  const maximumObservers = 256;
  const maximumEntries = 4096;
  let entries = privateArray();
  let capacity = 30;
  let queued = false;
  let launched = false;
  let retired = false;
  let generation = 0;
  let policy = create(null);
  const members = ["wx.getPerformance", "object:Performance.getEntries", "object:Performance.getEntriesByName",
    "object:Performance.getEntriesByType", "object:EntryList.getEntries", "object:EntryList.getEntriesByName",
    "object:EntryList.getEntriesByType"];
  function live() { return !retired && typeof nativeActive === "function" && nativeActive() === true; }
  function install(source) {
    const next = create(null);
    for (let index = 0; index < members.length; index++) {
      const name = members[index], value = ownData(source, name);
      next[name] = value === "full" || value === "partial";
    }
    // Revocation invalidates already detached observer deliveries. It does
    // not bind an old EntryList to another owner or alter its owned entries.
    if (policy["wx.getPerformance"] && !next["wx.getPerformance"]) {
      generation++;
      for (let index = 0; index < observers.length; index++) {
        observers[index].pending = privateArray(); observers[index].generation++;
      }
    }
    policy = next;
  }
  function retire() {
    if (retired) return;
    retired = true; generation++;
    entries = privateArray();
    for (let index = 0; index < observers.length; index++) {
      observers[index].active = false; observers[index].pending = privateArray(); observers[index].generation++;
    }
    observers.length = 0;
  }

  function requireAccess(name) {
    name = name || "wx.getPerformance";
    if (!live() || policy["wx.getPerformance"] !== true || policy[name] !== true) {
      throw { code: "ERR_UNSUPPORTED_CAPABILITY", api: name, errMsg: name + ":fail unsupported" };
    }
  }
  function copyEntry(entry) {
    const copy = {};
    data(copy, "entryType", entry.entryType); data(copy, "name", entry.name);
    data(copy, "startTime", entry.startTime); data(copy, "duration", entry.duration);
    if (entry.fileList) {
      const files = [];
      for (let index = 0; index < entry.fileList.length; index++) data(files, index, entry.fileList[index]);
      data(copy, "fileList", files);
    }
    if (entry.moduleName !== undefined) data(copy, "moduleName", entry.moduleName);
    if (entry.pageId !== undefined) data(copy, "pageId", entry.pageId);
    if (entry.navigationStart !== undefined) data(copy, "navigationStart", entry.navigationStart);
    if (entry.navigationType !== undefined) data(copy, "navigationType", entry.navigationType);
    if (entry.path !== undefined) data(copy, "path", entry.path);
    return copy;
  }
  function filtered(source, name, type) {
    const result = [];
    for (let index = 0; index < source.length; index++) {
      const entry = source[index];
      if ((name === undefined || entry.name === name) && (type === undefined || entry.entryType === type)) {
        data(result, result.length, copyEntry(entry));
      }
    }
    return result;
  }
  function nameArgument(value, label) {
    if (typeof value !== "string") throw new TypeError(label + " must be a string");
  }
  function entryList(source) {
    return {
      getEntries: function() { requireAccess("object:EntryList.getEntries"); return filtered(source); },
      getEntriesByName: function(name, type) {
        requireAccess("object:EntryList.getEntriesByName"); nameArgument(name, "name");
        if (type !== undefined) nameArgument(type, "entryType");
        return filtered(source, name, type);
      },
      getEntriesByType: function(type) { requireAccess("object:EntryList.getEntriesByType"); nameArgument(type, "entryType"); return filtered(source, undefined, type); }
    };
  }
  function matches(record, type) {
    for (let index = 0; index < record.types.length; index++) if (record.types[index] === type) return true;
    return false;
  }
  function boundedInsert(target, entry, limit) {
    if (limit === 0) return;
    // Nested require() finishes inner evaluation first. Public lists remain
    // ordered by startTime, with stable insertion order for equal timestamps.
    let index = target.length;
    while (index > 0 && target[index - 1].startTime > entry.startTime) {
      target[index] = target[index - 1]; index--;
    }
    target[index] = entry;
    if (target.length > limit) {
      for (let cursor = 1; cursor < target.length; cursor++) target[cursor - 1] = target[cursor];
      target.length = limit;
    }
  }
  function notify() {
    queued = false;
    if (!live()) { retire(); return; }
    const admittedGeneration = generation;
    // Detach all batches before invoking application code. Disconnect/reobserve
    // in one observer must also invalidate an already-detached neighbour batch.
    const deliveries = privateArray();
    for (let index = 0; index < observers.length; index++) {
      const record = observers[index];
      if (record.pending.length) {
        const delivery = create(null);
        delivery.record = record; delivery.generation = record.generation; delivery.entries = record.pending;
        deliveries[deliveries.length] = delivery;
        record.pending = privateArray();
      }
    }
    for (let index = 0; index < deliveries.length; index++) {
      const delivery = deliveries[index], record = delivery.record;
      try {
        if (!record.active || record.generation !== delivery.generation || (!live() || generation !== admittedGeneration || policy["wx.getPerformance"] !== true)) continue;
        apply(record.callback, undefined, [entryList(delivery.entries)]);
      } catch (error) { reportFailure(error); }
    }
  }
  function append(entry) {
    if (!live()) { retire(); return; }
    boundedInsert(entries, entry, capacity);
    let pending = false;
    for (let index = 0; index < observers.length; index++) {
      const record = observers[index];
      if (policy["wx.getPerformance"] === true && record.active && matches(record, entry.entryType)) {
        boundedInsert(record.pending, entry, maximumEntries);
        pending = true;
      }
    }
    if (pending && !queued) { queued = true; enqueue(checkpoint, notify); }
  }
  function removeObserver(record) {
    for (let index = 0; index < observers.length; index++) {
      if (observers[index] !== record) continue;
      for (let cursor = index + 1; cursor < observers.length; cursor++) observers[cursor - 1] = observers[cursor];
      observers.length--; break;
    }
    record.active = false; record.pending = privateArray(); record.generation++;
  }
  function createObserver(callback) {
    requireAccess();
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    const record = create(null);
    record.callback = callback; record.types = privateArray(); record.pending = privateArray();
    record.active = false; record.generation = 0;
    const observer = {
      observe: function(options) {
        requireAccess();
        if (!options || typeof options !== "object") throw new TypeError("observe options must be an object");
        const one = options.type, many = options.entryTypes;
        if ((one === undefined) === (many === undefined)) throw new TypeError("exactly one of type or entryTypes is required");
        const requested = one === undefined ? many : [one];
        if (!array(requested) || requested.length === 0 || requested.length > supported.length) throw new TypeError("entryTypes must be a nonempty supported type list");
        const types = privateArray();
        for (let index = 0; index < requested.length; index++) {
          const type = requested[index];
          if (type !== "navigation" && type !== "script") {
            throw { code: "ERR_UNSUPPORTED_CAPABILITY", api: "PerformanceObserver.observe", errMsg: "observe:fail unsupported entry type" };
          }
          let duplicate = false;
          for (let previous = 0; previous < types.length; previous++) if (types[previous] === type) duplicate = true;
          if (!duplicate) types[types.length] = type;
        }
        if (!record.active && observers.length >= maximumObservers) throw new RangeError("too many active performance observers");
        if (!record.active) observers[observers.length] = record;
        record.types = types; record.pending = privateArray(); record.active = true; record.generation++;
      },
      disconnect: function() { removeObserver(record); }
    };
    const supportedDescriptor = create(null);
    supportedDescriptor.enumerable = true;
    supportedDescriptor.get = function() { return [supported[0], supported[1]]; };
    define(observer, "supportedEntryTypes", supportedDescriptor);
    return observer;
  }
  const performance = {
    getEntries: function() { requireAccess("object:Performance.getEntries"); return filtered(entries); },
    getEntriesByName: function(name, type) {
      requireAccess("object:Performance.getEntriesByName"); nameArgument(name, "name");
      if (type !== undefined) nameArgument(type, "entryType");
      return filtered(entries, name, type);
    },
    getEntriesByType: function(type) { requireAccess("object:Performance.getEntriesByType"); nameArgument(type, "entryType"); return filtered(entries, undefined, type); },
    setBufferSize: function(size) {
      requireAccess();
      if (!integer(size) || size < 0 || size > maximumEntries) throw new RangeError("buffer size must be an integer from 0 to 4096");
      capacity = size;
      if (entries.length > size) {
        const retained = privateArray();
        for (let index = entries.length - size; index < entries.length; index++) retained[retained.length] = entries[index];
        entries = retained;
      }
    },
    createObserver: createObserver
  };
  wx.getPerformance = function() { requireAccess(); return performance; };

  function scriptEntry(moduleId, start, duration) {
    const entry = create(null), files = privateArray();
    entry.entryType = "script"; entry.name = "evaluateScript";
    entry.startTime = start; entry.duration = duration < 0 ? 0 : duration;
    files[0] = replace(string(moduleId), /^module:/, ""); entry.fileList = files;
    return entry;
  }
  // Only the private registered loader/eager native command can call this.
  // Public evaluator aliases keep their compatibility behavior without sample
  // authority. A real trusted record, not its public name, grants provenance.
  function measureScript(moduleId, evaluate) {
    let start;
    try { if (live()) start = now(); } catch (error) { reportFailure(error); }
    const result = evaluate();
    if (start !== undefined) {
      try { append(scriptEntry(moduleId, start, now() - start)); }
      catch (error) { reportFailure(error); }
    }
    return result;
  }
  const invokeApp = globalThis.__container_invoke_app;
  function invokeTrustedApp(name, args) {
    let path = "";
    if (live() && name === "onLaunch" && !launched) {
      // Native arguments arrive as own data. Capture before the application
      // hook can mutate the object or replace path with a getter.
      try {
        const value = ownData(ownData(args, "0"), "path");
        if (typeof value === "string") path = value;
      } catch (error) { reportFailure(error); }
    }
    const result = apply(invokeApp, this, [name, args]);
    if (live() && name === "onLaunch" && !launched) {
      launched = true;
      try {
        const entry = create(null);
        entry.entryType = "navigation"; entry.name = "appLaunch"; entry.startTime = 0;
        entry.duration = now(); entry.navigationStart = 0;
        entry.navigationType = "appLaunch"; entry.path = path;
        append(entry);
      } catch (error) { reportFailure(error); }
    }
    return result;
  }
  install(__container_capabilities);
  return { install:install, retire:retire, measureScript:measureScript, invokeApp:invokeTrustedApp };
})();
