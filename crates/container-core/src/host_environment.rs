//! One native-to-AppService environment installation, without a job checkpoint.
use crate::StorageSnapshot;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// `None` preserves the bootstrap-owned live business container. In particular,
/// a geometry repair must not rewind storage/file writes awaiting effect drain.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostEnvironmentSnapshot {
    pub version: String,
    pub capabilities: BTreeMap<String, String>,
    pub dom_query: bool,
    pub sync_api_values: Map<String, Value>,
    pub sync_api_errors: Map<String, Value>,
    pub storage: Option<StorageSnapshot>,
    pub files: Option<Map<String, Value>>,
}

/// Compile the existing facade in one bootstrap-owned scope. The explicit
/// function exports preserve the shared bootstrap/embedding entry names;
/// host maps and receiver identities remain lexical cells. The returned
/// transports are retained by native code before any application executes.
pub fn app_service_environment_bootstrap(facade: &str) -> String {
    [
        "(function() {\nconst __host_scheduler_clock = globalThis.__container_host_performance_now;\nconst __host_create = Object.create;\nconst __host_string = String;\nlet __host_storage_head = null;\nlet __host_storage_tail = null;\nlet __host_drain_pending = null;\nlet __host_drain_id = 0;\nconst __host_define = Object.defineProperty;\nconst __host_get_own = Object.getOwnPropertyDescriptor;\nconst __host_keys = Reflect.ownKeys;\nconst __host_is_array = Array.isArray;\nconst __host_dom = globalThis.__container_set_dom_query_contract;\n",
        CONFORMANCE_EXCEPTION_JOURNAL,
        CONFORMANCE_RUNTIME_LOG_JOURNAL,
        RECEIVER_INCARNATIONS,
        RECEIVER_CAPTURE_HEAD,
        CONFORMANCE_GUEST_CAPTURE,
        RECEIVER_CAPTURE_BODY,
        facade,
        include_str!("error-notifications.js"),
        include_str!("page-not-found-notifications.js"),
        include_str!("unhandled-rejections.js"),
        include_str!("window-resize-notifications.js"),
        include_str!("host-layout-notifications.js"),
        include_str!("finite-notifications.js"),
        include_str!("storage.js"),
        include_str!("animation.js"),
        include_str!("canvas.js"),
        include_str!("owned-canvas.js"),
        include_str!("dev-console.js"),
        include_str!("log-manager.js"),
        include_str!("event-channel.js"),
        include_str!("tab-bar.js"),
        include_str!("random-values.js"),
        include_str!("buffer-url.js"),
        "\nconst __receiver_page_table = __container_page_instances;\nconst __receiver_scope_table = __container_component_scopes;\n",
        include_str!("app-service-environment-exports.js"),
        include_str!("page-mirror.js"),
        include_str!("turn-scheduler.js"),
        CONFORMANCE_GUEST_OBSERVER,
        include_str!("component-events.js"),
        include_str!("component-presentation.js"),
        include_str!("component-relations.js"),
        include_str!("media-query-observers.js"),
        include_str!("intersection-observers.js"),
        include_str!("selector-query.js"),
        include_str!("route-transaction.js"),
        include_str!("lifecycle-notifications.js"),
        include_str!("performance.js"),
        include_str!("component-pages.js"),
        include_str!("modules.js"),
        "\nconst __host_install_environment = (function() {\n",
        include_str!("host-environment-install.js"),
        "\n})();\n",
        include_str!("receiver-event-dispatch.js"),
        "\nconst __host_batch_call = ",
        include_str!("engine-batch-call.js"),
        ";\nreturn { batchCall: __host_batch_call, trackPromiseRejection: __container_unhandled_rejections.track, flushUnhandledRejections: __container_unhandled_rejections.flush, installHostEnvironment: __host_install_environment, captureReceiverIncarnations: __receiver_capture, createReceiverEventDispatcher: __receiver_event_dispatcher, bindEventChannel: __container_event_channels.bind, dispatchLifecycleNotification: __container_lifecycle_notifications.dispatch, dispatchRouteNotification: function(name,payload) { return name === 'before' ? __container_routes.before(payload) : name === 'after' ? __container_routes.after(payload) : false; } };\n})()",
    ]
    .concat()
}

// No public object property carries an incarnation. Registration happens only
// when the facade creates an actual receiver; reads never mint identities for
// objects found in application-writable aliases. Captured intrinsics and own
// data descriptors keep this transport independent of prototype replacement,
// getters, toJSON and application microtask checkpoints.
const RECEIVER_INCARNATIONS: &str = r#"
const __receiver_global = globalThis;
const __receiver_weak = new WeakMap();
const __receiver_get = Function.prototype.call.bind(WeakMap.prototype.get);
const __receiver_set = Function.prototype.call.bind(WeakMap.prototype.set);
const __receiver_json = JSON.stringify;
const __receiver_pages = __host_create(null);
const __receiver_scopes = __host_create(null);
let __receiver_current_pages = null;
let __receiver_sequence = 0n;
let __receiver_component_head = null;
let __receiver_component_tail = null;
let __receiver_write_head = null;
let __receiver_write_tail = null;
let __receiver_write_bytes = 0;
let __receiver_write_count = 0;
let __receiver_host_write_sequence = 0n;
let __receiver_host_write_count = 0;
const __receiver_host_writes = __host_create(null);
const __receiver_bigint = BigInt;
function __receiver_value(object, key) {
  if (!object || typeof object !== "object") return undefined;
  const descriptor = __host_get_own(object, key);
  const data = descriptor && __host_get_own(descriptor, "value");
  return data ? data.value : undefined;
}
function __receiver_retire(receiver) {
  const entry = receiver && typeof receiver === "object" ? __receiver_get(__receiver_weak, receiver) : null;
  if (entry) {
    entry.retired = true;
    let write = entry.writeHead;
    while (write) { write.ownerAlive = false; if (!write.queued) { __receiver_write_bytes -= write.charge; __receiver_write_count--; } write = write.entryNext; }
    entry.writeHead = entry.writeTail = null;
    const table = entry.scopeId === null ? __receiver_pages : __receiver_scopes;
    const key = entry.scopeId === null ? entry.pageId : entry.scopeId;
    if (__receiver_value(table, key) === entry) delete table[key];
  }
}
function __receiver_register(receiver, pageId, scopeId) {
  if (!receiver || typeof receiver !== "object") throw "invalid native receiver";
  const previous = __receiver_get(__receiver_weak, receiver);
  if (previous) {
    if (previous.retired || previous.pageId !== pageId || previous.scopeId !== scopeId) throw "retired native receiver cannot be registered";
    return;
  }
  if (__receiver_sequence >= 18446744073709551615n) throw "native receiver identity exhausted";
  const entry = __host_create(null);
  entry.token = __host_string(++__receiver_sequence);
  entry.receiver = receiver;
  entry.pageId = pageId;
  entry.scopeId = scopeId;
  const page = scopeId === null ? null : __receiver_value(__receiver_pages, pageId);
  entry.pageToken = scopeId === null ? entry.token : page && !page.retired ? page.token : null;
  entry.componentRevision = 0n;
  entry.componentSequence = 0n;
  entry.componentActive = 0;
  entry.writeSequence = 0n;
  entry.writeActive = 0;
  entry.writeHead = entry.writeTail = null;
  entry.retired = false;
  const table = scopeId === null ? __receiver_pages : __receiver_scopes;
  const key = scopeId === null ? pageId : scopeId;
  const replaced = __receiver_value(table, key);
  if (replaced) __receiver_retire(replaced.receiver);
  __receiver_set(__receiver_weak, receiver, entry);
  const descriptor = __host_create(null);
  descriptor.value = entry;
  descriptor.writable = descriptor.enumerable = descriptor.configurable = true;
  __host_define(table, key, descriptor);
}
// Component mutation stamps belong to actual private receiver incarnations.
// Reads never mint/advance identities. Captured intrinsics avoid application
// getters, mutable receiver properties and replacement global functions.
// Successful write attempts have an independent private ledger: equal writes
// must not become dirty mutations or observer notifications. Reserve bounded
// storage before getters/writes; finish performs only preallocated cell moves.
function __receiver_write_begin(receiver, paths, local) {
  const entry = receiver && typeof receiver === "object" ? __receiver_get(__receiver_weak, receiver) : null;
  if (!__host_is_array(paths)) throw "invalid native write paths";
  // Legacy component bridge instances have no Page/managed occurrence owner.
  // They keep ordinary setData/property semantics without receiving animation
  // identity. Public receiver metadata cannot upgrade this private absence.
  if (!entry) return null;
  if (entry.retired) throw "native write receiver unavailable";
  const length = __receiver_value(paths, "length");
  if (!length) return null;
  if (length > 100000 || entry.writeSequence + __receiver_bigint(entry.writeActive) >= 18446744073709551615n) throw "native write ledger exhausted";
  const normalized = [];
  let charge = 128;
  for (let index = 0; index < length; index++) {
    const raw = __receiver_value(paths, __host_string(index));
    if (typeof raw !== "string" || raw.length > 2796202) throw "native write path byte budget exceeded";
    const parts = __container_path_parts(raw);
    if (!parts || parts.length > 256) throw "invalid native write path";
    const copy = [];
    for (let part = 0; part < parts.length; part++) {
      const value = parts[part];
      charge += typeof value === "string" ? value.length * 3 + 24 : 24;
      __host_define(copy, __host_string(part), {__proto__:null,value:value,writable:true,enumerable:true,configurable:true});
    }
    charge += 32;
    if (charge > 8388608) throw "native write path byte budget exceeded";
    __host_define(normalized, __host_string(index), {__proto__:null,value:copy,writable:true,enumerable:true,configurable:true});
  }
  if (__receiver_write_count >= 100000 || __receiver_write_bytes + charge > 8388608) throw "native write aggregate budget exceeded";
  const write = __host_create(null);
  write.entry = entry; write.paths = normalized; write.charge = charge; write.local = local !== false;
  write.ownerAlive = true; write.queued = false; write.next = write.entryNext = null;
  __receiver_write_bytes += charge; __receiver_write_count++; entry.writeActive++;
  return write;
}
function __receiver_write_finish(write, completed) {
  if (!write) return;
  const entry = write.entry;
  entry.writeActive--;
  if (!completed || entry.retired) { __receiver_write_bytes -= write.charge; __receiver_write_count--; return; }
  write.stamp = __host_string(++entry.writeSequence);
  // A newer ancestor/equal write supersedes an older complete path record.
  // Prune only fully covered records; pending drain retains its own reference.
  let old = entry.writeHead, previous = null;
  while (old) {
    let covered = true;
    for (let item = 0; item < old.paths.length && covered; item++) {
      let matched = false;
      for (let candidate = 0; candidate < write.paths.length && !matched; candidate++) {
        const prefix = write.paths[candidate], path = old.paths[item];
        if (prefix.length <= path.length) { matched = true; for (let part = 0; part < prefix.length; part++) if (prefix[part] !== path[part]) { matched = false; break; } }
      }
      if (!matched) covered = false;
    }
    const next = old.entryNext;
    if (covered) {
      if (previous) previous.entryNext = next; else entry.writeHead = next;
      if (entry.writeTail === old) entry.writeTail = previous;
      old.ownerAlive = false;
      if (!old.queued) { __receiver_write_bytes -= old.charge; __receiver_write_count--; }
    } else previous = old;
    old = next;
  }
  write.pageId = entry.pageId; write.pageToken = entry.pageToken || entry.token;
  write.scopeId = entry.scopeId; write.instanceToken = entry.token; write.queued = true;
  if (entry.writeTail) entry.writeTail.entryNext = write; else entry.writeHead = write;
  entry.writeTail = write;
  if (__receiver_write_tail) __receiver_write_tail.next = write; else __receiver_write_head = write;
  __receiver_write_tail = write;
}
function __receiver_write_snapshot(entry) {
  if (!entry || entry.retired || entry.writeActive) throw "native write snapshot is not a completed prefix";
  const byPath = __host_create(null), values = [];
  let write = entry.writeHead;
  while (write) {
    for (let item = 0; item < write.paths.length; item++) {
      const value = __host_create(null); value.path = write.paths[item]; value.stamp = write.stamp; value.local = write.local;
      __host_define(byPath, __receiver_snapshot_json(value.path), {__proto__:null,value:value,enumerable:true,configurable:true});
    }
    write = write.entryNext;
  }
  const keys = __host_keys(byPath);
  if (keys.length > 100000) throw "native write snapshot path budget exceeded";
  for (let index = 0; index < keys.length; index++) __host_define(values, __host_string(index), {__proto__:null,value:__receiver_value(byPath, keys[index]),enumerable:true});
  return values;
}
function __receiver_write_receipts(request) {
  const pending = __host_drain_pending;
  if (!pending || __receiver_value(request, "drainId") !== pending.id) throw "native write receipt unavailable";
  const values = __host_create(null);
  let write = __receiver_write_head, index = 0;
  while (write && pending.writeTail) {
    const value = __host_create(null);
    value.pageId = write.pageId; value.pageToken = write.pageToken;
    value.scopeId = write.scopeId; value.instanceToken = write.instanceToken;
    value.stamp = write.stamp; value.paths = write.paths; value.local = write.local;
    __host_define(values, __host_string(index++), {__proto__:null,value:value,enumerable:true});
    if (write === pending.writeTail) break;
    write = write.next;
  }
  return __receiver_snapshot_json(values);
}
function __receiver_write_ack(tail) {
  let write = __receiver_write_head;
  while (write && tail) {
    write.queued = false;
    if (!write.ownerAlive) { __receiver_write_bytes -= write.charge; __receiver_write_count--; }
    if (write === tail) { __receiver_write_head = write.next; if (!__receiver_write_head) __receiver_write_tail = null; return; }
    write = write.next;
  }
}

function __receiver_component_input(receiver) {
  const entry = receiver && typeof receiver === "object" ? __receiver_get(__receiver_weak, receiver) : null;
  if (!entry || entry.retired || entry.scopeId === null || entry.componentActive || entry.writeActive) return null;
  const value = __host_create(null);
  value.instanceToken = entry.token;
  value.mutationRevision = __host_string(entry.componentRevision);
  value.writeSnapshot = __receiver_write_snapshot(entry);
  return value;
}
// Reserve before writes, but publish only a completed mutation prefix. A
// reentrant snapshot during getters/observers has no consumable authority.
function __receiver_component_begin(receiver) {
  const entry = receiver && typeof receiver === "object" ? __receiver_get(__receiver_weak, receiver) : null;
  if (!entry || entry.retired || entry.scopeId === null) return null;
  if (entry.componentSequence >= 18446744073709551615n) throw "component input revision exhausted";
  const mutation = __host_create(null);
  mutation.entry = entry;
  mutation.revision = ++entry.componentSequence;
  mutation.identity = __host_create(null);
  mutation.identity.instanceToken = entry.token;
  mutation.identity.mutationRevision = __host_string(mutation.revision);
  entry.componentActive += 1;
  return mutation;
}
function __receiver_component_finish(mutation, dirty) {
  if (!mutation) return;
  const entry = mutation.entry;
  entry.componentActive -= 1;
  mutation.dirty = dirty;
  if (!dirty) return;
  if (entry.componentRevision < mutation.revision) entry.componentRevision = mutation.revision;
  const patch = __host_create(null);
  patch.pageId = entry.pageId;
  patch.scopeId = entry.scopeId;
  patch.instanceToken = entry.token;
  patch.mutationRevision = __host_string(mutation.revision);
  patch.next = null;
  if (__receiver_component_tail) __receiver_component_tail.next = patch;
  else __receiver_component_head = patch;
  __receiver_component_tail = patch;
}
// Encode only own data, without inherited toJSON, getters or mutable
// serialization functions. The bounded result is a proof of the actual
// snapshot returned by the facade, independent of its public JSON transport.
function __receiver_snapshot_json(source, budget, measurement) {
  let count = 0;
  function encode(value, depth) {
    if (++count > (budget || 100000) || depth > 64) throw "component snapshot proof budget exceeded";
    if (value === null) return "null";
    const kind = typeof value;
    if (kind === "string" || kind === "boolean") return __receiver_json(value);
    if (kind === "number") return value === value && value !== 1/0 && value !== -1/0 ? __receiver_json(value) : "null";
    if (kind === "undefined" || kind === "function" || kind === "symbol") return undefined;
    if (kind !== "object") throw "component snapshot is not JSON";
    let text = "";
    if (__host_is_array(value)) {
      const length = __receiver_value(value, "length");
      for (let index = 0; index < length; index += 1) {
        const item = encode(__receiver_value(value, __host_string(index)), depth + 1);
        text += (index ? "," : "") + (item === undefined ? "null" : item);
      }
      return "[" + text + "]";
    }
    const keys = __host_keys(value);
    let written = 0;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") continue;
      const descriptor = __host_get_own(value, key);
      if (!descriptor || !descriptor.enumerable) continue;
      const data = __host_get_own(descriptor, "value");
      if (!data) throw "component snapshot proof cannot read an accessor";
      const item = encode(data.value, depth + 1);
      if (item !== undefined) text += (written++ ? "," : "") + __receiver_json(key) + ":" + item;
    }
    return "{" + text + "}";
  }
  const encoded = encode(source, 0);
  // Internal callers can charge the exact same successful traversal that
  // defines the capture limit. Measurement never inspects guest properties.
  if (measurement) __host_define(measurement, "items", {__proto__:null,value:count});
  return encoded;
}
function __receiver_record_component_snapshot(receiver, snapshot, instanceToken, mutationRevision, writeSnapshot) {
  const entry = __receiver_get(__receiver_weak, receiver);
  if (!entry || entry.retired || entry.scopeId === null) return snapshot;
  const record = __host_create(null);
  record.identity = __host_create(null);
  record.identity.instanceToken = instanceToken;
  record.identity.mutationRevision = mutationRevision;
  record.writeSnapshot = writeSnapshot;
  try { record.json = __receiver_snapshot_json(snapshot); }
  catch (_) { record.json = null; }
  entry.snapshotReceipt = record;
  return snapshot;
}
// Capture a completed mutation inside its ordinary guest turn. Development
// candidates only read this immutable receipt; they never traverse live data,
// run a serializer/getter or checkpoint jobs in the retained AppService.
function __receiver_record_component_data(mutation) {
  if (!mutation || !mutation.dirty) return;
  const entry = mutation.entry;
  entry.dataReceipt = null;
  try {
    const input = __receiver_component_input(entry.receiver);
    if (!input) return;
    const snapshot = __host_create(null);
    snapshot.data = __receiver_value(entry.receiver, "data");
    snapshot.properties = __receiver_value(entry.receiver, "properties");
    const record = __host_create(null);
    record.identity = __host_create(null);
    record.identity.instanceToken = input.instanceToken;
    record.identity.mutationRevision = input.mutationRevision;
    record.writeSnapshot = input.writeSnapshot;
    record.json = __receiver_snapshot_json(snapshot);
    entry.dataReceipt = record;
  } catch (_) { /* Optional development capture cannot fail a completed write. */ }
}
function __receiver_component_mutations(request) {
  const pending = __host_drain_pending;
  if (!pending || __receiver_value(request, "drainId") !== pending.id) throw "component drain receipt unavailable";
  const result = __host_create(null);
  let patch = __receiver_component_head;
  let index = 0;
  while (patch && pending.componentTail) {
    if (index >= 100000) throw "component mutation batch exceeded";
    const value = __host_create(null);
    value.pageId = patch.pageId;
    value.scopeId = patch.scopeId;
    value.instanceToken = patch.instanceToken;
    value.mutationRevision = patch.mutationRevision;
    __host_define(result, __host_string(index++), {__proto__:null,value:value,enumerable:true});
    if (patch === pending.componentTail) break;
    patch = patch.next;
  }
  return __receiver_json(result);
}
"#;

const RECEIVER_CAPTURE_HEAD: &str = r#"
function __receiver_capture(request) {
"#;

#[cfg(feature = "conformance-observation")]
const CONFORMANCE_GUEST_CAPTURE: &str = r#"
  if (__receiver_value(request, "kind") === "conformance-exceptions") {
    return __container_conformance_exceptions.capture(__receiver_value(request, "request"));
  }
  if (__receiver_value(request, "kind") === "conformance-guest-method") {
    return __container_conformance_guest.capture(__receiver_value(request, "request"));
  }
"#;
#[cfg(not(feature = "conformance-observation"))]
const CONFORMANCE_GUEST_CAPTURE: &str = "";

#[cfg(feature = "conformance-observation")]
const CONFORMANCE_GUEST_OBSERVER: &str = include_str!("conformance-guest-observation.js");
#[cfg(not(feature = "conformance-observation"))]
const CONFORMANCE_GUEST_OBSERVER: &str = "";

const RECEIVER_CAPTURE_BODY: &str = r#"
  const hostWriteKind = __receiver_value(request, "kind");
  if (hostWriteKind === "component-presentation") return __container_component_presentation(request);
  if (hostWriteKind === "animation-host-write-prepare") {
    const page = __receiver_value(__receiver_pages, __receiver_value(request, "pageId"));
    if (!page || page.retired) throw "native host write page unavailable";
    if (__receiver_host_write_count >= 256 || __receiver_host_write_sequence >= 18446744073709551615n) throw "native host write ticket exhausted";
    const write = __receiver_write_begin(page.receiver, __receiver_value(request, "paths"), false);
    const ticket = __host_string(++__receiver_host_write_sequence);
    __receiver_host_write_count++;
    __host_define(__receiver_host_writes, ticket, {__proto__:null,value:write,configurable:true});
    return __receiver_json({__proto__:null,ticket:ticket});
  }
  if (hostWriteKind === "animation-host-write-finish") {
    const ticket = __receiver_value(request, "ticket"), descriptor = __host_get_own(__receiver_host_writes,ticket);
    if (!descriptor || typeof __receiver_value(request,"completed") !== "boolean") throw "native host write ticket unavailable";
    delete __receiver_host_writes[ticket]; __receiver_host_write_count--; __receiver_write_finish(descriptor.value,__receiver_value(request,"completed"));
    return "true";
  }
  if (__receiver_value(request, "kind") === "canvas-draw-requests") return __container_owned_canvases.capture(request);
  if (__receiver_value(request, "kind") === "turn-scheduler") return __container_turn_scheduler.capture(request);
  if (__receiver_value(request, "kind") === "selector-query-requests") return __container_selector_queries.capture(request);
  const animationWrites = __receiver_value(request, "kind") === "animation-write-snapshot";
  const privateQuery = animationWrites || __receiver_value(request, "kind") === "selector-query-receivers";
  if (__receiver_value(request, "kind") === "finite-notification-snapshot") return __container_finite_notifications.snapshot();
  if (__receiver_value(request, "kind") === "storage-pending") return __host_storage_through(__host_storage_tail);
  if (__receiver_value(request, "kind") === "storage-transactions") return __host_storage_capture(request);
  if (__receiver_value(request, "kind") === "component-mutations") return __receiver_component_mutations(request);
  if (__receiver_value(request, "kind") === "data-write-receipts") return __receiver_write_receipts(request);
  if (__receiver_value(request, "kind") === "media-query-state") return __container_media_queries.capture(request);
  if (__receiver_value(request, "kind") === "intersection-query-state") return __container_intersections.capture(request);
  const pageId = __receiver_value(request, "pageId");
  const scopes = __receiver_value(request, "scopes");
  if (typeof pageId !== "string" || !__host_is_array(scopes) || scopes.length > 100000) throw "invalid native receiver request";
  // Public maps are compatibility aliases, never an identity minting surface.
  if (!privateQuery && (!__host_page_table_current()
      || __receiver_value(__receiver_global, "__container_component_scopes") !== __receiver_scope_table)) throw "native receiver tables unavailable";
  const page = __receiver_value(__receiver_pages, pageId);
  if (!page || page.retired || (!privateQuery && __host_page_receiver(pageId) !== page.receiver)) throw "native page receiver unavailable";
  const result = __host_create(null);
  result.pageToken = page.token;
  if (animationWrites) result.pageWrites = __receiver_write_snapshot(page);
  result.scopes = __host_create(null);
  for (let index = 0; index < scopes.length; index += 1) {
    const scope = __receiver_value(scopes, __host_string(index));
    if (typeof scope !== "string" || scope.length === 0 || __receiver_value(result.scopes, scope) !== undefined) throw "invalid native receiver scope";
    const entry = __receiver_value(__receiver_scopes, scope);
    if (!entry || entry.retired || entry.pageId !== pageId || entry.pageToken !== page.token
        || (!privateQuery && __receiver_value(__receiver_scope_table, scope) !== entry.receiver)) throw "native component receiver unavailable";
    const descriptor = __host_create(null);
    if (__receiver_value(request, "componentSnapshots") === true) {
      const record = __receiver_value(request, "componentData") === true ? entry.dataReceipt : entry.snapshotReceipt;
      const proof = __host_create(null);
      proof.identity = record ? record.identity : null;
      proof.snapshotJson = record ? record.json : null;
      proof.writeSnapshot = record ? record.writeSnapshot : null;
      descriptor.value = proof;
    } else if (animationWrites) {
      const proof = __host_create(null); proof.instanceToken = entry.token; proof.writes = __receiver_write_snapshot(entry); descriptor.value = proof;
    } else descriptor.value = entry.token;
    descriptor.writable = descriptor.enumerable = descriptor.configurable = true;
    __host_define(result.scopes, scope, descriptor);
  }
  return __receiver_value(request, "componentData") === true
    ? __receiver_snapshot_json(result) : __receiver_json(result);
}
"#;

#[cfg(feature = "conformance-observation")]
const CONFORMANCE_EXCEPTION_JOURNAL: &str = include_str!("conformance-exceptions.js");
#[cfg(not(feature = "conformance-observation"))]
const CONFORMANCE_EXCEPTION_JOURNAL: &str = "const __container_conformance_exceptions = null;\n";

#[cfg(feature = "conformance-observation")]
const CONFORMANCE_RUNTIME_LOG_JOURNAL: &str = include_str!("conformance-runtime-logs.js");
#[cfg(not(feature = "conformance-observation"))]
const CONFORMANCE_RUNTIME_LOG_JOURNAL: &str =
    "const __container_conformance_runtime_logs = null;\n";
