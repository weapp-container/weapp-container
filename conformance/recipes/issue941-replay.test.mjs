/** Synthetic IPC contracts; no real engine or host execution. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture,plan,directResult,staticInputs,checkpointGroups } from './issue941-test-fixture.mjs'
import { descriptor } from './issue941-descriptor.mjs'
import { encodeMethodValue } from './source-method-values.mjs'
import { replayIssue941 } from '../../examples/hosts/conformance-desktop/issue941-replay.mjs'
const startup=engine=>({engine,sessionId:'synthetic941'})
const trace=async()=>{const f=fixture();await f.start();await f.page.callMethodWithOptions('_runE2E',{timeout:8000});f.checkpoint('executed');f.collector.flush();return f.trace()}
function native(engine, { samples = [directResult()], queryCount = 1, mutate } = {}) {
  let stamp = 1000, methodAt = 0, checkpointAt = 0, taps = 0, pump = 0, action = 0, required = 0, revision = 1, pageId = 1, route = 'pages/home/index'
  const calls = []
  const proof = () => ({ kind: 'owner-pump-native-presentation-v1', sessionId: startup(engine).sessionId, route, pageId: String(pageId),
    templateRevision: String(revision), consumedTemplateRevision: String(revision), frameId: String(revision + 10), renderRevision: String(revision),
    presentationAckRevision: String(revision), actionSeq: String(action), ownerPumpSeq: String(pump), requiredPumpSeq: String(required), presented: true })
  const act = () => { action++; required = pump + 1; pump++; revision++ }
  const request = async (op, payload = {}) => {
    calls.push({ op, payload: structuredClone(payload) }); pump++; let result
    if (op === 'render.settle') result = proof()
    else if (op === 'reLaunch') { route = payload.route.startsWith('/') ? payload.route.slice(1) : payload.route; pageId++; act(); result = { path: route, completion: proof() } }
    else if (op === 'currentPage') result = { path: route, pageId: String(pageId), completion: proof() }
    else if (op === 'checkpoint') { const id=checkpointAt++===0?'initial':'executed'; result={id,route,nodes:checkpointGroups(id),completion:proof()} }
    else if (op === 'method.call') {
      const index = methodAt++, item = samples[Math.min(index, samples.length - 1)]; act()
      const observation = item && Object.hasOwn(item, 'throw') ? { kind: 'rejected', ticket: 'unit/' + index,
        reason: item.throw === undefined ? { kind: 'undefined' } : { kind: 'json', value: item.throw } } : { kind: 'fulfilled', ticket: 'unit/' + index, value: encodeMethodValue(item) }
      result = { kind: 'native-guest-method-result-v1', owner: { kind: 'source-labelled-native-method-owner-v1', engine, sessionId: startup(engine).sessionId,
        sourceInvocationId: payload.sourceInvocationId, sourceDeclaration: structuredClone(payload.source), sourceDeclarationTrust: 'caller-declared-not-official-oracle',
        route, pageId: String(pageId), originalDeadlineNs: payload.deadlineNs, deadlineClock: 'original-unix-deadline-plus-once-anchored-monotonic-budget',
        sessionBeginAttempts: 1, sessionPollAttempts: 2, requestSha256: 'a'.repeat(64), receiverTokenSha256: 'b'.repeat(64) }, observation, completion: proof() }
    } else throw new Error('Unplanned synthetic op: ' + op)
    return mutate?.(result, op, payload) ?? result
  }
  return { request, calls, readinessClock: () => stamp, readinessWait: async ms => { stamp += ms } }
}
const replay=(engine,wire,oracleTrace)=>replayIssue941({...wire,startup:startup(engine),oracleTrace,staticInputs:staticInputs()})
test('both synthetic transports preserve complete source trace and original explicit timeout without expected IPC values',async()=>{
 const oracle=await trace()
 for(const engine of ['quickjs','v8']){const wire=native(engine),before=BigInt(Date.now())*1000000n,result=await replay(engine,wire,oracle),after=BigInt(Date.now())*1000000n;assert.deepEqual(result.events,oracle.events);assert.equal(result.staticCoverage.originalMethodExpectations,5);assert.equal(result.methodFacts.length,1)
 const calls=wire.calls.filter(call=>call.op==='method.call');assert.equal(calls.length,1);const payload=calls[0].payload;assert.deepEqual(Object.keys(payload).sort(),['args','deadlineNs','method','route','source','sourceInvocationId']);assert.deepEqual(payload.args,[]);assert.ok(BigInt(payload.deadlineNs)>=before+8000000000n&&BigInt(payload.deadlineNs)<=after+8000000000n);assert.ok(!JSON.stringify(payload).includes('sameIdentity'))}
})
test('options omissions/substitution/extra fields fail before any native operation',async()=>{
 for(const change of [trace=>delete trace.events[2].payload.callOptions,trace=>trace.events[2].payload.callOptions.timeout=5000,trace=>trace.events[2].payload.callOptions.extra=true]){const oracle=await trace();change(oracle);const wire=native('quickjs');await assert.rejects(replay('quickjs',wire,oracle),/Source-plan/);assert.equal(wire.calls.length,0)}
})
test('actual wrong return, rejected result or foreign owner cannot satisfy original source',async()=>{
 const oracle=await trace();for(const patch of [{samples:[{...directResult(),cacheManagerOptions:[]}]},{samples:[{throw:'actual provider rejection'}]},{mutate:(result,op)=>{if(op==='method.call')result.owner.sessionId='foreign';return result}}]){const wire=native('quickjs',patch);await assert.rejects(replay('quickjs',wire,oracle),/Source-plan|Actual native method|same-source/);assert.equal(wire.calls.filter(call=>call.op==='method.call').length,1)}
})
