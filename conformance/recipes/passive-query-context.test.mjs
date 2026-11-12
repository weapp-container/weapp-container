import assert from 'node:assert/strict'
import test from 'node:test'
import { createPassiveQueryContext } from './passive-query-context.mjs'

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return {promise,resolve} }

test('async provider lineage suppresses only its descendants while concurrent external calls have separate roots', async () => {
  const c=createPassiveQueryContext(), gate=deferred(), entered=deferred()
  const first=c.run(async()=>{ assert.equal(c.internal(),true);entered.resolve();await gate.promise;return c.run(()=>17,{operation:'nested'}) },{operation:'first'})
  await entered.promise
  assert.equal(c.internal(),false)
  assert.equal(await c.run(()=>23,{operation:'second'}),23)
  gate.resolve();assert.equal(await first,17);assert.equal(c.internal(),false)
  const begin=c.snapshot().events.filter(e=>e.phase==='begin')
  assert.equal(begin[0].internal,false);assert.equal(begin[1].internal,false);assert.equal(begin[2].internal,true)
  assert.notEqual(begin[0].root,begin[1].root);assert.equal(begin[0].root,begin[2].root)
})

test('a callback retained by a settled operation cannot suppress a later external acquisition', async () => {
  const c=createPassiveQueryContext(), gate=deferred();let pending
  await c.run(()=>{pending=gate.promise.then(()=>{assert.equal(c.internal(),false);return c.run(()=>31,{operation:'late'})})},{operation:'settled'})
  gate.resolve();assert.equal(await pending,31)
  const begin=c.snapshot().events.filter(e=>e.phase==='begin')
  assert.equal(begin[1].internal,false);assert.notEqual(begin[0].root,begin[1].root)
})

test('exact return and thrown identities survive observation, with no error or metadata accessor reads', async () => {
  const c=createPassiveQueryContext();let reads=0
  const result={pageId:7,id:'actual-node'};Object.defineProperty(result,'nodeId',{get(){reads++;throw 0}})
  const error=new Proxy({}, {get(_target,key){if(key==='then')return undefined;reads++;throw 0},getOwnPropertyDescriptor(){reads++;throw 0}})
  const options={fallback:false};Object.defineProperty(options,'timeout',{get(){reads++;throw 0}})
  assert.equal(await c.run(()=>result,{operation:'query',options}),result)
  await assert.rejects(c.run(()=>{throw error},{operation:'throw'}),value=>value===error)
  assert.equal(await c.run(()=>error,{operation:'opaque'}),error)
  assert.equal(reads,0)
  const events=c.snapshot().events
  assert.deepEqual(events[0].options,{fallback:false});assert.deepEqual(events[1].result.fields,{id:'actual-node',pageId:7})
  assert.equal(events[3].errorType,'object');assert.equal(events[5].result.opaque,true)
})

test('diagnostic storage is bounded and declares clipped strings, scopes and dropped records', async () => {
  const c=createPassiveQueryContext(),element={id:'node',pageId:7}
  for(let i=0;i<150;i++) await c.run(()=>[element],{operation:'query',selector:'x'.repeat(300),scope:Array(20).fill('scope')})
  const snapshot=c.snapshot();assert.equal(snapshot.events.length,256);assert.equal(snapshot.dropped,44)
  assert.equal(snapshot.clippedStrings,150);assert.equal(snapshot.clippedScopes,150)
  assert.equal(snapshot.events[0].selector.length,256);assert.equal(snapshot.events[0].scope.length,16)
  assert.equal(snapshot.events[1].result.elements[0].fields.id,'node')
  snapshot.events[0].selector='mutated';assert.equal(c.snapshot().events[0].selector.length,256)
})

test('closing the collector context releases its async hook and preserves a pending provider result',async()=>{
 const c=createPassiveQueryContext(),gate=deferred(),entered=deferred()
 const pending=c.run(async()=>{entered.resolve();await gate.promise;assert.equal(c.internal(),false);return 41})
 await entered.promise;c.close();c.close();gate.resolve();assert.equal(await pending,41)
 const before=c.snapshot().events.length;assert.equal(await c.run(()=>43),43)
 assert.equal(c.snapshot().events.length,before);assert.equal(c.snapshot().closed,true)
})
