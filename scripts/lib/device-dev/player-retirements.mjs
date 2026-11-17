// Proven retirement failures are history, never the Player's active error or
// authority to acknowledge a new session, enable input or recover a surface.
const invalid = () => { throw Object.assign(new Error('Invalid Player retirement diagnostic journal'), { code: 'ERR_DEV_INSPECT_DATA' }); };
const MAX_U64 = 18446744073709551615n;
const codes = new Set(["ERR_BUSY", "ERR_CANCELLED", "ERR_CLEANUP", "ERR_CONTEXT_LOST", "ERR_CREDENTIALS", "ERR_DEVICE_AUTH", "ERR_DEV_BUDGET", "ERR_DEV_CACHE_BUDGET", "ERR_DEV_GENERATION", "ERR_DEV_HTTP", "ERR_DEV_INSPECT_BUSY", "ERR_DEV_INSPECT_DATA", "ERR_DEV_INSPECT_LIMIT", "ERR_DEV_JSON", "ERR_DEV_MESSAGE", "ERR_DEV_NETWORK", "ERR_DEV_OUTCOME_UNKNOWN", "ERR_DEV_PATH", "ERR_DEV_PROJECT", "ERR_DEV_STALE_INSPECTION", "ERR_DIAGNOSTIC_SINK", "ERR_EGL", "ERR_ENGINE", "ERR_EXECUTION_RESTART_REQUIRED", "ERR_GL", "ERR_GLES", "ERR_GPU", "ERR_INVALID_MANIFEST", "ERR_METAL", "ERR_METAL_UNAVAILABLE", "ERR_MODULE_LOAD", "ERR_NOT_READY", "ERR_PAIRING_RESPONSE", "ERR_PAIRING_URI", "ERR_PERMISSION_DENIED", "ERR_PLAYER", "ERR_PREFERENCES_DISPOSED", "ERR_PREFERENCES_LANGUAGE", "ERR_PREFERENCES_STORAGE", "ERR_PREFERENCES_WRITE", "ERR_PREVIEW", "ERR_PROTOCOL_VERSION", "ERR_RENDER", "ERR_STALE_CALL", "ERR_SURFACE_DETACHED", "ERR_SURFACE_LOST", "ERR_TEXTURE", "ERR_TIMEOUT", "ERR_TLS_PIN", "ERR_UNKNOWN", "ERR_UNSUPPORTED_CAPABILITY", "ERR_VIEW_DESTROYED", "ERR_VIEW_EXECUTION", "ERR_VIEW_INVALID_BATCH", "ERR_VIEW_MODULE", "ERR_VIEW_REQUIRES_RESET", "ERR_VIEW_UNSUPPORTED_VALUE", "ERR_WGL", "ERR_WIN32"]);
const operations = new Set(['unload', 'cancelNavigation', 'cancelHostCalls']);

function exact(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== names.length || !names.every(name => {
        const property = Object.getOwnPropertyDescriptor(value, name);
        return property?.enumerable === true && Object.hasOwn(property, 'value');
      })) invalid();
}
function counter(value, positive = false, maximumDigits = 128) {
  if (typeof value !== 'string' || value.length > maximumDigits ||
      !/^(?:0|[1-9][0-9]*)$/.test(value) || positive && value === '0') invalid();
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
function origin(value) {
  exact(value, ['schemaVersion', 'phase', 'operation', 'sessionId', 'acceptedPackIdentity']);
  if (value.schemaVersion !== 1 || value.phase !== 'retirement' || !operations.has(value.operation)) invalid();
  const sessionId = session(value.sessionId), acceptedPackIdentity = identity(value.acceptedPackIdentity);
  if (acceptedPackIdentity.sessionId !== sessionId) invalid();
  return { schemaVersion: 1, phase: 'retirement', operation: value.operation, sessionId, acceptedPackIdentity };
}
function observed(value) {
  exact(value, ['controllerId', 'sessionId', 'ownerId', 'surfaceGeneration', 'frameRevision', 'acceptedPackIdentity']);
  const sessionId = session(value.sessionId), acceptedPackIdentity = identity(value.acceptedPackIdentity);
  if (acceptedPackIdentity.sessionId !== sessionId) invalid();
  return { controllerId: u64(value.controllerId), sessionId,
    ownerId: nullable(value.ownerId, u64), surfaceGeneration: nullable(value.surfaceGeneration, u64),
    frameRevision: nullable(value.frameRevision, v => u64(v, false)), acceptedPackIdentity };
}
function entry(value) {
  exact(value, ['schemaVersion', 'sequence', 'recordedAtMs', 'code', 'origin', 'observedAccepted']);
  if (value.schemaVersion !== 1 || !codes.has(value.code)) invalid();
  counter(value.sequence, true);
  const retired = origin(value.origin), accepted = observed(value.observedAccepted);
  if (retired.sessionId === accepted.sessionId ||
      BigInt(retired.acceptedPackIdentity.acceptedPackRevision) >= BigInt(accepted.acceptedPackIdentity.acceptedPackRevision)) invalid();
  return { schemaVersion: 1, sequence: value.sequence, recordedAtMs: u64(value.recordedAtMs, false),
    code: value.code, origin: retired, observedAccepted: accepted };
}

export function projectPlayerRetirementDiagnostics(value) {
  if (value === undefined) return undefined; // Legacy omission is not an empty history.
  exact(value, ['schemaVersion', 'journalId', 'lastSequence', 'droppedCount', 'responseTruncated', 'entries']);
  if (value.schemaVersion !== 1 || typeof value.journalId !== 'string' || !/^[a-f0-9]{32}$/.test(value.journalId) ||
      typeof value.responseTruncated !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > 16 ||
      Object.getPrototypeOf(value.entries) !== Array.prototype || Reflect.ownKeys(value.entries).length !== value.entries.length + 1 ||
      !Array.from({ length: value.entries.length }, (_, index) => Object.getOwnPropertyDescriptor(value.entries, String(index)))
        .every(property => property?.enumerable === true && Object.hasOwn(property, 'value'))) invalid();
  const last = counter(value.lastSequence), dropped = counter(value.droppedCount);
  const retained = Number(last > 16n ? 16n : last);
  if (dropped !== last - BigInt(retained) || value.entries.length > retained || !value.responseTruncated && value.entries.length !== retained) invalid();
  let previous = last - BigInt(value.entries.length);
  const entries = value.entries.map(value => {
    const projected = entry(value), sequence = counter(projected.sequence, true);
    if (sequence !== ++previous || sequence > last) invalid();
    return projected;
  });
  return { schemaVersion: 1, journalId: value.journalId, lastSequence: value.lastSequence,
    droppedCount: value.droppedCount, responseTruncated: value.responseTruncated, entries };
}
