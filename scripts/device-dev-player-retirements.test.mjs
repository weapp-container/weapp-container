import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPlayerRetirementDiagnostics } from './lib/device-dev/player-retirements.mjs';
import { projectPlayerFailures } from './lib/device-dev/player-failures.mjs';
import { sanitizeInspectorSnapshot } from './device-dev-server.mjs';

const clone = value => structuredClone(value);
const identity = (sessionId, acceptedPackRevision = '1') => ({ root: 'a'.repeat(64), acceptedPackRevision, sessionId });
function observed() {
  return { controllerId: '7', sessionId: 'sdk-7-2', ownerId: '7', surfaceGeneration: '2', frameRevision: '9007199254740994',
    acceptedPackIdentity: identity('sdk-7-2', '9007199254740993') };
}
function entry(sequence = '1') {
  return { schemaVersion: 1, sequence, recordedAtMs: '1793360452453', code: 'ERR_ENGINE',
    origin: { schemaVersion: 1, phase: 'retirement', operation: 'unload', sessionId: 'sdk-7-1', acceptedPackIdentity: identity('sdk-7-1') },
    observedAccepted: observed() };
}
function journal() {
  return { schemaVersion: 1, journalId: 'a'.repeat(32), lastSequence: '1', droppedCount: '0', responseTruncated: false, entries: [entry()] };
}
function activeFailure() {
  const current = { schemaVersion: 1, sequence: '1', recordedAtMs: '1793360452454', phase: 'runtime', code: 'ERR_TIMEOUT',
    origin: { controllerRole: 'accepted', controllerId: '7', view: null }, observedAccepted: observed() };
  return { schemaVersion: 1, journalId: 'b'.repeat(32), lastSequence: '1', droppedCount: '0', responseTruncated: false, current, entries: [clone(current)] };
}
const invalid = value => assert.throws(() => projectPlayerRetirementDiagnostics(value), { code: 'ERR_DEV_INSPECT_DATA' });

test('retirement history is copied independently, with explicit empty versus legacy absence', () => {
  const value = journal(), projected = projectPlayerRetirementDiagnostics(value);
  assert.deepEqual(projected, value);
  projected.entries[0].origin.acceptedPackIdentity.root = 'b'.repeat(64);
  projected.entries[0].observedAccepted.acceptedPackIdentity.acceptedPackRevision = '2';
  assert.equal(value.entries[0].origin.acceptedPackIdentity.root, 'a'.repeat(64));
  assert.equal(value.entries[0].observedAccepted.acceptedPackIdentity.acceptedPackRevision, '9007199254740993');
  const empty = { ...value, lastSequence: '0', entries: [] };
  assert.deepEqual(projectPlayerRetirementDiagnostics(empty), empty);
  assert.equal(projectPlayerRetirementDiagnostics(undefined), undefined);
});

test('only the fixed retirement operations and controlled codes cross the boundary', () => {
  for (const operation of ['unload', 'cancelNavigation', 'cancelHostCalls']) {
    for (const code of ['ERR_ENGINE', 'ERR_TIMEOUT', 'ERR_CANCELLED', 'ERR_VIEW_REQUIRES_RESET', 'ERR_UNKNOWN']) {
      const value = journal(); value.entries[0].origin.operation = operation; value.entries[0].code = code;
      assert.equal(projectPlayerRetirementDiagnostics(value).entries[0].code, code);
    }
  }
});

for (const [label, mutate] of [
  ['unknown journal key', v => v.secret = 'private'],
  ['a current active error field', v => v.current = entry()],
  ['record arbitrary message', v => v.entries[0].message = 'private'],
  ['record active phase', v => v.entries[0].phase = 'runtime'],
  ['origin arbitrary details', v => v.entries[0].origin.details = { secret: 'private' }],
  ['origin identity arbitrary token', v => v.entries[0].origin.acceptedPackIdentity.token = 'private'],
  ['observed arbitrary source', v => v.entries[0].observedAccepted.source = 'private'],
  ['observed identity arbitrary message', v => v.entries[0].observedAccepted.acceptedPackIdentity.message = 'private'],
  ['wrong journal schema', v => v.schemaVersion = 2],
  ['wrong entry schema', v => v.entries[0].schemaVersion = 2],
  ['wrong origin schema', v => v.entries[0].origin.schemaVersion = 2],
  ['unknown origin phase', v => v.entries[0].origin.phase = 'runtime'],
  ['unknown origin operation', v => v.entries[0].origin.operation = 'applyDevPack'],
  ['unknown error code', v => v.entries[0].code = 'ERR_PRIVATE_TOKEN'],
  ['nonlowercase journal identity', v => v.journalId = 'A'.repeat(32)],
  ['wrong journal identity length', v => v.journalId = 'a'.repeat(31)],
  ['missing causal pack identity', v => v.entries[0].origin.acceptedPackIdentity = null],
  ['causal session does not match causal pack', v => v.entries[0].origin.acceptedPackIdentity.sessionId = 'another'],
  ['active session disguised as retired', v => { v.entries[0].origin.sessionId = 'sdk-7-2'; v.entries[0].origin.acceptedPackIdentity.sessionId = 'sdk-7-2'; }],
  ['same-revision session cannot be retired history', v => v.entries[0].origin.acceptedPackIdentity.acceptedPackRevision = v.entries[0].observedAccepted.acceptedPackIdentity.acceptedPackRevision],
  ['future revision cannot be retired history', v => v.entries[0].origin.acceptedPackIdentity.acceptedPackRevision = '9007199254740994'],
  ['missing current observation', v => v.entries[0].observedAccepted = null],
  ['missing current session', v => v.entries[0].observedAccepted.sessionId = null],
  ['missing current pack identity', v => v.entries[0].observedAccepted.acceptedPackIdentity = null],
  ['current session differs from current pack', v => v.entries[0].observedAccepted.acceptedPackIdentity.sessionId = 'another'],
  ['origin session text injection', v => v.entries[0].origin.sessionId = 'weapp-container://credential'],
  ['current session text injection', v => v.entries[0].observedAccepted.sessionId = 'sdk-7-2\nsecret'],
  ['invalid pack hash', v => v.entries[0].origin.acceptedPackIdentity.root = 'A'.repeat(64)],
  ['zero accepted revision', v => v.entries[0].origin.acceptedPackIdentity.acceptedPackRevision = '0'],
  ['overflow causal accepted revision', v => v.entries[0].origin.acceptedPackIdentity.acceptedPackRevision = '18446744073709551616'],
  ['overflow current accepted revision', v => v.entries[0].observedAccepted.acceptedPackIdentity.acceptedPackRevision = '18446744073709551616'],
  ['zero current controller', v => v.entries[0].observedAccepted.controllerId = '0'],
  ['null current controller', v => v.entries[0].observedAccepted.controllerId = null],
  ['overflow owner', v => v.entries[0].observedAccepted.ownerId = '18446744073709551616'],
  ['noncanonical surface generation', v => v.entries[0].observedAccepted.surfaceGeneration = '01'],
  ['numeric frame revision', v => v.entries[0].observedAccepted.frameRevision = 9007199254740994],
  ['overflow timestamp', v => v.entries[0].recordedAtMs = '18446744073709551616'],
  ['noncanonical timestamp', v => v.entries[0].recordedAtMs = '1e12'],
  ['numeric sequence', v => v.entries[0].sequence = 1],
  ['zero sequence', v => v.entries[0].sequence = '0'],
  ['noncanonical sequence', v => v.entries[0].sequence = '01'],
  ['oversized counter', v => v.lastSequence = '1'.repeat(129)],
  ['counter erases history', v => v.lastSequence = '0'],
  ['inaccurate dropped count', v => v.droppedCount = '1'],
  ['missing untruncated entry', v => v.entries = []],
  ['coverage flag is not boolean', v => v.responseTruncated = 1],
  ['over maximum retained entries', v => v.entries = Array.from({ length: 17 }, () => entry())],
  ['array extra private property', v => v.entries.secret = 'private'],
  ['sparse entries', v => v.entries = new Array(1)],
]) test(`retirement projection rejects ${label}`, () => { const value = journal(); mutate(value); invalid(value); });

test('non-enumerable keys, symbols, accessors and inherited records cannot smuggle extra data', () => {
  const hidden = journal(); Object.defineProperty(hidden.entries[0].origin, 'message', { value: 'private' }); invalid(hidden);
  const symbol = journal(); symbol.entries[0][Symbol('private')] = 'private'; invalid(symbol);
  const inherited = journal(); Object.setPrototypeOf(inherited.entries[0].origin, { message: 'private' }); invalid(inherited);
  const accessor = journal(); let called = false;
  Object.defineProperty(accessor.entries[0].origin, 'operation', { enumerable: true, get() { called = true; return 'unload'; } });
  invalid(accessor); assert.equal(called, false);
  const arrayAccessor = journal();
  Object.defineProperty(arrayAccessor.entries, '0', { enumerable: true, get() { called = true; return entry(); } });
  invalid(arrayAccessor); assert.equal(called, false);
});

test('u64 scalar boundaries, zero timestamp/frame and nullable surface observations remain exact', () => {
  const value = journal(), e = value.entries[0], maximum = '18446744073709551615';
  e.recordedAtMs = maximum; e.origin.acceptedPackIdentity.acceptedPackRevision = (BigInt(maximum) - 1n).toString();
  e.observedAccepted.acceptedPackIdentity.acceptedPackRevision = maximum;
  e.observedAccepted.ownerId = null; e.observedAccepted.surfaceGeneration = null; e.observedAccepted.frameRevision = '0';
  assert.deepEqual(projectPlayerRetirementDiagnostics(value), value);
  e.recordedAtMs = '0'; e.observedAccepted.frameRevision = null;
  assert.deepEqual(projectPlayerRetirementDiagnostics(value), value);
});

test('original drop count and trimmed contiguous suffix use exact large sequence counters', () => {
  const value = journal(), last = BigInt('9'.repeat(128));
  value.lastSequence = last.toString(); value.droppedCount = (last - 16n).toString();
  value.entries = Array.from({ length: 16 }, (_, index) => entry((last - 15n + BigInt(index)).toString()));
  assert.deepEqual(projectPlayerRetirementDiagnostics(value), value);
  const truncated = { ...value, entries: value.entries.slice(-3), responseTruncated: true };
  assert.deepEqual(projectPlayerRetirementDiagnostics(truncated), truncated);
  truncated.entries = []; assert.equal(projectPlayerRetirementDiagnostics(truncated).entries.length, 0);
  truncated.entries = [entry((last - 1n).toString())]; invalid(truncated);
  truncated.entries = [entry((last - 2n).toString()), entry(last.toString())]; invalid(truncated);
  truncated.entries = value.entries.slice(-3); truncated.droppedCount = (last - 3n).toString(); invalid(truncated);
});

test('service keeps independent active failure/current semantics and ignores nested guest impostors', () => {
  const retirements = journal(), failures = activeFailure();
  const snapshot = { pages: [{ id: 1, route: 'home', data: { playerRetirementDiagnostics: { secret: 'guest' } } }],
    state: { playerRetirementDiagnostics: { secret: 'native' } }, playerFailures: failures, playerRetirementDiagnostics: retirements };
  const projected = sanitizeInspectorSnapshot(snapshot);
  assert.deepEqual(projected.playerRetirementDiagnostics, retirements);
  assert.deepEqual(projected.playerFailures, failures);
  assert.deepEqual(projectPlayerFailures(projected.playerFailures), failures);
  assert.equal(projected.playerFailures.current.code, 'ERR_TIMEOUT');
  assert.deepEqual(projected.pages[0].data.playerRetirementDiagnostics, { secret: '[redacted]' });
  assert.equal(Object.hasOwn(projected.state ?? {}, 'playerRetirementDiagnostics'), false);
  assert.equal(Object.hasOwn(sanitizeInspectorSnapshot({ pages: [] }), 'playerRetirementDiagnostics'), false);
  const invalidTop = { pages: [], playerRetirementDiagnostics: { message: 'private' } };
  assert.throws(() => sanitizeInspectorSnapshot(invalidTop), { code: 'ERR_DEV_INSPECT_DATA' });
});

test('service trims retired response history before active history without mutating the Player journal', () => {
  const retirements = journal(); retirements.lastSequence = '20'; retirements.droppedCount = '4';
  retirements.entries = Array.from({ length: 16 }, (_, i) => entry(String(i + 5)));
  const failures = activeFailure();
  const projected = sanitizeInspectorSnapshot({ pages: [{ id: 1, route: 'home', data: Array.from({ length: 23 }, () => 'x'.repeat(1900)) }],
    playerFailures: failures, playerRetirementDiagnostics: retirements });
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 48 * 1024);
  assert.equal(projected.playerRetirementDiagnostics.responseTruncated, true);
  assert.ok(projected.playerRetirementDiagnostics.entries.length < 16);
  assert.deepEqual(projectPlayerRetirementDiagnostics(projected.playerRetirementDiagnostics), projected.playerRetirementDiagnostics);
  assert.deepEqual(projected.playerFailures, failures);
  assert.deepEqual(projectPlayerFailures(projected.playerFailures), failures);
  assert.equal(retirements.entries.length, 16); assert.equal(retirements.responseTruncated, false);
});

test('explicit retirement coverage cannot disappear to fit the response byte boundary', () => {
  const pages = [{ id: 1, route: 'home', data: [...Array.from({ length: 24 }, () => 'x'.repeat(2000)), ''] }];
  const remaining = 48 * 1024 - 100 - Buffer.byteLength(JSON.stringify({ pages }));
  assert.ok(remaining > 0 && remaining <= 2048); pages[0].data[24] = 'x'.repeat(remaining);
  assert.ok(sanitizeInspectorSnapshot({ pages }));
  const empty = { ...journal(), lastSequence: '0', entries: [] };
  assert.throws(() => sanitizeInspectorSnapshot({ pages, playerRetirementDiagnostics: empty }), { code: 'ERR_DEV_INSPECT_LIMIT' });
  assert.deepEqual(empty.entries, []); assert.equal(empty.responseTruncated, false);
});
