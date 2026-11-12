// Compiled once per AppService realm and retained by the native engine, never
// published as a mutable application global. Arguments arrive through the
// engine's JSON parser; application data is not JavaScript source code.
(function() {
  "use strict";
  const apply = Reflect.apply;
  const stringify = JSON.stringify;
  const reportError = globalThis.__container_report_error;
  const root = globalThis;
  const invokePageInstance = root.__container_invoke_page_instance;
  const invokeApp = __container_performance.invokeApp;
  const moduleExports = __container_module_owner.exports;
  return function(moduleId, name, args) {
    try {
      const receiver = moduleId == null ? root : moduleExports(moduleId);
      // Teardown listeners run before the host invokes Page.onUnload. Keep
      // that invocation bound to the bootstrap even if user code replaces
      // its public compatibility alias while handling the notification.
      const target = moduleId == null && name === "__container_invoke_page_instance"
        ? invokePageInstance : moduleId == null && name === "__container_invoke_app" ? invokeApp : receiver[name];
      if (typeof target !== "function") throw new TypeError("target is not callable");
      // Preserve the public engine contract: even module exports receive the
      // realm global as `this`, undefined becomes null, arrays remain batches.
      return stringify(apply(target, root, args)) ?? "null";
    } catch (error) {
      reportError(error);
      throw error;
    }
  };
})()
