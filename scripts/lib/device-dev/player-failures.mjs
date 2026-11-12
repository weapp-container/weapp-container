// Player-owned active-error adoption provenance. It is observational metadata,
// never authority to recover a session, acknowledge a frame or enable input.
const invalid = () => { throw Object.assign(new Error('Invalid Player failure journal'), { code: 'ERR_DEV_INSPECT_DATA' }); };
const MAX_U64 = 18446744073709551615n;
const codes = new Set(["ERR_BUSY", "ERR_CANCELLED", "ERR_CLEANUP", "ERR_CONTEXT_LOST", "ERR_CREDENTIALS", "ERR_DEVICE_AUTH", "ERR_DEV_BUDGET", "ERR_DEV_CACHE_BUDGET", "ERR_DEV_GENERATION", "ERR_DEV_HTTP", "ERR_DEV_INSPECT_BUSY", "ERR_DEV_INSPECT_DATA", "ERR_DEV_INSPECT_LIMIT", "ERR_DEV_JSON", "ERR_DEV_MESSAGE", "ERR_DEV_NETWORK", "ERR_DEV_OUTCOME_UNKNOWN", "ERR_DEV_PATH", "ERR_DEV_PROJECT", "ERR_DEV_STALE_INSPECTION", "ERR_DIAGNOSTIC_SINK", "ERR_EGL", "ERR_ENGINE", "ERR_EXECUTION_RESTART_REQUIRED", "ERR_GL", "ERR_GLES", "ERR_GPU", "ERR_INVALID_MANIFEST", "ERR_METAL", "ERR_METAL_UNAVAILABLE", "ERR_MODULE_LOAD", "ERR_NOT_READY", "ERR_PAIRING_RESPONSE", "ERR_PAIRING_URI", "ERR_PERMISSION_DENIED", "ERR_PLAYER", "ERR_PREFERENCES_DISPOSED", "ERR_PREFERENCES_LANGUAGE", "ERR_PREFERENCES_STORAGE", "ERR_PREFERENCES_WRITE", "ERR_PREVIEW", "ERR_PROTOCOL_VERSION", "ERR_RENDER", "ERR_STALE_CALL", "ERR_SURFACE_DETACHED", "ERR_SURFACE_LOST", "ERR_TEXTURE", "ERR_TIMEOUT", "ERR_TLS_PIN", "ERR_UNKNOWN", "ERR_UNSUPPORTED_CAPABILITY", "ERR_VIEW_DESTROYED", "ERR_VIEW_EXECUTION", "ERR_VIEW_INVALID_BATCH", "ERR_VIEW_MODULE", "ERR_VIEW_REQUIRES_RESET", "ERR_VIEW_UNSUPPORTED_VALUE", "ERR_WGL", "ERR_WIN32"]);
const phases = new Set(['player', 'preview', 'build', 'development', 'runtime', 'executionHealth', 'cleanup', 'navigation', 'layout', 'connection']);
const roles = new Set(['accepted', 'candidate', 'prospective', 'retired', 'none']);
const operations = new Set(['claim', 'foreground', 'chromeQueue', 'chromeReady', 'hostLayout', 'hostLayoutProof', 'hostChrome', 'nativeChrome', 'cover', 'uncover', 'metricsQueue', 'attachTexture', 'resizeTexture', 'detachPlatformView', 'detachTexture', 'input']);
const reasons = new Set(['unclassified', 'layout-no-pending-observation', 'layout-observation-superseded', 'layout-surface-owner-changed', 'layout-stale-revision', 'layout-native-owner-retired', 'layout-measurement-task-cancelled', 'layout-measurement-engine-detached', 'layout-measurement-engine-initializing', 'layout-measurement-entry-closing', 'layout-measurement-view-retiring', 'layout-measurement-lifetime-changed', 'layout-measurement-entry-removed', 'layout-measurement-restart-receipt-mismatch', 'layout-measurement-observation-superseded']);
function exact(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length || !names.every(k => Object.hasOwn(value, k))) invalid();
}
function counter(value, positive = false, maxDigits = 128) {
  if (typeof value !== 'string' || value.length > maxDigits || !/^(?:0|[1-9][0-9]*)$/.test(value) || positive && value === '0') invalid();
  return BigInt(value);
}
function u64(value, positive = true) {
  if (counter(value, positive, 20) > MAX_U64) invalid();
  return value;
}
const nullable = (value, fn) => value === null ? null : fn(value);
function session(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) invalid();
  return value;
}
function identity(value) {
  exact(value, ['root', 'acceptedPackRevision', 'sessionId']);
  if (typeof value.root !== 'string' || !/^[a-f0-9]{64}$/.test(value.root)) invalid();
  return { root: value.root, acceptedPackRevision: u64(value.acceptedPackRevision), sessionId: session(value.sessionId) };
}
function observed(value) {
  exact(value, ['controllerId', 'sessionId', 'ownerId', 'surfaceGeneration', 'frameRevision', 'acceptedPackIdentity']);
  return { controllerId: u64(value.controllerId), sessionId: nullable(value.sessionId, session),
    ownerId: nullable(value.ownerId, u64), surfaceGeneration: nullable(value.surfaceGeneration, u64),
    frameRevision: nullable(value.frameRevision, v => u64(v, false)), acceptedPackIdentity: nullable(value.acceptedPackIdentity, identity) };
}
function origin(value, code) {
  exact(value, ['controllerRole', 'controllerId', 'view']);
  if (!roles.has(value.controllerRole) || (value.controllerRole === 'none') !== (value.controllerId === null)) invalid();
  let view = null;
  if (value.view !== null) {
    const v = value.view;
    exact(v, ['operation', 'viewLease', 'operationSequence', 'retired', 'code', 'nativeReason', 'disposition', 'proofOutcome']);
    if (!operations.has(v.operation) || v.retired !== false || !codes.has(v.code) || v.code !== code ||
        !reasons.has(v.nativeReason) || v.nativeReason !== 'unclassified' && v.code !== 'ERR_CANCELLED' ||
        v.disposition !== 'active-error' || !['notRequested', 'unavailable', 'notSuperseded'].includes(v.proofOutcome) ||
        v.proofOutcome !== 'notRequested' && (v.code !== 'ERR_CANCELLED' || !['hostLayout', 'hostChrome'].includes(v.operation)) || value.controllerRole === 'none') invalid();
    view = { operation: v.operation, viewLease: u64(v.viewLease), operationSequence: u64(v.operationSequence),
      retired: false, code: v.code, nativeReason: v.nativeReason, disposition: 'active-error', proofOutcome: v.proofOutcome };
  }
  return { controllerRole: value.controllerRole, controllerId: nullable(value.controllerId, u64), view };
}
function entry(value) {
  exact(value, ['schemaVersion', 'sequence', 'recordedAtMs', 'phase', 'code', 'origin', 'observedAccepted']);
  if (value.schemaVersion !== 1 || !phases.has(value.phase) || !codes.has(value.code)) invalid();
  counter(value.sequence, true);
  return { schemaVersion: 1, sequence: value.sequence, recordedAtMs: u64(value.recordedAtMs), phase: value.phase,
    code: value.code, origin: origin(value.origin, value.code), observedAccepted: nullable(value.observedAccepted, observed) };
}
export function projectPlayerFailures(value) {
  if (value === undefined) return undefined; // Legacy omission does not prove zero failures.
  exact(value, ['schemaVersion', 'journalId', 'lastSequence', 'droppedCount', 'responseTruncated', 'current', 'entries']);
  if (value.schemaVersion !== 1 || typeof value.journalId !== 'string' || !/^[a-f0-9]{32}$/.test(value.journalId) ||
      typeof value.responseTruncated !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > 16) invalid();
  const last = counter(value.lastSequence), dropped = counter(value.droppedCount);
  const retained = Number(last > 16n ? 16n : last);
  if (dropped !== last - BigInt(retained) || value.entries.length > retained || !value.responseTruncated && value.entries.length !== retained) invalid();
  let previous = last - BigInt(value.entries.length);
  const entries = value.entries.map(v => {
    const e = entry(v); const n = counter(e.sequence, true);
    if (n !== ++previous || n > last) invalid();
    return e;
  });
  const current = nullable(value.current, entry);
  if (current && (current.sequence !== value.lastSequence || entries.length && JSON.stringify(current) !== JSON.stringify(entries.at(-1)))) invalid();
  return { schemaVersion: 1, journalId: value.journalId, lastSequence: value.lastSequence,
    droppedCount: value.droppedCount, responseTruncated: value.responseTruncated, current, entries };
}
