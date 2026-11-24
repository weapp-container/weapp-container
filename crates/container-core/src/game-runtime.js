// Game-only AppService facilities. The native session enables this bootstrap
// before loading game.js, keeping page applications on their existing globals.
globalThis.__container_enable_game_runtime = (function() {
  const apply = Reflect.apply;
  const types = ["touchstart", "touchmove", "touchend", "touchcancel"];
  const listeners = Object.create(null);
  for (const type of types) listeners[type] = [];
  let enabled = false;
  let canvas = null;

  function requireCapability(name) {
    if (__container_capability(name) === "unsupported") throw __container_error(name, "unsupported");
  }
  function apiType(type) {
    return type[0].toUpperCase() + type.slice(1, 5) + type[5].toUpperCase() + type.slice(6);
  }
  function add(type, callback) {
    const name = "wx.on" + apiType(type);
    requireCapability(name);
    if (typeof callback !== "function") throw new TypeError(name + " requires a function");
    if (listeners[type].indexOf(callback) < 0) listeners[type].push(callback);
  }
  function remove(type, callback) {
    const name = "wx.off" + apiType(type);
    requireCapability(name);
    if (callback === undefined) { listeners[type].length = 0; return; }
    if (typeof callback !== "function") throw new TypeError(name + " requires a function");
    const index = listeners[type].indexOf(callback);
    if (index >= 0) listeners[type].splice(index, 1);
  }
  function flushCanvas() {
    if (!canvas) return;
    const context = canvas.getContext("2d");
    context.__containerFlushGameFrame();
  }
  function requestFrame(callback) {
    if (typeof callback !== "function") throw new TypeError("requestAnimationFrame requires a function");
    return setTimeout(function() {
      try { apply(callback, globalThis, [Date.now()]); }
      catch (error) { __container_report_error(error); }
      finally { flushCanvas(); }
    }, 16);
  }

  globalThis.__container_dispatch_game_touch = function(event) {
    if (!event || typeof event.type !== "string" || !listeners[event.type]) return false;
    const callbacks = listeners[event.type].slice();
    for (const callback of callbacks) {
      try { apply(callback, globalThis, [event]); }
      catch (error) { __container_report_error(error); }
    }
    return callbacks.length;
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
    wx.onTouchStart = function(callback) { return add("touchstart", callback); };
    wx.offTouchStart = function(callback) { return remove("touchstart", callback); };
    wx.onTouchMove = function(callback) { return add("touchmove", callback); };
    wx.offTouchMove = function(callback) { return remove("touchmove", callback); };
    wx.onTouchEnd = function(callback) { return add("touchend", callback); };
    wx.offTouchEnd = function(callback) { return remove("touchend", callback); };
    wx.onTouchCancel = function(callback) { return add("touchcancel", callback); };
    wx.offTouchCancel = function(callback) { return remove("touchcancel", callback); };
    globalThis.requestAnimationFrame = requestFrame;
    globalThis.cancelAnimationFrame = clearTimeout;
    return true;
  };
})();
