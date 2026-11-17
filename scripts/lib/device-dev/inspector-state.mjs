// Passive SDK state only. Each nested object is projected through its public
// wire contract; allowing a top-level key must never expose private descendants.
const invalid = () => { throw Object.assign(new Error('Invalid passive SDK state'), { code: 'ERR_DEV_INSPECT_DATA' }); };
const check = predicate => value => predicate(value) ? value : invalid();
const boolean = check(value => typeof value === 'boolean');
const text = check(value => typeof value === 'string');
const finite = check(value => typeof value === 'number' && Number.isFinite(value));
const nonnegative = check(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
const positive = check(value => typeof value === 'number' && Number.isFinite(value) && value > 0);
const integer = check(value => Number.isSafeInteger(value) && value >= 0);
const positiveInteger = check(value => Number.isSafeInteger(value) && value > 0);
const decimal = check(value => typeof value === 'string' && value.trim() === value && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n);
const unsignedDecimal = check(value => typeof value === 'string' && value.trim() === value && /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n);
const hash = check(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
const oneOf = values => check(value => values.includes(value));
const nullable = parse => value => value === null ? null : parse(value);
const list = (parse, maximum) => value => Array.isArray(value) && value.length <= maximum ? value.map(parse) : invalid();
const object = (required, optional = {}) => value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const projected = {};
  for (const [key, parse] of Object.entries(required)) {
    if (!Object.hasOwn(value, key)) return invalid();
    projected[key] = parse(value[key]);
  }
  for (const [key, parse] of Object.entries(optional)) if (Object.hasOwn(value, key)) projected[key] = parse(value[key]);
  return projected;
};
// New native diagnostics use an exact, closed schema; unreviewed descendants
// must never escape through an otherwise allowed passive-state field.
const exactObject = (required, optional = {}) => value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !Object.hasOwn(required, key) && !Object.hasOwn(optional, key))) return invalid();
  return object(required, optional)(value);
};
const schemaVersion = oneOf([1]);
const page = object({ id: positiveInteger, route: text });
const viewport = object({ width: positiveInteger, height: positiveInteger });
const rect = object({ left: finite, top: finite, width: positive, height: positive });
const edges = object({ left: finite, right: finite, top: finite, bottom: finite, width: nonnegative, height: nonnegative });
const windowMetrics = object({
  windowWidth: positiveInteger, windowHeight: positiveInteger, pixelRatio: positive,
  screenWidth: positiveInteger, screenHeight: positiveInteger, statusBarHeight: nonnegative,
  screenTop: finite, deviceOrientation: oneOf(['portrait', 'landscape']),
}, { safeArea: nullable(edges) });
const hostChrome = object({ schemaVersion, revision: positiveInteger, contentRect: rect, menuButtonRect: edges }, { sessionId: text, pageId: positiveInteger });
const hostLayout = object({ schemaVersion, ownerId: decimal, surfaceGeneration: decimal, observationId: decimal,
  layoutRevision: decimal, windowMetrics, chrome: hostChrome });
const observation = object({ schemaVersion, ownerId: decimal, surfaceGeneration: decimal, observationId: decimal,
  windowMetrics }, { sessionId: text, pageId: positiveInteger });
const fault = object({ domain: oneOf(['appService', 'view', 'navigation']), code: text, message: text, requiresRestart: boolean }, { stack: text });
const viewFault = value => {
  const projected = fault(value);
  const candidate = value.details;
  // Generic historical details remain private. A new-schema marker must not
  // be silently dropped when malformed, including a missing witness field.
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
      (Object.hasOwn(candidate, 'witness') || Object.hasOwn(candidate, 'schemaVersion') && Object.hasOwn(candidate, 'sessionId'))) {
    if (projected.domain !== 'view' || !projected.requiresRestart) return invalid();
    projected.details = viewFirstFaultDetails(candidate);
  }
  return projected;
};
const health = object({ schemaVersion, appServiceFault: nullable(fault), viewFault: nullable(viewFault), navigationFault: nullable(fault), requiresRestart: boolean });
const tabItem = object({ pagePath: text, text }, { iconPath: text, selectedIconPath: text, badgeText: text, redDot: boolean });
const tabBar = object({ visible: boolean, custom: boolean, color: text, selectedColor: text, backgroundColor: text,
  borderStyle: text, selectedIndex: nullable(integer), list: list(tabItem, 32) });
const chrome = object({ schemaVersion, sessionId: nullable(text), page: nullable(page), stack: list(page, 32), canGoBack: boolean,
  navigationStyle: oneOf(['default', 'custom']), title: text, backgroundColor: text, frontColor: text, tabBar });
const viewBatchDiagnostics = exactObject({
  schemaVersion, engine: oneOf(['quickjs', 'v8']), modern: boolean,
  operation: oneOf(['load', 'evaluate', 'render', 'registerDocuments', 'renderRegistered', 'releaseScopes', 'unknown']),
  batchSequence: nullable(decimal), ownerThreadId: nullable(decimal),
  monotonicStartNs: nullable(unsignedDecimal), monotonicEndNs: nullable(unsignedDecimal),
  boottimeStartNs: nullable(unsignedDecimal), boottimeEndNs: nullable(unsignedDecimal),
  threadCpuStartNs: nullable(unsignedDecimal), threadCpuEndNs: nullable(unsignedDecimal),
  threadCpuElapsedNs: nullable(unsignedDecimal),
  errorCode: nullable(oneOf(['ERR_ENGINE', 'ERR_TIMEOUT', 'ERR_CANCELLED', 'ERR_VIEW_REQUIRES_RESET',
    'ERR_VIEW_MODULE', 'ERR_VIEW_EXECUTION', 'ERR_VIEW_UNSUPPORTED_VALUE', 'ERR_VIEW_INVALID_BATCH'])),
  androidTraceEnabled: nullable(boolean), androidTraceEmitted: boolean,
});
const phaseTimingShape = exactObject({
  completed: boolean, monotonicStartNs: nullable(unsignedDecimal), monotonicEndNs: nullable(unsignedDecimal),
  wallElapsedNs: nullable(unsignedDecimal), threadCpuStartNs: nullable(unsignedDecimal),
  threadCpuEndNs: nullable(unsignedDecimal), threadCpuElapsedNs: nullable(unsignedDecimal),
});
const phaseTiming = value => {
  const phase = phaseTimingShape(value);
  for (const [start, end, elapsed] of [
    ['monotonicStartNs', 'monotonicEndNs', 'wallElapsedNs'],
    ['threadCpuStartNs', 'threadCpuEndNs', 'threadCpuElapsedNs'],
  ]) {
    if (phase[start] === null || phase[end] === null) {
      if (phase[elapsed] !== null) return invalid();
    } else if (BigInt(phase[end]) < BigInt(phase[start])) {
      if (phase[elapsed] !== null) return invalid();
    } else if (phase[elapsed] === null || BigInt(phase[end]) - BigInt(phase[start]) !== BigInt(phase[elapsed])) return invalid();
  }
  return phase;
};
const viewBatchBreakdown = exactObject({
  schemaVersion, engine: oneOf(['quickjs']), modern: boolean,
  operation: oneOf(['load', 'evaluate', 'render', 'registerDocuments', 'renderRegistered', 'releaseScopes', 'unknown']),
  batchSequence: nullable(decimal), ownerThreadId: nullable(decimal),
  phases: exactObject({ contextCall: nullable(phaseTiming), jsonStringifyApi: nullable(phaseTiming),
    utf8CopyApi: nullable(phaseTiming), finalDeadlineCheck: nullable(phaseTiming),
    poisonDrop: nullable(phaseTiming), outputBytes: nullable(unsignedDecimal) }),
});
const providerStageFields = { batches: integer, elapsedNs: integer, inputEncodeNs: integer, vmInputParseNs: integer,
  executeIncludingLazyCompileNs: integer, vmOutputEncodeNs: integer, outputDecodeNs: integer, compileNs: nullable(integer) };
const providerStageOptional = {
  inputBytes: integer, documentRegistrations: integer, registeredRenderBatches: integer, lastBatch: nullable(viewBatchDiagnostics),
  lastBatchBreakdown: nullable(viewBatchBreakdown),
};
const checkProviderStages = stages => {
  if (stages.lastBatchBreakdown) {
    if (!stages.lastBatch || ['engine', 'modern', 'operation', 'batchSequence', 'ownerThreadId']
      .some(key => stages.lastBatch[key] !== stages.lastBatchBreakdown[key])) return invalid();
    if (stages.lastBatchBreakdown.modern && stages.lastBatchBreakdown.phases.jsonStringifyApi !== null) return invalid();
  }
  return stages;
};
const providerStages = value => checkProviderStages(object(providerStageFields, providerStageOptional)(value));
const preparationMetricFields = { elapsedNs: integer, providerInitializationNs: integer, validationEncodingNs: integer, providerNs: integer,
  providerStages: nullable(providerStages), cacheHit: boolean, succeeded: boolean };
const frontierMetricFields = { elapsedNs: integer, documentValidationEncodingNs: integer, providerNs: integer,
  providerStages: nullable(providerStages), receiptValidationNs: integer, documentCacheHit: boolean, succeeded: boolean };
const frontierMetricOptional = { registrationCacheHits: integer, documentRegistrations: integer };
const releaseMetricFields = { elapsedNs: integer, providerNs: integer, providerStages: nullable(providerStages), succeeded: boolean };
const metrics = object({
  preparation: object(preparationMetricFields),
  frontier: object(frontierMetricFields, frontierMetricOptional),
  scopeRelease: object(releaseMetricFields),
});
// The first-fault wire is stricter than legacy latest metrics. It was produced
// only by the current typed runtime, so missing current fields are invalid.
const firstFaultProviderStages = value => checkProviderStages(exactObject({ ...providerStageFields,
  inputBytes: integer, documentRegistrations: integer, registeredRenderBatches: integer, lastBatch: nullable(viewBatchDiagnostics),
}, { lastBatchBreakdown: nullable(viewBatchBreakdown) })(value));
const firstFaultMetricVariants = { prepare: preparationMetricFields,
  render: { ...frontierMetricFields, ...frontierMetricOptional }, release: releaseMetricFields };
const firstFaultProvider = exactObject({ lastBatch: nullable(viewBatchDiagnostics), lastBatchBreakdown: nullable(viewBatchBreakdown) });
const firstFaultIdentity = check(value => typeof value === 'string' && value.trim() === value &&
  value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value) && !/(?:github_pat_|gh[pousr]_)/i.test(value));
const firstFaultWitness = value => {
  const operation = oneOf(['prepare', 'render', 'release'])(value?.operation);
  const projected = exactObject({ faultSequence: oneOf(['1']), operationSequence: decimal,
    // Relative to this ViewExecution instance only. Never compare this with
    // native/process absolute clocks or relabel latest metrics as its source.
    monotonicElapsedNs: unsignedDecimal, operation: oneOf([operation]),
    metrics: exactObject({ ...firstFaultMetricVariants[operation], providerStages: nullable(firstFaultProviderStages) }),
    provider: firstFaultProvider,
  })(value);
  if (projected.metrics.succeeded) return invalid();
  const stages = projected.metrics.providerStages;
  for (const key of ['lastBatch', 'lastBatchBreakdown']) {
    if (JSON.stringify(projected.provider[key]) !== JSON.stringify(stages?.[key] ?? null)) return invalid();
  }
  return projected;
};
const viewFirstFaultDetails = exactObject({ schemaVersion, sessionId: firstFaultIdentity, witness: firstFaultWitness });
const acceptedPackIdentity = object({ root: hash, acceptedPackRevision: decimal, sessionId: text });
const opaqueId = check(value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value));
const acceptedPack = object({ projectId: opaqueId, generation: decimal, runId: opaqueId, root: hash });
const errorCode = check(value => typeof value === 'string' && /^ERR_[A-Z0-9_]+$/.test(value));
const attemptError = object({ code: errorCode }, { message: text });
const developmentAttempt = object({
  schemaVersion, projectId: opaqueId, runId: opaqueId,
  generation: decimal, targetRoot: hash, resolution: oneOf(['pending', 'terminal', 'unknown']),
  source: oneOf(['begin', 'apply', 'query', 'event', 'cancel']),
  observedAt: check(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))),
  receipt: object({
    schemaVersion, ownerId: decimal, attemptId: decimal,
    status: oneOf(['prepared', 'applying', 'accepted', 'rejected', 'cancelled']),
    operation: oneOf(['load', 'applyDevPack']), targetRoot: hash,
    expectedAccepted: nullable(acceptedPackIdentity), acceptedPackIdentity: nullable(acceptedPackIdentity),
    reloadKind: oneOf(['inPlace', 'restart']),
  }, { error: attemptError, observationErrors: list(object({ phase: text, code: errorCode }), 32) }),
}, { queryStatus: oneOf(['notRetained', 'notSeen']) });
const state = object({}, {
  schemaVersion, status: oneOf(['empty', 'ready', 'closing', 'closed']), engine: oneOf(['quickjs', 'v8']),
  sessionId: nullable(text), ownerId: decimal, page: nullable(page),
  acceptedPackIdentity: nullable(acceptedPackIdentity),
  executionHealth: nullable(health), viewExecutionMetrics: nullable(metrics),
  hostSurface: nullable(object({ ownerId: decimal, surfaceGeneration: decimal })),
  acceptedLayout: nullable(hostLayout), pendingHostLayout: nullable(observation),
  pendingNavigation: nullable(object({ schemaVersion, ticket: text, sessionId: text, root: hash, targetRoute: text, deadlineNs: decimal, chrome })),
  frameId: nullable(integer), frameRevision: integer, generation: integer,
  foreground: boolean, inputEnabled: boolean, presentationEnabled: boolean, presentationRequired: boolean,
  surface: nullable(text), previewOccluded: boolean, chromeGeometryReady: boolean,
  observedViewport: viewport, viewport, hostChrome: nullable(hostChrome), chrome,
});

// No state remains a valid pages-only legacy response. Unknown-only state is
// discarded; a malformed known field is rejected rather than silently trusted.
export function projectInspectorState(value) {
  if (value === undefined) return undefined;
  const projected = state(value);
  const firstFault = projected.executionHealth?.viewFault?.details;
  // Recognized native evidence must have an observable owner session and the
  // same sticky health disposition. Omitting the owner cannot bypass binding.
  if (firstFault && (projected.sessionId !== firstFault.sessionId ||
      projected.executionHealth.requiresRestart !== true)) return invalid();
  return Object.keys(projected).length ? projected : undefined;
}

// This is an SDK-produced receipt bound by the Player to a downloaded build,
// not a command or a user-supplied replacement for native execution evidence.
export function projectDevelopmentAttempt(value) {
  return value === undefined ? undefined : value === null ? null : developmentAttempt(value);
}

export function projectAcceptedPack(value) {
  return value === undefined ? undefined : value === null ? null : acceptedPack(value);
}
