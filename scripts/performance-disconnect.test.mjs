import test from 'node:test'
import assert from 'node:assert/strict'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

// These are Node VM executions of the exact production source arrays selected
// by each engine bootstrap. They do not execute QuickJS, V8 or any host pump.
function realm(engine) {
  let tick = 0
  const result = createAppServiceTestRealm(engine, { __container_host_performance_now: () => ++tick, __performance_emit: file => emit(result, file) })
  result.transports.installHostEnvironment({ kind: 'capabilities', capabilities: { 'wx.getPerformance': 'partial', ...Object.fromEntries(['Performance','EntryList'].flatMap(type => ['getEntries','getEntriesByName','getEntriesByType'].map(method => [`object:${type}.${method}`, 'partial']))) } })
  result.run('var performanceUnderTest = wx.getPerformance(); var calls = [];')
  return result
}
const emit = (r, file = 'one') => r.transports.installHostEnvironment({kind:'module-command',operation:'eager',id:`module:${file}.js`,number:r.nextModule=(r.nextModule||0)+1,source:'exports.executed=true;'})
async function checkpoint() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

for (const engine of ['quickjs', 'v8']) {
  test(`${engine} bootstrap: disconnect returns undefined synchronously before and after observation`, async () => {
    const r = realm(engine)
    assert.equal(r.run(`
      var observer = performanceUnderTest.createObserver(function() { calls[calls.length] = 'callback'; });
      observer.disconnect() === undefined && observer.disconnect() === undefined
    `), true)
    r.run('observer.observe({type:"script"})')
    emit(r)
    assert.equal(r.run('observer.disconnect() === undefined && calls.length === 0'), true)
    await checkpoint()
    assert.deepEqual(r.json('calls'), [])
    emit(r, 'later')
    await checkpoint()
    assert.deepEqual(r.json('calls'), [])
  })

  test(`${engine} bootstrap: a callback can stop its own future subscription`, async () => {
    const r = realm(engine)
    r.run(`var observer = performanceUnderTest.createObserver(function(list) {
      calls[calls.length] = list.getEntries()[0].fileList[0];
      if (observer.disconnect() !== undefined) throw Error('disconnect must return void');
    }); observer.observe({type:'script'});`)
    emit(r)
    await checkpoint()
    emit(r, 'later')
    await checkpoint()
    assert.deepEqual(r.json('calls'), ['one.js'])
  })

  test(`${engine} bootstrap: synchronous disconnect fences an already detached neighbour batch`, async () => {
    const r = realm(engine)
    r.run(`
      var first = performanceUnderTest.createObserver(function() { calls[calls.length]='first'; second.disconnect(); });
      var second = performanceUnderTest.createObserver(function() { calls[calls.length]='second'; });
      var third = performanceUnderTest.createObserver(function() { calls[calls.length]='third'; });
      first.observe({type:'script'}); second.observe({type:'script'}); third.observe({type:'script'});
    `)
    emit(r)
    await checkpoint()
    assert.deepEqual(r.json('calls'), ['first', 'third'])
  })

  test(`${engine} bootstrap: reobservation invalidates detached old batches and delivers new work once`, async () => {
    const r = realm(engine)
    r.run(`
      function record(label,list) { calls[calls.length] = label+':'+list.getEntries()[0].fileList[0]; }
      var first = performanceUnderTest.createObserver(function(list) {
        record('first',list); first.disconnect(); second.disconnect(); second.observe({type:'script'});
        __performance_emit('new');
      });
      var second = performanceUnderTest.createObserver(function(list) { record('second',list); });
      var third = performanceUnderTest.createObserver(function(list) { record('third',list); });
      first.observe({type:'script'}); second.observe({type:'script'}); third.observe({type:'script'});
    `)
    emit(r)
    await checkpoint()
    // Reobserving moves second behind the still-active third subscription.
    assert.deepEqual(r.json('calls'), ['first:one.js', 'third:one.js', 'third:new.js', 'second:new.js'])
  })

  test(`${engine} bootstrap: borrowed functions retain the original private receiver authority`, async () => {
    const r = realm(engine)
    r.run(`
      var first = performanceUnderTest.createObserver(function() { calls[calls.length]='first'; });
      var second = performanceUnderTest.createObserver(function() { calls[calls.length]='second'; });
      first.observe({type:'script'}); second.observe({type:'script'});
      var disconnect = first.disconnect;
      first.disconnect = function() { throw Error('public replacement'); };
      first.record = second; first.active = true; first.pending = ['forged']; first.generation = -1;
      var forged = {record:second,active:true,pending:[],generation:0};
      var borrowedResult = disconnect.call(second);
      var forgedResult = disconnect.call(forged);
    `)
    assert.equal(r.run('borrowedResult === undefined && forgedResult === undefined'), true)
    emit(r)
    await checkpoint()
    assert.deepEqual(r.json('calls'), ['second'])
  })

  test(`${engine} bootstrap: cleanup still releases all observer capacity after capability revocation`, async () => {
    const r = realm(engine)
    r.run(`
      var observers = [];
      for (var index=0; index<256; index++) {
        var observer = performanceUnderTest.createObserver(function(){calls[calls.length]='unexpected';});
        observer.observe({type:'script'}); observers[index]=observer;
      }
      var overflow = performanceUnderTest.createObserver(function(){});
      var exhausted=false; try { overflow.observe({type:'script'}); } catch (error) { exhausted=error instanceof RangeError; }
    `)
    assert.equal(r.run('exhausted'), true)
    emit(r)
    r.transports.installHostEnvironment({ kind: 'capabilities', capabilities: { 'wx.getPerformance': 'unsupported' } })
    assert.equal(r.run(`
      var allVoid=true;
      for (var index=0; index<256; index++) allVoid = observers[index].disconnect() === undefined && allVoid;
      allVoid
    `), true)
    await checkpoint()
    assert.deepEqual(r.json('calls'), [])
    r.transports.installHostEnvironment({ kind: 'capabilities', capabilities: { 'wx.getPerformance': 'partial', ...Object.fromEntries(['Performance','EntryList'].flatMap(type => ['getEntries','getEntriesByName','getEntriesByType'].map(method => [`object:${type}.${method}`, 'partial']))) } })
    assert.equal(r.run(`
      for (var index=0; index<256; index++) observers[index].observe({type:'script'});
      var exhaustedAgain=false; try { overflow.observe({type:'script'}); } catch (error) { exhaustedAgain=error instanceof RangeError; }
      for (var index=0; index<256; index++) observers[index].disconnect();
      exhaustedAgain && overflow.observe({type:'script'}) === undefined && overflow.disconnect() === undefined
    `), true)
  })

  test(`${engine} bootstrap: callback failure preserves other deliveries and subsequent cleanup`, async () => {
    const r = realm(engine)
    r.run(`
      var failing = performanceUnderTest.createObserver(function(){ failing.disconnect(); throw Error('guest failure'); });
      var remaining = performanceUnderTest.createObserver(function(){ calls[calls.length]='remaining'; });
      failing.observe({type:'script'}); remaining.observe({type:'script'});
    `)
    emit(r)
    await checkpoint()
    emit(r, 'two')
    await checkpoint()
    assert.deepEqual(r.json('calls'), ['remaining', 'remaining'])
    assert.equal(r.run('remaining.disconnect() === undefined'), true)
  })

  test(`${engine} bootstrap: queued cleanup uses captured primitives after guest intrinsic poisoning`, async () => {
    const r = realm(engine)
    r.run(`
      var poisonCalls=0, remainingCalls=0;
      var first=performanceUnderTest.createObserver(function(){remainingCalls=-100;});
      var second=performanceUnderTest.createObserver(function(){remainingCalls++;});
      first.observe({type:'script'}); second.observe({type:'script'});
      var disconnect=first.disconnect;
    `)
    emit(r)
    assert.equal(r.run(`
      function poison(){poisonCalls++;throw Error('guest intrinsic');}
      Object.create=poison; Object.defineProperty=poison; Object.getOwnPropertyDescriptor=poison;
      Object.setPrototypeOf=poison; Array.isArray=poison; Array.prototype.splice=poison;
      Function.prototype.apply=poison; Function.prototype.call=poison; Promise.prototype.then=poison;
      Promise.resolve=poison; JSON.stringify=poison;
      disconnect() === undefined && remainingCalls === 0 && poisonCalls === 0
    `), true)
    await checkpoint()
    assert.equal(r.run('remainingCalls'), 1)
    assert.equal(r.run('poisonCalls'), 0)
  })

  test(`${engine} bootstrap: a delivered EntryList snapshot survives observer disconnection`, async () => {
    const r = realm(engine)
    r.run(`
      var saved;
      var observer=performanceUnderTest.createObserver(function(list){saved=list;observer.disconnect();});
      observer.observe({type:'script'});
    `)
    emit(r)
    await checkpoint()
    emit(r, 'later')
    await checkpoint()
    assert.deepEqual(r.json('saved.getEntries().map(function(entry){return entry.fileList[0];})'), ['one.js'])
    assert.equal(r.run('observer.disconnect() === undefined'), true)
  })

  test(`${engine} bootstrap: a foreign realm receiver cannot redirect the captured cleanup`, async () => {
    const first = realm(engine), second = realm(engine)
    for (const r of [first, second]) r.run('var observer=performanceUnderTest.createObserver(function(){calls[calls.length]="callback";}); observer.observe({type:"script"});')
    emit(first); emit(second)
    assert.equal(first.context.observer.disconnect.call(second.context.observer), undefined)
    await checkpoint()
    assert.deepEqual(first.json('calls'), [])
    assert.deepEqual(second.json('calls'), ['callback'])
  })
}
