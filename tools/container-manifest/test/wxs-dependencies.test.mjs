import assert from 'node:assert/strict';
import test from 'node:test';
import { extractWxsDependencySpecifiers } from '../src/wxs-dependencies.mjs';

function valid(source, specifiers = []) {
  const graph = extractWxsDependencySpecifiers(source);
  assert.deepEqual(graph.diagnostics, [], source);
  assert.deepEqual(graph.specifiers, specifiers, source);
}

function invalid(source, code = 'ERR_INVALID_WXS_DEPENDENCY') {
  const graph = extractWxsDependencySpecifiers(source);
  assert.ok(graph.diagnostics.some(issue => issue.code === code), source);
  assert.deepEqual(graph.specifiers, [], 'invalid graph never returns apparently complete edges');
  assert.ok(graph.diagnostics.every(issue => Number.isInteger(issue.location?.line)
    && Number.isInteger(issue.location?.column)), source);
}

test('WXS graph grammar separates division, regex, comments and control flow', () => {
  for (const source of [
    'module.exports = 10 / 2 / 5;',
    String.raw`module.exports = /require\("\.\/ghost.wxs"\)/;`,
    'module.exports = /[/*]/;',
    'module.exports = /[//]/;',
    'module.exports = function() { if (true) /[/*]/.test("x"); };',
    'var result = function() { return /[/*]/; }() / 2;',
    'var n = 10; n /= 2; module.exports = n;',
  ]) valid(source);
  for (const source of [
    'do /[/*]/.test("x"); while (require("./dep.wxs"));',
    'if (false) {} else /[/*]/.test(require("./dep.wxs"));',
    'for (var n = 0; n < 1; n++) /[/*]/.test(require("./dep.wxs"));',
    'while (false) /[/*]/.test(require("./dep.wxs"));',
    'module.exports = function() { if (true) /[/*]/.test(require("./dep.wxs")); };',
    'var result = 12 / require("./dep.wxs").n / 2;',
    'var value = { n: 1 }; value.n / require("./dep.wxs").n;',
    'if (true) {} /[/*]/.test(require("./dep.wxs"));',
  ]) valid(source, ['./dep.wxs']);
});

test('WXS graph ignores inert text and visits executable template substitutions', () => {
  valid([
    "// require('./comment.wxs')",
    "/* require('./comment.wxs') */",
    `var text = "require('./string.wxs')";`,
    String.raw`var pattern = /require\('\.\/regex.wxs'\)/;`,
    "var template = `require('./template.wxs')`;",
  ].join('\n'));
  valid('module.exports = `prefix-${require("./dep.wxs").value}`;', ['./dep.wxs']);
  valid('module.exports = `${`${require("./dep.wxs")}`}`;', ['./dep.wxs']);
  invalid('require(`./dep.wxs`)');
  invalid('require(`./${name}.wxs`)');
});

test('WXS graph decodes escaped identifiers and path literals using grammar', () => {
  valid(String.raw`requ\u0069re('./\u0064ep.wxs');`, ['./dep.wxs']);
  valid(String.raw`\u0072equire('./\x64ep.wxs');`, ['./dep.wxs']);
  valid(String.raw`require('./\u{64}ep.wxs');`, ['./dep.wxs']);
  valid("require('./de\\\np.wxs');", ['./dep.wxs']);
  valid('require("./z.wxs"); require("./a.wxs"); require("./z.wxs")', ['./a.wxs', './z.wxs']);
  invalid(String.raw`requ\u0069re(name);`);
  invalid(String.raw`var alias = requ\u0069re;`);
  for (const source of [String.raw`require('./\141.wxs')`, String.raw`require('./\8.wxs')`, String.raw`require('./\0.wxs')`]) invalid(source);
});

test('WXS graph distinguishes non-computed property names and labels from lexical uses', () => {
  for (const source of [
    'var value = { require: 1, eval: 2, Function: 3 }; value.require(); value.eval(); value.Function();',
    'var value = { require() { return 1; }, get eval() { return 2; } };',
    'var { require: value, eval: other, Function: third } = object;',
    'require: while (false) { continue require; break require; }',
    'var key = "require"; var object = { [key]: 1 }; object["require"]();',
    'class Item { require() {} eval() {} Function() {} }',
  ]) valid(source);
  valid('var object = { [require("./dep.wxs").name]: 1 };', ['./dep.wxs']);
  valid('object[require("./dep.wxs").name]();', ['./dep.wxs']);
  for (const source of [
    'var value = { require };', 'var value = { [require]: 1 };',
    'object[require]();', 'var { require } = object;',
    'var { key: require } = object;',
  ]) invalid(source);
});

test('WXS graph rejects aliases, bindings and every free lexical require reference', () => {
  for (const source of [
    'var load = require; load("./dep.wxs");', 'typeof require;',
    'require;', 'require = loader;', 'require++;', 'delete require;',
    'require.call(null, "./dep.wxs");', 'require.bind(null);',
    'new require("./dep.wxs");', '(0, require)("./dep.wxs");',
    'require`./dep.wxs`;', 'function require() {}',
    'function fn(require) { return require("./dep.wxs"); }',
    'function fn() { var require; }', 'var require;', 'let require;',
    'var [require] = loaders;', 'try {} catch (require) {}',
    'var fn = ({ name: require }) => require("./dep.wxs");',
    'for (var require of []) {}',
  ]) invalid(source);
  valid('(require)("./dep.wxs");', ['./dep.wxs']);
  valid('function fn() { return arguments[0]; } module.exports = fn;', []);
});

test('WXS graph validates static direct call argument shape throughout nested code', () => {
  for (const source of [
    'require(name)', 'require()', 'require("./dep.wxs", 1)',
    'require(...["./dep.wxs"])', 'require("./" + name + ".wxs")',
    'require?.("./dep.wxs")', 'function fn() { require(name); }',
    'require(/dep/)', 'require(null)', 'require(42)',
  ]) invalid(source);
  valid('function a() { function b() { return require("./dep.wxs"); } return b; }', ['./dep.wxs']);
});

test('WXS graph rejects eval, Function, with and dynamic import rather than claiming static proof', () => {
  for (const source of [
    String.raw`eval("require(\"./dep.wxs\")")`, 'var evaluate = eval;',
    'Function("return 1")', 'new Function("return 1")', 'typeof Function;',
    'var fn = { eval };', 'var fn = { [Function]: 1 };',
    'with ({}) { require("./dep.wxs"); }', 'import("./dep.wxs")',
  ]) invalid(source, 'ERR_UNSUPPORTED_WXS_SYNTAX');
});

test('WXS graph parses the entire source and rejects malformed or out-of-grammar programs', () => {
  for (const source of [
    'function (', 'module.exports = /unterminated;', '/* unterminated',
    '"unterminated', 'module.exports = `unterminated', 'require("./dep.wxs"',
    'var source = 1; ignored ??? require("./dep.wxs");',
    'import dep from "./dep.wxs";', 'export default 1;', 'return require("./dep.wxs")',
    String.raw`requ\u00XXre('./dep.wxs')`, 'module.exports = object?.;',
  ]) invalid(source, 'ERR_INVALID_WXS_SOURCE');
});

test('WXS dependency extraction never executes source or changes its bytes', () => {
  const sentinel = '__weappContainerGraphMustNotExecute';
  delete globalThis[sentinel];
  const source = `globalThis.${sentinel} = true;\r\nthrow new Error('must never run');\r\nrequire('./dep.wxs');`;
  const before = Buffer.from(source);
  valid(source, ['./dep.wxs']);
  assert.equal(globalThis[sentinel], undefined);
  assert.deepEqual(Buffer.from(source), before);
});

test('WXS graph acceptance does not claim to discover reflected factory loaders', () => {
  // CommonJS passes require as its third factory argument. These sources have
  // no lexical require reference; the shared native-engine contract separately
  // proves that the runtime still rejects their undeclared dependency loads.
  valid('module.exports=arguments[2]("./dep.wxs");');
  valid('module.exports=(()=>arguments[2]("./dep.wxs"))();');
});
