// Game-only AppService facilities. The native session enables this bootstrap
// before loading game.js, keeping page applications on their existing globals.
globalThis.__container_enable_game_runtime = (function() {
  const apply = Reflect.apply;
  const scheduleTimer = setTimeout;
  const cancelTimer = clearTimeout;
  const timeOrigin = globalThis.performance && typeof globalThis.performance.now === "function"
    ? function() { return globalThis.performance.now(); }
    : function() { return Date.now(); };
  const eventApis = {
    touchstart: ["onTouchStart", "offTouchStart"],
    touchmove: ["onTouchMove", "offTouchMove"],
    touchend: ["onTouchEnd", "offTouchEnd"],
    touchcancel: ["onTouchCancel", "offTouchCancel"],
    show: ["onShow", "offShow"],
    hide: ["onHide", "offHide"],
    audiointerruptionbegin: ["onAudioInterruptionBegin", "offAudioInterruptionBegin"],
    audiointerruptionend: ["onAudioInterruptionEnd", "offAudioInterruptionEnd"],
    memorywarning: ["onMemoryWarning", "offMemoryWarning"],
    devicemotionchange: ["onDeviceMotionChange", "offDeviceMotionChange"],
    accelerometerchange: ["onAccelerometerChange", "offAccelerometerChange"],
    keyboardheightchange: ["onKeyboardHeightChange", "offKeyboardHeightChange"],
    keydown: ["onKeyDown", "offKeyDown"],
    keyup: ["onKeyUp", "offKeyUp"],
    resize: ["onWindowResize", "offWindowResize"]
  };
  const listeners = Object.create(null);
  Object.keys(eventApis).forEach(function(type) { listeners[type] = []; });
  let enabled = false;
  let canvas = null;
  let visible = false;
  let frameTimer = null;
  let frameScheduled = false;
  let nextFrameId = 0;
  let lastFrameTimestamp = 0;
  let frameOrder = [];
  let pendingFrameCount = 0;
  const frameCallbacks = Object.create(null);

  function requireCapability(name) {
    if (__container_capability(name) === "unsupported") throw __container_error(name, "unsupported");
  }
  function eventName(type, action) {
    const pair = eventApis[type];
    return pair ? "wx." + pair[action === "on" ? 0 : 1] : "wx." + action + type;
  }
  function add(type, callback) {
    const name = eventName(type, "on");
    requireCapability(name);
    if (typeof callback !== "function") throw new TypeError(name + " requires a function");
    if (listeners[type].indexOf(callback) < 0) listeners[type].push(callback);
  }
  function remove(type, callback) {
    const name = eventName(type, "off");
    requireCapability(name);
    if (callback === undefined) { listeners[type].length = 0; return; }
    if (typeof callback !== "function") throw new TypeError(name + " requires a function");
    const index = listeners[type].indexOf(callback);
    if (index >= 0) listeners[type].splice(index, 1);
  }
  function eventPayload(event) {
    if (event.type === "show") return event.options || {};
    if (event.type === "hide") return {};
    const payload = {};
    Object.keys(event).forEach(function(key) {
      if (key !== "type") payload[key] = event[key];
    });
    if (event.type.indexOf("touch") === 0) payload.type = event.type;
    return payload;
  }
  function dispatch(event) {
    const type = event && event.type;
    if (!listeners[type]) return 0;
    if (type === "show") {
      if (visible) return 0;
      visible = true;
      scheduleFrame();
    } else if (type === "hide") {
      if (!visible) return 0;
      visible = false;
      if (frameTimer !== null) cancelTimer(frameTimer);
      frameTimer = null;
      frameScheduled = false;
    }
    if (type === "resize" && canvas) {
      canvas.width = event.size.windowWidth;
      canvas.height = event.size.windowHeight;
      try { flushCanvas(true); }
      catch (error) { __container_report_error(error); }
    }
    const callbacks = listeners[type].slice();
    const payload = eventPayload(event);
    for (const callback of callbacks) {
      try { apply(callback, globalThis, [payload]); }
      catch (error) { __container_report_error(error); }
    }
    try { flushCanvas(); }
    catch (error) { __container_report_error(error); }
    return callbacks.length;
  }
  function flushCanvas(force) {
    if (!canvas) return;
    const context = canvas.getContext("2d");
    context.__containerFlushGameFrame(!!force);
  }
  function scheduleFrame() {
    if (frameScheduled || !visible || !frameOrder.length) return;
    frameScheduled = true;
    frameTimer = scheduleTimer(flushFrame, 16);
  }
  function flushFrame() {
    frameScheduled = false;
    frameTimer = null;
    if (!visible || !frameOrder.length) return;
    const pending = frameOrder;
    frameOrder = [];
    const timestamp = Math.max(lastFrameTimestamp, timeOrigin());
    lastFrameTimestamp = timestamp;
    for (const id of pending) {
      const callback = frameCallbacks[id];
      if (!callback) continue;
      delete frameCallbacks[id];
      pendingFrameCount -= 1;
      try { apply(callback, globalThis, [timestamp]); }
      catch (error) { __container_report_error(error); }
    }
    try { flushCanvas(); }
    catch (error) { __container_report_error(error); }
    scheduleFrame();
  }
  function requestFrame(callback) {
    requireCapability("requestAnimationFrame");
    if (typeof callback !== "function") throw new TypeError("requestAnimationFrame requires a function");
    if (pendingFrameCount >= 4096) throw { errMsg: "requestAnimationFrame:fail frame callback limit exceeded", code: "ERR_RESOURCE_LIMIT", api: "requestAnimationFrame" };
    nextFrameId = nextFrameId >= 2147483647 ? 1 : nextFrameId + 1;
    while (frameCallbacks[nextFrameId]) nextFrameId = nextFrameId >= 2147483647 ? 1 : nextFrameId + 1;
    frameCallbacks[nextFrameId] = callback;
    frameOrder.push(nextFrameId);
    pendingFrameCount += 1;
    scheduleFrame();
    return nextFrameId;
  }
  function cancelFrame(id) {
    requireCapability("cancelAnimationFrame");
    if (typeof id !== "number" || !Number.isFinite(id)) return;
    if (frameCallbacks[id]) {
      delete frameCallbacks[id];
      pendingFrameCount -= 1;
    }
  }

  globalThis.__container_dispatch_game_touch = function(event) {
    if (!event || typeof event.type !== "string" || event.type.indexOf("touch") !== 0) return false;
    return dispatch(event);
  };
  globalThis.__container_dispatch_game_event = function(event) {
    if (!event || typeof event.type !== "string") return false;
    return dispatch(event);
  };
  globalThis.__container_flush_game_canvas = flushCanvas;
  return function() {
    if (enabled) return true;
    enabled = true;
    canvas = __container_create_game_canvas();
    const gameGlobal = globalThis.GameGlobal && typeof globalThis.GameGlobal === "object"
      ? globalThis.GameGlobal : {};
    gameGlobal.canvas = canvas;
    globalThis.GameGlobal = gameGlobal;
    wx.createCanvas = function() { requireCapability("wx.createCanvas"); return canvas; };
    Object.keys(eventApis).forEach(function(type) {
      const pair = eventApis[type];
      wx[pair[0]] = function(callback) { return add(type, callback); };
      wx[pair[1]] = function(callback) { return remove(type, callback); };
    });
    globalThis.requestAnimationFrame = requestFrame;
    globalThis.cancelAnimationFrame = cancelFrame;
    return true;
  };
})();
