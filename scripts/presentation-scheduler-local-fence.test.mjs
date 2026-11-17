/** Pure scheduler contracts; authored/unexecuted, no native presentation proof. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { PresentationScheduler } from '../examples/hosts/web-wasm/presentation-scheduler.mjs'
const tick = async () => { for (let index = 0; index < 30; index++) await Promise.resolve() }
const identity = { workerEpoch: 'epoch-fence', sessionId: 'session-fence', packSha256: 'a'.repeat(64), transportBackend: 'external-frame' }
const rect = { x: 0, y: 0, width: 375, height: 667 }
const observed = (sequence, patch = {}) => ({ sequence, state: { owner: identity, currentPage: { pageId: '1', path: 'pages/home' },
  templateRevision: '1', renderRevision: '0', surfaceGeneration: '1', viewport: rect, rendererProfile: 'skia', lifecycle: 'Active', ...patch } })
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function fixture() {
  const rafs = new Map(), calls = [], gates = new Map(); let raf = 0, render = 0
  const adapter = {
    prepareTemplate(demand, context) { calls.push('template'); return prepared(demand, context, demand.templateRevision) },
    preparePaint(demand, accepted, context) { calls.push('paint'); return prepared(demand, context, accepted.proof.consumedInput.templateRevision) },
    async present(candidate, context) {
      calls.push('present'); await gates.get('present')?.promise
      return { acknowledged: true, inputEnabled: true, publication: candidate.proof.publication }
    },
    release(candidate, context) { calls.push({ release: context, publication: candidate.proof.publication }); return { released: true } },
    freezeInput() { calls.push('freeze') }, cancelOwnedWork() {}, dispose() {},
  }
  function prepared(demand, context, revision) {
    render = Math.max(render + 1, Number(demand.renderRevision))
    return { proof: { version: '1.0', owner: identity, attemptId: context.attemptId, surfaceGeneration: demand.surfaceGeneration,
      consumedInput: { pageId: '1', routePath: 'pages/home', templateRevision: revision, viewport: rect },
      publication: { kind: 'external-frame', renderRevision: String(render) } } }
  }
  const scheduler = new PresentationScheduler({ owner: identity, adapter,
    requestFrame(callback) { rafs.set(++raf, callback); return raf }, cancelFrame(handle) { rafs.delete(handle) } })
  const pump = async () => { const frame = rafs.entries().next().value; if (frame) { rafs.delete(frame[0]); frame[1](16) }; await tick() }
  const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await pump() }; assert.fail('scheduler fence wait exhausted') }
  return { scheduler, calls, gates, pump, until }
}
test('local suspension does not fabricate observation and resume cannot restore old accepted input', async () => {
  const f = fixture()
  try {
    f.scheduler.observe(observed('1')); await f.until(() => f.scheduler.status.accepted?.inputEnabled)
    f.scheduler.suspend('metrics')
    assert.equal(f.scheduler.status.accepted, null)
    assert.equal(f.scheduler.status.observationSequence, '1')
    assert.equal(f.scheduler.status.latest.surfaceGeneration, '1')
    assert.equal(f.scheduler.status.suspended, true)
    f.scheduler.resume()
    assert.equal(f.scheduler.status.accepted, null)
    await f.until(() => f.scheduler.status.accepted?.inputEnabled)
    assert.equal(f.calls.filter(value => value === 'template').length, 2)
  } finally { await f.scheduler.close() }
})
test('a true late ACK from a suspended flight is released as committed and retired', async () => {
  const f = fixture(), gate = deferred(); f.gates.set('present', gate)
  try {
    f.scheduler.observe(observed('1')); await f.until(() => f.calls.includes('present'))
    f.scheduler.suspend('metrics'); gate.resolve()
    await f.until(() => !f.scheduler.status.inFlight)
    const release = f.calls.find(value => value?.release)?.release
    assert.equal(release.committed, true)
    assert.equal(release.retired, true)
    assert.equal(f.scheduler.status.accepted, null)
  } finally { gate.resolve(); await f.scheduler.close() }
})
test('physical render revision alone retains paint and never enters the logical metrics suspension path', async () => {
  const f = fixture()
  try {
    f.scheduler.observe(observed('1')); await f.until(() => f.scheduler.status.accepted?.inputEnabled)
    f.scheduler.observe(observed('2', { renderRevision: '2' })); await f.until(() => f.calls.includes('paint') && !f.scheduler.status.inFlight)
    assert.equal(f.calls.filter(value => value === 'template').length, 1)
    assert.equal(f.scheduler.status.suspended, false)
    assert.equal(f.scheduler.status.latest.surfaceGeneration, '1')
  } finally { await f.scheduler.close() }
})
