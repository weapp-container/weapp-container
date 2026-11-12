// Test-only prototype mutation in the isolated modern realm.
let n = 0;
const define = Object.defineProperty;
const trustedSetPrototype = Object.setPrototypeOf;
function flipDescriptors() {
  define(Object.prototype, 'get', trustedSetPrototype({ value: undefined, writable: true, configurable: true }, null));
  define(Object.prototype, 'set', trustedSetPrototype({ get() { throw new Error('poisoned descriptor field'); }, configurable: true }, null));
  return 'flipped';
}
function attack() {
  const boom = function () {
    throw new Error('poisoned transport intrinsic');
  };
  function poison(target, names) {
    for (let i = 0; i < names.length; i++)
      define(target, names[i], { value: boom, writable: true, configurable: true });
  }
  Object.prototype.toJSON = boom;
  Array.prototype.toJSON = boom;
  define(Object.prototype, 'then', { get: boom, configurable: true });
  define(Object.prototype, 'compilation', { get: boom, configurable: true });
  define(Array.prototype, '0', { get: boom, set: boom, configurable: true });
  poison(Array.prototype, [
    'map',
    'sort',
    'filter',
    'forEach',
    'includes',
    'every',
    'some',
    'join',
    'slice',
    'push',
    'pop',
  ]);
  Array.prototype[Symbol.iterator] = boom;
  String.prototype[Symbol.split] = boom;
  poison(String.prototype, [
    'split',
    'slice',
    'startsWith',
    'endsWith',
    'trim',
    'indexOf',
    'codePointAt',
  ]);
  poison(Map.prototype, ['get', 'set', 'has', 'delete', 'keys']);
  define(Map.prototype, 'size', { get: boom, configurable: true });
  poison(WeakMap.prototype, ['get', 'set', 'has', 'delete']);
  RegExp.prototype.test = boom;
  RegExp.prototype.exec = boom;
  Function.prototype.call = boom;
  Function.prototype.apply = boom;
  Function.prototype.bind = boom;
  Reflect.apply = boom;
  Reflect.get = boom;
  JSON.stringify = boom;
  JSON.parse = boom;
  Object.create = boom;
  Object.defineProperty = boom;
  Object.getOwnPropertyDescriptor = boom;
  Object.keys = boom;
  Number.isFinite = boom;
  Math.min = boom;
  Math.max = boom;
  globalThis.Function = boom;
  globalThis.String = boom;
  Object.prototype.set = undefined;
  define(Object.prototype, 'get', { get: boom, configurable: true });
  return { n: ++n, rows: [1, 2] };
}
module.exports = {
  'page.wxml': {
    tools: {
      attack,
      flipDescriptors,
      read() {
        return { n: ++n, rows: [3, 4] };
      },
    },
  },
};
