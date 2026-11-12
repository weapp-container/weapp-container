// Shared real async bridge for the runtime-owned tabBar state transaction.
// Copy only accepted own fields; no inherited option/toJSON crosses this wire.
(function() {
  const define = Object.defineProperty, own = Object.getOwnPropertyDescriptor;
  const create = Object.create, isArray = Array.isArray;
  const isInteger = Number.isInteger;
  const call = __container_api_call, capability = __container_capability;
  const complete = __container_async_result;
  function data(target, key, value) {
    define(target, key, {__proto__: null, value: value, enumerable: true, configurable: true, writable: true});
  }
  function read(value, key) {
    const descriptor = own(value, key);
    return descriptor && own(descriptor, "value") ? descriptor.value : undefined;
  }
  for (const method of ["setTabBarBadge", "removeTabBarBadge", "showTabBarRedDot", "hideTabBarRedDot", "setTabBarStyle", "showTabBar", "hideTabBar", "setTabBarItem"]) {
    const name = "wx." + method;
    data(wx, method, function(options) {
      const request = create(null);
      if (options && typeof options === "object" && !isArray(options)) {
        for (const key of ["success", "fail", "complete"]) {
          const callback = read(options, key);
          // Pending completion retains the original callback. It must not be
          // enumerated by the legacy JSON wire clone, which would otherwise
          // run a function's own/inherited toJSON before omitting the function.
          if (typeof callback === "function") define(request, key, {__proto__: null, value: callback});
        }
      }
      function fail(message, code) {
        return complete(request, null, {__proto__: null, api: name, code: code || "ERR_INVALID_REQUEST", errMsg: method + ":fail " + message});
      }
      if (method === "showTabBar" || method === "hideTabBar" || method === "setTabBarItem")
        return fail("unsupported", "ERR_UNSUPPORTED_CAPABILITY");
      if (capability(name) === "unsupported") return fail("unsupported", "ERR_UNSUPPORTED_CAPABILITY");
      if (options === undefined && method === "setTabBarStyle") options = create(null);
      if (!options || typeof options !== "object" || isArray(options)) return fail("options must be an object");
      for (const key of method === "setTabBarStyle" ? ["color", "selectedColor", "backgroundColor", "borderStyle"] : method === "setTabBarBadge" ? ["index", "text"] : ["index"]) {
        const descriptor = own(options, key);
        if (descriptor && !own(descriptor, "value")) return fail(key + " must be an own data value");
        const value = descriptor ? descriptor.value : undefined;
        if (method === "setTabBarStyle" && value === undefined) continue;
        // Only primitive snapshots may reach the generic wire serializer.
        // Native still validates the catalog index and the whole transaction.
        if (key === "index" ? typeof value !== "number" || !isInteger(value) || value < 0 : typeof value !== "string")
          return fail(key + " has an invalid type or value");
        data(request, key, value);
      }
      // Parameters are revalidated natively before any session state changes.
      return call(name, request);
    });
  }
})();
