// A Component constructor in an app.json route entry registers a page. The
// manifest supplies that context; framework marker properties and declaration
// shape cannot turn an ordinary component/dependency into a page.
const __container_component_page_modules = Object.create(null);
const __container_register_native_component = globalThis.Component;
const __container_register_native_page = globalThis.Page;
const __container_register_native_app = globalThis.App;
const __container_evaluate_page_module = globalThis.__container_evaluate_named_module;
const __container_initial_app = globalThis.__container_app;
let __container_app_registration = null;
let __container_app_registration_frame = null;
const __container_component_page_definitions = new WeakSet();
const __container_component_page_has = Function.call.bind(WeakSet.prototype.has);
const __container_component_page_add = Function.call.bind(WeakSet.prototype.add);
function __container_component_page_registered(moduleId) {
  return globalThis.__container_page_module_definitions[moduleId] || [];
}
function __container_component_page_duplicate() {
  throw __container_component_protocol_error("Component page module must register exactly one page definition and cannot mix Page and Component", "ERR_MODULE_LOAD");
}
globalThis.App = function(options) {
  const app = __container_register_native_app(options);
  const registration = { app: app, previous: __container_app_registration, valid: true };
  __container_app_registration = registration;
  if (__container_app_registration_frame) __container_app_registration_frame.registrations.push(registration);
  else registration.previous = null;
  return app;
};
function __container_component_page_method(page, name, receiver, args) {
  const method = page.methods && page.methods[name];
  return typeof method === "function" ? method.apply(receiver, args) : undefined;
}
function __container_component_page_visibility(page, name, receiver) {
  const hook = page.pageLifetimes && page.pageLifetimes[name];
  if (typeof hook === "function") {
    try { hook.call(receiver); }
    catch (error) { __container_report_error(error); }
  }
}
function __container_install_component_page_lifecycles(page) {
  // Observed with official DevTools 2.02.2609250 / SDK 3.17.3:
  // artifacts/conformance-probes/component-page-v2/report.json.
  // Resize was not observed by that probe and is not synthesized here.
  page.onLoad = function() {
    const route = this.route;
    this.is = route;
    this.route = undefined;
    try { __container_component_lifecycle(this, "created", []); }
    finally { this.route = route; }
    __container_component_lifecycle(this, "attached", []);
    return __container_component_page_method(page, "onLoad", this, arguments);
  };
  page.onShow = function() {
    __container_component_page_visibility(page, "show", this);
    return __container_component_page_method(page, "onShow", this, arguments);
  };
  page.onHide = function() {
    __container_component_page_visibility(page, "hide", this);
    return __container_component_page_method(page, "onHide", this, arguments);
  };
  page.onReady = function() {
    __container_component_lifecycle(this, "ready", []);
    return __container_component_page_method(page, "onReady", this, arguments);
  };
  page.onUnload = function() {
    try { return __container_component_page_method(page, "onUnload", this, arguments); }
    finally { __container_component_lifecycle(this, "detached", []); }
  };
}
globalThis.__container_configure_page_modules = function(moduleIds, routeCounts) {
  if (!Array.isArray(moduleIds) || moduleIds.some(function(id) { return typeof id !== "string" || !id.trim(); })) {
    throw __container_component_protocol_error("page module IDs must be nonempty strings", "ERR_MODULE_LOAD");
  }
  moduleIds.forEach(function(id) {
    const count = routeCounts && routeCounts[id];
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) {
      throw __container_component_protocol_error("page module route count must be a positive integer", "ERR_MODULE_LOAD");
    }
    __container_component_page_modules[id] = count || 1;
  });
  return { moduleIds: moduleIds.slice() };
};
// Install before the CommonJS owner captures its evaluator. Validation runs
// inside the native registration transaction, so a failed definition count
// rolls back this module while retaining successful cached dependencies.
globalThis.__container_evaluate_named_module = function(moduleId, evaluate, cacheOwned) {
  const previousFrame = __container_app_registration_frame;
  const frame = { registrations: [], legacy: cacheOwned !== true };
  __container_app_registration_frame = frame;
  try { return __container_evaluate_page_module(moduleId, function() {
    const result = evaluate();
    const count = __container_component_page_modules[moduleId];
    if (count !== undefined) {
      const definitions = __container_component_page_registered(moduleId);
      const componentPage = definitions.some(function(index) {
        return __container_component_page_has(__container_component_page_definitions, globalThis.__container_pages[index]);
      });
      if (componentPage ? definitions.length !== 1 : definitions.length !== 1 && definitions.length !== count) {
        throw __container_component_protocol_error("page module " + moduleId + " must register one page definition or exactly " + count + " Page definitions", "ERR_MODULE_LOAD");
      }
    }
    return result;
  }, cacheOwned); }
  catch (error) {
    // Successful cached dependencies own separate frames. Invalidating only
    // this module's registrations preserves their App definition even when a
    // failed importer registered App both before and after requiring them.
    if (frame.registrations.length) {
      frame.registrations.forEach(function(registration) { registration.valid = false; });
      while (__container_app_registration && !__container_app_registration.valid) {
        __container_app_registration = __container_app_registration.previous;
      }
      const app = __container_app_registration ? __container_app_registration.app : __container_initial_app;
      globalThis.__container_app = app;
      __container_unhandled_rejections.bindApp(app);
    }
    throw error;
  } finally {
    __container_app_registration_frame = previousFrame;
    // Explicit nested legacy helpers share their outer atomic transaction;
    // actual cached require modules retain independent ownership above.
    if (previousFrame && previousFrame.legacy) {
      frame.registrations.forEach(function(registration) { previousFrame.registrations.push(registration); });
    }
    if (!previousFrame && __container_app_registration) __container_app_registration.previous = null;
  }
};
globalThis.Page = function(options) {
  const moduleId = __container_registration_module_id;
  if (moduleId != null && __container_component_page_modules[moduleId] !== undefined
      && __container_component_page_registered(moduleId).some(function(index) {
        return __container_component_page_has(__container_component_page_definitions, globalThis.__container_pages[index]);
      })) __container_component_page_duplicate();
  return __container_register_native_page(options);
};
globalThis.Component = function(options) {
  const moduleId = __container_registration_module_id;
  if (moduleId == null || __container_component_page_modules[moduleId] === undefined) {
    return __container_register_native_component(options);
  }
  if (__container_component_page_registered(moduleId).length) __container_component_page_duplicate();
  const page = {};
  __container_merge_component_options(page, options || {});
  page.properties = page.properties || {};
  // Page receivers own page data patches and per-navigation incarnations.
  // A component-page definition never becomes a mounted child occurrence.
  page.__container_component_page_definition = true;
  __container_install_component_page_lifecycles(page);
  // A definition's data factory may require/register another definition.
  // Recheck after it executes, before accepting this module's sole page.
  if (__container_component_page_registered(moduleId).length) __container_component_page_duplicate();
  const registered = __container_register_native_page(page);
  __container_component_page_add(__container_component_page_definitions, registered);
  return registered;
};
