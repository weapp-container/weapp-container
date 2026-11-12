import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture,method,directResult,staticInputs } from './issue941-test-fixture.mjs'
import { assertIssue941MethodResults } from './issue941-source-assertions.mjs'
import { assertIssue941Outputs } from '../../examples/hosts/conformance-desktop/issue941-static.mjs'
import { issue941ActionTape } from '../../examples/hosts/conformance-desktop/issue941-replay.mjs'
const done=async f=>{await f.start();const options={timeout:8000},value=await f.page.callMethodWithOptions('_runE2E',options);f.checkpoint('executed');f.collector.flush();return{options,value}}
test('exact original receiver/options/result identity and four complete source events survive observation',async()=>{
 const f=fixture(),{options,value}=await done(f);assert.equal(value,f.result);assert.equal(f.calls[0].receiver,f.page);assert.equal(f.calls[0].options,options);assert.deepEqual(f.calls[0].args,[])
 assert.deepEqual(f.events.map(event=>event.op),['route.active','dom.checkpoint','method.call','dom.checkpoint']);assert.deepEqual(f.events[2].payload.callOptions,{timeout:8000})
 const original=f.page.callMethodWithOptions;assert.equal(await original.call(f.page,'_runE2E',options),f.result)
})
test('original nested provider implementation consumes one source action without an extra observer invocation',async()=>{const f=fixture({nested:true});await done(f);assert.deepEqual(f.calls.map(call=>call.op),['callMethodWithOptions','callMethod']);assert.equal(f.events.filter(event=>event.op==='method.call').length,1)})
test('wrong/missing/extra options or guest arguments preserve actual value but fail observation closed',async()=>{
 for(const [options,args] of [[{timeout:7999},[]],[undefined,[]],[{timeout:8000,extra:true},[]],[{timeout:8000},['unexpected']]]){
  const f=fixture();await f.start();assert.equal(await f.page.callMethodWithOptions('_runE2E',options,...args),f.result);assert.throws(()=>f.collector.flush(),/successful method|incomplete/)
 }
})
test('plain callMethod cannot replace original options surface and provider rejection keeps exact thrown identity',async()=>{
 const f=fixture();await f.start();assert.equal(await f.page.callMethod('_runE2E'),f.result);assert.throws(()=>f.collector.flush(),/successful method|incomplete/)
 for(const thrown of [undefined,null,'opaque',{},Symbol('opaque')]){const bad=fixture({onMethod:async()=>{throw thrown}});await bad.start();await assert.rejects(bad.page.callMethodWithOptions('_runE2E',{timeout:8000}),error=>error===thrown);assert.throws(()=>bad.collector.flush(),/incomplete/)}
})
test('a late terminal preserves original returned object and rejects evidence across its original timeout',async()=>{let f;f=fixture({onMethod:async()=>{f.setClock(9001);return f.result}});await f.start();assert.equal(await f.page.callMethodWithOptions('_runE2E',{timeout:8000}),f.result);assert.throws(()=>f.collector.flush(),/original source timeout/)})
test('source tape has exact call options and no oracle return data; changed options fail before replay',async()=>{
 const f=fixture();await done(f);const tape=issue941ActionTape(f.trace()),call=tape.find(step=>step.op==='method.call');assert.deepEqual(call.callOptions,{timeout:8000});assert.deepEqual(call.args,[]);assert.ok(!JSON.stringify(tape).includes('resultMethods'))
 for(const mutate of [value=>value.events[2].payload.callOptions.timeout=1,value=>delete value.events[2].payload.callOptions,value=>value.events[2].payload.callOptions.extra=true]){const trace=structuredClone(f.trace());mutate(trace);assert.throws(()=>issue941ActionTape(trace),/Source-plan/)}
})
test('all five original return assertions and three generated existence checks use actual results',()=>{
 const result=directResult(),results=value=>[{route:'pages/issue-941/index',method:'_runE2E',sourceCallsite:method.sourceCallsite,value}];assert.equal(assertIssue941MethodResults(results(result)).originalExpectations,5);assert.equal(assertIssue941Outputs(staticInputs(),{methodResults:results(result)}).originalExistenceExpectations,3)
 for(const mutate of [value=>value.resultMethods.pop(),value=>value.resultMethods[0].sameIdentity=false,value=>value.resultMethods[13].isPromise=true,value=>value.voidMethods.pop(),value=>value.voidMethods[0].isUndefined=false,value=>value.voidMethods[6].isPromise=true,value=>value.cacheManagerOptions.push('extra')]){const actual=directResult();mutate(actual);assert.throws(()=>assertIssue941MethodResults(results(actual)),/Issue941/)}
 const input=staticInputs();input.files.pop();assert.throws(()=>assertIssue941Outputs(input,{methodResults:results(result)}),/compiled file/)
})

test('cross-realm literal options and provider mutation preserve the originally received timeout snapshot',async()=>{
 const {runInNewContext}=await import('node:vm');let f;const options=runInNewContext('({timeout:8000})');f=fixture({onMethod:async value=>{assert.equal(value.options,options);value.options.timeout=1;return f.result}});await f.start();assert.equal(await f.page.callMethodWithOptions('_runE2E',options),f.result);f.checkpoint('executed');f.collector.flush();assert.equal(options.timeout,1);assert.deepEqual(f.events[2].payload.callOptions,{timeout:8000})
})
