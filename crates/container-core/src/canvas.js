const __container_canvas_intrinsics = (function() {
  const define = Object.defineProperty;
  return {
    isArray: Array.isArray,
    descriptor: Object.getOwnPropertyDescriptor,
    hasOwn: Function.prototype.call.bind(Object.prototype.hasOwnProperty),
    append: function(array, value) {
      define(array, array.length, {__proto__:null, value:value, writable:true, enumerable:true, configurable:true});
    },
    finite: Number.isFinite,
    fround: Math.fround
  };
})();
function __container_canvas_context(canvasId, component) {
  if (__container_capability("wx.createCanvasContext") === "unsupported") {
    throw __container_error("wx.createCanvasContext", "unsupported");
  }
  const id = String(canvasId || "");
  return __container_canvas_context_impl(id, null, __container_owned_canvases.context(id, component));
}
function __container_canvas_context_impl(canvasId, canvasSize, owner) {
  if (__container_capability("wx.createCanvasContext") === "unsupported") {
    throw __container_error("wx.createCanvasContext", "unsupported");
  }
  const state = {
    canvasId: String(canvasId || ""), commands: [], commandBytes: 0, admitting: false, recording: false,
    drawing: defaults(), stack: []
  };
  const api = {};
  function invalid(message, code) {
    throw { errMsg: "wx.canvas.draw:fail " + message, code: code || "ERR_INVALID_REQUEST", api: "wx.canvas.draw" };
  }
  function defaults() {
    return {fillStyle:"#000000", strokeStyle:"#000000", lineWidth:1,
      globalAlpha:1, fontSize:10, lineCap:"butt", lineJoin:"miter", miterLimit:10,
      lineDash:[], lineDashOffset:0, textAlign:"start", textBaseline:"alphabetic"};
  }
  function saved(drawing) {
    // Dash arrays are immutable owned command snapshots, so saves can share
    // them without multiplying a large dash pattern by the save-stack depth.
    return {fillStyle:drawing.fillStyle, strokeStyle:drawing.strokeStyle,
      lineWidth:drawing.lineWidth, globalAlpha:drawing.globalAlpha,
      fontSize:drawing.fontSize, lineCap:drawing.lineCap, lineJoin:drawing.lineJoin,
      miterLimit:drawing.miterLimit, lineDash:drawing.lineDash,
      lineDashOffset:drawing.lineDashOffset, textAlign:drawing.textAlign,
      textBaseline:drawing.textBaseline};
  }
  function scalar(value) {
    if (typeof value !== "number" || !__container_canvas_intrinsics.finite(value)
        || !__container_canvas_intrinsics.finite(__container_canvas_intrinsics.fround(value)))
      invalid("canvas state requires a finite native scalar");
    return value;
  }
  function normalize(op, args) {
    // Work only on the already owned snapshot. Reject invalid numeric/enum
    // stroke state before enqueue. Paint parsing remains renderer admission.
    const value = args[0];
    if (op === "setTransform" || op === "transform") {
      if (args.length < 6) invalid("canvas transform requires six scalars");
      for (let index = 0; index < 6; index += 1) scalar(args[index]);
    } else if (op === "arcTo") {
      if (args.length < 5) invalid("canvas arcTo requires five scalars");
      for (let index = 0; index < 5; index += 1) scalar(args[index]);
      if (args[4] < 0) invalid("canvas arcTo radius must be non-negative");
    } else if (op === "setFillStyle" || op === "setStrokeStyle") {
      if (typeof value !== "string") invalid("canvas paint requires a color string");
    } else if (op === "setLineCap") {
      if (value !== "butt" && value !== "round" && value !== "square") invalid("invalid line cap");
    } else if (op === "setLineJoin") {
      if (value !== "miter" && value !== "round" && value !== "bevel") invalid("invalid line join");
    } else if (op === "setLineWidth" || op === "setMiterLimit") {
      args[0] = scalar(value) < 0 ? 0 : value;
    } else if (op === "setGlobalAlpha") {
      scalar(value); args[0] = value < 0 ? 0 : value > 1 ? 1 : value;
    } else if (op === "setFontSize") {
      args[0] = scalar(value) < 1 ? 1 : value;
    } else if (op === "setLineDash") {
      if (!__container_canvas_intrinsics.isArray(value)) invalid("line dash requires an array");
      let period = 0;
      const copies = value.length % 2 === 1 ? 2 : 1;
      for (let copy = 0; copy < copies; copy += 1) {
        for (let index = 0; index < value.length; index += 1) {
          const interval = scalar(value[index]);
          if (interval < 0) invalid("line dash intervals must be non-negative");
          period = __container_canvas_intrinsics.fround(period + __container_canvas_intrinsics.fround(interval));
          if (!__container_canvas_intrinsics.finite(period)) invalid("line dash period must fit a native scalar");
        }
      }
      if (args.length > 1) args[1] = scalar(args[1]);
      else __container_canvas_intrinsics.append(args, 0);
    } else if (op === "setTextAlign") {
      if (value !== "start" && value !== "end" && value !== "left" && value !== "right" && value !== "center") invalid("invalid text alignment");
    } else if (op === "setTextBaseline") {
      if (value !== "top" && value !== "hanging" && value !== "middle" && value !== "alphabetic" && value !== "ideographic" && value !== "bottom") invalid("invalid text baseline");
    } else if (op === "save" && state.stack.length >= 256) {
      invalid("canvas save depth exceeded", "ERR_RESOURCE_LIMIT");
    }
  }
  function applyState(entry) {
    const drawing = state.drawing, args = entry.args;
    switch (entry.op) {
      case "setFillStyle": drawing.fillStyle = args[0]; break;
      case "setStrokeStyle": drawing.strokeStyle = args[0]; break;
      case "setLineWidth": drawing.lineWidth = args[0]; break;
      case "setGlobalAlpha": drawing.globalAlpha = args[0]; break;
      case "setFontSize": drawing.fontSize = args[0]; break;
      case "setLineCap": drawing.lineCap = args[0]; break;
      case "setLineJoin": drawing.lineJoin = args[0]; break;
      case "setMiterLimit": drawing.miterLimit = args[0]; break;
      case "setLineDash": drawing.lineDash = args[0]; drawing.lineDashOffset = args[1]; break;
      case "setTextAlign": drawing.textAlign = args[0]; break;
      case "setTextBaseline": drawing.textBaseline = args[0]; break;
      case "save": __container_canvas_intrinsics.append(state.stack, saved(drawing)); break;
      case "restore":
        if (state.stack.length) { state.drawing = state.stack[state.stack.length - 1]; state.stack.length -= 1; }
        break;
    }
  }
  // Commands only carry owned JSON primitives/arrays. The generic clone's
  // fallback returns the caller's object on cycles or failed serialization;
  // that would poison a later draw and retain mutable application state.
  function snapshot(args) {
    let remaining = 65536;
    let bytes = 0;
    function copy(value, depth) {
      if ((bytes += 8) + state.commandBytes > 4194304) invalid("canvas pending byte budget exceeded", "ERR_RESOURCE_LIMIT");
      if (--remaining < 0 || depth > 8) invalid("canvas argument budget exceeded");
      if (value === undefined || value === null) return null;
      if (typeof value === "number") {
        if (!__container_canvas_intrinsics.finite(value)) invalid("canvas arguments must be finite");
        return value;
      }
      if (typeof value === "string") {
        bytes += value.length * 2;
        if (bytes + state.commandBytes > 4194304) invalid("canvas pending byte budget exceeded", "ERR_RESOURCE_LIMIT");
        return value;
      }
      if (typeof value === "boolean") return value;
      if (!__container_canvas_intrinsics.isArray(value)) invalid("canvas argument requires a primitive or array");
      if (value.length > remaining) invalid("canvas argument budget exceeded");
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = __container_canvas_intrinsics.descriptor(value, index);
        if (descriptor && !__container_canvas_intrinsics.hasOwn(descriptor, "value")) invalid("canvas arguments cannot contain accessors");
        __container_canvas_intrinsics.append(result, copy(descriptor ? descriptor.value : undefined, depth + 1));
      }
      return result;
    }
    const result = [];
    for (let index = 0; index < args.length; index += 1) __container_canvas_intrinsics.append(result, copy(args[index], 0));
    return {values:result, bytes:bytes};
  }
  function command(op, args) {
    if (state.recording) invalid("cannot mutate a canvas while copying command arguments");
    if (state.commands.length >= 16384) invalid("canvas command budget exceeded", "ERR_RESOURCE_LIMIT");
    let values;
    state.recording = true;
    try { values = snapshot(args); }
    finally { state.recording = false; }
    const originalLength = values.values.length;
    normalize(op, values.values);
    values.bytes += (values.values.length - originalLength) * 8;
    if (values.bytes + state.commandBytes > 4194304) invalid("canvas pending byte budget exceeded", "ERR_RESOURCE_LIMIT");
    const entry = { op: op, args: values.values };
    __container_canvas_intrinsics.append(state.commands, entry);
    state.commandBytes += values.bytes;
    applyState(entry);
    return api;
  }
  ["setFillStyle", "setStrokeStyle", "setLineWidth", "setGlobalAlpha", "setFontSize",
    "setLineDash",
    "setLineCap", "setLineJoin", "setMiterLimit", "setShadow", "setTextAlign",
    "setTextBaseline"].forEach(function(name) {
      api[name] = function() { command(name, arguments); };
    });
  api.save = function() { command("save", arguments); };
  api.restore = function() { command("restore", arguments); };
  ["setTransform", "transform", "clip"].forEach(function(name) {
    api[name] = function() { command(name, arguments); };
  });
  api.arcTo = function() { command("arcTo", arguments); };
  ["fillRect", "strokeRect", "clearRect", "beginPath", "closePath", "moveTo", "lineTo",
    "arc", "rect", "fill", "stroke", "fillText", "strokeText", "drawImage", "translate", "rotate", "scale", "quadraticCurveTo", "bezierCurveTo"].forEach(function(name) {
      api[name] = function() { return command(name, arguments); };
    });
  Object.defineProperties(api, {
    fillStyle: { get: function() { return state.drawing.fillStyle; }, set: function(value) { command("setFillStyle", [String(value)]); } },
    strokeStyle: { get: function() { return state.drawing.strokeStyle; }, set: function(value) { command("setStrokeStyle", [String(value)]); } },
    lineWidth: { get: function() { return state.drawing.lineWidth; }, set: function(value) { command("setLineWidth", [Number(value)]); } },
    globalAlpha: { get: function() { return state.drawing.globalAlpha; }, set: function(value) { command("setGlobalAlpha", [Number(value)]); } },
    fontSize: { get: function() { return state.drawing.fontSize; }, set: function(value) { command("setFontSize", [Number(value)]); } },
    lineCap: { get: function() { return state.drawing.lineCap; }, set: function(value) { command("setLineCap", [value]); } },
    lineJoin: { get: function() { return state.drawing.lineJoin; }, set: function(value) { command("setLineJoin", [value]); } },
    miterLimit: { get: function() { return state.drawing.miterLimit; }, set: function(value) { command("setMiterLimit", [value]); } },
    lineDashOffset: { get: function() { return state.drawing.lineDashOffset; }, set: function(value) { command("setLineDash", [state.drawing.lineDash, value]); } }
  });
  api.draw = function(reserve, callback) {
    if (state.recording) invalid("cannot submit a canvas while copying command arguments");
    if (state.admitting) invalid("cannot submit a canvas during draw admission");
    if (typeof reserve === "function") { callback = reserve; reserve = false; }
    state.admitting = true;
    try {
      const count = state.commands.length, bytes = state.commandBytes;
      const commands = [];
      for (let index = 0; index < count; index += 1) __container_canvas_intrinsics.append(commands, state.commands[index]);
      const options = { canvasId: state.canvasId, reserve: !!reserve, commands: commands };
      if (canvasSize) { options.width = canvasSize.width; options.height = canvasSize.height; }
      if (typeof callback === "function") options.success = callback;
      const result = owner ? __container_owned_canvases.draw(owner, options, callback)
        : __container_api_call("wx.canvas.draw", options);
      // reserve preserves renderer pixels/history, never the submitted JS
      // queue. Only consume the admitted prefix; synchronous enqueue failure
      // keeps it available for an explicit retry, and reentrant new work stays.
      const retained = [];
      for (let index = count; index < state.commands.length; index += 1) __container_canvas_intrinsics.append(retained, state.commands[index]);
      state.commands = retained;
      state.commandBytes -= bytes;
      // Legacy draw keeps pixels with reserve, but every admitted draw starts
      // a fresh drawing context (including paths/transforms/save stack). New
      // work enqueued reentrantly belongs to that next batch. Replay its owned
      // state commands; never evaluate application getters a second time.
      state.drawing = defaults(); state.stack = [];
      for (let index = 0; index < retained.length; index += 1) applyState(retained[index]);
      return result;
    }
    finally { state.admitting = false; }
  };
  return api;
}
// Offscreen canvas uses the same batched CanvasFrame contract as an on-page
// canvas, but allocates an isolated renderer surface id.  The provider still
// owns native/GPU resources; the deterministic sandbox commits an RGBA raster
// snapshot, so callers never observe a fabricated successful draw.
function __container_create_offscreen_canvas(options) {
  const name = "wx.createOffscreenCanvas";
  if (__container_capability(name) === "unsupported") throw __container_error(name, "unsupported");
  const source = __container_options(options);
  const type = source.type == null ? "2d" : String(source.type);
  if (type !== "2d") {
    const error = { errMsg: name + ":fail type must be 2d", code: "ERR_INVALID_REQUEST", api: name };
    __container_errors.push(error);
    throw error;
  }
  const width = source.width == null ? 300 : Number(source.width);
  const height = source.height == null ? 150 : Number(source.height);
  if (!isFinite(width) || !isFinite(height) || width < 0 || height < 0 || width > 16384 || height > 16384) {
    const error = { errMsg: name + ":fail width and height must be finite values in [0, 16384]", code: "ERR_INVALID_REQUEST", api: name };
    __container_errors.push(error);
    throw error;
  }
  const canvasId = "__offscreen_" + (++globalThis.__container_offscreen_canvas_id);
  const state = { canvasId: canvasId, width: Math.floor(width), height: Math.floor(height) };
  let context = null;
  function context2d() {
    if (!context) context = __container_canvas_context_impl(canvasId, state, null);
    return context;
  }
  return {
    get width() { return state.width; },
    set width(value) {
      const number = Number(value);
      if (!isFinite(number) || number < 0 || number > 16384) throw { errMsg: name + ":fail invalid width", code: "ERR_INVALID_REQUEST", api: name };
      state.width = Math.floor(number);
    },
    get height() { return state.height; },
    set height(value) {
      const number = Number(value);
      if (!isFinite(number) || number < 0 || number > 16384) throw { errMsg: name + ":fail invalid height", code: "ERR_INVALID_REQUEST", api: name };
      state.height = Math.floor(number);
    },
    getContext: function(kind) {
      if (String(kind || "2d") !== "2d") {
        const error = { errMsg: name + ":fail unsupported context type", code: "ERR_UNSUPPORTED_CAPABILITY", api: name };
        __container_errors.push(error);
        throw error;
      }
      return context2d();
    },
    toDataURL: function() {
      const error = { errMsg: name + ":fail toDataURL requires a host snapshot provider", code: "ERR_UNSUPPORTED_CAPABILITY", api: name };
      __container_errors.push(error);
      return Promise.reject(error);
    }
  };
}
