import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { projectInspectorState } from './lib/device-dev/inspector-state.mjs';
import { sanitizeInspectorSnapshot } from './device-dev-server.mjs';

function fixture() {
  return { sessionId: 'sdk-independent-review', inputEnabled: false, presentationEnabled: false,
    executionHealth: { schemaVersion: 1, requiresRestart: true, appServiceFault: null, navigationFault: null,
      viewFault: { domain: 'view', code: 'ERR_TIMEOUT', message: 'synthetic-review-fault', requiresRestart: true,
        details: { schemaVersion: 1, sessionId: 'sdk-independent-review', witness: {
          faultSequence: '1', operationSequence: '2', monotonicElapsedNs: '0', operation: 'render',
          metrics: { elapsedNs: 0, documentValidationEncodingNs: 0, providerNs: 0, providerStages: null,
            receiptValidationNs: 0, documentCacheHit: false, registrationCacheHits: 0,
            documentRegistrations: 0, succeeded: false },
          provider: { lastBatch: null, lastBatchBreakdown: null },
        } } } } };
}

test('recognized first-fault evidence requires an observable matching state session', () => {
  const state = fixture();
  delete state.sessionId;
  const before = structuredClone(state);
  assert.throws(() => projectInspectorState(state), { code: 'ERR_DEV_INSPECT_DATA' });
  assert.deepEqual(state, before);
});

test('recognized first-fault evidence requires outer execution health to require restart', () => {
  const state = fixture();
  state.executionHealth.requiresRestart = false;
  const before = structuredClone(state);
  assert.throws(() => projectInspectorState(state), { code: 'ERR_DEV_INSPECT_DATA' });
  assert.deepEqual(state, before);
});

test('legacy details without a recognized witness retain existing optional-session and health behavior', () => {
  const state = fixture();
  delete state.sessionId;
  state.executionHealth.requiresRestart = false;
  state.executionHealth.viewFault.details = { legacyPrivateDebug: 'drop-this' };
  const before = structuredClone(state);
  const projected = projectInspectorState(state);
  assert.equal(Object.hasOwn(projected, 'sessionId'), false);
  assert.equal(projected.executionHealth.requiresRestart, false);
  assert.equal(Object.hasOwn(projected.executionHealth.viewFault, 'details'), false);
  assert.equal(projected.inputEnabled, false);
  assert.equal(projected.presentationEnabled, false);
  assert.deepEqual(state, before);
});

test('passive first-fault projection preserves input flags and never clears or repairs the source fault', () => {
  const state = fixture(), before = structuredClone(state);
  const projected = sanitizeInspectorSnapshot({ pages: [], state });
  assert.deepEqual(projected.state, before);
  projected.state.executionHealth.viewFault.details.witness.operationSequence = '99';
  assert.deepEqual(state, before);
  assert.equal(state.inputEnabled, false);
  assert.equal(state.presentationEnabled, false);
  assert.equal(state.executionHealth.requiresRestart, true);
});

test('actual Rust serde declarations produce compatible closed prepare render release variants', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/device-dev-first-fault-serde.json', import.meta.url), 'utf8'));
  assert.equal(fixtures.cases.length, 15);
  for (const { case: name, state } of fixtures.cases) {
    const before = structuredClone(state);
    const witness = state.executionHealth.viewFault.details.witness;
    assert.equal(witness.faultSequence, '1');
    assert.equal(witness.operationSequence, '9007199254740993');
    assert.equal(witness.monotonicElapsedNs, '18446744073709551615');
    assert.deepEqual(projectInspectorState(state), before, name);
    assert.deepEqual(sanitizeInspectorSnapshot({ pages: [], state }).state, before, name);
    assert.deepEqual(state, before, name);
    if (name.includes('uninstrumented')) {
      assert.equal(witness.metrics.providerStages.lastBatch, null);
      assert.equal(Object.hasOwn(witness.metrics.providerStages, 'lastBatchBreakdown'), false);
      assert.equal(witness.provider.lastBatchBreakdown, null);
    }
  }
});

test('a provider phase difference is rejected even when each duplicate is independently valid', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/device-dev-first-fault-serde.json', import.meta.url), 'utf8'));
  const state = fixtures.cases.find(item => item.case === 'serde-state-render-quickjs-classic').state;
  const before = structuredClone(state);
  state.executionHealth.viewFault.details.witness.provider.lastBatchBreakdown.phases.contextCall.completed = true;
  assert.throws(() => projectInspectorState(state), { code: 'ERR_DEV_INSPECT_DATA' });
  assert.equal(before.executionHealth.viewFault.details.witness.provider.lastBatchBreakdown.phases.contextCall.completed, false);
});

test('the unchanged service depth boundary accepts depth12 and refuses depth13 without dropping fault evidence', () => {
  const nested = depth => {
    let value = 0;
    for (let index = 0; index < depth; index++) value = { child: value };
    return value;
  };
  const state = fixture(), before = structuredClone(state);
  const result = sanitizeInspectorSnapshot({ pages: [{ id: 1, route: 'home', data: nested(12) }], state });
  assert.deepEqual(result.state, before);
  assert.throws(() => sanitizeInspectorSnapshot({ pages: [{ id: 1, route: 'home', data: nested(13) }], state }),
    { code: 'ERR_DEV_INSPECT_LIMIT' });
  assert.deepEqual(state, before);
});

test('the unchanged shared node budget accepts exactly2048 nodes and refuses2049 intact', () => {
  const count = value => 1 + (value && typeof value === 'object'
    ? Object.values(value).reduce((sum, entry) => sum + count(entry), 0) : 0);
  const state = fixture(), before = structuredClone(state);
  const snapshot = { pages: [{ id: 1, route: 'home', data: { values: [] } }], state };
  const consumed = 2 + count(snapshot.pages[0].data) + count(state);
  snapshot.pages[0].data.values = Array(2048 - consumed).fill(0);
  assert.equal(2 + count(snapshot.pages[0].data) + count(state), 2048);
  assert.deepEqual(sanitizeInspectorSnapshot(snapshot).state, before);
  snapshot.pages[0].data.values.push(0);
  assert.throws(() => sanitizeInspectorSnapshot(snapshot), { code: 'ERR_DEV_INSPECT_LIMIT' });
  assert.deepEqual(state, before);
});
