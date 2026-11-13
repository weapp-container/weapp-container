import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { buildManifest, canonicalize, sha256 } from '../tools/container-manifest/src/index.ts';
import { compileWxsModule } from '../tools/container-manifest/src/wxs-compiler.ts';
import { compareDatatypeObservations, normalizeDatatypeObservation } from './wxs-datatype-observations.mjs';
import { datatypeRequests, verifiedOfficialObservations } from './wxs-datatype-differential.mjs';

const fixture = new URL('../conformance/fixtures/wxs-execution-oracle/', import.meta.url);
const source = name => readFile(new URL(name, fixture), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

test('observation fixture packs separate verified WXS graph and lexical alias owners', async () => {
  const result = await buildManifest(fileURLToPath(new URL('raw/', fixture)), { compilerCommit: 'fixture-wxs-oracle-v1' });
  assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'), []);
  const manifest = result.manifest;
  assert.equal(manifest.modules.some(module => module.id.endsWith('.wxs')), false);
  assert.equal(manifest.assets.some(asset => asset.path.endsWith('.wxs')), false);
  assert.ok(manifest.modules.some(module => module.id === 'module:app.js'));
  assert.ok(manifest.modules.some(module => module.id === 'module:pages/index/index.js'));
  assert.ok(manifest.modules.some(module => module.id === 'module:components/probe-shell/index.js'));
  assert.ok(manifest.modules.some(module => module.id === 'module:components/probe-no-slot/index.js'));
  const modules = new Map(manifest.viewScripts.map(module => [module.id, module]));
  assert.equal(modules.size, 9);
  for (const module of modules.values()) {
    assert.equal(sha256(result.blobs.get(module.sha256)), module.sha256);
    for (const dependency of module.dependencies) assert.ok(modules.has(dependency));
  }
  const owners = new Map(manifest.templates.map(document => [document.id, document.wxsModules]));
  assert.deepEqual(owners.get('template:pages/index/index.wxml'), {
    literal: 'wxs:pages/index/index.wxml#literal', tools: 'wxs:view/page.wxs',
  });
  assert.deepEqual(owners.get('template:templates/card.wxml'), { tools: 'wxs:templates/card.wxml#tools' });
  assert.deepEqual(owners.get('template:fragments/section.wxml'), { tools: 'wxs:fragments/section.wxml#tools' });
  assert.deepEqual(owners.get('template:fragments/leaf.wxml'), { tools: 'wxs:fragments/leaf.wxml#tools' });
  assert.deepEqual(owners.get('template:components/probe-shell/index.wxml'), { tools: 'wxs:view/component.wxs' });
  assert.deepEqual(owners.get('template:components/probe-no-slot/index.wxml'), { tools: 'wxs:view/no-slot.wxs' });
  assert.deepEqual(owners.get('template:pages/datatypes/index.wxml'), { types: 'wxs:view/datatypes.wxs' });
  for (const [id, module] of modules) {
    if (!id.endsWith('#literal') && !['wxs:view/shared.wxs', 'wxs:view/datatypes.wxs'].includes(id)) assert.deepEqual(module.dependencies, ['wxs:view/shared.wxs']);
  }
  const literal = result.blobs.get(modules.get('wxs:pages/index/index.wxml#literal').sha256).toString('utf8');
  assert.equal(literal, "exports.value = 1 < 2 ? '{{notData}}' : '<tag>';");
  const unsigned = { ...manifest, integrity: { algorithm: 'sha256', root: '' } };
  assert.equal(manifest.integrity.root, sha256(Buffer.from(canonicalize(unsigned), 'utf8')));
});

test('fixture covers slots, unused light nodes, branching and readonly history without official expected counters', async () => {
  const page = await source('raw/pages/index/index.wxml');
  const shell = await source('raw/components/probe-shell/index.wxml');
  const noSlot = await source('raw/components/probe-no-slot/index.wxml');
  assert.match(page, /id="light-header" slot="header"/);
  assert.match(page, /id="light-default"/);
  assert.match(page, /id="light-unused" slot="unused"/);
  assert.match(page, /id="light-without-slot"/);
  assert.match(page, /<text wx:if="\{\{phase === 'ready'\}\}" id="snapshot-ready">/, 'the readiness marker only exists after onReady changes phase');
  assert.match(page, /wx:if="\{\{showBranch\}\}"/);
  assert.match(page, /wx:for="\{\{rows\}\}".*wx:key="id"/);
  assert.match(shell, /<slot name="header"><text class="fallback-header">/);
  assert.match(shell, /<slot><text class="fallback-default">/);
  assert.doesNotMatch(noSlot, /<slot\b/);
  for (const name of ['page', 'component', 'no-slot']) {
    const wxs = await source('raw/view/' + name + '.wxs');
    assert.match(wxs, /exports\.history = function\(\) \{ return log\.join\('\|'\); \};/);
  }
  const scenarios = JSON.parse(await source('scenarios.json'));
  assert.equal(scenarios.status, 'unknown');
  assert.deepEqual(scenarios.baseline, { ide: '2.02.2608080', sdk: '3.17.3', renderer: 'webview' });
  assert.equal(scenarios.steps.filter(step => step.kind === 'relaunch').length, 1);
  assert.equal(scenarios.steps.filter(step => step.kind === 'file-edit').length, 1);
  assert.deepEqual(scenarios.steps.map(step => step.kind), [
    'capture', ...Array(13).fill('patch'), 'relaunch', 'file-edit',
  ], 'scenario order matches initial capture, ordered same-page patches, one relaunch and the WXSS file edit');
  assert.match(scenarios.expectations, /^None for WXS/);
});

test('fixture same-value/style patches have no hidden stamps and captures do not mutate AppService state', async () => {
  let app;
  let page;
  const applied = [];
  const context = vm.createContext({
    App: definition => { app = definition; },
    Page: definition => { page = definition; },
    getApp: () => app,
    wx: { getSystemInfoSync: () => ({ SDKVersion: 'local-structural-test-only' }) },
  });
  vm.runInContext(await source('raw/app.js'), context);
  vm.runInContext(await source('raw/pages/index/index.js'), context);
  page.setData = (patch, callback) => {
    applied.push(plain(patch));
    Object.assign(page.data, plain(patch));
    callback?.();
  };
  page.onLoad();
  page.onReady();
  const before = plain(page.snapshot());
  assert.equal(before.lifecycle[0].entry.hook, 'page.onLoad.before');
  assert.equal(before.lifecycle[0].entry.data.marker, 'BEFORE_ONLOAD', 'lifecycle snapshots preserve the pre-onLoad input');
  await page.applyStep('same-a-1');
  await page.applyStep('same-a-2');
  assert.deepEqual(applied.slice(-2), [{ marker: 'A' }, { marker: 'A' }]);
  await page.applyStep('to-b');
  await page.applyStep('back-to-a');
  assert.deepEqual(applied.slice(-2), [{ marker: 'B' }, { marker: 'A' }]);
  await page.applyStep('style-data');
  await page.applyStep('same-style-data');
  assert.deepEqual(applied.slice(-2), [{ background: '#ddeeff' }, { background: '#ddeeff' }]);
  const count = applied.length;
  const trace = plain(app.oracleTrace);
  const data = plain(page.data);
  page.snapshot();
  page.snapshot();
  assert.equal(applied.length, count);
  assert.deepEqual(plain(app.oracleTrace), trace);
  assert.deepEqual(plain(page.data), data);
  assert.throws(() => page.applyStep('not-a-scenario'), /Unknown oracle step/);
  const scenarios = JSON.parse(await source('scenarios.json'));
  for (const step of scenarios.steps.filter(step => step.kind === 'patch')) await page.applyStep(step.id);
});

test('runner starts no tooling without explicit --run and retains the fixed baseline and ownership boundary', async () => {
  const runner = fileURLToPath(new URL('./wxs-execution-oracle.ts', import.meta.url));
  const dry = spawnSync(process.execPath, ['--experimental-strip-types', runner], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(dry.error);
  assert.equal(dry.status, 0, dry.stderr);
  const report = JSON.parse(dry.stdout);
  assert.equal(report.status, 'unknown');
  assert.equal(report.ranOfficialOracle, false);
  const text = await readFile(runner, 'utf8');
  assert.equal((text.match(/await launchAutomator\(/g) || []).length, 1);
  assert.equal((text.match(/await miniProgram\.reLaunch\(/g) || []).length, 2, 'one legacy relaunch plus the serial isolated datatype case loop');
  assert.match(text, /await withMachineE2ELease/);
  assert.match(text, /await claimDevtoolsHost\(installation\.cliPath\)/);
  assert.match(text, /await import\('\.\.\/vendor\/weapp-vite\/e2e\/utils\/automator'\)/);
  assert.match(text, /toolInfo\.version !== baseline\.ide/);
  assert.match(text, /toolInfo\.SDKVersion !== baseline\.sdk/);
  assert.ok(text.indexOf('baselineVerified = true') > text.indexOf('toolInfo.SDKVersion !== baseline.sdk'));
  assert.match(text, /e2e-apps\/github-issues\/project\.config\.json/);
  assert.doesNotMatch(text, /appid:\s*['"]wx[a-f0-9]+/);
  assert.match(text, /project\.private\.config\.json/);
  assert.match(text, /cleanupOwnedDevtoolsProcesses\(\{ journalPath: journal \}\)/);
  assert.match(text, /quitClaimedDevtoolsHost\(host!\)/);
  assert.match(text, /miniProgram\.screenshot/);
  assert.match(text, /wxssRestored/);
  assert.match(text, /machineLeaseReleased/);
  assert.match(text, /environmentRestored/);
  assert.doesNotMatch(text, /miniProgram\.compile\(/);
});

test('datatype cases remain unknown, compile separately, and keep failures outside the old fixture', async () => {
  const cases = JSON.parse(await source('datatype-cases.json'));
  assert.equal(cases.status, 'unknown');
  assert.equal(cases.cases.length, 18);
  assert.equal(new Set(cases.cases.map(value => value.id)).size, cases.cases.length);
  assert.deepEqual(cases.cases.filter(value => value.kind === 'error-boundary').map(value => value.id), [
    'regexp-invalid-flags', 'regexp-duplicate-flags', 'regexp-invalid-pattern', 'regexp-nonstring-flags', 'regexp-modern-flags',
  ]);
  const wxs = await source('raw/view/datatypes.wxs');
  const compiled = compileWxsModule(wxs);
  assert.equal(typeof compiled.code, 'string');
  for (const testCase of cases.cases) assert.ok(wxs.includes("id === '" + testCase.id + "'"));
  assert.doesNotMatch(wxs, /\btry\s*\{|\bcatch\s*\(/, 'real WXS error boundaries are not hidden by unverified catch semantics');
  assert.doesNotMatch(await source('raw/pages/index/index.wxml'), /datatypes|types\.probe/);
  assert.deepEqual(JSON.parse(await source('raw/app.json')).pages, ['pages/index/index', cases.route]);
  assert.match(await source('raw/pages/datatypes/index.wxml'), /data-case="\{\{caseId\}\}" data-value="\{\{types\.probe\(caseId\)\}\}"/);
});

test('normalized values require a correlated fresh dataset and reported errors never become parity', () => {
  const value = (caseId, text) => normalizeDatatypeObservation(caseId, { dataset: { case: caseId, value: text } });
  const a = value('a', 'Number');
  const b = value('b', '');
  assert.equal(b.outcome, 'value', 'an empty actual value is observable');
  assert.equal(normalizeDatatypeObservation('a', { dataset: { case: 'old-page', value: 'Number' } }).outcome, 'unresolved');
  assert.equal(normalizeDatatypeObservation('a', { dataset: { case: 'a', value: 1 } }).outcome, 'unresolved');
  const error = normalizeDatatypeObservation('a', { errors: [{ message: 'render failed' }] });
  assert.equal(error.outcome, 'reported-error');
  assert.equal(compareDatatypeObservations([a], [a], [{ id: 'a' }]).status, 'matched');
  assert.equal(compareDatatypeObservations([a], [value('a', 'Object')], [{ id: 'a' }]).status, 'different');
  assert.equal(compareDatatypeObservations([error], [error], [{ id: 'a' }]).status, 'incomplete');
  assert.equal(compareDatatypeObservations([a], [error], [{ id: 'a' }]).status, 'different');
  assert.equal(compareDatatypeObservations([a], [], [{ id: 'a' }]).status, 'incomplete');
  assert.equal(compareDatatypeObservations([a, a], [a], [{ id: 'a' }]).status, 'incomplete');
  const contaminated = normalizeDatatypeObservation('a', { dataset: { case: 'a', value: 'Number' }, errors: [{}] });
  assert.equal(contaminated.outcome, 'value-with-errors');
  assert.equal(compareDatatypeObservations([contaminated], [contaminated], [{ id: 'a' }]).status, 'incomplete');
});

test('native dispatch isolates one fresh case and carries verified source/compiled blob closure', async () => {
  const result = await buildManifest(fileURLToPath(new URL('raw/', fixture)), { compilerCommit: 'fixture-wxs-oracle-v1' });
  const blobs = Object.fromEntries([...result.blobs].map(([hash, bytes]) => [`sha256:${hash}`, [...bytes]]));
  const requests = datatypeRequests(result.manifest, blobs, 'regexp-invalid-flags');
  assert.deepEqual(requests.map(value => value.op), ['app.init', 'app.lifecycle', 'page.push', 'render.commit', 'api.call']);
  assert.equal(requests[2].payload.path, 'pages/datatypes/index');
  assert.deepEqual(requests[2].payload.query, { caseId: 'regexp-invalid-flags' });
  assert.deepEqual(requests[3].payload.data, { caseId: 'regexp-invalid-flags', phase: 'ready' });
  assert.equal(requests[3].payload.templateId, 'template:pages/datatypes/index.wxml');
  assert.equal(requests[0].payload.modules.length, result.manifest.modules.length);
  for (const compiled of result.manifest.viewCompilation.modules) assert.ok(blobs[`sha256:${compiled.executableSha256}`]);
  assert.throws(() => datatypeRequests(result.manifest, {}, 'constructors'), /missing module bytes/);
});

test('official comparison rejects unverified baseline and mismatched source instead of trusting status', () => {
  const hashes = { 'raw/view/datatypes.wxs': 'a'.repeat(64) };
  const report = { schemaVersion: 1, scope: 'wxs-execution-observations', baseline: { ide: '2.02.2608080', sdk: '3.17.3', renderer: 'webview' },
    actualRuntime: { toolInfo: { version: '2.02.2608080', SDKVersion: '3.17.3' } }, baselineVerifiedAt: 'verified-time', fixtureSha256: hashes,
    datatypes: { schemaVersion: 1, observations: [{ status: 'observed', caseId: 'constructors',
      snapshot: { caseId: 'constructors', phase: 'ready', environment: { SDKVersion: '3.17.3' } },
      selector: { dataset: { case: 'constructors', value: 'Actual retained observation' } },
      normalized: normalizeDatatypeObservation('constructors', { dataset: { case: 'constructors', value: 'Actual retained observation' } }) }, { status: 'blocked' }] } };
  assert.equal(verifiedOfficialObservations(report, hashes).length, 1);
  assert.throws(() => verifiedOfficialObservations({ ...report, actualRuntime: null }, hashes), /actual IDE evidence/);
  assert.throws(() => verifiedOfficialObservations({ ...report, baselineVerifiedAt: undefined }, hashes), /baseline capture/);
  assert.throws(() => verifiedOfficialObservations(report, { different: 'source' }), /byte-identical/);
  const contaminated = structuredClone(report);
  contaminated.datatypes.observations[0].normalized.value = 'invented expected value';
  assert.throws(() => verifiedOfficialObservations(contaminated, hashes), /retained raw observation/);
});

test('native collector requires an explicit binary and never starts a build or IDE', async () => {
  const runner = fileURLToPath(new URL('./wxs-datatype-differential.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [runner, '--help'], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(help.error);
  assert.equal(help.status, 0);
  const missing = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(missing.error);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--simulator-bin/);
  const text = await readFile(runner, 'utf8');
  assert.doesNotMatch(text, /runner\.command\(['"]cargo|launchAutomator|claimDevtoolsHost|createBrowserTab/);
});
