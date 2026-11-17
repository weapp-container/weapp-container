import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildManifest, canonicalize, sha256 } from '../src/index.ts';

async function fixture(context, { app = {}, page = {}, config } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'weapp-rendering-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const raw = path.join(root, 'raw');
  await mkdir(path.join(raw, 'pages'), { recursive: true });
  await writeFile(path.join(raw, 'app.json'), JSON.stringify({ pages: ['pages/home', 'pages/other'], ...app }));
  await writeFile(path.join(raw, 'app.js'), 'App({});');
  for (const name of ['home', 'other']) {
    await writeFile(path.join(raw, `pages/${name}.js`), 'Page({});');
    await writeFile(path.join(raw, `pages/${name}.wxml`), '<view>hello</view>');
  }
  await writeFile(path.join(raw, 'pages/home.json'), JSON.stringify(page));
  if (config !== undefined) await writeFile(path.join(root, 'container.config.json'), JSON.stringify(config));
  return { root, raw };
}

const errors = result => result.diagnostics.filter(item => item.severity === 'error');

test('unconfigured packs keep their legacy schema and implicit Skia default', async context => {
  const { root, raw } = await fixture(context);
  const result = await buildManifest(raw, { project: root });
  assert.deepEqual(errors(result), []);
  assert.equal(result.manifest.schemaVersion, 1);
  assert.equal(result.manifest.rendering, undefined);
});

test('source app/page renderer maps to explicit v3 profiles without rewriting source bytes', async context => {
  const { raw } = await fixture(context, { app: { renderer: 'webview' }, page: { renderer: 'skyline' } });
  const before = await readFile(path.join(raw, 'pages/home.json'));
  const result = await buildManifest(raw);
  assert.deepEqual(errors(result), []);
  assert.equal(result.manifest.schemaVersion, 3);
  assert.deepEqual(result.manifest.rendering, { version: '1.0', default: 'webview',
    pages: { 'pages/home': 'skyline-compat', 'pages/other': 'webview' } });
  const module = result.manifest.modules.find(module => module.id === 'module:pages/home.json');
  assert.deepEqual(result.blobs.get(module.sha256), before);
  assert.deepEqual(await readFile(path.join(raw, 'pages/home.json')), before);
});

test('configured default preserves explicit source page renderer and configured page wins', async context => {
  const { root, raw } = await fixture(context, {
    app: { renderer: 'webview' }, page: { renderer: 'skyline' },
    config: { renderer: { default: 'skia' } },
  });
  const first = await buildManifest(raw, { project: root });
  assert.deepEqual(errors(first), []);
  assert.deepEqual(first.manifest.rendering.pages, { 'pages/home': 'skyline-compat', 'pages/other': 'skia' });
  await writeFile(path.join(root, 'container.config.json'), JSON.stringify({
    renderer: { default: 'skia', pages: { 'pages/home': 'webview' } },
  }));
  const second = await buildManifest(raw, { project: root });
  assert.deepEqual(errors(second), []);
  assert.equal(second.manifest.rendering.pages['pages/home'], 'webview');
  assert.notEqual(first.manifest.integrity.root, second.manifest.integrity.root);
  assert.equal(second.watchDependencies[0].path, await realpath(path.join(root, 'container.config.json')));
  assert.equal(second.watchDependencies[0].sha256, sha256(await readFile(path.join(root, 'container.config.json'))));
  const rootInput = { ...second.manifest, integrity: { algorithm: 'sha256', root: '' } };
  assert.equal(second.manifest.integrity.root, sha256(Buffer.from(canonicalize(rootInput))));
});

test('an explicit all-Skia profile is still a negotiated schema v3 requirement', async context => {
  const { root, raw } = await fixture(context, { config: { renderer: { default: 'skia' } } });
  const result = await buildManifest(raw, { project: root });
  assert.deepEqual(errors(result), []);
  assert.equal(result.manifest.schemaVersion, 3);
  assert.equal(result.manifest.rendering.default, 'skia');
});

test('renderer profiles and modern View coexist in one v3 pack', async context => {
  const { root, raw } = await fixture(context, { config: {
    renderer: { default: 'webview' },
    view: { documents: { 'pages/home.wxml': { mode: 'modern', modules: {} } } },
  } });
  const result = await buildManifest(raw, { project: root });
  assert.deepEqual(errors(result), []);
  assert.equal(result.manifest.schemaVersion, 3);
  assert.equal(result.manifest.rendering.default, 'webview');
  assert.equal(result.manifest.modernView.units.length, 1);
});

for (const config of [
  { renderer: 'webview' },
  { renderer: { default: 'skyline' } },
  { renderer: { pages: { 'pages/home.wxml': 'webview' } } },
  { renderer: { pages: { 'pages/missing': 'webview' } } },
  { renderer: { pages: { '../pages/home': 'webview' } } },
  { renderer: { pages: { 'pages/home': 'unknown' } } },
  { renderer: { fallback: 'skia' } },
]) {
  test(`invalid renderer configuration rejects: ${JSON.stringify(config)}`, async context => {
    const { root, raw } = await fixture(context, { config });
    const result = await buildManifest(raw, { project: root });
    assert.ok(errors(result).some(item => item.code === 'ERR_RENDERER_CONFIG'));
  });
}

test('invalid source renderer is rejected even if a container override is present', async context => {
  const { root, raw } = await fixture(context, { page: { renderer: 'unknown' }, config: { renderer: { default: 'skia' } } });
  const result = await buildManifest(raw, { project: root });
  assert.ok(errors(result).some(item => item.code === 'ERR_RENDERER_CONFIG' && item.path === 'pages/home.json'));
});

test('v3 schema requires rendering and permits optional modern View', async () => {
  const schema = JSON.parse(await readFile(new URL('../../../schemas/container-manifest-v3.schema.json', import.meta.url)));
  assert.equal(schema.properties.schemaVersion.const, 3);
  assert.ok(schema.required.includes('rendering'));
  assert.ok(!schema.required.includes('modernView'));
  assert.deepEqual(schema.$defs.rendererProfile.enum, ['skia', 'webview', 'skyline-compat']);
});
