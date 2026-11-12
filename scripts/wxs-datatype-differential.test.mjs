import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { datatypeRequests, observeDatatypeTrace } from './wxs-datatype-differential.mjs';
import { compareDatatypeObservations } from './wxs-datatype-observations.mjs';

const route = 'pages/datatypes/index';
const runtimeError = (requestId, code = 'ERR_RENDER') => ({ ok: false,
  error: { code, request_id: requestId, message: 'retained native render error', retryable: false } });
function fixture(caseId = 'constructors') {
  const requests = datatypeRequests({ modules: [], styles: [] }, {}, caseId);
  const payloads = [
    { ok: true }, { ok: true },
    { ok: true, pageId: 1, page: { id: 1, path: route, query: { caseId }, data: { caseId, phase: 'ready' } } },
    { ok: true, committed: true, source: 'manifest', frameId: 1, templateId: `template:${route}.wxml` },
    { ok: true, name: 'wx.createSelectorQuery', selector: '#datatype-result', count: 1,
      result: { dataset: { case: caseId, value: 'retained native value' } } },
  ];
  return { schemaVersion: 1, records: requests.map((request, index) => ({ request,
    response: { messages: [{ ...request, kind: 'response', payload: payloads[index] }] } })) };
}
const response = (trace, index) => trace.records[index].response.messages[0];
function errorFixture(caseId = 'regexp-invalid-flags') {
  const trace = fixture(caseId);
  for (const index of [2, 3, 4]) response(trace, index).payload = runtimeError(trace.records[index].request.requestId);
  return trace;
}

test('datatype render errors during page.push retain complete raw responses and remain incomparable', () => {
  const trace = errorFixture();
  const observed = observeDatatypeTrace(trace, 'regexp-invalid-flags');
  assert.equal(observed.status, 'observed');
  assert.equal(observed.normalized.outcome, 'reported-error');
  assert.equal(observed.errors.length, 3);
  assert.equal(observed.trace.length, 5);
  assert.deepEqual(observed.trace[2].response, trace.records[2].response);
  assert.deepEqual(observed.selectorError, response(trace, 4).payload.error);
  assert.equal(observed.trace[0].request.payload.blobs, '[verified pack blobs]');
  const comparison = compareDatatypeObservations([observed.normalized], [observed.normalized], [{ id: 'regexp-invalid-flags' }]);
  assert.equal(comparison.status, 'incomplete');
  assert.equal(comparison.cases[0].status, 'incomparable');
});

test('datatype startup failures retain traces but cannot become WXS observations', () => {
  for (const index of [0, 1]) {
    const trace = errorFixture();
    response(trace, index).payload = runtimeError(trace.records[index].request.requestId, 'ERR_ENGINE');
    const item = { status: 'blocked' };
    assert.throws(() => observeDatatypeTrace(trace, 'regexp-invalid-flags', item), /runtime must succeed/);
    assert.equal(item.status, 'blocked');
    assert.equal(item.normalized, undefined);
    assert.equal(item.trace.length, 5);
    assert.deepEqual(item.trace[index].response, trace.records[index].response);
    assert.equal(item.errors[0].payload.error.code, 'ERR_ENGINE');
  }
});

test('only correlated structured ERR_RENDER failures qualify as render-boundary observations', () => {
  const mutations = [
    trace => { response(trace, 2).payload.error.code = 'ERR_MODULE_LOAD'; },
    trace => { response(trace, 2).payload.error.request_id = 'other-request'; },
    trace => { response(trace, 2).sessionId = 'old-session'; },
    trace => { response(trace, 2).protocolVersion = '2.0'; },
    trace => { response(trace, 2).op = 'app.init'; },
    trace => { response(trace, 2).payload.error.message = ''; },
    trace => { response(trace, 2).payload.ok = null; },
    trace => { trace.records[2].response.messages.push(structuredClone(response(trace, 2))); },
    trace => { trace.records.push(structuredClone(trace.records[2])); },
    trace => { trace.records[2].request.payload.query.caseId = 'old-case'; },
    trace => { trace.records[2].request.payload.path = 'pages/wrong/index'; },
    trace => { trace.records[2].response.messages = []; },
  ];
  for (const mutate of mutations) {
    const trace = errorFixture();
    mutate(trace);
    const item = { status: 'blocked' };
    assert.throws(() => observeDatatypeTrace(trace, 'regexp-invalid-flags', item));
    assert.equal(item.status, 'blocked');
    assert.ok(item.trace.length >= 5, 'rejected evidence is retained for diagnosis');
    assert.equal(item.normalized, undefined);
  }
});

test('render-only errors are observable, while a selector failure alone is not a WXS boundary', () => {
  const trace = errorFixture();
  response(trace, 2).payload = response(fixture('regexp-invalid-flags'), 2).payload;
  assert.equal(observeDatatypeTrace(trace, 'regexp-invalid-flags').normalized.outcome, 'reported-error');
  response(trace, 3).payload = response(fixture('regexp-invalid-flags'), 3).payload;
  const item = { status: 'blocked' };
  assert.throws(() => observeDatatypeTrace(trace, 'regexp-invalid-flags', item), /selector failure needs/);
  assert.equal(item.trace.length, 5);
  assert.equal(item.normalized, undefined);
});

test('datatype values require a successful manifest frame and the exact fresh string dataset', () => {
  const observed = observeDatatypeTrace(fixture(), 'constructors');
  assert.equal(observed.normalized.outcome, 'value');
  assert.equal(observed.normalized.value, 'retained native value');
  const mutations = [
    trace => { response(trace, 4).payload.result.dataset.case = 'old-case'; },
    trace => { response(trace, 4).payload.result.dataset.value = 3; },
    trace => { response(trace, 4).payload.count = 0; },
    trace => { response(trace, 4).payload.selector = '#wrong-node'; },
    trace => { response(trace, 3).payload.committed = false; },
    trace => { response(trace, 3).payload.source = 'synthetic'; },
    trace => { response(trace, 3).payload.frameId = 99; },
    trace => { response(trace, 3).payload.templateId = 'template:old-page.wxml'; },
    trace => { response(trace, 2).payload.page.id = 7; },
  ];
  for (const mutate of mutations) {
    const trace = fixture();
    mutate(trace);
    assert.throws(() => observeDatatypeTrace(trace, 'constructors'));
  }
});

test('an actual value after an earlier render error remains contaminated and cannot match as parity', () => {
  const trace = fixture();
  response(trace, 2).payload = runtimeError('datatype-page');
  const observed = observeDatatypeTrace(trace, 'constructors');
  assert.equal(observed.normalized.outcome, 'value-with-errors');
  assert.equal(compareDatatypeObservations([observed.normalized], [observed.normalized], [{ id: 'constructors' }]).status, 'incomplete');
});

test('collector retains trace and startup errors even when its owned simulator process exits unsuccessfully', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-wxs-collector-test-'));
  try {
    const binary = resolve(temporary, 'simulator.mjs');
    const report = resolve(temporary, 'report.json');
    await writeFile(binary, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const option = name => process.argv[process.argv.indexOf(name) + 1];
const records = readFileSync(option('--script'), 'utf8').trim().split('\\n').map(line => {
  const request = JSON.parse(line);
  const payload = request.op === 'app.init'
    ? { ok: false, error: { code: 'ERR_ENGINE', request_id: request.requestId, message: 'native provider unavailable' } }
    : { ok: true };
  return { request, response: { messages: [{ ...request, kind: 'response', payload }] } };
});
writeFileSync(option('--trace'), JSON.stringify({ schemaVersion: 1, records }));
writeFileSync(option('--report'), JSON.stringify({ engine: option('--engine'), route: '${route}', lifecycleState: 'Active' }));
process.exitCode = 7;
`);
    await chmod(binary, 0o755);
    const runner = fileURLToPath(new URL('./wxs-datatype-differential.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [runner, '--simulator-bin', binary, '--out', report], { encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    const collected = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(collected.status, 'blocked');
    assert.equal(collected.official.status, 'unknown');
    for (const engine of collected.engines) for (const item of engine.observations) {
      assert.equal(item.status, 'blocked');
      assert.equal(item.process.exitCode, 7);
      assert.equal(item.trace.length, 5);
      assert.equal(item.errors[0].payload.error.code, 'ERR_ENGINE');
      assert.equal(item.normalized.outcome, 'unresolved');
    }
    assert.equal(collected.cleanup.childProcessClosed, true);
    assert.equal(collected.cleanup.temporaryRemoved, true);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
