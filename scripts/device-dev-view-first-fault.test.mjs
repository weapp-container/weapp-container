import assert from 'node:assert/strict';
import test from 'node:test';
import { projectInspectorState } from './lib/device-dev/inspector-state.mjs';
import { sanitizeInspectorSnapshot } from './device-dev-server.mjs';
import { nativeViewMetricsFixture } from './fixtures/device-dev-view-metrics.mjs';

function fixture(operation = 'render', mode = 'instrumented', engine = 'quickjs') {
  const stages = nativeViewMetricsFixture();
  const metrics = stages[{ prepare: 'preparation', render: 'frontier', release: 'scopeRelease' }[operation]];
  metrics.succeeded = false;
  metrics.providerStages = structuredClone(stages.preparation.providerStages);
  const batch = metrics.providerStages.lastBatch;
  batch.engine = engine;
  batch.operation = { prepare: 'load', render: 'renderRegistered', release: 'releaseScopes' }[operation];
  batch.batchSequence = '9007199254740993';
  batch.errorCode = 'ERR_TIMEOUT';
  if (engine === 'quickjs') metrics.providerStages.lastBatchBreakdown = {
    schemaVersion: 1, engine, modern: false, operation: batch.operation,
    batchSequence: batch.batchSequence, ownerThreadId: batch.ownerThreadId,
    phases: { contextCall: { completed: false, monotonicStartNs: '7', monotonicEndNs: '9', wallElapsedNs: '2',
      threadCpuStartNs: null, threadCpuEndNs: null, threadCpuElapsedNs: null }, jsonStringifyApi: null,
    utf8CopyApi: null, finalDeadlineCheck: null, poisonDrop: null, outputBytes: null },
  };
  if (mode === 'no-provider') metrics.providerStages = null;
  else if (mode === 'uninstrumented') {
    metrics.providerStages.lastBatch = null;
    delete metrics.providerStages.lastBatchBreakdown;
  }
  const details = { schemaVersion: 1, sessionId: 'sdk-review-1', witness: {
    faultSequence: '1', operationSequence: '9007199254740994', monotonicElapsedNs: '18446744073709551615',
    operation, metrics, provider: {
      lastBatch: structuredClone(metrics.providerStages?.lastBatch ?? null),
      lastBatchBreakdown: structuredClone(metrics.providerStages?.lastBatchBreakdown ?? null),
    },
  } };
  return { sessionId: details.sessionId, inputEnabled: false, presentationEnabled: false,
    executionHealth: { schemaVersion: 1, requiresRestart: true, appServiceFault: null, navigationFault: null,
      viewFault: { domain: 'view', code: 'ERR_TIMEOUT', message: 'bounded interruption', requiresRestart: true, details } } };
}
const details = state => state.executionHealth.viewFault.details;
const invalid = state => assert.throws(() => projectInspectorState(state), { code: 'ERR_DEV_INSPECT_DATA' });

test('typed first fault survives all operation variants without borrowing latest metrics', () => {
  for (const operation of ['prepare', 'render', 'release']) for (const engine of ['quickjs', 'v8']) {
    const state = fixture(operation, 'instrumented', engine);
    state.viewExecutionMetrics = nativeViewMetricsFixture();
    const projected = projectInspectorState(state);
    assert.deepEqual(projected, state);
    assert.notEqual(details(projected), details(state));
    details(projected).witness.provider.lastBatch.batchSequence = '9';
    assert.equal(details(state).witness.provider.lastBatch.batchSequence, '9007199254740993');
  }
});

test('absent native observations remain explicit null and relative time is not an absolute native clock', () => {
  for (const operation of ['prepare', 'render', 'release']) for (const mode of ['no-provider', 'uninstrumented']) {
    const state = fixture(operation, mode);
    details(state).witness.monotonicElapsedNs = '0';
    details(state).witness.operationSequence = '18446744073709551615';
    assert.deepEqual(projectInspectorState(state), state);
  }
  const state = fixture();
  // Host receipt validation/cancellation may poison after a successful batch.
  for (const batch of [details(state).witness.provider.lastBatch, details(state).witness.metrics.providerStages.lastBatch]) batch.errorCode = null;
  assert.deepEqual(projectInspectorState(state), state);
});

test('unknown legacy details still disappear and healthy state acquires no invented fault', () => {
  const state = fixture();
  for (const legacy of [null, 'old private text', { secretNativePath: '/private/runtime' }, { schemaVersion: 1, olderDebug: true }]) {
    state.executionHealth.viewFault.details = legacy;
    const projected = projectInspectorState(state);
    assert.equal(Object.hasOwn(projected.executionHealth.viewFault, 'details'), false);
  }
  const healthy = { ...state, executionHealth: { schemaVersion: 1, requiresRestart: false,
    appServiceFault: null, viewFault: null, navigationFault: null } };
  assert.deepEqual(projectInspectorState(healthy), healthy);
  const other = fixture();
  other.executionHealth.appServiceFault = { ...other.executionHealth.viewFault, domain: 'appService' };
  assert.equal(Object.hasOwn(projectInspectorState(other).executionHealth.appServiceFault, 'details'), false);
});

for (const [label, mutate] of [
  ['envelope unknown source', d => { d.privateSource = 'exports.secret'; }],
  ['envelope missing witness', d => { delete d.witness; }],
  ['envelope missing version', d => { delete d.schemaVersion; }],
  ['envelope unsupported version', d => { d.schemaVersion = 2; }],
  ['envelope missing identity', d => { delete d.sessionId; }],
  ['identity path', d => { d.sessionId = '/private/runtime'; }],
  ['identity URL', d => { d.sessionId = 'weapp-container://credential'; }],
  ['identity credential', d => { d.sessionId = 'github_pat_private'; }],
  ['identity trailing newline', d => { d.sessionId = 'sdk-1\n'; }],
  ['identity bound', d => { d.sessionId = 'a'.repeat(129); }],
  ['unknown witness source', d => { d.witness.rawError = 'guest message'; }],
  ['missing witness sequence', d => { delete d.witness.operationSequence; }],
  ['unknown operation', d => { d.witness.operation = 'evaluatePrivateSource'; }],
  ['wrong metrics variant', d => { d.witness.operation = 'release'; }],
  ['success cannot describe first poison', d => { d.witness.metrics.succeeded = true; }],
  ['unknown metrics source', d => { d.witness.metrics.sourceMap = '/private/source'; }],
  ['unknown stages field', d => { d.witness.metrics.providerStages.rawOutput = 'private'; }],
  ['missing current native counter', d => { delete d.witness.metrics.providerStages.inputBytes; }],
  ['unknown provider source', d => { d.witness.provider.privateOutput = 'guest'; }],
  ['missing provider observation', d => { delete d.witness.provider.lastBatch; }],
  ['receipt mismatch', d => { d.witness.provider.lastBatch.batchSequence = '99'; }],
  ['breakdown mismatch', d => { d.witness.provider.lastBatchBreakdown.ownerThreadId = '99'; }],
  ['missing stages with provider', d => { d.witness.metrics.providerStages = null; }],
  ['unknown batch field', d => { d.witness.provider.lastBatch.rawError = 'guest'; }],
  ['unknown phase field', d => { d.witness.provider.lastBatchBreakdown.phases.contextCall.rawSource = 'guest'; }],
  ['unsupported phase clock', d => { d.witness.provider.lastBatchBreakdown.phases.contextCall.wallElapsedNs = '3'; }],
  ['unsafe numeric timing', d => { d.witness.metrics.elapsedNs = Number.MAX_SAFE_INTEGER + 1; }],
  ['negative timing', d => { d.witness.metrics.providerNs = -1; }],
  ['fault ordinal must be first', d => { d.witness.faultSequence = '2'; }],
]) test(`recognized first fault rejects ${label}`, () => { const state = fixture(); mutate(details(state)); invalid(state); });

test('new identity and fault envelope cannot be silently rebound to another session', () => {
  for (const mutate of [
    s => { s.sessionId = 'sdk-another-1'; },
    s => { s.sessionId = null; },
    s => { s.executionHealth.viewFault.domain = 'appService'; },
    s => { s.executionHealth.viewFault.requiresRestart = false; },
  ]) { const state = fixture(); mutate(state); invalid(state); }
});

test('new sequences are positive canonical u64 and local elapsed is unsigned canonical u64', () => {
  for (const key of ['faultSequence', 'operationSequence', 'monotonicElapsedNs']) {
    for (const value of [1, null, '-1', '01', '+1', ' 1', '1\n', '1\r\n', '1e3', '18446744073709551616']) {
      const state = fixture(); details(state).witness[key] = value; invalid(state);
    }
  }
  for (const key of ['faultSequence', 'operationSequence']) {
    const state = fixture(); details(state).witness[key] = '0'; invalid(state);
  }
});

test('current first fault is retained exactly at48KiB or explicit limit is returned', () => {
  const state = fixture();
  const snapshot = { pages: [{ id: 1, route: 'home', data: { values: [], padding: '' } }], state };
  const size = () => Buffer.byteLength(JSON.stringify(sanitizeInspectorSnapshot(snapshot)));
  while (48 * 1024 - size() > 2048) snapshot.pages[0].data.values.push('x'.repeat(1800));
  const spare = 48 * 1024 - size();
  assert.ok(spare >= 0 && spare <= 2048);
  snapshot.pages[0].data.padding = 'x'.repeat(spare);
  const projected = sanitizeInspectorSnapshot(snapshot);
  assert.equal(Buffer.byteLength(JSON.stringify(projected)), 48 * 1024);
  assert.deepEqual(details(projected.state), details(state));
  snapshot.pages[0].data.padding += 'x';
  assert.throws(() => sanitizeInspectorSnapshot(snapshot), { code: 'ERR_DEV_INSPECT_LIMIT' });
  assert.deepEqual(details(state), details(fixture()));
});

test('node overflow is explicit and a failed read never changes source fault or input rights', () => {
  const state = fixture(), before = structuredClone(state);
  assert.throws(() => sanitizeInspectorSnapshot({ pages: [{ id: 1, route: 'home', data: Array(2000).fill(0) }], state }),
    { code: 'ERR_DEV_INSPECT_LIMIT' });
  assert.deepEqual(state, before);
});
