// Loaded as an actual application module by both native engine unit suites.
const original = {
  assign: Object.assign, create: Object.create, define: Object.defineProperty,
  getOwn: Object.getOwnPropertyDescriptor, keys: Reflect.ownKeys,
  apply: Reflect.apply, array: Array.isArray,
  parse: JSON.parse, stringify: JSON.stringify,
};
const aliases = ["__container_storage", "__container_sync_files", "__container_sync_api_values", "__container_capabilities"];
const descriptors = aliases.map(function(name) { return original.getOwn(globalThis, name); });
const trace = [];
let attacks = 0;
let oldValues;
function attack() { attacks += 1; throw new Error("application trap entered"); }
function descriptor() {
  const value = original.create(null);
  value.get = attack;
  value.configurable = true;
  return value;
}
function read() {
  return {
    width: wx.getWindowInfo().windowWidth,
    systemWidth: wx.getSystemInfoSync().windowWidth,
    storage: wx.getStorageSync("pending"),
    file: wx.getFileSystemManager().readFileSync("pending.txt", "utf8"),
  };
}
exports.queue = function() {
  wx.setStorageSync("pending", "kept");
  wx.getFileSystemManager().writeFileSync("pending.txt", "kept", "utf8");
  Promise.resolve().then(function() { trace.push(read()); });
  return true;
};
exports.poison = function() {
  oldValues = __container_sync_api_values;
  Object.freeze(oldValues);
  Object.freeze(__container_capabilities);
  for (let index = 0; index < aliases.length; index += 1) {
    original.define(globalThis, aliases[index], descriptor());
  }
  original.define(Object.prototype, "get", descriptor());
  original.define(Object.prototype, "set", descriptor());
  original.define(Object.prototype, "kind", descriptor());
  Object.assign = Object.create = Object.defineProperty = Object.getOwnPropertyDescriptor = attack;
  Reflect.ownKeys = Reflect.apply = Array.isArray = attack;
  JSON.parse = JSON.stringify = attack;
  globalThis.__container_set_sync_api_values = attack;
  globalThis.__container_set_sync_files = attack;
  globalThis.__container_set_storage_snapshot = attack;
  globalThis.__container_set_dom_query_contract = attack;
  return true;
};
exports.restoreRead = function() {
  delete Object.prototype.get;
  delete Object.prototype.set;
  delete Object.prototype.kind;
  Object.assign = original.assign; Object.create = original.create;
  Object.defineProperty = original.define; Object.getOwnPropertyDescriptor = original.getOwn;
  Reflect.ownKeys = original.keys; Reflect.apply = original.apply; Array.isArray = original.array;
  JSON.parse = original.parse; JSON.stringify = original.stringify;
  const result = read();
  result.attacks = attacks;
  result.jobs = trace.length;
  result.dom = __container_dom_query_enabled();
  result.aliasOwnedByApp = original.getOwn(globalThis, "__container_storage").get === attack;
  return result;
};
exports.restoreAliases = function() {
  for (let index = 0; index < aliases.length; index += 1) {
    original.define(globalThis, aliases[index], descriptors[index]);
  }
  return {
    width: __container_sync_api_values["wx.getWindowInfo"].windowWidth,
    replacement: __container_sync_api_values !== oldValues,
    attacks: attacks,
  };
};
exports.trace = function() { return { entries: trace }; };
