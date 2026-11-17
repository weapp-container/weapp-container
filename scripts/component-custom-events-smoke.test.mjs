import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectEmission, inspectSummary } from './component-custom-events-smoke.mjs'

function emission() {
  return { returnedUndefined: true, circular: true, callable: true, handledBeforeReturn: true,
    records: [{ label: 'before' }, { label: 'direct', sameDetail: true, circular: true, callable: true, value: 7 }, { label: 'after' }] }
}

test('custom-event evidence requires synchronous handlers and actual non-JSON detail identity', () => {
  inspectEmission(emission(), ['direct'], 'fixture')
  const delayed = emission()
  delayed.records = [delayed.records[0], delayed.records[2], delayed.records[1]]
  assert.throws(() => inspectEmission(delayed, ['direct'], 'delayed'), /same-turn handler order/)
  for (const key of ['sameDetail', 'circular', 'callable']) {
    const cloned = emission()
    cloned.records[1][key] = false
    assert.throws(() => inspectEmission(cloned, ['direct'], key))
  }
  assert.throws(() => inspectEmission({ ...emission(), handledBeforeReturn: false }, ['direct'], 'deferred'), /before return/)
  assert.throws(() => inspectEmission({ ...emission(), returnedUndefined: false }, ['direct'], 'fake-result'), /returns undefined/)
  assert.throws(() => inspectSummary({ launched: true, capability: false }), /negotiate/)
})

test('an unbound hyphen event must have no handler or mutation before return', () => {
  const unbound = { ...emission(), handledBeforeReturn: false, records: [{ label: 'before' }, { label: 'after' }] }
  inspectEmission(unbound, [], 'unbound')
  assert.throws(() => inspectEmission(emission(), [], 'illegal-hyphen-listener'), /handler order/)
  assert.throws(() => inspectEmission({ ...unbound, handledBeforeReturn: true }, [], 'hidden-handler'), /before return/)
})
