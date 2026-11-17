// Player-owned, process-wide diagnostic history only. It never establishes
// accepted pack identity, runtime health, input authority or operation success.
// Project every scalar again at the authenticated service boundary; arbitrary
// native maps and guest page data cannot become this top-level journal.
const invalid = () => { throw Object.assign(new Error('Invalid Player View diagnostic journal'), { code: 'ERR_DEV_INSPECT_DATA' }); };
const MAX_U64 = 18446744073709551615n;
const operations = new Set([
  'claim', 'foreground', 'chromeQueue', 'chromeReady', 'hostLayout',
  'hostLayoutProof', 'hostChrome', 'nativeChrome', 'cover', 'uncover',
  'metricsQueue', 'attachTexture', 'resizeTexture', 'detachPlatformView',
  'detachTexture', 'input',
]);
const measurementReasons = new Set([
  'layout-measurement-task-cancelled',
  'layout-measurement-engine-detached',
  'layout-measurement-engine-initializing',
  'layout-measurement-entry-closing',
  'layout-measurement-view-retiring',
  'layout-measurement-lifetime-changed',
  'layout-measurement-entry-removed',
  'layout-measurement-restart-receipt-mismatch',
  'layout-measurement-observation-superseded',
]);
const reasons = new Set([
  ...measurementReasons,
  'unclassified', 'layout-no-pending-observation', 'layout-observation-superseded',
  'layout-surface-owner-changed', 'layout-stale-revision', 'layout-native-owner-retired',
]);
const roles = new Set(['accepted', 'candidate', 'prospective', 'retired']);
const wrapperKeys = ['schemaVersion', 'lastSequence', 'droppedCount', 'responseTruncated', 'entries'];
const entryKeys = ['schemaVersion', 'operation', 'viewLease', 'operationSequence', 'retired', 'code', 'nativeReason', 'controllerRole', 'sequence'];
function exactRecord(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== names.length || !names.every(name => Object.hasOwn(value, name))) invalid();
}
function decimal(value, positive = false, maximumDigits = 128) {
  if (typeof value !== 'string' || value.trim() !== value || value.length > maximumDigits ||
      !/^(?:0|[1-9][0-9]*)$/.test(value) || positive && value === '0') invalid();
  return BigInt(value);
}
function positiveU64(value) {
  const number = decimal(value, true, 20);
  if (number > MAX_U64) invalid();
  return value;
}
export function projectPlayerViewDiagnostics(value) {
  if (value === undefined) return undefined;
  exactRecord(value, wrapperKeys);
  if (value.schemaVersion !== 1 || typeof value.responseTruncated !== 'boolean' ||
      !Array.isArray(value.entries) || value.entries.length > 16) invalid();
  const lastSequence = decimal(value.lastSequence);
  if (decimal(value.droppedCount) > lastSequence) invalid();
  let previous = 0n;
  const entries = value.entries.map(entry => {
    exactRecord(entry, entryKeys);
    const sequence = decimal(entry.sequence, true);
    if (entry.schemaVersion !== 1 || !operations.has(entry.operation) ||
        typeof entry.retired !== 'boolean' || !reasons.has(entry.nativeReason) ||
        measurementReasons.has(entry.nativeReason) && entry.code !== 'ERR_CANCELLED' ||
        !roles.has(entry.controllerRole) || sequence <= previous || sequence > lastSequence ||
        entry.code !== null && (typeof entry.code !== 'string' || entry.code.trim() !== entry.code || !/^ERR_[A-Z0-9_]{1,48}$/.test(entry.code))) invalid();
    previous = sequence;
    return {
      schemaVersion: 1, operation: entry.operation,
      viewLease: positiveU64(entry.viewLease), operationSequence: positiveU64(entry.operationSequence),
      retired: entry.retired, code: entry.code, nativeReason: entry.nativeReason,
      controllerRole: entry.controllerRole, sequence: entry.sequence,
    };
  });
  // Both Player and server trim the oldest response entries; a nonempty
  // retained journal must still include the latest observation.
  if (entries.length && previous !== lastSequence) invalid();
  return {
    schemaVersion: 1, lastSequence: value.lastSequence, droppedCount: value.droppedCount,
    responseTruncated: value.responseTruncated, entries,
  };
}
