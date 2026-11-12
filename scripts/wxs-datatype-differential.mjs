#!/usr/bin/env node
/** Collect the official raw fixture on native engines; never launches Cargo or an IDE. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '../tools/container-manifest/src/index.mjs';
import { createOwnedCommandRunner, matchedResponse, sha256, sourceHashes } from './simulator-cli-harness.mjs';
import { compareDatatypeObservations, normalizeDatatypeObservation } from './wxs-datatype-observations.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE = resolve(ROOT, 'conformance/fixtures/wxs-execution-oracle');
const BASELINE = { ide: '2.02.2608080', sdk: '3.17.3', renderer: 'webview' };
const ROUTE = 'pages/datatypes/index';
const envelope = (requestId, op, payload) => ({ protocolVersion: '1.0', sessionId: 'simulator-1', requestId, kind: 'request', op, payload });

export function datatypeRequests(manifest, blobs, caseId) {
  const modules = manifest.modules.map(module => ({ id: module.id, bytes: blobs[`sha256:${module.sha256}`] }));
  for (const module of modules) assert.ok(Array.isArray(module.bytes), `missing module bytes: ${module.id}`);
  const data = { caseId, phase: 'ready' };
  return [
    envelope('datatype-init', 'app.init', { modules, blobs }),
    envelope('datatype-launch', 'app.lifecycle', { event: 'launch', options: {} }),
    envelope('datatype-page', 'page.push', { path: ROUTE, query: { caseId }, data }),
    envelope('datatype-render', 'render.commit', { templateId: `template:${ROUTE}.wxml`, blobs,
      styleIds: manifest.styles.map(style => style.id), data, viewport: { width: 375, height: 667 }, frameId: 1 }),
    envelope('datatype-selector', 'api.call', { name: 'wx.createSelectorQuery', selector: '#datatype-result',
      all: false, operation: 'fields', fields: { dataset: true } }),
  ];
}

function retainDatatypeTrace(item, trace) {
  const records = trace.records ?? trace.events;
  item.traceSchemaVersion = trace.schemaVersion;
  // Retain failed startup and malformed-response evidence before validating it.
  // Only the verified blob payloads are compacted; responses remain unchanged.
  item.trace = Array.isArray(records) ? records.map(record => {
    if (!['app.init', 'render.commit'].includes(record?.request?.op)) return record;
    const payload = { ...record.request.payload };
    if ('blobs' in payload) payload.blobs = '[verified pack blobs]';
    if ('modules' in payload) payload.modules = '[verified manifest modules]';
    return { ...record, request: { ...record.request, payload } };
  }) : records;
  item.errors = Array.isArray(records) ? records.flatMap(record => Array.isArray(record?.response?.messages)
    ? record.response.messages.filter(message => message?.op === 'error' || message?.payload?.ok === false) : []) : [];
}

function datatypeResponse(trace, requestId, op) {
  assert.equal(trace.schemaVersion, 1, 'trace must use schema v1');
  const records = trace.records ?? trace.events;
  assert.ok(Array.isArray(records), 'trace must contain records');
  const matching = records.filter(record => record?.request?.requestId === requestId);
  assert.equal(matching.length, 1, `exactly one request record for ${requestId}`);
  const record = matching[0];
  assert.equal(record.request.protocolVersion, '1.0', `${requestId} request protocol`);
  assert.equal(record.request.kind, 'request', `${requestId} request kind`);
  assert.equal(record.request.sessionId, 'simulator-1', `${requestId} request session`);
  assert.equal(record.request.op, op, `${requestId} request op`);
  const messages = record.response?.messages?.filter(message => message.kind === 'response' && message.requestId === requestId);
  assert.equal(messages?.length, 1, `exactly one correlated runtime response for ${requestId}/${op}`);
  const message = messages[0];
  assert.equal(message.protocolVersion, '1.0', `${requestId} response protocol`);
  assert.equal(message.sessionId, 'simulator-1', `${requestId} response session`);
  assert.equal(message.op, op, `${requestId} response op`);
  return { request: record.request.payload, response: message.payload };
}

function renderBoundary(response, requestId) {
  if (response?.ok === true) return false;
  assert.equal(response?.ok, false, `${requestId} must return an explicit outcome`);
  assert.equal(response.error?.code, 'ERR_RENDER', `${requestId} must fail at the render boundary`);
  assert.equal(response.error?.request_id, requestId, `${requestId} error request identity`);
  assert.equal(typeof response.error?.message, 'string', `${requestId} error message`);
  assert.ok(response.error.message.length, `${requestId} error message must not be empty`);
  return true;
}

export function observeDatatypeTrace(trace, caseId, item = {}) {
  retainDatatypeTrace(item, trace);
  // app.init and launch failures are infrastructure/startup failures, never WXS observations.
  for (const [id, op] of [['datatype-init', 'app.init'], ['datatype-launch', 'app.lifecycle']]) {
    datatypeResponse(trace, id, op);
    matchedResponse(trace, id, op);
  }
  const page = datatypeResponse(trace, 'datatype-page', 'page.push');
  assert.equal(page.request.path, ROUTE);
  assert.deepEqual(page.request.query, { caseId });
  assert.deepEqual(page.request.data, { caseId, phase: 'ready' });
  const pageFailed = renderBoundary(page.response, 'datatype-page');
  if (!pageFailed) {
    assert.equal(page.response.page?.path, ROUTE);
    assert.deepEqual(page.response.page?.query, { caseId });
    assert.equal(page.response.page?.data?.caseId, caseId);
    assert.equal(page.response.page?.data?.phase, 'ready');
    assert.ok(Number.isSafeInteger(page.response.pageId) && page.response.pageId > 0, 'page.push page identity');
    assert.equal(page.response.page?.id, page.response.pageId);
  }
  const render = datatypeResponse(trace, 'datatype-render', 'render.commit');
  assert.equal(render.request.templateId, `template:${ROUTE}.wxml`);
  assert.deepEqual(render.request.data, { caseId, phase: 'ready' });
  const renderFailed = renderBoundary(render.response, 'datatype-render');
  if (!renderFailed) {
    assert.equal(render.response.committed, true, 'datatype render must commit its manifest frame');
    assert.equal(render.response.source, 'manifest');
    assert.equal(render.response.templateId, render.request.templateId);
    assert.equal(render.response.frameId, render.request.frameId);
  }
  const selector = datatypeResponse(trace, 'datatype-selector', 'api.call');
  assert.equal(selector.request.name, 'wx.createSelectorQuery');
  assert.equal(selector.request.selector, '#datatype-result');
  assert.equal(selector.request.operation, 'fields');
  assert.deepEqual(selector.request.fields, { dataset: true });
  if (selector.response?.ok === true) {
    assert.equal(selector.response.name, 'wx.createSelectorQuery');
    assert.equal(selector.response.selector, '#datatype-result');
    assert.equal(selector.response.count, 1, 'exactly one datatype result must be observed');
    item.dataset = selector.response.result?.dataset;
    assert.equal(item.dataset?.case, caseId, 'dataset must belong to the requested case');
    assert.equal(typeof item.dataset?.value, 'string', 'datatype value must be the actual string dataset');
  } else {
    assert.ok(pageFailed || renderFailed, 'selector failure needs an observed page/render boundary');
    renderBoundary(selector.response, 'datatype-selector');
    item.selectorError = selector.response.error;
  }
  item.normalized = normalizeDatatypeObservation(caseId, { dataset: item.dataset, errors: item.errors });
  item.status = item.normalized.outcome === 'unresolved' ? 'blocked' : 'observed';
  return item;
}

export function verifiedOfficialObservations(report, fixtureHashes) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.scope, 'wxs-execution-observations');
  assert.deepEqual(report.baseline, BASELINE);
  assert.equal(report.actualRuntime?.toolInfo?.version, BASELINE.ide, 'actual IDE evidence is required');
  assert.equal(report.actualRuntime?.toolInfo?.SDKVersion, BASELINE.sdk, 'actual SDK evidence is required');
  assert.equal(typeof report.baselineVerifiedAt, 'string', 'successful baseline capture is required');
  assert.equal(canonicalize(report.fixtureSha256), canonicalize(fixtureHashes), 'official and native fixtures must be byte-identical');
  assert.equal(report.datatypes?.schemaVersion, 1);
  assert.ok(Array.isArray(report.datatypes.observations));
  return report.datatypes.observations.filter(value => value.status === 'observed').map(value => {
    assert.equal(value.snapshot?.environment?.SDKVersion, BASELINE.sdk, 'each official case needs actual SDK evidence');
    assert.equal(value.snapshot?.phase, 'ready');
    assert.equal(value.snapshot?.caseId, value.caseId, 'official page must correlate to its requested case');
    assert.equal(value.normalized?.caseId, value.caseId);
    assert.equal(value.normalized?.schemaVersion, 1);
    assert.deepEqual(value.normalized, normalizeDatatypeObservation(value.caseId, {
      dataset: value.selector?.dataset, errors: [...(value.exceptions || []), ...(value.appErrors || [])],
    }), 'normalized official values must derive from the retained raw observation');
    return value.normalized;
  });
}

function options(argv) {
  const result = { out: resolve(ROOT, 'artifacts/wxs-datatype-differential.json'), timeoutMs: 120_000 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!['--out', '--simulator-bin', '--official-report', '--timeout'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (arg === '--timeout') result.timeoutMs = Number(value);
    else result[{ '--out': 'out', '--simulator-bin': 'simulatorBin', '--official-report': 'officialReport' }[arg]] = resolve(value);
  }
  if (!result.simulatorBin) throw new Error('--simulator-bin <fresh dual-engine binary> is required; this collector never builds implicitly');
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1_000) throw new Error('--timeout must be >= 1000 milliseconds');
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const config = options(argv);
  if (config.help) {
    process.stdout.write('Usage: node scripts/wxs-datatype-differential.mjs --simulator-bin <fresh-dual-engine-bin> [--official-report <report.json>] [--out <json>]\n');
    return;
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-wxs-datatypes-'));
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: config.timeoutMs });
  const report = { schemaVersion: 1, scope: 'wxs-datatype-differential', status: 'blocked', baseline: BASELINE,
    startedAt: new Date().toISOString(), engines: [], official: { status: 'unknown' }, cleanup: {},
    evidenceBoundary: 'Same raw observation fixture on native QuickJS/V8. Matching values are auxiliary evidence. Error equivalence requires reviewed error shapes; absent official observations remain unknown. Not GPU/device/seven-host/performance acceptance.' };
  try {
    report.sourceCommit = (await runner.command('git', ['rev-parse', 'HEAD'])).stdout.trim();
    report.workingTreeDirty = Boolean((await runner.command('git', ['status', '--short'])).stdout.trim());
    report.fixture = { path: relative(ROOT, FIXTURE), sha256: await sourceHashes(FIXTURE) };
    report.simulator = { path: config.simulatorBin, sha256: sha256(await readFile(config.simulatorBin)) };
    report.collectorSha256 = await sourceHashes(resolve(ROOT, 'tools/container-manifest/src'));
    report.runnerSha256 = Object.fromEntries(await Promise.all(['wxs-datatype-differential.mjs', 'wxs-datatype-observations.mjs']
      .map(async name => [name, sha256(await readFile(resolve(ROOT, 'scripts', name)))])));
    const cases = JSON.parse(await readFile(resolve(FIXTURE, 'datatype-cases.json'), 'utf8'));
    assert.deepEqual(cases.baseline, BASELINE);
    report.cases = cases;
    const compilerCommit = (await runner.command('git', ['-C', 'vendor/weapp-vite', 'rev-parse', 'HEAD'])).stdout.trim();
    const pack = resolve(temporary, 'pack');
    await runner.command(process.execPath, ['tools/container-manifest/bin/container-pack.mjs', resolve(FIXTURE, 'raw'), '--out', pack, '--compiler-commit', compilerCommit]);
    const manifestBytes = await readFile(resolve(pack, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    report.pack = { manifestSha256: sha256(manifestBytes), integrityRoot: manifest.integrity.root, compilerCommit };
    const blobs = {};
    for (const name of await readdir(resolve(pack, 'blobs/sha256'))) {
      const bytes = await readFile(resolve(pack, 'blobs/sha256', name));
      assert.equal(sha256(bytes), name);
      blobs[`sha256:${name}`] = [...bytes];
    }
    for (const engine of ['quickjs', 'v8']) {
      const observed = { engine, status: 'blocked', observations: [] };
      report.engines.push(observed);
      for (const testCase of cases.cases) {
        const item = { caseId: testCase.id, kind: testCase.kind, status: 'blocked' };
        observed.observations.push(item);
        const prefix = resolve(temporary, `${engine}-${testCase.id}`);
        try {
          await writeFile(`${prefix}.jsonl`, datatypeRequests(manifest, blobs, testCase.id).map(value => JSON.stringify(value)).join('\n') + '\n');
          let processError;
          try {
            const result = await runner.command(config.simulatorBin, ['dispatch', '--pack', pack, '--engine', engine,
              '--script', `${prefix}.jsonl`, '--trace', `${prefix}.trace.json`, '--report', `${prefix}.report.json`]);
            item.process = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'stdout'));
          } catch (error) { processError = error; if (error.result) item.process = error.result; }
          const trace = JSON.parse(await readFile(`${prefix}.trace.json`, 'utf8'));
          retainDatatypeTrace(item, trace);
          item.simulator = JSON.parse(await readFile(`${prefix}.report.json`, 'utf8'));
          if (processError) throw processError;
          assert.equal(item.simulator.engine, engine, 'requested native engine must not fall back');
          assert.equal(item.simulator.route, ROUTE);
          assert.equal(item.simulator.lifecycleState, 'Active');
          observeDatatypeTrace(trace, testCase.id, item);
        } catch (error) {
          item.error = error.stack ?? String(error);
          if (error.result) item.process = error.result;
          item.normalized = normalizeDatatypeObservation(testCase.id);
          if (runner.interrupted) throw error;
        }
      }
      observed.status = observed.observations.every(value => value.status === 'observed') ? 'observed' : 'blocked';
    }
    report.nativeComparison = compareDatatypeObservations(...report.engines.map(engine => engine.observations.map(item => item.normalized)), cases.cases);
    if (config.officialReport) {
      const bytes = await readFile(config.officialReport);
      const official = JSON.parse(bytes);
      report.official = { path: config.officialReport, sha256: sha256(bytes), status: 'verified-capture' };
      const normalized = verifiedOfficialObservations(official, report.fixture.sha256);
      report.official.comparisons = report.engines.map(engine => ({ engine: engine.engine,
        ...compareDatatypeObservations(normalized, engine.observations.map(item => item.normalized), cases.cases) }));
    }
    assert.equal(canonicalize(await sourceHashes(FIXTURE)), canonicalize(report.fixture.sha256), 'fixture changed during collection');
    report.status = report.engines.every(engine => engine.status === 'observed') ? 'observed' : 'blocked';
  } catch (error) {
    report.error = error.stack ?? String(error);
    if (error.result) report.failedProcess = error.result;
  } finally {
    report.cleanup.childProcessClosed = runner.active === null;
    try { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporaryRemoved = true; }
    catch (error) { report.cleanup.error = String(error); report.status = 'cleanup-failed'; }
    report.cleanup.noIdeBrowserOrListenerCreated = true;
    report.finishedAt = new Date().toISOString();
    runner.dispose();
    await mkdir(dirname(config.out), { recursive: true });
    await writeFile(config.out, JSON.stringify(report, null, 2) + '\n');
  }
  process.stdout.write(JSON.stringify({ status: report.status, report: config.out, nativeComparison: report.nativeComparison?.status,
    official: report.official.status, cleanup: report.cleanup }) + '\n');
  if (runner.interrupted) process.exitCode = runner.interrupted === 'SIGINT' ? 130 : 143;
  else if (report.status !== 'observed' || report.nativeComparison?.status === 'different'
      || report.official.comparisons?.some(value => value.status === 'different')) process.exitCode = 1;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
