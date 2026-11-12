// Opt-in, bounded diagnostics. Both engines install this in the bootstrap
// lexical scope, before any application module can replace intrinsics.
const __dev_console = (function() {
  const create = Object.create;
  const define = Object.defineProperty;
  const own = Object.getOwnPropertyDescriptor;
  const keys = Reflect.ownKeys;
  const setPrototype = Object.setPrototypeOf;
  const makeQueue = function() { return setPrototype([], null); };
  const text = String;
  const slice = Function.prototype.call.bind(String.prototype.slice);
  let enabled = false;
  let queue = makeQueue();
  let characters = 0;
  let dropped = 0;
  let formatting = false;
  let groupDepth = 0;
  function data(object, key, value) {
    const descriptor = create(null);
    descriptor.value = value;
    descriptor.writable = descriptor.enumerable = descriptor.configurable = true;
    define(object, key, descriptor);
  }
  function format(value, depth) {
    if (value === null) return 'null';
    const type = typeof value;
    if (type !== 'object' && type !== 'function') return slice(text(value), 0, 1024);
    if (type === 'function') return '[Function]';
    if (depth > 1) return '[Object]';
    let result = '{';
    try {
      const names = keys(value);
      for (let index = 0; index < names.length && index < 12; index += 1) {
        const key = names[index];
        const descriptor = own(value, key);
        if (!descriptor || !descriptor.enumerable) continue;
        if (result.length > 1) result += ', ';
        result += slice(text(key), 0, 80) + ': ';
        result += own(descriptor, 'value') ? format(descriptor.value, depth + 1) : '[Accessor]';
        if (result.length > 1024) break;
      }
    } catch (_) { result += '[Uninspectable]'; }
    return slice(result, 0, 1024) + '}';
  }
  function emit(level, args) {
    if (__container_conformance_runtime_logs) __container_conformance_runtime_logs.console(level, args);
    if (!enabled) return;
    if (formatting || queue.length >= 128 || characters >= 65536) { dropped += 1; return; }
    formatting = true;
    try {
    let message = '';
    for (let depth = 0; depth < groupDepth; depth += 1) message += '  ';
    for (let index = 0; index < args.length && index < 16; index += 1) {
      message += (index ? ' ' : '') + format(args[index], 0);
      if (message.length >= 2048) break;
    }
    message = slice(message, 0, 2048);
    if (!enabled) return;
    const entry = create(null);
    data(entry, 'level', level);
    data(entry, 'message', message);
    data(entry, 'groupDepth', groupDepth);
    data(queue, text(queue.length), entry);
    characters += message.length;
    } finally { formatting = false; }
  }
  const console = create(null);
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    data(console, level, function(...args) { emit(level, args); });
  }
  data(console, 'group', function(...args) {
    emit('log', args);
    if (!enabled) return;
    if (groupDepth < 32) groupDepth += 1;
    else dropped += 1;
  });
  data(console, 'groupEnd', function() {
    if (groupDepth > 0) groupDepth -= 1;
  });
  globalThis.console = console;
  globalThis.__container_set_dev_console_enabled = function(value) {
    enabled = value === true;
    if (!enabled) { queue = makeQueue(); characters = 0; dropped = 0; groupDepth = 0; }
    return null;
  };
  return function() {
    const result = create(null);
    data(result, 'entries', queue);
    data(result, 'dropped', dropped);
    queue = makeQueue(); characters = 0; dropped = 0;
    return result;
  };
})();
