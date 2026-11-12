import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPlayerFailures } from './lib/device-dev/player-failures.mjs';
import { sanitizeInspectorSnapshot } from './device-dev-server.mjs';

const clone = value => structuredClone(value);
function entry(sequence = '1') {
  return { schemaVersion: 1, sequence, recordedAtMs: '1793351000000', phase: 'preview', code: 'ERR_CANCELLED',
    origin: { controllerRole: 'accepted', controllerId: '7', view: { operation: 'hostLayout', viewLease: '3', operationSequence: '9', retired: false, code: 'ERR_CANCELLED', nativeReason: 'unclassified', disposition: 'active-error', proofOutcome: 'unavailable' } },
    observedAccepted: { controllerId: '7', sessionId: 'sdk-7-1', ownerId: '7', surfaceGeneration: '2', frameRevision: '9007199254740994', acceptedPackIdentity: { root: 'a'.repeat(64), acceptedPackRevision: '9007199254740993', sessionId: 'sdk-7-1' } } };
}
function journal() {
  const current = entry();
  return { schemaVersion: 1, journalId: 'a'.repeat(32), lastSequence: '1', droppedCount: '0', responseTruncated: false, current, entries: [clone(current)] };
}
const invalid = value => assert.throws(() => projectPlayerFailures(value), { code: 'ERR_DEV_INSPECT_DATA' });

test('failure history projects copies and explicit zero versus legacy absence', () => {
  const value = journal(), projected = projectPlayerFailures(value);
  assert.deepEqual(projected, value); assert.notEqual(projected.current, value.current);
  projected.current.origin.view.viewLease = '999';
  assert.equal(value.current.origin.view.viewLease, '3');
  const empty = { ...value, lastSequence: '0', current: null, entries: [] };
  assert.deepEqual(projectPlayerFailures(empty), empty);
  assert.equal(projectPlayerFailures(undefined), undefined);
});

for (const [label, mutate] of [
  ['arbitrary top descendant', v => v.secret = 'credential'],
  ['record arbitrary message', v => v.current.message = 'private'],
  ['origin arbitrary payload', v => v.current.origin.details = { token: 'private' }],
  ['observed arbitrary source', v => v.current.observedAccepted.token = 'private'],
  ['unknown phase', v => v.current.phase = 'private phase'],
  ['unknown code', v => v.current.code = 'ERR_PRIVATE_TOKEN'],
  ['unknown role', v => v.current.origin.controllerRole = 'arbitrary'],
  ['unknown native reason', v => v.current.origin.view.nativeReason = 'private'],
  ['invalid disposition', v => v.current.origin.view.disposition = 'diagnostic-only'],
  ['retired cannot be adopted', v => v.current.origin.view.retired = true],
  ['wrong attempt code', v => v.current.origin.view.code = 'ERR_TIMEOUT'],
  ['unknown proof', v => v.current.origin.view.proofOutcome = 'passed'],
  ['proof not from host layout', v => v.current.origin.view.operation = 'input'],
  ['nullable role mismatch', v => v.current.origin.controllerId = null],
  ['wrong u64 field', v => v.current.origin.view.viewLease = '18446744073709551616'],
  ['noncanonical decimal', v => v.current.origin.view.operationSequence = '01'],
  ['session text injection', v => v.current.observedAccepted.sessionId = 'weapp-container://credential'],
  ['noncanonical timestamp', v => v.current.recordedAtMs = '1e12'],
  ['current not newest', v => v.current.sequence = '2'],
  ['current differs from retained latest', v => v.entries[0].origin.view.operationSequence = '8'],
  ['counter cannot erase failures', v => v.lastSequence = '0'],
  ['invalid dropped count', v => v.droppedCount = '1'],
  ['missing untruncated entry', v => v.entries = []],
  ['wrong coverage flag', v => v.responseTruncated = 1],
]) test(`failure projection rejects ${label}`, () => { const value = journal(); mutate(value); invalid(value); });

test('bounded suffix, clear and large adoption counters are exact', () => {
  const value = journal(); value.lastSequence = '9007199254740994';
  value.droppedCount = '9007199254740978';
  value.entries = Array.from({ length: 16 }, (_, i) => entry((9007199254740979n + BigInt(i)).toString()));
  value.current = clone(value.entries.at(-1));
  assert.deepEqual(projectPlayerFailures(value), value);
  value.current = null; assert.equal(projectPlayerFailures(value).current, null);
  const truncated = { ...value, entries: value.entries.slice(-3), responseTruncated: true };
  assert.equal(projectPlayerFailures(truncated).entries.length, 3);
  truncated.entries = []; assert.equal(projectPlayerFailures(truncated).entries.length, 0);
  truncated.entries = [entry('9007199254740993')]; invalid(truncated);
});

test('service ignores guest impostors and retains top-level own failure metadata', () => {
  const value = journal();
  const snapshot = { pages: [{ id: 1, route: 'home', data: { playerFailures: { secret: 'guest' } } }], state: { playerFailures: { secret: 'native' } }, playerFailures: value };
  const projected = sanitizeInspectorSnapshot(snapshot);
  assert.deepEqual(projected.playerFailures, value);
  assert.deepEqual(projected.pages[0].data.playerFailures, { secret: '[redacted]' });
  assert.equal(Object.hasOwn(projected.state ?? {}, 'playerFailures'), false);
  assert.equal(Object.hasOwn(sanitizeInspectorSnapshot({ pages: [] }), 'playerFailures'), false);
});

test('service shares48KiB budget, trims response copies and never drops current', () => {
  const value = journal(); value.lastSequence = '20'; value.droppedCount = '4';
  value.entries = Array.from({ length: 16 }, (_, i) => entry(String(i + 5)));
  value.current = clone(value.entries.at(-1));
  const base = { pages: [{ id: 1, route: 'home', data: Array.from({ length: 23 }, () => 'x'.repeat(1900)) }], playerFailures: value };
  const projected = sanitizeInspectorSnapshot(base);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 48 * 1024);
  assert.equal(projected.playerFailures.responseTruncated, true);
  assert.deepEqual(projected.playerFailures.current, value.current);
  assert.equal(value.entries.length, 16); assert.equal(value.responseTruncated, false);
  assert.ok(projected.playerFailures.entries.length < 16);
  const huge = { ...base, pages: [{ id: 1, route: 'home', data: Array.from({ length: 26 }, () => 'x'.repeat(1900)) }] };
  assert.throws(() => sanitizeInspectorSnapshot(huge), { code: 'ERR_DEV_INSPECT_LIMIT' });
});


test('unavailable View projection remains explicit unknown and inspectable', () => {
  const value = journal();
  for (const e of [value.current, ...value.entries]) {
    e.code = 'ERR_UNKNOWN';
    e.origin.view.code = 'ERR_UNKNOWN';
    e.origin.view.operation = 'foreground';
    e.origin.view.proofOutcome = 'notRequested';
    e.origin.view.nativeReason = 'unclassified';
  }
  const projected = sanitizeInspectorSnapshot({ pages: [], playerFailures: value });
  assert.deepEqual(projected.playerFailures, value);
  assert.equal(projected.playerFailures.current.origin.view.operationSequence, '9');
});


test('minimum current failure envelope cannot be silently trimmed at byte boundary', () => {
  const value = journal();
  const pages = [{ id: 1, route: 'home', data: [...Array.from({ length: 24 }, () => 'x'.repeat(2000)), ''] }];
  const remaining = 48 * 1024 - 100 - Buffer.byteLength(JSON.stringify({ pages }));
  assert.ok(remaining > 0 && remaining <= 2048);
  pages[0].data[24] = 'x'.repeat(remaining);
  assert.equal(Buffer.byteLength(JSON.stringify({ pages })), 48 * 1024 - 100);
  assert.throws(() => sanitizeInspectorSnapshot({ pages, playerFailures: value }), { code: 'ERR_DEV_INSPECT_LIMIT' });
  assert.equal(value.entries.length, 1);
  assert.equal(value.responseTruncated, false);
  assert.equal(value.current.sequence, '1');
});
