import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture,tapSteps,pollOptions,poll,staticInputs } from './issue1011-test-fixture.mjs'
import { tapElement } from './issue1011-tap-source.mjs'
import { expectedSnapshot,assertIssue1011DomEvidence,assertIssue1011MethodResult } from './issue1011-source-assertions.mjs'
import { decodeMethodValue } from './source-method-values.mjs'
import { issue1011ActionTape } from '../../examples/hosts/conformance-desktop/issue1011-replay.mjs'
const ready=async options=>{const f=fixture(options);await f.start();return f}
const beforePoll=async options=>{const f=await ready(options);await f.taps();return f}
test('original helper uses five default first acquisitions and preserves all event/wait attempts',async()=>{
 const f=await beforePoll();await f.poll();f.finish()
 assert.equal(f.calls.filter(x=>x.op==='$$').length,0);assert.ok(f.calls.filter(x=>x.op==='$').every(x=>x.args.length===1))
 assert.deepEqual(f.calls.filter(x=>x.op==='tap').map(x=>x.selector),tapSteps.map(x=>x.address.selector))
 const journal=f.collector.diagnostics().tapHelperJournal
 assert.equal(journal.acquisitions.length,5);assert.equal(journal.attempts.length,10)
 assert.deepEqual(journal.attempts.map(x=>x.operation),Array(5).fill(['tap','waitFor']).flat())
 assert.equal(f.events.filter(x=>x.op==='tap.helper.attempt').length,10)
 assert.equal(issue1011ActionTape(f.trace()).filter(x=>x.op==='tap.helper').length,5)
 assertIssue1011DomEvidence(f.events.filter(x=>x.op==='dom.checkpoint').map(x=>x.payload))
 const actual=f.events.find(x=>x.op==='method.poll').payload
 assertIssue1011MethodResult([{route:actual.route,method:actual.method,sourceCallsite:actual.sourceCallsite,value:decodeMethodValue(actual.completion.value)}])
})
for(const success of ['tap','trigger','touchend','dispatchEvent'])test('actual fallback sequence reaches '+success+' only after preceding real errors',async()=>{
 const failures=[],f=await ready({onOperation:({operation})=>{if(operation==='touchstart'&&success==='touchend')return;if(operation!==success){const error={original:operation};failures.push(error);throw error}}})
 await tapElement(f.page,tapSteps[0].address.selector)
 const expected=success==='tap'?['tap']:success==='trigger'?['tap','trigger']:success==='touchend'?['tap','trigger','touchstart','touchend']:['tap','trigger','touchstart','dispatchEvent']
 assert.deepEqual(f.calls.filter(x=>!['$','waitFor'].includes(x.op)).map(x=>x.op),expected)
 const attempts=f.collector.diagnostics().tapHelperJournal.attempts
 assert.deepEqual(attempts.map(x=>x.operation),expected.concat('waitFor'))
 assert.equal(attempts.filter(x=>x.completion.kind==='rejected').length,failures.length)
 assert.equal(f.events.filter(x=>x.op==='tap').length,1)
 assert.throws(()=>f.collector.flush(),/coverage is incomplete/)
})
test('wait failure preserves the successful input effect and runs the next original mode',async()=>{
 let waits=0,effects=0;const error=new Error('actual wait error'),f=await ready({onOperation:()=>{effects++},onWait:()=>{if(waits++===0)throw error}})
 await tapElement(f.page,tapSteps[0].address.selector)
 assert.equal(effects,2);assert.deepEqual(f.collector.diagnostics().tapHelperJournal.attempts.map(x=>[x.operation,x.completion.kind]),[['tap','fulfilled'],['waitFor','rejected'],['trigger','fulfilled'],['waitFor','fulfilled']])
 assert.equal(f.events.filter(x=>x.op==='tap.helper.attempt').length,4)
})
test('touchend failure retains touchstart fulfillment and reaches dispatch without inventing a completed touch',async()=>{
 const f=await ready({onOperation:({operation})=>{if(['tap','trigger','touchend'].includes(operation))throw new Error(operation)}})
 await tapElement(f.page,tapSteps[0].address.selector)
 assert.deepEqual(f.collector.diagnostics().tapHelperJournal.attempts.map(x=>[x.operation,x.completion.kind]),[['tap','rejected'],['trigger','rejected'],['touchstart','fulfilled'],['touchend','rejected'],['dispatchEvent','fulfilled'],['waitFor','fulfilled']])
})
test('exhausted helper returns the last original Error and emits no successful action',async()=>{
 const errors=Object.fromEntries(['tap','trigger','touchstart','dispatchEvent'].map(x=>[x,new Error(x)])),f=await ready({onOperation:({operation})=>{throw errors[operation]}})
 await assert.rejects(tapElement(f.page,tapSteps[0].address.selector),error=>error===errors.dispatchEvent)
 assert.equal(f.events.filter(x=>x.op==='tap').length,0);assert.equal(f.collector.diagnostics().tapHelperJournal.attempts.length,4)
 assert.throws(()=>f.collector.flush(),/coverage is incomplete/)
})
test('default first acquisition adds neither uniqueness nor $$ substitution',async()=>{
 for(const mode of ['options','duplicate','array']){
  const f=await ready();let element
  if(mode==='array')element=(await f.page.$$(tapSteps[0].address.selector))[0]
  else{element=await f.page.$(tapSteps[0].address.selector,...(mode==='options'?[{}]:[]));if(mode==='duplicate')await f.page.$(tapSteps[0].address.selector)}
  await element.tap();await f.page.waitFor(240)
  assert.throws(()=>f.collector.flush(),/query options|acquisition|tap helper/)
 }
})
test('a successful input needs its original successful 240ms wait before advancing',async()=>{
 for(const mode of ['omit','changed','event-after-success']){
  const f=await ready(),element=await f.page.$(tapSteps[0].address.selector);await element.tap()
  if(mode==='changed')await f.page.waitFor(0)
  if(mode==='event-after-success')await element.trigger('tap')
  assert.equal(f.events.filter(x=>x.op==='tap').length,0);assert.throws(()=>f.collector.flush(),/coverage is incomplete|tap helper/)
 }
})
test('pure snapshot poll keeps every rejected and incorrect attempt with exact5000 options',async()=>{
 const original={private:'original method rejection'},f=await beforePoll({onMethod:({at})=>{if(at===0)throw original;return at===1?{objectCaptures:[],tupleCaptures:[]}:structuredClone(expectedSnapshot)}})
 await f.collector.sourcePoll(pollOptions,async()=>{
  await assert.rejects(f.page.callMethodWithOptions('_snapshot',{timeout:5000}),error=>error===original)
  assert.deepEqual(await f.page.callMethodWithOptions('_snapshot',{timeout:5000}),{objectCaptures:[],tupleCaptures:[]})
  assert.deepEqual(await f.page.callMethodWithOptions('_snapshot',{timeout:5000}),expectedSnapshot)
 });f.finish()
 const attempts=f.collector.diagnostics().sourcePollJournal.attempts
 assert.deepEqual(attempts.map(x=>x.completion.kind),['rejected','fulfilled','fulfilled'])
 assert.ok(attempts.every(x=>x.callOptions.timeout===5000&&x.callDeadlineMs===x.startedAtMs+5000))
 assert.equal(f.events.filter(x=>x.op==='method.poll').length,1)
})
test('nested actual callMethod implementation remains one original options-bearing attempt',async()=>{
 const f=await beforePoll({nestedMethod:true});await f.poll();f.finish();assert.equal(f.collector.diagnostics().pollAttempts.length,1)
})
for(const mode of ['plain','options','call-deadline','scope-defaults'])test('poll rejects '+mode+' drift while preserving provider results',async()=>{
 const f=await beforePoll({onMethod:({setClock})=>{if(mode==='call-deadline')setClock(7401);return structuredClone(expectedSnapshot)}})
 await f.collector.sourcePoll({...pollOptions,...(mode==='scope-defaults'?{intervalMs:1}:{})},async()=>{
  const result=mode==='plain'?await f.page.callMethod('_snapshot'):await f.page.callMethodWithOptions('_snapshot',{timeout:mode==='options'?6000:5000})
  assert.deepEqual(result,expectedSnapshot)
 });assert.equal(f.events.filter(x=>x.op==='method.poll').length,0);assert.throws(()=>f.collector.flush(),/poll|deadline/)
})
test('failed input attempts cannot be removed or relabeled in source replay tape',async()=>{
 const f=await beforePoll({onOperation:({operation})=>{if(operation==='tap')throw new Error('actual tap failure')}});await f.poll();f.finish()
 assert.equal(issue1011ActionTape(f.trace()).filter(x=>x.op==='tap.helper').length,5)
 for(const mutate of [events=>events.splice(3,1),events=>events[3].payload.operation='trigger',events=>events[4].payload.attemptOrdinal=0]){
  const trace=structuredClone(f.trace());mutate(trace.events);trace.events.forEach((x,at)=>x.seq=at)
  assert.throws(()=>issue1011ActionTape(trace),/tap helper|sequence|attempt/)
 }
})
test('original source root readiness cannot be omitted, duplicated, reoptioned or moved after initial assertions',async()=>{
 for(const mode of ['omit','options','duplicate']){
  const f=fixture();await f.program.reLaunch('/'+f.page.path)
  if(mode!=='omit')await f.page.waitForRendered({selector:'#issue-1011-page',timeout:mode==='options'?6000:5000})
  if(mode==='duplicate')await f.page.waitForRendered({selector:'#issue-1011-page',timeout:5000})
  assert.throws(()=>f.checkpoint('initial'),/root readiness/)
 }
 const f=await ready();const trace=f.trace();assert.equal(trace.events[0].op,'route.active');assert.equal(trace.events[1].op,'route.root.ready')
})
