/** Controlled clocks/protocol facts only. No browser/compositor/GPU evidence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { AppliedInputTrace, InputCausalLedger, UncorrelatedInputLedger } from '../examples/hosts/web-wasm/input-causal-ledger.mjs'

const owner = { workerEpoch: 'epoch', sessionId: 'session', packSha256: 'a'.repeat(64), transportBackend: 'external-frame' }
const viewport = { x: 0, y: 0, width: 375, height: 667 }
const state = (revision = '1', changes = {}) => ({ currentPage: { pageId: '1', path: 'pages/home/index' },
  templateRevision: revision, surfaceGeneration: '1', inputLifetimeRevision: '1', viewport, ...changes })
const consumed = revision => ({ pageId: '1', routePath: 'pages/home/index', templateRevision: revision, viewport })
const proof = (revision = '2', changes = {}) => ({ version: '1.0', owner, attemptId: revision, surfaceGeneration: '1',
  publication: { kind: 'external-frame', renderRevision: revision }, consumedInput: consumed(revision), ...changes })
function fixture(options = {}) {
  let now = 0, workerNow = 1e6
  const ledger = new InputCausalLedger({ owner, clock: () => now, timeOrigin: 100, ...options })
  const applied = new AppliedInputTrace({ sessionId: owner.sessionId, clock: () => workerNow })
  return { ledger, applied, at: value => { now = value }, workerAt: value => { workerNow = value },
    input(type = 'pointerup', revision = '1', extra = {}) { return ledger.capture({ state: state(revision), type, nativeTimeStamp: now - 1, isTrusted: true, ...extra }) },
    apply(sampleIds, before = '1', after = '2', extra = {}) {
      const receipt = applied.applied({ sampleIds, requestId: `rpc-${after}`, innerRequestId: `bridge-${after}`, before: state(before), after: state(after), ok: true, ...extra })
      ledger.applied(receipt); return receipt
    }, clone(revision = '2', changes = {}) {
      const p = proof(revision, changes), receipt = applied.clone(p.consumedInput)
      ledger.frame('clone', { proof: p, inputTiming: receipt, physicalSize: { width: 750, height: 1334 } })
      return { proof: p, inputTiming: receipt }
    } }
}

test('continuous inputs retain distinct clocks and only exact changed data revision becomes a candidate', () => {
  const f = fixture(); f.at(10); const first = f.input(); f.ledger.queued([first]); f.at(15); f.apply([first], '1', '2')
  f.at(20); const second = f.input(); f.ledger.queued([second]); f.at(25); f.apply([second], '2', '3')
  f.at(30); const frame = f.clone('3'); f.at(32); f.ledger.frame('submitted', frame)
  f.at(33); f.ledger.frame('visible-swap', frame); f.at(40); f.ledger.frame('runtime-ack', frame)
  const report = f.ledger.snapshot()
  assert.deepEqual(report.frames[0].samples, [{ sampleId: first, association: 'ordered-only' }, { sampleId: second, association: 'exact-data-revision' }])
  assert.equal(report.samples.length, 2); assert.equal(report.samples[0].capturedAt, 10); assert.equal(report.samples[1].capturedAt, 20)
  assert.deepEqual(report.candidates[0].durationsMs, { 'applied-received': 5, 'clone-received': 10, submitted: 12, 'visible-swap': 13, 'runtime-ack-received': 20 })
  assert.equal(report.gate.status, 'blocked'); assert.equal(report.gate.inputToPresentP95Ms, null)
  assert.equal(report.candidates[0].visualChange, 'unproven')
  assert.equal(Object.isFrozen(report.samples[0]), true)
})

test('a later unrelated timer revision and no-op input cannot fabricate a causal frame', () => {
  for (const [before, after, revision] of [['1', '2', '3'], ['1', '1', '1']]) {
    const f = fixture(), sample = f.input(); f.apply([sample], before, after); f.clone(revision)
    assert.equal(f.ledger.snapshot().frames[0].samples[0].association, 'ordered-only')
    assert.deepEqual(f.ledger.snapshot().candidates, [])
  }
})

test('page, viewport or surface generation transitions never cross-associate an input', () => {
  for (const changes of [{ surfaceGeneration: '2' }, { consumedInput: { ...consumed('2'), pageId: '2' } },
    { consumedInput: { ...consumed('2'), viewport: { ...viewport, width: 400 } } }]) {
    const f = fixture(), sample = f.input(); f.apply([sample]); f.clone('2', changes)
    assert.deepEqual(f.ledger.snapshot().candidates, [])
  }
})

test('missing before revision and native lifetime transitions remain ordered-only despite a matching final revision',()=>{
  for(const before of [state(null),state('1',{surfaceGeneration:'0'}),state('1',{inputLifetimeRevision:'0'}),
    state('1',{currentPage:{pageId:'2',path:'pages/other'}})]) {
    const f=fixture(),sample=f.input()
    f.apply([sample],'1','2',{before});const frame=f.clone()
    assert.equal(frame.inputTiming.applied[0].association,'ordered-only')
    assert.deepEqual(f.ledger.snapshot().candidates,[])
  }
})

test('negative clocks and oversized physical targets are explicit incomplete diagnostics',()=>{
  const f=fixture();f.at(-1);const sample=f.input();f.at(1);f.apply([sample]);f.at(2)
  const p=proof(),receipt=f.applied.clone(p.consumedInput)
  f.ledger.frame('clone',{proof:p,inputTiming:receipt,physicalSize:{width:4096,height:4096}})
  const report=f.ledger.snapshot()
  assert.equal(report.counts.clockFaults,1);assert.equal(report.frames[0].physicalSize,null)
  assert.equal(report.frames[0].complete,false);assert.deepEqual(report.candidates,[])
})

test('Worker timestamps remain an independent domain and are never subtracted from Window time', () => {
  const f = fixture(); f.at(5); const sample = f.input(); f.at(8); f.apply([sample]); f.at(10); f.clone()
  const report = f.ledger.snapshot()
  assert.equal(report.samples[0].applied.workerAt, 1e6)
  assert.equal(report.samples[0].applied.clockDomain, 'worker-monotonic')
  assert.equal(report.candidates[0].durationsMs['clone-received'], 5)
  assert.equal(report.samples[0].nativeClockDomain, 'dom-event-unmapped')
})

test('regressed or unavailable monotonic clocks expose faults and suppress candidate durations', () => {
  const f = fixture(); f.at(10); const sample = f.input(); f.at(8); f.apply([sample]); f.at(12); f.clone()
  assert.equal(f.ledger.snapshot().counts.clockFaults, 1)
  assert.deepEqual(f.ledger.snapshot().candidates[0].durationsMs, {})
  f.at(NaN); f.ledger.queued([sample])
  assert.ok(f.ledger.snapshot().counts.clockFaults > 1)
})

test('late applied facts cannot revive a discarded input or retired owner', () => {
  const f = fixture(), sample = f.input(); f.ledger.drop([sample], 'input-reset'); f.apply([sample]); f.clone()
  assert.equal(f.ledger.snapshot().samples[0].status, 'discarded'); assert.ok(f.ledger.snapshot().counts.late > 0)
  assert.deepEqual(f.ledger.snapshot().candidates, [])
  f.ledger.retire(); const before = f.ledger.snapshot().counts.captured
  assert.equal(f.input(), null); assert.equal(f.ledger.snapshot().counts.captured, before)
})

test('clone and stage identities are exact and missing/duplicate/out-of-order observations remain explicit', () => {
  const f = fixture(), sample = f.input(); f.apply([sample]); const frame = f.clone()
  assert.equal(f.ledger.frame('runtime-ack', frame), null)
  assert.equal(f.ledger.frame('submitted', { ...frame, proof: { ...frame.proof, owner: { ...owner, sessionId: 'other' } } }), null)
  f.ledger.frame('submitted', frame); assert.equal(f.ledger.frame('submitted', frame), null)
  assert.equal(f.ledger.snapshot().counts.invalid, 3)
  assert.equal(f.ledger.snapshot().frames[0].runtimeAckReceivedAt, null)
})

test('diagnostic DTOs do not retain business payloads or invented clone metadata', () => {
  const f = fixture(), sample = f.input('pointerup', '1', { detail: { secret: 'not-recorded' }, state: { ...state(), data: { secret: 'not-recorded' } } })
  const receipt = f.apply([sample])
  assert.equal(f.ledger.applied({ ...receipt, payload: { secret: 'not-recorded' } }), null)
  const frame = f.clone()
  assert.equal(f.ledger.frame('clone', { ...frame, proof: { ...frame.proof, attemptId: '3', payload: 'not-recorded' } }), null)
  assert.equal(JSON.stringify(f.ledger.snapshot()).includes('not-recorded'), false)
})

test('sample, frame and event evictions are bounded and counted rather than overwritten invisibly', () => {
  const f = fixture({ maxSamples: 2, maxFrames: 1, maxEvents: 3 })
  for (let index = 1; index <= 4; index++) { const sample = f.input(); f.apply([sample], String(index), String(index + 1)); f.clone(String(index + 1)) }
  const report = f.ledger.snapshot()
  assert.equal(report.samples.length, 2); assert.equal(report.frames.length, 1); assert.equal(report.events.length, 3)
  assert.equal(report.counts.evictedSamples, 2); assert.equal(report.counts.evictedFrames, 3); assert.ok(report.counts.evictedEvents > 0)
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 8 * 1024 * 1024)
})

test('Worker applied trace has a fixed budget and reports omitted batches in the original clone', () => {
  const f = fixture()
  for (let index = 1; index <= 40; index++) f.applied.applied({ sampleIds: [String(index)], requestId: `rpc-${index}`,
    innerRequestId: `bridge-${index}`, before: state(String(index)), after: state(String(index + 1)), ok: true })
  const receipt = f.applied.clone(consumed('41'))
  assert.equal(receipt.applied.length, 32); assert.equal(receipt.droppedAppliedBatches, 8)
  assert.equal(receipt.capturedThrough, '40'); assert.equal(Object.isFrozen(receipt.applied), true)
})

test('remote input batches stay independent and never acquire a later frame or a present metric', () => {
  let now = 1
  const ledger = new UncorrelatedInputLedger({ scope: 'remote-dom', clock: () => now })
  const first = ledger.capture({ binding: { sessionId: 'one', previewEpoch: '2', payload: 'secret' } }); now = 2
  const second = ledger.capture({ binding: { sessionId: 'two', previewEpoch: '3' } }); now = 5
  ledger.complete([first], { requestId: 'inner-1' }); now = 8; ledger.complete([second], { outcome: 'protocol-error', requestId: 'inner-2' })
  const report = ledger.snapshot()
  assert.deepEqual(report.records.map(value => [value.sampleId, value.capturedAt, value.completedAt, value.outcome]), [[first, 1, 5, 'protocol-completed'], [second, 2, 8, 'protocol-error']])
  assert.equal(report.association, 'unavailable'); assert.equal(report.gate.status, 'blocked')
  assert.equal(JSON.stringify(report).includes('secret'), false); assert.equal(Object.hasOwn(report.records[0], 'presentedAt'), false)
})

test('remote eviction, retirement and late completion stay visible', () => {
  const ledger = new UncorrelatedInputLedger({ scope: 'remote-raster', clock: () => 1 })
  for (let index = 0; index < 520; index++) ledger.capture({ binding: { sessionId: 'same' } })
  ledger.retire(); ledger.complete(['520'])
  const report = ledger.snapshot()
  assert.equal(report.records.length, 512); assert.equal(report.counts.evicted, 8); assert.equal(report.counts.late, 1)
  assert.equal(report.records.at(-1).outcome, 'owner-retired')
})


test('missing or budget-omitted diagnostics produce bounded omission facts and no causal candidates', () => {
  const f = fixture({ maxEvents: 2 }), sample = f.input(); f.ledger.queued([sample])
  f.ledger.applied(undefined)
  f.ledger.applied({ version: '1.0', omitted: 'payload-budget' }, { late: true })
  f.ledger.frame('clone', { proof: proof(), inputTiming: { version: '1.0', omitted: 'diagnostic-budget' },
    physicalSize: { width: 750, height: 1334 } })
  for (let index = 0; index < 10; index++) f.ledger.omitted('applied', 'untrusted-' + 'x'.repeat(1000))
  const report = f.ledger.snapshot()
  assert.equal(report.counts.omittedDiagnostics, 13)
  assert.equal(report.counts.late, 1)
  assert.equal(report.events.length, 2)
  assert.equal(report.frames[0].complete, false)
  assert.deepEqual(report.candidates, [])
  assert.equal(report.gate.inputToPresentP95Ms, null)
  assert.equal(JSON.stringify(report).includes('untrusted-'), false)
  assert.ok(report.events.every(value => value.kind === 'diagnostic-omitted' && value.reason === 'unknown'))
})
