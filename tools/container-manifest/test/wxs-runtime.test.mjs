import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { compileWxmlExpression, compileWxsModule } from '../src/wxs-compiler.mjs';

// This exercises the shipped JS bootstrap and compiler together in Node's VM.
// It is structural evidence, not a native-engine or official DevTools oracle.
const bootstrap = readFileSync(new URL('../../../crates/container-core/src/view.js', import.meta.url), 'utf8');

function realm() {
  const context = vm.createContext({});
  vm.runInContext(bootstrap, context, { timeout: 1000 });
  vm.runInContext('globalThis.__fixtureLoads=0;globalThis.__fixtureCalls=0;', context);
  const call = (name, input) => JSON.parse(JSON.stringify(vm.runInContext(
    `__weappContainer_view_${name}(${JSON.stringify(input)})`, context, { timeout: 1000 },
  )));
  return {
    load: input => call('load', input),
    evaluate: (expression, options = {}) => call('evaluate', [{
      taskId: 'probe', scopeId: 'scope', documentId: 'page.wxml',
      expression, data: {}, bindings: { probe: 'wxs:probe.wxs' }, ...options,
    }]),
    render: (documents, tasks) => call('render', { documents, tasks }),
    inspect: expression => vm.runInContext(expression, context, { timeout: 1000 }),
  };
}

function moduleSource(source, id = 'wxs:probe.wxs') {
  return { id, source, dependencies: [], compilation: { ...compileWxsModule(source), abi: '1.0' } };
}

function expression(source, shorthand = false) {
  return { source, shorthand, compilation: { ...compileWxmlExpression(source, { shorthand }), abi: '1.0' } };
}

function document(documentId, source, bindings = {}) {
  return {
    documentId, bindings,
    ast: { version: 1, nodes: [{ kind: 'text', value: `{{${source}}}`, bindings: [source] }] },
    compilation: [expression(source)],
  };
}

function task(documentId, data = {}, taskId = documentId) {
  return { taskId, scopeId: 'scope', documentId, data };
}

function decode(value) {
  if (value.type === 'object') return Object.fromEntries(Object.entries(value.value).map(([key, child]) => [key, decode(child)]));
  if (value.type === 'array') return value.value.map(decode);
  if (value.type === 'null') return null;
  if (value.type === 'undefined') return undefined;
  assert.ok(['bool', 'number', 'string'].includes(value.type), JSON.stringify(value));
  return value.value;
}

function evaluateModule(source, expressionSource = 'probe') {
  const runtime = realm();
  assert.deepEqual(runtime.load([moduleSource(source)]), { ok: true });
  const result = runtime.evaluate(expressionSource);
  assert.equal(result.ok, true, JSON.stringify(result));
  return decode(result.results[0].value);
}

test('bare repeat keys remain literal property names for objects and primitive items', () => {
  const runtime = realm();
  const keys = ['class', 'first-name', 'constructor'];
  const document = {
    documentId: 'page.wxml', bindings: {}, compilation: [expression('items')],
    ast: { version: 1, nodes: keys.map(key => ({
      kind: 'element', tag: 'view', attrs: {}, bindings: [],
      directives: { forExpr: 'items', forKey: key }, children: [],
    })) },
  };
  const result = runtime.render([document], [task('page.wxml', {
    items: [{ class: 'keyword', 'first-name': 'hyphen', constructor: 'own' }, 'primitive'],
  })]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.results[0].ast.nodes.map(node => node.key),
    ['keyword', '', 'hyphen', '', 'own', '']);
});

test('constructor observations preserve own values, inherited overrides and single getter reads', () => {
  const value = evaluateModule(`
    var reads=[];
    var own={constructor:'own'};
    var ownNative={constructor:Array};
    var ownGetter={get constructor(){reads.push('own');return Array;}};
    var inherited=Object.create({constructor:'inherited'});
    var inheritedNative=Object.create({constructor:Array});
    var inheritedGetter=Object.create({get constructor(){reads.push('inherited');return Array;}});
    var frozen=Object.freeze({constructor:Array});
    module.exports={
      builtin:[(1).constructor,'s'.constructor,true.constructor,({}).constructor,
        (function(){}).constructor,[].constructor,getDate(0).constructor,getRegExp('a').constructor],
      own:own.constructor, ownNative:ownNative.constructor===Array,
      ownGetter:ownGetter.constructor===Array, inherited:inherited.constructor,
      inheritedNative:inheritedNative.constructor===Array,
      inheritedGetter:inheritedGetter.constructor===Array,
      frozen:frozen.constructor===Array, reads:reads
    };
  `);
  assert.deepEqual(value, {
    builtin: ['Number', 'String', 'Boolean', 'Object', 'Function', 'Array', 'Date', 'RegExp'],
    own: 'own', ownNative: true, ownGetter: true, inherited: 'inherited',
    inheritedNative: true, inheritedGetter: true, frozen: true, reads: ['own', 'inherited'],
  });
});

test('ordinary own method writes survive transport freezing without overriding custom readonly prototypes', () => {
  const value = evaluateModule(`
    var o={}, a=[];
    o.toString=function(){return 'custom-object';};
    a.push=function(){return 'custom-array';};
    o.constructor=Array;
    var locked=Object.create(null);
    Object.defineProperty(locked,'constructor',{value:'locked-constructor',writable:false});
    Object.defineProperty(locked,'toString',{value:'locked-method',writable:false});
    var child=Object.create(locked);
    child.constructor='changed'; child.toString='changed';
    var setterCalls=[];
    var proto={set toString(value){setterCalls.push(value);}};
    var setterChild=Object.create(proto); setterChild.toString='setter';
    function strictWrite(){'use strict';try{child.constructor='changed';return false;}catch(error){return error.name==='TypeError';}}
    module.exports={object:o.toString(),array:a.push(1),ownConstructor:o.constructor===Array,
      lockedConstructor:child.constructor,lockedMethod:child.toString,
      strictReadonly:strictWrite(),setterCalls:setterCalls};
  `);
  assert.deepEqual(value, {
    object: 'custom-object', array: 'custom-array', ownConstructor: true,
    lockedConstructor: 'locked-constructor', lockedMethod: 'locked-method',
    strictReadonly: true, setterCalls: ['setter'],
  });
});

test('user readonly changes on the unfrozen Function prototype remain authoritative', () => {
  const value = evaluateModule(`
    var fn=function(){};
    var proto=Object.getPrototypeOf(fn);
    Object.defineProperty(proto,'call',{value:'locked',writable:false});
    fn.call='changed';
    function strictWrite(){'use strict';try{fn.call='changed';return false;}catch(error){return error.name==='TypeError';}}
    module.exports={value:fn.call,own:Object.getOwnPropertyDescriptor(fn,'call')!==undefined,
      strictReadonly:strictWrite()};
  `);
  assert.deepEqual(value, { value: 'locked', own: false, strictReadonly: true });
});

test('for-in member assignments use the same property semantics and preserve LHS timing and labels', () => {
  const value = evaluateModule(`
    var targets=[{},{}], index=0, log=[];
    for(targets[(log.push('base'+index),index++)].constructor in {a:1,b:2})log.push('body'+index);
    var holder={};
    outer:for(holder.constructor in {a:1,b:2}){
      if(holder.constructor==='a')continue outer;
      break outer;
    }
    module.exports={values:[targets[0].constructor,targets[1].constructor],log:log,label:holder.constructor};
  `);
  assert.deepEqual(value, { values: ['a', 'b'], log: ['base0', 'body1', 'base1', 'body2'], label: 'b' });
});

test('native array species and constructor descriptors remain functions while reads use WXS type names', () => {
  const value = evaluateModule(`
    var source=[1,2,3];
    var descriptor=Object.getOwnPropertyDescriptor(Array.prototype,'constructor');
    module.exports={mapped:source.map(function(v){return v+1;}),
      filtered:source.filter(function(v){return v>1;}),sliced:source.slice(1),
      concatenated:source.concat([4]),type:source.constructor,
      nativeConstructor:descriptor.value===Array, frozen:descriptor.writable===false};
  `);
  assert.deepEqual(value, {
    mapped: [2, 3, 4], filtered: [2, 3], sliced: [2, 3], concatenated: [1, 2, 3, 4],
    type: 'Array', nativeConstructor: true, frozen: true,
  });
});

test('references preserve key conversion timing, primitive writes and captured callees', () => {
  const value = evaluateModule(`
    var log=[];
    var key={toString:function(){log.push('key');return 'constructor';}};
    var o={}; o[key]=(log.push('rhs-assign'),'a');
    o[key]+=(log.push('rhs-compound'),'b');
    var numberKey={toString:function(){log.push('number-key');return 'x';}};
    (1)[numberKey]=(log.push('primitive-rhs'),2);
    function strictWrite(){'use strict';try{(1)[numberKey]=(log.push('strict-rhs'),2);}catch(error){log.push(error.name);}}
    strictWrite();
    var receiver={method:function(value){return this===receiver?value:'lost-receiver';}};
    var captured=receiver.method((receiver.method=function(){return 'replacement';},'captured'));
    try{({method:1}).method(log.push('noncallable-arg'));}catch(error){log.push(error.name);}
    module.exports={value:o.constructor,log:log,captured:captured};
  `);
  assert.deepEqual(value, {
    value: 'ab', captured: 'captured',
    log: ['rhs-assign', 'key', 'key', 'rhs-compound', 'key',
      'primitive-rhs', 'number-key', 'strict-rhs', 'number-key', 'TypeError',
      'noncallable-arg', 'TypeError'],
  });
});

test('compiled WXML helper binding preserves page arguments/scope names and resists scope interception', () => {
  const runtime = realm();
  assert.deepEqual(runtime.load([]), { ok: true });
  const source = 'payload.constructor+"|"+arguments.constructor+"|"+scope.constructor+"|"+__wcWxs0.constructor';
  const compiled = expression(source);
  assert.notEqual(compiled.compilation.helper, '__wcWxs0');
  const input = document('page.wxml', source);
  input.compilation = [compiled];
  const result = runtime.render([input], [task('page.wxml', {
    payload: [], arguments: { constructor: 'arguments-data' }, scope: { constructor: 'scope-data' },
    __wcWxs0: { constructor: 'named-data' }, [compiled.compilation.helper]: 'cannot replace helper',
  })]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.results[0].ast.nodes[0].value, 'Array|arguments-data|scope-data|named-data');
});

test('invalid module ABI or helper never executes raw source or replaces the last registry', () => {
  const runtime = realm();
  const original = moduleSource('var count=0;module.exports={next:function(){return ++count;}};');
  assert.deepEqual(runtime.load([original]), { ok: true });
  assert.equal(decode(runtime.evaluate('probe.next()').results[0].value), 1);
  for (const change of [{ abi: '2.0' }, { helper: 'arguments' }, { helper: '__wc-invalid' }]) {
    const invalid = moduleSource('globalThis.__fixtureLoads++;throw new Error("raw source executed");');
    Object.assign(invalid.compilation, change);
    const result = runtime.load([invalid]);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ERR_VIEW_MODULE');
    assert.equal(runtime.inspect('__fixtureLoads'), 0);
  }
  assert.equal(decode(runtime.evaluate('probe.next()').results[0].value), 2);
});

test('compiled WXML registries fail closed across every document before running any module', () => {
  for (const invalidKind of ['missing-source', 'missing-other-document-source', 'bad-abi', 'duplicate-source']) {
    const runtime = realm();
    assert.deepEqual(runtime.load([moduleSource(`
      globalThis.__fixtureLoads++;
      module.exports={bump:function(){globalThis.__fixtureCalls++;return 'executed';}};
    `)]), { ok: true });
    const source = 'probe.bump()';
    const first = document('first.wxml', source, { probe: 'wxs:probe.wxs' });
    const second = document('second.wxml', source, { probe: 'wxs:probe.wxs' });
    if (invalidKind === 'missing-source') first.compilation = [];
    if (invalidKind === 'missing-other-document-source') second.compilation = [];
    if (invalidKind === 'bad-abi') first.compilation[0].compilation.abi = '2.0';
    if (invalidKind === 'duplicate-source') first.compilation.push(structuredClone(first.compilation[0]));
    const result = runtime.render([first, second], [task('first.wxml')]);
    assert.equal(result.ok, false, invalidKind);
    assert.equal(result.error.code, 'ERR_VIEW_INVALID_BATCH', invalidKind);
    assert.equal(runtime.inspect('__fixtureLoads'), 0, invalidKind);
    assert.equal(runtime.inspect('__fixtureCalls'), 0, invalidKind);
    // Validation failure does not consume the last working module registry.
    assert.equal(decode(runtime.evaluate('probe.bump()').results[0].value), 'executed');
  }
});

test('compiled document expressions retain each documents lexical WXS aliases through includes', () => {
  const runtime = realm();
  assert.deepEqual(runtime.load([
    moduleSource('module.exports={value:[]};', 'wxs:array.wxs'),
    moduleSource('module.exports={value:{}};', 'wxs:object.wxs'),
  ]), { ok: true });
  const source = 'tools.value.constructor';
  const first = document('page.wxml', source, { tools: 'wxs:array.wxs' });
  first.ast.nodes.push({ kind: 'element', tag: 'include', attrs: { src: './fragment.wxml' }, bindings: [], children: [] });
  const fragment = document('fragment.wxml', source, { tools: 'wxs:object.wxs' });
  const result = runtime.render([first, fragment], [task('page.wxml')]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.results[0].ast.nodes.map(node => [node.value, node.lexicalOrigin.documentId]), [
    ['Array', 'page.wxml'], ['Object', 'fragment.wxml'],
  ]);
});
