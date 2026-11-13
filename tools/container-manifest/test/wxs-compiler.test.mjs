import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  compileWxsModule,
  compileWxmlExpression,
  WXS_COMPILER_NAME,
  WXS_COMPILER_VERSION,
  WXS_HELPER_ABI_VERSION,
} from '../src/wxs-compiler.ts';

// A model of the property ABI, isolated inside the same realm as test source.
// These tests verify the compiler's ordering and binding contract. Native
// QuickJS/V8 tests must separately verify the runtime implementation of it.
const helperSource = `(function () {
  const prototypes = new Map([
    [Number.prototype,'Number'],[String.prototype,'String'],
    [Boolean.prototype,'Boolean'],[Object.prototype,'Object'],
    [Function.prototype,'Function'],[Array.prototype,'Array'],
    [Date.prototype,'Date'],[RegExp.prototype,'RegExp']
  ]);
  const apply = Reflect.apply;
  function key(value) { return Reflect.ownKeys({[value]: true})[0]; }
  function read(base, rawKey) {
    if (base === null || base === undefined) return base[rawKey];
    const property = key(rawKey);
    const value = base[property];
    if (property !== 'constructor') return value;
    for (let owner = Object(base); owner !== null; owner = Object.getPrototypeOf(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, property);
      if (!descriptor) continue;
      return prototypes.has(owner) && descriptor.value === value ? prototypes.get(owner) : value;
    }
    return value;
  }
  function looseSet(reference, value) { reference.base[reference.rawKey] = value; return value; }
  function strictSet(reference, value) { 'use strict'; reference.base[reference.rawKey] = value; return value; }
  function looseRemove(base, rawKey) { return delete base[rawKey]; }
  function strictRemove(base, rawKey) { 'use strict'; return delete base[rawKey]; }
  function set(reference, value, strict) { return (strict ? strictSet : looseSet)(reference, value); }
  return {
    read,
    callee(base, rawKey) { return { fn: read(base, rawKey), receiver: base }; },
    invoke(record, args) { return apply(record.fn, record.receiver, args); },
    reference(base, rawKey) { return { base, rawKey }; },
    get(reference) { return read(reference.base, reference.rawKey); },
    set,
    update(reference, delta, prefix, strict) {
      let value = read(reference.base, reference.rawKey);
      const before = delta === 1 ? value++ : value--;
      set(reference, value, strict);
      return prefix ? value : before;
    },
    remove(base, rawKey, strict) { return (strict ? strictRemove : looseRemove)(base, rawKey); }
  };
})()`;

function execute(source, { compiled = true } = {}) {
  const context = vm.createContext({ module: { exports: undefined }, trace: [] });
  const output = compiled ? compileWxsModule(source) : undefined;
  if (output) {
    context.__testHelper = vm.runInContext(helperSource, context);
    vm.runInContext(`const ${output.helper} = __testHelper;\n${output.code}`, context);
  } else {
    vm.runInContext(source, context);
  }
  return JSON.parse(vm.runInContext('JSON.stringify({result:module.exports,trace})', context));
}

function agreesWithNative(source) {
  const original = execute(source, { compiled: false });
  const lowered = execute(source);
  assert.deepEqual(lowered, original);
  return lowered;
}

test('compiler identity and generated binding are deterministic and hygienic', () => {
  assert.equal(WXS_COMPILER_NAME, 'weapp-container-wxs');
  assert.equal(WXS_COMPILER_VERSION, '1.0.0');
  assert.equal(WXS_HELPER_ABI_VERSION, '1.0');
  const source = 'var __wcWxs0=1, __wcWxs\\u0031=2; module.exports = [__wcWxs0,__wcWxs1].constructor;';
  const output = compileWxsModule(source);
  assert.equal(output.helper, '__wcWxs2');
  assert.deepEqual(output, compileWxsModule(source));
  assert.equal(execute(source).result, 'Array');
});

test('all standard inherited constructors are strings without mutating native prototypes', () => {
  const source = `
    var values=[1,'s',true,{},function(){},[],new Date(0),/x/];
    module.exports=values.map(function(value){return value.constructor;});
  `;
  assert.deepEqual(execute(source).result,
    ['Number', 'String', 'Boolean', 'Object', 'Function', 'Array', 'Date', 'RegExp']);
  const context = vm.createContext({});
  const before = vm.runInContext('Array.prototype.constructor', context);
  const output = compileWxsModule('module.exports=[1].map(function(x){return x+1;});');
  context.__testHelper = vm.runInContext(helperSource, context);
  context.module = { exports: null };
  vm.runInContext(`const ${output.helper}=__testHelper;${output.code}`, context);
  assert.equal(vm.runInContext('Array.prototype.constructor', context), before);
  assert.deepEqual(JSON.parse(JSON.stringify(context.module.exports)), [2]);
});

test('own and inherited constructor overrides and accessors stay observable', () => {
  const output = execute(`
    var own={constructor:'own'};
    var inherited=Object.create({constructor:'inherited'});
    var getter=Object.create({get constructor(){trace.push('getter');return 'accessor';}});
    var custom=Object.create({constructor:function Custom(){}});
    module.exports=[own.constructor,inherited['constructor'],getter.constructor,typeof custom.constructor];
  `);
  assert.deepEqual(output, { result: ['own', 'inherited', 'accessor', 'function'], trace: ['getter'] });
});

test('property reads evaluate base, raw key and coercion once in native order', () => {
  const output = agreesWithNative(`
    function base(){trace.push('base');return {x:7};}
    function key(){trace.push('key');return {toString:function(){trace.push('coerce');return 'x';}};}
    module.exports=base()[key()];
  `);
  assert.deepEqual(output, { result: 7, trace: ['base', 'key', 'coerce'] });
});

test('member calls capture getter and receiver before all arguments', () => {
  const output = agreesWithNative(`
    var object={id:'receiver',get method(){trace.push('get');return function(a,b){trace.push(this.id);return a+b;};}};
    function base(){trace.push('base');return object;}
    function key(){trace.push('key');return 'method';}
    function argument(n){trace.push('arg'+n);return n;}
    module.exports=(base()[key()])(argument(1),argument(2));
  `);
  assert.deepEqual(output, { result: 3, trace: ['base', 'key', 'get', 'arg1', 'arg2', 'receiver'] });
});

test('callee replacement during arguments cannot change the captured callable', () => {
  agreesWithNative(`
    var object={n:4,method:function(v){return this.n+v;}};
    module.exports=object.method((object.method=function(){throw 'changed';},3));
  `);
});

test('non-callable and getter failures preserve argument execution boundaries', () => {
  const output = agreesWithNative(`
    function argument(){trace.push('arg');return 1;}
    var object={method:3,get fail(){trace.push('get');throw new Error('getter');}};
    try { object.method(argument()); } catch(e) { trace.push(e.name); }
    try { object.fail(argument()); } catch(e) { trace.push(e.message); }
    try { (null).method(argument()); } catch(e) { trace.push(e.name); }
    module.exports=true;
  `);
  assert.deepEqual(output.trace, ['arg', 'TypeError', 'get', 'getter', 'TypeError']);
});

test('detached and comma calls stay detached while nested call/apply/bind preserve receivers', () => {
  agreesWithNative(`
    'use strict';
    var object={n:5,method:function(v){'use strict';return this===undefined?'detached':this.n+v;}};
    var detached=object.method;
    module.exports=[detached(1),(0,object.method)(1),object.method.call({n:7},2),
      object.method.apply({n:8},[3]),object.method.bind({n:9})(4)];
  `);
});

test('simple assignment defers key coercion and null failure until after RHS', () => {
  const output = agreesWithNative(`
    var target={};
    var key={toString:function(){trace.push('key');return 'x';}};
    function rhs(){trace.push('rhs');return 8;}
    module.exports=target[key]=rhs();
    try { (null)[key]=rhs(); } catch(e) { trace.push(e.name); }
  `);
  assert.deepEqual(output, { result: 8, trace: ['rhs', 'key', 'rhs', 'TypeError'] });
});

test('null bases evaluate raw key expressions but never coerce those keys', () => {
  const output = agreesWithNative(`
    function base(){trace.push('base');return null;}
    function key(){trace.push('keyexpr');return {toString:function(){trace.push('coerce');return 'x';}};}
    function rhs(){trace.push('rhs');return 1;}
    try {base()[key()];}catch(e){trace.push(e.name);}
    try {base()[key()](rhs());}catch(e){trace.push(e.name);}
    try {base()[key()]+=rhs();}catch(e){trace.push(e.name);}
    try {base()[key()]++;}catch(e){trace.push(e.name);}
    try {delete base()[key()];}catch(e){trace.push(e.name);}
    module.exports=true;
  `);
  assert.deepEqual(output.trace, Array.from({length:5}, () => ['base','keyexpr','TypeError']).flat());
});

test('compound assignment reads before RHS, coerces values after RHS and reconverts raw keys', () => {
  const output = agreesWithNative(`
    var target={get x(){trace.push('get');return {valueOf:function(){trace.push('left value');return 4;}};},
      set x(v){trace.push('set:'+v);}};
    var key={toString:function(){trace.push('key');return 'x';}};
    function rhs(){trace.push('rhs');return {valueOf:function(){trace.push('right value');return 3;}};}
    module.exports=target[key]+=rhs();
  `);
  assert.deepEqual(output, { result: 7, trace: ['key', 'get', 'rhs', 'left value', 'right value', 'key', 'set:7'] });
});

test('compound assignments evaluate each raw reference once and preserve this and arguments', () => {
  agreesWithNative(`
    var count=0, object={x:10};
    function base(){trace.push('base');return object;}
    function key(){trace.push('keyexpr');return 'x';}
    function calculate(value){base()[key()]*=arguments[0]+this.offset;return object.x;}
    module.exports=calculate.call({offset:2},3);
  `);
  for (const operator of ['-', '*', '/', '%', '**', '<<', '>>', '>>>', '&', '^', '|']) {
    agreesWithNative(`var object={x:13};module.exports=[object.x ${operator}= 2, object.x];`);
  }
});

test('changing raw property keys are converted separately for reads and writes', () => {
  const output = agreesWithNative(`
    var conversions=0;
    var key={toString:function(){var value=conversions++===0?'x':'out';trace.push('key:'+value);return value;}};
    var object={get x(){trace.push('get');return {valueOf:function(){trace.push('valueOf');return 2;}};},
      set out(value){trace.push('set:'+value);}};
    function rhs(){trace.push('rhs');return 3;}
    module.exports=object[key]+=rhs();
  `);
  assert.deepEqual(output, {result:5,trace:['key:x','get','rhs','valueOf','key:out','set:5']});
});

test('prefix and postfix updates preserve ToNumeric, key coercion and setter order', () => {
  const output = agreesWithNative(`
    var stored='4';
    var object={get x(){trace.push('get');return stored;},set x(v){trace.push('set:'+v);stored=v;}};
    var key={toString:function(){trace.push('key');return 'x';}};
    module.exports=[object[key]++,++object[key],object[key]--,--object[key],stored];
  `);
  assert.deepEqual(output.result, [4, 6, 6, 4, 4]);
  assert.deepEqual(output.trace.slice(0, 4), ['key', 'get', 'key', 'set:5']);
  agreesWithNative('var object={x:4n};module.exports=[String(object.x++),String(++object.x),String(object.x)];');
});

test('delete evaluates key without reading getter and preserves strict deletion errors', () => {
  const output = agreesWithNative(`
    var object={get x(){throw new Error('must not read');}};
    var key={toString:function(){trace.push('key');return 'x';}};
    var result=delete (object[key]);
    function strict(){'use strict';var x={};Object.defineProperty(x,'fixed',{value:1});
      try {delete x.fixed;}catch(error){trace.push(error.name);}}
    strict();module.exports=[result,'x' in object];
  `);
  assert.deepEqual(output, { result: [true, false], trace: ['key', 'TypeError'] });
});

test('strictness follows function directives and inherited strict lexical code', () => {
  const output = agreesWithNative(`
    function loose(){var p='x';return p.field=3;}
    function strict(){'use strict';return function(){var p='x';return p.field=4;};}
    function emptyDirective(){'other';'use strict';var p=1;return p.field=5;}
    trace.push(loose());
    try {strict()();}catch(e){trace.push(e.name);}
    try {emptyDirective();}catch(e){trace.push(e.name);}
    module.exports=true;
  `);
  assert.deepEqual(output.trace, [3, 'TypeError', 'TypeError']);
  agreesWithNative(`'use strict';function child(){var p='x';try{p.a=1;}catch(e){return e.name;}}module.exports=child();`);
});

test('primitive inherited setters retain a primitive receiver in strict and sloppy assignments', () => {
  const output = agreesWithNative(`
    Object.defineProperty(Number.prototype,'probe',{configurable:true,set:function(value){
      'use strict';trace.push([typeof this,this,value]);
    }});
    function loose(){var value=7;return value.probe=4;}
    function strict(){'use strict';var value=8;return value.probe=5;}
    module.exports=[loose(),strict()];
  `);
  assert.deepEqual(output,{result:[4,5],trace:[['number',7,4],['number',8,5]]});
});

test('property keys whose string-hint conversion returns a Symbol are preserved', () => {
  const output = agreesWithNative(`
    var symbol=Symbol('key');
    var key={};key[Symbol.toPrimitive]=function(hint){trace.push(hint);return symbol;};
    var object={};object[symbol]=1;
    var read=object[key];object[key]+=3;
    module.exports=[read,object[symbol],delete object[key],symbol in object];
  `);
  assert.deepEqual(output,{result:[1,4,true,false],trace:['string','string','string','string']});
});

test('member write exceptions and value coercion exceptions propagate at the original point', () => {
  agreesWithNative(`
    var key={toString:function(){trace.push('key');throw new Error('key');}};
    var object={get x(){trace.push('get');throw new Error('get');}};
    function rhs(){trace.push('rhs');return 1;}
    try { object[key]=rhs(); }catch(e){trace.push(e.message);}
    try { object.x+=rhs(); }catch(e){trace.push(e.message);}
    module.exports=true;
  `);
});

test('ES5 control flow, getter/setter definitions and for-in member targets remain valid', () => {
  agreesWithNative(`
    var object={value:0,get x(){return this.value;},set x(v){this.value=v;}};
    for(var key in {a:1,b:2}) {object.x+=1;}
    var holder={};for(holder.key in {c:1,d:2}) {trace.push(holder.key);}
    var n=0;outer:for(var i=0;i<3;i++){if(i===1)continue outer;n+=i;}
    switch(object.x){case 2:trace.push('two');break;default:trace.push('other');}
    try{throw new Error('ok');}catch(e){trace.push(e.message);}finally{trace.push(n);}
    module.exports=object.x;
  `);
});

test('for-in targets use the write ABI on every iteration with labels and lexical context intact', () => {
  const output = agreesWithNative(`
    var object={},calls=0;
    function base(){trace.push('base');return object;}
    function key(){trace.push('keyexpr');return {toString:function(){trace.push('key');return 'constructor';}};}
    function loop(input){outer:for(base()[key()] in input){
      trace.push(this.tag+':'+arguments[0][object.constructor]);
      if(calls++===0)continue outer;
      break outer;
    }return object.constructor;}
    module.exports=loop.call({tag:'receiver'},{first:1,second:2,third:3});
  `);
  assert.deepEqual(output,{result:'second',trace:['base','keyexpr','key','receiver:1','base','keyexpr','key','receiver:2']});
  const compiled = compileWxsModule('for(holder.constructor in values){}');
  assert.match(compiled.code, new RegExp(`${compiled.helper}\\.set\\(`), 'loop writes cannot bypass the dialect ABI');
  const context=vm.createContext({});
  context.__testHelper=vm.runInContext(helperSource,context);
  const loop=compileWxsModule('for(object.x in {a:1}){}');
  context.object={};
  assert.equal(vm.runInContext(`const ${loop.helper}=__testHelper;${loop.code}`,context),undefined);
});

test('native constructors and parenthesized member constructors evaluate correctly', () => {
  agreesWithNative(`
    var object={get factory(){trace.push('getter');return function(v){this.value=v;};}};
    function argument(){trace.push('arg');return 6;}
    module.exports=(new (object.factory)(argument())).value;
  `);
});

test('WXML expression and template-data shorthand use the same property semantics', () => {
  function evaluate(source, options) {
    const output = compileWxmlExpression(source, options);
    const context = vm.createContext({});
    context.scope = vm.runInContext('({data:{value:[1,2]}})', context);
    context.__testHelper = vm.runInContext(helperSource, context);
    return JSON.parse(vm.runInContext(`JSON.stringify((function(){with(scope){return ((${output.helper})=>(${output.code}))(__testHelper);}})())`, context));
  }
  assert.equal(evaluate('data.value.constructor'), 'Array');
  assert.deepEqual(evaluate('kind:data.value.constructor, length:data.value.length', {shorthand:true}), {kind:'Array',length:2});
  assert.deepEqual(evaluate('{kind:data.value.constructor}', {shorthand:true}), {kind:'Array'});
});

test('hygienic WXML inner lexical binding resists an intercepting with-scope Proxy', () => {
  const output = compileWxmlExpression('value.constructor');
  const context = vm.createContext({});
  context.__testHelper = vm.runInContext(helperSource, context);
  context.compiled = output.code;
  const evaluator = vm.runInContext(`(function(abi){
    const scope=new Proxy({value:[]},{has(){return true;},get(target,key){
      if(key===Symbol.unscopables)return undefined;
      if(key==='value')return target.value;
      throw new Error('intercepted:'+String(key));
    }});
    return ((innerAbi)=>{with(scope){return ((${output.helper})=>(${output.code}))(innerAbi);}})(abi);
  })`, context);
  // The ABI argument must also cross the with boundary through a lexical
  // declaration inside it; a normal function parameter alone is interceptable.
  assert.throws(() => evaluator(context.__testHelper), /intercepted:innerAbi/);
  const safe = vm.runInContext(`(function(abi){
    const scope=new Proxy({value:[]},{has(){return true;},get(target,key){
      if(key===Symbol.unscopables)return undefined;
      if(key==='value')return target.value;
      throw new Error('intercepted:'+String(key));
    }});
    return ((bridge)=>{with(scope){return function(${output.helper}){return (${output.code});};}})(abi)(abi);
  })`, context);
  assert.equal(safe(context.__testHelper), 'Array');
});

test('unsupported operations fail explicitly instead of leaving unlowered semantics', () => {
  const sources = [
    'eval("x")', 'var x=Function', 'with(x){}', 'import("x")',
    'value?.x', 'value.x?.()', 'async function f(){}', 'function* f(){yield 1}',
    'value.x`template`', 'var {x}=value', 'var [x]=value', 'var x={...value}',
    'function f(...args){}', 'fn(...args)', 'for(var value of values){}',
    'class X {}', 'function f(){return new.target}',
  ];
  for (const source of sources) assert.throws(() => compileWxsModule(source), {code:'ERR_UNSUPPORTED_WXS_SYNTAX'}, source);
  assert.throws(() => compileWxsModule('var x = ;'), {code:'ERR_UNSUPPORTED_WXS_SYNTAX'});
  assert.throws(() => compileWxmlExpression('var x=1'), {code:'ERR_UNSUPPORTED_WXS_SYNTAX'});
  assert.throws(() => compileWxsModule(null), {code:'ERR_UNSUPPORTED_WXS_SYNTAX'});
  agreesWithNative('var object={eval:3,Function:4};module.exports=[object.eval,object.Function];');
});
