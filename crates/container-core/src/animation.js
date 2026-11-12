// Animation produces a serializable queue. Renderer playback is a separate,
// still partial capability; building an action must never pretend it played.
// Both AppService engines use this implementation and retain no host resource.
const __container_animation_runtime = (function() {
  const create = Object.create;
  const define = Object.defineProperty;
  const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  const isFinite = Number.isFinite;
  const maxOperations = 16384;
  const maxSteps = 4096;

  function record() { return create(null); }
  function set(target, key, value) {
    define(target, key, {__proto__:null, value:value, enumerable:true, configurable:true, writable:true});
  }
  function append(target, value) { set(target, target.length, value); }
  function fail(method, message, code) {
    const error = record();
    error.code = code || "ERR_INVALID_REQUEST";
    error.api = "Animation." + method;
    error.errMsg = error.api + ":fail " + message;
    throw error;
  }
  function number(value, method) {
    if (typeof value !== "number" || !isFinite(value)) fail(method, "expected a finite number");
    return value;
  }
  function length(value, method) {
    if (typeof value === "number") return number(value, method);
    if (typeof value === "string") return value;
    fail(method, "expected a number or string");
  }
  function string(value, method) {
    if (typeof value !== "string") fail(method, "expected a string");
    return value;
  }
  function options(value, method) {
    const result = record();
    if (value === null || value === undefined) return result;
    if (typeof value !== "object") fail(method, "expected step options");
    for (const name of ["delay", "duration", "timingFunction", "transformOrigin"]) {
      if (!hasOwn(value, name)) continue;
      // Read an accessor exactly once, before committing any queued action.
      const item = value[name];
      if (item === null || item === undefined) continue;
      if (name === "delay" || name === "duration") {
        number(item, method);
        if (item < 0) fail(method, name + " must be non-negative");
      } else if (name === "timingFunction") {
        if (item !== "linear" && item !== "ease" && item !== "ease-in" &&
            item !== "ease-in-out" && item !== "ease-out" &&
            item !== "step-start" && item !== "step-end") fail(method, "invalid timingFunction");
      } else string(item, method);
      result[name] = item;
    }
    return result;
  }
  function copyOptions(defaults, overrides) {
    const result = record();
    for (const name of ["delay", "duration", "timingFunction", "transformOrigin"]) {
      result[name] = hasOwn(overrides, name) ? overrides[name] : defaults[name];
    }
    return result;
  }
  function animation(value) {
    const standard = record();
    standard.delay = 0;
    standard.duration = 400;
    standard.timingFunction = "linear";
    standard.transformOrigin = "50% 50% 0";
    const defaults = copyOptions(standard, options(value, "create"));
    let actions = [];
    let operations = [];
    let operationCount = 0;
    let readingOptions = false;
    const api = {};
    function mutable(method) {
      if (readingOptions) fail(method, "cannot mutate an animation while reading step options");
    }
    function add(type, args) {
      mutable(type);
      if (operationCount >= maxOperations) fail(type, "queued operation limit exceeded", "ERR_RESOURCE_LIMIT");
      const operation = record();
      operation.type = type;
      operation.args = args;
      append(operations, operation);
      operationCount += 1;
      return api;
    }
    function numeric(method, count) {
      set(api, method, function() {
        const args = [];
        for (let index = 0; index < count; index += 1) append(args, number(arguments[index], method));
        return add(method, args);
      });
    }
    for (const method of ["bottom", "height", "left", "right", "top", "width"]) {
      set(api, method, function(value) { return add(method, [length(value, method)]); });
    }
    set(api, "backgroundColor", function(value) { return add("backgroundColor", [string(value, "backgroundColor")]); });
    set(api, "opacity", function(value) {
      number(value, "opacity");
      if (value < 0 || value > 1) fail("opacity", "expected a value between zero and one");
      return add("opacity", [value]);
    });
    for (const method of ["rotate", "rotateX", "rotateY", "rotateZ", "scaleX", "scaleY", "scaleZ",
      "skewX", "skewY", "translateX", "translateY", "translateZ"]) numeric(method, 1);
    numeric("rotate3d", 4);
    numeric("scale3d", 3);
    numeric("skew", 2);
    set(api, "scale", function(x, y) {
      return add("scale", [number(x, "scale"), number(y === undefined ? x : y, "scale")]);
    });
    set(api, "translate", function(x, y) {
      return add("translate", [number(x === undefined ? 0 : x, "translate"), number(y === undefined ? 0 : y, "translate")]);
    });
    set(api, "translate3d", function(x, y, z) {
      return add("translate3d", [number(x === undefined ? 0 : x, "translate3d"),
        number(y === undefined ? 0 : y, "translate3d"), number(z === undefined ? 0 : z, "translate3d")]);
    });
    for (const entry of [["matrix", 6], ["matrix3d", 16]]) {
      const method = entry[0], count = entry[1];
      set(api, method, function() {
        // The fixed typings expose the no-argument overload; the documented
        // CSS matrix form also accepts the complete set of coefficients.
        if (arguments.length !== 0 && arguments.length !== count) fail(method, "invalid matrix coefficient count");
        const args = [];
        for (let index = 0; index < arguments.length; index += 1) append(args, number(arguments[index], method));
        return add(method, args);
      });
    }
    set(api, "step", function(value) {
      mutable("step");
      if (actions.length >= maxSteps) fail("step", "queued step limit exceeded", "ERR_RESOURCE_LIMIT");
      let stepOptions;
      readingOptions = true;
      try { stepOptions = copyOptions(defaults, options(value, "step")); }
      finally { readingOptions = false; }
      const step = record();
      step.animates = operations;
      step.option = stepOptions;
      // No application code is invoked between publishing and resetting the
      // operation list. A failed option getter leaves the original queue live.
      append(actions, step);
      operations = [];
      return api;
    });
    set(api, "export", function() {
      mutable("export");
      const result = record();
      result.actions = actions;
      actions = [];
      // Export retires the current queue, including actions without step().
      // No pending operations from a previous export leak into its successor.
      operations = [];
      operationCount = 0;
      return result;
    });
    return api;
  }
  return {options:options, animation:animation};
})();
function __container_animation_options(value) {
  return __container_animation_runtime.options(value, "step");
}
function __container_animation(options) {
  return __container_animation_runtime.animation(options);
}
function __container_create_animation(options) {
  if (__container_capability("wx.createAnimation") === "unsupported") {
    throw __container_error("wx.createAnimation", "unsupported");
  }
  return __container_animation(options);
}
