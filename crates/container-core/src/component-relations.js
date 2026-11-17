const __container_component_relation_report_error = globalThis.__container_report_error;
// Executable definition metadata and live component references never cross
// JSON/FFI. Both engines use this same behavior/relationship implementation.
const __container_behavior_definitions = Object.create(null);
let __container_behavior_sequence = 0;
globalThis.__container_component_relation_pages = Object.create(null);

function __container_component_relation_error(message, code) {
  return __container_component_protocol_error(message, code);
}

globalThis.Behavior = function(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw __container_component_relation_error("Behavior definition must be an object");
  }
  const id = "weapp-container://behavior/" + (++__container_behavior_sequence);
  __container_behavior_definitions[id] = options;
  return id;
};

function __container_merge_component_options(target, source, traversal, isBehavior) {
  const state = traversal || { seen: [], active: [] };
  if (state.active.indexOf(source) >= 0) throw __container_component_relation_error("behavior definitions contain a cycle");
  if (state.seen.indexOf(source) >= 0) return target;
  let option = source || {};
  if (isBehavior) {
    const identities = target.__container_behavior_ids || (target.__container_behavior_ids = []);
    if (identities.indexOf(source) < 0) identities.push(source);
  }
  if (option === "wx://component-export") {
    target.__container_component_export_behavior = true;
    state.seen.push(source);
    return target;
  }
  if (typeof option === "string") {
    if (!Object.prototype.hasOwnProperty.call(__container_behavior_definitions, option)) {
      throw __container_component_relation_error("behavior is unavailable: " + option, "ERR_UNSUPPORTED_CAPABILITY");
    }
    option = __container_behavior_definitions[option];
  }
  if (!option || typeof option !== "object" || Array.isArray(option)) {
    throw __container_component_relation_error("component/behavior definition must be an object");
  }
  state.active.push(source);
  if (Array.isArray(option.behaviors)) {
    option.behaviors.forEach(function(behavior) { __container_merge_component_options(target, behavior, state, true); });
  }
  // Definition order is postorder and shared behaviors run only once, even
  // through a diamond. Preserve executable hooks instead of JSON cloning.
  if (typeof option.export === "function") target.__container_component_export = option.export;
  if (typeof option.data === "function") {
    const value = option.data.call(target);
    if (value && typeof value === "object" && !Array.isArray(value)) target.data = Object.assign(target.data || {}, __container_clone(value));
  } else if (option.data && typeof option.data === "object") {
    target.data = Object.assign(target.data || {}, __container_clone(option.data));
  }
  if (option.properties && typeof option.properties === "object") {
    target.properties = target.properties || {};
    Object.keys(option.properties).forEach(function(name) { target.properties[name] = option.properties[name]; });
  }
  if (option.methods && typeof option.methods === "object") {
    target.methods = Object.assign(target.methods || {}, option.methods);
    Object.keys(option.methods).forEach(function(name) { target[name] = option.methods[name]; });
  }
  ["observers", "lifetimes", "pageLifetimes"].forEach(function(name) {
    if (option[name] && typeof option[name] === "object") target[name] = Object.assign(target[name] || {}, option[name]);
  });
  const hooks = target.__container_lifecycle_hooks || (target.__container_lifecycle_hooks = Object.create(null));
  ["created", "attached", "ready", "moved", "detached", "error"].forEach(function(name) {
    const hook = option.lifetimes && typeof option.lifetimes[name] === "function" ? option.lifetimes[name] : option[name];
    if (typeof hook === "function") (hooks[name] || (hooks[name] = [])).push(hook);
  });
  if (option.relations !== undefined) {
    if (!option.relations || typeof option.relations !== "object" || Array.isArray(option.relations)) {
      throw __container_component_relation_error("component relations must be an object");
    }
    if (Object.keys(option.relations).length && __container_capability("Component.relations") === "unsupported") {
      throw __container_error("Component.relations", "unsupported");
    }
    const relations = target.__container_relation_definitions || (target.__container_relation_definitions = Object.create(null));
    Object.keys(option.relations).forEach(function(key) {
      const relation = option.relations[key];
      if (!key.trim() || !relation || typeof relation !== "object" || Array.isArray(relation)
          || ["parent", "child", "ancestor", "descendant"].indexOf(relation.type) < 0) {
        throw __container_component_relation_error("invalid component relation: " + key);
      }
      const value = { type: relation.type };
      if (typeof relation.linkChanged === "function") {
        // A compacted result-array index is not a physical move. The view
        // frontier must supply verified move identities before this callback
        // can be implemented without emitting false movement notifications.
        throw __container_component_relation_error("relation linkChanged requires component move metadata", "ERR_UNSUPPORTED_CAPABILITY");
      }
      if (Object.prototype.hasOwnProperty.call(relation, "target")) {
        if (typeof relation.target !== "string" || !Object.prototype.hasOwnProperty.call(__container_behavior_definitions, relation.target)) {
          throw __container_component_relation_error("relation target must be a registered Behavior identifier", "ERR_UNSUPPORTED_CAPABILITY");
        }
        value.target = relation.target;
      }
      ["linked", "unlinked"].forEach(function(name) {
        if (typeof relation[name] === "function") value[name] = relation[name];
      });
      relations[key] = Object.freeze(value);
    });
  }
  state.active.pop();
  state.seen.push(source);
  return target;
}

function __container_install_component_relations(instance, definition) {
  instance.__container_behavior_ids = (definition && definition.__container_behavior_ids || instance.__container_behavior_ids || []).slice();
  instance.__container_relation_definitions = definition && definition.__container_relation_definitions || instance.__container_relation_definitions || Object.create(null);
  instance.__container_relation_nodes = Object.create(null);
  instance.hasBehavior = function(identifier) {
    if (__container_capability("Component.hasBehavior") === "unsupported") throw __container_error("Component.hasBehavior", "unsupported");
    return this.__container_behavior_ids.indexOf(identifier) >= 0;
  };
  instance.getRelationNodes = function(key) {
    if (__container_capability("Component.getRelationNodes") === "unsupported") throw __container_error("Component.getRelationNodes", "unsupported");
    // detached is still a live callback with access to the old graph. Scope
    // lookup would reject it, and could later select a different occurrence.
    if (this.__container_disposed || typeof key !== "string") return [];
    const nodes = this.__container_relation_nodes[key];
    return Array.isArray(nodes) ? nodes.slice() : [];
  };
}

function __container_component_relation_path(moduleId, key) {
  const file = String(moduleId || "").replace(/^module:/, "");
  const directory = file.slice(0, Math.max(0, file.lastIndexOf("/")));
  const source = key[0] === "/" ? key.slice(1) : directory + "/" + key;
  const parts = [];
  for (const part of source.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/").replace(/\.(?:js|mjs|cjs)$/, "");
}

function __container_component_relation_matches(source, key, descriptor, target) {
  if (Object.prototype.hasOwnProperty.call(descriptor, "target")) return target.__container_behavior_ids.indexOf(descriptor.target) >= 0;
  const path = __container_component_relation_path(source.__container_module_id, key);
  return path !== null && path === String(target.__container_module_id || "").replace(/^module:/, "").replace(/\.(?:js|mjs|cjs)$/, "");
}

// Validate physical ancestry before any user hook. A proposed batch may
// reference a surviving parent outside that frontier, so inspect both maps.
function __container_validate_component_relation_records(records, pageId) {
  const parents = Object.create(null);
  Object.keys(__container_component_scopes).forEach(function(scope) {
    const instance = __container_component_scopes[scope];
    if (String(instance.__container_page_id) === String(pageId)) parents[scope] = instance.__container_parent_scope_id;
  });
  records.forEach(function(entry) { parents[entry.record.scopeId] = entry.record.parentScopeId; });
  const visited = Object.create(null);
  Object.keys(parents).forEach(function(scope) {
    const path = [];
    while (scope != null && Object.prototype.hasOwnProperty.call(parents, scope) && visited[scope] !== 2) {
      if (visited[scope] === 1) throw __container_component_relation_error("component physical ancestry contains a cycle");
      visited[scope] = 1;
      path.push(scope);
      scope = parents[scope];
    }
    path.forEach(function(id) { visited[id] = 2; });
  });
}

function __container_component_relation_tables(instances) {
  return instances.map(function(instance) { return { instance: instance, nodes: Object.create(null) }; });
}

function __container_publish_component_relation_tables(pageId, tables, silent) {
  const page = String(pageId);
  const previous = __container_component_relation_pages[page] || [];
  const previousSet = new Set(previous);
  const byInstance = new Map(tables.map(function(table) { return [table.instance, table]; }));
  const order = previous.concat(tables.map(function(table) { return table.instance; }).filter(function(instance) { return !previousSet.has(instance); }));
  const removed = [];
  const added = [];
  // Compute notifications before replacing any table; publish every table
  // before invoking either side so callbacks see one complete graph.
  order.forEach(function(instance) {
    const table = byInstance.get(instance);
    const before = instance.__container_relation_nodes || Object.create(null);
    const after = table ? table.nodes : Object.create(null);
    Object.keys(instance.__container_relation_definitions || {}).forEach(function(key) {
      const oldNodes = before[key] || [];
      const newNodes = after[key] || [];
      const oldSet = new Set(oldNodes);
      const newSet = new Set(newNodes);
      oldNodes.forEach(function(target) { if (!newSet.has(target)) removed.push({ instance: instance, key: key, target: target }); });
      newNodes.forEach(function(target) { if (!oldSet.has(target)) added.push({ instance: instance, key: key, target: target }); });
    });
    instance.__container_relation_nodes = after;
  });
  if (tables.length) __container_component_relation_pages[page] = tables.map(function(table) { return table.instance; });
  else delete __container_component_relation_pages[page];
  if (silent) return;
  const invoke = function(event, name) {
    const descriptor = event.instance.__container_relation_definitions[event.key];
    if (descriptor && typeof descriptor[name] === "function") {
      try { __container_turn_scheduler.invokeOwned(event.instance, descriptor[name], [event.target]); } catch (error) { __container_component_relation_report_error(error); }
    }
  };
  removed.forEach(function(event) { invoke(event, "unlinked"); });
  added.forEach(function(event) { invoke(event, "linked"); });
}

function __container_remove_component_relations(instances, pageId) {
  const previous = __container_component_relation_pages[String(pageId)] || [];
  const removed = new Set(instances);
  const tables = __container_component_relation_tables(previous.filter(function(instance) { return !removed.has(instance); }));
  tables.forEach(function(table) {
    const old = table.instance.__container_relation_nodes || {};
    Object.keys(old).forEach(function(key) { table.nodes[key] = old[key].filter(function(target) { return !removed.has(target); }); });
  });
  __container_publish_component_relation_tables(pageId, tables, false);
}

function __container_dispose_component_scopes(scopes, pageId) {
  const seen = Object.create(null);
  const pending = [];
  const removed = Object.create(null);
  scopes.slice().reverse().forEach(function(scopeId) {
    if (seen[scopeId]) return;
    seen[scopeId] = true;
    const instance = __container_component_scopes[scopeId];
    if (!instance || String(instance.__container_page_id) !== String(pageId)) return;
    pending.push(instance);
    // Both endpoints and all old edges remain alive throughout detached.
    __container_component_lifecycle(instance, "detached", []);
  });
  __container_remove_component_relations(pending, pageId);
  const disposed = pending.map(function(instance) {
    const scope = instance.__container_scope_id;
    instance.__container_disposed = true;
    instance.__container_relation_nodes = Object.create(null);
    if (__container_component_scopes[scope] === instance) delete __container_component_scopes[scope];
    instance.__container_selection = null;
    removed[scope] = true;
    __container_components[instance.__container_component_index] = null;
    return { scopeId: scope, index: instance.__container_component_index, snapshot: __container_component_snapshot_value(instance) };
  });
  const key = String(pageId);
  const selected = __container_component_selection_pages[key];
  if (selected) {
    const survivors = selected.filter(function(node) {
      return !(node.componentScopeId !== null && removed[node.componentScopeId])
        && !(node.ownerScopeId !== null && removed[node.ownerScopeId]);
    });
    if (survivors.length) __container_component_selection_pages[key] = survivors;
    else delete __container_component_selection_pages[key];
  }
  __container_dispose_component_event_scopes(scopes, pageId);
  return disposed;
}

function __container_live_component_batch(batch) {
  if (!batch || batch.version !== 1 || !Array.isArray(batch.scopeIds)
      || !(typeof batch.pageId === "string" && batch.pageId.trim() || Number.isSafeInteger(batch.pageId) && batch.pageId >= 0)) {
    throw __container_component_relation_error("invalid component relation batch");
  }
  const byScope = Object.create(null);
  const instances = batch.scopeIds.map(function(scope) {
    const instance = __container_component_scopes[scope];
    if (typeof scope !== "string" || byScope[scope] || !instance || instance.__container_disposed
        || !instance.__container_attached_lifecycle || instance.__container_detached_lifecycle
        || String(instance.__container_page_id) !== String(batch.pageId)) {
      throw __container_component_relation_error("component relation scope is unavailable or duplicated");
    }
    byScope[scope] = instance;
    return instance;
  });
  return instances;
}

// Refresh authoritative JS data before template evaluation. In particular,
// repairing invalid data must not require successfully evaluating stale data.
globalThis.__container_snapshot_component_scopes = function(batch) {
  return { instances: __container_live_component_batch(batch).map(function(instance) {
    return { scopeId: instance.__container_scope_id, index: instance.__container_component_index, snapshot: __container_component_snapshot_value(instance) };
  }) };
};

globalThis.__container_commit_component_relations = function(batch) {
  if (!batch || typeof batch.silent !== "boolean") throw __container_component_relation_error("invalid component relation commit");
  const instances = __container_live_component_batch(batch);
  const byScope = Object.create(null);
  instances.forEach(function(instance) { byScope[instance.__container_scope_id] = instance; });
  const tables = __container_component_relation_tables(instances);
  instances.forEach(function(instance) {
    const parent = instance.__container_parent_scope_id;
    if (parent != null && !byScope[parent]) throw __container_component_relation_error("component relation parent is outside the page frontier");
  });
  const tableByScope = Object.create(null);
  tables.forEach(function(table) { table.seen = Object.create(null); tableByScope[table.instance.__container_scope_id] = table; });
  const add = function(source, key, target) {
    const table = tableByScope[source.__container_scope_id];
    const list = table.nodes[key] || (table.nodes[key] = []);
    const seen = table.seen[key] || (table.seen[key] = new Set());
    if (!seen.has(target)) { seen.add(target); list.push(target); }
  };
  // Walk composed component ancestry once per occurrence; native wrappers do
  // not create parents, and slot declaration ownership is deliberately absent.
  instances.forEach(function(child) {
    let ancestor = child.__container_parent_scope_id == null ? null : byScope[child.__container_parent_scope_id];
    let direct = true;
    const seen = [];
    while (ancestor) {
      if (seen.indexOf(ancestor) >= 0) throw __container_component_relation_error("component relation ancestry contains a cycle");
      seen.push(ancestor);
      Object.keys(ancestor.__container_relation_definitions).forEach(function(upperKey) {
        const upper = ancestor.__container_relation_definitions[upperKey];
        const opposite = upper.type === "child" && direct ? "parent" : upper.type === "descendant" ? "ancestor" : null;
        if (!opposite || !__container_component_relation_matches(ancestor, upperKey, upper, child)) return;
        Object.keys(child.__container_relation_definitions).forEach(function(lowerKey) {
          const lower = child.__container_relation_definitions[lowerKey];
          if (lower.type === opposite && __container_component_relation_matches(child, lowerKey, lower, ancestor)) {
            add(ancestor, upperKey, child);
            add(child, lowerKey, ancestor);
          }
        });
      });
      ancestor = ancestor.__container_parent_scope_id == null ? null : byScope[ancestor.__container_parent_scope_id];
      direct = false;
    }
  });
  __container_publish_component_relation_tables(batch.pageId, tables, batch.silent);
  return { instances: instances.map(function(instance) {
    return { scopeId: instance.__container_scope_id, index: instance.__container_component_index, snapshot: __container_component_snapshot_value(instance) };
  }) };
};

// Preserve the existing compatibility entry points. Actual producers share
// the lexical receiver/turn scope; the scheduler and its driver stay private.
globalThis.__container_component_relation_error = __container_component_relation_error;
globalThis.__container_merge_component_options = __container_merge_component_options;
globalThis.__container_install_component_relations = __container_install_component_relations;
globalThis.__container_component_relation_path = __container_component_relation_path;
globalThis.__container_component_relation_matches = __container_component_relation_matches;
globalThis.__container_validate_component_relation_records = __container_validate_component_relation_records;
globalThis.__container_component_relation_tables = __container_component_relation_tables;
globalThis.__container_publish_component_relation_tables = __container_publish_component_relation_tables;
globalThis.__container_remove_component_relations = __container_remove_component_relations;
globalThis.__container_dispose_component_scopes = __container_dispose_component_scopes;
globalThis.__container_live_component_batch = __container_live_component_batch;
