import test from 'node:test'
import assert from 'node:assert/strict'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

// Production source composition in Node VM only. The host-side installer is
// the retained transport; no test-only collector is published in the realm.
const members = ['Performance', 'EntryList'].flatMap(type =>
  ['getEntries', 'getEntriesByName', 'getEntriesByType'].map(method => `object:${type}.${method}`))
const allowed = () => Object.fromEntries(['wx.getPerformance', ...members].map(name => [name, 'partial']))
async function checkpoint() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function realm(engine, grants = allowed()) {
  const life = { active: true }
  const r = createAppServiceTestRealm(engine, { __container_host_performance_active: () => life.active })
  r.life = life; r.number = 0; r.grants = grants
  r.install = map => r.transports.installHostEnvironment({ kind: 'capabilities', capabilities: map })
  r.install(grants)
  r.register = (id, source, dependencies = []) => r.transports.installHostEnvironment({
    kind: 'module-command', operation: 'register', id: `module:${id}.js`, source,
    dependencies: dependencies.map(value => `module:${value}.js`), format: 'commonjs', number: ++r.number,
  })
  r.evaluate = id => r.transports.installHostEnvironment({ kind: 'module-command', operation: 'evaluate', id: `module:${id}.js` })
  r.execute = (id, source = 'exports.executed = true;') => { r.register(id, source); return r.evaluate(id) }
  r.read = expression => r.json(expression)
  r.entries = () => r.read('wx.getPerformance().getEntries()')
  return r
}

for (const engine of ['quickjs', 'v8']) {
  test(`${engine}: private registered source executes, cache hits do not create extra samples`, () => {
    const r = realm(engine)
    r.execute('real', 'globalThis.actualExecutions=(globalThis.actualExecutions||0)+1; exports.read=function(){return actualExecutions;}')
    r.evaluate('real')
    assert.equal(r.run('actualExecutions'), 1)
    assert.deepEqual(r.entries().map(entry => entry.fileList), [['real.js']])
    assert.equal(JSON.parse(r.transports.batchCall(1, 'read', [])), 1)
    assert.equal(r.run('typeof __container_performance'), 'undefined')
    assert.equal(r.run('typeof __container_module_owner'), 'undefined')
    assert.equal(r.run('typeof __container_host_performance_active'), 'undefined')
  })

  test(`${engine}: public named/registered fake evaluations execute without trusted performance samples`, () => {
    const r = realm(engine)
    r.run(`__container_evaluate_named_module('module:fake.js',function(){globalThis.fakeRan=1;},true);
      __container_define_module('module:fake-record.js',999,[],'commonjs',function(){globalThis.fakeRan++;});
      __container_evaluate_module('module:fake-record.js');`)
    assert.equal(r.run('fakeRan'), 2)
    assert.deepEqual(r.entries(), [])
    r.execute('real')
    assert.equal(r.entries().length, 1)
  })

  test(`${engine}: actual dependency/cycle execution is sampled once per successful record`, () => {
    const r = realm(engine)
    r.register('a', "exports.ready=1; require('./b'); globalThis.aRuns=(globalThis.aRuns||0)+1;", ['b'])
    r.register('b', "require('./a'); globalThis.bRuns=(globalThis.bRuns||0)+1;", ['a'])
    r.evaluate('a'); r.evaluate('b')
    assert.equal(r.run('aRuns+bRuns'), 2)
    assert.deepEqual(r.entries().flatMap(entry => entry.fileList).sort(), ['a.js', 'b.js'])
  })

  test(`${engine}: failed importer retries without resampling its successful dependency`, () => {
    const r = realm(engine)
    r.register('dependency', 'globalThis.dependencyRuns=(globalThis.dependencyRuns||0)+1;')
    r.register('importer', "require('./dependency'); if (!globalThis.retryAllowed) throw Error('real failure'); globalThis.importerRuns=1;", ['dependency'])
    assert.throws(() => r.evaluate('importer'), /real failure/)
    assert.deepEqual(r.entries().flatMap(entry => entry.fileList), ['dependency.js'])
    r.run('globalThis.retryAllowed=true')
    r.evaluate('importer')
    assert.equal(r.run('dependencyRuns'), 1)
    assert.equal(r.run('importerRuns'), 1)
    assert.deepEqual(r.entries().flatMap(entry => entry.fileList).sort(), ['dependency.js', 'importer.js'])
  })

  test(`${engine}: global evaluator/define/export replacement cannot bypass actual native commands`, () => {
    const r = realm(engine)
    r.run(`function poison(){throw Error('public alias used');}
      __container_evaluate_named_module=poison; __container_define_module=poison;
      __container_evaluate_module=poison; __container_module_exports=poison;`)
    r.execute('private', 'exports.read=function(){return 23;}')
    assert.equal(JSON.parse(r.transports.batchCall(1, 'read', [])), 23)
    assert.deepEqual(r.entries().flatMap(entry => entry.fileList), ['private.js'])
  })

  test(`${engine}: a trusted factory has no lexical collector/loader authority`, () => {
    const r = realm(engine)
    r.execute('scope', 'globalThis.privateNames=[typeof __container_module_owner,typeof __container_performance,typeof __host_install_environment]; globalThis.factoryCaller=arguments.callee.caller;')
    assert.deepEqual(r.read('privateNames'), ['undefined', 'undefined', 'undefined'])
    assert.equal(r.run('factoryCaller'), null)
  })

  test(`${engine}: fake IDs/numbers and frozen diagnostic exports cannot redirect actual records`, () => {
    const r = realm(engine)
    r.run(`__container_define_module('module:actual.js',1,[],'commonjs',function(require,module){module.exports={read:function(){return 'fake';}};});
      __container_evaluate_module('module:actual.js');
      Object.freeze(__container_modules);
      Object.defineProperty(globalThis,'__container_modules',{configurable:true,get:function(){throw Error('diagnostic read');}});`)
    r.execute('actual', `globalThis.actualRuns=(globalThis.actualRuns||0)+1; module.exports={read:function(){return actualRuns;}};`)
    r.evaluate('actual')
    assert.equal(JSON.parse(r.transports.batchCall(1, 'read', [])), 1)
    assert.deepEqual(r.entries().flatMap(entry => entry.fileList), ['actual.js'])
  })

  test(`${engine}: anonymous native compatibility loads use private exports without inventing named samples`, () => {
    const r = realm(engine)
    r.run('Object.freeze(__container_modules); globalThis.__container_modules=null;')
    assert.equal(r.transports.installHostEnvironment({kind:'module-command',operation:'anonymous',id:'',number:1,
      source:'globalThis.anonymousRuns=(globalThis.anonymousRuns||0)+1; exports.read=function(){return anonymousRuns;}'}), true)
    assert.equal(JSON.parse(r.transports.batchCall(1, 'read', [])), 1)
    assert.deepEqual(r.entries(), [])
  })

  test(`${engine}: member methods have independent captured policies and saved-alias revocation`, async () => {
    for (const member of members) {
      const r = realm(engine), [type, method] = member.slice('object:'.length).split('.')
      r.run('var p=wx.getPerformance(), savedList; p.createObserver(function(list){savedList=list;}).observe({type:"script"});')
      r.execute('sample'); await checkpoint()
      r.run(`var target=${type === 'Performance' ? 'p' : 'savedList'}; var saved=target.${method};`)
      const args = method === 'getEntries' ? '' : method === 'getEntriesByName' ? "'evaluateScript','script'" : "'script'"
      assert.equal(r.run(`Array.isArray(saved(${args}))`), true)
      r.install({ ...allowed(), [member]: 'unsupported' })
      assert.throws(() => r.run(`saved.call({},${args})`), error => error.api === member)
      const other = method === 'getEntries' ? 'getEntriesByType' : 'getEntries'
      assert.equal(r.run(`Array.isArray(target.${other}(${other === 'getEntries' ? '' : "'script'"}))`), true)
      r.install(allowed())
      assert.equal(r.run(`Array.isArray(saved(${args}))`), true)
    }
  })

  test(`${engine}: factory permission alone does not silently grant query members`, () => {
    const r = realm(engine, { 'wx.getPerformance': 'partial' })
    assert.equal(r.run('typeof wx.getPerformance()'), 'object')
    assert.throws(() => r.entries(), error => error.api === 'object:Performance.getEntries')
  })

  test(`${engine}: mutation of diagnostic capability aliases does not change installed member authority`, () => {
    const r = realm(engine)
    r.run("__container_capabilities['object:Performance.getEntries']='unsupported'")
    assert.deepEqual(r.entries(), [])
    r.install({ ...allowed(), 'object:Performance.getEntries': 'unsupported' })
    r.run("__container_capabilities['object:Performance.getEntries']='full'")
    assert.throws(() => r.entries(), error => error.api === 'object:Performance.getEntries')
  })

  test(`${engine}: returned arrays and nested file lists do not alter private snapshots or filters`, async () => {
    const r = realm(engine)
    r.run('var saved; wx.getPerformance().createObserver(function(list){if(!saved)saved=list;}).observe({type:"script"});')
    r.execute('one'); await checkpoint(); r.execute('two'); await checkpoint()
    r.run("var snapshot=saved.getEntries(); snapshot[0].fileList[0]='forged'; snapshot[0].name='forged'; snapshot.length=0;")
    assert.deepEqual(r.read('saved.getEntries().flatMap(entry=>entry.fileList)'), ['one.js'])
    assert.equal(r.read("wx.getPerformance().getEntriesByName('evaluateScript','script')").length, 2)
    assert.deepEqual(r.read("wx.getPerformance().getEntriesByName('evaluateScript','navigation')"), [])
    assert.deepEqual(r.read("wx.getPerformance().getEntriesByType('resource')"), [])
  })

  test(`${engine}: public App alias does not mint samples; retained native invocation preserves real result/path`, () => {
    const r = realm(engine)
    r.run(`App({onLaunch:function(options){globalThis.launches=(globalThis.launches||0)+1;
      options.path='mutated'; return 17;}});
      __container_invoke_app('onLaunch',[{path:'public'}]);`)
    assert.deepEqual(r.entries(), [])
    r.run("__container_invoke_app=function(){throw Error('replaced App entry');}")
    assert.equal(JSON.parse(r.transports.batchCall(null, '__container_invoke_app', ['onLaunch', [{ path: 'pages/home' }]])), 17)
    const entries = r.entries()
    assert.equal(entries.length, 1); assert.equal(entries[0].path, 'pages/home')
    assert.equal(Object.hasOwn(entries[0], 'pageId'), false)
    assert.equal(Object.hasOwn(entries[0], 'moduleName'), false)
    assert.equal(r.run('launches'), 2)
  })

  test(`${engine}: retained App invocation preserves standalone lifecycle notification wrapper`, () => {
    const r = realm(engine, {...allowed(),'wx.onAppShow':'partial','wx.offAppShow':'partial'})
    r.run(`globalThis.lifecycleTrace='';App({onShow:function(){lifecycleTrace+='hook;';}});
      wx.onAppShow(function(){lifecycleTrace+='listener;';});
      __container_invoke_app=function(){throw Error('public alias used');};`)
    r.transports.batchCall(null, '__container_invoke_app', ['onShow', [{}]])
    assert.equal(r.run('lifecycleTrace'), 'hook;listener;')
  })

  test(`${engine}: trusted root evaluation preserves error notification and original failure`, () => {
    const r = realm(engine, {...allowed(),'wx.onError':'partial','wx.offError':'partial'})
    r.run("globalThis.reported='';wx.onError(function(message){reported=message;});globalThis.original=Error('trusted failure');")
    r.register('failure', 'throw original;')
    let thrown
    try { r.evaluate('failure') } catch(error) { thrown=error }
    assert.equal(thrown, r.run('original'))
    assert.equal(r.run('reported'), 'trusted failure')
    assert.deepEqual(r.entries(), [])
  })

  test(`${engine}: native liveness retirement fences aliases and queued deliveries without entering JS`, async () => {
    const r = realm(engine)
    r.run('var p=wx.getPerformance(), saved=p.getEntries, calls=0; p.createObserver(function(){calls++;}).observe({type:"script"});')
    r.execute('pending'); r.life.active = false
    assert.throws(() => r.run('saved()'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    r.install(allowed()); await checkpoint()
    assert.equal(r.run('calls'), 0)
    assert.throws(() => r.run('wx.getPerformance()'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
  })

  test(`${engine}: trusted lifecycle retirement is permanent and EntryList cannot reach another owner`, async () => {
    const r = realm(engine), next = realm(engine)
    r.run('var saved; wx.getPerformance().createObserver(function(list){saved=list;}).observe({type:"script"});')
    r.execute('old'); await checkpoint()
    assert.equal(r.transports.dispatchLifecycleNotification('retire', null), true)
    r.install(allowed())
    assert.throws(() => r.run('saved.getEntries()'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    next.execute('new')
    assert.deepEqual(next.entries().flatMap(entry => entry.fileList), ['new.js'])
    assert.throws(() => r.context.saved.getEntries.call(next.context), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
  })

  test(`${engine}: factory withdrawal/regrant fences already detached observer work`, async () => {
    const r = realm(engine)
    r.run('var calls=0; wx.getPerformance().createObserver(function(){calls++;}).observe({type:"script"});')
    r.execute('withdrawn')
    r.install({ ...allowed(), 'wx.getPerformance': 'unsupported' })
    r.execute('while-denied'); r.install(allowed())
    await checkpoint(); assert.equal(r.run('calls'), 0)
    r.execute('new'); await checkpoint(); assert.equal(r.run('calls'), 1)
  })

  test(`${engine}: trusted loader and query path use captured primitives after guest poisoning`, () => {
    const r = realm(engine)
    r.run(`var p=wx.getPerformance(), saved=p.getEntries;
      function poison(){throw Error('guest primitive');}
      globalThis.Function=poison; Function.prototype.apply=poison;
      Array.prototype.includes=poison; Object.create=poison; Object.defineProperty=poison;
      Object.getOwnPropertyDescriptor=poison; JSON.stringify=poison;`)
    r.execute('captured', 'globalThis.capturedExecuted=true;')
    assert.equal(r.run('capturedExecuted'), true)
    assert.equal(r.run('saved()[0].fileList[0]'), 'captured.js')
  })
}
