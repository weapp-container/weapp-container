// Snapshot the typed request after ordinary JavaScript property reads. Entropy
// comes only from Session; guest objects and toJSON never generate native bytes.
(function() {
  const define = Object.defineProperty, create = Object.create;
  const has = Reflect.has, apply = Reflect.apply, then = Promise.prototype.then;
  const isInteger = Number.isInteger;
  const call = __container_api_call, capability = __container_capability;
  const complete = __container_async_result;
  const name = "wx.getRandomValues";
  function data(target, key, value, enumerable) {
    define(target, key, {__proto__: null, value: value, enumerable: enumerable === true, configurable: true, writable: true});
  }
  function finish(promise, callbackMode) {
    if (!callbackMode) return promise;
    // Callback-style APIs return void. Handle the internal rejected Promise so
    // a failure delivered through fail/complete is never an unhandled rejection.
    define(promise, "constructor", {__proto__: null, value: undefined});
    apply(then, promise, [undefined, function() {}]);
    return undefined;
  }
  data(wx, "getRandomValues", function(options) {
    const request = create(null);
    const isObject = options !== null && (typeof options === "object" || typeof options === "function");
    let callbackMode = false;
    if (isObject) {
      for (const key of ["success", "fail", "complete"]) {
        // The locked PromisifySuccessResult selects void when any callback
        // property is present, including inherited or explicitly undefined.
        const callback = options[key];
        if (has(options, key) || callback !== undefined) callbackMode = true;
        if (typeof callback === "function") {
          // Preserve the existing callback receiver while retaining the once-read
          // function. The original options object never enters the wire clone.
          data(request, key, function(value) { return apply(callback, options, [value]); }, false);
        }
      }
    }
    function fail(message, code) {
      return finish(complete(request, null, {__proto__: null, api: name, code: code || "ERR_INVALID_REQUEST", errMsg: "getRandomValues:fail " + message}), callbackMode);
    }
    if (capability(name) === "unsupported") return fail("unsupported", "ERR_UNSUPPORTED_CAPABILITY");
    if (!isObject) return fail("options must be an object");
    // Get exactly once: inherited data, getters and Proxy reads are ordinary
    // structural options. Validate the original value before any JSON clone.
    const length = options.length;
    if (typeof length !== "number" || !isInteger(length) || length < 0 || length > 1048576)
      return fail("length must be an integer between 0 and 1048576 bytes");
    data(request, "length", length, true);
    for (const key of ["timeout", "deadlineNs", "deadline_ns", "cancelToken", "cancel_token"]) {
      const value = options[key];
      if (value !== undefined && value !== null && typeof value !== "number" && typeof value !== "string")
        return fail(key + " must be a primitive request control");
      if (value !== undefined) data(request, key, value, true);
    }
    return finish(call(name, request), callbackMode);
  }, true);
})();
