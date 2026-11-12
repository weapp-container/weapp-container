//! V8 integration boundary.
//!
//! The default build is deliberately a metadata-only stub. Enabling the
//! `v8-native` feature links the pinned `v8` (rusty_v8) provider and runs
//! modules in an actual isolate. The two modes are intentionally explicit:
//! no host can silently turn a requested V8 runtime into a different engine.

use std::fmt;
#[cfg(feature = "v8-native")]
use std::time::Instant as TurnSchedulerInstant;

mod view;
pub use view::V8ViewEngine;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineMode {
    Stub,
    V8,
    Unavailable,
}

#[cfg(feature = "v8-native")]
const MINI_PROGRAM_BOOTSTRAP: &str = r##"
globalThis.__container_app = null;
globalThis.__container_pages = [];
globalThis.__container_current_page_indices = [];
globalThis.__container_current_page_instances = [];
globalThis.__container_page_instances = Object.create(null);
globalThis.__container_components = [];
globalThis.__container_managed_component_modules = Object.create(null);
globalThis.__container_component_module_definitions = Object.create(null);
globalThis.__container_component_scopes = Object.create(null);
globalThis.__container_component_selection_pages = Object.create(null);
globalThis.__container_registration_module_id = null;
globalThis.__container_events = [];
globalThis.__container_errors = [];
globalThis.__container_app_listeners = {
  show: [], hide: [], error: [], pageNotFound: []
};
globalThis.__container_network_status_listeners = [];
let __container_storage = Object.create(null);
globalThis.__container_api_id = 0;
globalThis.__container_audio_context_id = 0;
globalThis.__container_video_context_id = 0;
globalThis.__container_camera_context_id = 0;
globalThis.__container_offscreen_canvas_id = 0;
globalThis.__container_api_pending = Object.create(null);
// Values for synchronous host APIs are installed by the runtime before a
// module is evaluated. Keeping them in the isolate makes calls such as
// getSystemInfoSync genuinely synchronous while the provider still owns the
// platform-specific source of truth.
let __container_sync_api_values = Object.create(null);
let __container_sync_api_errors = Object.create(null);
let __container_sync_files = Object.create(null);
let __container_sync_files_available = false;
let __container_capabilities = {
  "Page.selectComponent": "partial", "Page.selectAllComponents": "partial",
  "Component.selectComponent": "partial", "Component.selectAllComponents": "partial",
  "Component.selectOwnerComponent": "partial",
  "Component.relations": "partial", "Component.getRelationNodes": "partial", "Component.hasBehavior": "partial",
  "wx.canIUse": "full",
  "wx.getPerformance": "partial",
  "getCurrentPages": "partial",
  "wx.onAppShow": "partial", "wx.onAppHide": "partial",
  "wx.onBeforeAppRoute": "partial", "wx.offBeforeAppRoute": "partial",
  "wx.onAppRoute": "partial", "wx.offAppRoute": "partial", "wx.rewriteRoute": "partial",
  "wx.onError": "partial", "wx.offError": "partial", "wx.onPageNotFound": "partial",
  "wx.onNetworkStatusChange": "partial",
  "wx.createSelectorQuery": "full",
  "wx.createIntersectionObserver": "partial",
  "wx.createMediaQueryObserver": "partial",
  "wx.createCanvasContext": "partial", "wx.canvas.draw": "partial",
  "wx.createOffscreenCanvas": "partial",
  "wx.createAnimation": "partial",
  "wx.getMenuButtonBoundingClientRect": "partial",
  "wx.getEnterOptionsSync": "partial",
  "wx.getAccountInfoSync": "full",
  "wx.arrayBufferToBase64": "full", "wx.base64ToArrayBuffer": "full",
  "wx.getRandomValues": "full",
  "wx.getExtConfigSync": "partial",
  "wx.getExtConfig": "partial",
  "wx.getAppAuthorizeSetting": "partial",
  "wx.getBatteryInfo": "partial",
  "wx.getBatteryInfoSync": "partial",
  "wx.getScreenBrightness": "partial",
  "wx.setScreenBrightness": "partial",
  "wx.getSystemSetting": "partial",
  "wx.connectSocket": "partial",
  "wx.shareAppMessage": "partial", "wx.shareTimeline": "partial",
  "wx.setStorage": "partial", "wx.setStorageSync": "partial",
  "wx.batchSetStorage": "partial", "wx.batchSetStorageSync": "partial",
  "wx.getStorage": "partial", "wx.getStorageSync": "full",
  "wx.getStorageInfo": "full", "wx.getStorageInfoSync": "full",
  "wx.removeStorage": "full", "wx.removeStorageSync": "full",
  "wx.clearStorage": "full", "wx.clearStorageSync": "full",
  "wx.navigateTo": "partial", "wx.redirectTo": "partial",
  "wx.navigateBack": "partial", "wx.reLaunch": "partial",
  "wx.switchTab": "partial", "wx.preloadPage": "partial",
  "wx.setNavigationBarTitle": "partial",
  "wx.redirectToMiniProgram": "partial",
  "wx.showToast": "partial", "wx.hideToast": "partial",
  "wx.showLoading": "partial", "wx.hideLoading": "partial",
  "wx.showModal": "partial", "wx.showActionSheet": "partial",
  "wx.pageScrollTo": "partial", "wx.setNavigationBarColor": "partial",
  "wx.getLocation": "partial", "wx.startLocationUpdate": "partial",
  "wx.createInnerAudioContext": "partial", "wx.innerAudioContext": "partial",
  "wx.createVideoContext": "partial", "wx.videoContext": "partial",
  "wx.createAudioContext": "partial", "wx.audioContext": "partial",
  "wx.createCameraContext": "partial", "wx.cameraContext": "partial",
  "wx.stopLocationUpdate": "partial", "wx.scanCode": "partial",
  "setData": "partial", "setTimeout": "partial", "setInterval": "partial",
  "clearTimeout": "partial", "clearInterval": "partial"
};
function __container_clone(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}
function __container_error(name, message) {
  const error = { errMsg: name + ":fail " + message, code: "ERR_UNSUPPORTED_CAPABILITY", api: name };
  __container_errors.push(error);
  return error;
}
function __container_report_error(error) {
  return __container_error_notifications.report(error);
}
function __container_capability(name) {
  const raw = String(name);
  // wx.canIUse accepts both fully-qualified names ("wx.request") and the
  // public short form ("request"). Keep component capability strings such as
  // "button.open-type.getUserInfo" untouched because they are not API names.
  const canonical = raw.indexOf(".") < 0 && raw !== "getCurrentPages" ? "wx." + raw : raw;
  return __container_capabilities[raw]
    || __container_capabilities[canonical]
    || (canonical === "wx.innerAudioContext" ? (__container_capabilities["wx.createInnerAudioContext"] || "unsupported") : null)
    || (canonical === "wx.audioContext" ? (__container_capabilities["wx.createAudioContext"] || "unsupported") : null)
    || (canonical === "wx.cameraContext" ? (__container_capabilities["wx.createCameraContext"] || "unsupported") : null)
    || (canonical === "wx.socketTask.send" || canonical === "wx.socketTask.close" ? (__container_capabilities["wx.connectSocket"] || "unsupported") : null)
    || (canonical.indexOf("wx.fs.") === 0 || canonical === "wx.saveFile" || canonical === "wx.removeSavedFile"
      || canonical === "wx.getFileInfo" || canonical === "wx.getSavedFileInfo" || canonical === "wx.getSavedFileList"
      ? (__container_capabilities["wx.getFileSystemManager"] || "unsupported")
      : "unsupported");
}
function __container_set_sync_api_values(values, errors) {
  __container_sync_api_values = Object.assign(Object.create(null), values || {});
  __container_sync_api_errors = Object.assign(Object.create(null), errors || {});
  return true;
}
function __container_set_sync_files(files) {
  __container_sync_files = Object.assign(Object.create(null), files || {});
  __container_sync_files_available = true;
  return true;
}
function __container_sync_api(name) {
  const capability = __container_capability(name);
  if (capability === "unsupported") throw __container_error(name, "unsupported");
  const failure = __container_sync_api_errors[name];
  if (failure) {
    __container_errors.push(__container_clone(failure));
    throw failure;
  }
  if (!Object.prototype.hasOwnProperty.call(__container_sync_api_values, name)) {
    throw __container_error(name, "synchronous provider value is unavailable");
  }
  return __container_clone(__container_sync_api_values[name]);
}
function __container_file_path(value, name) {
  const path = String(value == null ? "" : value).replace(/\\/g, "/").replace(/^wxfile:\/\//, "").replace(/^\/+/, "");
  if (!path) throw __container_sync_file_error(name, "filePath is required", "ERR_INVALID_REQUEST");
  return path;
}
function __container_sync_utf8_bytes(text) {
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) { code = 0x10000 + ((code - 0xD800) * 0x400) + low - 0xDC00; index += 1; }
    }
    if (code <= 0x7F) bytes.push(code);
    else if (code <= 0x7FF) bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
    else if (code <= 0xFFFF) bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
    else bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
  }
  return bytes;
}
function __container_sync_base64(bytes) {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] || 0, b = index + 1 < bytes.length ? bytes[index + 1] : 0, c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const value = (a << 16) | (b << 8) | c;
    result += table[(value >> 18) & 63] + table[(value >> 12) & 63] + (index + 1 < bytes.length ? table[(value >> 6) & 63] : "=") + (index + 2 < bytes.length ? table[value & 63] : "=");
  }
  return result;
}
// New facade helpers stay lexical. Function declarations are reserved for the
// legacy global bootstrap aliases explicitly retained by the environment owner.
const __container_base64_error = function(name, message) {
  const error = { errMsg: name + ":fail " + message, code: "ERR_INVALID_REQUEST", api: name };
  __container_errors.push(error);
  throw error;
};
const __container_base64_decode = function(value) {
  if (typeof value !== "string") __container_base64_error("wx.base64ToArrayBuffer", "base64 must be a string");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(value)) {
    __container_base64_error("wx.base64ToArrayBuffer", "base64 is invalid");
  }
  const padded = value + "=".repeat((4 - value.length % 4) % 4);
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = [];
  for (let index = 0; index < padded.length; index += 4) {
    const a = table.indexOf(padded[index]), b = table.indexOf(padded[index + 1]);
    const c = padded[index + 2] === "=" ? 0 : table.indexOf(padded[index + 2]);
    const d = padded[index + 3] === "=" ? 0 : table.indexOf(padded[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) __container_base64_error("wx.base64ToArrayBuffer", "base64 is invalid");
    const value24 = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((value24 >> 16) & 255);
    if (padded[index + 2] !== "=") bytes.push((value24 >> 8) & 255);
    if (padded[index + 3] !== "=") bytes.push(value24 & 255);
  }
  return new Uint8Array(bytes).buffer;
};
const __container_array_buffer_to_base64 = function(value) {
  if (__container_capability("wx.arrayBufferToBase64") === "unsupported") throw __container_error("wx.arrayBufferToBase64", "unsupported");
  if (!(value instanceof ArrayBuffer)) __container_base64_error("wx.arrayBufferToBase64", "arrayBuffer must be an ArrayBuffer");
  return __container_sync_base64(new Uint8Array(value));
};
const __container_base64_to_array_buffer = function(value) {
  if (__container_capability("wx.base64ToArrayBuffer") === "unsupported") throw __container_error("wx.base64ToArrayBuffer", "unsupported");
  return __container_base64_decode(value);
};
function __container_sync_bytes(value) {
  if (typeof value === "string") return __container_sync_utf8_bytes(value);
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return Array.prototype.slice.call(new Uint8Array(value));
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value)) return Array.prototype.slice.call(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return null;
}
function __container_sync_file_error(name, message, code) {
  const error = { errMsg: name + ":fail " + message, code: code || "ERR_INVALID_REQUEST", api: name };
  __container_errors.push(error);
  return error;
}
function __container_sync_file(name, filePath, data, encoding) {
  const capability = __container_capability(name);
  if (capability === "unsupported") throw __container_error(name, "unsupported");
  if (!__container_sync_files_available) throw __container_error(name, "synchronous filesystem provider is unavailable");
  const options = filePath && typeof filePath === "object" ? filePath : { filePath: filePath, data: data, encoding: encoding };
  if (name === "wx.fs.readdirSync") {
    const rawDir = options.dirPath;
    if (typeof rawDir !== "string") throw __container_sync_file_error(name, "dirPath is required", "ERR_INVALID_REQUEST");
    const dir = String(rawDir).replace(/\\/g, "/").replace(/^wxfile:\/\//, "").replace(/^\/+/, "");
    const prefix = dir.length ? dir + "/" : "";
    const entries = Object.keys(__container_sync_files).reduce(function(result, filePath) {
      if (filePath.indexOf(prefix) !== 0) return result;
      const relative = filePath.slice(prefix.length);
      if (!relative) return result;
      const entry = relative.split("/")[0];
      if (result.indexOf(entry) < 0) result.push(entry);
      return result;
    }, []);
    entries.sort();
    return entries;
  }
  const path = __container_file_path(options.filePath || options.path, name);
  const entry = __container_sync_files[path];
  if (name === "wx.fs.readFileSync") {
    if (!entry) throw __container_sync_file_error(name, "no such file or directory, open '" + path + "'");
    const requested = options.encoding == null ? "" : String(options.encoding).toLowerCase();
    if (requested === "base64") return String(entry.base64 || "");
    if (requested === "utf8" || requested === "utf-8" || requested === "ucs2" || requested === "ucs-2" || requested === "ascii" || requested === "latin1" || requested === "binary") {
      if (entry.text !== null && entry.text !== undefined) return String(entry.text);
    }
    if (typeof Uint8Array === "function") return new Uint8Array(entry.bytes || []).buffer;
    return __container_clone(entry.bytes || []);
  }
  if (name === "wx.fs.accessSync") {
    if (!entry) throw __container_sync_file_error(name, "no such file or directory, access '" + path + "'");
    return undefined;
  }
  if (name === "wx.fs.unlinkSync") {
    if (!entry) throw __container_sync_file_error(name, "no such file or directory, unlink '" + path + "'");
    delete __container_sync_files[path];
    __container_events.push({ type: "api.sync", name: name, options: { filePath: path } });
    return undefined;
  }
  if (name === "wx.fs.writeFileSync") {
    const bytes = __container_sync_bytes(options.data);
    if (!bytes) throw __container_sync_file_error(name, "data must be a string or ArrayBuffer");
    const text = typeof options.data === "string" ? String(options.data) : null;
    __container_sync_files[path] = { bytes: bytes, text: text, base64: __container_sync_base64(bytes) };
    const eventOptions = text === null ? { filePath: path, data: __container_sync_base64(bytes), encoding: "base64" } : __container_clone(options);
    __container_events.push({ type: "api.sync", name: name, options: eventOptions });
    return undefined;
  }
  throw __container_sync_file_error(name, "unsupported");
}
const __container_api_callback_error_push = Function.call.bind(Array.prototype.push);
function __container_api_callback_attempt(invoke) {
  try {
    invoke();
  } catch (callbackError) {
    // Only this compatibility diagnostic projection reads guest getters. The
    // private hub still notifies once before any legacy reporting failure is
    // returned here; neither path may skip complete or Promise settlement.
    try { __container_error_notifications.reportApiCallback(callbackError); }
    catch (_) {
      // Even the error queue may be frozen or replaced by the guest. Reporting
      // is best-effort; it must never interrupt the terminal delivery sequence.
      try { __container_api_callback_error_push(__container_errors, { name: "Error", message: "API callback threw an unreportable value" }); }
      catch (_) {}
    }
  }
}
function __container_invoke_api_callback(options, name, value) {
  __container_api_callback_attempt(function() {
    if (typeof options[name] === "function") options[name](value);
  });
}
// Only lexical framework delivery accepts a private incarnation snapshot.
// Keep the public compatibility callback helper's three-argument contract.
function __container_deliver_api_callback(options, name, value, callbackOwner) {
  __container_api_callback_attempt(function() {
    __container_turn_scheduler.withCapturedOwner(callbackOwner, function() {
      if (typeof options[name] === "function") options[name](value);
    });
  });
}
function __container_async_result(options, value, error) {
  const callback = options || {};
  const ok = !error, result = error || value;
  const callbackOwner = __container_turn_scheduler.captureOwner();
  Promise.resolve().then(function() {
    __container_deliver_api_callback(callback, ok ? "success" : "fail", result, callbackOwner);
    __container_deliver_api_callback(callback, "complete", result, callbackOwner);
  });
  return ok ? Promise.resolve(result) : Promise.reject(result);
}
function __container_options(value) {
  return value && typeof value === "object" ? value : {};
}
function __container_require_key(options, name) {
  const key = options && options.key;
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new TypeError(name + ":fail key must be a non-empty string");
  }
  return key;
}
function __container_navigation(name, options) {
  const callback = __container_options(options);
  const publicName = name.replace(/^wx\./, "");
  if (__container_capability(name) === "unsupported") {
    const error = { errMsg: publicName + ":fail unsupported", code: "ERR_UNSUPPORTED_CAPABILITY", api: name };
    return __container_async_result(callback, null, error);
  }
  let invalid = null;
  if (!(options === undefined && name === "wx.navigateBack")
    && (!options || typeof options !== "object" || Array.isArray(options))) {
    invalid = "options must be an object";
  } else if (name === "wx.setNavigationBarTitle") {
    if (typeof callback.title !== "string") invalid = "title must be a string";
  } else if (name !== "wx.navigateBack"
    && (typeof callback.url !== "string" || !callback.url.trim())) {
    invalid = "url must be a non-empty string";
  }
  if (invalid) {
    const error = { errMsg: publicName + ":fail " + invalid, code: "ERR_INVALID_REQUEST", api: name };
    return __container_async_result(callback, null, error);
  }
  return __container_api_call(name, callback);
}
function __container_share(name, options) {
  const callback = __container_options(options);
  if (__container_capability(name) === "unsupported") {
    const error = __container_error(name, "unsupported");
    return __container_async_result(callback, null, error);
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    const error = { errMsg: name + ":fail options must be an object", code: "ERR_INVALID_REQUEST", api: name };
    __container_errors.push(error);
    return __container_async_result(callback, null, error);
  }
  return __container_api_call(name, options);
}
function __container_request_payment(options) {
  const name = "wx.requestPayment";
  const callback = __container_options(options);
  if (__container_capability(name) === "unsupported") {
    const error = __container_error(name, "unsupported");
    return __container_async_result(callback, null, error);
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    const error = { errMsg: name + ":fail options must be an object", code: "ERR_INVALID_REQUEST", api: name };
    __container_errors.push(error);
    return __container_async_result(callback, null, error);
  }
  const required = ["timeStamp", "nonceStr", "package", "paySign"];
  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];
    if (typeof options[key] !== "string" || options[key].trim().length === 0) {
      const error = { errMsg: name + ":fail requires non-empty " + key, code: "ERR_INVALID_REQUEST", api: name };
      __container_errors.push(error);
      return __container_async_result(callback, null, error);
    }
  }
  if (typeof options.signType !== "string" || ["MD5", "HMAC-SHA256", "RSA"].indexOf(options.signType.trim()) < 0) {
    const error = { errMsg: name + ":fail signType must be MD5, HMAC-SHA256, or RSA", code: "ERR_INVALID_REQUEST", api: name };
    __container_errors.push(error);
    return __container_async_result(callback, null, error);
  }
  return __container_api_call(name, options);
}
function __container_selector_query() { return __container_selector_queries.create(); }
// Observers keep callbacks in this isolate. Registration requests only
// acknowledge subscriptions; committed host frames deliver one result batch.
globalThis.__container_observer_id = 0;
globalThis.__container_observer_subscription_id = 0;
globalThis.__container_observers = Object.create(null);
function __container_observer_error(name, message) {
  const error = { errMsg: name + ":fail " + message, code: "ERR_INVALID_REQUEST", api: name };
  __container_errors.push(error);
  return error;
}
function __container_observer_owner(component) {
  if (component && typeof component === "object") return component;
  const owner = __container_api_owner_for_observer();
  if (owner) return owner;
  const pages = __host_current_pages === null ? (globalThis.__container_current_page_instances || []) : __host_current_pages;
  return pages.length ? pages[pages.length - 1] : null;
}
function __container_observer_identity(owner) {
  const scope = owner && (owner.scopeId != null ? owner.scopeId
    : (owner.__scopeId != null ? owner.__scopeId : owner.__container_scope_id));
  const page = owner && (owner.__container_page_id != null ? owner.__container_page_id : owner.__container_instance_id);
  return {
    scopeId: scope != null && String(scope).trim().length ? String(scope) : null,
    pageId: page != null && String(page).trim().length ? String(page) : null
  };
}
function __container_new_observer(name, component) {
  const owner = __container_observer_owner(component);
  const identity = __container_observer_identity(owner);
  // A lifecycle owner is also a cleanup boundary, but only the explicit
  // component overload/method narrows selector matching to that component.
  const scope = component && typeof component === "object"
    ? __container_observer_identity(component).scopeId : null;
  const record = {
    id: "observer-" + (++__container_observer_id), name: name, owner: owner,
    pageId: identity.pageId, scopeId: scope,
    active: true, subscriptions: Object.create(null)
  };
  __container_observers[record.id] = record;
  return record;
}
function __container_observer_request(record, request) {
  request.observerId = record.id;
  if (record.pageId !== null) request.pageId = record.pageId;
  if (record.scopeId !== null) request.scopeId = record.scopeId;
  return request;
}
function __container_observer_subscribe(record, request, callback) {
  if (typeof callback !== "function") throw __container_observer_error(record.name, "callback must be a function");
  const id = "subscription-" + (++__container_observer_subscription_id);
  record.subscriptions[id] = callback;
  request.subscriptionId = id;
  return __container_api_call(record.name, __container_observer_request(record, request)).then(function(result) {
    // The acknowledgement is deliberately not an observation. Geometry may
    // not exist until the first frame is committed after this request.
    return result;
  }, function(error) {
    delete record.subscriptions[id];
    throw error;
  });
}
function __container_observer_disconnect(record) {
  if (!record.active) return Promise.resolve({ errMsg: record.name + ":disconnect:ok" });
  // Revoke before crossing the bridge, including results already queued in
  // the host. A delayed acknowledgement can never resurrect a subscription.
  record.active = false;
  record.subscriptions = Object.create(null);
  delete __container_observers[record.id];
  return __container_api_call(record.name, __container_observer_request(record, { action: "disconnect" }));
}
function __container_observer_report(error) {
  try {
    if (error && error.code) __container_errors.push(__container_clone(error));
    else __container_report_error(error);
  } catch (_) {
    __container_errors.push({ name: "Error", message: "Observer callback threw an unreportable value" });
  }
}
function __container_release_observers(owner, filter) {
  const released = [];
  Object.keys(__container_observers).forEach(function(id) {
    const record = __container_observers[id];
    const matchesOwner = owner && record.owner === owner;
    const hasFilter = filter && (filter.pageId != null || filter.scopeId != null);
    const matchesFilter = hasFilter
      && (filter.pageId == null || record.pageId === String(filter.pageId))
      && (filter.scopeId == null || record.scopeId === String(filter.scopeId));
    if (!matchesOwner && !matchesFilter) return;
    released.push(id);
    __container_observer_disconnect(record).catch(__container_observer_report);
  });
  return released;
}
globalThis.__container_disconnect_observers = function(filter) {
  return __container_release_observers(null, filter);
};
globalThis.__container_notify_observers = function(batch) {
  let delivered = 0, ignored = 0;
  (Array.isArray(batch) ? batch : []).forEach(function(notification) {
    const record = notification && __container_observers[notification.observerId];
    const callback = record && record.active && record.subscriptions[notification.subscriptionId];
    if (typeof callback !== "function") { ignored++; return; }
    delivered++;
    try {
      // Carry scope through callbacks without changing the public callback's
      // ordinary unbound receiver (strict callbacks must still see undefined).
      __container_turn_scheduler.withOwner(record.owner, function() {
        callback(__container_clone(notification.value));
      });
    } catch (error) { __container_observer_report(error); }
  });
  return { delivered: delivered, ignored: ignored };
};
function __container_intersection_observer(componentOrOptions, maybeOptions) {
  const name = "wx.createIntersectionObserver";
  if (__container_capability(name) === "unsupported") throw __container_error(name, "unsupported");
  // WeChat accepts both createIntersectionObserver(options) and the
  // component-scoped overload createIntersectionObserver(component, options).
  // Preserve the component scope in the single provider request so selector
  // matching remains component-local without a second bridge round trip.
  const scoped = maybeOptions !== undefined || !!(componentOrOptions && typeof componentOrOptions === "object"
    && (componentOrOptions.__container_is_component || componentOrOptions.__container_page_index != null));
  const component = scoped && componentOrOptions && typeof componentOrOptions === "object"
    ? componentOrOptions : null;
  const rawOptions = scoped ? maybeOptions : componentOrOptions;
  const config = __container_clone(rawOptions && typeof rawOptions === "object" ? rawOptions : {});
  if (scoped && component) {
    const scopeId = component.scopeId || component.__scopeId || component.__container_scope_id;
    if (scopeId != null && String(scopeId).trim().length > 0) config.scopeId = String(scopeId);
  }
  if (Object.prototype.hasOwnProperty.call(config, "thresholds")) {
    if (!Array.isArray(config.thresholds) || config.thresholds.some(function(value) {
      return typeof value !== "number" || !isFinite(value) || value < 0 || value > 1;
    })) throw __container_observer_error(name, "thresholds must be numbers between 0 and 1");
  }
  if (Object.prototype.hasOwnProperty.call(config, "initialRatio") &&
      (typeof config.initialRatio !== "number" || !isFinite(config.initialRatio) || config.initialRatio < 0 || config.initialRatio > 1)) {
    throw __container_observer_error(name, "initialRatio must be a number between 0 and 1");
  }
  if (Object.prototype.hasOwnProperty.call(config, "observeAll") && typeof config.observeAll !== "boolean") {
    throw __container_observer_error(name, "observeAll must be a boolean");
  }
  if (Object.prototype.hasOwnProperty.call(config, "nativeMode") && typeof config.nativeMode !== "boolean") {
    throw __container_observer_error(name, "nativeMode must be a boolean");
  }
  // Public relative calls accumulate intersection roots. nativeMode only
  // permits a single root; validation precedes mutation of the builder.
  config.relativeRoots = [];
  function addRoot(root) {
    if (config.nativeMode === true && config.relativeRoots.length) {
      throw __container_observer_error(name, "nativeMode permits only one relative root");
    }
    config.relativeRoots.push(root);
  }
  const record = __container_new_observer(name, component);
  const api = {
    relativeTo: function(selector, margins) {
      if (!record.active) return api;
      if (typeof selector !== "string" || selector.trim().length === 0) throw __container_observer_error(name, "relative selector is required");
      const normalizedMargins = margins == null ? {} : margins;
      if (!normalizedMargins || typeof normalizedMargins !== "object" || Array.isArray(normalizedMargins)) {
        throw __container_observer_error(name, "margins must be an object");
      }
      ["top", "right", "bottom", "left"].forEach(function(edge) {
        if (Object.prototype.hasOwnProperty.call(normalizedMargins, edge) &&
            (typeof normalizedMargins[edge] !== "number" || !isFinite(normalizedMargins[edge]))) {
          throw __container_observer_error(name, "margin " + edge + " must be a number");
        }
      });
      const root = { kind: "node", selector: String(selector), margins: __container_clone(normalizedMargins) };
      addRoot(root);
      config.relativeTo = { selector: root.selector, margins: __container_clone(root.margins) };
      return api;
    },
    relativeToViewport: function(margins) {
      if (!record.active) return api;
      const normalizedMargins = margins == null ? {} : margins;
      if (!normalizedMargins || typeof normalizedMargins !== "object" || Array.isArray(normalizedMargins)) {
        throw __container_observer_error(name, "margins must be an object");
      }
      ["top", "right", "bottom", "left"].forEach(function(edge) {
        if (Object.prototype.hasOwnProperty.call(normalizedMargins, edge) &&
            (typeof normalizedMargins[edge] !== "number" || !isFinite(normalizedMargins[edge]))) {
          throw __container_observer_error(name, "margin " + edge + " must be a number");
        }
      });
      addRoot({ kind: "viewport", margins: __container_clone(normalizedMargins) });
      config.relativeToViewport = __container_clone(normalizedMargins);
      return api;
    },
    observe: function(selector, callback) {
      if (!record.active) return Promise.reject(__container_observer_error(name, "observer has been disconnected"));
      if (typeof selector !== "string" || selector.trim().length === 0) {
        return Promise.reject(__container_observer_error(name, "selector is required"));
      }
      const request = { action: "observe", selector: selector, options: __container_clone(config) };
      return __container_observer_subscribe(record, request, callback);
    },
    disconnect: function() {
      return __container_observer_disconnect(record);
    }
  };
  return api;
}
function __container_media_query_observer(component) {
  const name = "wx.createMediaQueryObserver";
  if (__container_capability(name) === "unsupported") throw __container_error(name, "unsupported");
  const owner = __container_observer_owner(component);
  // Real receivers carry a private incarnation. Public page/scope aliases
  // cannot move a subscription to a replacement with the same textual id.
  const identity = owner && typeof owner === "object" ? __receiver_get(__receiver_weak, owner) : null;
  const pageIdentity = identity ? __receiver_value(__receiver_pages, identity.pageId) : null;
  function requireOwner() {
    // Standalone engine diagnostics can create Page() without a host mirror.
    // Once native receivers exist, an unregistered object cannot borrow a
    // public method or forge aliases to become a lifecycle owner.
    if (owner && !identity && __receiver_sequence > 0n) {
      throw __container_observer_error(name, "observer owner is not a registered receiver");
    }
    if (identity) {
      if (identity.retired || __receiver_get(__receiver_weak, owner) !== identity
          || !pageIdentity || pageIdentity.retired
          || __receiver_value(__receiver_pages, identity.pageId) !== pageIdentity
          || (identity.scopeId !== null && identity.pageToken !== pageIdentity.token)) {
        throw __container_observer_error(name, "observer owner has been disposed");
      }
    } else if (owner && (owner.__container_disposed || owner.__container_detached_lifecycle)) {
      throw __container_observer_error(name, "observer owner has been disposed");
    }
  }
  requireOwner();
  const record = identity ? {
    id: "observer-" + (++__container_observer_id), name: name, owner: owner,
    pageId: identity.pageId,
    scopeId: component && typeof component === "object" ? identity.scopeId : null,
    active: true, subscriptions: Object.create(null)
  } : __container_new_observer(name, component);
  if (identity) __container_observers[record.id] = record;
  const api = {
    observe: function(descriptor, callback) {
      if (!record.active) {
        throw __container_observer_error(name, "observer has been disconnected");
      }
      requireOwner();
      if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
        const error = __container_observer_error(name, "descriptor must be an object");
        throw error;
      }
      if (typeof callback !== "function") throw __container_observer_error(name, "callback must be a function");
      // The locked descriptor contains only seven primitive fields. Project
      // them once instead of JSON-cloning an application object: toJSON,
      // unknown cycles and clone's legacy raw-object fallback cannot enter
      // the native effect queue or change a field between validation/send.
      const normalized = Object.create(null);
      try {
        ["width", "minWidth", "maxWidth", "height", "minHeight", "maxHeight", "orientation"].forEach(function(key) {
          if (Object.prototype.hasOwnProperty.call(descriptor, key)) normalized[key] = descriptor[key];
        });
      } catch (_) {
        throw __container_observer_error(name, "descriptor fields could not be read");
      }
      ["width", "minWidth", "maxWidth", "height", "minHeight", "maxHeight"].forEach(function(key) {
        if (Object.prototype.hasOwnProperty.call(normalized, key) &&
            (typeof normalized[key] !== "number" || !isFinite(normalized[key]) || normalized[key] < 0)) {
          throw __container_observer_error(name, key + " must be a finite non-negative number");
        }
      });
      if (Object.prototype.hasOwnProperty.call(normalized, "orientation") &&
          (normalized.orientation !== "portrait" && normalized.orientation !== "landscape")) {
        throw __container_observer_error(name, "orientation must be portrait or landscape");
      }
      // A field getter can disconnect this observer or dispose its owner.
      // Recheck both fences before installing an owned subscription.
      if (!record.active) throw __container_observer_error(name, "observer has been disconnected");
      requireOwner();
      const request = { action: "observe", descriptor: normalized };
      __container_observer_subscribe(record, request, function(value) {
        // Disposal in an earlier callback fences later notifications already
        // collected in the same native batch, before a cleanup ACK arrives.
        requireOwner();
        callback(value);
      }).catch(__container_observer_report);
    },
    disconnect: function() {
      __container_observer_disconnect(record).catch(__container_observer_report);
    }
  };
  return api;
}
// Animation is installed from the shared AppService environment.
// Inner audio is a stateful host resource. The JS object keeps property
// semantics local and sends one batched command per transport operation;
// native providers can replace the sandbox state machine with a decoder and
// output device without changing the public object contract.
function __container_create_inner_audio_context() {
  if (__container_capability("wx.createInnerAudioContext") === "unsupported") {
    throw __container_error("wx.createInnerAudioContext", "unsupported");
  }
  const contextId = "audio-" + String(++globalThis.__container_audio_context_id);
  const state = {
    src: "", startTime: 0, autoplay: false, loop: false, volume: 1,
    playbackRate: 1, obeyMuteSwitch: true, currentTime: 0, duration: 0,
    paused: true, buffered: 0, destroyed: false
  };
  const listeners = Object.create(null);
  ["canplay", "play", "pause", "stop", "ended", "timeUpdate", "error",
    "waiting", "seeking", "seeked"].forEach(function(name) { listeners[name] = []; });
  function dispatch(name, value) {
    (listeners[name] || []).slice().forEach(function(callback) {
      try { callback(value); } catch (error) { __container_report_error(error); }
    });
  }
  function update(result) {
    if (!result || typeof result !== "object") return result;
    ["src", "startTime", "autoplay", "loop", "volume", "playbackRate",
      "obeyMuteSwitch", "currentTime", "duration", "paused", "buffered",
      "destroyed"].forEach(function(key) {
      if (Object.prototype.hasOwnProperty.call(result, key)) state[key] = result[key];
    });
    if (result.event) dispatch(String(result.event), result);
    return result;
  }
  function invoke(command, extra) {
    const request = Object.assign({
      contextId: contextId, command: command, src: state.src,
      startTime: state.startTime, autoplay: state.autoplay, loop: state.loop,
      volume: state.volume, playbackRate: state.playbackRate,
      obeyMuteSwitch: state.obeyMuteSwitch
    }, extra || {});
    return __container_api_call("wx.innerAudioContext", request).then(update);
  }
  const api = {};
  api.play = function() { return invoke("play"); };
  api.pause = function() { return invoke("pause"); };
  api.stop = function() { return invoke("stop"); };
  api.seek = function(position) { return invoke("seek", { position: Number(position) }); };
  api.destroy = function() { state.destroyed = true; return invoke("destroy"); };
  ["onCanplay", "onPlay", "onPause", "onStop", "onEnded", "onTimeUpdate",
    "onError", "onWaiting", "onSeeking", "onSeeked"].forEach(function(method) {
    const event = method.slice(2);
    const key = event.charAt(0).toLowerCase() + event.slice(1);
    api[method] = function(callback) {
      if (typeof callback === "function" && listeners[key].indexOf(callback) < 0) listeners[key].push(callback);
      return api;
    };
    api["off" + event.charAt(0).toUpperCase() + event.slice(1)] = function(callback) {
      const list = listeners[key];
      if (typeof callback !== "function") list.splice(0, list.length);
      else { const index = list.indexOf(callback); if (index >= 0) list.splice(index, 1); }
      return api;
    };
  });
  ["src", "startTime", "autoplay", "loop", "volume", "playbackRate", "obeyMuteSwitch"].forEach(function(key) {
    Object.defineProperty(api, key, {
      enumerable: true, configurable: false,
      get: function() { return state[key]; },
      set: function(value) {
        state[key] = value;
        const update = {}; update[key] = value;
        invoke("set", update).catch(function(error) { dispatch("error", error); });
      }
    });
  });
  ["currentTime", "duration", "paused", "buffered"].forEach(function(key) {
    Object.defineProperty(api, key, { enumerable: true, get: function() { return state[key]; } });
  });
  // Registration is observable by the provider and creates the lifetime
  // record. It does not claim that audio is available until `play` succeeds.
  invoke("create").catch(function(error) { dispatch("error", error); });
  return api;
}
// AudioContext controls an <audio> component.  It shares the provider's
// deterministic transport state machine with InnerAudioContext while keeping
// the component-scoped API (audio id and setSrc) explicit at the JS boundary.
function __container_create_audio_context(audioId, component) {
  const name = "wx.createAudioContext";
  if (__container_capability(name) === "unsupported") {
    throw __container_error(name, "unsupported");
  }
  const id = String(audioId == null ? "" : audioId);
  if (!id) {
    const error = { errMsg: name + ":fail audioId is required", code: "ERR_INVALID_REQUEST", api: name };
    __container_errors.push(error);
    throw error;
  }
  const contextId = "component-audio-" + id;
  const state = { src: "", currentTime: 0, paused: true, destroyed: false };
  function invoke(command, extra) {
    const request = Object.assign({ contextId: contextId, command: command, src: state.src }, extra || {});
    return __container_api_call("wx.audioContext", request).then(function(result) {
      if (result && typeof result === "object") {
        if (Object.prototype.hasOwnProperty.call(result, "src")) state.src = result.src;
        if (Object.prototype.hasOwnProperty.call(result, "currentTime")) state.currentTime = result.currentTime;
        if (Object.prototype.hasOwnProperty.call(result, "paused")) state.paused = result.paused;
        if (Object.prototype.hasOwnProperty.call(result, "destroyed")) state.destroyed = result.destroyed;
      }
      return result;
    });
  }
  const api = {
    setSrc: function(value) {
      state.src = String(value == null ? "" : value);
      return invoke("set", { src: state.src });
    },
    play: function() { return invoke("play"); },
    pause: function() { return invoke("pause"); },
    seek: function(position) { return invoke("seek", { position: Number(position) }); }
  };
  invoke("create").catch(function(error) { __container_report_error(error); });
  return api;
}
// VideoContext controls a page video component by id. Commands are kept in a
// single provider boundary so sandbox and native hosts share validation and
// lifetime semantics without exposing platform surfaces to JavaScript.
function __container_create_video_context(videoId, component) {
  const name = "wx.createVideoContext";
  if (__container_capability(name) === "unsupported") {
    throw __container_error(name, "unsupported");
  }
  if (typeof videoId !== "string" || videoId.trim().length === 0) {
    const error = { errMsg: name + ":fail videoId is required", code: "ERR_INVALID_REQUEST", api: name };
    __container_errors.push(error);
    throw error;
  }
  const value = videoId;
  const contextId = "video-" + String(++globalThis.__container_video_context_id);
  const state = { playing: false, position: 0, playbackRate: 1, fullscreen: false, statusBarVisible: true };
  function invoke(command, extra) {
    const request = Object.assign({ contextId: contextId, videoId: value, command: command }, extra || {});
    return __container_api_call("wx.videoContext", request).then(function(result) {
      if (result && typeof result === "object") {
        if (Object.prototype.hasOwnProperty.call(result, "playing")) state.playing = result.playing;
        if (Object.prototype.hasOwnProperty.call(result, "position")) state.position = result.position;
        if (Object.prototype.hasOwnProperty.call(result, "playbackRate")) state.playbackRate = result.playbackRate;
        if (Object.prototype.hasOwnProperty.call(result, "fullscreen")) state.fullscreen = result.fullscreen;
        if (Object.prototype.hasOwnProperty.call(result, "statusBarVisible")) state.statusBarVisible = result.statusBarVisible;
      }
      return result;
    });
  }
  const api = {
    play: function() { return invoke("play"); },
    pause: function() { return invoke("pause"); },
    stop: function() { return invoke("stop"); },
    seek: function(position) { return invoke("seek", { position: Number(position) }); },
    sendDanmu: function(options) {
      const item = __container_options(options);
      return invoke("sendDanmu", { text: item.text, color: item.color });
    },
    playbackRate: function(rate) { return invoke("playbackRate", { rate: Number(rate) }); },
    requestFullScreen: function(options) {
      const item = __container_options(options);
      return invoke("requestFullScreen", { direction: item.direction });
    },
    exitFullScreen: function() { return invoke("exitFullScreen"); },
    showStatusBar: function() { return invoke("showStatusBar"); },
    hideStatusBar: function() { return invoke("hideStatusBar"); }
  };
  invoke("create").catch(function(error) { __container_report_error(error); });
  return api;
}
// CameraContext keeps the component command surface available while leaving
// camera acquisition to the host provider. The sandbox validates the public
// options and returns ERR_PERMISSION_DENIED or ERR_UNSUPPORTED_CAPABILITY;
// it never invents an image/video path or a camera frame.
function __container_create_camera_context() {
  const name = "wx.createCameraContext";
  if (__container_capability(name) === "unsupported") {
    throw __container_error(name, "unsupported");
  }
  const contextId = "camera-" + String(++globalThis.__container_camera_context_id);
  const state = { recording: false, frameStreaming: false, destroyed: false };
  function invoke(command, options) {
    const source = __container_options(options);
    const request = Object.assign({ contextId: contextId, command: command }, source);
    return __container_api_call("wx.cameraContext", request).then(function(result) {
      if (result && typeof result === "object") {
        ["recording", "frameStreaming", "destroyed"].forEach(function(key) {
          if (Object.prototype.hasOwnProperty.call(result, key)) state[key] = result[key];
        });
      }
      return result;
    });
  }
  const api = {
    takePhoto: function(options) {
      const source = __container_options(options);
      const request = { quality: source.quality === undefined ? "high" : source.quality };
      ["success", "fail", "complete"].forEach(function(key) {
        if (typeof source[key] === "function") request[key] = source[key];
      });
      return invoke("takePhoto", request);
    },
    startRecord: function(options) {
      const source = __container_options(options);
      const request = {};
      if (source.timeout !== undefined) request.timeout = source.timeout;
      ["success", "fail", "complete"].forEach(function(key) {
        if (typeof source[key] === "function") request[key] = source[key];
      });
      return invoke("startRecord", request);
    },
    stopRecord: function(options) {
      const source = __container_options(options);
      const request = {};
      ["success", "fail", "complete"].forEach(function(key) {
        if (typeof source[key] === "function") request[key] = source[key];
      });
      return invoke("stopRecord", request);
    },
    onCameraFrame: function(callback) {
      if (typeof callback !== "function") {
        const error = { errMsg: name + ":fail onCameraFrame callback must be a function", code: "ERR_INVALID_REQUEST", api: name };
        __container_errors.push(error);
        throw error;
      }
      const listener = {
        start: function() {
          return invoke("frameStart").then(function(result) {
            state.frameStreaming = true;
            return result;
          });
        },
        stop: function() {
          return invoke("frameStop").then(function(result) {
            state.frameStreaming = false;
            return result;
          });
        }
      };
      // A sandbox/native provider may emit frame events through the bridge;
      // no callback is invoked until a real provider supplies a frame.
      return listener;
    }
  };
  // Context creation only allocates a provider-owned lifetime record. It does
  // not request camera permission or claim that a device is present.
  invoke("create").catch(function(error) { __container_report_error(error); });
  return api;
}
// WebSocketTask keeps its event listeners and readyState in the isolate while
// the provider owns transport.  The sandbox provider opens a virtual socket
// and records sent/close commands, so callback and failure timing can be
// conformance-tested without contacting a network.
function __container_connect_socket(options) {
  const name = "wx.connectSocket";
  if (__container_capability(name) === "unsupported") {
    const error = __container_error(name, "unsupported");
    const callback = __container_options(options);
    __container_async_result(callback, null, error).catch(function() {});
    return { readyState: 3, onOpen: function() {}, onClose: function() {}, onError: function() {}, onMessage: function() {} };
  }
  const source = __container_options(options);
  const state = { socketId: null, readyState: 0 };
  const listeners = { open: [], close: [], error: [], message: [] };
  function add(kind, callback) {
    if (typeof callback === "function" && listeners[kind].indexOf(callback) < 0) listeners[kind].push(callback);
    return task;
  }
  function remove(kind, callback) {
    const list = listeners[kind];
    if (typeof callback !== "function") list.splice(0, list.length);
    else { const index = list.indexOf(callback); if (index >= 0) list.splice(index, 1); }
    return task;
  }
  function dispatch(kind, value) {
    listeners[kind].slice().forEach(function(callback) {
      try { callback(value); } catch (error) { __container_report_error(error); }
    });
  }
  function callbacks(callbacks, ok, result) {
    try {
      if (ok && typeof callbacks.success === "function") callbacks.success(result);
      if (!ok && typeof callbacks.fail === "function") callbacks.fail(result);
      if (typeof callbacks.complete === "function") callbacks.complete(result);
    } catch (error) { __container_report_error(error); }
  }
  function request(operation, payload, callbackOptions) {
    const promise = __container_api_call(operation, payload);
    promise.then(function(result) { callbacks(callbackOptions, true, result); return result; }, function(error) {
      callbacks(callbackOptions, false, error); dispatch("error", error); throw error;
    });
    return promise;
  }
  const task = {
    get socketId() { return state.socketId; },
    get readyState() { return state.readyState; },
    send: function(sendOptions) {
      const callback = __container_options(sendOptions);
      if (state.readyState !== 1 || !state.socketId) {
        const error = __container_error("wx.socketTask.send", "socket is not open");
        callbacks(callback, false, error);
        return Promise.reject(error);
      }
      const payload = { socketId: state.socketId, data: callback.data };
      return request("wx.socketTask.send", payload, callback);
    },
    close: function(closeOptions) {
      const callback = __container_options(closeOptions);
      if (state.readyState !== 1 || !state.socketId) {
        const error = __container_error("wx.socketTask.close", "socket is not open");
        callbacks(callback, false, error);
        return Promise.reject(error);
      }
      state.readyState = 2;
      const payload = { socketId: state.socketId };
      if (callback.code !== undefined) payload.code = callback.code;
      if (callback.reason !== undefined) payload.reason = callback.reason;
      return request("wx.socketTask.close", payload, callback).then(function(result) {
        state.readyState = 3;
        dispatch("close", { code: result.code, reason: result.reason });
        return result;
      }, function(error) { state.readyState = 1; throw error; });
    },
    onOpen: function(callback) { return add("open", callback); },
    offOpen: function(callback) { return remove("open", callback); },
    onClose: function(callback) { return add("close", callback); },
    offClose: function(callback) { return remove("close", callback); },
    onError: function(callback) { return add("error", callback); },
    offError: function(callback) { return remove("error", callback); },
    onMessage: function(callback) { return add("message", callback); },
    offMessage: function(callback) { return remove("message", callback); }
  };
  const connectPayload = {};
  ["url", "protocols", "tcpNoDelay", "perMessageDeflate", "timeout"].forEach(function(key) {
    if (Object.prototype.hasOwnProperty.call(source, key)) connectPayload[key] = __container_clone(source[key]);
  });
  __container_api_call(name, connectPayload).then(function(result) {
    state.socketId = result.socketId || null;
    state.readyState = 1;
    dispatch("open", result);
    callbacks(source, true, result);
    return result;
  }, function(error) {
    state.readyState = 3;
    dispatch("error", error);
    callbacks(source, false, error);
    throw error;
  }).catch(function() {});
  return task;
}
// Pending compatibility records remain public; receiver authority is held only
// in this lexical WeakMap and captured before guest payload getters can reenter.
const __container_api_callback_owners = new WeakMap();
function __container_api_call(name, options, owner) {
  const callbackOwner = __container_turn_scheduler.captureOwner();
  const callback = __container_options(options);
  const requestId = ++__container_api_id;
  const event = { type: "api.call", id: requestId, name: name };
  if (name === "wx.navigateTo") {
    try {
      // Prepare the wire payload before allocating a channel or a pending
      // promise. The legacy clone's raw-object fallback cannot safely carry
      // cyclic options, throwing getters or toJSON into the effect queue.
      const prepared = __container_event_channels.prepare(callback, owner);
      event.options = prepared.options;
      if (owner !== undefined) event.owner = prepared.owner;
      __container_event_channels.start(requestId, callback);
    } catch (error) { return __container_async_result(callback, null, error); }
  } else {
    event.options = __container_clone(callback);
    if (owner !== undefined) event.owner = __container_clone(owner);
  }
  let promise;
  try {
    promise = new Promise(function(resolve, reject) {
      const pending = { resolve: resolve, reject: reject, options: callback, name: name };
      __receiver_set(__container_api_callback_owners, pending, callbackOwner);
      __container_api_pending[requestId] = pending;
    });
    __container_events.push(event);
  } catch (error) {
    delete __container_api_pending[requestId];
    if (name === "wx.navigateTo") __container_event_channels.discard(requestId);
    throw error;
  }
  return promise;
}
// Captured before application modules execute. A ticket is resolved by native
// authority at the actual callback microtask, never by guest-supplied JSON.
const __container_delivery_claim = globalThis.__container_host_api_delivery_claim;
const __container_delivery_parse = JSON.parse;
const __container_delivery_number = Number;
// Native then still performs SpeciesConstructor on its receiver. Keep the
// scheduler's own constructor private so guest prototype/@@species changes
// cannot throw after the API pending entry has been consumed.
const __container_delivery_promise = Promise.resolve();
Object.defineProperty(__container_delivery_promise, "constructor", {value:undefined,writable:false,configurable:false});
const __container_delivery_schedule = Function.call.bind(Promise.prototype.then, __container_delivery_promise);
function __container_resolve_api(requestId, result, error, deliveryTicket, deliveryDecoder) {
  const claimedDelivery = deliveryTicket !== undefined;
  const id = claimedDelivery ? __container_delivery_number(requestId) : Number(requestId);
  const pending = __container_api_pending[id];
  if (!pending) return false;
  delete __container_api_pending[id];
  const callbackOwner = __receiver_get(__container_api_callback_owners, pending) || null;
  let failed = !!error;
  const complete = function() {
    if (claimedDelivery) {
      try {
        if (typeof __container_delivery_claim !== "function") throw null;
        const outcome = __container_delivery_parse(__container_delivery_claim(id, deliveryTicket));
        if (outcome.status === "retired") return;
        if (outcome.status === "failure") {
          failed = true;
          error = outcome.error;
          result = null;
        } else if (outcome.status === "success") {
          failed = false;
          error = null;
          try { result = typeof deliveryDecoder === "function" ? deliveryDecoder(outcome.result, pending.name) : outcome.result; }
          catch (_) {
            failed = true;
            result = null;
            error = { code: "ERR_INVALID_RESPONSE", errMsg: pending.name + ":fail invalid native API result" };
          }
        } else throw null;
      } catch (_) {
        failed = true;
        result = null;
        error = { code: "ERR_API_DELIVERY", errMsg: pending.name + ":fail invalid native API delivery" };
      }
    }
    if (pending.name === "wx.navigateTo") {
      const navigation = __container_event_channels.settle(id, failed, failed ? error : result);
      failed = navigation.failed;
      if (failed) error = navigation.value; else result = navigation.value;
    }
    const value = failed ? error : result;
    __container_deliver_api_callback(pending.options, failed ? "fail" : "success", value, callbackOwner);
    __container_deliver_api_callback(pending.options, "complete", value, callbackOwner);
    if (failed) pending.reject(error);
    else pending.resolve(result);
  };
  if (claimedDelivery) __container_delivery_schedule(complete);
  else Promise.resolve().then(complete);
  return true;
}
// Keep this grammar aligned with container_core::DataPatch::path_tokens:
// dotted object keys and bracketed non-negative array indices. Host patches
// carry the already parsed tokens, so the bridge has one authoritative parse.
function __container_path_parts(path) {
  const source = String(path);
  const parts = [];
  let offset = 0;
  while (offset < source.length) {
    if (source[offset] === "[") {
      const end = source.indexOf("]", offset + 1);
      if (end < 0 || !/^[0-9]+$/.test(source.slice(offset + 1, end))) return null;
      const index = Number(source.slice(offset + 1, end));
      if (!Number.isSafeInteger(index) || index >= 1048576) return null;
      parts.push(index);
      offset = end + 1;
    } else {
      const start = offset;
      while (offset < source.length && !/[.\[\]]/.test(source[offset])) offset += 1;
      if (offset === start) return null;
      parts.push(source.slice(start, offset));
    }
    if (source[offset] === ".") {
      offset += 1;
      if (offset === source.length || /[.\[\]]/.test(source[offset])) return null;
    } else if (offset < source.length && source[offset] !== "[") return null;
  }
  return parts;
}
function __container_apply_data_path(target, parts, value, deleting) {
  if (!parts.length) return deleting ? null : __container_clone(value);
  const part = parts[0];
  const array = typeof part === "number";
  const matching = array ? Array.isArray(target)
    : target !== null && typeof target === "object" && !Array.isArray(target);
  if (!matching) {
    if (deleting) return target;
    target = array ? [] : {};
  }
  const owned = Object.prototype.hasOwnProperty.call(target, part);
  if (deleting && !owned) return target;
  if (deleting && parts.length === 1) {
    if (array) target[part] = null;
    else delete target[part];
    return target;
  }
  const next = __container_apply_data_path(owned ? target[part] : null, parts.slice(1), value, deleting);
  // Own data properties also keep __proto__/constructor paths from walking
  // or mutating JavaScript's prototypes through a portable JSON data key.
  Object.defineProperty(target, part, { value: next, enumerable: true, writable: true, configurable: true });
  return target;
}
function __container_set_path(target, path, value) {
  const parts = __container_path_parts(path);
  if (!parts) throw new TypeError("setData:fail invalid data path " + String(path));
  return __container_apply_data_path(target, parts, value, value === undefined);
}
function __container_get_path(target, path) {
  const parts = __container_path_parts(path);
  if (!parts) return undefined;
  return parts.reduce(function(value, part) {
    return value == null || !Object.prototype.hasOwnProperty.call(Object(value), part) ? undefined : value[part];
  }, target);
}
function __container_apply_set_data(page, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("setData:fail data must be an object");
  }
  if (!page.data || typeof page.data !== "object") page.data = {};
  const changes = [];
  const paths = Object.keys(patch);
  paths.forEach(function(path) {
    if (!__container_path_parts(path)) throw new TypeError("setData:fail invalid data path " + String(path));
  });
  const write = __receiver_write_begin(page, paths);
  let writeCompleted = false;
  try {
  paths.forEach(function(path) {
    const value = patch[path];
    page.data = __container_set_path(page.data, path, value);
    changes.push({ path: path, op: value === undefined ? "delete" : "set", value: __container_clone(value) });
  });
  if (page.observers && typeof page.observers === "object") {
    Object.keys(page.observers).forEach(function(paths) {
      const observer = page.observers[paths];
      if (typeof observer !== "function") return;
      const values = paths.split(",").map(function(path) { return __container_get_path(page.data, path.trim()); });
      try { __container_turn_scheduler.invokeOwned(page, observer, values); } catch (error) { __container_report_error(error); }
    });
  }
  if (changes.length) {
    const event = { type: "data.patch.batch", pageIndex: page.__container_page_index, patches: changes };
    if (page.__container_instance_id != null) event.pageId = Number(page.__container_instance_id);
    __container_events.push(event);
  }
  writeCompleted = true;
  return changes;
  } finally { __receiver_write_finish(write, writeCompleted); }
}
function __container_component_equal(left, right) {
  if (left === right) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch (_) { return false; }
}
function __container_component_path_parts(path) {
  return __container_path_parts(path) || [];
}
function __container_component_path_changed(changed, path) {
  const observed = __container_path_parts(path);
  if (!observed) return false;
  return changed.some(function(entry) {
    const parts = __container_path_parts(entry);
    if (!parts) return false;
    return parts.slice(0, Math.min(parts.length, observed.length)).every(function(part, index) {
      return part === observed[index];
    });
  });
}
function __container_component_observe(component, changedPaths) {
  const observers = component.observers && typeof component.observers === "object" ? component.observers : {};
  Object.keys(observers).forEach(function(paths) {
    const observer = observers[paths];
    if (typeof observer !== "function") return;
    const normalized = String(paths).split(",").map(function(path) { return path.trim(); }).filter(function(path) { return path.length > 0; });
    if (!normalized.length) return;
    if (normalized[0] !== "**" && !normalized.some(function(path) { return __container_component_path_changed(changedPaths, path); })) return;
    const values = normalized[0] === "**"
      ? [__container_clone(component.data || {})]
      : normalized.map(function(path) { return __container_clone(__container_get_path(component.data, path)); });
    try { __container_turn_scheduler.invokeOwned(component, observer, values); } catch (error) { __container_report_error(error); }
  });
}
function __container_component_apply_patch(component, patch, source) {
  if (component.__container_disposed) return [];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("component property patch must be an object");
  }
  const changes = [];
  const changedPaths = [];
  const oldValues = Object.create(null);
  const paths = Object.keys(patch);
  paths.forEach(function(path) {
    if (!__container_path_parts(path)) throw new TypeError("setData:fail invalid data path " + String(path));
  });
  // Reserve before any component write or observer. Exhaustion and exceptions
  // cannot leave changed data carrying the previously accepted input stamp.
  const write = __receiver_write_begin(component, paths, source === "setData");
  let mutation = null;
  let completed = false;
  try {
  mutation = paths.length ? __receiver_component_begin(component) : null;
  if (!component.data || typeof component.data !== "object") component.data = {};
  if (!component.properties || typeof component.properties !== "object") component.properties = {};
  paths.forEach(function(path) {
    const parts = __container_component_path_parts(path);
    if (!parts.length) return;
    const root = parts[0];
    const descriptor = component.__container_property_descriptors && component.__container_property_descriptors[root];
    const oldValue = __container_clone(__container_get_path(component.data, path));
    if (!Object.prototype.hasOwnProperty.call(oldValues, root)) oldValues[root] = __container_clone(__container_get_path(component.data, root));
    oldValues[path] = oldValue;
    component.data = __container_set_path(component.data, path, patch[path]);
    // `setData` updates the component's internal data. External properties are
    // owned by the parent and change only through mount/property.update;
    // keeping the two stores separate matches the observable Component API.
    if (descriptor && source !== "setData") component.properties = __container_set_path(component.properties, path, patch[path]);
    const nextValue = __container_clone(__container_get_path(component.data, path));
    if (__container_component_equal(oldValue, nextValue)) return;
    changedPaths.push(path);
    changes.push({ path: path, op: nextValue === undefined ? "delete" : "set", value: nextValue, oldValue: oldValue });
  });
  if (!changes.length) { completed = true; return changes; }
  const descriptors = component.__container_property_descriptors || {};
  const seenRoots = Object.create(null);
  changedPaths.forEach(function(path) {
    const root = __container_component_path_parts(path)[0];
    if (seenRoots[root]) return;
    seenRoots[root] = true;
    const descriptor = descriptors[root];
    const observer = source === "setData" ? null : descriptor && descriptor.observer;
    if (typeof observer === "function") {
      const value = __container_clone(__container_get_path(component.properties, root));
      const previous = __container_clone(oldValues[root]);
      try { __container_turn_scheduler.invokeOwned(component, observer, [value, previous, root]); } catch (error) { __container_report_error(error); }
    }
  });
  __container_component_observe(component, changedPaths);
  const event = { type: "component.property.patch", componentIndex: component.__container_component_index, source: source || "setData", patches: changes };
  event.inputIdentity = mutation ? mutation.identity : null;
  if (component.__container_scope_id != null) event.scopeId = component.__container_scope_id;
  if (component.__container_page_id != null) event.pageId = component.__container_page_id;
  __container_events.push(event);
  completed = true;
  return changes;
  } finally {
    __receiver_component_finish(mutation, !completed || changes.length > 0);
    __receiver_write_finish(write, completed);
    __receiver_record_component_data(mutation);
  }
}
function __container_set_data(page, patch, callback) {
  // A framework completion belongs to the actual setData receiver, even when
  // another Page called it or the receiver retires before the microtask runs.
  const completionOwner = __container_turn_scheduler.captureReceiverOwner(page);
  const changes = page && page.__container_is_component
    ? __container_component_apply_patch(page, patch, "setData")
    : __container_apply_set_data(page, patch);
  if (typeof callback === "function") Promise.resolve().then(function() {
    __container_turn_scheduler.withCapturedOwner(completionOwner, function() { callback(); });
  });
  return changes;
}
function __container_component_lifecycle(component, name, args) {
  if (name === "detached") __receiver_retire(component);
  component.__container_lifecycle = component.__container_lifecycle || [];
  if (name === "created" && component.__container_created_lifecycle) return null;
  if (name === "attached" && component.__container_attached_lifecycle) return null;
  if (name === "ready" && component.__container_ready_lifecycle) return null;
  if (name === "detached" && component.__container_detached_lifecycle) return null;
  // These hooks are one-shot attempts, including hooks that throw or
  // re-enter reconciliation. Retrying a caught hook would repeat user side
  // effects and prevent the runtime graph from reaching a stable snapshot.
  if (name === "created") component.__container_created_lifecycle = true;
  if (name === "attached") component.__container_attached_lifecycle = true;
  if (name === "ready") component.__container_ready_lifecycle = true;
  if (name === "detached") component.__container_detached_lifecycle = true;
  const hooks = component.__container_lifecycle_hooks && component.__container_lifecycle_hooks[name];
  const fallback = component.lifetimes && typeof component.lifetimes[name] === "function"
    ? component.lifetimes[name] : component[name];
  const handlers = Array.isArray(hooks) && hooks.length > 0 ? hooks : (typeof fallback === "function" ? [fallback] : []);
  if (!handlers.length) {
    component.__container_lifecycle.push(name);
    if (name === "detached") __container_release_observers(component, __container_observer_identity(component));
    return null;
  }
  try {
    let result;
    handlers.forEach(function(hook) { result = __container_turn_scheduler.invokeOwned(component, hook, args); });
    component.__container_lifecycle.push(name);
    return result === undefined ? null : __container_clone(result);
  } catch (error) {
    __container_report_error(error);
    component.__container_lifecycle.push(name + ":error");
    return null;
  } finally {
    if (name === "detached") __container_release_observers(component, __container_observer_identity(component));
  }
}
function __container_drain_events() {
  // Keep the exact batch until native JSON conversion succeeds. Serializing
  // application values may throw, be interrupted, or enqueue more effects.
  // Later effects use fresh queues and never enlarge this batch's prefix.
  if (__host_drain_pending) return __host_drain_pending.batch;
  if (__host_drain_id >= 9007199254740991) throw new Error("effect drain identity exhausted");
  const pending = __host_create(null);
  const batch = __host_create(null);
  pending.id = ++__host_drain_id;
  pending.tail = __host_storage_tail;
  pending.componentTail = __receiver_component_tail;
  pending.writeTail = __receiver_write_tail;
  pending.batch = batch;
  batch.__containerDrainId = pending.id;
  batch.events = __container_events;
  batch.errors = __container_errors;
  batch.console = __dev_console();
  __container_events = [];
  __container_errors = [];
  __host_drain_pending = pending;
  return batch;
}
globalThis.App = function(options) {
  const app = options || {};
  globalThis.__container_app = app;
  __container_unhandled_rejections.bindApp(app);
  if (!app.globalData) app.globalData = {};
  return app;
};
globalThis.Page = function(options) {
  const page = options || {};
  // `getCurrentPages()` returns the registered page object itself.  Route and
  // query metadata are filled by the runtime when the page enters the stack;
  // keeping the object identity here preserves setData and page methods.
  if (!Object.prototype.hasOwnProperty.call(page, "route")) page.route = "";
  if (!Object.prototype.hasOwnProperty.call(page, "options")) page.options = {};
  page.data = __container_clone(page.data || {});
  page.__container_page_index = globalThis.__container_pages.length;
  if (__container_registration_module_id != null) {
    const moduleId = __container_registration_module_id;
    page.__container_module_id = moduleId;
    const definitions = globalThis.__container_page_module_definitions;
    (definitions[moduleId] || (definitions[moduleId] = [])).push(page.__container_page_index);
  }
  page.setData = function(patch, callback) { return __container_set_data(this, patch, callback); };
  __container_install_component_selection(page, false);
  __container_event_channels.install(page);
  page.createMediaQueryObserver = function() { return __container_media_query_observer(this); };
  page.createIntersectionObserver = function(options) { return __container_intersection_observer(this, options || {}); };
  globalThis.__container_pages.push(page);
  return page;
};
function __container_component_protocol_error(message, code) {
  const error = new Error(message);
  error.code = code || "ERR_INVALID_REQUEST";
  return error;
}
// Component selection uses declaration ownership rather than composed render
// ancestry. A projected slot can be physically inside a different component.
// The runtime publishes the entire page selection frontier before any attached
// hook, and every result is a live occurrence rather than a registration object.
function __container_component_selection_error(message, unsupported) {
  return __container_component_protocol_error(message, unsupported ? "ERR_UNSUPPORTED_CAPABILITY" : "ERR_INVALID_REQUEST");
}
function __container_component_selection_node(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)
      || typeof node.id !== "string" || typeof node.tag !== "string" || !node.tag.trim()
      || !Array.isArray(node.classes) || node.classes.some(function(name) { return typeof name !== "string" || !name || /\s/.test(name); })) {
    throw __container_component_selection_error("invalid component selection node");
  }
  return { id: node.id, tag: node.tag, classes: node.classes.slice() };
}
function __container_component_selection_metadata(value) {
  if (value == null) return null; // Legacy explicit component helpers have no host node.
  const result = __container_component_selection_node(value);
  if (!Array.isArray(value.ancestors) || !Number.isSafeInteger(value.order) || value.order < 0) {
    throw __container_component_selection_error("invalid component selection metadata");
  }
  result.ancestors = value.ancestors.map(__container_component_selection_node);
  result.order = value.order;
  return result;
}
function __container_component_selection_parse(selector) {
  if (typeof selector !== "string" || !selector.trim()) {
    throw __container_component_selection_error("component selector must be a nonempty string");
  }
  function unsupported() {
    throw __container_component_selection_error("component selector syntax is not supported: " + selector, true);
  }
  return selector.split(",").map(function(source) {
    const text = source.trim();
    if (!text) return unsupported();
    const parts = [];
    const combinators = [];
    let position = 0;
    while (position < text.length) {
      const part = { id: null, classes: [] };
      let count = 0;
      while (position < text.length && (text[position] === "#" || text[position] === ".")) {
        const prefix = text[position++];
        const start = position;
        while (position < text.length && /[A-Za-z0-9_\-\u0080-\uFFFF]/.test(text[position])) position++;
        if (start === position) return unsupported();
        const name = text.slice(start, position);
        if (prefix === "#") {
          if (part.id !== null) return unsupported();
          part.id = name;
        } else part.classes.push(name);
        count++;
      }
      if (!count) return unsupported();
      parts.push(part);
      const beforeWhitespace = position;
      while (position < text.length && /\s/.test(text[position])) position++;
      if (position === text.length) break;
      if (text[position] === ">") {
        position++;
        while (position < text.length && /\s/.test(text[position])) position++;
        if (position === text.length || text[position] === ">") return unsupported();
        combinators.push(">");
      } else if (position !== beforeWhitespace) combinators.push(" ");
      else return unsupported();
    }
    if (combinators.length !== parts.length - 1) return unsupported();
    return { parts: parts, combinators: combinators };
  });
}
function __container_component_selection_matches(metadata, selector) {
  const nodes = metadata.ancestors.concat([metadata]);
  function matches(node, part) {
    return (part.id === null || part.id === node.id) && part.classes.every(function(name) { return node.classes.indexOf(name) >= 0; });
  }
  let partIndex = selector.parts.length - 1;
  if (!matches(nodes[nodes.length - 1], selector.parts[partIndex])) return false;
  let candidates = [nodes.length - 1];
  while (partIndex > 0) {
    const combinator = selector.combinators[partIndex - 1];
    partIndex--;
    const next = [];
    const seen = Object.create(null);
    candidates.forEach(function(nodeIndex) {
      for (let ancestor = nodeIndex - 1; ancestor >= 0; ancestor--) {
        if (!seen[ancestor] && matches(nodes[ancestor], selector.parts[partIndex])) {
          seen[ancestor] = true;
          next.push(ancestor);
        }
        if (combinator === ">") break;
      }
    });
    if (!next.length) return false;
    candidates = next;
  }
  return true;
}
function __container_component_selection_context(receiver) {
  if (!receiver || typeof receiver !== "object") return null;
  if (receiver.__container_is_component_instance) {
    const scope = receiver.__container_scope_id;
    if (typeof scope !== "string" || __container_component_scopes[scope] !== receiver
        || receiver.__container_disposed || receiver.__container_detached_lifecycle) return null;
    return { pageId: String(receiver.__container_page_id), ownerScopeId: scope };
  }
  const pageId = receiver.__container_instance_id;
  if (pageId == null || __host_page_lookup(String(pageId)) !== receiver) return null;
  return { pageId: String(pageId), ownerScopeId: null };
}
function __container_component_selection_public_reference(instance) {
  if (typeof instance.__container_component_export === "function") {
    throw __container_component_selection_error("component export selection is not supported", true);
  }
  return instance;
}
function __container_select_components(receiver, selector, all) {
  const groups = __container_component_selection_parse(selector);
  const context = __container_component_selection_context(receiver);
  if (!context) return all ? [] : null;
  const nodes = __container_component_selection_pages[context.pageId] || [];
  const selected = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.ownerScopeId !== context.ownerScopeId
        || !groups.some(function(group) { return __container_component_selection_matches(node.selection, group); })) continue;
    const component = node.componentScopeId == null ? null : __container_component_scopes[node.componentScopeId];
    if (!component || !component.__container_is_component_instance || component.__container_disposed
        || component.__container_detached_lifecycle || String(component.__container_page_id) !== context.pageId) {
      // selectComponent first matches a node and then converts it to an
      // instance. A native first match must not skip to a later custom node.
      if (!all) return null;
      continue;
    }
    const reference = __container_component_selection_public_reference(component);
    if (!all) return reference;
    selected.push(reference);
  }
  return all ? selected : null;
}
function __container_select_owner_component(receiver) {
  if (!receiver || !receiver.__container_is_component_instance || !__container_component_selection_context(receiver)) return null;
  const ownerScope = receiver.__container_owner_scope_id;
  if (ownerScope == null) return null;
  const owner = __container_component_scopes[ownerScope];
  if (!owner || !owner.__container_is_component_instance || owner.__container_disposed || owner.__container_detached_lifecycle
      || String(owner.__container_page_id) !== String(receiver.__container_page_id)) return null;
  return __container_component_selection_public_reference(owner);
}
function __container_install_component_selection(instance, component) {
  const prefix = component ? "Component." : "Page.";
  function requireCapability(method) {
    const name = prefix + method;
    if (__container_capability(name) === "unsupported") throw __container_error(name, "unsupported");
  }
  instance.selectComponent = function(selector) {
    requireCapability("selectComponent");
    return __container_select_components(this, selector, false);
  };
  instance.selectAllComponents = function(selector) {
    requireCapability("selectAllComponents");
    return __container_select_components(this, selector, true);
  };
  if (component) instance.selectOwnerComponent = function() {
    requireCapability("selectOwnerComponent");
    return __container_select_owner_component(this);
  };
}
globalThis.__container_configure_component_modules = function(moduleIds) {
  if (!Array.isArray(moduleIds) || moduleIds.some(function(id) { return typeof id !== "string" || !id.trim(); })) {
    throw __container_component_protocol_error("component module IDs must be nonempty strings");
  }
  moduleIds.forEach(function(id) { __container_managed_component_modules[id] = true; });
  return { moduleIds: moduleIds.slice() };
};
globalThis.__container_evaluate_named_module = function(moduleId, evaluate, cacheOwned) {
  const previous = __container_registration_module_id;
  const managed = __container_managed_component_modules[moduleId] === true;
  const componentCount = __container_components.length;
  const pageCount = __container_pages.length;
  const pageDefinitions = globalThis.__container_page_module_definitions;
  const previousPages = Object.prototype.hasOwnProperty.call(pageDefinitions, moduleId)
    ? pageDefinitions[moduleId].slice() : null;
  const previousDefinitions = Object.prototype.hasOwnProperty.call(__container_component_module_definitions, moduleId)
    ? __container_component_module_definitions[moduleId].slice() : null;
  // The legacy eager API is one atomic registration transaction, including
  // explicitly nested helper calls. Real cached require modules own separate
  // registrations, so a failed importer cannot undo a successful dependency.
  const transactionDefinitions = cacheOwned === true ? null : Object.create(null);
  const transactionPages = cacheOwned === true ? null : Object.create(null);
  if (transactionDefinitions !== null) {
    Object.keys(__container_component_module_definitions).forEach(function(id) {
      transactionDefinitions[id] = __container_component_module_definitions[id].slice();
    });
    Object.keys(pageDefinitions).forEach(function(id) { transactionPages[id] = pageDefinitions[id].slice(); });
  }
  __container_registration_module_id = moduleId;
  if (cacheOwned !== true) globalThis.__container_legacy_registration_depth++;
  if (managed) __container_component_module_definitions[moduleId] = [];
  try {
    const result = evaluate();
    if (managed && __container_component_module_definitions[moduleId].length !== 1) {
      throw __container_component_protocol_error("managed component module must register exactly one definition: " + moduleId, "ERR_MODULE_LOAD");
    }
    return result;
  } catch (error) {
    if (transactionPages !== null) {
      __container_pages.splice(pageCount);
      Object.keys(pageDefinitions).forEach(function(id) { delete pageDefinitions[id]; });
      Object.keys(transactionPages).forEach(function(id) { pageDefinitions[id] = transactionPages[id]; });
    } else {
      (pageDefinitions[moduleId] || []).forEach(function(index) {
        if (index >= pageCount) __container_pages[index] = null;
      });
      while (__container_pages.length > pageCount && __container_pages[__container_pages.length - 1] === null) __container_pages.pop();
      if (previousPages === null) delete pageDefinitions[moduleId];
      else pageDefinitions[moduleId] = previousPages;
    }
    if (managed) {
      if (transactionDefinitions !== null) {
        __container_components.splice(componentCount);
        Object.keys(__container_component_module_definitions).forEach(function(id) { delete __container_component_module_definitions[id]; });
        Object.keys(transactionDefinitions).forEach(function(id) { __container_component_module_definitions[id] = transactionDefinitions[id]; });
      } else {
        // Retain stable definition indices for successful cached dependencies.
        (__container_component_module_definitions[moduleId] || []).forEach(function(index) {
          if (index >= componentCount) __container_components[index] = null;
        });
        while (__container_components.length > componentCount
            && __container_components[__container_components.length - 1] === null) __container_components.pop();
        if (previousDefinitions === null) delete __container_component_module_definitions[moduleId];
        else __container_component_module_definitions[moduleId] = previousDefinitions;
      }
    }
    throw error;
  } finally {
    if (cacheOwned !== true) globalThis.__container_legacy_registration_depth--;
    __container_registration_module_id = previous;
  }
};
globalThis.Component = function(options) {
  const component = {};
  __container_merge_component_options(component, options || {});
  component.data = __container_clone(component.data || {});
  component.properties = component.properties || {};
  component.__container_property_descriptors = Object.create(null);
  component.__container_is_component = true;
  component.__container_is_component_definition = true;
  component.__container_lifecycle = [];
  component.createMediaQueryObserver = function() { return __container_media_query_observer(this); };
  component.createIntersectionObserver = function(options) { return __container_intersection_observer(this, options || {}); };
  Object.keys(component.properties).forEach(function(name) {
    const descriptor = component.properties[name];
    component.__container_property_descriptors[name] = descriptor && typeof descriptor === "object" && !Array.isArray(descriptor)
      ? descriptor : { type: descriptor };
    const defaultValue = descriptor && typeof descriptor === "object" && !Array.isArray(descriptor)
      && Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : undefined;
    component.properties[name] = __container_clone(defaultValue);
    if (!Object.prototype.hasOwnProperty.call(component.data, name)) component.data[name] = __container_clone(defaultValue);
  });
  // Keep an immutable registration baseline.  A Component() call registers a
  // definition; each rendered occurrence must start from that baseline rather
  // than inheriting state from a previous occurrence.
  component.__container_definition_data = __container_clone(component.data);
  component.__container_definition_properties = __container_clone(component.properties);
  component.setData = function(patch, callback) { return __container_set_data(component, patch, callback); };
  __container_install_component_events(component);
  __container_event_channels.install(component);
  __container_install_component_relations(component);
  component.__container_component_index = globalThis.__container_components.length;
  globalThis.__container_components.push(component);
  // Registration creates the definition object. We retain this observable
  // hook for compatibility with existing bundles; attached/ready/detached
  // are driven by the host's explicit component mount operations below.
  const moduleId = __container_registration_module_id;
  if (moduleId != null && __container_managed_component_modules[moduleId] === true) {
    component.__container_module_id = moduleId;
    (__container_component_module_definitions[moduleId] || (__container_component_module_definitions[moduleId] = [])).push(component.__container_component_index);
  } else {
    __container_component_lifecycle(component, "created");
  }
  return component;
};
function __container_clone_component_instance(definition, metadata) {
  const instance = {};
  Object.keys(definition).forEach(function(name) {
    if (name === "data" || name === "properties" || name === "setData" || name.indexOf("__container_") === 0) return;
    const value = definition[name];
    // Definition hooks and method tables are immutable executable metadata.
    // Other enumerable values are registration-instance state written by
    // `created`/methods and must start empty for every occurrence.
    if (typeof value === "function" || name === "methods" || name === "lifetimes"
      || name === "pageLifetimes" || name === "observers") instance[name] = value;
  });
  instance.data = __container_clone(definition.__container_definition_data || definition.data || {});
  instance.properties = __container_clone(definition.__container_definition_properties || definition.properties || {});
  instance.__container_property_descriptors = Object.create(null);
  Object.keys(definition.__container_property_descriptors || {}).forEach(function(name) {
    instance.__container_property_descriptors[name] = definition.__container_property_descriptors[name];
  });
  instance.__container_is_component = true;
  instance.__container_is_component_instance = true;
  instance.__container_component_export = definition.__container_component_export;
  instance.__container_component_export_behavior = !!definition.__container_component_export_behavior;
  instance.__container_component_definition_index = definition.__container_component_index;
  instance.__container_lifecycle_hooks = Object.create(null);
  Object.keys(definition.__container_lifecycle_hooks || {}).forEach(function(name) {
    instance.__container_lifecycle_hooks[name] = (definition.__container_lifecycle_hooks[name] || []).slice();
  });
  instance.__container_lifecycle = [];
  __container_install_component_selection(instance, true);
  instance.setData = function(patch, callback) { return __container_set_data(instance, patch, callback); };
  __container_install_component_events(instance);
  __container_event_channels.install(instance);
  __container_install_component_relations(instance, definition);
  instance.createMediaQueryObserver = function() { return __container_media_query_observer(this); };
  instance.createIntersectionObserver = function(options) { return __container_intersection_observer(this, options || {}); };
  instance.__container_component_index = globalThis.__container_components.length;
  if (metadata) {
    instance.scopeId = metadata.scopeId;
    instance.__container_scope_id = metadata.scopeId;
    instance.__container_module_id = metadata.moduleId;
    instance.is = String(metadata.moduleId).replace(/^module:/, "").replace(/\.(?:js|mjs|cjs)$/, "");
    instance.__container_page_id = metadata.pageId;
    instance.__container_bound_properties = Object.create(null);
    instance.__container_parent_scope_id = metadata.parentScopeId == null ? null : metadata.parentScopeId;
    instance.__container_owner_scope_id = metadata.ownerScopeId == null ? null : metadata.ownerScopeId;
    __receiver_register(instance, __host_string(metadata.pageId), metadata.scopeId);
    instance.createSelectorQuery = function() { return __container_selector_queries.create(this).in(this); };
  }
  globalThis.__container_components.push(instance);
  // Publish occurrence identity before created: a synchronous custom event can
  // reach its already constructed declaration owner in this same frontier.
  if (metadata) __container_component_scopes[metadata.scopeId] = instance;
  __container_component_lifecycle(instance, "created");
  return instance;
}
globalThis.__container_create_component_instance = function(definitionIndex) {
  const definition = globalThis.__container_components[Number(definitionIndex)];
  if (!definition || !definition.__container_is_component_definition) throw new Error("component definition not found");
  const instance = __container_clone_component_instance(definition);
  return { index: instance.__container_component_index, snapshot: __container_component_snapshot_value(instance) };
};
globalThis.getApp = function() { return globalThis.__container_app; };
globalThis.__container_set_current_pages = function(indices, metadata) {
  const values = Array.isArray(indices) ? indices : [];
  globalThis.__container_current_page_indices = values
    .map(function(index) { return Number(index); })
    .filter(function(index) { return Number.isInteger(index) && index >= 0; });
  const records = Array.isArray(metadata) ? metadata : [];
  const instances = [];
  const created = [];
  records.forEach(function(record) {
    if (!record || typeof record !== "object") return;
    const index = Number(record.index);
    const page = globalThis.__container_pages[index];
    if (!page) return;
    const instanceId = record.instanceId == null ? null : String(record.instanceId);
    let instance = instanceId && globalThis.__container_page_instances[instanceId];
    if (!instance) {
      instance = Object.create(page);
      instance.data = __container_clone(page.data || {});
      // A host may supply explicit initial data for this new page. Merge it
      // once, before onLoad, so defaults remain available to JS and rendering.
      const overrides = record.data && typeof record.data === "object" ? record.data : {};
      Object.keys(overrides).forEach(function(name) { instance.data[name] = __container_clone(overrides[name]); });
      instance.__container_page_index = index;
      instance.__container_instance_id = instanceId;
      if (instanceId) __receiver_register(instance, instanceId, null);
      instance.setData = function(patch, callback) { return __container_set_data(this, patch, callback); };
      __container_event_channels.install(instance);
      if (instanceId) {
        globalThis.__container_page_instances[instanceId] = instance;
        created.push({ instanceId: Number(instanceId), data: __container_clone(instance.data) });
      }
    }
    instances.push(instanceId ? instance : page);
    if (typeof record.route === "string") instance.route = record.route;
    if (record.options && typeof record.options === "object") instance.options = __container_clone(record.options);
    if (typeof record.route === "string") page.route = record.route;
    if (record.options && typeof record.options === "object") page.options = __container_clone(record.options);
  });
  // Keep the actual stack independently of application-writable aliases.
  // The trusted navigation mirror has its own private publication path.
  __receiver_current_pages = __host_copy_page_array(instances);
  globalThis.__container_current_page_instances = instances;
  return { created: created };
};
globalThis.getCurrentPages = function() {
  if (__container_capability("getCurrentPages") === "unsupported") throw __container_error("getCurrentPages", "unsupported");
  if (__host_current_pages !== null) return __host_copy_page_array(__host_current_pages);
  if (globalThis.__container_current_page_instances.length) return globalThis.__container_current_page_instances.slice();
  return globalThis.__container_current_page_indices
    .map(function(index) { return globalThis.__container_pages[index]; })
    .filter(function(page) { return !!page; });
};
// RequestTask/UploadTask/DownloadTask share the asynchronous provider
// boundary while retaining the task methods exposed by WeChat.  The promise
// returned by __container_api_call is augmented in-place, so existing
// callback/promise consumers keep one bridge request and task consumers can
// abort or observe response headers without a second per-event call.
function __container_network_task(name, options) {
  const source = __container_options(options);
  const state = { aborted: false, settled: false, completed: false, headers: [] };
  const token = source.cancelToken || (name + "-" + (__container_api_id + 1));
  const callback = {
    success: typeof source.success === "function" ? source.success : null,
    fail: typeof source.fail === "function" ? source.fail : null,
    complete: typeof source.complete === "function" ? source.complete : null
  };
  const forwarded = {};
  Object.keys(source).forEach(function(key) { forwarded[key] = source[key]; });
  forwarded.cancelToken = token;
  if (name === "wx.request" && typeof ArrayBuffer !== "undefined" &&
      (forwarded.data instanceof ArrayBuffer || (ArrayBuffer.isView && ArrayBuffer.isView(forwarded.data)))) {
    forwarded.data = __container_sync_bytes(forwarded.data);
    forwarded.dataEncoding = "bytes";
  }
  forwarded.success = function(result) {
    if (state.aborted || state.settled) return;
    state.settled = true;
    const header = result && result.header ? { header: __container_clone(result.header) } : { header: {} };
    state.headers.slice().forEach(function(listener) {
      try { listener(header); } catch (error) { __container_report_error(error); }
    });
    if (callback.success) {
      try { callback.success(result); } catch (error) { __container_report_error(error); }
    }
  };
  forwarded.fail = function(error) {
    if (state.aborted || state.settled) return;
    state.settled = true;
    if (callback.fail) {
      try { callback.fail(error); } catch (callbackError) { __container_report_error(callbackError); }
    }
  };
  forwarded.complete = function(result) {
    if (state.aborted || state.completed) return;
    state.completed = true;
    if (callback.complete) {
      try { callback.complete(result); } catch (error) { __container_report_error(error); }
    }
  };
  let task;
  function attach(base) {
    task = base;
    task.abort = function() {
      if (state.aborted || state.completed) return;
      state.aborted = true;
      state.settled = true;
      const error = { errMsg: name + ":fail abort", code: "ERR_CANCELLED", api: name };
      __container_errors.push(error);
      __container_events.push({ type: "api.cancel", name: name, cancelToken: token });
      Promise.resolve().then(function() {
        try { if (callback.fail) callback.fail(error); } catch (failure) { __container_report_error(failure); }
        try { if (!state.completed && callback.complete) callback.complete(error); } catch (completion) { __container_report_error(completion); }
        state.completed = true;
      });
    };
    task.onHeadersReceived = function(listener) {
      if (typeof listener === "function" && state.headers.indexOf(listener) < 0) state.headers.push(listener);
      return task;
    };
    task.offHeadersReceived = function(listener) {
      if (typeof listener !== "function") state.headers.splice(0, state.headers.length);
      else {
        const index = state.headers.indexOf(listener);
        if (index >= 0) state.headers.splice(index, 1);
      }
      return task;
    };
    return task;
  }
  if (__container_capability(name) === "unsupported") {
    const error = __container_error(name, "unsupported");
    state.settled = true;
    state.completed = true;
    return attach(__container_async_result(source, null, error));
  }
  return attach(__container_api_call(name, forwarded));
}
globalThis.wx = {
  canIUse: function(name) { return __container_capability(String(name)) !== "unsupported"; },
  createSelectorQuery: __container_selector_query,
  createIntersectionObserver: __container_intersection_observer,
  createMediaQueryObserver: __container_media_query_observer,
  createCanvasContext: __container_canvas_context,
  createInnerAudioContext: __container_create_inner_audio_context,
  createVideoContext: __container_create_video_context,
  createAudioContext: __container_create_audio_context,
  createCameraContext: __container_create_camera_context,
  connectSocket: __container_connect_socket,
  request: function(options) { return __container_network_task("wx.request", options); },
  uploadFile: function(options) { return __container_network_task("wx.uploadFile", options); },
  downloadFile: function(options) { return __container_network_task("wx.downloadFile", options); },
  createOffscreenCanvas: __container_create_offscreen_canvas,
  createAnimation: __container_create_animation,
  getSystemInfoSync: function() { return __container_sync_api("wx.getSystemInfoSync"); },
  getAppBaseInfo: function() { return __container_sync_api("wx.getAppBaseInfo"); },
  getDeviceInfo: function() { return __container_sync_api("wx.getDeviceInfo"); },
  getWindowInfo: function() { return __container_sync_api("wx.getWindowInfo"); },
  getSystemSetting: function() { return __container_sync_api("wx.getSystemSetting"); },
  getMenuButtonBoundingClientRect: function() { return __container_sync_api("wx.getMenuButtonBoundingClientRect"); },
  getAccountInfoSync: function() { return __container_sync_api("wx.getAccountInfoSync"); },
  arrayBufferToBase64: __container_array_buffer_to_base64,
  base64ToArrayBuffer: __container_base64_to_array_buffer,
  getExtConfigSync: function() { return __container_sync_api("wx.getExtConfigSync"); },
  getAppAuthorizeSetting: function() { return __container_sync_api("wx.getAppAuthorizeSetting"); },
  getLaunchOptionsSync: function() { return __container_sync_api("wx.getLaunchOptionsSync"); },
  getEnterOptionsSync: function() { return __container_sync_api("wx.getEnterOptionsSync"); },
  getBatteryInfoSync: function() { return __container_sync_api("wx.getBatteryInfoSync"); },
  getFileSystemManager: function() {
    const manager = {};
    ["readFile", "writeFile", "access", "unlink", "readdir", "removeSavedFile", "saveFile"].forEach(function(method) {
      manager[method] = function(options) {
        const name = method === "removeSavedFile" || method === "saveFile" ? "wx." + method : "wx.fs." + method;
        const capability = __container_capability(name);
        if (capability === "unsupported") {
          const error = __container_error(name, "unsupported");
          const callback = __container_options(options);
          Promise.resolve().then(function() {
            if (typeof callback.fail === "function") callback.fail(error);
            if (typeof callback.complete === "function") callback.complete(error);
          });
          return Promise.reject(error);
        }
        return __container_api_call(name, options);
      };
    });
    manager.readFileSync = function(filePath, encoding) {
      if (filePath && typeof filePath === "object") return __container_sync_file("wx.fs.readFileSync", filePath);
      return __container_sync_file("wx.fs.readFileSync", filePath, undefined, encoding);
    };
    manager.writeFileSync = function(filePath, data, encoding) {
      if (filePath && typeof filePath === "object") return __container_sync_file("wx.fs.writeFileSync", filePath);
      return __container_sync_file("wx.fs.writeFileSync", filePath, data, encoding);
    };
    manager.accessSync = function(filePath) {
      if (filePath && typeof filePath === "object") return __container_sync_file("wx.fs.accessSync", filePath);
      return __container_sync_file("wx.fs.accessSync", filePath);
    };
    manager.unlinkSync = function(filePath) {
      if (filePath && typeof filePath === "object") return __container_sync_file("wx.fs.unlinkSync", filePath);
      return __container_sync_file("wx.fs.unlinkSync", filePath);
    };
    manager.readdirSync = function(dirPath) {
      if (dirPath && typeof dirPath === "object") return __container_sync_file("wx.fs.readdirSync", dirPath);
      return __container_sync_file("wx.fs.readdirSync", { dirPath: dirPath });
    };
    return manager;
  },
  navigateTo: function(options) { return __container_navigation("wx.navigateTo", options); },
  redirectTo: function(options) { return __container_navigation("wx.redirectTo", options); },
  navigateBack: function(options) { return __container_navigation("wx.navigateBack", options); },
  reLaunch: function(options) { return __container_navigation("wx.reLaunch", options); },
  switchTab: function(options) { return __container_navigation("wx.switchTab", options); },
  preloadPage: function(options) { return __container_navigation("wx.preloadPage", options); },
  setNavigationBarTitle: function(options) { return __container_navigation("wx.setNavigationBarTitle", options); },
  onAppShow: function(callback) { return __container_add_app_listener("show", callback); },
  offAppShow: function(callback) { return __container_remove_app_listener("show", callback); },
  onAppHide: function(callback) { return __container_add_app_listener("hide", callback); },
  offAppHide: function(callback) { return __container_remove_app_listener("hide", callback); },
  // The shared private hub installs wx.onError/wx.offError after facade setup.
  onPageNotFound: function(callback) { return __container_page_not_found.add(callback); },
  offPageNotFound: function(callback) { return __container_page_not_found.remove(callback); },
  onNetworkStatusChange: function(callback) { return __container_add_network_status_listener(callback); },
  offNetworkStatusChange: function(callback) { return __container_remove_network_status_listener(callback); },
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
  shareAppMessage: function(options) { return __container_share("wx.shareAppMessage", options); },
  shareTimeline: function(options) { return __container_share("wx.shareTimeline", options); }
};
[
  "saveFile", "removeSavedFile", "getFileInfo", "getSavedFileInfo", "getSavedFileList", "getSystemInfo", "getSystemInfoAsync", "getBatteryInfo", "getScreenBrightness", "setScreenBrightness", "getExtConfig", "getNetworkType", "setClipboardData", "getClipboardData",
  "showToast", "hideToast", "showLoading", "hideLoading", "showModal", "showActionSheet", "pageScrollTo", "setNavigationBarColor",
  "setKeepScreenOn", "vibrateShort", "vibrateLong", "chooseMedia", "chooseImage", "getLocation", "startLocationUpdate", "stopLocationUpdate", "scanCode",
  "login", "checkSession", "getUserProfile", "authorize", "openSetting", "getSetting", "redirectToMiniProgram"
].forEach(function(name) {
  wx[name] = function(options) {
    const capability = __container_capability("wx." + name);
    if (capability === "unsupported") {
      const error = __container_error("wx." + name, "unsupported");
      return __container_async_result(__container_options(options), null, error);
    }
    return __container_api_call("wx." + name, options);
  };
});
wx.requestPayment = __container_request_payment;
function __container_add_app_listener(name, callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  const list = globalThis.__container_app_listeners[name];
  if (list && list.indexOf(callback) < 0) list.push(callback);
}
function __container_remove_app_listener(name, callback) {
  const list = globalThis.__container_app_listeners[name] || [];
  if (typeof callback !== "function") { list.splice(0, list.length); return; }
  const index = list.indexOf(callback);
  if (index >= 0) list.splice(index, 1);
}
function __container_dispatch_app_listeners(name, args) {
  if (name === "pageNotFound") return __container_page_not_found.dispatch(args);
  const list = (globalThis.__container_app_listeners[name] || []).slice();
  const values = [];
  list.forEach(function(callback) {
    try { values.push(__container_clone(callback.apply(globalThis, args || []))); }
    catch (error) { __container_report_error(error); }
  });
  if (list.length) __container_events.push({ type: "app.listener", name: name, count: list.length });
  return values;
}
function __container_add_network_status_listener(callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  const list = globalThis.__container_network_status_listeners;
  if (list.indexOf(callback) < 0) list.push(callback);
}
function __container_remove_network_status_listener(callback) {
  const list = globalThis.__container_network_status_listeners || [];
  if (typeof callback !== "function") { list.splice(0, list.length); return; }
  const index = list.indexOf(callback);
  if (index >= 0) list.splice(index, 1);
}
globalThis.__container_dispatch_network_status = function(status) {
  const value = __container_clone(status || {});
  const list = (globalThis.__container_network_status_listeners || []).slice();
  const results = [];
  list.forEach(function(callback) {
    try { results.push(__container_clone(callback(value))); }
    catch (error) { __container_report_error(error); }
  });
  __container_events.push({ type: "network.status.change", status: value, count: list.length });
  return results;
};
globalThis.__container_invoke_app = function(name, args) {
  const hook = globalThis.__container_app && globalThis.__container_app[name];
  if (typeof hook === "function") __container_log_manager.trace("lifecycle", "App." + name, args);
  const result = typeof hook === "function" ? hook.apply(globalThis.__container_app, args || []) : null;
  if (name === "onShow") __container_dispatch_app_listeners("show", args);
  if (name === "onHide") __container_dispatch_app_listeners("hide", args);
  return result;
};
globalThis.__container_invoke_page = function(index, name, args) {
  const page = __host_copy_page_array(__host_current_pages === null ? globalThis.__container_current_page_instances : __host_current_pages).reverse().find(function(candidate) {
    return candidate && candidate.__container_page_index === Number(index);
  }) || globalThis.__container_pages[index];
  if (name === "onUnload") __receiver_retire(page);
  try {
    const hook = page && page[name];
    if (typeof hook === "function") __container_log_manager.trace("lifecycle", "Page." + name, args);
    return typeof hook === "function" ? __container_turn_scheduler.invokeOwned(page, hook, args) : null;
  } catch (error) {
    if (name !== "onUnload") throw error;
    return __container_lifecycle_notifications.pageUnloadError(error);
  } finally { if (name === "onUnload") {
    try { __container_release_observers(page, __container_observer_identity(page)); }
    finally { __container_event_channels.retire(page); }
  } }
};
globalThis.__container_invoke_page_instance = function(instanceId, index, name, args) {
  const page = __container_lifecycle_notifications.pageForHook(instanceId, index);
  if (name === "onUnload") __receiver_retire(page);
  try {
    const hook = page && page[name];
    if (typeof hook === "function") __container_log_manager.trace("lifecycle", "Page." + name, args);
    return typeof hook === "function" ? __container_turn_scheduler.invokeOwned(page, hook, args) : null;
  } catch (error) {
    if (name !== "onUnload") throw error;
    return __container_lifecycle_notifications.pageUnloadError(error);
  } finally { if (name === "onUnload") {
    try { __container_release_observers(page, __container_observer_identity(page)); }
    finally { __container_event_channels.retire(page); }
  } }
};
globalThis.__container_invoke_page_event = function(index, event, rethrowHandlerError) {
  const page = __host_copy_page_array(__host_current_pages === null ? globalThis.__container_current_page_instances : __host_current_pages).reverse().find(function(candidate) {
    return candidate && candidate.__container_page_index === Number(index);
  }) || globalThis.__container_pages[index];
  return __container_dispatch_owned_event(page, event, false, rethrowHandlerError);
};
function __container_component_snapshot_value(component) {
  const value = __host_create(null);
  // Capture before any data clone/toJSON/getter. A later mutation, including
  // a call-return microtask, cannot be claimed by this snapshot's receipt.
  const inputIdentity = __receiver_component_input(component);
  const instanceToken = inputIdentity && inputIdentity.instanceToken;
  const mutationRevision = inputIdentity && inputIdentity.mutationRevision;
  value.inputIdentity = inputIdentity ? {__proto__:null,instanceToken:instanceToken,mutationRevision:mutationRevision} : null;
  value.data = __container_clone(component.data || {});
  value.properties = __container_clone(component.properties || {});
  value.created = !!component.__container_created_lifecycle;
  value.attached = !!component.__container_attached_lifecycle;
  value.ready = !!component.__container_ready_lifecycle;
  value.detached = !!component.__container_detached_lifecycle;
  value.mounted = !!component.__container_attached_lifecycle && !component.__container_detached_lifecycle;
  value.lifecycle = (component.__container_lifecycle || []).slice();
  value.observed = __container_clone(component.observed);
  return __receiver_record_component_snapshot(component, value, instanceToken, mutationRevision, inputIdentity && inputIdentity.writeSnapshot);
}
function __container_component_scope(value, nullable) {
  return nullable && value == null || typeof value === "string" && value.trim().length > 0;
}
globalThis.__container_reconcile_components = function(batch) {
  if (!batch || batch.version !== 1 || ["prepare", "attach", "ready", "dispose", "publish"].indexOf(batch.phase) < 0
      || !(typeof batch.pageId === "string" && batch.pageId.trim() || Number.isSafeInteger(batch.pageId) && batch.pageId >= 0)
      || !Array.isArray(batch.instances) || !Array.isArray(batch.remove || [])
      || batch.selectionNodes !== undefined && !Array.isArray(batch.selectionNodes)) {
    throw __container_component_protocol_error("invalid managed component batch");
  }
  const removals = batch.remove || [];
  if (removals.some(function(scopeId) { return !__container_component_scope(scopeId, false); })) {
    throw __container_component_protocol_error("invalid component removal scope");
  }
  const seen = Object.create(null);
  const selectionOrders = Object.create(null);
  const records = batch.instances.map(function(record) {
    if (!record || typeof record !== "object" || !__container_component_scope(record.scopeId, false) || seen[record.scopeId]) {
      throw __container_component_protocol_error("component scopes must be unique nonempty strings");
    }
    seen[record.scopeId] = true;
    if (batch.phase === "dispose") return { scopeId: record.scopeId };
    if (typeof record.moduleId !== "string" || !record.moduleId.trim()
        || !__container_component_scope(record.parentScopeId, true) || !__container_component_scope(record.ownerScopeId, true)
        || !record.properties || typeof record.properties !== "object" || Array.isArray(record.properties)) {
      throw __container_component_protocol_error("invalid managed component instance record");
    }
    const definitions = __container_component_module_definitions[record.moduleId];
    if (!__container_managed_component_modules[record.moduleId] || !Array.isArray(definitions) || definitions.length !== 1) {
      throw __container_component_protocol_error("component module must resolve exactly one definition: " + record.moduleId, "ERR_MODULE_LOAD");
    }
    const definition = __container_components[definitions[0]];
    if (!definition || !definition.__container_is_component_definition) {
      throw __container_component_protocol_error("component definition is unavailable: " + record.moduleId, "ERR_MODULE_LOAD");
    }
    const incoming = Object.create(null);
    const descriptors = definition.__container_property_descriptors || {};
    Object.keys(record.properties).forEach(function(name) {
      const normalized = Object.prototype.hasOwnProperty.call(descriptors, name) ? name
        : name.replace(/-([a-z])/g, function(_, character) { return character.toUpperCase(); });
      if (!Object.prototype.hasOwnProperty.call(descriptors, normalized)) return;
      if (!__container_path_parts(normalized)) throw __container_component_protocol_error("invalid component property name: " + name);
      if (Object.prototype.hasOwnProperty.call(incoming, normalized)) throw __container_component_protocol_error("duplicate component property binding: " + normalized);
      incoming[normalized] = __container_clone(record.properties[name]);
    });
    const existing = __container_component_scopes[record.scopeId];
    if (existing && removals.indexOf(record.scopeId) < 0
        && (existing.__container_module_id !== record.moduleId || String(existing.__container_page_id) !== String(batch.pageId))) {
      throw __container_component_protocol_error("component scope cannot change its module or page");
    }
    if (batch.phase !== "prepare" && (!existing || removals.indexOf(record.scopeId) >= 0)) {
      throw __container_component_protocol_error("component scope is unavailable: " + record.scopeId);
    }
    if (record.parentScopeId === record.scopeId || record.ownerScopeId === record.scopeId) {
      throw __container_component_protocol_error("component cannot be its own parent or owner");
    }
    const selection = __container_component_selection_metadata(record.selection);
    if (selection) {
      if (selectionOrders[selection.order]) throw __container_component_selection_error("component selection order must be unique");
      selectionOrders[selection.order] = true;
    }
    return { record: record, definition: definition, incoming: incoming, selection: selection };
  });
  if (batch.phase === "dispose") {
    const scopes = records.map(function(record) { return record.scopeId; }).concat(removals);
    return { instances: __container_dispose_component_scopes(scopes, batch.pageId),
      acknowledgedScopeIds: Array.from(new Set(scopes)) };
  }
  // Validate every mapping and property path before creating occurrences or
  // running any user hook. Child records may reference a parent in this batch.
  records.forEach(function(entry) {
    [entry.record.parentScopeId, entry.record.ownerScopeId].forEach(function(scopeId) {
      if (scopeId == null) return;
      const existing = __container_component_scopes[scopeId];
      if (!seen[scopeId] && (!existing || removals.indexOf(scopeId) >= 0 || String(existing.__container_page_id) !== String(batch.pageId))) {
        throw __container_component_protocol_error("component parent or owner scope is unavailable: " + scopeId);
      }
    });
  });
  __container_validate_component_relation_records(records, batch.pageId);
  let selectionNodes;
  if (batch.phase === "prepare" || batch.phase === "publish") {
    const selectionScopes = Object.create(null);
    const selectionOrders = Object.create(null);
    const recordsByScope = Object.create(null);
    records.forEach(function(entry) { recordsByScope[entry.record.scopeId] = entry; });
    if (batch.phase === "publish" && removals.length) throw __container_component_selection_error("selection publication cannot remove instances");
    const sourceNodes = batch.selectionNodes === undefined ? records.filter(function(entry) { return !!entry.selection; }).map(function(entry) {
      return { ownerScopeId: entry.record.ownerScopeId == null ? null : entry.record.ownerScopeId,
        componentScopeId: entry.record.scopeId, selection: entry.selection };
    }) : batch.selectionNodes;
    selectionNodes = sourceNodes.map(function(node) {
      if (!node || typeof node !== "object" || Array.isArray(node)
          || !__container_component_scope(node.ownerScopeId, true) || !__container_component_scope(node.componentScopeId, true)) {
        throw __container_component_selection_error("invalid component selection tree node");
      }
      const selection = __container_component_selection_metadata(node.selection);
      if (!selection || selectionOrders[selection.order]) throw __container_component_selection_error("selection tree orders must be unique");
      selectionOrders[selection.order] = true;
      const ownerScope = node.ownerScopeId == null ? null : node.ownerScopeId;
      const componentScope = node.componentScopeId == null ? null : node.componentScopeId;
      if (ownerScope !== null && !seen[ownerScope]) throw __container_component_selection_error("selection owner is outside the page frontier");
      if (componentScope !== null) {
        const entry = recordsByScope[componentScope];
        if (!entry || selectionScopes[componentScope] || ownerScope !== (entry.record.ownerScopeId == null ? null : entry.record.ownerScopeId)
            || JSON.stringify(entry.selection) !== JSON.stringify(selection)) {
          throw __container_component_selection_error("selection component must map exactly to one matching instance record");
        }
        selectionScopes[componentScope] = true;
      }
      return { ownerScopeId: ownerScope, componentScopeId: componentScope, selection: selection };
    });
    records.forEach(function(entry) {
      if (entry.selection && !selectionScopes[entry.record.scopeId]) throw __container_component_selection_error("component host is missing from selection tree");
    });
    selectionNodes.sort(function(left, right) { return left.selection.order - right.selection.order; });
  }
  const eventGraph = batch.phase === "prepare" || batch.phase === "publish"
    ? __container_prepare_component_event_batch(batch, records.map(function(entry) { return entry.record; })) : undefined;
  if (batch.phase === "prepare") __container_dispose_component_scopes(removals, batch.pageId);
  __container_publish_component_event_batch(batch, eventGraph);
  records.forEach(function(entry) {
    const record = entry.record;
    let instance = __container_component_scopes[record.scopeId];
    if (batch.phase === "prepare" || batch.phase === "publish") {
      if (!instance) {
        instance = __container_clone_component_instance(entry.definition, {
          scopeId: record.scopeId, moduleId: record.moduleId, pageId: batch.pageId,
          parentScopeId: record.parentScopeId, ownerScopeId: record.ownerScopeId
        });
        __container_component_scopes[record.scopeId] = instance;
      }
      instance.__container_parent_scope_id = record.parentScopeId == null ? null : record.parentScopeId;
      instance.__container_owner_scope_id = record.ownerScopeId == null ? null : record.ownerScopeId;
      instance.__container_selection = entry.selection;
      if (entry.selection) instance.id = entry.selection.id;
    }
    if (batch.phase === "prepare") {
      // Parent bindings and component-local data have different ownership.
      // Re-rendering the same binding must not overwrite a component setData.
      const previous = instance.__container_bound_properties || Object.create(null);
      const incoming = entry.incoming;
      const patch = Object.create(null);
      Object.keys(previous).forEach(function(name) {
        if (!Object.prototype.hasOwnProperty.call(incoming, name)) {
          patch[name] = __container_clone(entry.definition.__container_definition_properties[name]);
        }
      });
      Object.keys(incoming).forEach(function(name) {
        if (!Object.prototype.hasOwnProperty.call(previous, name) || !__container_component_equal(previous[name], incoming[name])) {
          patch[name] = __container_clone(incoming[name]);
        }
      });
      instance.__container_bound_properties = incoming;
      __container_component_apply_patch(instance, patch, "property.update");
    } else if (batch.phase !== "publish") {
      __container_component_lifecycle(instance, batch.phase === "attach" ? "attached" : "ready", []);
    }
  });
  if (batch.phase === "prepare" || batch.phase === "publish") {
    // Preserve per-occurrence created/property observer order. Node selection
    // is published only once the frontier is complete, before attached hooks.
    if (selectionNodes.length) __container_component_selection_pages[String(batch.pageId)] = selectionNodes;
    else delete __container_component_selection_pages[String(batch.pageId)];
  }
  return { instances: records.map(function(entry) {
    const instance = __container_component_scopes[entry.record.scopeId];
    return { scopeId: entry.record.scopeId, index: instance.__container_component_index, snapshot: __container_component_snapshot_value(instance) };
  }) };
};
globalThis.__container_invoke_component_page_lifetimes = function(batch) {
  if (!batch || batch.version !== 1 || ["show", "hide", "resize"].indexOf(batch.name) < 0
      || !(typeof batch.pageId === "string" && batch.pageId.trim() || Number.isSafeInteger(batch.pageId) && batch.pageId >= 0)
      || !Array.isArray(batch.args) || !Array.isArray(batch.scopeIds)) {
    throw __container_component_protocol_error("invalid component page lifetime batch");
  }
  const seen = Object.create(null);
  const instances = batch.scopeIds.map(function(scopeId) {
    if (!__container_component_scope(scopeId, false) || seen[scopeId]) {
      throw __container_component_protocol_error("component page lifetime scopes must be unique nonempty strings");
    }
    seen[scopeId] = true;
    const instance = __container_component_scopes[scopeId];
    if (instance && String(instance.__container_page_id) !== String(batch.pageId)) {
      throw __container_component_protocol_error("component page lifetime scope belongs to another page");
    }
    return instance;
  });
  // Validate the whole batch before invoking user code. Disposed scopes and
  // occurrences that have not attached cannot receive page notifications.
  const result = [];
  instances.forEach(function(instance) {
    if (!instance || instance.__container_disposed || !instance.__container_attached_lifecycle
        || instance.__container_detached_lifecycle) return;
    let invoke = true;
    if (batch.name === "show") {
      invoke = instance.__container_page_visible !== true;
      instance.__container_page_visible = true;
    } else if (batch.name === "hide") {
      invoke = instance.__container_page_visible === true;
      instance.__container_page_visible = false;
    }
    // Consume the transition before the callback, including throws/re-entry.
    // Ordinary methods named show/hide/resize are never lifecycle handlers.
    const hook = instance.pageLifetimes && instance.pageLifetimes[batch.name];
    if (invoke && typeof hook === "function") {
      try { hook.apply(instance, batch.args); }
      catch (error) { __container_report_error(error); }
    }
    result.push({ scopeId: instance.__container_scope_id, index: instance.__container_component_index,
      snapshot: __container_component_snapshot_value(instance) });
  });
  return { instances: result };
};
globalThis.__container_invoke_component = function(index, name, args) {
  const component = globalThis.__container_components[index];
  if (!component) return null;
  if (["created", "attached", "ready", "moved", "detached", "error"].indexOf(name) >= 0) {
    return __container_component_lifecycle(component, name, args || []);
  }
  const hook = component[name] || (component.methods && component.methods[name]);
  const pageHook = component.pageLifetimes && component.pageLifetimes[name];
  const selected = typeof hook === "function" ? hook : pageHook;
  return typeof selected === "function" ? __container_turn_scheduler.invokeOwned(component, selected, args) : null;
};
globalThis.__container_mount_component = function(index, properties) {
  const component = globalThis.__container_components[Number(index)];
  if (!component) throw new Error("component instance not found");
  const changes = __container_component_apply_patch(component, properties || {}, "mount");
  __container_component_lifecycle(component, "attached", []);
  __container_component_lifecycle(component, "ready", []);
  return { index: component.__container_component_index, changes: changes, snapshot: __container_component_snapshot_value(component) };
};
globalThis.__container_update_component = function(index, properties) {
  const component = globalThis.__container_components[Number(index)];
  if (!component) throw new Error("component instance not found");
  const changes = __container_component_apply_patch(component, properties || {}, "property.update");
  return { index: component.__container_component_index, changes: changes, snapshot: __container_component_snapshot_value(component) };
};
globalThis.__container_unmount_component = function(index) {
  const component = globalThis.__container_components[Number(index)];
  if (!component) throw new Error("component instance not found");
  const result = __container_component_lifecycle(component, "detached", []);
  return { index: component.__container_component_index, detached: result, snapshot: __container_component_snapshot_value(component) };
};
globalThis.__container_move_component = function(index) {
  const component = globalThis.__container_components[Number(index)];
  if (!component) throw new Error("component instance not found");
  const moved = __container_component_lifecycle(component, "moved", []);
  return { index: component.__container_component_index, moved: moved, snapshot: __container_component_snapshot_value(component) };
};
globalThis.__container_component_snapshot = function(index) {
  const component = globalThis.__container_components[Number(index)];
  return component ? __container_component_snapshot_value(component) : null;
};
globalThis.__container_registration_snapshot = function() {
  return { app: !!globalThis.__container_app,
    pages: globalThis.__container_pages.length,
    components: globalThis.__container_components.length };
};
globalThis.__container_capability_snapshot = function() { return __container_capabilities; };
"##;

/// Whether this crate was compiled with the real rusty_v8 provider. Hosts can
/// use this at startup when deciding whether a manifest requesting V8 is
/// admissible; the value is compile-time and never reports a stub as native.
pub const fn native_provider_compiled() -> bool {
    cfg!(feature = "v8-native")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V8Config {
    pub heap_limit_bytes: Option<usize>,
}

impl Default for V8Config {
    fn default() -> Self {
        Self {
            heap_limit_bytes: Some(128 * 1024 * 1024),
        }
    }
}

#[cfg(feature = "v8-native")]
struct HostEnvironmentTransports {
    batch_call: v8::Global<v8::Function>,
    installer: v8::Global<v8::Function>,
    incarnations: v8::Global<v8::Function>,
    event_factory: v8::Global<v8::Function>,
    channel_binding: v8::Global<v8::Function>,
    lifecycle_notification: v8::Global<v8::Function>,
    route_notification: v8::Global<v8::Function>,
    rejection_collector: v8::Global<v8::Function>,
    flush_rejections: v8::Global<v8::Function>,
}

#[cfg(feature = "v8-native")]
struct NativePromiseRejections {
    collector: Option<v8::Global<v8::Function>>,
    failed: std::cell::Cell<bool>,
}

// The slot holds only an address into NativeV8's stable boxed owner. NativeV8
// remains thread-affine; no callback or Global is shared with another Session.
#[cfg(feature = "v8-native")]
struct PromiseRejectionSlot(usize);

/// The native provider is kept behind a feature so the portable workspace can
/// build without downloading a V8 archive. Each JS turn holds a scoped isolate
/// lock, allowing a validated development candidate to coexist with the active
/// session and either instance to be disposed independently. The adapter stays
/// thread-affine even though V8's shared isolate supports cross-thread locking.
#[cfg(feature = "v8-native")]
struct NativeV8 {
    batch_call: Option<v8::Global<v8::Function>>,
    host_environment: Option<v8::Global<v8::Function>>,
    receiver_incarnations: Option<v8::Global<v8::Function>>,
    receiver_event: Option<v8::Global<v8::Function>>,
    event_channel_binding: Option<v8::Global<v8::Function>>,
    lifecycle_notification: Option<v8::Global<v8::Function>>,
    route_notification: Option<v8::Global<v8::Function>>,
    flush_rejections: Option<v8::Global<v8::Function>>,
    promise_rejections: Box<NativePromiseRejections>,
    context: v8::Global<v8::Context>,
    isolate: v8::SharedIsolate,
    modules: std::collections::BTreeMap<u64, String>,
    sync_host_api: Option<Box<std::sync::Arc<dyn container_core::SyncHostApi>>>,
    // Stable callback data; declared after the isolate so it outlives its VM.
    api_delivery_provider: Box<container_core::ApiDeliveryProviderSlot>,
    performance_origin: Box<std::time::Instant>,
    performance_lifetime: std::sync::Arc<container_core::PerformanceLifetime>,
    // Box keeps the Arc handle itself at a stable address for V8 External
    // callbacks; the extra allocation is intentional and scoped here.
    #[allow(clippy::redundant_allocation)]
    log_manager: Box<std::sync::Arc<container_core::LogManagerJournal>>,
    #[allow(clippy::redundant_allocation)]
    buffer_urls: Box<std::sync::Arc<container_core::BufferUrlStore>>,
    terminal_resources: std::sync::Arc<container_core::EngineTerminalResources>,
    route_rewrite: std::rc::Rc<container_core::RouteRewriteSlot>,
    _owner: std::marker::PhantomData<std::rc::Rc<()>>,
}

#[cfg(feature = "v8-native")]
impl Drop for NativeV8 {
    fn drop(&mut self) {
        self.terminal_resources.retire();
        let mut isolate = self.isolate.lock();
        isolate.set_promise_reject_callback(Self::ignore_promise_rejection);
        isolate.remove_slot::<PromiseRejectionSlot>();
        isolate.remove_slot::<std::sync::Arc<container_core::EngineTerminalResources>>();
        self.promise_rejections.collector = None;
    }
}

#[cfg(feature = "v8-native")]
impl fmt::Debug for NativeV8 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NativeV8")
            .field("modules", &self.modules.len())
            .field(
                "terminating",
                &self.isolate.thread_safe_handle().is_execution_terminating(),
            )
            .finish()
    }
}

#[derive(Debug)]
#[cfg_attr(not(feature = "v8-native"), derive(Clone, PartialEq, Eq))]
pub struct V8Engine {
    config: V8Config,
    loaded_modules: usize,
    interrupted: bool,
    #[cfg(feature = "v8-native")]
    deferred_storage_commit: bool,
    #[cfg(feature = "v8-native")]
    native: Option<NativeV8>,
}

pub trait JsEngineAdapter {
    fn engine_name(&self) -> &'static str;
    fn mode(&self) -> EngineMode;
    fn load_module_batch(&mut self, modules: &[&[u8]]) -> Result<usize, EngineError>;
    fn interrupt(&mut self);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    EmptyModule,
    InvalidUtf8,
    Interrupted,
    NativeBackendUnavailable,
    Runtime(String),
    Execution(container_core::EngineError),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyModule => f.write_str("module batch contains an empty module"),
            Self::InvalidUtf8 => f.write_str("module is not valid UTF-8"),
            Self::Interrupted => f.write_str("engine execution was interrupted"),
            Self::NativeBackendUnavailable => {
                f.write_str("V8 native backend is unavailable in this build")
            }
            Self::Runtime(message) => write!(f, "V8 runtime error: {message}"),
            Self::Execution(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for EngineError {}

// Storage admission permits a value at depth 128; its diagnostic effect adds
// envelope containers. Bound native JSON before using serde's recursive parser
// with its default 128-container restriction disabled. This changes only the
// depth budget; native result bytes/nodes retain their existing contract.
#[cfg(feature = "v8-native")]
fn decode_native_result_json(encoded: &str) -> Result<serde_json::Value, String> {
    let (mut quoted, mut escaped, mut nesting) = (false, false, 0usize);
    for byte in encoded.bytes() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'[' | b'{' => {
                    nesting += 1;
                    if nesting > 256 {
                        return Err("native result JSON nesting exceeds 256 containers".into());
                    }
                }
                b']' | b'}' => {
                    nesting = nesting
                        .checked_sub(1)
                        .ok_or("invalid native result JSON nesting")?;
                }
                _ => {}
            }
        }
    }
    let mut decoder = serde_json::Deserializer::from_str(encoded);
    decoder.disable_recursion_limit();
    let mut values = decoder.into_iter::<serde_json::Value>();
    let value = values
        .next()
        .ok_or("native result JSON is empty")?
        .map_err(|error| error.to_string())?;
    if let Some(trailing) = values.next() {
        return Err(match trailing {
            Ok(_) => "native result JSON has a trailing value".into(),
            Err(error) => error.to_string(),
        });
    }
    Ok(value)
}
// Read native termination while the TryCatch still owns its exception. V8's
// isolate-level flag is transient and may be reset when that scope unwinds.
#[cfg(feature = "v8-native")]
fn native_transport_error(
    scope: &v8::PinnedRef<'_, v8::TryCatch<v8::HandleScope>>,
    message: &str,
) -> container_core::EngineError {
    if scope.has_terminated() || scope.is_execution_terminating() {
        if let Some(resources) =
            scope.get_slot::<std::sync::Arc<container_core::EngineTerminalResources>>()
        {
            resources.retire();
        }
        container_core::EngineError::new(
            container_core::EngineErrorCode::Interrupted,
            "V8 was interrupted",
        )
    } else {
        container_core::EngineError::new(container_core::EngineErrorCode::Call, message)
    }
}

#[cfg(feature = "v8-native")]
fn latch_native_control_result<T>(
    interrupted: &mut bool,
    result: Result<T, container_core::EngineError>,
) -> Result<T, container_core::EngineError> {
    if matches!(&result, Err(error) if error.code == container_core::EngineErrorCode::Interrupted) {
        *interrupted = true;
    }
    result
}

impl EngineError {
    /// Preserve execution-control failures across the legacy adapter API.
    pub fn into_core_error(self) -> container_core::EngineError {
        match self {
            Self::Execution(error) => error,
            Self::Interrupted => container_core::EngineError::new(
                container_core::EngineErrorCode::Interrupted,
                "V8 was interrupted",
            ),
            Self::EmptyModule | Self::InvalidUtf8 => container_core::EngineError::new(
                container_core::EngineErrorCode::ModuleLoad,
                self.to_string(),
            ),
            other => container_core::EngineError::new(
                container_core::EngineErrorCode::Call,
                other.to_string(),
            ),
        }
    }
}

impl V8Engine {
    pub fn buffer_url_store(&self) -> Option<std::sync::Arc<container_core::BufferUrlStore>> {
        #[cfg(feature = "v8-native")]
        {
            self.native
                .as_ref()
                .map(|native| native.buffer_urls.as_ref().clone())
        }
        #[cfg(not(feature = "v8-native"))]
        {
            None
        }
    }

    /// Poll the bootstrap-private next-turn queue. Only a native monotonic
    /// deadline can admit idle work; guest globals never select this driver.
    #[cfg(feature = "v8-native")]
    pub fn poll_turn_scheduler(
        &mut self,
        idle_deadline: Option<TurnSchedulerInstant>,
    ) -> Result<(), container_core::EngineError> {
        self.poll_turn_scheduler_within_turn(idle_deadline)
    }

    #[cfg(feature = "v8-native")]
    fn poll_turn_scheduler_within_turn(
        &mut self,
        idle_deadline: Option<TurnSchedulerInstant>,
    ) -> Result<(), container_core::EngineError> {
        use container_core::JsEngine;
        self.drain_microtasks()?;
        let idle_budget = idle_deadline
            .map(|deadline| {
                deadline
                    .saturating_duration_since(TurnSchedulerInstant::now())
                    .as_secs_f64()
                    * 1000.0
            })
            .filter(|budget| *budget > 0.0)
            .map(|budget| budget.min(50.0));
        let begun = self
            .capture_receiver_transport(serde_json::json!({
                "kind":"turn-scheduler", "action":"begin", "limit":64,
                "idleBudgetMs":idle_budget
            }))
            .map_err(EngineError::into_core_error)?;
        if begun.get("begun") != Some(&serde_json::Value::Bool(true)) {
            return Err(container_core::EngineError::new(
                container_core::EngineErrorCode::Call,
                "scheduler begin returned an invalid result",
            ));
        }
        let tasks = (|| {
            for _ in 0..64 {
                // Recheck the absolute host deadline after every checkpoint.
                let allow_idle =
                    idle_deadline.is_some_and(|deadline| deadline > TurnSchedulerInstant::now());
                let result = self
                    .capture_receiver_transport(serde_json::json!({
                        "kind":"turn-scheduler", "action":"task", "allowIdle":allow_idle
                    }))
                    .map_err(EngineError::into_core_error)?;
                match result.get("called").and_then(serde_json::Value::as_bool) {
                    Some(true) => self.drain_microtasks()?,
                    Some(false) => return Ok(()),
                    None => {
                        return Err(container_core::EngineError::new(
                            container_core::EngineErrorCode::Call,
                            "scheduler task returned an invalid result",
                        ))
                    }
                }
            }
            Ok(())
        })();
        // A control fault is sticky: the retained transport checks it before
        // cleanup, so this cannot continue guest execution after interruption.
        let completed = self
            .capture_receiver_transport(serde_json::json!({
                "kind":"turn-scheduler", "action":"end"
            }))
            .map_err(EngineError::into_core_error);
        tasks?;
        let completed = completed?;
        if completed.get("ended") != Some(&serde_json::Value::Bool(true)) {
            return Err(container_core::EngineError::new(
                container_core::EngineErrorCode::Call,
                "scheduler end returned an invalid result",
            ));
        }
        Ok(())
    }
    fn drain_native_timer_tasks(
        &mut self,
        args: container_core::ValueBatch,
    ) -> Result<container_core::ValueBatch, container_core::EngineError> {
        use container_core::{CallTarget, JsEngine};

        // Freeze eligible timers only after the preceding task's jobs, and
        // enter a native microtask checkpoint after every timer callback.
        self.drain_microtasks()?;
        self.call(
            CallTarget::Global {
                name: "__container_timer_begin".into(),
            },
            args,
        )?;
        let tasks = (|| loop {
            let result = self.call(
                CallTarget::Global {
                    name: "__container_timer_task".into(),
                },
                vec![],
            )?;
            match result.as_slice() {
                [serde_json::Value::Bool(true)] => self.drain_microtasks()?,
                [serde_json::Value::Bool(false)] => return Ok(()),
                _ => {
                    return Err(container_core::EngineError::new(
                        container_core::EngineErrorCode::Call,
                        "timer task driver returned an invalid result",
                    ))
                }
            }
        })();
        // Always release the turn; a failed callback/checkpoint must not
        // strand the remaining timer queue behind an active-turn marker.
        let completed = self.call(
            CallTarget::Global {
                name: "__container_timer_end".into(),
            },
            vec![],
        );
        tasks?;
        completed
    }

    pub fn new(config: V8Config) -> Self {
        #[cfg(feature = "v8-native")]
        let native = NativeV8::new(&config);

        Self {
            config,
            loaded_modules: 0,
            interrupted: false,
            #[cfg(feature = "v8-native")]
            deferred_storage_commit: false,
            #[cfg(feature = "v8-native")]
            native,
        }
    }

    pub fn config(&self) -> &V8Config {
        &self.config
    }

    /// Register a factory without running application code. All dependencies
    /// must be registered before the first root is evaluated.
    pub fn register_module_with_id(
        &mut self,
        manifest_id: &str,
        module: &[u8],
        dependencies: &[String],
        esm: bool,
    ) -> Result<container_core::ModuleId, container_core::EngineError> {
        let source = std::str::from_utf8(module).map_err(|error| {
            container_core::EngineError::new(
                container_core::EngineErrorCode::ModuleLoad,
                format!("module is not UTF-8: {error}"),
            )
        })?;
        let number = self.loaded_modules.saturating_add(1);
        #[cfg(feature = "v8-native")]
        {
            self.install_host_environment_payload(serde_json::json!({
                "kind":"module-command", "operation":"register", "id":manifest_id,
                "number":number, "source":source, "dependencies":dependencies,
                "format":if esm { "esm" } else { "commonjs" },
            }))
            .map_err(EngineError::into_core_error)?;
            if let Some(native) = &mut self.native {
                native.modules.insert(number as u64, source.to_owned());
            }
            self.loaded_modules = number;
            Ok(container_core::ModuleId(number as u64))
        }
        #[cfg(not(feature = "v8-native"))]
        {
            let _ = (manifest_id, dependencies, esm, source, number);
            <Self as container_core::JsEngine>::load_module(self, module)
        }
    }

    pub fn evaluate_module_with_id(
        &mut self,
        manifest_id: &str,
    ) -> Result<(), container_core::EngineError> {
        #[cfg(feature = "v8-native")]
        {
            self.install_host_environment_payload(serde_json::json!({
                "kind":"module-command", "operation":"evaluate", "id":manifest_id,
            }))
            .map_err(EngineError::into_core_error)
        }
        #[cfg(not(feature = "v8-native"))]
        {
            let _ = manifest_id;
            Err(container_core::EngineError::new(
                container_core::EngineErrorCode::Call,
                EngineError::NativeBackendUnavailable.to_string(),
            ))
        }
    }

    /// Eager, atomic standalone load retained for existing embedders. Runtime
    /// batches use register/evaluate instead, with CommonJS dependency caches.
    pub fn load_module_with_id(
        &mut self,
        manifest_id: &str,
        module: &[u8],
    ) -> Result<container_core::ModuleId, container_core::EngineError> {
        if module.is_empty() {
            return <Self as container_core::JsEngine>::load_module(self, module);
        }
        let source = std::str::from_utf8(module).map_err(|error| {
            container_core::EngineError::new(
                container_core::EngineErrorCode::ModuleLoad,
                format!("module is not UTF-8: {error}"),
            )
        })?;
        #[cfg(feature = "v8-native")]
        {
            let number = self.loaded_modules.saturating_add(1);
            self.install_host_environment_payload(serde_json::json!({
                "kind":"module-command", "operation":"eager", "id":manifest_id,
                "number":number, "source":source,
            }))
            .map_err(EngineError::into_core_error)?;
            if let Some(native) = &mut self.native {
                native.modules.insert(number as u64, source.to_owned());
            }
            self.loaded_modules = number;
            Ok(container_core::ModuleId(number as u64))
        }
        #[cfg(not(feature = "v8-native"))]
        {
            let _ = (manifest_id, source);
            <Self as container_core::JsEngine>::load_module(self, module)
        }
    }

    pub fn performance_lifetime(
        &self,
    ) -> Option<std::sync::Arc<container_core::PerformanceLifetime>> {
        #[cfg(feature = "v8-native")]
        if let Some(native) = &self.native {
            return Some(native.performance_lifetime.clone());
        }
        None
    }

    pub fn loaded_module_count(&self) -> usize {
        self.loaded_modules
    }

    pub fn is_interrupted(&self) -> bool {
        self.interrupted
    }

    /// Drain host-visible effects produced by the JavaScript facade in one
    /// batch.  The shape deliberately matches the QuickJS adapter so the
    /// runtime can route navigation, API calls and setData through one
    /// bridge path for either engine.
    #[cfg(feature = "v8-native")]
    pub fn drain_host_events(&mut self) -> Result<container_core::ValueBatch, EngineError> {
        container_core::JsEngine::call(
            self,
            container_core::CallTarget::Global {
                name: "__container_drain_events".into(),
            },
            Vec::new(),
        )
        .map_err(EngineError::Execution)
    }

    #[cfg(feature = "v8-native")]
    pub fn enable_deferred_storage_commit(&mut self) -> Result<(), EngineError> {
        self.check_native_execution_state()?;
        if !self.deferred_storage_commit && self.loaded_modules != 0 {
            return Err(EngineError::Execution(container_core::EngineError::new(
                container_core::EngineErrorCode::Call,
                "storage commit ownership must be selected before module loading",
            )));
        }
        self.deferred_storage_commit = true;
        Ok(())
    }

    #[cfg(feature = "v8-native")]
    pub fn acknowledge_storage_transactions(&mut self, sequence: u64) -> Result<(), EngineError> {
        self.check_native_execution_state()?;
        let encoded = serde_json::to_string(
            &serde_json::json!({"kind":"storage-ack","sequence":sequence.to_string()}),
        )
        .map_err(|error| {
            EngineError::Execution(container_core::EngineError::new(
                container_core::EngineErrorCode::Call,
                error.to_string(),
            ))
        })?;
        let result = self
            .native
            .as_mut()
            .ok_or(EngineError::NativeBackendUnavailable)?
            .install_host_environment(&encoded, false);
        latch_native_control_result(&mut self.interrupted, result).map_err(EngineError::Execution)
    }

    #[cfg(feature = "v8-native")]
    pub fn dispatch_lifecycle_notification(
        &mut self,
        name: &str,
        payload: &serde_json::Value,
    ) -> Result<bool, EngineError> {
        self.check_native_execution_state()?;
        let encoded = serde_json::to_string(payload).map_err(|error| {
            EngineError::Execution(container_core::EngineError::new(
                container_core::EngineErrorCode::Call,
                error.to_string(),
            ))
        })?;
        let result = self
            .native
            .as_mut()
            .ok_or(EngineError::NativeBackendUnavailable)?
            .dispatch_lifecycle_notification(name, &encoded);
        latch_native_control_result(&mut self.interrupted, result).map_err(EngineError::Execution)
    }

    #[cfg(feature = "v8-native")]
    pub fn dispatch_route_notification(
        &mut self,
        name: &str,
        payload: &serde_json::Value,
        validator: Option<container_core::RouteRewriteValidator>,
    ) -> Result<bool, EngineError> {
        self.check_native_execution_state()?;
        let slot = self
            .native
            .as_ref()
            .ok_or(EngineError::NativeBackendUnavailable)?
            .route_rewrite
            .clone();
        let _lease = validator
            .map(|validator| slot.begin(validator))
            .transpose()
            .map_err(|error| {
                EngineError::Execution(container_core::EngineError::new(
                    container_core::EngineErrorCode::Call,
                    error.message,
                ))
            })?;
        let encoded = serde_json::to_string(payload).map_err(|error| {
            EngineError::Execution(container_core::EngineError::new(
                container_core::EngineErrorCode::Call,
                error.to_string(),
            ))
        })?;
        let result = self
            .native
            .as_mut()
            .ok_or(EngineError::NativeBackendUnavailable)?
            .dispatch_route_notification(name, &encoded);
        latch_native_control_result(&mut self.interrupted, result).map_err(EngineError::Execution)
    }

    /// Capture accepted storage intent without public effects or a checkpoint.
    pub fn pending_storage_transactions(&mut self) -> Result<serde_json::Value, EngineError> {
        #[cfg(feature = "v8-native")]
        {
            self.capture_receiver_transport(serde_json::json!({"kind":"storage-pending"}))
        }
        #[cfg(not(feature = "v8-native"))]
        {
            Err(EngineError::NativeBackendUnavailable)
        }
    }

    #[cfg(feature = "v8-native")]
    fn check_native_execution_state(&mut self) -> Result<(), EngineError> {
        if self.interrupted
            || self.native.as_ref().is_some_and(|native| {
                native
                    .isolate
                    .thread_safe_handle()
                    .is_execution_terminating()
            })
        {
            self.interrupted = true;
            if let Some(native) = &self.native {
                native.terminal_resources.retire();
            }
            return Err(EngineError::Execution(container_core::EngineError::new(
                container_core::EngineErrorCode::Interrupted,
                "V8 was interrupted",
            )));
        }
        Ok(())
    }

    /// Run callbacks whose logical deadline has elapsed.  Hosts own the
    /// clock and pass safe-integer Unix milliseconds, keeping behavior deterministic in
    /// native V8 tests and production event loops alike.
    #[cfg(feature = "v8-native")]
    pub fn drain_timers(&mut self, now_ms: u64) -> Result<container_core::ValueBatch, EngineError> {
        container_core::JsEngine::call(
            self,
            container_core::CallTarget::Global {
                name: "__container_drain_timers".into(),
            },
            vec![serde_json::json!(now_ms)],
        )
        .map_err(EngineError::Execution)
    }

    /// Complete environment installation uses native JSON parsing and the
    /// bootstrap-retained function, without an application job checkpoint.
    /// Read only identities registered by actual receiver creation. This uses
    /// the existing isolate/interrupt state without draining application jobs.
    #[cfg(feature = "v8-native")]
    pub fn capture_receiver_incarnations(
        &mut self,
        page_id: u64,
        scopes: &[String],
    ) -> Result<serde_json::Value, EngineError> {
        if scopes.len() > 100_000 {
            return Err(EngineError::Runtime(
                "receiver scope budget exceeded".into(),
            ));
        }
        self.capture_receiver_transport(
            serde_json::json!({"pageId":page_id.to_string(),"scopes":scopes}),
        )
    }

    /// Feature-only conformance receiver/result observation. The caller owns
    /// current Session/PageId/route admission and its irreversible invocation
    /// ledger. This transport inherits the host-turn budget, never drains jobs,
    /// and never looks up an application-writable global.
    #[cfg(all(feature = "v8-native", feature = "conformance-observation"))]
    pub fn observe_conformance_guest(
        &mut self,
        request: &container_core::ConformanceGuestRequest,
    ) -> Result<container_core::ConformanceGuestObservation, EngineError> {
        let value = self.capture_receiver_transport(serde_json::json!({
            "kind":"conformance-guest-method", "request":request
        }))?;
        serde_json::from_value(value).map_err(|error| EngineError::Runtime(error.to_string()))
    }

    /// Feature-only private exception interval. No public global/job checkpoint.
    #[cfg(all(feature = "v8-native", feature = "conformance-observation"))]
    pub fn observe_conformance_exceptions(
        &mut self,
        request: &container_core::ConformanceExceptionRequest,
    ) -> Result<container_core::ConformanceExceptionObservation, EngineError> {
        let value = self.capture_receiver_transport(serde_json::json!({
            "kind":"conformance-exceptions", "request":request
        }))?;
        serde_json::from_value(value).map_err(|error| EngineError::Runtime(error.to_string()))
    }

    /// Native-owned desired media state; no public queue or job checkpoint.
    #[cfg(feature = "v8-native")]
    pub fn capture_media_query_state(
        &mut self,
        revision: Option<u64>,
    ) -> Result<serde_json::Value, EngineError> {
        self.capture_receiver_transport(serde_json::json!({
            "kind":"media-query-state", "revision":revision.map(|value| value.to_string())
        }))
    }

    /// Native-owned desired intersection state; no public queue or job checkpoint.
    #[cfg(feature = "v8-native")]
    pub fn capture_intersection_query_state(
        &mut self,
        revision: Option<u64>,
    ) -> Result<serde_json::Value, EngineError> {
        self.capture_receiver_transport(serde_json::json!({
            "kind":"intersection-query-state", "revision":revision.map(|value| value.to_string())
        }))
    }

    #[cfg(feature = "v8-native")]
    pub fn capture_component_snapshot_receipts(
        &mut self,
        page_id: u64,
        scopes: &[String],
    ) -> Result<serde_json::Value, EngineError> {
        if scopes.len() > 100_000 {
            return Err(EngineError::Runtime(
                "component scope budget exceeded".into(),
            ));
        }
        self.capture_receiver_transport(serde_json::json!({"pageId":page_id.to_string(),"scopes":scopes,"componentSnapshots":true}))
    }

    /// Completed mutation data captured during its ordinary guest turn.
    #[cfg(feature = "v8-native")]
    pub fn capture_component_data_receipts(
        &mut self,
        page_id: u64,
        scopes: &[String],
    ) -> Result<serde_json::Value, EngineError> {
        self.capture_receiver_transport(serde_json::json!({"pageId":page_id.to_string(),"scopes":scopes,"componentSnapshots":true,"componentData":true}))
    }

    /// Stage/commit only native-owned component event and selection metadata.
    #[cfg(feature = "v8-native")]
    pub fn component_presentation(
        &mut self,
        mut request: serde_json::Value,
    ) -> Result<serde_json::Value, EngineError> {
        request["kind"] = serde_json::json!("component-presentation");
        self.capture_receiver_transport(request)
    }

    #[cfg(feature = "v8-native")]
    pub fn capture_selector_query_requests(
        &mut self,
        after: u64,
    ) -> Result<serde_json::Value, EngineError> {
        self.capture_receiver_transport(
            serde_json::json!({"kind":"selector-query-requests","after":after.to_string()}),
        )
    }

    #[cfg(feature = "v8-native")]
    pub fn capture_owned_canvas_requests(
        &mut self,
        after: u64,
    ) -> Result<serde_json::Value, EngineError> {
        self.capture_receiver_transport(
            serde_json::json!({"kind":"canvas-draw-requests","after":after.to_string()}),
        )
    }

    #[cfg(feature = "v8-native")]
    pub fn capture_animation_write_snapshot(
        &mut self,
        page_id: u64,
        scopes: &[String],
    ) -> Result<serde_json::Value, EngineError> {
        self.capture_receiver_transport(serde_json::json!({"kind":"animation-write-snapshot","pageId":page_id.to_string(),"scopes":scopes}))
    }
    #[cfg(feature = "v8-native")]
    pub fn prepare_animation_host_writes(
        &mut self,
        page_id: u64,
        paths: &[String],
    ) -> Result<serde_json::Value, EngineError> {
        self.capture_receiver_transport(serde_json::json!({"kind":"animation-host-write-prepare","pageId":page_id.to_string(),"paths":paths}))
    }
    #[cfg(feature = "v8-native")]
    pub fn finish_animation_host_writes(
        &mut self,
        ticket: &str,
        completed: bool,
    ) -> Result<serde_json::Value, EngineError> {
        self.capture_receiver_transport(serde_json::json!({"kind":"animation-host-write-finish","ticket":ticket,"completed":completed}))
    }

    #[cfg(feature = "v8-native")]
    pub fn capture_selector_query_receivers(
        &mut self,
        page_id: u64,
        scopes: &[String],
    ) -> Result<serde_json::Value, EngineError> {
        self.capture_receiver_transport(serde_json::json!({"kind":"selector-query-receivers","pageId":page_id.to_string(),"scopes":scopes}))
    }

    #[cfg(feature = "v8-native")]
    fn capture_receiver_transport(
        &mut self,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, EngineError> {
        self.check_native_execution_state()?;
        let encoded = serde_json::to_string(&payload)
            .map_err(|error| EngineError::Runtime(error.to_string()))?;
        let result = self
            .native
            .as_mut()
            .ok_or(EngineError::NativeBackendUnavailable)?
            .capture_receiver_incarnations(&encoded);
        let encoded = latch_native_control_result(&mut self.interrupted, result)
            .map_err(EngineError::Execution)?;
        serde_json::from_str(&encoded).map_err(|error| EngineError::Runtime(error.to_string()))
    }

    /// One bootstrap-private dispatch task, without a microtask checkpoint.
    /// A retired expected incarnation returns `retired:true` instead of
    /// invoking the application's error handlers or a replacement receiver.
    #[cfg(feature = "v8-native")]
    pub fn invoke_receiver_event(
        &mut self,
        page_id: u64,
        expected: &serde_json::Value,
        event: &serde_json::Value,
        rethrow_handler_error: bool,
    ) -> Result<serde_json::Value, EngineError> {
        if self.interrupted {
            return Err(EngineError::Interrupted);
        }
        let encoded = serde_json::to_string(&serde_json::json!({
            "pageId":page_id.to_string(),"expected":expected,"event":event,
            "rethrowHandlerError":rethrow_handler_error
        }))
        .map_err(|error| EngineError::Runtime(error.to_string()))?;
        let encoded = self
            .native
            .as_mut()
            .ok_or(EngineError::NativeBackendUnavailable)?
            .invoke_receiver_event(&encoded)
            .map_err(EngineError::Runtime)?;
        serde_json::from_str(&encoded).map_err(|error| EngineError::Runtime(error.to_string()))
    }

    /// Bootstrap-private navigation bookkeeping, with no application checkpoint.
    #[cfg(feature = "v8-native")]
    pub fn bind_event_channel(
        &mut self,
        request_id: u64,
        page_id: u64,
    ) -> Result<bool, EngineError> {
        if self.interrupted {
            return Err(EngineError::Interrupted);
        }
        self.native
            .as_mut()
            .ok_or(EngineError::NativeBackendUnavailable)?
            .bind_event_channel(request_id, page_id)
            .map_err(EngineError::Runtime)
    }

    /// Native event identity is checked by Session before this retained ingress.
    #[cfg(feature = "v8-native")]
    pub fn dispatch_finite_notification(
        &mut self,
        api: &str,
        event: &serde_json::Value,
    ) -> Result<(), EngineError> {
        self.install_host_environment_payload(serde_json::json!({
            "kind":"finite-notification", "api":api, "event":event,
        }))
    }

    #[cfg(feature = "v8-native")]
    pub fn finite_notification_snapshot(&mut self) -> Result<serde_json::Value, EngineError> {
        self.capture_receiver_transport(serde_json::json!({"kind":"finite-notification-snapshot"}))
    }

    #[cfg(feature = "v8-native")]
    pub fn retire_finite_notification_object(
        &mut self,
        object_id: &str,
    ) -> Result<(), EngineError> {
        self.install_host_environment_payload(serde_json::json!({
            "kind":"finite-notification-object-retire", "objectId":object_id,
        }))
    }

    #[cfg(feature = "v8-native")]
    pub fn acknowledge_finite_notification_cancellations(
        &mut self,
        subscription_id: &str,
    ) -> Result<(), EngineError> {
        self.install_host_environment_payload(serde_json::json!({
            "kind":"finite-notification-cancel-ack", "subscriptionId":subscription_id,
        }))
    }

    #[cfg(feature = "v8-native")]
    pub fn install_host_environment(
        &mut self,
        snapshot: &container_core::HostEnvironmentSnapshot,
    ) -> Result<(), EngineError> {
        let payload = serde_json::to_value(snapshot)
            .map_err(|error| EngineError::Runtime(error.to_string()))?;
        self.install_host_environment_payload(payload)
    }

    #[cfg(feature = "v8-native")]
    fn install_host_environment_payload(
        &mut self,
        payload: serde_json::Value,
    ) -> Result<(), EngineError> {
        self.check_native_execution_state()?;
        let module_command =
            payload.get("kind").and_then(serde_json::Value::as_str) == Some("module-command");
        let encoded = serde_json::to_string(&payload)
            .map_err(|error| EngineError::Runtime(error.to_string()))?;
        let result = self
            .native
            .as_mut()
            .ok_or(EngineError::NativeBackendUnavailable)?
            .install_host_environment(&encoded, module_command);
        latch_native_control_result(&mut self.interrupted, result).map_err(EngineError::Execution)
    }

    /// Compatibility surfaces share the retained transport, not global eval.
    #[cfg(feature = "v8-native")]
    pub fn prepare_page_mirror(
        &mut self,
        token: &str,
        records: &serde_json::Value,
    ) -> Result<serde_json::Value, EngineError> {
        let encoded = serde_json::to_string(
            &serde_json::json!({"kind":"pages-prepare", "token":token, "records":records}),
        )
        .map_err(|error| EngineError::Runtime(error.to_string()))?;
        let result = self
            .native
            .as_mut()
            .ok_or(EngineError::NativeBackendUnavailable)?
            .prepare_page_mirror(&encoded)
            .map_err(EngineError::Runtime)?;
        serde_json::from_str(&result).map_err(|error| EngineError::Runtime(error.to_string()))
    }

    #[cfg(feature = "v8-native")]
    pub fn commit_page_mirror(&mut self, token: &str) -> Result<(), EngineError> {
        self.install_host_environment_payload(
            serde_json::json!({"kind":"pages-commit", "token":token}),
        )
    }

    #[cfg(feature = "v8-native")]
    pub fn cancel_page_mirror(&mut self, token: &str) -> Result<(), EngineError> {
        self.install_host_environment_payload(
            serde_json::json!({"kind":"pages-cancel", "token":token}),
        )
    }

    /// Retained native journal; independent of guest effect JSON conversion.
    pub fn log_manager_journal(&self) -> Option<std::sync::Arc<container_core::LogManagerJournal>> {
        #[cfg(feature = "v8-native")]
        if let Some(native) = &self.native {
            return Some(native.log_manager.as_ref().clone());
        }
        None
    }

    pub fn take_log_manager_records(&self) -> container_core::LogManagerDrain {
        #[cfg(feature = "v8-native")]
        if let Some(native) = &self.native {
            return native.log_manager.take();
        }
        container_core::LogManagerDrain::default()
    }

    #[cfg(feature = "v8-native")]
    pub fn set_capabilities(
        &mut self,
        capabilities: &std::collections::BTreeMap<String, String>,
    ) -> Result<(), EngineError> {
        self.install_host_environment_payload(
            serde_json::json!({"kind":"capabilities", "capabilities":capabilities}),
        )
    }

    #[cfg(feature = "v8-native")]
    pub fn set_dom_query_contract(&mut self, enabled: bool) -> Result<(), EngineError> {
        self.install_host_environment_payload(
            serde_json::json!({"kind":"dom-query", "enabled":enabled}),
        )
    }
}

impl Default for V8Engine {
    fn default() -> Self {
        Self::new(V8Config::default())
    }
}

impl JsEngineAdapter for V8Engine {
    fn engine_name(&self) -> &'static str {
        "v8"
    }

    fn mode(&self) -> EngineMode {
        #[cfg(feature = "v8-native")]
        {
            if self.native.is_some() {
                EngineMode::V8
            } else {
                EngineMode::Unavailable
            }
        }
        #[cfg(not(feature = "v8-native"))]
        {
            EngineMode::Stub
        }
    }

    fn load_module_batch(&mut self, modules: &[&[u8]]) -> Result<usize, EngineError> {
        if modules.iter().any(|module| module.is_empty()) {
            return Err(EngineError::EmptyModule);
        }
        if self.mode() != EngineMode::V8 {
            return Err(EngineError::NativeBackendUnavailable);
        }
        for module in modules {
            container_core::JsEngine::load_module(self, module).map_err(map_core_error)?;
        }
        Ok(modules.len())
    }

    fn interrupt(&mut self) {
        self.interrupted = true;
        #[cfg(feature = "v8-native")]
        if let Some(native) = &self.native {
            native.terminal_resources.retire();
            // TerminateExecution is safe to request from another thread too;
            // this adapter is thread-affine, so issuing it here keeps the
            // state transition deterministic for the core contract.
            native.isolate.thread_safe_handle().terminate_execution();
        }
    }
}

impl container_core::JsEngine for V8Engine {
    fn install_api_delivery_provider(
        &mut self,
        provider: std::sync::Arc<dyn container_core::ApiDeliveryProvider>,
    ) -> Result<(), container_core::EngineError> {
        #[cfg(not(feature = "v8-native"))]
        {
            let _ = provider;
            Err(container_core::EngineError::new(
                container_core::EngineErrorCode::Call,
                "native V8 API delivery claims are unavailable",
            ))
        }
        #[cfg(feature = "v8-native")]
        self.native
            .as_ref()
            .ok_or_else(|| {
                container_core::EngineError::new(
                    container_core::EngineErrorCode::Call,
                    "V8 is unavailable",
                )
            })?
            .api_delivery_provider
            .install(provider)
    }

    fn install_sync_host_api(
        &mut self,
        provider: std::sync::Arc<dyn container_core::SyncHostApi>,
    ) -> Result<(), container_core::EngineError> {
        #[cfg(not(feature = "v8-native"))]
        {
            let _ = provider;
            Err(container_core::EngineError::new(
                container_core::EngineErrorCode::Call,
                "native V8 synchronous host callback is unavailable",
            ))
        }
        #[cfg(feature = "v8-native")]
        {
            let native = self.native.as_mut().ok_or_else(|| {
                container_core::EngineError::new(
                    container_core::EngineErrorCode::Call,
                    "V8 is unavailable",
                )
            })?;
            native.install_sync_host_api(provider).ok_or_else(|| {
                container_core::EngineError::new(
                    container_core::EngineErrorCode::Call,
                    "cannot install V8 synchronous host callback",
                )
            })
        }
    }
    fn load_module(
        &mut self,
        module: &[u8],
    ) -> Result<container_core::ModuleId, container_core::EngineError> {
        if module.is_empty() {
            return Err(container_core::EngineError::new(
                container_core::EngineErrorCode::ModuleLoad,
                EngineError::EmptyModule.to_string(),
            ));
        }
        if self.interrupted {
            return Err(container_core::EngineError::new(
                container_core::EngineErrorCode::Interrupted,
                EngineError::Interrupted.to_string(),
            ));
        }
        if self.mode() != EngineMode::V8 {
            return Err(container_core::EngineError::new(
                container_core::EngineErrorCode::ModuleLoad,
                EngineError::NativeBackendUnavailable.to_string(),
            ));
        }

        #[cfg(feature = "v8-native")]
        let source = match std::str::from_utf8(module) {
            Ok(source) => source,
            Err(_) => {
                return Err(container_core::EngineError::new(
                    container_core::EngineErrorCode::ModuleLoad,
                    EngineError::InvalidUtf8.to_string(),
                ))
            }
        };
        let id = container_core::ModuleId((self.loaded_modules + 1) as u64);

        #[cfg(feature = "v8-native")]
        {
            self.native.as_ref().ok_or_else(|| {
                container_core::EngineError::new(
                    container_core::EngineErrorCode::ModuleLoad,
                    EngineError::NativeBackendUnavailable.to_string(),
                )
            })?;
            self.install_host_environment_payload(serde_json::json!({
                "kind":"module-command", "operation":"anonymous", "id":"",
                "number":id.0, "source":source,
            }))
            .map_err(EngineError::into_core_error)?;
            if let Some(native) = &mut self.native {
                native.modules.insert(id.0, source.to_owned());
            }
        }

        self.loaded_modules = id.0 as usize;
        Ok(id)
    }

    fn call(
        &mut self,
        target: container_core::CallTarget,
        args: container_core::ValueBatch,
    ) -> Result<container_core::ValueBatch, container_core::EngineError> {
        if self.interrupted {
            return Err(container_core::EngineError::new(
                container_core::EngineErrorCode::Interrupted,
                EngineError::Interrupted.to_string(),
            ));
        }
        if self.mode() != EngineMode::V8 {
            return Err(container_core::EngineError::new(
                container_core::EngineErrorCode::Call,
                EngineError::NativeBackendUnavailable.to_string(),
            ));
        }
        #[cfg(feature = "v8-native")]
        if matches!(&target, container_core::CallTarget::Global { name } if name == "__container_set_storage_snapshot")
        {
            let mut snapshot = args
                .first()
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            if let Some(object) = snapshot.as_object_mut() {
                object
                    .entry("values")
                    .or_insert_with(|| serde_json::json!({}));
                object
                    .entry("undefinedKeys")
                    .or_insert_with(|| serde_json::json!([]));
            }
            self.install_host_environment_payload(
                serde_json::json!({"kind":"storage-restore","storage":snapshot}),
            )
            .map_err(EngineError::into_core_error)?;
            return Ok(vec![serde_json::Value::Bool(true)]);
        }
        if matches!(
            &target,
            container_core::CallTarget::Global { name } if name == "__container_drain_timers"
        ) {
            return self.drain_native_timer_tasks(args);
        }
        let args_json = serde_json::to_string(&args).map_err(|error| {
            container_core::EngineError::new(
                container_core::EngineErrorCode::Call,
                format!("cannot serialize argument batch: {error}"),
            )
        })?;
        let effect_drain = matches!(&target, container_core::CallTarget::Global { name } if name == "__container_drain_events");
        let (module_id, name) = match target {
            container_core::CallTarget::Global { name } => (None, name),
            container_core::CallTarget::Module { id, export } => (Some(id.0), export),
        };

        #[cfg(feature = "v8-native")]
        {
            let native = self.native.as_mut().ok_or_else(|| {
                container_core::EngineError::new(
                    container_core::EngineErrorCode::Call,
                    EngineError::NativeBackendUnavailable.to_string(),
                )
            })?;
            let encoded = native
                .call_batch(module_id, &name, &args_json)
                .map_err(|message| {
                    container_core::EngineError::new(container_core::EngineErrorCode::Call, message)
                })?;
            let mut value = decode_native_result_json(&encoded).map_err(|error| {
                container_core::EngineError::new(
                    container_core::EngineErrorCode::Call,
                    format!("V8 returned invalid JSON: {error}"),
                )
            })?;
            if effect_drain {
                // Strip all guest envelopes before authenticating the single
                // canonical pending drain through the retained native channel.
                if let Some(values) = value.as_array_mut() {
                    for value in values {
                        if let Some(batch) = value.as_object_mut() {
                            batch.remove("__componentMutations");
                            batch.remove("__dataWrites");
                            batch.remove("__storageTransactions");
                        }
                    }
                } else if let Some(batch) = value.as_object_mut() {
                    batch.remove("__componentMutations");
                    batch.remove("__dataWrites");
                    batch.remove("__storageTransactions");
                }
                let token = value
                    .get("__containerDrainId")
                    .and_then(serde_json::Value::as_u64);
                if let Some(token) = token {
                    let request = serde_json::to_string(
                        &serde_json::json!({"kind":"storage-transactions","drainId":token}),
                    )
                    .expect("storage drain token");
                    let transactions = latch_native_control_result(
                        &mut self.interrupted,
                        native.capture_receiver_incarnations(&request),
                    )?;
                    let transactions: serde_json::Value = serde_json::from_str(&transactions)
                        .map_err(|error| {
                            container_core::EngineError::new(
                                container_core::EngineErrorCode::Call,
                                error.to_string(),
                            )
                        })?;
                    let request = serde_json::to_string(
                        &serde_json::json!({"kind":"component-mutations","drainId":token}),
                    )
                    .expect("component drain token");
                    let mutations = latch_native_control_result(
                        &mut self.interrupted,
                        native.capture_receiver_incarnations(&request),
                    )?;
                    let mutations: serde_json::Value =
                        serde_json::from_str(&mutations).map_err(|error| {
                            container_core::EngineError::new(
                                container_core::EngineErrorCode::Call,
                                error.to_string(),
                            )
                        })?;
                    if mutations
                        .as_object()
                        .is_some_and(|records| !records.is_empty())
                    {
                        value["__componentMutations"] = mutations;
                    }
                    let request = serde_json::to_string(
                        &serde_json::json!({"kind":"data-write-receipts","drainId":token}),
                    )
                    .expect("write drain token");
                    let writes = latch_native_control_result(
                        &mut self.interrupted,
                        native.capture_receiver_incarnations(&request),
                    )?;
                    let writes: serde_json::Value =
                        serde_json::from_str(&writes).map_err(|error| {
                            container_core::EngineError::new(
                                container_core::EngineErrorCode::Call,
                                error.to_string(),
                            )
                        })?;
                    value["__dataWrites"] = writes;
                    value["__storageTransactions"] = transactions;
                    let ack = serde_json::to_string(
                        &serde_json::json!({"kind":"effects-ack", "drainId":token,"keepStorage":self.deferred_storage_commit}),
                    )
                    .expect("effect token serialization");
                    latch_native_control_result(
                        &mut self.interrupted,
                        native.install_host_environment(&ack, false),
                    )?;
                    value.as_object_mut().unwrap().remove("__containerDrainId");
                }
            }
            Ok(match value {
                serde_json::Value::Array(values) => values,
                value => vec![value],
            })
        }

        #[cfg(not(feature = "v8-native"))]
        {
            let _ = (module_id, name, args_json, args, effect_drain);
            unreachable!("stub mode returned before constructing a native call")
        }
    }

    fn drain_microtasks(&mut self) -> Result<(), container_core::EngineError> {
        if self.interrupted {
            return Err(container_core::EngineError::new(
                container_core::EngineErrorCode::Interrupted,
                EngineError::Interrupted.to_string(),
            ));
        }
        if self.mode() != EngineMode::V8 {
            return Err(container_core::EngineError::new(
                container_core::EngineErrorCode::Microtasks,
                EngineError::NativeBackendUnavailable.to_string(),
            ));
        }
        #[cfg(feature = "v8-native")]
        if let Some(native) = &mut self.native {
            native.isolate.lock().perform_microtask_checkpoint();
            let result = native.flush_unhandled_rejections();
            if result
                .as_ref()
                .is_err_and(|error| error.code == container_core::EngineErrorCode::Interrupted)
            {
                self.interrupted = true;
                #[cfg(feature = "v8-native")]
                if let Some(native) = &self.native {
                    native.terminal_resources.retire();
                }
            }
            return result;
        }
        Err(container_core::EngineError::new(
            container_core::EngineErrorCode::Microtasks,
            EngineError::NativeBackendUnavailable.to_string(),
        ))
    }

    fn snapshot(
        &mut self,
    ) -> Result<Option<container_core::Snapshot>, container_core::EngineError> {
        if self.mode() != EngineMode::V8 {
            return Err(container_core::EngineError::new(
                container_core::EngineErrorCode::Snapshot,
                EngineError::NativeBackendUnavailable.to_string(),
            ));
        }
        // Runtime snapshots need an embedder-defined startup blob and a
        // module serializer. Returning None is the trait's explicit
        // "snapshot unavailable" result; it does not claim V8 is unavailable.
        Ok(None)
    }

    fn interrupt(&mut self) {
        <Self as JsEngineAdapter>::interrupt(self);
    }
}

fn map_core_error(error: container_core::EngineError) -> EngineError {
    if error.message == EngineError::NativeBackendUnavailable.to_string() {
        EngineError::NativeBackendUnavailable
    } else if error.message == EngineError::Interrupted.to_string() {
        EngineError::Interrupted
    } else if error.message == EngineError::EmptyModule.to_string() {
        EngineError::EmptyModule
    } else if error.message == EngineError::InvalidUtf8.to_string() {
        EngineError::InvalidUtf8
    } else {
        EngineError::Runtime(error.to_string())
    }
}

#[cfg(feature = "v8-native")]
fn initialize_v8_platform() {
    use std::sync::Once;

    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
    });
}

#[cfg(feature = "v8-native")]
impl NativeV8 {
    fn new(config: &V8Config) -> Option<Self> {
        initialize_v8_platform();

        let mut params = v8::CreateParams::default();
        if let Some(limit) = config.heap_limit_bytes {
            params = params.set_max_old_generation_size_in_bytes(limit);
        }
        let terminal_resources =
            std::sync::Arc::new(container_core::EngineTerminalResources::default());
        let mut isolate = v8::Isolate::new(params);
        isolate.set_slot(terminal_resources.clone());
        isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
        let context = {
            v8::scope!(let scope, &mut isolate);
            let context = v8::Context::new(scope, Default::default());
            v8::Global::new(scope, context)
        };
        // Conversion exits the construction-time entry. No isolate remains
        // entered between calls, including while another session is created
        // or an older session is dropped after a successful reload.
        // SAFETY: the isolate is still on its creating thread, the temporary
        // handle scope has ended, and it has no embedder slots/callbacks or
        // external allocations. NativeV8 remains !Send/!Sync via `_owner`;
        // subsequent context access creates Locals only under a Locker.
        let isolate = match unsafe { isolate.try_into_shared() } {
            Ok(isolate) => isolate,
            Err(error) => {
                drop(error.into_isolate());
                return None;
            }
        };
        let log_manager = std::sync::Arc::new(container_core::LogManagerJournal::default());
        let log_retirement = log_manager.clone();
        terminal_resources.register(move || log_retirement.retire());
        let performance_lifetime =
            std::sync::Arc::new(container_core::PerformanceLifetime::default());
        let performance_retirement = performance_lifetime.clone();
        terminal_resources.register(move || performance_retirement.retire());
        let buffer_urls = std::sync::Arc::new(container_core::BufferUrlStore::default());
        let buffer_retirement = buffer_urls.clone();
        terminal_resources.register(move || buffer_retirement.retire());
        let mut native = Self {
            batch_call: None,
            host_environment: None,
            receiver_incarnations: None,
            receiver_event: None,
            event_channel_binding: None,
            lifecycle_notification: None,
            route_notification: None,
            flush_rejections: None,
            promise_rejections: Box::new(NativePromiseRejections {
                collector: None,
                failed: std::cell::Cell::new(false),
            }),
            context,
            isolate,
            modules: std::collections::BTreeMap::new(),
            sync_host_api: None,
            api_delivery_provider: Box::default(),
            performance_origin: Box::new(std::time::Instant::now()),
            performance_lifetime,
            log_manager: Box::new(log_manager),
            buffer_urls: Box::new(buffer_urls),
            terminal_resources,
            route_rewrite: std::rc::Rc::new(container_core::RouteRewriteSlot::default()),
            _owner: std::marker::PhantomData,
        };
        native.install_api_delivery_callback()?;
        native.install_performance_clock()?;
        native.install_log_manager()?;
        native.install_buffer_url_callback()?;
        native.install_route_rewrite_callback()?;
        // The registration globals must exist before the first generated
        // app/page module is evaluated. This is a deterministic script with
        // no host callbacks, so a failure indicates a broken provider setup.
        let facade = container_core::app_service_environment_bootstrap(MINI_PROGRAM_BOOTSTRAP);
        for (name, source) in [
            (
                "timer-tasks",
                include_str!("../../container-core/src/timer-tasks.js"),
            ),
            (
                "api-owner",
                include_str!("../../container-core/src/api-owner.js"),
            ),
            ("mini-program", facade.as_str()),
            (
                "host-data-mirror",
                include_str!("../../container-core/src/host-data-mirror.js"),
            ),
            ("host-bridge", container_core::HOST_BRIDGE_BOOTSTRAP),
        ] {
            if name == "mini-program" {
                let transports = native.compile_host_environment(source)?;
                native.host_environment = Some(transports.installer);
                native.batch_call = Some(transports.batch_call);
                native.receiver_incarnations = Some(transports.incarnations);
                native.receiver_event = Some(transports.event_factory);
                native.event_channel_binding = Some(transports.channel_binding);
                native.lifecycle_notification = Some(transports.lifecycle_notification);
                native.route_notification = Some(transports.route_notification);
                native.promise_rejections.collector = Some(transports.rejection_collector);
                native.flush_rejections = Some(transports.flush_rejections);
                continue;
            }
            if let Err(error) = native.run_bootstrap(name, source) {
                eprintln!("container-engine-v8: {error}");
                return None;
            }
        }
        native.receiver_event = Some(native.bind_receiver_event_dispatcher()?);
        native.install_promise_rejection_callback();
        Some(native)
    }

    fn install_promise_rejection_callback(&mut self) {
        let pointer = self.promise_rejections.as_ref() as *const NativePromiseRejections;
        let mut isolate = self.isolate.lock();
        isolate.set_slot(PromiseRejectionSlot(pointer as usize));
        isolate.set_promise_reject_callback(Self::promise_reject_callback);
    }

    unsafe extern "C" fn promise_reject_callback(message: v8::PromiseRejectMessage) {
        let handled = match message.get_event() {
            v8::PromiseRejectEvent::PromiseRejectWithNoHandler => false,
            v8::PromiseRejectEvent::PromiseHandlerAddedAfterReject => true,
            _ => return,
        };
        v8::callback_scope!(unsafe scope, &message);
        let Some(pointer) = scope.get_slot::<PromiseRejectionSlot>().map(|slot| slot.0) else {
            return;
        };
        // The current isolate's slot points into its own NativeV8 allocation.
        // The owner removes the callback/slot under its Locker before disposal.
        let slot = unsafe { &*(pointer as *const NativePromiseRejections) };
        if slot.failed.get() {
            return;
        }
        let Some(collector) = slot.collector.as_ref() else {
            slot.failed.set(true);
            return;
        };
        v8::tc_scope!(let scope, scope);
        let collector = v8::Local::new(scope, collector);
        let promise: v8::Local<v8::Value> = message.get_promise().into();
        // Handler-added messages carry no value. The collector ignores their
        // reason argument, so reuse the message-local Promise handle there.
        let reason = message.get_value().unwrap_or(promise);
        let handled = v8::Boolean::new(scope, handled).into();
        let receiver = v8::undefined(scope).into();
        // Only the retained data collector runs here; application callbacks are
        // deferred until after the explicit native microtask checkpoint.
        if collector
            .call(scope, receiver, &[promise, reason, handled])
            .is_none()
        {
            slot.failed.set(true);
        }
    }

    unsafe extern "C" fn ignore_promise_rejection(_: v8::PromiseRejectMessage) {}

    fn flush_unhandled_rejections(&mut self) -> Result<(), container_core::EngineError> {
        use container_core::{EngineError, EngineErrorCode};
        if self.isolate.thread_safe_handle().is_execution_terminating() {
            self.terminal_resources.retire();
            return Err(EngineError::new(
                EngineErrorCode::Interrupted,
                "V8 execution interrupted",
            ));
        }
        if self.promise_rejections.failed.get() {
            return Err(EngineError::new(
                EngineErrorCode::Microtasks,
                "native promise rejection capture failed",
            ));
        }
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        v8::tc_scope!(let scope, scope);
        let Some(flush) = self.flush_rejections.as_ref() else {
            return Err(EngineError::new(
                EngineErrorCode::Microtasks,
                "native rejection flush unavailable",
            ));
        };
        let flush = v8::Local::new(scope, flush);
        let receiver = v8::undefined(scope).into();
        let accepted = flush.call(scope, receiver, &[]).is_some();
        if scope.has_terminated() || scope.is_execution_terminating() {
            self.terminal_resources.retire();
            Err(EngineError::new(
                EngineErrorCode::Interrupted,
                "V8 execution interrupted",
            ))
        } else if !accepted {
            Err(EngineError::new(
                EngineErrorCode::Microtasks,
                "native rejection flush failed",
            ))
        } else {
            Ok(())
        }
    }

    fn install_route_rewrite_callback(&mut self) -> Option<()> {
        let pointer = std::rc::Rc::as_ptr(&self.route_rewrite);
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        let external = v8::External::new(scope, pointer.cast_mut().cast());
        let function = v8::Function::builder(Self::route_rewrite_callback)
            .data(external.into())
            .build(scope)?;
        let key = v8::String::new(scope, "__container_host_route_rewrite")?;
        context
            .global(scope)
            .define_own_property(
                scope,
                key.into(),
                function.into(),
                v8::PropertyAttribute::DONT_ENUM,
            )?
            .then_some(())
    }

    fn route_rewrite_callback(
        scope: &mut v8::PinScope,
        arguments: v8::FunctionCallbackArguments,
        mut result: v8::ReturnValue,
    ) {
        let Ok(external) = v8::Local::<v8::External>::try_from(arguments.data()) else {
            return;
        };
        if !arguments.get(0).is_string() || !arguments.get(1).is_boolean() {
            return;
        }
        let Some(url) = arguments.get(0).to_string(scope) else {
            return;
        };
        let url = url.to_rust_string_lossy(scope);
        let preserve = arguments.get(1).is_true();
        // Rc::as_ptr addresses the stable slot allocation, not the movable Rc handle.
        // NativeV8 retains its Rc until after the isolate is dropped. The slot is
        // owner-thread only and its validator never owns a Session borrow.
        let slot = unsafe { &*external.value().cast::<container_core::RouteRewriteSlot>() };
        let json = slot.invoke_json(&url, preserve);
        if let Some(value) = v8::String::new(scope, &json) {
            result.set(value.into());
        }
    }

    fn install_log_manager(&mut self) -> Option<()> {
        let pointer =
            self.log_manager.as_ref() as *const std::sync::Arc<container_core::LogManagerJournal>;
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        let external = v8::External::new(scope, pointer.cast_mut().cast());
        let function = v8::Function::builder(Self::log_manager_callback)
            .data(external.into())
            .build(scope)?;
        let key = v8::String::new(scope, "__container_host_log_manager_write")?;
        context
            .global(scope)
            .define_own_property(
                scope,
                key.into(),
                function.into(),
                v8::PropertyAttribute::DONT_ENUM,
            )?
            .then_some(())
    }

    fn log_manager_callback(
        scope: &mut v8::PinScope,
        arguments: v8::FunctionCallbackArguments,
        mut result: v8::ReturnValue,
    ) {
        let Ok(external) = v8::Local::<v8::External>::try_from(arguments.data()) else {
            return;
        };
        // Boxed Arc remains stable until the isolate drops; native ingress catches panics.
        let journal = unsafe {
            &*external
                .value()
                .cast::<std::sync::Arc<container_core::LogManagerJournal>>()
        };
        if arguments.length() == 0 {
            result.set_bool(journal.is_active());
            return;
        }
        let Ok(text) = v8::Local::<v8::String>::try_from(arguments.get(0)) else {
            return;
        };
        result.set_bool(journal.append_json(&text.to_rust_string_lossy(scope)));
    }

    fn install_buffer_url_callback(&mut self) -> Option<()> {
        let pointer =
            self.buffer_urls.as_ref() as *const std::sync::Arc<container_core::BufferUrlStore>;
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        let external = v8::External::new(scope, pointer.cast_mut().cast());
        let function = v8::Function::builder(Self::buffer_url_callback)
            .data(external.into())
            .build(scope)?;
        let key = v8::String::new(scope, "__container_host_buffer_url")?;
        context
            .global(scope)
            .define_own_property(
                scope,
                key.into(),
                function.into(),
                v8::PropertyAttribute::DONT_ENUM,
            )?
            .then_some(())
    }
    fn buffer_url_callback(
        scope: &mut v8::PinScope,
        arguments: v8::FunctionCallbackArguments,
        mut result: v8::ReturnValue,
    ) {
        let Ok(external) = v8::Local::<v8::External>::try_from(arguments.data()) else {
            return;
        };
        if !arguments.get(0).is_string() || !arguments.get(1).is_string() {
            return;
        }
        let Some(operation) = arguments.get(0).to_string(scope) else {
            return;
        };
        let Some(input) = arguments.get(1).to_string(scope) else {
            return;
        };
        // Boxed Arc remains stable until after this isolate has been dropped.
        let owner = unsafe {
            &*external
                .value()
                .cast::<std::sync::Arc<container_core::BufferUrlStore>>()
        };
        let text = owner.invoke_json(
            &operation.to_rust_string_lossy(scope),
            &input.to_rust_string_lossy(scope),
        );
        if let Some(value) = v8::String::new(scope, &text) {
            result.set(value.into());
        }
    }

    fn install_performance_clock(&mut self) -> Option<()> {
        let pointer = self.performance_origin.as_ref() as *const std::time::Instant;
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        let external = v8::External::new(scope, pointer.cast_mut().cast());
        let function = v8::Function::builder(Self::performance_clock_callback)
            .data(external.into())
            .build(scope)?;
        let live_pointer = std::sync::Arc::as_ptr(&self.performance_lifetime);
        let live_data = v8::External::new(scope, live_pointer.cast_mut().cast());
        let active = v8::Function::builder(Self::performance_active_callback)
            .data(live_data.into())
            .build(scope)?;
        let active_key = v8::String::new(scope, "__container_host_performance_active")?;
        context
            .global(scope)
            .define_own_property(
                scope,
                active_key.into(),
                active.into(),
                v8::PropertyAttribute::DONT_ENUM,
            )?
            .then_some(())?;
        let key = v8::String::new(scope, "__container_host_performance_now")?;
        context
            .global(scope)
            .define_own_property(
                scope,
                key.into(),
                function.into(),
                v8::PropertyAttribute::DONT_ENUM,
            )?
            .then_some(())
    }

    fn performance_active_callback(
        _scope: &mut v8::PinScope,
        arguments: v8::FunctionCallbackArguments,
        mut result: v8::ReturnValue,
    ) {
        let Ok(external) = v8::Local::<v8::External>::try_from(arguments.data()) else {
            return;
        };
        // The Arc allocation is retained until after the isolate is disposed.
        let lifetime = unsafe {
            &*external
                .value()
                .cast::<container_core::PerformanceLifetime>()
        };
        result.set_bool(lifetime.is_active());
    }

    fn performance_clock_callback(
        _scope: &mut v8::PinScope,
        arguments: v8::FunctionCallbackArguments,
        mut result: v8::ReturnValue,
    ) {
        let Ok(external) = v8::Local::<v8::External>::try_from(arguments.data()) else {
            return;
        };
        // Stable boxed clock lives past the isolate and is never mutated.
        let origin = unsafe { &*external.value().cast::<std::time::Instant>() };
        result.set_double(origin.elapsed().as_secs_f64() * 1000.0);
    }

    fn install_api_delivery_callback(&mut self) -> Option<()> {
        let pointer =
            self.api_delivery_provider.as_ref() as *const container_core::ApiDeliveryProviderSlot;
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        let external = v8::External::new(scope, pointer.cast_mut().cast());
        let function = v8::Function::builder(Self::api_delivery_callback)
            .data(external.into())
            .build(scope)?;
        let key = v8::String::new(scope, "__container_host_api_delivery_claim")?;
        context
            .global(scope)
            .define_own_property(
                scope,
                key.into(),
                function.into(),
                v8::PropertyAttribute::READ_ONLY
                    | v8::PropertyAttribute::DONT_DELETE
                    | v8::PropertyAttribute::DONT_ENUM,
            )?
            .then_some(())
    }

    fn api_delivery_callback(
        scope: &mut v8::PinScope,
        arguments: v8::FunctionCallbackArguments,
        mut result: v8::ReturnValue,
    ) {
        let Ok(external) = v8::Local::<v8::External>::try_from(arguments.data()) else {
            return;
        };
        if !arguments.get(0).is_number() || !arguments.get(1).is_string() {
            return;
        }
        let number = arguments.get(0).number_value(scope).unwrap_or(f64::NAN);
        let request_id = if number.is_finite()
            && number.fract() == 0.0
            && (1.0..=9_007_199_254_740_991.0).contains(&number)
        {
            number as u64
        } else {
            0
        };
        let Some(ticket) = arguments.get(1).to_string(scope) else {
            return;
        };
        let ticket = ticket.to_rust_string_lossy(scope);
        // The slot is independent of Session; it clones its Arc and releases
        // its short lock before calling the provider inside this VM callback.
        let provider = unsafe {
            &*external
                .value()
                .cast::<container_core::ApiDeliveryProviderSlot>()
        };
        let text = provider.claim_json(request_id, &ticket);
        if let Some(value) = v8::String::new(scope, &text) {
            result.set(value.into());
        }
    }

    fn install_sync_host_api(
        &mut self,
        provider: std::sync::Arc<dyn container_core::SyncHostApi>,
    ) -> Option<()> {
        if self.sync_host_api.is_some() {
            return None;
        }
        let provider = Box::new(provider);
        let pointer = provider.as_ref() as *const std::sync::Arc<dyn container_core::SyncHostApi>;
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope,&mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope,scope,context);
        let external = v8::External::new(scope, pointer.cast_mut().cast());
        let function = v8::Function::builder(Self::sync_host_callback)
            .data(external.into())
            .build(scope)?;
        let key = v8::String::new(scope, "__container_host_sync_call")?;
        if !context.global(scope).define_own_property(
            scope,
            key.into(),
            function.into(),
            v8::PropertyAttribute::READ_ONLY
                | v8::PropertyAttribute::DONT_DELETE
                | v8::PropertyAttribute::DONT_ENUM,
        )? {
            return None;
        }
        self.sync_host_api = Some(provider);
        Some(())
    }
    fn sync_host_callback(
        scope: &mut v8::PinScope,
        arguments: v8::FunctionCallbackArguments,
        mut result: v8::ReturnValue,
    ) {
        let Ok(external) = v8::Local::<v8::External>::try_from(arguments.data()) else {
            return;
        };
        if !arguments.get(0).is_string() || !arguments.get(1).is_string() {
            return;
        }
        let Some(name) = arguments.get(0).to_string(scope) else {
            return;
        };
        let Some(payload) = arguments.get(1).to_string(scope) else {
            return;
        };
        let name = name.to_rust_string_lossy(scope);
        let payload = payload.to_rust_string_lossy(scope);
        // The stable boxed Arc outlives the isolate and every callback. No
        // Session/provider borrow or V8 Locker is acquired inside this call.
        let provider = unsafe {
            &*external
                .value()
                .cast::<std::sync::Arc<dyn container_core::SyncHostApi>>()
        };
        let text = container_core::invoke_sync_host_api(provider.as_ref(), &name, &payload);
        if let Some(value) = v8::String::new(scope, &text) {
            result.set(value.into());
        }
    }

    fn compile_host_environment(&mut self, source: &str) -> Option<HostEnvironmentTransports> {
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        let source = v8::String::new(scope, source)?;
        let script = v8::Script::compile(scope, source, None)?;
        let result = script.run(scope)?;
        let transports = v8::Local::<v8::Object>::try_from(result).ok()?;
        let installer_key = v8::String::new(scope, "installHostEnvironment")?;
        let installer = transports.get(scope, installer_key.into())?;
        let installer = v8::Local::<v8::Function>::try_from(installer).ok()?;
        let capture_key = v8::String::new(scope, "captureReceiverIncarnations")?;
        let capture = transports.get(scope, capture_key.into())?;
        let capture = v8::Local::<v8::Function>::try_from(capture).ok()?;
        let event_key = v8::String::new(scope, "createReceiverEventDispatcher")?;
        let event_factory = transports.get(scope, event_key.into())?;
        let event_factory = v8::Local::<v8::Function>::try_from(event_factory).ok()?;
        let channel_key = v8::String::new(scope, "bindEventChannel")?;
        let channel_binding = transports.get(scope, channel_key.into())?;
        let channel_binding = v8::Local::<v8::Function>::try_from(channel_binding).ok()?;
        let lifecycle_key = v8::String::new(scope, "dispatchLifecycleNotification")?;
        let lifecycle = transports.get(scope, lifecycle_key.into())?;
        let lifecycle = v8::Local::<v8::Function>::try_from(lifecycle).ok()?;
        let route_key = v8::String::new(scope, "dispatchRouteNotification")?;
        let route = transports.get(scope, route_key.into())?;
        let route = v8::Local::<v8::Function>::try_from(route).ok()?;
        Some(HostEnvironmentTransports {
            batch_call: {
                let key = v8::String::new(scope, "batchCall")?;
                let value = transports.get(scope, key.into())?;
                let function = v8::Local::<v8::Function>::try_from(value).ok()?;
                v8::Global::new(scope, function)
            },
            installer: v8::Global::new(scope, installer),
            incarnations: v8::Global::new(scope, capture),
            event_factory: v8::Global::new(scope, event_factory),
            channel_binding: v8::Global::new(scope, channel_binding),
            lifecycle_notification: v8::Global::new(scope, lifecycle),
            route_notification: v8::Global::new(scope, route),
            rejection_collector: {
                let key = v8::String::new(scope, "trackPromiseRejection")?;
                let value = transports.get(scope, key.into())?;
                let function = v8::Local::<v8::Function>::try_from(value).ok()?;
                v8::Global::new(scope, function)
            },
            flush_rejections: {
                let key = v8::String::new(scope, "flushUnhandledRejections")?;
                let value = transports.get(scope, key.into())?;
                let function = v8::Local::<v8::Function>::try_from(value).ok()?;
                v8::Global::new(scope, function)
            },
        })
    }

    fn bind_event_channel(&mut self, request_id: u64, page_id: u64) -> Result<bool, String> {
        const FAILED: &str = "event channel binding failed";
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        v8::tc_scope!(let scope, scope);
        let bind = v8::Local::new(scope, self.event_channel_binding.as_ref().ok_or(FAILED)?);
        let request = v8::String::new(scope, &request_id.to_string()).ok_or(FAILED)?;
        let page = v8::String::new(scope, &page_id.to_string()).ok_or(FAILED)?;
        let receiver = v8::undefined(scope).into();
        let result = bind
            .call(scope, receiver, &[request.into(), page.into()])
            .ok_or(FAILED)?;
        if !result.is_boolean() {
            return Err(FAILED.into());
        }
        Ok(result.boolean_value(scope))
    }

    fn bind_receiver_event_dispatcher(&mut self) -> Option<v8::Global<v8::Function>> {
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        let factory = v8::Local::new(scope, self.receiver_event.as_ref()?);
        let receiver = context.global(scope);
        let name = v8::String::new(scope, "__container_dispatch_owned_event")?;
        let dispatcher = receiver.get(scope, name.into())?;
        let result = factory.call(scope, receiver.into(), &[dispatcher])?;
        let invoke = v8::Local::<v8::Function>::try_from(result).ok()?;
        Some(v8::Global::new(scope, invoke))
    }

    fn prepare_page_mirror(&mut self, encoded: &str) -> Result<String, String> {
        const FAILED: &str = "page mirror preparation failed";
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        v8::tc_scope!(let try_catch, scope);
        let installer = v8::Local::new(try_catch, self.host_environment.as_ref().ok_or(FAILED)?);
        let text = v8::String::new(try_catch, encoded).ok_or(FAILED)?;
        let payload = v8::json::parse(try_catch, text).ok_or(FAILED)?;
        let receiver = context.global(try_catch);
        let result = installer
            .call(try_catch, receiver.into(), &[payload])
            .ok_or(FAILED)?;
        let text = v8::Local::<v8::String>::try_from(result).map_err(|_| FAILED)?;
        Ok(text.to_rust_string_lossy(try_catch))
    }

    fn install_host_environment(
        &mut self,
        encoded: &str,
        module_command: bool,
    ) -> Result<(), container_core::EngineError> {
        // No exception coercion/reporting: even a thrown object's toString may
        // be application code. The installer has a fixed failure contract.
        const FAILED: &str = "host environment installation failed";
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        v8::tc_scope!(let try_catch, scope);
        let installer = self.host_environment.as_ref().ok_or_else(|| {
            container_core::EngineError::new(container_core::EngineErrorCode::Call, FAILED)
        })?;
        let installer = v8::Local::new(try_catch, installer);
        let text = v8::String::new(try_catch, encoded)
            .ok_or_else(|| native_transport_error(try_catch, FAILED))?;
        let payload = v8::json::parse(try_catch, text)
            .ok_or_else(|| native_transport_error(try_catch, FAILED))?;
        let receiver = context.global(try_catch);
        let result = installer
            .call(try_catch, receiver.into(), &[payload])
            .ok_or_else(|| {
                let error = native_transport_error(try_catch, FAILED);
                if !module_command || error.code == container_core::EngineErrorCode::Interrupted {
                    return error;
                }
                // V8's captured Message is diagnostic data. Do not coerce the
                // guest exception or invoke its toString/getters while reporting.
                let message = try_catch
                    .message()
                    .map(|message| message.get(try_catch).to_rust_string_lossy(try_catch))
                    .unwrap_or_else(|| "native module command failed".into());
                container_core::EngineError::new(
                    container_core::EngineErrorCode::ModuleLoad,
                    message,
                )
            })?;
        if result.is_true() {
            Ok(())
        } else {
            Err(native_transport_error(try_catch, FAILED))
        }
    }

    fn dispatch_lifecycle_notification(
        &mut self,
        name: &str,
        encoded: &str,
    ) -> Result<bool, container_core::EngineError> {
        const FAILED: &str = "lifecycle notification dispatch failed";
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        v8::tc_scope!(let try_catch, scope);
        let dispatch = self.lifecycle_notification.as_ref().ok_or_else(|| {
            container_core::EngineError::new(container_core::EngineErrorCode::Call, FAILED)
        })?;
        let dispatch = v8::Local::new(try_catch, dispatch);
        let name = v8::String::new(try_catch, name)
            .ok_or_else(|| native_transport_error(try_catch, FAILED))?;
        let text = v8::String::new(try_catch, encoded)
            .ok_or_else(|| native_transport_error(try_catch, FAILED))?;
        let payload = v8::json::parse(try_catch, text)
            .ok_or_else(|| native_transport_error(try_catch, FAILED))?;
        let receiver = context.global(try_catch);
        let result = dispatch
            .call(try_catch, receiver.into(), &[name.into(), payload])
            .ok_or_else(|| native_transport_error(try_catch, FAILED))?;
        if !result.is_boolean() {
            return Err(native_transport_error(try_catch, FAILED));
        }
        Ok(result.is_true())
    }

    fn dispatch_route_notification(
        &mut self,
        name: &str,
        encoded: &str,
    ) -> Result<bool, container_core::EngineError> {
        const FAILED: &str = "route notification dispatch failed";
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        v8::tc_scope!(let try_catch, scope);
        let dispatch = self.route_notification.as_ref().ok_or_else(|| {
            container_core::EngineError::new(container_core::EngineErrorCode::Call, FAILED)
        })?;
        let dispatch = v8::Local::new(try_catch, dispatch);
        let name = v8::String::new(try_catch, name)
            .ok_or_else(|| native_transport_error(try_catch, FAILED))?;
        let text = v8::String::new(try_catch, encoded)
            .ok_or_else(|| native_transport_error(try_catch, FAILED))?;
        let receiver = context.global(try_catch);
        let result = dispatch
            .call(try_catch, receiver.into(), &[name.into(), text.into()])
            .ok_or_else(|| native_transport_error(try_catch, FAILED))?;
        if !result.is_boolean() {
            return Err(native_transport_error(try_catch, FAILED));
        }
        Ok(result.is_true())
    }

    fn capture_receiver_incarnations(
        &mut self,
        encoded: &str,
    ) -> Result<String, container_core::EngineError> {
        const FAILED: &str = "native receiver identity unavailable";
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        v8::tc_scope!(let try_catch, scope);
        let capture = self.receiver_incarnations.as_ref().ok_or_else(|| {
            container_core::EngineError::new(container_core::EngineErrorCode::Call, FAILED)
        })?;
        let capture = v8::Local::new(try_catch, capture);
        let text = v8::String::new(try_catch, encoded)
            .ok_or_else(|| native_transport_error(try_catch, FAILED))?;
        let payload = v8::json::parse(try_catch, text)
            .ok_or_else(|| native_transport_error(try_catch, FAILED))?;
        let receiver = context.global(try_catch);
        let result = capture
            .call(try_catch, receiver.into(), &[payload])
            .ok_or_else(|| native_transport_error(try_catch, FAILED))?;
        // The trusted getter already encoded a private, null-prototype record.
        // Do not invoke an application's toString or JSON serialization hook.
        let text = v8::Local::<v8::String>::try_from(result)
            .map_err(|_| native_transport_error(try_catch, FAILED))?;
        Ok(text.to_rust_string_lossy(try_catch))
    }

    fn invoke_receiver_event(&mut self, encoded: &str) -> Result<String, String> {
        const FAILED: &str = "native receiver event invocation failed";
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        v8::tc_scope!(let try_catch, scope);
        let invoke = v8::Local::new(try_catch, self.receiver_event.as_ref().ok_or(FAILED)?);
        let text = v8::String::new(try_catch, encoded).ok_or(FAILED)?;
        let payload = v8::json::parse(try_catch, text).ok_or(FAILED)?;
        let receiver = context.global(try_catch);
        let result = invoke
            .call(try_catch, receiver.into(), &[payload])
            .ok_or_else(|| exception_message(try_catch).unwrap_or_else(|| FAILED.into()))?;
        let text = v8::Local::<v8::String>::try_from(result).map_err(|_| FAILED)?;
        Ok(text.to_rust_string_lossy(try_catch))
    }

    fn call_batch(
        &mut self,
        module_id: Option<u64>,
        name: &str,
        args: &str,
    ) -> Result<String, String> {
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, &self.context);
        v8::scope_with_context!(let scope, scope, context);
        v8::tc_scope!(let try_catch, scope);
        let function = v8::Local::new(
            try_catch,
            self.batch_call
                .as_ref()
                .ok_or("V8 batch caller is unavailable")?,
        );
        let source =
            v8::String::new(try_catch, args).ok_or("V8 could not allocate argument batch")?;
        let values = v8::json::parse(try_catch, source).ok_or_else(|| {
            exception_message(try_catch)
                .unwrap_or_else(|| "V8 could not parse argument batch".into())
        })?;
        let module_id: v8::Local<v8::Value> = match module_id {
            Some(id) => v8::Number::new(try_catch, id as f64).into(),
            None => v8::null(try_catch).into(),
        };
        let name = v8::String::new(try_catch, name).ok_or("V8 could not allocate call target")?;
        let receiver = context.global(try_catch);
        let result = function
            .call(
                try_catch,
                receiver.into(),
                &[module_id, name.into(), values],
            )
            .ok_or_else(|| {
                exception_message(try_catch).unwrap_or_else(|| "V8 batch call failed".into())
            })?;
        let encoded = v8::Local::<v8::String>::try_from(result)
            .map_err(|_| "V8 batch call did not return JSON")?;
        Ok(encoded.to_rust_string_lossy(try_catch))
    }

    fn run_bootstrap(&mut self, name: &str, source: &str) -> Result<(), String> {
        // Setup scripts publish globals and have no return-value contract.
        // Their completion value can be a null-prototype object; coercing it
        // to String would throw even after setup itself completed correctly.
        self.run_script_value(source, false)
            .map(|_| ())
            .map_err(|message| format!("{name} bootstrap failed: {message}"))
    }

    #[cfg(test)]
    fn run_script(&mut self, source: &str) -> Result<String, String> {
        self.run_script_value(source, true)
    }

    fn run_script_value(&mut self, source: &str, encode_result: bool) -> Result<String, String> {
        let context_global = &self.context;
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, context_global);
        v8::scope_with_context!(let scope, scope, context);
        v8::tc_scope!(let try_catch, scope);
        let source = v8::String::new(try_catch, source)
            .ok_or_else(|| "V8 could not allocate script source".to_owned())?;
        let script = v8::Script::compile(try_catch, source, None).ok_or_else(|| {
            exception_message(try_catch).unwrap_or_else(|| "V8 script compilation failed".into())
        })?;
        let result = script.run(try_catch).ok_or_else(|| {
            exception_message(try_catch).unwrap_or_else(|| "V8 script execution failed".into())
        })?;
        if !encode_result {
            return Ok(String::new());
        }
        let result = result.to_string(try_catch).ok_or_else(|| {
            exception_message(try_catch).unwrap_or_else(|| "V8 result is not a string".into())
        })?;
        Ok(result.to_rust_string_lossy(try_catch))
    }
}

#[cfg(feature = "v8-native")]
fn exception_message(
    scope: &mut v8::PinnedRef<'_, v8::TryCatch<v8::HandleScope>>,
) -> Option<String> {
    if scope.has_terminated() || scope.is_execution_terminating() {
        if let Some(resources) =
            scope.get_slot::<std::sync::Arc<container_core::EngineTerminalResources>>()
        {
            resources.retire();
        }
    }
    scope
        .exception()
        .and_then(|exception| exception.to_string(scope))
        .map(|exception| exception.to_rust_string_lossy(scope))
}

#[cfg(all(test, feature = "v8-native"))]
mod api_delivery_tests;
#[cfg(all(test, feature = "v8-native"))]
mod console_tests;
#[cfg(all(test, feature = "v8-native"))]
mod event_channel_tests;

#[cfg(all(test, feature = "v8-native"))]
mod canvas_tests {
    use super::V8Engine as Engine;
    include!("../../container-core/src/canvas-tests.rs");
}

#[cfg(all(test, feature = "v8-native"))]
mod performance_tests {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/performance-engine.rs");
}

#[cfg(all(test, feature = "v8-native"))]
mod animation_tests {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/animation-engine.rs");
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "v8-native")]
    #[test]
    fn atomic_page_publication_and_receivers_ignore_frozen_or_replaced_public_tables() {
        let mut engine = super::V8Engine::default();
        engine
            .set_capabilities(&std::collections::BTreeMap::from([(
                "getCurrentPages".into(),
                "full".into(),
            )]))
            .unwrap();
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"
            Page({data:{count:0},onLoad(){this.setData({count:this.data.count+1});}});
            exports.sabotage=function(){
                Object.freeze(globalThis.__container_page_instances);
                Object.defineProperty(globalThis,'__container_page_instances',{
                    value:Object.freeze(Object.create(null)),writable:false,configurable:false});
            };
            exports.snapshot=function(){return getCurrentPages().map(page=>page.data);};
        "#,
        )
        .unwrap();
        let first =
            serde_json::json!([{"index":0,"instanceId":1,"route":"pages/index","options":{}}]);
        engine.prepare_page_mirror("first", &first).unwrap();
        engine.commit_page_mirror("first").unwrap();
        let initial = engine.capture_receiver_incarnations(1, &[]).unwrap();
        let second = serde_json::json!([
            {"index":0,"instanceId":1,"route":"pages/index","options":{}},
            {"index":0,"instanceId":2,"route":"pages/index","options":{}}
        ]);
        engine.prepare_page_mirror("second", &second).unwrap();
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "sabotage".into(),
            },
            vec![],
        )
        .unwrap();
        engine.commit_page_mirror("second").unwrap();
        assert_eq!(
            engine.capture_receiver_incarnations(1, &[]).unwrap(),
            initial
        );
        let next = engine.capture_receiver_incarnations(2, &[]).unwrap();
        assert_ne!(initial["pageToken"], next["pageToken"]);
        let admission = engine
            .invoke_receiver_event(2, &next, &serde_json::json!({"dispatches":[]}), false)
            .unwrap();
        assert_eq!(admission["retired"], false);
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_page_instance".into(),
            },
            vec![
                serde_json::json!(2),
                serde_json::json!(0),
                serde_json::json!("onLoad"),
                serde_json::json!([]),
            ],
        )
        .unwrap();
        let snapshot = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "snapshot".into(),
            },
            vec![],
        )
        .unwrap();
        assert_eq!(
            snapshot,
            vec![
                serde_json::json!({"count":0}),
                serde_json::json!({"count":1})
            ]
        );
    }
    use super::*;

    #[test]
    fn execution_error_conversion_preserves_control_codes() {
        for code in [
            container_core::EngineErrorCode::Timeout,
            container_core::EngineErrorCode::Interrupted,
            container_core::EngineErrorCode::Cancelled,
            container_core::EngineErrorCode::RequiresRestart,
            container_core::EngineErrorCode::UnsupportedExecutionBudget,
        ] {
            let error = container_core::EngineError::new(code, "original execution fault");
            assert_eq!(
                EngineError::Execution(error.clone()).into_core_error(),
                error
            );
        }
        assert_eq!(
            EngineError::Interrupted.into_core_error().code,
            container_core::EngineErrorCode::Interrupted
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn interrupted_storage_and_lifecycle_controls_keep_termination_typed() {
        let mut engine = V8Engine::default();
        JsEngineAdapter::interrupt(&mut engine);
        let errors = [
            engine.enable_deferred_storage_commit().unwrap_err(),
            engine.acknowledge_storage_transactions(0).unwrap_err(),
            engine
                .dispatch_lifecycle_notification("app.show", &serde_json::json!({}))
                .unwrap_err(),
            engine.pending_storage_transactions().unwrap_err(),
            engine.drain_host_events().unwrap_err(),
            engine.drain_timers(0).unwrap_err(),
        ];
        for error in errors {
            assert_eq!(
                error.into_core_error().code,
                container_core::EngineErrorCode::Interrupted
            );
        }
    }

    #[cfg(feature = "v8-native")]
    fn assert_native_control_termination(kind: &str) {
        let mut engine = V8Engine::default();
        if kind == "lifecycle" {
            container_core::JsEngine::load_module(
                &mut engine,
                b"wx.onAppShow(function() { for (;;) {} });",
            )
            .unwrap();
        } else {
            // A test-only retained function makes these trusted boundaries
            // long-running without adding application probes to production.
            let native = engine.native.as_mut().unwrap();
            let function = {
                let mut isolate = native.isolate.lock();
                v8::scope!(let scope, &mut *isolate);
                let context = v8::Local::new(scope, &native.context);
                v8::scope_with_context!(let scope, scope, context);
                let source = v8::String::new(scope, "(function() { for (;;) {} })").unwrap();
                let script = v8::Script::compile(scope, source, None).unwrap();
                let result = script.run(scope).unwrap();
                let function = v8::Local::<v8::Function>::try_from(result).unwrap();
                v8::Global::new(scope, function)
            };
            match kind {
                "ack" => native.host_environment = Some(function),
                "pending" => native.receiver_incarnations = Some(function),
                _ => unreachable!(),
            }
        }
        let handle = engine.native.as_ref().unwrap().isolate.thread_safe_handle();
        let terminator = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(10));
            assert!(handle.terminate_execution());
        });
        assert!(!engine.interrupted);
        let result = match kind {
            "ack" => engine.acknowledge_storage_transactions(0),
            "lifecycle" => engine
                .dispatch_lifecycle_notification("show", &serde_json::json!({}))
                .map(|_| ()),
            "pending" => engine.pending_storage_transactions().map(|_| ()),
            _ => unreachable!(),
        };
        terminator.join().unwrap();
        let error = result.unwrap_err().into_core_error();
        assert_eq!(
            error.code,
            container_core::EngineErrorCode::Interrupted,
            "{kind}: {error}"
        );
        assert!(engine.interrupted, "{kind} must latch native termination");
        assert_eq!(
            engine
                .enable_deferred_storage_commit()
                .unwrap_err()
                .into_core_error()
                .code,
            container_core::EngineErrorCode::Interrupted,
            "{kind} must reject later policy changes without JavaScript"
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn native_storage_ack_boundary_keeps_termination_typed() {
        assert_native_control_termination("ack");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn native_lifecycle_notification_boundary_keeps_termination_typed() {
        assert_native_control_termination("lifecycle");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn native_pending_storage_boundary_keeps_termination_typed() {
        assert_native_control_termination("pending");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn dom_query_environment_preparation_does_not_run_application_microtasks() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(&mut engine, br#"
          exports.enqueue = () => { Promise.resolve().then(() => {globalThis.__queryMicrotask = true}); return true; };
          exports.read = () => ({ran:globalThis.__queryMicrotask === true,enabled:__container_dom_query_enabled()});
        "#).unwrap();
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "enqueue".into(),
            },
            vec![],
        )
        .unwrap();
        engine.set_dom_query_contract(true).unwrap();
        let before = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "read".into(),
            },
            vec![],
        )
        .unwrap();
        assert_eq!(before[0], serde_json::json!({"ran":false,"enabled":true}));
        container_core::JsEngine::drain_microtasks(&mut engine).unwrap();
        let after = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "read".into(),
            },
            vec![],
        )
        .unwrap();
        assert_eq!(after[0], serde_json::json!({"ran":true,"enabled":true}));
    }

    #[test]
    #[cfg(feature = "v8-native")]
    fn bootstrap_discards_noncoercible_completion_and_names_setup_failures() {
        let mut native = NativeV8::new(&V8Config::default()).expect("native bootstrap succeeds");
        native
            .run_bootstrap(
                "completion-test",
                "globalThis.__bootstrap_completion_probe = 41; Object.create(null);",
            )
            .expect("a bootstrap completion value needs no string conversion");
        assert_eq!(
            native.run_script("String(__bootstrap_completion_probe + 1)"),
            Ok("42".into())
        );
        let error = native
            .run_bootstrap("failure-test", "throw new Error('setup failed')")
            .expect_err("actual setup exceptions remain errors");
        assert!(error.contains("failure-test bootstrap failed"));
        assert!(error.contains("setup failed"));
    }

    #[test]
    fn loads_modules_in_one_batch() {
        let mut engine = V8Engine::default();
        if engine.mode() == EngineMode::V8 {
            assert_eq!(
                engine.load_module_batch(&[b"exports.entry = () => 1", b"exports.page = () => 2"]),
                Ok(2)
            );
            assert_eq!(engine.loaded_module_count(), 2);
        } else {
            assert_eq!(
                engine.load_module_batch(&[b"entry", b"page"]),
                Err(EngineError::NativeBackendUnavailable)
            );
        }
    }

    #[test]
    fn reports_selected_backend_mode() {
        let engine = V8Engine::default();
        assert_eq!(engine.engine_name(), "v8");
        assert!(matches!(
            engine.mode(),
            EngineMode::Stub | EngineMode::V8 | EngineMode::Unavailable
        ));
    }

    #[test]
    fn implements_core_batch_engine_contract() {
        let mut engine = V8Engine::default();
        if engine.mode() == EngineMode::V8 {
            let module = container_core::JsEngine::load_module(
                &mut engine,
                b"exports.entry = (...args) => args",
            )
            .unwrap();
            let values = container_core::JsEngine::call(
                &mut engine,
                container_core::CallTarget::Module {
                    id: module,
                    export: "entry".into(),
                },
                vec![serde_json::json!({ "ready": true })],
            )
            .unwrap();
            assert_eq!(values, vec![serde_json::json!({ "ready": true })]);
        } else {
            assert!(container_core::JsEngine::load_module(&mut engine, b"module").is_err());
        }
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn executes_commonjs_module_exports_and_microtasks() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let module = container_core::JsEngine::load_module(
            &mut engine,
            b"exports.add = (left, right) => left + right; exports.enqueue = (value) => Promise.resolve(value)",
        )
        .expect("module evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "add".into(),
            },
            vec![serde_json::json!(2), serde_json::json!(3)],
        )
        .expect("export is callable");
        assert_eq!(result, vec![serde_json::json!(5)]);
        container_core::JsEngine::drain_microtasks(&mut engine).expect("microtasks drain");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn generated_app_registration_is_invokable_through_batch_boundary() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        container_core::JsEngine::load_module(
            &mut engine,
            b"App({ onLaunch(options) { return options.ready ? 'launched' : 'cold'; } }); Page({});",
        )
        .expect("registration module evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_app".into(),
            },
            vec![
                serde_json::json!("onLaunch"),
                serde_json::json!([{"ready": true}]),
            ],
        )
        .expect("App.onLaunch is callable");
        assert_eq!(result, vec![serde_json::json!("launched")]);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn wx_storage_and_page_set_data_are_real_js_operations() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"Page({ data: { user: { name: 'Ada' }, stale: true } });
                exports.run = function() {
                  wx.setStorageSync({ key: 'profile', data: { name: 'Ada' } });
                  wx.setStorage({ key: 'async', data: 7 });
                  return { sync: wx.getStorageSync('profile'), async: wx.getStorageSync('async'), info: wx.getStorageInfoSync() };
                };"#,
        )
        .expect("module evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("storage calls succeed");
        assert_eq!(
            result,
            vec![serde_json::json!({
                "sync": {"name": "Ada"},
                "async": 7,
                "info": {"keys": ["async", "profile"], "currentSize": 1, "limitSize": 10240, "errMsg": "getStorageInfo:ok"}
            })]
        );
        let page = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_page".into(),
            },
            vec![
                serde_json::json!(0),
                serde_json::json!("setData"),
                serde_json::json!([{"user.name": "Lin"}]),
            ],
        )
        .expect("setData hook is callable");
        assert_eq!(page[0]["path"], "user.name");
        let events = engine.drain_host_events().expect("events drain");
        assert_eq!(events[0]["events"][0]["type"], "storage.patch.batch");
        assert_eq!(events[0]["events"][0]["patches"][0]["key"], "profile");
        assert_eq!(events[0]["events"][1]["type"], "storage.patch.batch");
        assert_eq!(events[0]["events"][1]["patches"][0]["key"], "async");
        assert_eq!(events[0]["events"][2]["type"], "data.patch.batch");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn storage_info_counts_key_and_value_utf8_pair_bytes() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              wx.setStorageSync({ key: 'k'.repeat(1020), data: 'v' });
              return wx.getStorageInfoSync();
            };"#,
        )
        .expect("storage size fixture evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("storage size fixture runs");
        assert_eq!(result[0]["currentSize"], 2);
        assert_eq!(result[0]["errMsg"], "getStorageInfo:ok");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn sync_system_apis_and_filesystem_manager_keep_sync_and_async_shapes() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let mut capabilities = std::collections::BTreeMap::new();
        for name in [
            "wx.getSystemInfoSync",
            "wx.getAppBaseInfo",
            "wx.getDeviceInfo",
            "wx.getWindowInfo",
            "wx.getMenuButtonBoundingClientRect",
            "wx.getAccountInfoSync",
            "wx.getExtConfigSync",
            "wx.getAppAuthorizeSetting",
            "wx.getLaunchOptionsSync",
            "wx.getEnterOptionsSync",
            "wx.getFileSystemManager",
        ] {
            capabilities.insert(name.to_string(), "partial".to_string());
        }
        engine
            .set_capabilities(&capabilities)
            .expect("capability map installs");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_set_sync_api_values".into(),
            },
            vec![
                serde_json::json!({
                    "wx.getSystemInfoSync": {"SDKVersion": "3.17.3"},
                    "wx.getAppBaseInfo": {"version": "1.0.0"},
                    "wx.getDeviceInfo": {"brand": "Apple", "model": "iPhone 15 Pro", "abi": "arm64-v8a", "cpuType": "A17 Pro", "memorySize": 8192, "benchmarkLevel": 42, "platform": "test", "system": "iOS 17.6"},
                    "wx.getWindowInfo": {"pixelRatio": 3, "screenWidth": 393, "screenHeight": 852, "windowWidth": 375, "windowHeight": 759, "statusBarHeight": 59, "safeArea": {"left": 0, "right": 393, "top": 59, "bottom": 818, "width": 393, "height": 759}, "screenTop": 59},
                    "wx.getMenuButtonBoundingClientRect": {"left": 278, "right": 365, "top": 56, "bottom": 88, "width": 87, "height": 32},
                    "wx.getAccountInfoSync": {"miniProgram": {"appId": "wxa-test", "envVersion": "develop", "version": "1.2.3"}},
                    "wx.getExtConfigSync": {"extConfig": {"source": "sandbox", "revision": 2}},
                    "wx.getAppAuthorizeSetting": {"cameraAuthorized": "not determined", "locationAuthorized": "authorized", "microphoneAuthorized": "denied", "notificationAuthorized": "not determined", "notificationAlertAuthorized": "not determined", "notificationBadgeAuthorized": "not determined", "notificationSoundAuthorized": "not determined", "albumAuthorized": "authorized"},
                    "wx.getLaunchOptionsSync": {"scene": 1001}
                    ,"wx.getEnterOptionsSync": {"scene": 1001}
                }),
                serde_json::json!({}),
            ],
        )
        .expect("sync values install");
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
                const manager = wx.getFileSystemManager();
                manager.readFile({ filePath: '/hello.txt', success: function(value) {
                  globalThis.__read_success = value.data;
                }, complete: function() { globalThis.__read_complete = true; } });
                let syncError = null;
                try { manager.readFileSync({ filePath: '/hello.txt' }); }
                catch (error) { syncError = error.code; }
                return {
                  sdk: wx.getSystemInfoSync().SDKVersion,
                  appVersion: wx.getAppBaseInfo().version,
                  brand: wx.getDeviceInfo().brand,
                  model: wx.getDeviceInfo().model,
                  abi: wx.getDeviceInfo().abi,
                  memorySize: wx.getDeviceInfo().memorySize,
                  benchmarkLevel: wx.getDeviceInfo().benchmarkLevel,
                  platform: wx.getDeviceInfo().platform,
                  width: wx.getWindowInfo().windowWidth,
                  safeTop: wx.getWindowInfo().safeArea.top,
                  screenTop: wx.getWindowInfo().screenTop,
                  menuWidth: wx.getMenuButtonBoundingClientRect().width,
                  menuRight: wx.getMenuButtonBoundingClientRect().right,
                  accountId: wx.getAccountInfoSync().miniProgram.appId,
                  extSource: wx.getExtConfigSync().extConfig.source,
                  extRevision: wx.getExtConfigSync().extConfig.revision,
                  locationAuthorization: wx.getAppAuthorizeSetting().locationAuthorized,
                  albumAuthorization: wx.getAppAuthorizeSetting().albumAuthorized,
                  scene: wx.getLaunchOptionsSync().scene,
                  enterScene: wx.getEnterOptionsSync().scene,
                  hasRead: typeof manager.readFile === 'function',
                  syncError: syncError
                };
              };
              exports.status = function() {
                return { success: globalThis.__read_success, complete: !!globalThis.__read_complete };
              };"#,
        )
        .expect("module evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("sync APIs evaluate");
        assert_eq!(result[0]["sdk"], "3.17.3");
        assert_eq!(result[0]["appVersion"], "1.0.0");
        assert_eq!(result[0]["brand"], "Apple");
        assert_eq!(result[0]["model"], "iPhone 15 Pro");
        assert_eq!(result[0]["abi"], "arm64-v8a");
        assert_eq!(result[0]["memorySize"], 8192);
        assert_eq!(result[0]["benchmarkLevel"], 42);
        assert_eq!(result[0]["platform"], "test");
        assert_eq!(result[0]["width"], 375);
        assert_eq!(result[0]["safeTop"], 59);
        assert_eq!(result[0]["screenTop"], 59);
        assert_eq!(result[0]["menuWidth"], 87);
        assert_eq!(result[0]["menuRight"], 365);
        assert_eq!(result[0]["accountId"], "wxa-test");
        assert_eq!(result[0]["extSource"], "sandbox");
        assert_eq!(result[0]["extRevision"], 2);
        assert_eq!(result[0]["locationAuthorization"], "authorized");
        assert_eq!(result[0]["albumAuthorization"], "authorized");
        assert_eq!(result[0]["scene"], 1001);
        assert_eq!(result[0]["enterScene"], 1001);
        assert_eq!(result[0]["hasRead"], true);
        assert_eq!(result[0]["syncError"], "ERR_UNSUPPORTED_CAPABILITY");
        let events = engine.drain_host_events().expect("filesystem call drains");
        let event = &events[0]["events"][0];
        assert_eq!(event["name"], "wx.fs.readFile");
        let request_id = event["id"].as_u64().expect("request id");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![
                request_id.into(),
                serde_json::json!({"data": "hello"}),
                serde_json::Value::Null,
            ],
        )
        .expect("filesystem callback resolves");
        container_core::JsEngine::drain_microtasks(&mut engine)
            .expect("filesystem callbacks drain");
        let status = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "status".into(),
            },
            Vec::new(),
        )
        .expect("callback status reads");
        assert_eq!(status[0]["success"], "hello");
        assert_eq!(status[0]["complete"], true);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn filesystem_readdir_facade_uses_sync_snapshot_and_async_provider() {
        let mut engine = V8Engine::default();
        engine
            .set_capabilities(&std::collections::BTreeMap::from([(
                "wx.getFileSystemManager".to_owned(),
                "partial".to_owned(),
            )]))
            .expect("filesystem capability installs");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_set_sync_files".into(),
            },
            vec![serde_json::json!({
                "docs/a.txt": {"bytes": [97], "text": "a"},
                "docs/nested/value.json": {"bytes": [123, 125], "text": "{}"},
                "docs/z.txt": {"bytes": [122], "text": "z"}
            })],
        )
        .expect("filesystem snapshot installs");
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              const manager = wx.getFileSystemManager();
              manager.readdir({ dirPath: '/docs', success: function(value) { globalThis.__readdir = value; } });
              return { canUse: wx.canIUse('wx.fs.readdir'), sync: manager.readdirSync({ dirPath: '/docs' }), hasAsync: typeof manager.readdir === 'function' };
            };
            exports.value = function() { return globalThis.__readdir || null; };"#,
        )
        .expect("readdir facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("readdir facade runs");
        assert_eq!(result[0]["canUse"], true);
        assert_eq!(
            result[0]["sync"],
            serde_json::json!(["a.txt", "nested", "z.txt"])
        );
        assert_eq!(result[0]["hasAsync"], true);
        let events = engine.drain_host_events().expect("readdir event drains");
        let event = &events[0]["events"][0];
        assert_eq!(event["name"], "wx.fs.readdir");
        assert_eq!(event["options"]["dirPath"], "/docs");
        let request_id = event["id"].as_u64().expect("request id");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![
                request_id.into(),
                serde_json::json!({"files": ["a.txt", "nested", "z.txt"], "errMsg": "readdir:ok"}),
                serde_json::Value::Null,
            ],
        )
        .expect("readdir callback resolves");
        container_core::JsEngine::drain_microtasks(&mut engine).expect("readdir callback drains");
        let value = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "value".into(),
            },
            Vec::new(),
        )
        .expect("readdir callback value reads");
        assert_eq!(
            value[0]["files"],
            serde_json::json!(["a.txt", "nested", "z.txt"])
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn ext_config_async_facade_queues_provider_call() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              wx.getExtConfig({ success: function(value) { globalThis.__ext_config = value; } });
              return typeof wx.getExtConfig;
            };
            exports.value = function() { return globalThis.__ext_config || null; };"#,
        )
        .expect("ext config facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("ext config call queues");
        assert_eq!(result, vec![serde_json::json!("function")]);
        let events = engine.drain_host_events().expect("ext config event drains");
        let event = &events[0]["events"][0];
        assert_eq!(event["name"], "wx.getExtConfig");
        let request_id = event["id"].as_u64().expect("request id");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![
                request_id.into(),
                serde_json::json!({"extConfig": {"source": "sandbox"}}),
                serde_json::Value::Null,
            ],
        )
        .expect("ext config callback resolves");
        container_core::JsEngine::drain_microtasks(&mut engine).expect("callback drains");
        let value = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "value".into(),
            },
            Vec::new(),
        )
        .expect("ext config callback value reads");
        assert_eq!(value[0]["extConfig"]["source"], "sandbox");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn device_facade_preserves_battery_and_clipboard_callbacks() {
        let mut engine = V8Engine::default();
        let capabilities = [
            ("wx.getBatteryInfo", "partial"),
            ("wx.getScreenBrightness", "partial"),
            ("wx.setScreenBrightness", "partial"),
            ("wx.setClipboardData", "partial"),
            ("wx.getClipboardData", "partial"),
        ]
        .into_iter()
        .map(|(name, support)| (name.to_owned(), support.to_owned()))
        .collect();
        engine
            .set_capabilities(&capabilities)
            .expect("device capabilities install");
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              wx.getBatteryInfo({ success: function(value) { globalThis.__battery = value; } });
              wx.getScreenBrightness({ success: function(value) { globalThis.__brightness = value; } });
              wx.setScreenBrightness({ value: 0.42, success: function(value) { globalThis.__setBrightness = value; } });
              wx.setClipboardData({ data: 'hello', success: function(value) { globalThis.__set = value; } });
              wx.getClipboardData({ success: function(value) { globalThis.__get = value; } });
              return { battery: typeof wx.getBatteryInfo, brightness: typeof wx.getScreenBrightness, setBrightness: typeof wx.setScreenBrightness, set: typeof wx.setClipboardData, get: typeof wx.getClipboardData };
            };
            exports.value = function() { return { battery: globalThis.__battery || null, brightness: globalThis.__brightness || null, setBrightness: globalThis.__setBrightness || null, set: globalThis.__set || null, get: globalThis.__get || null }; };"#,
        )
        .expect("device facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("device calls queue");
        assert_eq!(result[0]["battery"], "function");
        assert_eq!(result[0]["brightness"], "function");
        assert_eq!(result[0]["setBrightness"], "function");
        assert_eq!(result[0]["set"], "function");
        assert_eq!(result[0]["get"], "function");
        let events = engine.drain_host_events().expect("device events drain");
        assert_eq!(events[0]["events"].as_array().unwrap().len(), 5);
        for event in events[0]["events"].as_array().unwrap() {
            let name = event["name"].as_str().unwrap();
            let request_id = event["id"].as_u64().unwrap();
            let response = match name {
                "wx.getBatteryInfo" => {
                    serde_json::json!({"level": 42, "isCharging": true, "errMsg": "getBatteryInfo:ok"})
                }
                "wx.getScreenBrightness" => {
                    serde_json::json!({"value": 0.75, "errMsg": "getScreenBrightness:ok"})
                }
                "wx.setScreenBrightness" => serde_json::json!({"errMsg": "setScreenBrightness:ok"}),
                "wx.setClipboardData" => serde_json::json!({"errMsg": "setClipboardData:ok"}),
                "wx.getClipboardData" => {
                    serde_json::json!({"data": "hello", "errMsg": "getClipboardData:ok"})
                }
                other => panic!("unexpected device API {other}"),
            };
            container_core::JsEngine::call(
                &mut engine,
                container_core::CallTarget::Global {
                    name: "__container_resolve_api".into(),
                },
                vec![request_id.into(), response, serde_json::Value::Null],
            )
            .expect("device callback resolves");
        }
        container_core::JsEngine::drain_microtasks(&mut engine).expect("device callbacks drain");
        let value = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "value".into(),
            },
            Vec::new(),
        )
        .expect("device callback values read");
        assert_eq!(value[0]["battery"]["level"], 42);
        assert_eq!(value[0]["brightness"]["value"], 0.75);
        assert_eq!(
            value[0]["setBrightness"]["errMsg"],
            "setScreenBrightness:ok"
        );
        assert_eq!(value[0]["set"]["errMsg"], "setClipboardData:ok");
        assert_eq!(value[0]["get"]["data"], "hello");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn network_status_listener_registers_dispatches_and_unsubscribes() {
        let mut engine = V8Engine::default();
        engine
            .set_capabilities(&std::collections::BTreeMap::from([(
                "wx.onNetworkStatusChange".to_owned(),
                "partial".to_owned(),
            )]))
            .expect("network status capability installs");
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.register = function() {
              globalThis.__network_statuses = [];
              globalThis.__network_handler = function(status) { globalThis.__network_statuses.push(status); };
              wx.onNetworkStatusChange(globalThis.__network_handler);
              return { canUse: wx.canIUse('wx.onNetworkStatusChange'), type: typeof wx.onNetworkStatusChange };
            };
            exports.statuses = function() { return globalThis.__network_statuses || []; };
            exports.unregister = function() { wx.offNetworkStatusChange(globalThis.__network_handler); };"#,
        )
        .expect("network status facade loads");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "register".into(),
            },
            Vec::new(),
        )
        .expect("network status listener registers");
        assert_eq!(result[0]["canUse"], true);
        assert_eq!(result[0]["type"], "function");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_dispatch_network_status".into(),
            },
            vec![serde_json::json!({"networkType":"wifi", "isConnected":true})],
        )
        .expect("network status dispatches");
        container_core::JsEngine::drain_microtasks(&mut engine).expect("network callback drains");
        let statuses = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "statuses".into(),
            },
            Vec::new(),
        )
        .expect("network status reads");
        assert_eq!(statuses[0]["networkType"], "wifi");
        let events = engine
            .drain_host_events()
            .expect("network status event drains");
        assert_eq!(events[0]["events"][0]["type"], "network.status.change");
        assert_eq!(events[0]["events"][0]["count"], 1);
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "unregister".into(),
            },
            Vec::new(),
        )
        .expect("network status listener unregisters");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_dispatch_network_status".into(),
            },
            vec![serde_json::json!({"networkType":"none", "isConnected":false})],
        )
        .expect("network status second dispatches");
        let events = engine
            .drain_host_events()
            .expect("network status second event drains");
        assert_eq!(events[0]["events"][0]["count"], 0);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn battery_sync_facade_reads_provider_snapshot_without_bridge_event() {
        let mut engine = V8Engine::default();
        engine
            .set_capabilities(&std::collections::BTreeMap::from([(
                "wx.getBatteryInfoSync".to_owned(),
                "partial".to_owned(),
            )]))
            .expect("battery sync capability installs");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_set_sync_api_values".into(),
            },
            vec![
                serde_json::json!({
                    "wx.getBatteryInfoSync": {
                        "level": 37,
                        "isCharging": true,
                        "errMsg": "getBatteryInfoSync:ok"
                    }
                }),
                serde_json::json!({}),
            ],
        )
        .expect("battery sync snapshot installs");
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              return { type: typeof wx.getBatteryInfoSync, value: wx.getBatteryInfoSync() };
            };"#,
        )
        .expect("battery sync fixture evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("battery sync fixture runs");
        assert_eq!(result[0]["type"], "function");
        assert_eq!(result[0]["value"]["level"], 37);
        assert_eq!(result[0]["value"]["isCharging"], true);
        let events = engine.drain_host_events().expect("drain host events");
        assert!(events
            .iter()
            .flat_map(|batch| batch["events"].as_array().into_iter().flatten())
            .all(|event| event["name"] != "wx.getBatteryInfoSync"));
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn user_profile_facade_preserves_desc_and_callback_order() {
        let mut engine = V8Engine::default();
        let mut capabilities = std::collections::BTreeMap::new();
        capabilities.insert("wx.getUserProfile".to_owned(), "partial".to_owned());
        engine
            .set_capabilities(&capabilities)
            .expect("profile capability installs");
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              wx.getUserProfile({
                desc: 'Personalize your profile',
                success: function(value) { globalThis.__profile_success = value; },
                complete: function(value) { globalThis.__profile_complete = value.errMsg; }
              });
              return wx.canIUse('wx.getUserProfile');
            };
            exports.status = function() {
              return { success: globalThis.__profile_success || null, complete: globalThis.__profile_complete || null };
            };"#,
        )
        .expect("profile facade evaluates");
        let supported = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("profile call queues");
        assert_eq!(supported, vec![serde_json::json!(true)]);
        let events = engine.drain_host_events().expect("profile event drains");
        let event = &events[0]["events"][0];
        assert_eq!(event["name"], "wx.getUserProfile");
        assert_eq!(event["options"]["desc"], "Personalize your profile");
        let request_id = event["id"].as_u64().expect("request id");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![
                request_id.into(),
                serde_json::json!({
                    "userInfo": {
                        "nickName": "Ada",
                        "avatarUrl": "https://example.test/avatar.png",
                        "gender": 1,
                        "country": "US",
                        "province": "CA",
                        "city": "San Francisco",
                        "language": "en"
                    },
                    "errMsg": "getUserProfile:ok"
                }),
                serde_json::Value::Null,
            ],
        )
        .expect("profile callback resolves");
        container_core::JsEngine::drain_microtasks(&mut engine).expect("profile callbacks drain");
        let status = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "status".into(),
            },
            Vec::new(),
        )
        .expect("profile status reads");
        assert_eq!(status[0]["success"]["userInfo"]["nickName"], "Ada");
        assert_eq!(status[0]["complete"], "getUserProfile:ok");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn selector_query_is_fluent_and_crosses_the_bridge_once() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              return wx.createSelectorQuery()
                .selectAll('.card')
                .boundingClientRect({ id: true, width: true })
                .exec(function(value) { globalThis.__selector_result = value; });
            };"#,
        )
        .expect("selector facade evaluates");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("selector query call is queued");
        let events = engine
            .drain_host_events()
            .expect("selector event is drained");
        assert_eq!(events[0]["events"].as_array().unwrap().len(), 1);
        let event = &events[0]["events"][0];
        assert_eq!(event["name"], "wx.createSelectorQuery");
        assert_eq!(event["options"]["queries"][0]["selector"], ".card");
        assert_eq!(event["options"]["queries"][0]["all"], true);
        assert_eq!(event["options"]["queries"].as_array().unwrap().len(), 1);
        assert_eq!(event["options"]["queries"][0]["fields"]["id"], true);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn selector_query_scroll_offset_is_a_batched_operation() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              return wx.createSelectorQuery().select('#scroll').scrollOffset().exec();
            };"#,
        )
        .expect("selector scroll facade evaluates");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("selector scroll query is queued");
        let events = engine
            .drain_host_events()
            .expect("selector event is drained");
        let event = &events[0]["events"][0];
        assert_eq!(event["name"], "wx.createSelectorQuery");
        assert_eq!(event["options"]["queries"][0]["selector"], "#scroll");
        assert_eq!(event["options"]["queries"][0]["operation"], "scrollOffset");
        assert_eq!(event["options"]["queries"].as_array().unwrap().len(), 1);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn selector_query_fields_and_viewport_are_explicit_operations() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"Page({});
            __container_set_current_pages([0], [{index:0,instanceId:1}]);
            __container_registration_module_id = 'selector:fields';
            __container_managed_component_modules['selector:fields'] = true;
            Component({});
            __container_registration_module_id = null;
            __container_reconcile_components({version:1,phase:'prepare',pageId:1,instances:[{
              scopeId:'component',moduleId:'selector:fields',parentScopeId:null,ownerScopeId:null,properties:{}
            }],remove:[]});
            exports.run = function() {
              wx.createSelectorQuery().select('.card').in(__container_component_scopes.component).fields({
                properties: ['aria-label'], computedStyle: ['color'], mark: true,
                node: true, context: true
              }).exec();
              wx.createSelectorQuery().selectViewport().fields({ rect: true, size: true }).exec();
            };"#,
        )
        .expect("selector fields facade evaluates");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("selector fields calls are queued");
        let events = engine
            .drain_host_events()
            .expect("selector events are drained");
        let events = events[0]["events"].as_array().expect("event batch");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["options"]["queries"][0]["operation"], "fields");
        assert_eq!(events[0]["options"]["queries"][0]["scopeId"], "component");
        assert_eq!(
            events[0]["options"]["queries"][0]["fields"]["computedStyle"][0],
            "color"
        );
        assert_eq!(events[1]["options"]["queries"][0]["target"], "viewport");
        assert_eq!(events[1]["options"]["queries"][0]["operation"], "fields");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn observers_validate_and_cross_the_provider_boundary() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              const intersection = wx.createIntersectionObserver({ thresholds: [0.5] })
                .relativeToViewport({ top: 4 });
              intersection.observe('.hero', function(value) { (globalThis.__intersection || (globalThis.__intersection = [])).push(value); });
              const media = wx.createMediaQueryObserver();
              media.observe({ minWidth: 320, orientation: 'portrait' }, function(value) { (globalThis.__media || (globalThis.__media = [])).push(value); });
              return [wx.canIUse('wx.createIntersectionObserver'), wx.canIUse('wx.createMediaQueryObserver')];
            };
            exports.state = function() { return [globalThis.__intersection, globalThis.__media]; };"#,
        )
        .expect("observer facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("observer calls are queued");
        assert_eq!(
            result,
            vec![serde_json::json!(true), serde_json::json!(true)]
        );
        let events = engine.drain_host_events().expect("observer events drain");
        let values = events[0]["events"].as_array().expect("event list");
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["name"], "wx.createIntersectionObserver");
        assert_eq!(values[0]["options"]["action"], "observe");
        assert_eq!(values[0]["options"]["selector"], ".hero");
        assert_eq!(
            values[0]["options"]["options"]["relativeToViewport"]["top"],
            4
        );
        assert_eq!(values[1]["name"], "wx.createMediaQueryObserver");
        assert_eq!(values[1]["options"]["descriptor"]["minWidth"], 320);
        assert_eq!(
            values[1]["options"]["descriptor"]["orientation"],
            "portrait"
        );
        let intersection_id = values[0]["id"].as_u64().unwrap();
        let media_id = values[1]["id"].as_u64().unwrap();
        for (id, value) in [
            (
                intersection_id,
                serde_json::json!({"matches": true, "intersectionRatio": 1.0}),
            ),
            (media_id, serde_json::json!({"matches": false})),
        ] {
            container_core::JsEngine::call(
                &mut engine,
                container_core::CallTarget::Global {
                    name: "__container_resolve_api".into(),
                },
                vec![serde_json::json!(id), value, serde_json::Value::Null],
            )
            .expect("observer response resolves");
        }
        container_core::JsEngine::drain_microtasks(&mut engine).expect("observer callbacks drain");
        let before = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "state".into(),
            },
            Vec::new(),
        )
        .expect("acknowledgement state reads");
        assert_eq!(
            before,
            vec![serde_json::Value::Null, serde_json::Value::Null]
        );
        let acknowledged = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global { name: "__container_notify_observers".into() },
            vec![serde_json::json!([
                {"observerId":values[0]["options"]["observerId"],"subscriptionId":values[0]["options"]["subscriptionId"],"value":{"intersectionRatio":1}},
                {"observerId":values[1]["options"]["observerId"],"subscriptionId":values[1]["options"]["subscriptionId"],"value":{"matches":false}},
                {"observerId":values[0]["options"]["observerId"],"subscriptionId":values[0]["options"]["subscriptionId"],"value":{"intersectionRatio":0.25}},
                {"observerId":values[1]["options"]["observerId"],"subscriptionId":values[1]["options"]["subscriptionId"],"value":{"matches":true}}
            ])],
        ).expect("committed observation batch dispatches");
        assert_eq!(
            acknowledged,
            vec![serde_json::json!({"delivered":4,"ignored":0})]
        );
        let state = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "state".into(),
            },
            Vec::new(),
        )
        .expect("observer state reads");
        assert_eq!(
            state,
            vec![
                serde_json::json!([{"intersectionRatio": 1}, {"intersectionRatio": 0.25}]),
                serde_json::json!([{"matches": false}, {"matches": true}]),
            ]
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn intersection_observer_supports_component_scope_and_rejects_invalid_options() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              const observer = wx.createIntersectionObserver(
                { __scopeId: 'component-42' },
                { thresholds: [0, 0.5, 1], observeAll: true }
              ).relativeTo('.viewport', { left: 1.5, bottom: -2 });
              observer.observe('.hero', function() {});
              let invalid = null;
              try { wx.createIntersectionObserver({ thresholds: [1.1] }); }
              catch (error) { invalid = { code: error.code, api: error.api }; }
              return invalid;
            };"#,
        )
        .expect("component-scoped observer facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("component-scoped observer is queued");
        assert_eq!(
            result,
            vec![serde_json::json!({
                "code": "ERR_INVALID_REQUEST",
                "api": "wx.createIntersectionObserver"
            })]
        );
        let events = engine.drain_host_events().expect("observer event drains");
        let event = &events[0]["events"][0];
        assert_eq!(event["name"], "wx.createIntersectionObserver");
        assert_eq!(event["options"]["options"]["scopeId"], "component-42");
        assert_eq!(event["options"]["options"]["observeAll"], true);
        assert_eq!(
            event["options"]["options"]["relativeTo"]["selector"],
            ".viewport"
        );
        assert_eq!(
            event["options"]["options"]["relativeTo"]["margins"]["left"],
            1.5
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn media_query_observer_uses_descriptor_scope_and_disconnect() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              const page = Page({});
              page.__scopeId = 'page-7';
              const observer = page.createMediaQueryObserver();
              observer.observe({ minWidth: 320, maxHeight: 1000, orientation: 'portrait' }, function(value) {
                globalThis.__media = value;
              });
              observer.disconnect();
              let invalid = null;
              try { page.createMediaQueryObserver().observe('min-width', function() {}); }
              catch (error) { invalid = { code: error.code, api: error.api }; }
              return invalid;
            };
            exports.state = function() { return globalThis.__media; };"#,
        )
        .expect("media observer facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("media observer calls are queued");
        assert_eq!(
            result,
            vec![serde_json::json!({
                "code": "ERR_INVALID_REQUEST",
                "api": "wx.createMediaQueryObserver"
            })]
        );
        let events = engine.drain_host_events().expect("media events drain");
        let values = events[0]["events"].as_array().expect("event list");
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["name"], "wx.createMediaQueryObserver");
        assert_eq!(values[0]["options"]["action"], "observe");
        assert_eq!(values[0]["options"]["scopeId"], "page-7");
        assert_eq!(values[0]["options"]["descriptor"]["minWidth"], 320);
        assert_eq!(values[1]["options"]["action"], "disconnect");
        let observe_id = values[0]["id"].as_u64().unwrap();
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![
                observe_id.into(),
                serde_json::json!({"matches": true}),
                serde_json::Value::Null,
            ],
        )
        .expect("media response resolves");
        container_core::JsEngine::drain_microtasks(&mut engine).expect("media callback drains");
        let late = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global { name: "__container_notify_observers".into() },
            vec![serde_json::json!([{"observerId":values[0]["options"]["observerId"],"subscriptionId":values[0]["options"]["subscriptionId"],"value":{"matches":true}}])],
        ).expect("late media result is ignored");
        assert_eq!(late, vec![serde_json::json!({"delivered":0,"ignored":1})]);
        let state = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "state".into(),
            },
            Vec::new(),
        )
        .expect("media state reads");
        assert_eq!(state, vec![serde_json::Value::Null]);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn observer_batches_are_persistent_isolated_and_revocable() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(&mut engine, br#"
            let first, media;
            const trace = [];
            exports.run = function() {
                first = wx.createIntersectionObserver().relativeToViewport();
                first.observe('.a', function(value) {
                    'use strict';
                    if (this !== undefined) throw new Error('observer callback must remain unbound');
                    trace.push(['a', value]);
                    if (value.sequence === 1) throw new Error('observer callback');
                });
                first.observe('.b', function(value) { trace.push(['b', value]); first.disconnect(); });
                media = wx.createMediaQueryObserver();
                media.observe({ minWidth: 100 }, function(value) { trace.push(['media', value]); });
            };
            exports.state = function() { return trace; };
        "#).expect("persistent observer fixture loads");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("observer subscriptions register");
        let events = engine
            .drain_host_events()
            .expect("registration batch drains");
        let requests = events[0]["events"].as_array().unwrap();
        assert_eq!(requests.len(), 3);
        let ids: Vec<_> = requests
            .iter()
            .map(|request| {
                (
                    request["options"]["observerId"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                    request["options"]["subscriptionId"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                )
            })
            .collect();
        assert_eq!(ids[0].0, ids[1].0);
        assert_ne!(ids[0].1, ids[1].1);
        assert_ne!(ids[0].0, ids[2].0);
        for request in requests {
            container_core::JsEngine::call(
                &mut engine,
                container_core::CallTarget::Global {
                    name: "__container_resolve_api".into(),
                },
                vec![
                    request["id"].clone(),
                    serde_json::json!({"errMsg":"registered:ok"}),
                    serde_json::Value::Null,
                ],
            )
            .expect("registration acknowledges");
        }
        container_core::JsEngine::drain_microtasks(&mut engine).expect("acknowledgements settle");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_notify_observers".into(),
            },
            vec![serde_json::json!([
                {"observerId":ids[0].0,"subscriptionId":ids[0].1,"value":{"sequence":1}},
                {"observerId":ids[2].0,"subscriptionId":ids[2].1,"value":{"matches":true}},
                {"observerId":ids[0].0,"subscriptionId":ids[0].1,"value":{"sequence":2}},
                {"observerId":ids[1].0,"subscriptionId":ids[1].1,"value":{"sequence":3}},
                {"observerId":ids[0].0,"subscriptionId":ids[0].1,"value":{"sequence":4}},
                {"observerId":"missing","subscriptionId":"missing","value":{}}
            ])],
        )
        .expect("callbacks do not abort batch");
        assert_eq!(result, vec![serde_json::json!({"delivered":4,"ignored":2})]);
        let state = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "state".into(),
            },
            Vec::new(),
        )
        .expect("persistent callback trace reads");
        assert_eq!(
            state,
            vec![
                serde_json::json!(["a",{"sequence":1}]),
                serde_json::json!(["media",{"matches":true}]),
                serde_json::json!(["a",{"sequence":2}]),
                serde_json::json!(["b",{"sequence":3}])
            ]
        );
        let drained = engine
            .drain_host_events()
            .expect("callback error and disconnect drain");
        assert_eq!(drained[0]["errors"].as_array().unwrap().len(), 1);
        assert_eq!(drained[0]["errors"][0]["message"], "observer callback");
        assert_eq!(drained[0]["events"][0]["options"]["action"], "disconnect");
        assert_eq!(drained[0]["events"][0]["options"]["observerId"], ids[0].0);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn observer_owner_cleanup_survives_throwing_page_and_component_hooks() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(&mut engine, br#"
            const trace = [];
            Page({
                onLoad() {
                    wx.createIntersectionObserver().relativeToViewport().observe('.item', function(value) { trace.push(value); });
                    this.createMediaQueryObserver().observe({ minWidth: 1 }, function(value) { trace.push(value); });
                },
                onUnload() { throw new Error('unload'); }
            });
            __container_registration_module_id = 'module:observer-cleanup.js';
            __container_managed_component_modules['module:observer-cleanup.js'] = true;
            Component({
                methods: { start() {
                    wx.createMediaQueryObserver().observe({ minWidth: 2 }, function(value) { trace.push(value); });
                    this.createIntersectionObserver().relativeToViewport().observe('.child', function(value) { trace.push(value); });
                } },
                detached() { throw new Error('detach'); }
            });
            __container_registration_module_id = null;
            let componentIndex = null;
            exports.run = function() {
                __container_set_current_pages([0, 0], [
                    { index:0, instanceId:71, route:'pages/index' },
                    { index:0, instanceId:72, route:'pages/index' }
                ]);
                __container_invoke_page_instance(71, 0, 'onLoad', []);
                __container_invoke_page_instance(72, 0, 'onLoad', []);
                // A real page-bound occurrence carries the private owner
                // incarnation; assigning public aliases does not register one.
                const mounted = __container_reconcile_components({version:1,phase:'prepare',pageId:72,instances:[{
                    scopeId:'component-72',moduleId:'module:observer-cleanup.js',
                    parentScopeId:null,ownerScopeId:null,properties:{}
                }],remove:[]});
                componentIndex = mounted.instances[0].index;
                __container_invoke_component(componentIndex, 'start', []);
            };
            exports.cleanup = function() {
                try { __container_invoke_page_instance(71, 0, 'onUnload', []); } catch (_) {}
                __container_invoke_component(componentIndex, 'detached', []);
            };
            exports.state = function() { return trace; };
        "#).expect("observer owner fixture loads");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("owned observers register");
        let registered = engine.drain_host_events().unwrap();
        let requests = registered[0]["events"].as_array().unwrap();
        assert_eq!(requests.len(), 6);
        for (index, page_id) in ["71", "71", "72", "72", "72", "72"].iter().enumerate() {
            assert_eq!(requests[index]["options"]["pageId"], *page_id);
        }
        assert_eq!(requests[4]["options"]["scopeId"], serde_json::Value::Null);
        assert_eq!(requests[5]["options"]["scopeId"], "component-72");
        assert_eq!(requests[5]["options"]["options"]["scopeId"], "component-72");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "cleanup".into(),
            },
            Vec::new(),
        )
        .expect("throwing cleanup hooks finish");
        let cleaned = engine.drain_host_events().unwrap();
        let disconnects = cleaned[0]["events"].as_array().unwrap();
        assert_eq!(disconnects.len(), 4);
        assert!(disconnects
            .iter()
            .all(|entry| entry["options"]["action"] == "disconnect"));
        let notifications: Vec<_> = requests
            .iter()
            .enumerate()
            .map(|(index, request)| {
                serde_json::json!({
                    "observerId":request["options"]["observerId"],
                    "subscriptionId":request["options"]["subscriptionId"],
                    "value":{"index":index}
                })
            })
            .collect();
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_notify_observers".into(),
            },
            vec![serde_json::json!(notifications)],
        )
        .expect("only live owners are notified");
        assert_eq!(result, vec![serde_json::json!({"delivered":2,"ignored":4})]);
        let state = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "state".into(),
            },
            Vec::new(),
        )
        .unwrap();
        assert_eq!(
            state,
            vec![
                serde_json::json!({"index":2}),
                serde_json::json!({"index":3})
            ]
        );
        let released = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_disconnect_observers".into(),
            },
            vec![serde_json::json!({"pageId":72})],
        )
        .expect("runtime can revoke an owner in one batch");
        assert_eq!(released.len(), 2);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn intersection_roots_accumulate_and_native_mode_rejects_a_second_root() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(&mut engine, br#"
            exports.run = function() {
                const observer = wx.createIntersectionObserver({ thresholds:[0,0.5], initialRatio:0 })
                    .relativeTo('.parent', { top:1 }).relativeToViewport({ bottom:-2 }).relativeTo('.clip');
                observer.observe('.child', function() {});
                const native = wx.createIntersectionObserver({ nativeMode:true }).relativeToViewport();
                let error = null;
                try { native.relativeTo('.parent'); } catch (failure) { error = failure.code; }
                native.observe('.native', function() {});
                let invalid = null;
                try { wx.createIntersectionObserver({ nativeMode:'yes' }); } catch (failure) { invalid = failure.code; }
                return [error, invalid];
            };
        "#).expect("relative roots fixture loads");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .unwrap();
        assert_eq!(
            result,
            vec![
                serde_json::json!("ERR_INVALID_REQUEST"),
                serde_json::json!("ERR_INVALID_REQUEST")
            ]
        );
        let events = engine.drain_host_events().unwrap();
        let requests = events[0]["events"].as_array().unwrap();
        assert_eq!(
            requests[0]["options"]["options"]["relativeRoots"],
            serde_json::json!([
                {"kind":"node","selector":".parent","margins":{"top":1}},
                {"kind":"viewport","margins":{"bottom":-2}},
                {"kind":"node","selector":".clip","margins":{}}
            ])
        );
        assert_eq!(
            requests[1]["options"]["options"]["relativeRoots"],
            serde_json::json!([
                {"kind":"viewport","margins":{}}
            ])
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn canvas_context_batches_commands_until_draw() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              const ctx = wx.createCanvasContext('main');
              ctx.fillStyle = '#f00';
              ctx.setLineDash([2, 1], 3);
              ctx.fillRect(0, 0, 10, 20);
              return ctx.draw(function(result) { globalThis.__draw_result = result; });
            };"#,
        )
        .expect("canvas facade evaluates");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("canvas draw is queued");
        let events = engine.drain_host_events().expect("canvas event drains");
        let event = &events[0]["events"][0];
        assert_eq!(event["name"], "wx.canvas.draw");
        assert_eq!(event["options"]["canvasId"], "main");
        assert_eq!(event["options"]["commands"][0]["op"], "setFillStyle");
        assert_eq!(event["options"]["commands"][1]["op"], "setLineDash");
        assert_eq!(
            event["options"]["commands"][1]["args"],
            serde_json::json!([[2, 1], 3])
        );
        assert_eq!(event["options"]["commands"][2]["op"], "fillRect");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn menu_button_sync_api_reports_explicit_unsupported_capability() {
        let mut engine = V8Engine::default();
        engine
            .set_capabilities(&std::collections::BTreeMap::new())
            .expect("empty capability map installs");
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              try { wx.getMenuButtonBoundingClientRect(); return 'unexpected'; }
              catch (error) { return { code: error.code, api: error.api, canUse: wx.canIUse('wx.getMenuButtonBoundingClientRect') }; }
            };"#,
        )
        .expect("menu button unsupported fixture evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("unsupported sync call is handled");
        assert_eq!(
            result,
            vec![serde_json::json!({
                "code": "ERR_UNSUPPORTED_CAPABILITY",
                "api": "wx.getMenuButtonBoundingClientRect",
                "canUse": false
            })]
        );
        let events = engine
            .drain_host_events()
            .expect("unsupported error drains");
        assert_eq!(
            events[0]["errors"][0]["api"],
            "wx.getMenuButtonBoundingClientRect"
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn app_authorize_setting_sync_api_reports_explicit_unsupported_capability() {
        let mut engine = V8Engine::default();
        engine
            .set_capabilities(&std::collections::BTreeMap::new())
            .expect("empty capability map installs");
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              try { wx.getAppAuthorizeSetting(); return 'unexpected'; }
              catch (error) { return { code: error.code, api: error.api, canUse: wx.canIUse('wx.getAppAuthorizeSetting') }; }
            };"#,
        )
        .expect("app authorize setting unsupported fixture evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("unsupported sync call is handled");
        assert_eq!(
            result,
            vec![serde_json::json!({
                "code": "ERR_UNSUPPORTED_CAPABILITY",
                "api": "wx.getAppAuthorizeSetting",
                "canUse": false
            })]
        );
        let events = engine
            .drain_host_events()
            .expect("unsupported error drains");
        assert_eq!(events[0]["errors"][0]["api"], "wx.getAppAuthorizeSetting");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn inner_audio_context_batches_stateful_commands_and_exposes_properties() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              const audio = wx.createInnerAudioContext();
              audio.src = 'https://example.test/song.mp3';
              audio.volume = 0.5;
              audio.loop = true;
              audio.play();
              return { canUse: wx.canIUse('wx.createInnerAudioContext'), src: audio.src, volume: audio.volume, loop: audio.loop, paused: audio.paused };
            };"#,
        )
        .expect("audio facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("audio commands are queued");
        assert_eq!(result[0]["canUse"], true);
        assert_eq!(result[0]["src"], "https://example.test/song.mp3");
        assert_eq!(result[0]["volume"], 0.5);
        assert_eq!(result[0]["loop"], true);
        assert_eq!(result[0]["paused"], true);
        let events = engine.drain_host_events().expect("audio events drain");
        let calls = &events[0]["events"];
        assert_eq!(calls[0]["name"], "wx.innerAudioContext");
        assert_eq!(calls[0]["options"]["command"], "create");
        assert_eq!(calls[1]["options"]["command"], "set");
        assert_eq!(calls[1]["options"]["src"], "https://example.test/song.mp3");
        assert_eq!(calls[2]["options"]["volume"], 0.5);
        assert_eq!(calls[3]["options"]["loop"], true);
        assert_eq!(calls[4]["options"]["command"], "play");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn audio_context_controls_component_audio_through_provider() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              const audio = wx.createAudioContext('intro');
              audio.setSrc('https://example.test/intro.mp3');
              audio.play();
              audio.seek(2.5);
              return { canUse: wx.canIUse('wx.createAudioContext'), hasSetSrc: typeof audio.setSrc === 'function', hasSeek: typeof audio.seek === 'function' };
            };"#,
        )
        .expect("audio context facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("audio context commands are queued");
        assert_eq!(result[0]["canUse"], true);
        assert_eq!(result[0]["hasSetSrc"], true);
        assert_eq!(result[0]["hasSeek"], true);
        let events = engine
            .drain_host_events()
            .expect("audio context events drain");
        let calls = &events[0]["events"];
        assert_eq!(calls[0]["name"], "wx.audioContext");
        assert_eq!(calls[0]["options"]["command"], "create");
        assert_eq!(calls[1]["options"]["command"], "set");
        assert_eq!(calls[1]["options"]["src"], "https://example.test/intro.mp3");
        assert_eq!(calls[2]["options"]["command"], "play");
        assert_eq!(calls[3]["options"]["command"], "seek");
        assert_eq!(calls[3]["options"]["position"], 2.5);
        assert_eq!(calls[0]["options"]["contextId"], "component-audio-intro");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn video_context_batches_transport_and_ui_commands() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              const video = wx.createVideoContext('hero');
              video.play(); video.seek(4.5); video.playbackRate(1.25);
              video.sendDanmu({ text: 'hello', color: '#fff' });
              video.requestFullScreen({ direction: 'vertical' });
              video.hideStatusBar();
              return { canUse: wx.canIUse('wx.createVideoContext'), methods: [typeof video.play, typeof video.sendDanmu] };
            }"#,
        ).expect("video facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("video commands are queued");
        assert_eq!(result[0]["canUse"], true);
        assert_eq!(
            result[0]["methods"],
            serde_json::json!(["function", "function"])
        );
        let events = engine.drain_host_events().expect("video events drain");
        let calls = &events[0]["events"];
        assert_eq!(calls[0]["name"], "wx.videoContext");
        assert_eq!(calls[0]["options"]["command"], "create");
        assert_eq!(calls[1]["options"]["command"], "play");
        assert_eq!(calls[2]["options"]["position"], 4.5);
        assert_eq!(calls[3]["options"]["rate"], 1.25);
        assert_eq!(calls[4]["options"]["text"], "hello");
        assert_eq!(calls[5]["options"]["direction"], "vertical");
        assert_eq!(calls[6]["options"]["command"], "hideStatusBar");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn camera_context_batches_capture_commands_without_fabricating_frames() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              const camera = wx.createCameraContext();
              const listener = camera.onCameraFrame(function() {});
              camera.takePhoto({ quality: 'low', fail: function() {} });
              camera.startRecord({ timeout: 12 });
              camera.stopRecord();
              listener.start();
              return { canUse: wx.canIUse('wx.createCameraContext'), methods: [
                typeof camera.takePhoto, typeof camera.startRecord, typeof camera.stopRecord,
                typeof camera.onCameraFrame, typeof listener.start, typeof listener.stop
              ] };
            };"#,
        )
        .expect("camera facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("camera commands are queued");
        assert_eq!(result[0]["canUse"], true);
        assert_eq!(
            result[0]["methods"],
            serde_json::json!([
                "function", "function", "function", "function", "function", "function"
            ])
        );
        let events = engine.drain_host_events().expect("camera events drain");
        let calls = &events[0]["events"];
        assert_eq!(calls[0]["name"], "wx.cameraContext");
        assert_eq!(calls[0]["options"]["command"], "create");
        assert_eq!(calls[1]["options"]["command"], "takePhoto");
        assert_eq!(calls[1]["options"]["quality"], "low");
        assert_eq!(calls[2]["options"]["command"], "startRecord");
        assert_eq!(calls[2]["options"]["timeout"], 12);
        assert_eq!(calls[3]["options"]["command"], "stopRecord");
        assert_eq!(calls[4]["options"]["command"], "frameStart");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn connect_socket_returns_task_and_batches_provider_open_request() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              const task = wx.connectSocket({ url: 'wss://example.test/socket', protocols: ['json'] });
              task.onOpen(function(value) { globalThis.__socket_open = value; });
              task.onMessage(function(value) { globalThis.__socket_message = value; });
              return { canUse: wx.canIUse('wx.connectSocket'), readyState: task.readyState,
                hasSend: typeof task.send === 'function', hasClose: typeof task.close === 'function' };
            };"#,
        )
        .expect("socket facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("socket request is queued");
        assert_eq!(result[0]["canUse"], true);
        assert_eq!(result[0]["readyState"], 0);
        assert_eq!(result[0]["hasSend"], true);
        assert_eq!(result[0]["hasClose"], true);
        let events = engine.drain_host_events().expect("socket event drains");
        let event = &events[0]["events"][0];
        assert_eq!(event["name"], "wx.connectSocket");
        assert_eq!(event["options"]["url"], "wss://example.test/socket");
        assert_eq!(event["options"]["protocols"][0], "json");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn offscreen_canvas_batches_isolated_surface_draw() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              const canvas = wx.createOffscreenCanvas({ type: '2d', width: 10, height: 6 });
              const context = canvas.getContext('2d');
              context.fillStyle = '#ff0000';
              context.fillRect(0, 0, 2, 3);
              context.draw();
              return { width: canvas.width, height: canvas.height, canUse: wx.canIUse('wx.createOffscreenCanvas') };
            };"#,
        )
        .expect("offscreen canvas facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("offscreen canvas draw queues");
        assert_eq!(
            result,
            vec![serde_json::json!({"width": 10, "height": 6, "canUse": true})]
        );
        let events = engine
            .drain_host_events()
            .expect("offscreen draw event drains");
        let event = &events[0]["events"][0];
        assert_eq!(event["name"], "wx.canvas.draw");
        assert_eq!(event["options"]["width"], 10);
        assert_eq!(event["options"]["height"], 6);
        assert!(event["options"]["canvasId"]
            .as_str()
            .unwrap()
            .starts_with("__offscreen_"));
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn animation_exports_chained_steps_and_clears_after_export() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              const animation = wx.createAnimation({ duration: 300, timingFunction: 'linear' });
              const first = animation.translateX(24).opacity(0.5).step({ delay: 20 });
              const second = first.height('auto').scale(1.1).step();
              return [second.export(), second.export(), wx.canIUse('wx.createAnimation')];
            };"#,
        )
        .expect("animation facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("animation call succeeds");
        assert_eq!(result[0]["actions"][0]["animates"][0]["type"], "translateX");
        assert_eq!(
            result[0]["actions"][0]["animates"][1]["args"],
            serde_json::json!([0.5])
        );
        assert_eq!(result[0]["actions"][0]["option"]["delay"], 20);
        assert_eq!(
            result[0]["actions"][1]["animates"][1]["args"],
            serde_json::json!([1.1, 1.1])
        );
        assert_eq!(result[0]["actions"][1]["option"]["duration"], 300);
        assert_eq!(
            result[0]["actions"][1]["option"]["timingFunction"],
            "linear"
        );
        assert_eq!(
            result[0]["actions"][1]["option"]["transformOrigin"],
            "50% 50% 0"
        );
        assert_eq!(result[1], serde_json::json!({"actions": []}));
        assert_eq!(result[2], true);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn animation_defaults_match_wechat_step_options() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              const animation = wx.createAnimation();
              animation.opacity(0.25).step();
              const nullish = wx.createAnimation({
                delay: null, duration: null, timingFunction: null,
                transformOrigin: null
              });
              nullish.opacity(0.5).step();
              return [animation.export(), nullish.export()];
            };"#,
        )
        .expect("animation defaults fixture evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("animation defaults call succeeds");
        assert_eq!(
            result[0]["actions"][0]["option"],
            serde_json::json!({
                "delay": 0,
                "duration": 400,
                "timingFunction": "linear",
                "transformOrigin": "50% 50% 0"
            })
        );
        assert_eq!(
            result[1]["actions"][0]["option"],
            result[0]["actions"][0]["option"]
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn animation_reports_explicit_error_when_capability_is_unsupported() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let mut capabilities = std::collections::BTreeMap::new();
        capabilities.insert("wx.createAnimation".to_string(), "unsupported".to_string());
        engine
            .set_capabilities(&capabilities)
            .expect("capability map installs");
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              try { wx.createAnimation(); return 'unexpected'; }
              catch (error) { return { code: error.code, canUse: wx.canIUse('wx.createAnimation') }; }
            };"#,
        )
        .expect("animation unsupported fixture evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("unsupported animation call is handled");
        assert_eq!(result[0]["code"], "ERR_UNSUPPORTED_CAPABILITY");
        assert_eq!(result[0]["canUse"], false);
        let events = engine.drain_host_events().expect("error event drains");
        assert_eq!(events[0]["errors"][0]["api"], "wx.createAnimation");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn page_event_uses_phase_bound_handlers_and_catch_after_listener_error() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        container_core::JsEngine::load_module(
            &mut engine,
            br#"Page({
                onCapture(event) { return 'capture:' + event.phase; },
                onBubble(event) { return 'bubble:' + event.phase; },
                onTarget() { return 'target'; },
                onLegacy() { return 'legacy'; },
                onCatch() { throw new Error('catch listener failed'); }
              });"#,
        )
        .expect("page registration evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_page_event".into(),
            },
            vec![
                serde_json::json!(0),
                serde_json::json!({
                    "handler": "onTarget",
                    "handlers": {"root": "onLegacy"},
                    "dispatches": [
                        {"phase": "capture", "currentTarget": "root", "target": "button", "handler": "onCapture"},
                        {"phase": "target", "currentTarget": "button", "target": "button", "handler": ""},
                        {"phase": "bubble", "currentTarget": "root", "target": "button", "handler": "onBubble"}
                    ]
                }),
            ],
        )
        .expect("phase-bound page event dispatch succeeds");
        assert_eq!(result.len(), 3);
        assert_eq!(result[0]["handler"], "onCapture");
        assert_eq!(result[0]["result"], "capture:capture");
        assert_eq!(result[1]["handler"], "onTarget");
        assert_eq!(result[2]["handler"], "onBubble");
        assert_eq!(result[2]["result"], "bubble:bubble");

        let caught = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_page_event".into(),
            },
            vec![
                serde_json::json!(0),
                serde_json::json!({"dispatches": [
                    {"phase": "target", "currentTarget": "button", "target": "button", "handler": "onCatch", "catch": true},
                    {"phase": "bubble", "currentTarget": "root", "target": "button", "handler": "onBubble"}
                ]}),
            ],
        )
        .expect("catch listener error is recorded");
        assert_eq!(caught.len(), 1);
        assert_eq!(caught[0]["handler"], "onCatch");
        assert_eq!(caught[0]["error"], "catch listener failed");
        assert_eq!(caught[0]["propagationStopped"], true);
        assert_eq!(caught[0]["dispatchIndex"], 0);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_explicit_owner_cancellation_rethrows_original_error_but_default_dispatch_reports() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"const failure = new Error('owner cancel failed');
              failure.code = 'APP_CANCEL_FAILED';
              const trace = [];
              const observedErrors = [];
              wx.onError(function(message) { observedErrors.push(message); });
              Page({
                onFirst() { trace.push('first'); throw failure; },
                onLast() { trace.push('last'); return 'continued'; }
              });
              const event = {type:'touchcancel',rethrowHandlerError:true,dispatches:[
                {phase:'target',currentTarget:'button',target:'button',handler:'onFirst'},
                {phase:'bubble',currentTarget:'root',target:'button',handler:'onLast'}
              ]};
              exports.run = function() {
                const ordinary = globalThis.__container_invoke_page_event(0, event);
                let caught;
                try { globalThis.__container_invoke_page_event(0, event, true); }
                catch (error) { caught = error; }
                return {ordinary,trace,sameError:caught === failure,code:caught && caught.code,observedErrors};
              };
              exports.uncaught = function() {
                return globalThis.__container_invoke_page_event(0, event, true);
              };
              exports.inspect = function() { return {trace,observedErrors}; };"#,
        )
        .expect("owner cancellation fixture registers");
        let values = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("fixture catches the original strict cancellation error");
        let value = &values[0];
        assert_eq!(
            value["sameError"], true,
            "the thrown JS object must not be reconstructed"
        );
        assert_eq!(value["code"], "APP_CANCEL_FAILED");
        assert_eq!(
            value["trace"],
            serde_json::json!(["first", "last", "first"])
        );
        assert_eq!(value["ordinary"][0]["error"], "owner cancel failed");
        assert_eq!(value["ordinary"][1]["result"], "continued");
        assert_eq!(
            value["observedErrors"],
            serde_json::json!(["owner cancel failed"])
        );
        let events = engine
            .drain_host_events()
            .expect("the ordinary error remains reported");
        let errors = events
            .iter()
            .filter_map(|event| event["errors"].as_array())
            .flatten()
            .filter(|error| error["message"] == "owner cancel failed")
            .count();
        assert_eq!(
            errors, 1,
            "an internally caught strict throw is not reported"
        );
        // Reusing the exact Error in separate failed native calls must report
        // once per throw. Identity-based deduplication would lose the second.
        for attempt in 0..2 {
            container_core::JsEngine::call(
                &mut engine,
                container_core::CallTarget::Module {
                    id: module,
                    export: "uncaught".into(),
                },
                Vec::new(),
            )
            .expect_err("strict uncaught failure crosses the real native call boundary");
            let events = engine.drain_host_events().expect("strict error drains");
            let errors = events
                .iter()
                .filter_map(|event| event["errors"].as_array())
                .flatten()
                .filter(|error| error["message"] == "owner cancel failed")
                .count();
            assert_eq!(
                errors, 1,
                "one retained boundary report per failed native call: {events:?}"
            );
            let values = container_core::JsEngine::call(
                &mut engine,
                container_core::CallTarget::Module {
                    id: module,
                    export: "inspect".into(),
                },
                Vec::new(),
            )
            .expect("error reporting does not poison the realm");
            let state = &values[0];
            assert_eq!(
                state["observedErrors"].as_array().unwrap().len(),
                attempt + 2
            );
            assert!(state["observedErrors"]
                .as_array()
                .unwrap()
                .iter()
                .all(|message| message == "owner cancel failed"));
            assert_eq!(state["trace"].as_array().unwrap().len(), attempt + 4);
            assert_eq!(state["trace"].as_array().unwrap().last().unwrap(), "first");
        }
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn page_event_controls_stop_propagation_and_prevent_default() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        container_core::JsEngine::load_module(
            &mut engine,
            br#"globalThis.__trace = [];
              Page({
                onRoot(event) { __trace.push('root'); return event.defaultPrevented; },
                onPanel(event) { __trace.push('panel'); return event.defaultPrevented; },
                onButton(event) {
                  __trace.push('button');
                  event.preventDefault();
                  event.stopPropagation();
                  return { defaultPrevented: event.defaultPrevented, cancelBubble: event.cancelBubble, mark: event.mark };
                }
              });"#,
        )
        .expect("page registration evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_page_event".into(),
            },
            vec![
                serde_json::json!(0),
                serde_json::json!({
                    "type": "tap",
                    "handlers": {"root": "onRoot", "panel": "onPanel", "button": "onButton"},
                    "dispatches": [
                        {"phase": "capture", "currentTarget": "root", "target": "button"},
                        {"phase": "capture", "currentTarget": "panel", "target": "button"},
                        {"phase": "target", "currentTarget": "button", "target": "button", "mark": {"source": "fixture"}},
                        {"phase": "bubble", "currentTarget": "panel", "target": "button"},
                        {"phase": "bubble", "currentTarget": "root", "target": "button"}
                    ]
                }),
            ],
        )
        .expect("page event dispatch is callable");
        let rows = &result;
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["currentTarget"], "root");
        assert_eq!(rows[1]["currentTarget"], "panel");
        assert_eq!(rows[2]["currentTarget"], "button");
        assert_eq!(rows[2]["propagationStopped"], true);
        assert_eq!(rows[2]["dispatchIndex"], 2);
        assert_eq!(rows[2]["result"]["defaultPrevented"], true);
        assert_eq!(rows[2]["result"]["cancelBubble"], true);
        assert_eq!(rows[2]["result"]["mark"]["source"], "fixture");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn wx_capabilities_navigation_and_unsupported_api_are_explicit() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let mut capabilities = std::collections::BTreeMap::new();
        capabilities.insert("wx.request".to_string(), "partial".to_string());
        capabilities.insert("wx.navigateTo".to_string(), "partial".to_string());
        capabilities.insert(
            "wx.setNavigationBarTitle".to_string(),
            "partial".to_string(),
        );
        engine
            .set_capabilities(&capabilities)
            .expect("capability map installs");
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
                wx.navigateTo({ url: '/pages/detail/index', query: { id: 7 } });
                wx.setNavigationBarTitle({ title: 'Detail' });
                wx.request({ url: 'https://example.invalid' }).catch(function() {});
                return [wx.canIUse('wx.request'), wx.canIUse('wx.camera')];
              };"#,
        )
        .expect("module evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("facade call succeeds");
        assert_eq!(
            result,
            vec![serde_json::json!(true), serde_json::json!(false)]
        );
        let events = engine.drain_host_events().expect("events drain");
        assert_eq!(events[0]["events"][0]["name"], "wx.navigateTo");
        assert_eq!(events[0]["events"][1]["name"], "wx.setNavigationBarTitle");
        assert_eq!(events[0]["events"][1]["options"]["title"], "Detail");
        assert_eq!(events[0]["errors"].as_array().map(Vec::len), Some(0));
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn navigation_callbacks_wait_for_host_result() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"var trace = [];
                exports.run = function() {
                  wx.navigateTo({url:'/pages/detail/index',
                    success:function(value){trace.push('success:'+value.errMsg);},
                    fail:function(){trace.push('unexpected fail');},
                    complete:function(value){trace.push('complete:'+value.errMsg);}
                  }).then(function(value){trace.push('resolved:'+value.errMsg);});
                  wx.redirectTo({url:'/pages/missing/index',
                    success:function(){trace.push('unexpected success');},
                    fail:function(value){trace.push('fail:'+value.code);},
                    complete:function(value){trace.push('complete:'+value.code);}
                  }).catch(function(value){trace.push('rejected:'+value.code);});
                };
                exports.status = function(){return {trace:trace};};"#,
        )
        .expect("navigation fixture loads");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("navigation starts");
        container_core::JsEngine::drain_microtasks(&mut engine).expect("pending microtasks drain");
        let status = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "status".into(),
            },
            Vec::new(),
        )
        .expect("pending status reads");
        assert_eq!(status[0]["trace"], serde_json::json!([]));
        let events = engine
            .drain_host_events()
            .expect("navigation requests drain");
        let requests = events[0]["events"].as_array().expect("request list");
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["type"], "api.call");
        assert_eq!(requests[0]["name"], "wx.navigateTo");
        assert_eq!(requests[1]["type"], "api.call");
        assert_eq!(requests[1]["name"], "wx.redirectTo");
        for (index, result, error) in [
            (
                0,
                serde_json::json!({"errMsg":"navigateTo:ok"}),
                serde_json::Value::Null,
            ),
            (
                1,
                serde_json::Value::Null,
                serde_json::json!({"errMsg":"redirectTo:fail route missing", "code":"ERR_INVALID_REQUEST"}),
            ),
        ] {
            let request_id = requests[index]["id"].clone();
            let accepted = container_core::JsEngine::call(
                &mut engine,
                container_core::CallTarget::Global {
                    name: "__container_resolve_api".into(),
                },
                vec![request_id.clone(), result, error],
            )
            .expect("host result resolves");
            assert_eq!(accepted, vec![serde_json::json!(true)]);
            let duplicate = container_core::JsEngine::call(
                &mut engine,
                container_core::CallTarget::Global {
                    name: "__container_resolve_api".into(),
                },
                vec![
                    request_id,
                    serde_json::json!({"errMsg":"duplicate"}),
                    serde_json::Value::Null,
                ],
            )
            .expect("duplicate result is ignored");
            assert_eq!(duplicate, vec![serde_json::json!(false)]);
            container_core::JsEngine::drain_microtasks(&mut engine)
                .expect("result callbacks drain");
        }
        let status = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "status".into(),
            },
            Vec::new(),
        )
        .expect("settled status reads");
        assert_eq!(
            status[0]["trace"],
            serde_json::json!([
                "success:navigateTo:ok",
                "complete:navigateTo:ok",
                "resolved:navigateTo:ok",
                "fail:ERR_INVALID_REQUEST",
                "complete:ERR_INVALID_REQUEST",
                "rejected:ERR_INVALID_REQUEST"
            ])
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn api_callback_exceptions_do_not_skip_complete_or_promise_settlement() {
        for (failed, unreportable) in [(false, false), (true, false), (false, true)] {
            let mut engine = V8Engine::default();
            let module = container_core::JsEngine::load_module(
                &mut engine,
                br#"var trace = [];
                    exports.run = function(unreportable) {
                      wx.navigateTo({url:'/pages/detail/index',
                        success:function(){trace.push('success');throw new Error('success callback');},
                        fail:function(){trace.push('fail');throw new Error('fail callback');},
                        complete:function(){trace.push('complete');
                          if (unreportable) throw {get message(){throw new Error('reporting getter');}};
                          throw new Error('complete callback');}
                      }).then(function(){trace.push('resolved');},function(){trace.push('rejected');});
                    };
                    exports.status = function(){return {trace:trace};};"#,
            ).expect("throwing callbacks fixture loads");
            container_core::JsEngine::call(
                &mut engine,
                container_core::CallTarget::Module {
                    id: module,
                    export: "run".into(),
                },
                vec![serde_json::json!(unreportable)],
            )
            .expect("request starts");
            let events = engine.drain_host_events().expect("request drains");
            let request_id = events[0]["events"][0]["id"].clone();
            let value = serde_json::json!({"errMsg":if failed {"navigateTo:fail invalid route"} else {"navigateTo:ok"}});
            let (result, error) = if failed {
                (serde_json::Value::Null, value)
            } else {
                (value, serde_json::Value::Null)
            };
            container_core::JsEngine::call(
                &mut engine,
                container_core::CallTarget::Global {
                    name: "__container_resolve_api".into(),
                },
                vec![request_id, result, error],
            )
            .expect("host resolution survives callback exceptions");
            container_core::JsEngine::drain_microtasks(&mut engine)
                .expect("throwing callbacks drain");
            let status = container_core::JsEngine::call(
                &mut engine,
                container_core::CallTarget::Module {
                    id: module,
                    export: "status".into(),
                },
                Vec::new(),
            )
            .expect("status reads");
            assert_eq!(
                status[0]["trace"],
                if failed {
                    serde_json::json!(["fail", "complete", "rejected"])
                } else {
                    serde_json::json!(["success", "complete", "resolved"])
                }
            );
            let events = engine.drain_host_events().expect("callback errors drain");
            let errors = events[0]["errors"].as_array().expect("error list");
            assert_eq!(errors.len(), 2);
            assert_eq!(
                errors[0]["message"],
                if failed {
                    "fail callback"
                } else {
                    "success callback"
                }
            );
            assert_eq!(
                errors[1]["message"],
                if unreportable {
                    "API callback threw an unreportable value"
                } else {
                    "complete callback"
                }
            );
        }
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn navigation_rejects_invalid_options_and_disabled_capability_asynchronously() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"var trace = [];
                exports.run = function() {
                  wx.navigateTo({fail:function(value){trace.push('fail:'+value.errMsg+':'+value.api+':'+value.code);throw new Error('validation callback');},
                    complete:function(value){trace.push('complete:'+value.code);}
                  }).catch(function(value){trace.push('rejected:'+value.code);});
                  wx.navigateTo().catch(function(value){trace.push('missing:'+value.code);});
                  wx.navigateTo([]).catch(function(value){trace.push('array:'+value.code);});
                  wx.setNavigationBarTitle({}).catch(function(value){trace.push('title:'+value.code);});
                  trace.push('returned');
                  wx.navigateBack();
                };
                exports.disabled = function() {
                  wx.navigateTo({url:'/pages/detail/index',
                    fail:function(value){trace.push('disabled fail:'+value.errMsg+':'+value.api+':'+value.code);},
                    complete:function(value){trace.push('disabled complete:'+value.code);}
                  }).catch(function(value){trace.push('disabled rejected:'+value.code);});
                  trace.push('disabled returned');
                };
                exports.status = function(){return {trace:trace};};"#,
        ).expect("invalid navigation fixture loads");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("invalid navigation does not throw synchronously");
        container_core::JsEngine::drain_microtasks(&mut engine)
            .expect("validation callbacks drain");
        let status = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "status".into(),
            },
            Vec::new(),
        )
        .expect("validation status reads");
        assert_eq!(
            status[0]["trace"],
            serde_json::json!([
                "returned",
                "fail:navigateTo:fail url must be a non-empty string:wx.navigateTo:ERR_INVALID_REQUEST",
                "complete:ERR_INVALID_REQUEST",
                "rejected:ERR_INVALID_REQUEST",
                "missing:ERR_INVALID_REQUEST",
                "array:ERR_INVALID_REQUEST",
                "title:ERR_INVALID_REQUEST"
            ])
        );
        let events = engine.drain_host_events().expect("validation events drain");
        let requests = events[0]["events"].as_array().expect("request list");
        assert_eq!(
            requests.len(),
            1,
            "only optional navigateBack reaches the host"
        );
        assert_eq!(requests[0]["name"], "wx.navigateBack");
        assert_eq!(events[0]["errors"].as_array().map(Vec::len), Some(1));
        assert_eq!(events[0]["errors"][0]["message"], "validation callback");
        engine
            .set_capabilities(&std::collections::BTreeMap::new())
            .expect("all capabilities disabled");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "disabled".into(),
            },
            Vec::new(),
        )
        .expect("disabled navigation does not throw synchronously");
        container_core::JsEngine::drain_microtasks(&mut engine).expect("disabled callbacks drain");
        let status = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "status".into(),
            },
            Vec::new(),
        )
        .expect("disabled status reads");
        let trace = status[0]["trace"].as_array().expect("trace list");
        assert_eq!(
            &trace[7..],
            &[
                serde_json::json!("disabled returned"),
                serde_json::json!("disabled fail:navigateTo:fail unsupported:wx.navigateTo:ERR_UNSUPPORTED_CAPABILITY"),
                serde_json::json!("disabled complete:ERR_UNSUPPORTED_CAPABILITY"),
                serde_json::json!("disabled rejected:ERR_UNSUPPORTED_CAPABILITY")
            ]
        );
        let events = engine.drain_host_events().expect("disabled events drain");
        assert_eq!(
            events[0]["events"],
            serde_json::json!([]),
            "disabled navigation cannot reach the host"
        );
        assert_eq!(events[0]["errors"], serde_json::json!([]));
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn can_i_use_accepts_short_api_names() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        let mut capabilities = std::collections::BTreeMap::new();
        capabilities.insert("wx.request".to_string(), "partial".to_string());
        engine
            .set_capabilities(&capabilities)
            .expect("capability map installs");
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
                return [wx.canIUse('request'), wx.canIUse('wx.request'), wx.canIUse('button.open-type.getUserInfo')];
              };"#,
        )
        .expect("module evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("capability query succeeds");
        assert_eq!(
            result,
            vec![
                serde_json::json!(true),
                serde_json::json!(true),
                serde_json::json!(false)
            ]
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn app_show_and_hide_listeners_are_dispatched_once_per_hook() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        container_core::JsEngine::load_module(
            &mut engine,
            br#"wx.onAppShow(function(options) { globalThis.__show_scene = options.scene; });
              wx.onAppHide(function() { globalThis.__hide_seen = true; });
              App({ onShow() { return globalThis.__show_scene || null; }, onHide() { return globalThis.__hide_seen || false; } });"#,
        )
        .expect("listener registration evaluates");
        let show = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_app".into(),
            },
            vec![
                serde_json::json!("onShow"),
                serde_json::json!([{ "scene": 1001 }]),
            ],
        )
        .expect("show hook is callable");
        assert_eq!(show, vec![serde_json::Value::Null]);
        let hide = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_app".into(),
            },
            vec![serde_json::json!("onHide"), serde_json::json!([])],
        )
        .expect("hide hook is callable");
        assert_eq!(hide, vec![serde_json::json!(false)]);
        let hide_after_dispatch = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_app".into(),
            },
            vec![serde_json::json!("onHide"), serde_json::json!([])],
        )
        .expect("second hide hook is callable");
        assert_eq!(hide_after_dispatch, vec![serde_json::json!(true)]);
        let effects = engine
            .drain_host_events()
            .expect("listener event is drained");
        let events = effects[0]["events"].as_array().expect("events array");
        assert_eq!(events[0]["type"], "app.listener");
        assert_eq!(events[0]["name"], "show");
        assert_eq!(events[1]["name"], "hide");
        assert_eq!(events[2]["name"], "hide");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn component_behavior_data_lifetimes_and_page_lifetimes_are_composed_in_order() {
        let mut engine = V8Engine::default();
        container_core::JsEngine::load_module(
            &mut engine,
            br#"
              const Base = Behavior({
                data() { return { fromBehavior: true }; },
                lifetimes: {
                  created() { (this.trace || (this.trace = [])).push('behavior-created'); },
                  attached() { this.trace.push('behavior-attached'); }
                },
                pageLifetimes: {
                  show(options) { this.pageScene = options.scene; }
                }
              });
              Component({
                behaviors: [Base],
                data() { return { fromComponent: true }; },
                lifetimes: {
                  created() { this.trace.push('component-created'); },
                  attached() { this.trace.push('component-attached'); }
                },
                methods: {
                  read() { return { data: this.data, trace: this.trace, pageScene: this.pageScene }; }
                }
              });
            "#,
        )
        .expect("component registration evaluates");
        let mounted = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_mount_component".into(),
            },
            vec![serde_json::json!(0), serde_json::json!({})],
        )
        .expect("component mounts");
        assert_eq!(
            mounted[0]["snapshot"]["lifecycle"],
            serde_json::json!(["created", "attached", "ready"])
        );
        let before = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_component".into(),
            },
            vec![
                serde_json::json!(0),
                serde_json::json!("read"),
                serde_json::json!([]),
            ],
        )
        .expect("component method is callable");
        assert_eq!(before[0]["data"]["fromBehavior"], true);
        assert_eq!(before[0]["data"]["fromComponent"], true);
        assert_eq!(
            before[0]["trace"],
            serde_json::json!([
                "behavior-created",
                "component-created",
                "behavior-attached",
                "component-attached"
            ])
        );
        assert!(before[0]["pageScene"].is_null());
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_component".into(),
            },
            vec![
                serde_json::json!(0),
                serde_json::json!("show"),
                serde_json::json!([{ "scene": 1001 }]),
            ],
        )
        .expect("page lifetime is callable");
        let after = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_component".into(),
            },
            vec![
                serde_json::json!(0),
                serde_json::json!("read"),
                serde_json::json!([]),
            ],
        )
        .expect("component method is callable");
        assert_eq!(after[0]["pageScene"], 1001);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn component_event_retirement_disposes_orphans_without_reviving_reused_scopes() {
        let mut engine = V8Engine::default();
        container_core::JsEngine::load_module(
            &mut engine,
            br#"
              globalThis.__container_test_event_retirement = function() {
                __container_capabilities['Component.triggerEvent'] = 'partial';
                const received = [];
                Page({ receive(event) { received.push(event.detail); } });
                const page = __container_pages[0];
                page.__container_instance_id = 29;
                __container_page_instances['29'] = page;
                __container_current_page_instances = [page];
                __container_registration_module_id = 'module:event-retirement.js';
                __container_managed_component_modules['module:event-retirement.js'] = true;
                Component({ detached() { this.triggerEvent('change', 'detached'); } });
                __container_registration_module_id = null;
                const scope = 'event-retirement-child';
                const record = { scopeId: scope, moduleId: 'module:event-retirement.js',
                  parentScopeId: null, ownerScopeId: null, properties: {} };
                const node = { key: 'event:0', parentKey: null, ownerScopeId: null,
                  componentScopeId: scope, attributes: { id: 'child', bindchange: 'receive' },
                  dataset: {}, mark: {} };
                const prepare = { version: 1, pageId: 29, phase: 'prepare',
                  instances: [record], remove: [], eventNodes: [node] };
                const removeFrontier = { version: 1, pageId: 29, phase: 'publish',
                  instances: [], remove: [], eventNodes: [] };
                const dispose = { version: 1, pageId: 29, phase: 'dispose',
                  instances: [], remove: [scope, scope] };
                function failure(source) {
                  try { source.triggerEvent('change', 'stale'); return null; }
                  catch (error) { return error.code; }
                }
                __container_reconcile_components(prepare);
                const first = __container_component_scopes[scope];
                __container_reconcile_components(removeFrontier);
                const retired = __container_retiring_component_events['29'][scope];
                __container_reconcile_components(removeFrontier);
                const duplicateRetained = retired === __container_retiring_component_events['29'][scope];
                __container_reconcile_components(dispose);
                const firstCleared = !__container_retiring_component_events['29'];
                __container_reconcile_components(prepare);
                const second = __container_component_scopes[scope];
                second.triggerEvent('change', 'second');
                __container_reconcile_components(removeFrontier);
                // Simulate a registry entry already lost by another cleanup.
                // Its pending route must still be released by the requested
                // identity, although the disposer cannot run a hook for it.
                delete __container_component_scopes[scope];
                __container_components[second.__container_component_index] = null;
                __container_reconcile_components(dispose);
                const orphanCleared = !__container_retiring_component_events['29'];
                __container_reconcile_components(prepare);
                const third = __container_component_scopes[scope];
                third.triggerEvent('change', 'third');
                return { received: received, duplicateRetained: duplicateRetained,
                  firstCleared: firstCleared, orphanCleared: orphanCleared,
                  freshInstances: first !== second && second !== third,
                  firstFailure: failure(first), orphanFailure: failure(second),
                  errors: __container_errors.length };
              };
            "#,
        )
        .expect("retirement fixture loads");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_test_event_retirement".into(),
            },
            Vec::new(),
        )
        .expect("retirement fixture executes in the native engine");
        assert_eq!(
            result[0],
            serde_json::json!({
                "received": ["detached", "second", "third"],
                "duplicateRetained": true,
                "firstCleared": true,
                "orphanCleared": true,
                "freshInstances": true,
                "firstFailure": "ERR_INVALID_REQUEST",
                "orphanFailure": "ERR_INVALID_REQUEST",
                "errors": 0
            })
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn component_instances_do_not_share_definition_state_or_properties() {
        let mut engine = V8Engine::default();
        container_core::JsEngine::load_module(
            &mut engine,
            br#"
              Component({
                data: { count: 0 },
                properties: { label: { type: String, value: 'default' } },
                lifetimes: {
                  created() { this.createdCount = (this.createdCount || 0) + 1; },
                  attached() { this.trace = (this.trace || []).concat('attached'); }
                },
                methods: {
                  bump() { this.setData({ count: this.data.count + 1 }); return this.data.count; },
                  read() { return { count: this.data.count, label: this.properties.label, created: this.createdCount, trace: this.trace }; }
                }
              });
            "#,
        )
        .expect("component definition evaluates");
        let first = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_create_component_instance".into(),
            },
            vec![serde_json::json!(0)],
        )
        .expect("first instance creates");
        let second = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_create_component_instance".into(),
            },
            vec![serde_json::json!(0)],
        )
        .expect("second instance creates");
        assert_eq!(first[0]["index"], 1);
        assert_eq!(second[0]["index"], 2);
        assert_eq!(
            first[0]["snapshot"]["lifecycle"],
            serde_json::json!(["created"])
        );
        let first_mount = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_mount_component".into(),
            },
            vec![serde_json::json!(1), serde_json::json!({"label": "first"})],
        )
        .expect("first instance mounts");
        let second_mount = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_mount_component".into(),
            },
            vec![serde_json::json!(2), serde_json::json!({"label": "second"})],
        )
        .expect("second instance mounts");
        assert_eq!(first_mount[0]["snapshot"]["properties"]["label"], "first");
        assert_eq!(second_mount[0]["snapshot"]["properties"]["label"], "second");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_component".into(),
            },
            vec![
                serde_json::json!(1),
                serde_json::json!("bump"),
                serde_json::json!([]),
            ],
        )
        .expect("first instance mutates");
        let first_read = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_component".into(),
            },
            vec![
                serde_json::json!(1),
                serde_json::json!("read"),
                serde_json::json!([]),
            ],
        )
        .expect("first instance reads");
        let second_read = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_component".into(),
            },
            vec![
                serde_json::json!(2),
                serde_json::json!("read"),
                serde_json::json!([]),
            ],
        )
        .expect("second instance reads");
        assert_eq!(first_read[0]["count"], 1);
        assert_eq!(second_read[0]["count"], 0);
        assert_eq!(first_read[0]["label"], "first");
        assert_eq!(second_read[0]["label"], "second");
        assert_eq!(first_read[0]["created"], 1);
        assert_eq!(second_read[0]["created"], 1);
        assert_eq!(first_read[0]["trace"], serde_json::json!(["attached"]));
        assert_eq!(second_read[0]["trace"], serde_json::json!(["attached"]));
        let definition = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_component_snapshot".into(),
            },
            vec![serde_json::json!(0)],
        )
        .expect("definition snapshot reads");
        assert_eq!(definition[0]["data"]["count"], 0);
        assert_eq!(definition[0]["properties"]["label"], "default");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn component_mount_update_and_detach_have_stable_lifecycle_and_property_observers() {
        let mut engine = V8Engine::default();
        container_core::JsEngine::load_module(
            &mut engine,
            br#"
              Component({
                data: { count: 0 },
                properties: {
                  title: { type: String, value: 'default', observer(next, previous) { this.descriptorObserved = [next, previous]; } }
                },
                observers: {
                  'title, count': function(title, count) { this.observed = [title, count]; }
                },
                lifetimes: {
                  created() { this.lifecycleMarker = 'created'; },
                  attached() { this.attachedMarker = true; },
                  ready() { this.readyMarker = true; },
                  detached() { this.detachedMarker = true; }
                },
                methods: { read() { return { lifecycleMarker: this.lifecycleMarker, attached: this.attachedMarker, ready: this.readyMarker, detached: this.detachedMarker, observed: this.observed, descriptorObserved: this.descriptorObserved }; } }
              });
            "#,
        )
        .expect("component registration evaluates");
        let mounted = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_mount_component".into(),
            },
            vec![
                serde_json::json!(0),
                serde_json::json!({"title": "first", "count": 1}),
            ],
        )
        .expect("component mounts");
        assert_eq!(
            mounted[0]["snapshot"]["lifecycle"],
            serde_json::json!(["created", "attached", "ready"])
        );
        assert_eq!(mounted[0]["snapshot"]["mounted"], true);
        let read = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_component".into(),
            },
            vec![
                serde_json::json!(0),
                serde_json::json!("read"),
                serde_json::json!([]),
            ],
        )
        .expect("component method is callable");
        assert_eq!(read[0]["observed"], serde_json::json!(["first", 1]));
        assert_eq!(
            read[0]["descriptorObserved"],
            serde_json::json!(["first", "default"])
        );
        let updated = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_update_component".into(),
            },
            vec![serde_json::json!(0), serde_json::json!({"title": "second"})],
        )
        .expect("component properties update");
        assert_eq!(updated[0]["changes"][0]["oldValue"], "first");
        let detached = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_unmount_component".into(),
            },
            vec![serde_json::json!(0)],
        )
        .expect("component detaches");
        assert_eq!(
            detached[0]["snapshot"]["lifecycle"],
            serde_json::json!(["created", "attached", "ready", "detached"])
        );
        assert_eq!(detached[0]["snapshot"]["mounted"], false);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn app_page_component_registration_and_component_set_data_match_facade() {
        let mut engine = V8Engine::default();
        assert_eq!(engine.mode(), EngineMode::V8);
        container_core::JsEngine::load_module(
            &mut engine,
            br#"
              App({ globalData: { ready: true }, onLaunch() { return this.globalData.ready; } });
              const Base = Behavior({ data: { fromBehavior: true }, methods: { ping() { return 'pong'; } } });
              Component({ behaviors: [Base], properties: { title: { type: String, value: 'Default' } }, observers: { 'title': function(value) { this.observed = value; } }, lifetimes: { created() { this.created = true; } } });
            "#,
        )
        .expect("registration module evaluates");
        let launch = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_app".into(),
            },
            vec![serde_json::json!("onLaunch"), serde_json::json!([])],
        )
        .expect("app hook is callable");
        assert_eq!(launch, vec![serde_json::json!(true)]);
        let ping = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_component".into(),
            },
            vec![
                serde_json::json!(0),
                serde_json::json!("ping"),
                serde_json::json!([]),
            ],
        )
        .expect("behavior method is callable");
        assert_eq!(ping, vec![serde_json::json!("pong")]);
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_invoke_component".into(),
            },
            vec![
                serde_json::json!(0),
                serde_json::json!("setData"),
                serde_json::json!([{ "title": "Updated" }]),
            ],
        )
        .expect("component setData is callable");
        let snapshot = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_component_snapshot".into(),
            },
            vec![serde_json::json!(0)],
        )
        .expect("component snapshot is callable");
        assert_eq!(snapshot[0]["data"]["fromBehavior"], true);
        assert_eq!(snapshot[0]["properties"]["title"], "Default");
        assert_eq!(snapshot[0]["created"], true);
        assert_eq!(snapshot[0]["observed"], "Updated");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn get_current_pages_returns_active_page_objects_with_route_and_query() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"
              Page({ data: { count: 1 } });
              Page({ data: { count: 2 } });
              exports.read = function() {
                return getCurrentPages().map(function(page) {
                  return { route: page.route, options: page.options, count: page.data.count, hasSetData: typeof page.setData === 'function' };
                });
              };
            "#,
        )
        .expect("page registration evaluates");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_set_current_pages".into(),
            },
            vec![
                serde_json::json!([0, 1]),
                serde_json::json!([
                    {"index": 0, "route": "pages/home", "options": {"from": "launch"}},
                    {"index": 1, "route": "pages/detail", "options": {"id": "7"}}
                ]),
            ],
        )
        .expect("page stack installs");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "read".into(),
            },
            Vec::new(),
        )
        .expect("getCurrentPages evaluates");
        assert_eq!(
            result,
            vec![
                serde_json::json!({"route": "pages/home", "options": {"from": "launch"}, "count": 1, "hasSetData": true}),
                serde_json::json!({"route": "pages/detail", "options": {"id": "7"}, "count": 2, "hasSetData": true})
            ]
        );
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_set_current_pages".into(),
            },
            vec![serde_json::json!([1]), serde_json::json!([])],
        )
        .expect("page stack updates");
        let active = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "read".into(),
            },
            Vec::new(),
        )
        .expect("updated getCurrentPages evaluates");
        assert_eq!(active.len(), 1);
        assert_eq!(active[0]["route"], "pages/detail");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn get_current_pages_preserves_duplicate_route_instance_identity_and_data() {
        let mut engine = V8Engine::default();
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"
              Page({ data: { count: 0 } });
              exports.read = function() {
                const pages = getCurrentPages();
                return { same: pages[0] === pages[1], pages: pages.map(function(page) {
                  return { route: page.route, id: page.options.id, count: page.data.count };
                }) };
              };
              exports.bumpFirst = function() { getCurrentPages()[0].setData({ count: 1 }); };
            "#,
        )
        .expect("page registration evaluates");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_set_current_pages".into(),
            },
            vec![
                serde_json::json!([0, 0]),
                serde_json::json!([
                    {"index": 0, "instanceId": 11, "route": "pages/detail", "options": {"id": "first"}},
                    {"index": 0, "instanceId": 12, "route": "pages/detail", "options": {"id": "second"}}
                ]),
            ],
        )
        .expect("duplicate page stack installs");
        let before = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "read".into(),
            },
            Vec::new(),
        )
        .expect("duplicate page snapshot reads");
        assert_eq!(before[0]["same"], false);
        assert_eq!(before[0]["pages"][0]["id"], "first");
        assert_eq!(before[0]["pages"][1]["id"], "second");

        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "bumpFirst".into(),
            },
            Vec::new(),
        )
        .expect("first page setData succeeds");
        let effects = engine.drain_host_events().expect("setData event drains");
        assert_eq!(effects[0]["events"][0]["pageId"], 11);
        let after = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "read".into(),
            },
            Vec::new(),
        )
        .expect("duplicate page snapshot re-reads");
        assert_eq!(after[0]["pages"][0]["count"], 1);
        assert_eq!(after[0]["pages"][1]["count"], 0);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn request_payment_facade_validates_and_batches_typed_options() {
        let mut engine = V8Engine::default();
        engine
            .set_capabilities(&std::collections::BTreeMap::from([(
                "wx.requestPayment".to_owned(),
                "partial".to_owned(),
            )]))
            .expect("payment capability installs");
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              wx.requestPayment({
                timeStamp: '1710000000', nonceStr: 'nonce-123', package: 'prepay_id=wx123',
                signType: 'RSA', paySign: 'signed-value',
                success: function(value) { globalThis.__payment = value; },
                complete: function(value) { globalThis.__payment_complete = value.errMsg; }
              });
              return { canUse: wx.canIUse('wx.requestPayment'), type: typeof wx.requestPayment };
            };
            exports.invalid = function() {
              const pending = wx.requestPayment({ timeStamp: '1710000000' });
              pending.catch(function(value) { globalThis.__payment_error = value; });
              return true;
            };
            exports.status = function() { return { payment: globalThis.__payment || null, complete: globalThis.__payment_complete || null, error: globalThis.__payment_error || null }; };"#,
        )
        .expect("payment facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("payment call queues");
        assert_eq!(result[0]["canUse"], true);
        assert_eq!(result[0]["type"], "function");
        let events = engine.drain_host_events().expect("payment event drains");
        let event = &events[0]["events"][0];
        assert_eq!(event["name"], "wx.requestPayment");
        assert_eq!(event["options"]["signType"], "RSA");
        let request_id = event["id"].as_u64().expect("request id");
        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![
                request_id.into(),
                serde_json::json!({"errMsg": "requestPayment:ok", "sandbox": true}),
                serde_json::Value::Null,
            ],
        )
        .expect("payment callback resolves");
        container_core::JsEngine::drain_microtasks(&mut engine).expect("payment callback drains");
        let status = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "status".into(),
            },
            Vec::new(),
        )
        .expect("payment status reads");
        assert_eq!(status[0]["payment"]["errMsg"], "requestPayment:ok");
        assert_eq!(status[0]["complete"], "requestPayment:ok");

        container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "invalid".into(),
            },
            Vec::new(),
        )
        .expect("invalid payment call returns rejected promise");
        container_core::JsEngine::drain_microtasks(&mut engine)
            .expect("invalid payment rejection drains");
        let status = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "status".into(),
            },
            Vec::new(),
        )
        .expect("invalid payment status reads");
        assert_eq!(status[0]["error"]["code"], "ERR_INVALID_REQUEST");
        let invalid_events = engine
            .drain_host_events()
            .expect("invalid payment diagnostics");
        assert_eq!(invalid_events[0]["events"], serde_json::json!([]));
        assert_eq!(
            invalid_events[0]["errors"][0]["code"],
            "ERR_INVALID_REQUEST"
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn permission_facade_preserves_subscription_settings_option_and_result() {
        let mut engine = V8Engine::default();
        engine
            .set_capabilities(&std::collections::BTreeMap::from([
                ("wx.getSetting".to_owned(), "partial".to_owned()),
                ("wx.openSetting".to_owned(), "partial".to_owned()),
            ]))
            .expect("permission capabilities install");
        let module = container_core::JsEngine::load_module(
            &mut engine,
            br#"exports.run = function() {
              wx.getSetting({ withSubscriptions: true, success: function(value) { globalThis.__get = value; } });
              wx.openSetting({ withSubscriptions: true, success: function(value) { globalThis.__open = value; } });
              return { get: typeof wx.getSetting, open: typeof wx.openSetting };
            };
            exports.status = function() { return { get: globalThis.__get || null, open: globalThis.__open || null }; };"#,
        )
        .expect("permission facade evaluates");
        let result = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            Vec::new(),
        )
        .expect("permission calls queue");
        assert_eq!(result[0]["get"], "function");
        assert_eq!(result[0]["open"], "function");
        let events = engine.drain_host_events().expect("permission events drain");
        let mut ids = Vec::new();
        for event in events[0]["events"].as_array().expect("events") {
            assert_eq!(event["options"]["withSubscriptions"], true);
            ids.push((
                event["name"].as_str().unwrap().to_owned(),
                event["id"].as_u64().unwrap(),
            ));
        }
        assert_eq!(ids.len(), 2);
        for (name, id) in ids {
            let public_name = name.strip_prefix("wx.").unwrap();
            let result = serde_json::json!({
                "authSetting": {},
                "subscriptionsSetting": {"mainSwitch": true, "itemSettings": {"tmpl": "accept"}},
                "errMsg": format!("{public_name}:ok")
            });
            container_core::JsEngine::call(
                &mut engine,
                container_core::CallTarget::Global {
                    name: "__container_resolve_api".into(),
                },
                vec![id.into(), result, serde_json::Value::Null],
            )
            .expect("permission callback resolves");
        }
        container_core::JsEngine::drain_microtasks(&mut engine)
            .expect("permission callbacks drain");
        let status = container_core::JsEngine::call(
            &mut engine,
            container_core::CallTarget::Module {
                id: module,
                export: "status".into(),
            },
            Vec::new(),
        )
        .expect("permission status reads");
        assert_eq!(status[0]["get"]["subscriptionsSetting"]["mainSwitch"], true);
        assert_eq!(
            status[0]["open"]["subscriptionsSetting"]["itemSettings"]["tmpl"],
            "accept"
        );
    }
}

#[cfg(all(test, feature = "v8-native"))]
mod selector_query_conformance {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/selector-query-engine.rs");
}

#[cfg(all(test, feature = "v8-native"))]
mod managed_component_conformance {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/managed-component-engine.rs");
}

#[cfg(all(test, feature = "v8-native"))]
mod component_selection_conformance {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/component-selection-engine.rs");
}

#[cfg(all(test, feature = "v8-native"))]
mod native_batch_conformance {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/native-batch-engine.rs");
}

#[cfg(all(test, feature = "v8-native"))]
mod host_environment_tests;

#[cfg(all(test, feature = "v8-native"))]
mod receiver_incarnation_tests {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/receiver-incarnation-engine.rs");
}

#[cfg(all(test, feature = "v8-native"))]
mod storage_transaction_tests {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/storage-engine.rs");
}

#[cfg(all(test, feature = "v8-native"))]
mod media_query_tests {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/media-query-engine.rs");
}

#[cfg(all(test, feature = "v8-native"))]
mod basic_selector_query_engine_contract {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/selector-basic-engine.rs");
}

#[cfg(all(test, feature = "v8-native", not(target_arch = "wasm32")))]
mod turn_scheduler_tests {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/turn-scheduler-engine.rs");
}

#[cfg(all(test, feature = "v8-native", not(target_arch = "wasm32")))]
mod nexttick_owner_tests {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/nexttick-owner-engine.rs");
}

#[cfg(all(test, feature = "v8-native", not(target_arch = "wasm32")))]
mod nexttick_canvas_tests {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/nexttick-canvas-engine.rs");
}

#[cfg(all(test, feature = "v8-native", not(target_arch = "wasm32")))]
mod nexttick_framework_tests {
    type NativeEngine = super::V8Engine;
    include!("../../../fixtures/nexttick-framework-engine.rs");
}

#[cfg(all(test, feature = "v8-native"))]
mod log_manager_tests {
    use super::V8Engine as Engine;
    include!("../../container-core/src/log-manager-tests.rs");
}

#[cfg(all(test, feature = "v8-native"))]
mod buffer_url_retirement_tests;
