import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeInspectorSnapshot } from './device-dev-server.mjs';
import { nativeViewMetricsFixture } from './fixtures/device-dev-view-metrics.mjs';

function state() {
  const windowMetrics = { windowWidth: 393, windowHeight: 701, pixelRatio: 3, screenWidth: 393,
    screenHeight: 851, statusBarHeight: 24, screenTop: 72, deviceOrientation: 'portrait',
    safeArea: { left: 0, right: 393, top: 24, bottom: 827, width: 393, height: 803 } };
  const chrome = { schemaVersion: 1, revision: 9, sessionId: 'sdk-session', pageId: 1,
    contentRect: { left: 0, top: 72, width: 393, height: 701 },
    menuButtonRect: { left: 297, right: 385, top: 32, bottom: 64, width: 88, height: 32 } };
  return { schemaVersion: 1, status: 'ready', ownerId: '18446744073709551615', sessionId: 'sdk-session',
    generation: 1, engine: 'quickjs', page: { id: 1, route: 'pages/home/index' },
    acceptedPackIdentity: { root: 'a'.repeat(64), acceptedPackRevision: '2', sessionId: 'sdk-session' },
    executionHealth: { schemaVersion: 1, appServiceFault: null, viewFault: null, navigationFault: null, requiresRestart: false },
    viewExecutionMetrics: null, pendingNavigation: null,
    frameId: 7, frameRevision: 8, foreground: true, surface: 'gles', inputEnabled: true, presentationEnabled: true,
    hostSurface: { ownerId: '18446744073709551615', surfaceGeneration: '4' },
    acceptedLayout: { schemaVersion: 1, ownerId: '18446744073709551615', surfaceGeneration: '4', observationId: '6',
      layoutRevision: '9', windowMetrics, chrome },
    pendingHostLayout: null, previewOccluded: false, hostChrome: chrome,
    chromeGeometryReady: true, observedViewport: { width: 393, height: 701 },
    presentationRequired: true, viewport: { width: 393, height: 701 } };
}
const inspect = value => sanitizeInspectorSnapshot({ pages: [], state: value });

test('passive SDK state preserves exact lossless layout identities and typed health', () => {
  const native = state();
  assert.deepEqual(inspect(native).state, native);
  native.executionHealth.viewFault = { domain: 'view', code: 'ERR_TIMEOUT', message: 'bounded interruption', requiresRestart: true,
    stack: 'page.wxs:4', details: { secretNativePath: '/private/runtime' } };
  native.executionHealth.requiresRestart = true;
  const projected = inspect(native).state;
  assert.equal(projected.executionHealth.viewFault.code, 'ERR_TIMEOUT');
  assert.equal(projected.executionHealth.viewFault.details, undefined);
});

test('projection excludes unreviewed descendants and applies the shared credential scrubber', () => {
  const native = state();
  native.secretNativeConfig = { token: 'never expose' };
  native.acceptedLayout.chrome.nativePath = '/private/runtime';
  native.acceptedLayout.windowMetrics.storage = { secret: 'never expose' };
  native.executionHealth.viewFault = { domain: 'view', code: 'ERR_TIMEOUT', message: 'Bearer private',
    requiresRestart: true, stack: 'weapp-container://connect?code=private' };
  const projected = inspect(native).state;
  assert.equal(projected.secretNativeConfig, undefined);
  assert.equal(projected.acceptedLayout.chrome.nativePath, undefined);
  assert.equal(projected.acceptedLayout.windowMetrics.storage, undefined);
  assert.equal(projected.executionHealth.viewFault.message, '[redacted]');
  assert.equal(projected.executionHealth.viewFault.stack, '[redacted]');
  assert.deepEqual(inspect({ secretNativeConfig: 'never expose' }), { pages: [] });
  assert.deepEqual(sanitizeInspectorSnapshot({ pages: [] }), { pages: [] });
});

test('malformed identities and known state fields fail closed instead of disappearing', () => {
  for (const [field, value] of [['ownerId', 1], ['ownerId', '01'], ['ownerId', '18446744073709551616'],
    ['ownerId', '0'], ['ownerId', '1\n'], ['ownerId', '1\r\n'], ['inputEnabled', 'true'], ['frameRevision', Number.MAX_SAFE_INTEGER + 1],
    ['generation', -1], ['schemaVersion', 2], ['viewport', { width: 0, height: 667 }]]) {
    assert.throws(() => inspect({ ...state(), [field]: value }), { code: 'ERR_DEV_INSPECT_DATA' }, field + '=' + value);
  }
  const native = state();
  delete native.acceptedLayout.observationId;
  assert.throws(() => inspect(native), { code: 'ERR_DEV_INSPECT_DATA' });
});

test('native state and page traces consume the same byte/node/string budget', () => {
  const native = state();
  native.executionHealth.viewFault = { domain: 'view', code: 'ERR_TIMEOUT', message: 'x'.repeat(2049), requiresRestart: true };
  assert.throws(() => inspect(native), { code: 'ERR_DEV_INSPECT_LIMIT' });
  assert.throws(() => sanitizeInspectorSnapshot({ pages: [{ id: 1, route: 'home', data: Array(2000).fill(0) }], state: state() }),
    { code: 'ERR_DEV_INSPECT_LIMIT' });
});

test('development attempts preserve the typed actual SDK receipt without state, paths or unreviewed details', () => {
  const accepted = state().acceptedPackIdentity;
  const developmentAttempt = { schemaVersion: 1, projectId: 'd'.repeat(32), runId: 'b'.repeat(32), generation: '3', targetRoot: 'c'.repeat(64),
    resolution: 'terminal', source: 'event', observedAt: '2026-10-29T00:00:00.000Z',
    receipt: { schemaVersion: 1, ownerId: '17', attemptId: '8', status: 'rejected', operation: 'applyDevPack',
      targetRoot: 'c'.repeat(64), expectedAccepted: accepted, acceptedPackIdentity: accepted, reloadKind: 'restart',
      error: { code: 'ERR_ENGINE', message: 'P0_CANDIDATE_STARTUP_FAILURE', details: { token: 'never expose' } },
      observationErrors: [{ phase: 'state', code: 'ERR_ENGINE', privatePath: '/private' }],
      state: { config: 'never expose' }, packPath: '/private/pack' } };
  const projected = sanitizeInspectorSnapshot({ pages: [], developmentAttempt }).developmentAttempt;
  assert.equal(projected.receipt.error.message, 'P0_CANDIDATE_STARTUP_FAILURE');
  assert.equal(projected.receipt.error.details, undefined);
  assert.equal(projected.receipt.state, undefined);
  assert.equal(projected.receipt.packPath, undefined);
  assert.equal(projected.receipt.observationErrors[0].privatePath, undefined);
  assert.equal(projected.receipt.observationErrors[0].code, 'ERR_ENGINE');
  const cancelled = sanitizeInspectorSnapshot({ pages: [], developmentAttempt: { ...developmentAttempt,
    source: 'cancel', receipt: { ...developmentAttempt.receipt, status: 'cancelled',
      error: { code: 'ERR_CANCELLED', message: 'Cancelled before submission' } } } }).developmentAttempt;
  assert.equal(cancelled.source, 'cancel');
  assert.equal(cancelled.receipt.status, 'cancelled');
  assert.equal(sanitizeInspectorSnapshot({ pages: [], developmentAttempt: null }).developmentAttempt, null);
  const acceptedPack = { projectId: 'd'.repeat(32), runId: 'b'.repeat(32), generation: '2', root: accepted.root, privatePath: '/private' };
  assert.deepEqual(sanitizeInspectorSnapshot({ pages: [], acceptedPack }).acceptedPack,
    { projectId: acceptedPack.projectId, runId: acceptedPack.runId, generation: '2', root: accepted.root });
  assert.equal(sanitizeInspectorSnapshot({ pages: [], acceptedPack: null }).acceptedPack, null);
  assert.throws(() => sanitizeInspectorSnapshot({ pages: [], developmentAttempt: { ...developmentAttempt, generation: 3 } }),
    { code: 'ERR_DEV_INSPECT_DATA' });
  assert.throws(() => sanitizeInspectorSnapshot({ pages: [], developmentAttempt: { ...developmentAttempt,
    receipt: { ...developmentAttempt.receipt, status: 'maybe-rejected' } } }), { code: 'ERR_DEV_INSPECT_DATA' });
});


test('native View stage diagnostics preserve the exact serialized probe and registration counters', () => {
  const metrics = nativeViewMetricsFixture();
  const result = inspect({ viewExecutionMetrics: metrics }).state.viewExecutionMetrics;
  assert.deepEqual(result, metrics);
  assert.equal(result.preparation.providerStages.lastBatch.boottimeStartNs, null);
  assert.equal(result.preparation.providerStages.lastBatch.boottimeEndNs, null);
  assert.equal(result.preparation.providerStages.lastBatch.androidTraceEnabled, null);
  metrics.frontier.providerStages.lastBatch.threadCpuElapsedNs = '0';
  metrics.frontier.providerStages.lastBatch.monotonicStartNs = '18446744073709551615';
  assert.equal(inspect({ viewExecutionMetrics: metrics }).state.viewExecutionMetrics.frontier.providerStages.lastBatch.threadCpuElapsedNs, '0');
  assert.equal(inspect({ viewExecutionMetrics: metrics }).state.viewExecutionMetrics.frontier.providerStages.lastBatch.monotonicStartNs, '18446744073709551615');
  // Native metrics retain the existing guest-shared budget rather than acquiring
  // the independent bounded Player journal allowance.
  assert.throws(() => sanitizeInspectorSnapshot({ pages: [{ id: 1, route: 'home', data: Array(2000).fill(0) }],
    state: { viewExecutionMetrics: metrics } }), { code: 'ERR_DEV_INSPECT_LIMIT' });
});

test('native View metrics accept legacy or unavailable observations without manufacturing zeros', () => {
  const metrics = nativeViewMetricsFixture();
  for (const stage of ['preparation', 'frontier']) {
    for (const key of ['inputBytes', 'documentRegistrations', 'registeredRenderBatches', 'lastBatch']) delete metrics[stage].providerStages[key];
  }
  delete metrics.frontier.registrationCacheHits; delete metrics.frontier.documentRegistrations;
  assert.deepEqual(inspect({ viewExecutionMetrics: metrics }).state.viewExecutionMetrics, metrics);
  metrics.frontier.providerStages.lastBatch = null;
  assert.equal(inspect({ viewExecutionMetrics: metrics }).state.viewExecutionMetrics.frontier.providerStages.lastBatch, null);
  metrics.frontier.providerStages.privatePath = '/private/never-forward';
  assert.equal(inspect({ viewExecutionMetrics: metrics }).state.viewExecutionMetrics.frontier.providerStages.privatePath, undefined);
  const nullable = nativeViewMetricsFixture();
  for (const key of ['batchSequence', 'ownerThreadId', 'monotonicStartNs', 'monotonicEndNs', 'boottimeStartNs', 'boottimeEndNs',
    'threadCpuStartNs', 'threadCpuEndNs', 'threadCpuElapsedNs', 'errorCode', 'androidTraceEnabled']) nullable.frontier.providerStages.lastBatch[key] = null;
  assert.deepEqual(inspect({ viewExecutionMetrics: nullable }).state.viewExecutionMetrics.frontier.providerStages.lastBatch, nullable.frontier.providerStages.lastBatch);
});

test('native View diagnostics fail closed on private fields and malformed clocks, identities or enums', () => {
  const bad = [
    ['unknown field', batch => { batch.rawError = 'never-forward'; }],
    ['missing field', batch => { delete batch.errorCode; }],
    ['schema', batch => { batch.schemaVersion = 2; }],
    ['engine', batch => { batch.engine = 'unknown-native'; }],
    ['modern', batch => { batch.modern = 1; }],
    ['operation', batch => { batch.operation = 'private'; }],
    ['sequence terminal newline', batch => { batch.batchSequence = '1\n'; }],
    ['clock terminal newline', batch => { batch.monotonicStartNs = '1\n'; }],
    ['zero clock terminal newline', batch => { batch.threadCpuElapsedNs = '0\n'; }],
    ['sequence', batch => { batch.batchSequence = '0'; }],
    ['thread identity', batch => { batch.ownerThreadId = 7; }],
    ['overflow clock', batch => { batch.monotonicStartNs = '18446744073709551616'; }],
    ['numeric clock', batch => { batch.threadCpuElapsedNs = 0; }],
    ['ambiguous clock', batch => { batch.threadCpuStartNs = '01'; }],
    ['negative clock', batch => { batch.threadCpuEndNs = '-1'; }],
    ['error', batch => { batch.errorCode = 'ERR_UNREVIEWED_NATIVE'; }],
    ['trace enabled', batch => { batch.androidTraceEnabled = 'false'; }],
    ['trace emitted', batch => { batch.androidTraceEmitted = null; }],
  ];
  for (const [label, mutate] of bad) {
    const metrics = nativeViewMetricsFixture(); mutate(metrics.frontier.providerStages.lastBatch);
    assert.throws(() => inspect({ viewExecutionMetrics: metrics }), { code: 'ERR_DEV_INSPECT_DATA' }, label);
  }
  for (const path of [['frontier', 'registrationCacheHits'], ['frontier', 'documentRegistrations'],
    ['frontier', 'providerStages', 'inputBytes'], ['frontier', 'providerStages', 'registeredRenderBatches'],
    ['frontier', 'providerStages', 'documentRegistrations']]) {
    for (const invalid of [-1, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      const metrics = nativeViewMetricsFixture(); let owner = metrics;
      for (const key of path.slice(0, -1)) owner = owner[key]; owner[path.at(-1)] = invalid;
      assert.throws(() => inspect({ viewExecutionMetrics: metrics }), { code: 'ERR_DEV_INSPECT_DATA' }, path.join('.'));
    }
  }
  for (const operation of ['load', 'evaluate', 'render', 'registerDocuments', 'renderRegistered', 'releaseScopes', 'unknown']) {
    const metrics = nativeViewMetricsFixture(); metrics.frontier.providerStages.lastBatch.operation = operation;
    metrics.frontier.providerStages.lastBatch.engine = 'v8';
    assert.equal(inspect({ viewExecutionMetrics: metrics }).state.viewExecutionMetrics.frontier.providerStages.lastBatch.operation, operation);
  }
});


test('dynamic tab chrome retains only typed indicator observations', () => {
  const value = { schemaVersion:1, sessionId:'session', page:{id:1,route:'home'}, stack:[{id:1,route:'home'}], canGoBack:false,
    navigationStyle:'default',title:'Home',backgroundColor:'#ffffff',frontColor:'#000000',
    tabBar:{visible:true,custom:false,color:'#111111',selectedColor:'#222222',backgroundColor:'#ffffff',borderStyle:'white',selectedIndex:0,
      list:[{pagePath:'home',text:'Home',badgeText:'...',privateToken:'secret'},{pagePath:'other',text:'Other',redDot:true}]} };
  const result = inspect({chrome:value}).state.chrome;
  assert.equal(result.tabBar.list[0].badgeText,'...');
  assert.equal(result.tabBar.list[0].privateToken,undefined);
  assert.equal(result.tabBar.list[1].redDot,true);
  value.tabBar.list[1].redDot='true';
  assert.throws(()=>inspect({chrome:value}),{code:'ERR_DEV_INSPECT_DATA'});
});
