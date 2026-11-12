import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectPlayerViewDiagnostics } from './lib/device-dev/player-view-diagnostics.mjs';

const fixture = JSON.parse(readFileSync(new URL('../sdk/flutter/weapp_container/test/fixtures/ios-layout-cancellation-v1.json', import.meta.url), 'utf8'));
const journal = (reason, code = 'ERR_CANCELLED') => ({
  schemaVersion: 1, lastSequence: '1', droppedCount: '0', responseTruncated: false,
  entries: [{ schemaVersion: 1, operation: 'hostLayout', viewLease: '2', operationSequence: '3',
    retired: false, code, nativeReason: reason, controllerRole: 'accepted', sequence: '1' }],
});
for (const { reason } of fixture.contracts) {
  test(`typed iOS failure journal projection: ${reason}`, () => {
    const value = journal(reason);
    assert.deepEqual(projectPlayerViewDiagnostics(value), value);
    for (const code of ['ERR_ENGINE', 'ERR_NOT_READY', null]) {
      assert.throws(() => projectPlayerViewDiagnostics(journal(reason, code)), { code: 'ERR_DEV_INSPECT_DATA' });
    }
  });
}
test('legacy exact journal shape remains accepted, new unreviewed reasons fail closed', () => {
  const value = journal('layout-no-pending-observation');
  assert.deepEqual(projectPlayerViewDiagnostics(value), value);
  for (const reason of ['layout-measurement-made-up', 'layout-measurement-task-cancelled\nprivate-data']) {
    assert.throws(() => projectPlayerViewDiagnostics(journal(reason)), { code: 'ERR_DEV_INSPECT_DATA' });
  }
});
