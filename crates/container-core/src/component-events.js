const __container_component_event_report_error = globalThis.__container_report_error;
// Event routes are published once per component frontier. Component events
// stay in the isolate: listeners run before triggerEvent returns, and detail
// never crosses JSON/FFI merely to reach a parent in the same AppService.
const __container_event_page_lookup = globalThis.__container_native_page_lookup;
globalThis.__container_component_event_pages = Object.create(null);
// A new render frontier may remove an occurrence before its detached hook.
// Retain that occurrence's last route until disposal, with object identity so
// a later occurrence reusing the scope can never inherit a retired route.
globalThis.__container_retiring_component_events = Object.create(null);
let __container_component_event_depth = 0;

function __container_component_event_error(message, code) {
  const error = __container_component_protocol_error(message, code);
  error.api = "Component.triggerEvent";
  error.errMsg = "triggerEvent:fail " + message;
  return error;
}

function __container_component_event_map(value, strings) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw __container_component_event_error("event node metadata must be an object");
  }
  const result = Object.create(null);
  Object.keys(value).forEach(function(key) {
    if (strings && typeof value[key] !== "string") {
      throw __container_component_event_error("event attributes must contain strings");
    }
    result[key] = __container_clone(value[key]);
  });
  return result;
}

// This validation has no side effects. Reconcile calls it after validating the
// complete instance/selection batch, before disposing or invoking user hooks.
function __container_prepare_component_event_batch(batch, records) {
  if (batch.eventNodes === undefined) return undefined;
  if (!Array.isArray(batch.eventNodes)) {
    throw __container_component_event_error("eventNodes must be an array");
  }
  const pageId = String(batch.pageId);
  const scopes = Object.create(null);
  const nodes = Object.create(null);
  const hosts = Object.create(null);
  records.forEach(function(record) { scopes[record.scopeId] = record; });
  batch.eventNodes.forEach(function(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)
        || typeof record.key !== "string" || !record.key.trim() || nodes[record.key]
        || !(record.parentKey == null || typeof record.parentKey === "string" && record.parentKey.trim())
        || !__container_component_scope(record.ownerScopeId, true)
        || !__container_component_scope(record.componentScopeId, true)) {
      throw __container_component_event_error("event node keys and scope identities must be valid and unique");
    }
    const owner = record.ownerScopeId == null ? null : record.ownerScopeId;
    const scope = record.componentScopeId == null ? null : record.componentScopeId;
    if (owner !== null && !scopes[owner]) {
      throw __container_component_event_error("event node owner is outside the page frontier");
    }
    if (scope !== null) {
      if (!scopes[scope] || hosts[scope]
          || (scopes[scope].ownerScopeId == null ? null : scopes[scope].ownerScopeId) !== owner) {
        throw __container_component_event_error("event host must match exactly one component occurrence");
      }
      hosts[scope] = record.key;
    }
    nodes[record.key] = {
      key: record.key,
      parentKey: record.parentKey == null ? null : record.parentKey,
      ownerScopeId: owner,
      componentScopeId: scope,
      attributes: __container_component_event_map(record.attributes, true),
      dataset: __container_component_event_map(record.dataset, false),
      mark: __container_component_event_map(record.mark, false)
    };
  });
  Object.keys(scopes).forEach(function(scope) {
    if (!hosts[scope]) throw __container_component_event_error("component occurrence is missing its event host");
  });
  const visited = Object.create(null);
  Object.keys(nodes).forEach(function(key) {
    const chain = [];
    let node = nodes[key];
    while (node && visited[node.key] !== 2) {
      if (visited[node.key] === 1) throw __container_component_event_error("event node ancestry contains a cycle");
      visited[node.key] = 1;
      chain.push(node.key);
      if (node.parentKey !== null && !nodes[node.parentKey]) {
        throw __container_component_event_error("event node parent is outside the page frontier");
      }
      node = node.parentKey === null ? null : nodes[node.parentKey];
    }
    chain.forEach(function(id) { visited[id] = 2; });
  });
  return { pageId: pageId, nodes: nodes, hosts: hosts };
}

function __container_publish_component_event_batch(batch, graph) {
  if (graph === undefined) return;
  const pageId = String(batch.pageId);
  const previous = __container_component_event_pages[pageId];
  const retiring = __container_retiring_component_events[pageId] || Object.create(null);
  Object.keys(retiring).forEach(function(scopeId) {
    const source = __container_component_scopes[scopeId];
    if (graph.hosts[scopeId] || !source || source.__container_disposed || retiring[scopeId].instance !== source) {
      delete retiring[scopeId];
    }
  });
  if (previous) {
    Object.keys(previous.hosts).forEach(function(scopeId) {
      const source = __container_component_scopes[scopeId];
      if (!graph.hosts[scopeId] && !retiring[scopeId] && source && !source.__container_disposed
          && String(source.__container_page_id) === pageId) {
        retiring[scopeId] = { graph: previous, instance: source };
      }
    });
  }
  if (Object.keys(retiring).length) __container_retiring_component_events[pageId] = retiring;
  else delete __container_retiring_component_events[pageId];
  if (Object.keys(graph.nodes).length) __container_component_event_pages[pageId] = graph;
  else delete __container_component_event_pages[pageId];
}

function __container_dispose_component_event_scopes(scopes, pageId) {
  const key = String(pageId);
  const retiring = __container_retiring_component_events[key];
  if (retiring) {
    scopes.forEach(function(scope) { delete retiring[scope]; });
    if (!Object.keys(retiring).length) delete __container_retiring_component_events[key];
  }
  const graph = __container_component_event_pages[key];
  if (!graph) return;
  const removed = Object.create(null);
  scopes.forEach(function(scope) { removed[scope] = true; });
  const nodes = Object.create(null);
  const hosts = Object.create(null);
  Object.keys(graph.nodes).forEach(function(key) {
    let node = graph.nodes[key];
    while (node) {
      if (removed[node.componentScopeId] || removed[node.ownerScopeId]) return;
      node = node.parentKey === null ? null : graph.nodes[node.parentKey];
    }
    const retained = graph.nodes[key];
    nodes[key] = retained;
    if (retained.componentScopeId !== null) hosts[retained.componentScopeId] = key;
  });
  // A page with no surviving source occurrences cannot emit custom events.
  if (Object.keys(hosts).length) __container_component_event_pages[key] = { pageId: key, nodes: nodes, hosts: hosts };
  else delete __container_component_event_pages[key];
}

function __container_component_event_binding(node, type, capture) {
  const prefix = capture ? "capture-" : "";
  // The fixed SDK oracle selects bare bind for alphanumeric/underscore names
  // when both aliases exist. Hyphenated names require the colon form.
  const separators = /^[A-Za-z0-9_]+$/.test(type) ? ["", ":"] : [":"];
  for (let kindIndex = 0; kindIndex < 2; kindIndex += 1) {
    const kind = kindIndex === 0 ? "catch" : "bind";
    for (let index = 0; index < separators.length; index += 1) {
      const handler = node.attributes[prefix + kind + separators[index] + type];
      if (typeof handler === "string" && handler.trim()) return { handler: handler.trim(), catches: kind === "catch" };
    }
  }
  return null;
}

// Both native input and component events use the same listener/control loop.
// Routing records are an immutable snapshot for one dispatch, so a nested
// triggerEvent or a user callback cannot replace the outer event's ancestry.
function __container_dispatch_owned_event(page, event, preserveDetail, rethrowHandlerError, receiverGuard) {
  if (!page || !event || !Array.isArray(event.dispatches)) return [];
  const handlers = event.handlers && typeof event.handlers === "object" ? event.handlers : {};
  const fallback = typeof event.handler === "string" ? event.handler
    : (typeof event.method === "string" ? event.method : null);
  const results = [];
  let propagationStopped = false;
  let immediatePropagationStopped = false;
  let defaultPrevented = false;
  let previousCurrentTarget = null;
  for (let dispatchIndex = 0; dispatchIndex < event.dispatches.length; dispatchIndex += 1) {
    const dispatch = event.dispatches[dispatchIndex];
    const currentTargetId = dispatch.current_target || dispatch.currentTarget || "";
    if (immediatePropagationStopped || (propagationStopped && previousCurrentTarget !== currentTargetId)) break;
    // The opt-in native transport supplies a bootstrap-private validator.
    // Resolve the actual incarnation before touching an application handler.
    let ownerScopeId;
    let owner = page;
    if (receiverGuard) {
      ownerScopeId = receiverGuard.scope(dispatch);
      owner = receiverGuard.resolve(ownerScopeId);
      if (!owner) break;
    }
    const name = typeof dispatch.handler === "string" && dispatch.handler ? dispatch.handler
      : (handlers[dispatch.current_target] || handlers[dispatch.currentTarget] || (dispatch.phase === "target" ? fallback : null));
    if (typeof name !== "string" || !name) { previousCurrentTarget = currentTargetId; continue; }
    if (!receiverGuard) ownerScopeId = Object.prototype.hasOwnProperty.call(dispatch, "ownerScopeId") ? dispatch.ownerScopeId : event.ownerScopeId;
    if (!receiverGuard && ownerScopeId != null) {
      owner = typeof ownerScopeId === "string" ? __container_component_scopes[ownerScopeId] : null;
      if (preserveDetail && (!owner || page.__container_instance_id != null
          && String(owner.__container_page_id) !== String(page.__container_instance_id))) {
        throw __container_component_event_error("declared event receiver is unavailable on this page");
      }
      if (!owner || owner.__container_disposed || page.__container_instance_id != null
          && String(owner.__container_page_id) !== String(page.__container_instance_id)) {
        previousCurrentTarget = currentTargetId;
        continue;
      }
    }
    let hook;
    if (receiverGuard) {
      hook = receiverGuard.handler(ownerScopeId, owner, name);
    } else {
      const parts = name.split(".").filter(function(part) { return part.length > 0; });
      hook = owner;
      for (let cursor = 0; cursor < parts.length && hook != null; cursor += 1) hook = hook[parts[cursor]];
    }
    if (receiverGuard && receiverGuard.resolve(ownerScopeId) !== owner) break;
    if (typeof hook !== "function") { previousCurrentTarget = currentTargetId; continue; }
    const publicCurrentTargetId = Object.prototype.hasOwnProperty.call(dispatch, "publicCurrentTargetId")
      ? dispatch.publicCurrentTargetId : currentTargetId;
    const publicTargetId = Object.prototype.hasOwnProperty.call(dispatch, "publicTargetId")
      ? dispatch.publicTargetId : (dispatch.target || "");
    const currentTarget = { id: publicCurrentTargetId, dataset: __container_clone(dispatch.dataset || {}) };
    const target = { id: publicTargetId, dataset: __container_clone(
      Object.prototype.hasOwnProperty.call(dispatch, "targetDataset") ? dispatch.targetDataset : (event.dataset || dispatch.dataset || {})) };
    const detail = Object.prototype.hasOwnProperty.call(dispatch, "detail") ? dispatch.detail : event.detail;
    const value = {
      type: dispatch.type || event.type || "", target: target, currentTarget: currentTarget,
      detail: preserveDetail ? detail : __container_clone(detail === undefined ? {} : detail),
      dataset: __container_clone(dispatch.dataset || {}), mark: __container_clone(dispatch.mark || event.mark || {}),
      phase: dispatch.phase || "target", defaultPrevented: defaultPrevented, cancelBubble: false,
      stopPropagation: function() { propagationStopped = true; value.cancelBubble = true; },
      stopImmediatePropagation: function() { propagationStopped = true; immediatePropagationStopped = true; value.cancelBubble = true; },
      preventDefault: function() { defaultPrevented = true; value.defaultPrevented = true; }
    };
    if (event.timeStamp !== undefined) value.timeStamp = event.timeStamp;
    // Native surface adapters submit complete touch batches. Keep the touch
    // arrays at the documented event level, including empty touches on end
    // and cancel; custom component detail remains an independent value.
    if (Array.isArray(event.touches)) value.touches = __container_clone(event.touches);
    if (Array.isArray(event.changedTouches)) value.changedTouches = __container_clone(event.changedTouches);
    let record;
    try {
      let result;
      if (receiverGuard) {
        const invoked = receiverGuard.invoke(ownerScopeId, owner, hook, value);
        if (!invoked.called) break;
        result = invoked.value;
      } else {
        result = __container_turn_scheduler.invokeOwned(owner, hook, [value]);
      }
      record = { currentTarget: currentTarget.id, phase: value.phase, handler: name, result: result };
    } catch (error) {
      // Strict owner retirement propagates the original object to the retained
      // engine batch-call boundary, which reports the uncaught error once.
      // Reporting here as well would invoke wx.onError twice. A caller that
      // catches it inside the realm owns that exception and does not report it.
      if (rethrowHandlerError === true) throw error;
      __container_component_event_report_error(error);
      // Ordinary input and triggerEvent retain report-and-continue semantics.
      record = { currentTarget: currentTarget.id, phase: value.phase, handler: name, error: String(error && error.message || error) };
    }
    if (dispatch.catch === true) value.stopPropagation();
    if (value.cancelBubble) propagationStopped = true;
    if (defaultPrevented) record.defaultPrevented = true;
    if (propagationStopped) { record.propagationStopped = true; record.dispatchIndex = dispatchIndex; }
    if (immediatePropagationStopped) record.immediatePropagationStopped = true;
    results.push(record);
    previousCurrentTarget = currentTargetId;
  }
  return results;
}

function __container_trigger_component_event(source, name, detail, options) {
  if (__container_capability("Component.triggerEvent") === "unsupported") {
    throw __container_error("Component.triggerEvent", "unsupported");
  }
  if (typeof name !== "string" || !name.trim()) throw __container_component_event_error("event name must be a nonempty string");
  if (options === undefined) options = {};
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw __container_component_event_error("event options must be an object");
  }
  ["bubbles", "capturePhase", "composed"].forEach(function(key) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") {
      throw __container_component_event_error("event option " + key + " must be a boolean");
    }
  });
  const scopeId = source && source.__container_scope_id;
  if (!source || !source.__container_is_component_instance || source.__container_disposed
      || typeof scopeId !== "string" || __container_component_scopes[scopeId] !== source) {
    throw __container_component_event_error("component occurrence is unavailable");
  }
  const pageId = String(source.__container_page_id);
  let graph = __container_component_event_pages[pageId];
  let host = graph && graph.nodes[graph.hosts[scopeId]];
  if (!host && source.__container_detached_lifecycle === true) {
    const retiring = __container_retiring_component_events[pageId];
    const retired = retiring && retiring[scopeId];
    if (retired && retired.instance === source) {
      graph = retired.graph;
      host = graph.nodes[graph.hosts[scopeId]];
    }
  }
  const page = __container_event_page_lookup(pageId);
  if (!graph || !host || !page) {
    throw __container_component_event_error("component event routing metadata is unavailable", "ERR_UNSUPPORTED_CAPABILITY");
  }
  if (__container_component_event_depth >= 128) throw __container_component_event_error("component event recursion limit exceeded", "ERR_ENGINE");
  const bubbles = options.bubbles === true;
  const capture = options.capturePhase === true;
  const composed = options.composed === true;
  const route = [];
  let node = host;
  let target = host;
  while (node) {
    // The host's listener belongs to the template that declared it. Crossing
    // that template's component boundary requires composed; a physical slot
    // parent never changes the receiver of the host's own listener.
    if (node !== host && !composed && node.ownerScopeId !== host.ownerScopeId) break;
    if (node !== host && node.componentScopeId !== null && node.componentScopeId === target.ownerScopeId) target = node;
    route.push({ node: node, target: target });
    node = node.parentKey === null ? null : graph.nodes[node.parentKey];
  }
  let inheritedMark = Object.create(null);
  route.slice().reverse().forEach(function(entry) { Object.assign(inheritedMark, entry.node.mark); });
  const dispatches = [];
  const add = function(entry, phase, capturePhase) {
    const binding = __container_component_event_binding(entry.node, name, capturePhase);
    if (!binding) return;
    dispatches.push({
      type: name, target: host.key, currentTarget: entry.node.key, phase: phase,
      handler: binding.handler, catch: binding.catches, ownerScopeId: entry.node.ownerScopeId,
      publicCurrentTargetId: entry.node.attributes.id || "", publicTargetId: entry.target.attributes.id || "",
      dataset: entry.node.dataset, targetDataset: entry.target.dataset, mark: inheritedMark, detail: detail
    });
  };
  if (capture) route.slice().reverse().forEach(function(entry) { add(entry, "capture", true); });
  add(route[0], "target", false);
  if (bubbles) route.slice(1).forEach(function(entry) { add(entry, "bubble", false); });
  __container_component_event_depth += 1;
  try {
    const results = __container_dispatch_owned_event(page, { type: name, dispatches: dispatches, timeStamp: Date.now() }, true);
    // Detail can be cyclic or contain functions. It belongs to JavaScript and
    // must not poison JSON transport just because diagnostics record a send.
    __container_events.push({ type: "component.custom.event", pageId: source.__container_page_id,
      scopeId: scopeId, name: name, bubbles: bubbles, capturePhase: capture, composed: composed, handlers: results.length });
  } finally {
    __container_component_event_depth -= 1;
  }
}

function __container_install_component_events(instance) {
  instance.triggerEvent = function(name, detail, options) {
    return __container_trigger_component_event(this, name, detail, options);
  };
}

// Preserve the existing compatibility entry points. Actual producers share
// the lexical receiver/turn scope; the scheduler and its driver stay private.
globalThis.__container_component_event_error = __container_component_event_error;
globalThis.__container_component_event_map = __container_component_event_map;
globalThis.__container_prepare_component_event_batch = __container_prepare_component_event_batch;
globalThis.__container_publish_component_event_batch = __container_publish_component_event_batch;
globalThis.__container_dispose_component_event_scopes = __container_dispose_component_event_scopes;
globalThis.__container_component_event_binding = __container_component_event_binding;
globalThis.__container_dispatch_owned_event = __container_dispatch_owned_event;
globalThis.__container_trigger_component_event = __container_trigger_component_event;
globalThis.__container_install_component_events = __container_install_component_events;
