// Private canonical records carry storage authority. Public maps and effects
// are diagnostic projections and cannot replace the admitted value bytes.
const __storage_stringify = JSON.stringify;
const __storage_parse = JSON.parse;
const __storage_define = Object.defineProperty;
const __storage_descriptor = Object.getOwnPropertyDescriptor;
const __storage_keys = Object.keys;
const __storage_create = Object.create;
const __storage_set_prototype = Object.setPrototypeOf;
const __storage_is_array = Array.isArray;
const __storage_char_code = Function.prototype.call.bind(String.prototype.charCodeAt);
const __storage_sort = Function.prototype.call.bind(Array.prototype.sort);
const __storage_bigint = BigInt;
const __storage_Error = Error;
const __storage_TypeError = TypeError;
const __storage_MAX_VALUE = 1048576;
const __storage_MAX_TOTAL = 10485760;
const __storage_MAX_PENDING = 4096;
const __storage_MAX_PENDING_BYTES = 67108864;
let __storage_entries = __storage_create(null);
let __storage_usage = 0;
let __storage_sequence = 0n;
let __storage_acknowledged = 0n;
let __storage_captured = 0n;
let __storage_pending_count = 0;
let __storage_pending_bytes = 0;

function __storage_record() { return __storage_create(null); }
function __storage_array() {
  const value = [];
  __storage_set_prototype(value, null);
  return value;
}
function __storage_data(object, key, value) {
  const descriptor = __storage_record();
  descriptor.value = value;
  descriptor.writable = descriptor.enumerable = descriptor.configurable = true;
  __storage_define(object, key, descriptor);
}
function __storage_own(object, key) {
  const descriptor = __storage_descriptor(object, key);
  return descriptor && __storage_descriptor(descriptor, "value") ? descriptor.value : undefined;
}
function __storage_fail(message) { throw new __storage_TypeError(message); }
function __storage_key(key) {
  if (typeof key !== "string") __storage_fail("key must be a non-empty string");
  // Match the existing native Unicode White_Space policy. ECMAScript trim
  // disagrees on U+0085/U+FEFF and could otherwise accept a write that fails
  // only after native commit, or reject a valid legacy native snapshot.
  let nonBlank = false;
  for (let index = 0; index < key.length; index += 1) {
    const code = __storage_char_code(key, index);
    const blank = (code >= 9 && code <= 13) || code === 32 || code === 133 || code === 160
      || code === 5760 || (code >= 8192 && code <= 8202) || code === 8232 || code === 8233
      || code === 8239 || code === 8287 || code === 12288;
    if (!blank) { nonBlank = true; break; }
  }
  if (!nonBlank) __storage_fail("key must be a non-empty string");
  __storage_valid_string(key);
  return key;
}
function __storage_valid_string(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = __storage_char_code(text, index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const low = __storage_char_code(text, ++index);
      if (!(low >= 0xDC00 && low <= 0xDFFF)) __storage_fail("storage lone UTF16 surrogate is not supported");
    } else if (code >= 0xDC00 && code <= 0xDFFF) __storage_fail("storage lone UTF16 surrogate is not supported");
  }
}
function __container_utf8_size(text) {
  let size = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = __storage_char_code(text, index);
    if (code >= 0xD800 && code <= 0xDBFF) { index += 1; size += 4; }
    else size += code <= 0x7F ? 1 : code <= 0x7FF ? 2 : 3;
  }
  return size;
}
// JSON.parse produces only data properties. Iterative neutral copies avoid
// application getters/toJSON and preserve deep legacy native snapshots without
// spending JS call stack or imposing the admission limits on existing data.
function __storage_safe_json(value, enforceAdmissionLimits) {
  let nodes = 0;
  function copy(item, depth) {
    nodes += 1;
    if (enforceAdmissionLimits && (nodes > 1000000 || depth > 128)) __storage_fail("storage JSON proof budget exceeded");
    if (typeof item === "string") { __storage_valid_string(item); return item; }
    if (item === null || typeof item !== "object") return item;
    return __storage_is_array(item) ? __storage_array() : __storage_record();
  }
  function frame(source, target, depth, parent) {
    const current = __storage_record();
    current.source = source; current.target = target; current.depth = depth;
    current.keys = __storage_keys(source); current.index = 0; current.parent = parent;
    return current;
  }
  const result = copy(value, 0);
  let pending = value !== null && typeof value === "object" ? frame(value, result, 0, null) : null;
  while (pending) {
    if (pending.index === pending.keys.length) { pending = pending.parent; continue; }
    const key = pending.keys[pending.index++];
    __storage_valid_string(key);
    const descriptor = __storage_descriptor(pending.source, key);
    if (!descriptor || !__storage_descriptor(descriptor, "value")) __storage_fail("storage snapshot accessor is not supported");
    const item = descriptor.value, depth = pending.depth + 1;
    const child = copy(item, depth);
    __storage_data(pending.target, key, child);
    if (item !== null && typeof item === "object") pending = frame(item, child, depth, pending);
  }
  return result;
}
function __storage_value(value) {
  const entry = __storage_record();
  entry.undefined = value === undefined;
  if (typeof value === "function" || typeof value === "symbol") __storage_fail("storage value is not JSON serializable");
  const json = entry.undefined ? "null" : __storage_stringify(value);
  if (typeof json !== "string") __storage_fail("storage value is not JSON serializable");
  const valueBytes = __container_utf8_size(json);
  if (valueBytes > __storage_MAX_VALUE) __storage_fail("storage value exceeds 1 MiB quota");
  // Encoding may run user getters/toJSON and legitimate nested storage calls.
  // Validate only the outer snapshot; no state has been prepared/published yet.
  __storage_safe_json(__storage_parse(json), true);
  entry.valueJson = json;
  entry.valueBytes = valueBytes;
  return entry;
}
function __storage_entry(key, valueJson, isUndefined) {
  const entry = __storage_record();
  entry.valueJson = valueJson;
  entry.undefined = isUndefined;
  entry.valueBytes = __container_utf8_size(valueJson);
  entry.entryBytes = __container_utf8_size(__storage_stringify(key)) + 3 + entry.valueBytes;
  return entry;
}
function __storage_patch(op, key, value) {
  const patch = __storage_record();
  patch.op = op;
  if (op !== "clear") patch.key = __storage_key(key);
  if (op === "set") {
    const entry = __storage_value(value);
    patch.valueJson = entry.valueJson;
    patch.undefined = entry.undefined;
  }
  return patch;
}
function __storage_apply(entries, patches) {
  let candidate = entries;
  for (let index = 0; index < patches.length; index += 1) {
    const patch = patches[index];
    if (patch.op === "clear") candidate = __storage_record();
    else if (patch.op === "remove") delete candidate[patch.key];
    else __storage_data(candidate, patch.key, __storage_entry(patch.key, patch.valueJson, patch.undefined));
  }
  return candidate;
}
function __storage_copy(entries) {
  const result = __storage_record();
  const keys = __storage_keys(entries);
  for (let index = 0; index < keys.length; index += 1) __storage_data(result, keys[index], entries[keys[index]]);
  return result;
}
function __storage_state(entries) {
  const state = __storage_record();
  state.entries = entries;
  state.usage = 0;
  state.projection = __storage_record();
  const keys = __storage_keys(entries);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index], entry = entries[key];
    state.usage += entry.entryBytes;
    __storage_data(state.projection, key, entry.undefined ? undefined : __storage_parse(entry.valueJson));
  }
  return state;
}
function __storage_publish(state) {
  __storage_entries = state.entries;
  __storage_usage = state.usage;
  __container_storage = state.projection;
}
function __storage_trace(patches) {
  // Public queue/prototype tampering may affect diagnostics, never authority
  // or the success of a transaction already admitted into the private ledger.
  try {
    const trace = __storage_array();
    for (let index = 0; index < patches.length; index += 1) {
      const patch = patches[index], item = __storage_record();
      item.op = patch.op;
      if (patch.op !== "clear") item.key = patch.key;
      if (patch.op === "set") { item.value = patch.undefined ? undefined : __storage_parse(patch.valueJson); item.undefined = patch.undefined; }
      __storage_data(trace, index, item);
    }
    const event = __storage_record(); event.type = "storage.patch.batch"; event.patches = trace;
    __storage_data(__container_events, __container_events.length, event);
  } catch (_) {}
}
function __storage_commit(patches) {
  const count = patches.length;
  if (count === 0) return;
  // Input normalization is complete, including any nested calls. Prepare
  // against the current state rather than a state from before user callbacks.
  for (let index = 0; index < count; index += 1) {
    if (patches[index].op === "set" && __container_utf8_size(patches[index].valueJson) > __storage_MAX_VALUE) __storage_fail("storage value exceeds 1 MiB quota");
  }
  const state = __storage_state(__storage_apply(__storage_copy(__storage_entries), patches));
  if (state.usage > __storage_MAX_TOTAL && state.usage > __storage_usage) __storage_fail("storage exceeds 10 MiB total quota");
  if (__storage_sequence >= 18446744073709551615n) __storage_fail("storage transaction sequence exhausted");
  const sequence = __storage_sequence + 1n;
  const transaction = __storage_record();
  transaction.sequence = __host_string(sequence);
  transaction.patches = patches;
  transaction.json = '{"sequence":' + __storage_stringify(transaction.sequence) + ',"patches":' + __storage_stringify(patches) + '}';
  transaction.bytes = __container_utf8_size(transaction.json);
  transaction.next = null;
  if (__storage_pending_count >= __storage_MAX_PENDING || __storage_pending_bytes + transaction.bytes > __storage_MAX_PENDING_BYTES) __storage_fail("storage pending transaction budget exceeded");
  // All fallible admission work precedes publication; optional trace failures
  // cannot undo or reject accepted private transactions.
  __storage_publish(state);
  __storage_sequence = sequence;
  if (__host_storage_tail) __host_storage_tail.next = transaction;
  else __host_storage_head = transaction;
  __host_storage_tail = transaction;
  __storage_pending_count += 1;
  __storage_pending_bytes += transaction.bytes;
  __storage_trace(patches);
}
function __host_storage_capture(request) {
  const pending = __host_drain_pending;
  if (!pending || __receiver_value(request, "drainId") !== pending.id) throw "storage drain receipt unavailable";
  return __host_storage_through(pending.tail);
}
// Native reconciliation cannot depend on serialization of public traces. It
// reads only immutable, preencoded private intent and runs no application code.
function __host_storage_through(tail) {
  let entry = __host_storage_head, result = "[", first = true;
  while (entry && tail) {
    if (__storage_bigint(entry.sequence) > __storage_bigint(tail.sequence)) break;
    result += (first ? "" : ",") + entry.json;
    first = false;
    if (entry === tail) break;
    entry = entry.next;
  }
  if (tail && __storage_captured < __storage_bigint(tail.sequence)) __storage_captured = __storage_bigint(tail.sequence);
  return result + "]";
}
function __host_storage_ack(sequence) {
  if (typeof sequence !== "string" || sequence.length === 0 || sequence.length > 20) return false;
  for (let index = 0; index < sequence.length; index += 1) {
    const code = __storage_char_code(sequence, index);
    if (code < 48 || code > 57 || (index === 0 && sequence.length > 1 && code === 48)) return false;
  }
  const accepted = __storage_bigint(sequence);
  if (accepted <= __storage_acknowledged) return true;
  if (accepted > __storage_captured) return false;
  let entry = __host_storage_head;
  while (entry && __storage_bigint(entry.sequence) <= accepted) {
    __storage_pending_count -= 1;
    __storage_pending_bytes -= entry.bytes;
    entry = entry.next;
  }
  __host_storage_head = entry;
  if (!entry) __host_storage_tail = null;
  __storage_acknowledged = accepted;
  return true;
}
function __host_storage_prepare_snapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const values = __storage_own(snapshot, "values"), undefinedKeys = __storage_own(snapshot, "undefinedKeys");
  if (!values || typeof values !== "object" || __storage_is_array(values) || !__storage_is_array(undefinedKeys)) return null;
  let entries = __storage_record();
  const keys = __storage_keys(values);
  for (let index = 0; index < keys.length; index += 1) {
    const key = __storage_key(keys[index]);
    const safe = __storage_safe_json(__storage_own(values, key), false);
    const json = __storage_stringify(safe);
    if (typeof json !== "string") return null;
    __storage_data(entries, key, __storage_entry(key, json, false));
  }
  for (let index = 0; index < undefinedKeys.length; index += 1) {
    const key = __storage_key(undefinedKeys[index]);
    __storage_data(entries, key, __storage_entry(key, "null", true));
  }
  // Legacy restore preserves oversized snapshots. Only later admitted writes
  // are quota checked; replay is immutable previously accepted local intent.
  let pending = __host_storage_head;
  while (pending) { entries = __storage_apply(entries, pending.patches); pending = pending.next; }
  return __storage_state(entries);
}
function __container_storage_require(name) {
  if (__container_capability(name) === "unsupported") throw __container_error(name, "unsupported");
}
function __container_storage_get(key) {
  const entry = __storage_entries[key];
  return entry ? (entry.undefined ? undefined : __storage_parse(entry.valueJson)) : undefined;
}
function __container_storage_patch(patch) {
  // Compatibility diagnostic entry; a guest cannot append private authority.
  __storage_trace(__storage_is_array(patch) ? patch : [patch]);
}
function __container_storage_set(key, value) {
  __container_storage_require("wx.setStorageSync");
  const patches = __storage_array(); __storage_data(patches, 0, __storage_patch("set", key, value)); __storage_commit(patches);
}
function __container_storage_remove(key) {
  __container_storage_require("wx.removeStorageSync");
  const patches = __storage_array(); __storage_data(patches, 0, __storage_patch("remove", key)); __storage_commit(patches);
}
function __container_storage_clear() {
  __container_storage_require("wx.clearStorageSync");
  const patches = __storage_array(); __storage_data(patches, 0, __storage_patch("clear")); __storage_commit(patches);
}
function __container_set_storage_snapshot(_) { return false; }
function __container_storage_info() {
  const keys = __storage_keys(__storage_entries); __storage_sort(keys);
  return { keys: keys, currentSize: Math.ceil(__storage_usage / 1024), limitSize: 10240, errMsg: "getStorageInfo:ok" };
}
function __container_storage_async(name, options, action) {
  const callback = __container_options(options);
  try { __container_storage_require(name); return __container_async_result(callback, action(), null); }
  catch (error) {
    const message = String(error && error.message || error);
    const errMsg = error && typeof error === "object" && error.errMsg
      ? String(error.errMsg)
      : (message.indexOf(name + ":fail ") === 0 ? message : name + ":fail " + message);
    const failure = { errMsg: errMsg, code: String(error && error.code || "ERR_INVALID_REQUEST"), api: String(error && error.api || name) };
    return __container_async_result(callback, null, failure);
  }
}
function __storage_one(op, key, value) {
  const patches = __storage_array(); __storage_data(patches, 0, __storage_patch(op, key, value)); __storage_commit(patches);
}
function __storage_encrypt(options) {
  const encrypt = options.encrypt;
  if (encrypt !== undefined && typeof encrypt !== "boolean") __storage_fail("storage encrypt must be boolean");
  if (encrypt) throw new __storage_Error("encrypted storage is not implemented");
}
function __storage_batch(items) {
  if (!__storage_is_array(items) || items.length > 100000) __storage_fail("storage batch requires a bounded kvList array");
  const length = items.length;
  const patches = __storage_array();
  for (let index = 0; index < length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== "object") __storage_fail("storage batch entry requires key and value");
    __storage_data(patches, index, __storage_patch("set", item.key, item.value));
  }
  __storage_commit(patches);
}
__storage_data(wx, "setStorageSync", function(key, value) {
  __container_storage_require("wx.setStorageSync");
  const item = typeof key === "string" ? { key: key, data: value } : __container_options(key);
  __storage_one("set", item.key, item.data);
});
__storage_data(wx, "getStorageSync", function(key) {
  __container_storage_require("wx.getStorageSync");
  key = __storage_key(typeof key === "string" ? key : __container_options(key).key);
  return __storage_entries[key] ? __container_storage_get(key) : "";
});
__storage_data(wx, "removeStorageSync", function(key) {
  __container_storage_require("wx.removeStorageSync"); __storage_one("remove", typeof key === "string" ? key : __container_options(key).key);
});
__storage_data(wx, "clearStorageSync", function() { __container_storage_require("wx.clearStorageSync"); __storage_one("clear"); });
__storage_data(wx, "getStorageInfoSync", function() { __container_storage_require("wx.getStorageInfoSync"); return __container_storage_info(); });
__storage_data(wx, "batchSetStorageSync", function(items) { __container_storage_require("wx.batchSetStorageSync"); __storage_batch(items); });
__storage_data(wx, "setStorage", function(options) {
  const item = __container_options(options);
  return __container_storage_async("wx.setStorage", item, function() { __storage_encrypt(item); __storage_one("set", item.key, item.data); return { errMsg: "wx.setStorage:ok" }; });
});
__storage_data(wx, "getStorage", function(options) {
  const item = __container_options(options);
  return __container_storage_async("wx.getStorage", item, function() {
    __storage_encrypt(item); const key = __storage_key(item.key);
    if (!__storage_entries[key]) throw new __storage_Error("data not found");
    return { data: __container_storage_get(key), errMsg: "wx.getStorage:ok" };
  });
});
__storage_data(wx, "removeStorage", function(options) {
  const item = __container_options(options);
  return __container_storage_async("wx.removeStorage", item, function() { __storage_one("remove", item.key); return { errMsg: "wx.removeStorage:ok" }; });
});
__storage_data(wx, "clearStorage", function(options) { return __container_storage_async("wx.clearStorage", options, function() { __storage_one("clear"); return { errMsg: "wx.clearStorage:ok" }; }); });
__storage_data(wx, "getStorageInfo", function(options) { return __container_storage_async("wx.getStorageInfo", options, __container_storage_info); });
__storage_data(wx, "batchSetStorage", function(options) {
  const item = __container_options(options);
  return __container_storage_async("wx.batchSetStorage", item, function() { __storage_batch(item.kvList); return { errMsg: "wx.batchSetStorage:ok" }; });
});
