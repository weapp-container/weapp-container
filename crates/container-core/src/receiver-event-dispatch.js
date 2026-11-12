// Called once by the native bootstrap after component-events has been loaded,
// before application code. Neither the factory nor its result is published as
// an application global; native code retains the resulting function directly.
const __receiver_apply = Reflect.apply;
const __receiver_set_prototype = Object.setPrototypeOf;
const __receiver_run_owner = __container_turn_scheduler.withOwner;
const __receiver_report_error = globalThis.__container_report_error;
function __receiver_event_dispatcher(dispatchOwnedEvent) {
  if (typeof dispatchOwnedEvent !== "function") throw "native event dispatcher unavailable";
  return function(request) {
    const pageId = __receiver_value(request, "pageId");
    const expected = __receiver_value(request, "expected");
    const pageToken = __receiver_value(expected, "pageToken");
    const scopes = __receiver_value(expected, "scopes");
    const event = __receiver_value(request, "event");
    const dispatches = __receiver_value(event, "dispatches");
    if (typeof pageId !== "string" || typeof pageToken !== "string"
        || !scopes || typeof scopes !== "object" || __host_is_array(scopes)
        || !__host_is_array(dispatches) || dispatches.length > 100000) {
      throw "invalid native receiver event request";
    }
    let retired = false;
    function current(scopeId, receiver) {
      if (retired) return null;
      if (!__host_page_table_current()
          || __receiver_value(__receiver_global, "__container_component_scopes") !== __receiver_scope_table) {
        retired = true; return null;
      }
      const page = __receiver_value(__receiver_pages, pageId);
      if (!page || page.retired || page.token !== pageToken
          || __host_page_receiver(pageId) !== page.receiver
          || __receiver_get(__receiver_weak, page.receiver) !== page) {
        retired = true; return null;
      }
      let entry = page;
      if (scopeId != null) {
        const token = typeof scopeId === "string" && __receiver_value(scopes, scopeId);
        entry = typeof token === "string" && __receiver_value(__receiver_scopes, scopeId);
        if (!entry || entry.retired || entry.token !== token || entry.pageId !== pageId
            || entry.pageToken !== pageToken
            || __receiver_value(__receiver_scope_table, scopeId) !== entry.receiver
            || __receiver_get(__receiver_weak, entry.receiver) !== entry) {
          retired = true; return null;
        }
      }
      if (receiver !== undefined && entry.receiver !== receiver) {
        retired = true; return null;
      }
      return entry.receiver;
    }
    // Validate the complete native snapshot and listener frontier before any
    // callback, getter, error hook, or application microtask can execute.
    current(null);
    const keys = __host_keys(scopes);
    if (keys.length > 100000) throw "native receiver event scope budget exceeded";
    for (let index = 0; index < keys.length && !retired; index += 1) {
      const scope = keys[index];
      if (typeof scope !== "string" || !scope) throw "invalid native receiver event scope";
      current(scope);
    }
    for (let index = 0; index < dispatches.length && !retired; index += 1) {
      const dispatch = __receiver_value(dispatches, __host_string(index));
      if (!dispatch || typeof dispatch !== "object") throw "invalid native receiver event listener";
      const descriptor = __host_get_own(dispatch, "ownerScopeId");
      current(descriptor ? descriptor.value : __receiver_value(event, "ownerScopeId"));
    }
    // A constant is intentional: even an empty array otherwise inherits an
    // application-supplied Object.prototype.toJSON during a stale admission.
    if (retired) return '{"version":"1.0","retired":true,"results":[]}';
    const guard = __host_create(null);
    guard.scope = function(dispatch) {
      const descriptor = __host_get_own(dispatch, "ownerScopeId");
      return descriptor ? descriptor.value : __receiver_value(event, "ownerScopeId");
    };
    guard.resolve = function(scopeId) { return current(scopeId); };
    guard.handler = function(scopeId, receiver, name) {
      if (!current(scopeId, receiver)) return undefined;
      let hook = receiver;
      let part = "";
      // Runtime supplies the handler path. Do not let replaced String/Array
      // methods rewrite that path into a different application method.
      for (let index = 0; index <= name.length; index += 1) {
        const character = index < name.length ? name[index] : ".";
        if (character !== ".") { part += character; continue; }
        if (!part) continue;
        if (hook == null) return hook;
        hook = hook[part];
        part = "";
        // A path getter may unload/rebuild this receiver or a later segment.
        // Never inspect the next segment on a retired incarnation.
        if (!current(scopeId, receiver)) return undefined;
      }
      return hook;
    };
    guard.invoke = function(scopeId, receiver, hook, value) {
      const outcome = __host_create(null);
      outcome.called = false;
      if (!current(scopeId, receiver)) return outcome;
      outcome.value = __receiver_run_owner(receiver, function() {
        // Keep this check next to the captured call intrinsic. Handler lookup
        // may have executed an application getter that rebuilt this scope.
        if (!current(scopeId, receiver)) return undefined;
        outcome.called = true;
        return __receiver_apply(hook, receiver, [value]);
      });
      return outcome;
    };
    let encodedResults;
    try {
      const results = dispatchOwnedEvent(current(null), event, false,
        __receiver_value(request, "rethrowHandlerError") === true, guard);
      // These containers belong to the dispatcher. Remove inherited toJSON
      // hooks without changing an application's returned value or receiver.
      __receiver_set_prototype(results, null);
      for (let index = 0; index < results.length; index += 1) __receiver_set_prototype(results[index], null);
      // Returned application values may run getters/toJSON while encoded.
      // They remain part of this task; authorize the outcome only afterwards.
      encodedResults = __receiver_json(results);
    } catch (error) {
      __receiver_report_error(error);
      throw error;
    }
    current(null);
    for (let index = 0; index < keys.length && !retired; index += 1) current(keys[index]);
    return '{"version":"1.0","retired":' + (retired ? 'true' : 'false') + ',"results":' + encodedResults + '}';
  };
}
