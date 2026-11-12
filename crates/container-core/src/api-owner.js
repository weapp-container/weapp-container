// Shared synchronous API ownership for both AppService engines. Context and
// JavaScript receiver are independent: callers keep their existing call/apply
// form inside the thunk. Returning a Promise never extends this stack frame.
(function() {
  const isArray = Array.isArray;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const ownKeys = Reflect.ownKeys;
  let currentOwner = null;
  let domQueryEnabled = false;
  let domQueryRevision = 0;

  // This opt-in is installed by the runtime together with its capability map.
  // The default keeps legacy Skia queries on their existing facade path.
  globalThis.__container_set_dom_query_contract = function(contract) {
    const object = contract && typeof contract === "object" && !isArray(contract);
    const version = object && getOwnPropertyDescriptor(contract, "version");
    const enabled = object && getOwnPropertyDescriptor(contract, "enabled");
    if (!object || ownKeys(contract).length !== 2
        || !version || version.value !== "1.0"
        || !enabled || typeof enabled.value !== "boolean") {
      throw { code: "ERR_PROTOCOL_VERSION", message: "DOM query requires the explicit version 1.0 contract" };
    }
    if (domQueryEnabled !== enabled.value) domQueryRevision += 1;
    domQueryEnabled = enabled.value;
  };
  globalThis.__container_dom_query_enabled = function() { return domQueryEnabled; };
  globalThis.__container_dom_query_revision = function() { return domQueryRevision; };

  globalThis.__container_run_with_api_owner = function(owner, thunk) {
    const previous = currentOwner;
    currentOwner = owner;
    try { return thunk(); }
    finally { currentOwner = previous; }
  };

  // Strict capture never borrows the latest page. The identity validator checks
  // the actual live instance maps, so a reused page/scope id cannot resurrect a
  // destroyed receiver. Visibility and runtime leases are validated separately
  // by the API that eventually consumes this owner.
  globalThis.__container_capture_api_owner = function() {
    const owner = currentOwner;
    return owner && typeof owner === "object"
      && !owner.__container_disposed && !owner.__container_detached_lifecycle
      && typeof __container_component_selection_context === "function"
      && __container_component_selection_context(owner) ? owner : null;
  };

  // Existing observers also accept legacy/unmanaged lifecycle receivers and
  // fall back to the latest page outside a context. Keep that compatibility
  // policy separate from strict capture for future asynchronous geometry APIs.
  globalThis.__container_api_owner_for_observer = function() { return currentOwner; };
  globalThis.__container_with_observer_owner = function(owner, callback, args) {
    return __container_run_with_api_owner(owner, function() {
      return callback.apply(owner, args || []);
    });
  };
})();
