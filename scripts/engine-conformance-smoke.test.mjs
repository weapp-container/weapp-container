import test from 'node:test'
import assert from 'node:assert/strict'
import { compareEngineTraces, normalizeEngineTrace } from './engine-conformance-compare.mjs'

test('engine trace comparison ignores only retention byte accounting and engine metadata', () => {
  const quickjs = {
    engine: 'quickjs',
    traceSummary: { retainedBytes: 16370, totalRecords: 2 },
    records: [{ source: 'quickjs', request: { id: 'one' }, response: { ok: true } }],
  }
  const v8 = {
    engine: 'v8',
    traceSummary: { retainedBytes: 16360, totalRecords: 2 },
    records: [{ source: 'v8', request: { id: 'one' }, response: { ok: true } }],
  }

  assert.deepEqual(compareEngineTraces(quickjs, v8), {
    status: 'passed',
    reason: 'normalized bridge traces match',
  })
  assert.deepEqual(normalizeEngineTrace(quickjs).traceSummary, { totalRecords: 2 })
})

test('engine trace comparison still fails on protocol differences', () => {
  const base = { traceSummary: { retainedBytes: 10 }, records: [{ requestId: 'one', payload: { ok: true } }] }
  const changed = { traceSummary: { retainedBytes: 20 }, records: [{ requestId: 'one', payload: { ok: false } }] }

  assert.deepEqual(compareEngineTraces(base, changed), {
    status: 'failed',
    reason: 'normalized bridge traces differ',
  })
})
