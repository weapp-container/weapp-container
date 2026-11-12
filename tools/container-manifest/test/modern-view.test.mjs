import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildManifest, canonicalize, packContainer, sha256 } from '../src/index.mjs';

const page = 'pages/home/index.wxml';
const modern = modules => ({ mode: 'modern', modules });
const errors = result => result.diagnostics.filter(item => item.severity === 'error');
const plain = value => JSON.parse(JSON.stringify(value));

async function put(root, file, value) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
}

async function fixture(context, { documents = { [page]: modern({ fmt: 'format.view.ts' }) }, source = 'export const label = (name?: string) => name ?? "guest";', wxml = '<view>{{fmt.label(name)}}</view>' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'weapp-modern-view-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const raw = path.join(root, 'raw');
  await put(raw, 'app.json', { pages: ['pages/home/index'] });
  await put(raw, 'app.js', 'App({});');
  await put(raw, 'pages/home/index.js', 'Page({data:{name:"Ada"}});');
  await put(raw, page, wxml);
  await put(project, 'container.config.json', { view: { documents } });
  await put(project, 'format.view.ts', source);
  return { root, project, raw, build: options => buildManifest(raw, { project, ...options }) };
}

function execute(result, index = 0) {
  const unit = result.manifest.modernView.units[index];
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(result.blobs.get(unit.executableSha256).toString('utf8'), sandbox, { timeout: 1000 });
  return sandbox.module.exports;
}

test('erased TS types do not acquire runtime globals and namespace stays excluded', async context => {
  const f = await fixture(context, { source: `
    type Future = Promise<unknown>;
    type Environment = typeof globalThis;
    interface Shape { callback?: () => Future; environment?: Environment }
    export const label = (value: string | number): string => String(value);
  ` });
  const result = await f.build();
  assert.deepEqual(errors(result), []);
  assert.equal(execute(result)[page].fmt.label(42), '42');
  await put(f.project, 'format.view.ts', 'export namespace Helpers { export const value = 1; }');
  const rejected = await f.build();
  assert.equal(errors(rejected)[0].code, 'ERR_UNSUPPORTED_MODERN_VIEW_SYNTAX');
  assert.match(errors(rejected)[0].message, /namespace/);
});

test('npm conditional exports preserve import and require resolution independently', async context => {
  const f = await fixture(context, { source: `
    import { value as imported } from 'dual-package';
    const required = require('dual-package');
    export const label = () => imported + ':' + required.value;
  ` });
  await put(f.project, 'node_modules/dual-package/package.json', {
    name: 'dual-package', version: '1.2.3',
    exports: { import: './import.mjs', require: './require.cjs' },
  });
  await put(f.project, 'node_modules/dual-package/import.mjs', 'export const value = "import";');
  await put(f.project, 'node_modules/dual-package/require.cjs', 'module.exports = { value: "require" };');
  const result = await f.build();
  assert.deepEqual(errors(result), []);
  assert.equal(execute(result)[page].fmt.label(), 'import:require');
  const sources = result.manifest.modernView.units[0].sources.map(source => source.path);
  assert.ok(sources.includes('npm:dual-package@1.2.3/import.mjs'));
  assert.ok(sources.includes('npm:dual-package@1.2.3/require.cjs'));
});

test('ESM cycles retain temporal dead zones instead of exposing uninitialized undefined', async context => {
  const f = await fixture(context, { source: 'export { a as value } from "./a.js";' });
  await put(f.project, 'a.js', 'import { b } from "./b.js"; export const a = b;');
  await put(f.project, 'b.js', 'import { a } from "./a.js"; export const b = a;');
  const result = await f.build();
  assert.deepEqual(errors(result), []);
  assert.throws(() => execute(result), error => error.name === 'ReferenceError');
});

test('ordinary lexical temporal dead zones survive bundling', async context => {
  const f = await fixture(context, { source: `
    export function read() { return value; }
    export const early = read();
    const value = 1;
  ` });
  const result = await f.build();
  assert.deepEqual(errors(result), []);
  assert.throws(() => execute(result), error => error.name === 'ReferenceError');
});

test('native ESM conformance fixtures are exact public-compiler goldens with live bindings and TDZ', async () => {
  const project = fileURLToPath(new URL('./fixtures/modern-esm-conformance/', import.meta.url));
  for (const suffix of ['', '-tdz']) {
    const result = await buildManifest(path.join(project, `raw${suffix}`), { project,
      ...(suffix ? { configFile: 'container-tdz.config.json' } : {}) });
    assert.deepEqual(errors(result), []);
    const unit = result.manifest.modernView.units[0];
    assert.deepEqual(unit, JSON.parse(await readFile(path.join(project, `unit${suffix}.json`), 'utf8')));
    const executable = await readFile(path.join(project, `compiled${suffix}.cjs`));
    const sourceMap = await readFile(path.join(project, `compiled${suffix}.cjs.map`));
    assert.deepEqual(result.blobs.get(unit.executableSha256), executable);
    assert.deepEqual(result.blobs.get(unit.sourceMapSha256), sourceMap);
    assert.equal(sha256(executable), unit.executableSha256);
    assert.equal(sha256(sourceMap), unit.sourceMapSha256);
    for (const source of unit.sources) {
      const bytes = await readFile(path.join(project, source.path));
      assert.equal(sha256(bytes), source.sha256);
      assert.deepEqual(result.blobs.get(source.sha256), bytes);
    }
    if (suffix) {
      assert.throws(() => execute(result), error => error.name === 'ReferenceError');
    } else {
      const { tools, shared } = execute(result)['page.wxml'];
      assert.equal(shared.counter, 0);
      assert.equal(tools.exercise(), 'before=0;after=1;sum=6;unit=points;cycle=a:b:a');
      assert.equal(shared.counter, 1, 'the second alias observes the same ESM instance');
      assert.equal(shared.bump(), 2);
      assert.equal(tools.readImported(), 2, 'an imported export let stays live after another module writes');
      assert.equal(tools.exercise(), 'before=2;after=3;sum=6;unit=points;cycle=a:b:a');
      assert.equal(shared.counter, 3);
    }
  }
});

test('the performance fixture is an actual reproducible TypeScript compile with equivalent results', async () => {
  const project = fileURLToPath(new URL('./fixtures/modern-perf/', import.meta.url));
  for (const suffix of ['', '-js']) {
    const result = await buildManifest(path.join(project, 'raw'), { project,
      ...(suffix ? { configFile: 'container-js.config.json' } : {}) });
    assert.deepEqual(errors(result), []);
    const unit = result.manifest.modernView.units[0];
    assert.deepEqual(unit, JSON.parse(await readFile(path.join(project, `unit${suffix}.json`), 'utf8')));
    assert.deepEqual(result.blobs.get(unit.executableSha256), await readFile(path.join(project, `compiled${suffix}.cjs`)));
    assert.deepEqual(result.blobs.get(unit.sourceMapSha256), await readFile(path.join(project, `compiled${suffix}.cjs.map`)));
    const compiled = execute(result)['page.wxml'].tools.compute;
    for (const count of [17, 1000]) {
      const items = Array.from({ length: count }, (_, index) => ({ id: index, value: index + 1 }));
      const total = 3 * count * (count + 1) / 2;
      assert.deepEqual(plain(compiled({ items, factor: 3 })), { total, label: `sum:${total}`, count });
    }
  }
});

test('modern TS is an explicit schema-v2 pack with standard ECMAScript behavior and untouched raw output', async context => {
  const f = await fixture(context, { source: `
    export const label = (name?: string) => name ?? 'guest';
    export function inspect() {
      let reads = 0;
      const value = {get item() { reads++; return {name:'Ada'}; }};
      const {item: {name}} = value;
      const copy = {...value};
      const rows = [1,,3].map(x => x * 2);
      const closures = [];
      for (let i = 0; i < 3; i++) closures.push(() => i);
      class Box { constructor(public value: number) {} get doubled() { return this.value * 2; } }
      function* items() { yield 1; yield 2; }
      let total = 0; for (const item of items()) total += item;
      return {name, copy:copy.item.name, reads, optional:value?.item?.name ?? 'none',
        zero:0 ?? 9, constructors:[[].constructor === Array, ({}).constructor === Object],
        rows, hole:1 in rows, closures:closures.map(f => f()), box:new Box(4).doubled, total};
    }
  ` });
  const before = await readFile(path.join(f.raw, page));
  const result = await f.build();
  assert.deepEqual(errors(result), []);
  assert.equal(result.manifest.schemaVersion, 2);
  assert.equal(result.manifest.modernView.target, 'es2022');
  assert.equal(result.manifest.viewCompilation, undefined, 'modern expressions never enter the WXS helper ABI');
  assert.equal(result.manifest.modules.some(item => item.id.includes('.view.')), false);
  const modules = execute(result)[page];
  assert.equal(modules.fmt.label(), 'guest');
  assert.deepEqual(plain(modules.fmt.inspect()), { name: 'Ada', copy: 'Ada', reads: 2, optional: 'Ada', zero: 0,
    constructors: [true, true], rows: [2, null, 6], hole: false, closures: [0, 1, 2], box: 8, total: 3 });
  const unit = result.manifest.modernView.units[0];
  assert.match(unit.id, /^modern:[a-f0-9]{64}$/);
  assert.deepEqual(unit.documents, [{ documentId: page, aliases: ['fmt'] }]);
  for (const source of unit.sources) assert.equal(sha256(result.blobs.get(source.sha256)), source.sha256);
  const map = JSON.parse(result.blobs.get(unit.sourceMapSha256));
  assert.ok(map.sources.includes('format.view.ts'));
  assert.ok(map.sourcesContent.some(source => source.includes('name?: string')));
  assert.ok(map.mappings.length > 0);
  assert.equal(map.sources.length, map.sourcesContent.length);
  assert.ok(!JSON.stringify(map).includes(f.root));
  assert.ok(!JSON.stringify(map).includes(process.cwd()));
  assert.ok(!result.blobs.get(unit.executableSha256).toString().includes(f.root));
  const unsigned = { ...result.manifest, integrity: { algorithm: 'sha256', root: '' } };
  assert.equal(result.manifest.integrity.root, sha256(canonicalize(unsigned)));
  await packContainer(f.raw, path.join(f.root, 'pack'), { project: f.project });
  assert.deepEqual(await readFile(path.join(f.raw, page)), before);
  assert.deepEqual(await readdir(f.raw), ['app.js', 'app.json', 'pages']);
});

test('connected documents and aliases share live bindings and cycles; independent graphs stay isolated', async context => {
  const fragment = 'fragments/item.wxml';
  const separate = 'components/separate/index.wxml';
  const f = await fixture(context, { documents: {
    [page]: modern({ a: 'a.view.ts', b: 'b.view.js' }), [fragment]: modern({ c: 'a.view.ts' }),
    [separate]: modern({ a: 'a.view.ts' }),
  }, wxml: '<import src="../../fragments/item.wxml"/><view>{{a.next()}} {{b.read()}}</view>' });
  await put(f.raw, fragment, '<template name="item"><view>{{c.read()}}</view></template>');
  await put(f.raw, separate, '<view>{{a.read()}}</view>');
  await put(f.project, 'a.view.ts', 'export {next,read} from "./shared.ts"; import {fromB} from "./cycle-b.ts"; export const cycle=()=>fromB();');
  await put(f.project, 'b.view.js', 'export {read} from "./shared.ts";');
  await put(f.project, 'shared.ts', 'export let count = 0; export const next = () => ++count; export const read = () => count;');
  await put(f.project, 'cycle-a.ts', 'import {fromB} from "./cycle-b.ts"; export const fromA=()=>"a"; export const cycle=()=>fromB();');
  await put(f.project, 'cycle-b.ts', 'import {fromA} from "./cycle-a.ts"; export const fromB=()=>fromA()+"b";');
  const result = await f.build();
  assert.deepEqual(errors(result), []);
  assert.equal(result.manifest.modernView.units.length, 2);
  const sharedIndex = result.manifest.modernView.units.findIndex(unit => unit.documents.some(doc => doc.documentId === page));
  const scope = execute(result, sharedIndex);
  assert.equal(scope[page].a.next(), 1);
  assert.equal(scope[page].b.read(), 1);
  assert.equal(scope[fragment].c.read(), 1);
  assert.equal(scope[page].a.cycle(), 'ab');
  assert.equal(scope[page].a, scope[fragment].c, 'the same ESM entry keeps its namespace identity');
  assert.equal(execute(result, 1 - sharedIndex)[separate].a.read(), 0);
});

test('modern and legacy packs coexist with per-document expression policy and immutable v1 defaults', async context => {
  const f = await fixture(context);
  await put(f.raw, 'legacy/index.wxml', '<wxs module="old">module.exports={label:function(v){return v.constructor;}};</wxs><view>{{old.label(value)}}</view>');
  const result = await f.build();
  assert.deepEqual(errors(result), []);
  assert.deepEqual(result.manifest.viewCompilation.documents.map(doc => doc.documentId), ['legacy/index.wxml']);
  assert.deepEqual(result.manifest.viewScripts.map(module => module.id), ['wxs:legacy/index.wxml#old']);
  const rawOnly = await buildManifest(f.raw);
  assert.equal(rawOnly.manifest.schemaVersion, 1);
  assert.equal(rawOnly.manifest.modernView, undefined);
  await rm(path.join(f.project, 'container.config.json'));
  const noConfig = await f.build();
  assert.deepEqual(noConfig.manifest, rawOnly.manifest);
});

test('source and executable hashes are reproducible across project snapshots, including npm resolution', async context => {
  const f = await fixture(context, { source: 'import {double} from "sync-helper"; export const label=(n:number)=>double(n);' });
  await put(f.project, 'node_modules/sync-helper/package.json', { name: 'sync-helper', version: '1.2.3', type: 'module', exports: './index.js' });
  await put(f.project, 'node_modules/sync-helper/index.js', 'export const double = n => n * 2;');
  const first = await f.build();
  assert.deepEqual(errors(first), []);
  const snapshot = path.join(f.root, 'snapshot');
  await cp(f.project, snapshot, { recursive: true, filter: source => path.basename(source) !== 'node_modules' });
  const second = await buildManifest(f.raw, { project: snapshot, resolveRoot: f.project });
  assert.deepEqual(errors(second), []);
  assert.deepEqual(second.manifest, first.manifest, 'absolute source snapshot paths do not alter bundle/source-map bytes');
  assert.equal(execute(second)[page].fmt.label(4), 8);
  assert.ok(second.manifest.modernView.units[0].sources.some(source => source.path === 'npm:sync-helper@1.2.3/index.js'));
  const realProject = await realpath(f.project);
  const realSnapshot = await realpath(snapshot);
  assert.ok(second.watchDependencies.some(source => source.path === path.join(realProject, 'node_modules/sync-helper/index.js')));
  assert.ok(second.watchDependencies.some(source => source.path === path.join(realSnapshot, 'format.view.ts')));
  for (const source of second.watchDependencies) assert.equal(source.sha256, sha256(await readFile(source.path)));
});

test('JavaScript aliases resolve extensionless TypeScript helpers in live and frozen projects', async context => {
  const f = await fixture(context, { documents: { [page]: modern({ fmt: 'format.view.ts', stats: 'stats.view.js' }) },
    source: 'import {next} from "./shared"; export const label = () => next();',
    wxml: '<view>{{fmt.label()}}:{{stats.current()}}</view>' });
  await put(f.project, 'stats.view.js', 'export {current} from "./shared";');
  await put(f.project, 'shared.ts', 'let count: number = 0; export const next = (): number => ++count; export const current = (): number => count;');
  await put(f.project, 'tsconfig.json', { references: [{ path: './.weapp-vite/tsconfig.app.json' }], files: [] });
  await put(f.project, '.weapp-vite/tsconfig.app.json', { compilerOptions: { allowJs: true }, include: ['../**/*'] });
  const first = await f.build();
  assert.deepEqual(errors(first), []);
  const snapshot = path.join(f.root, 'snapshot');
  await cp(f.project, snapshot, { recursive: true, filter: source => path.basename(source) !== '.weapp-vite' });
  const second = await buildManifest(f.raw, { project: snapshot, resolveRoot: f.project });
  assert.deepEqual(errors(second), []);
  assert.deepEqual(second.manifest, first.manifest, 'helper resolution and emitted bytes are identical in a frozen source project');
  const { fmt, stats } = execute(second)[page];
  assert.equal(stats.current(), 0);
  assert.equal(fmt.label(), 1);
  assert.equal(stats.current(), 1, 'the JS and TS aliases share one live TypeScript dependency');
  const source = second.manifest.modernView.units[0].sources.find(source => source.path === 'shared.ts');
  assert.equal(source.sha256, sha256(await readFile(path.join(snapshot, 'shared.ts'))));
  const realSnapshot = await realpath(snapshot);
  assert.ok(second.watchDependencies.some(source => source.path === path.join(realSnapshot, 'shared.ts')));
});

test('ambient tsconfig path aliases do not redirect modern View module resolution', async context => {
  const f = await fixture(context, { source: 'import {label} from "view-helper"; export {label};' });
  await put(f.project, 'helpers/label.ts', 'export const label = (): string => "relative helper";');
  await put(f.project, 'tsconfig.json', { compilerOptions: { baseUrl: '.', paths: { 'view-helper': ['./helpers/label.ts'] } } });
  const rejected = await f.build();
  assert.equal(errors(rejected)[0].code, 'ERR_MODERN_VIEW_DEPENDENCY');
  assert.match(errors(rejected)[0].message, /cannot be linked: view-helper/);
  await put(f.project, 'format.view.ts', 'export {label} from "./helpers/label";');
  const accepted = await f.build();
  assert.deepEqual(errors(accepted), []);
  assert.equal(execute(accepted)[page].fmt.label(), 'relative helper');
});

test('module-less modern template data shorthand is validated and has complete provenance', async context => {
  const f = await fixture(context, { documents: { [page]: modern({}) }, wxml: '<template is="row" data="{{...record, name: user?.name ?? \'guest\'}}"/>' });
  const result = await f.build();
  assert.deepEqual(errors(result), []);
  assert.deepEqual(result.manifest.modernView.units[0].documents, [{ documentId: page, aliases: [] }]);
  assert.deepEqual(result.manifest.modernView.units[0].sources.map(source => source.path), ['container.config.json']);
  assert.deepEqual(plain(execute(result)[page]), {});
});

test('modern entry accepts the conventional ./ project prefix without allowing traversal', async context => {
  const f = await fixture(context, { documents: { [page]: modern({ fmt: './format.view.ts' }) } });
  const result = await f.build();
  assert.deepEqual(errors(result), []);
  assert.equal(execute(result)[page].fmt.label(), 'guest');
});

test('modern source IO and invalid UTF-8 use stable diagnostic codes and source paths', async context => {
  const f = await fixture(context);
  await writeFile(path.join(f.project, 'format.view.ts'), Buffer.from([0xff, 0xfe]));
  const invalid = await f.build();
  assert.ok(errors(invalid).some(item => item.code === 'ERR_MODERN_VIEW_DEPENDENCY' && item.path === 'format.view.ts'));
  await rm(path.join(f.project, 'format.view.ts'));
  const missing = await f.build();
  assert.ok(errors(missing).some(item => item.code === 'ERR_MODERN_VIEW_DEPENDENCY' && item.path === 'format.view.ts'));
});

test('JSON and synchronous CommonJS dependencies are linked into the closed View graph', async context => {
  const f = await fixture(context, { source: 'import data from "./labels.json"; import helper from "./helper.cjs"; export const label=()=>helper(data.title);' });
  await put(f.project, 'labels.json', { title: 'ready' });
  await put(f.project, 'helper.cjs', 'module.exports = function(value) { return value.toUpperCase(); };');
  const result = await f.build();
  assert.deepEqual(errors(result), []);
  assert.equal(execute(result)[page].fmt.label(), 'READY');
});

for (const [name, source] of Object.entries({
  async: 'export async function label(){return 1}', promise: 'export const label=()=>Promise.resolve(1)',
  await: 'export const label=await 1', dynamic: 'export const label=()=>import("./dep.ts")',
  network: 'export const label=()=>fetch("https://example.com")', appservice: 'export const label=()=>wx.getStorageSync("x")',
  node: 'import fs from "node:fs"; export const label=()=>fs.readFileSync("x")',
  native: 'import native from "./native.node"; export const label=()=>native()',
  require: 'const load=require; export const label=()=>load("./dep.ts")',
})) {
  test(`modern source ${name} fails explicitly before publication`, async context => {
    const f = await fixture(context, { source });
    await put(f.project, 'dep.ts', 'export const count=1;');
    await put(f.project, 'native.node', 'not a native module');
    const result = await f.build();
    assert.ok(errors(result).some(item => /^ERR_(?:UNSUPPORTED_MODERN_VIEW_SYNTAX|MODERN_VIEW_DEPENDENCY)$/.test(item.code)), result.diagnostics.map(item => item.message).join('\n'));
    await assert.rejects(packContainer(f.raw, path.join(f.root, 'failed-pack'), { project: f.project }), { code: 'ERR_INVALID_MANIFEST' });
    assert.equal(await readdir(f.root).then(files => files.includes('failed-pack')), false);
  });
}

test('modern WXML expression rejects async, dynamic imports, forbidden globals and multi-statement injection', async context => {
  const f = await fixture(context);
  for (const expression of ['Promise.resolve(1)', '(async()=>1)()', 'import("./dep.ts")', 'require("./dep.ts")', 'x); y = 1; (x']) {
    await put(f.raw, page, `<view>{{${expression}}}</view>`);
    const result = await f.build();
    assert.ok(errors(result).some(item => item.code === 'ERR_UNSUPPORTED_MODERN_VIEW_SYNTAX' && item.path === page), expression);
  }
});

test('modern configuration rejects cross-mode edges, WXS declarations, absent documents and escaping sources', async context => {
  const f = await fixture(context);
  for (const [documents, wxml, extra] of [
    [{ [page]: modern({ fmt: 'format.view.ts' }) }, '<include src="../../legacy.wxml"/>', ['legacy.wxml', '<view/>']],
    [{ [page]: modern({ fmt: 'format.view.ts' }) }, '<view/>', ['legacy.wxml', '<import src="pages/home/index.wxml"/>']],
    [{ [page]: modern({}) }, '<wxs module="old">module.exports={};</wxs><view/>'],
    [{ 'missing.wxml': modern({}) }, '<view/>'],
    [{ [page]: modern({ fmt: '../format.view.ts' }) }, '<view/>'],
    [{ [page]: modern({ 'bad-alias': 'format.view.ts' }) }, '<view/>'],
  ]) {
    await put(f.project, 'container.config.json', { view: { documents } });
    await put(f.raw, page, wxml);
    await rm(path.join(f.raw, 'legacy.wxml'), { force: true });
    if (extra) await put(f.raw, ...extra);
    const result = await f.build();
    assert.ok(errors(result).some(item => item.code === 'ERR_MODERN_VIEW_CONFIG'), JSON.stringify({ documents, wxml }));
  }
});

test('CLI writes structured modern build diagnostics and validates new option values', async context => {
  const f = await fixture(context, { source: 'export const label=()=>Promise.resolve(1)' });
  const cli = fileURLToPath(new URL('../bin/container-pack.mjs', import.meta.url));
  const report = path.join(f.root, 'error.json');
  const failed = spawnSync(process.execPath, [cli, f.raw, '--out', path.join(f.root, 'pack'), '--project', f.project, '--diagnostic-json', report], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  const diagnostic = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(diagnostic.code, 'ERR_INVALID_MANIFEST');
  assert.ok(diagnostic.diagnostics.some(item => /Promise/.test(item.message)
    && item.code === 'ERR_UNSUPPORTED_MODERN_VIEW_SYNTAX' && item.path === 'format.view.ts'
    && item.details.line === 1));
  const invalid = spawnSync(process.execPath, [cli, f.raw, '--out', path.join(f.root, 'pack'), '--project'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /--project requires a value/);
});

test('CLI writes resolved development dependencies only to an explicit sidecar', async context => {
  const f = await fixture(context);
  const cli = fileURLToPath(new URL('../bin/container-pack.mjs', import.meta.url));
  const report = path.join(f.root, 'watch.json');
  const output = path.join(f.root, 'pack');
  const packed = spawnSync(process.execPath, [cli, f.raw, '--out', output, '--project', f.project,
    '--watch-dependencies-json', report], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const dependencies = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(dependencies.schemaVersion, 1);
  const project = await realpath(f.project);
  assert.deepEqual(dependencies.sources.map(source => path.relative(project, source.path)), ['container.config.json', 'format.view.ts']);
  const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.ok(!JSON.stringify(manifest).includes(f.root));
  assert.equal(manifest.watchDependencies, undefined);
});
