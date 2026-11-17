import assert from 'node:assert/strict';
import test from 'node:test';
import { projectInspectorState } from './lib/device-dev/inspector-state.mjs';
import { nativeViewMetricsFixture } from './fixtures/device-dev-view-metrics.mjs';

const phase = (completed = true) => ({ completed, monotonicStartNs: '100', monotonicEndNs: '120',
  wallElapsedNs: '20', threadCpuStartNs: '3', threadCpuEndNs: '10', threadCpuElapsedNs: '7' });
function fixture() {
  const metrics = nativeViewMetricsFixture();
  const batch = metrics.frontier.providerStages.lastBatch;
  metrics.frontier.providerStages.lastBatchBreakdown = {
    schemaVersion: 1, engine: batch.engine, modern: batch.modern, operation: batch.operation,
    batchSequence: batch.batchSequence, ownerThreadId: batch.ownerThreadId,
    phases: { contextCall: phase(), jsonStringifyApi: phase(), utf8CopyApi: phase(),
      finalDeadlineCheck: phase(), poisonDrop: null, outputBytes: '28' },
  };
  return metrics;
}
const inspect = metrics => projectInspectorState({ viewExecutionMetrics: metrics }).viewExecutionMetrics;

test('independent detail preserves exact lossless clocks, byte count, and actual batch identity', () => {
  const metrics = fixture();
  assert.deepEqual(inspect(metrics), metrics);
  const detail = metrics.frontier.providerStages.lastBatchBreakdown;
  detail.phases.outputBytes = '18446744073709551615';
  detail.phases.utf8CopyApi.threadCpuStartNs = null;
  detail.phases.utf8CopyApi.threadCpuElapsedNs = null;
  assert.deepEqual(inspect(metrics), metrics);
});

test('failed returns and missing clocks remain distinct from successful zero-cost observations', () => {
  const metrics = fixture();
  const phases = metrics.frontier.providerStages.lastBatchBreakdown.phases;
  phases.jsonStringifyApi = phase(false); phases.utf8CopyApi = null; phases.outputBytes = null;
  phases.contextCall = phase(false);
  phases.finalDeadlineCheck = { completed: true, monotonicStartNs: '0', monotonicEndNs: '0',
    wallElapsedNs: '0', threadCpuStartNs: null, threadCpuEndNs: null, threadCpuElapsedNs: null };
  assert.deepEqual(inspect(metrics), metrics);
  phases.contextCall.monotonicEndNs = '90'; phases.contextCall.wallElapsedNs = null;
  assert.deepEqual(inspect(metrics), metrics);
});

test('legacy, unavailable, and V8 cases do not acquire invented QuickJS costs', () => {
  const metrics = nativeViewMetricsFixture();
  assert.deepEqual(inspect(metrics), metrics);
  metrics.frontier.providerStages.lastBatchBreakdown = null;
  metrics.frontier.providerStages.lastBatch.engine = 'v8';
  assert.deepEqual(inspect(metrics), metrics);
  const modern = fixture();
  modern.frontier.providerStages.lastBatch.modern = true;
  modern.frontier.providerStages.lastBatchBreakdown.modern = true;
  modern.frontier.providerStages.lastBatchBreakdown.phases.jsonStringifyApi = null;
  assert.deepEqual(inspect(modern), modern);
});

test('closed detail rejects unreviewed descendants, malformed clocks, and unsupported schemas', () => {
  const bad = [
    detail => { detail.rawOutput = 'secret'; },
    detail => { detail.phases.source = 'secret'; },
    detail => { detail.phases.contextCall.privatePath = '/private'; },
    detail => { delete detail.phases.poisonDrop; },
    detail => { detail.schemaVersion = 2; },
    detail => { detail.engine = 'v8'; },
    detail => { detail.phases.outputBytes = 28; },
    detail => { detail.phases.outputBytes = '-1'; },
    detail => { detail.phases.outputBytes = '01'; },
    detail => { detail.phases.outputBytes = '18446744073709551616'; },
    detail => { detail.phases.outputBytes = '0\n'; },
    detail => { detail.phases.utf8CopyApi.completed = 'true'; },
    detail => { detail.phases.utf8CopyApi.threadCpuElapsedNs = '8'; },
    detail => { detail.phases.utf8CopyApi.threadCpuStartNs = null; },
    detail => { detail.phases.utf8CopyApi.monotonicEndNs = '90'; },
  ];
  for (const mutate of bad) {
    const metrics = fixture(); mutate(metrics.frontier.providerStages.lastBatchBreakdown);
    assert.throws(() => inspect(metrics), { code: 'ERR_DEV_INSPECT_DATA' });
  }
});

test('stale/mismatched detail cannot be projected as the current actual owner-thread batch', () => {
  for (const field of ['engine', 'modern', 'operation', 'batchSequence', 'ownerThreadId']) {
    const metrics = fixture();
    const detail = metrics.frontier.providerStages.lastBatchBreakdown;
    detail[field] = { engine: 'v8', modern: true, operation: detail.operation === 'load' ? 'render' : 'load', batchSequence: '99', ownerThreadId: '99' }[field];
    assert.throws(() => inspect(metrics), { code: 'ERR_DEV_INSPECT_DATA' }, field);
  }
  const missing = fixture(); delete missing.frontier.providerStages.lastBatch;
  assert.throws(() => inspect(missing), { code: 'ERR_DEV_INSPECT_DATA' });
});
