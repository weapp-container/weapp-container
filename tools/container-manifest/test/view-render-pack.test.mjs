import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildManifest, canonicalize, sha256 } from '../src/index.mjs';

const fixtureUrl = new URL('../../../conformance/fixtures/isolated-view-render/', import.meta.url);

test('raw isolated View fixture deterministically packs to the shared render-program golden', async () => {
  const rawRoot = fileURLToPath(new URL('raw/', fixtureUrl));
  const result = await buildManifest(rawRoot, { compilerCommit: 'fixture-isolated-view-v1' });
  assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'), []);

  const render = JSON.parse(await readFile(new URL('render-case.json', fixtureUrl), 'utf8'));
  const wrapper = {
    schemaVersion: 1,
    manifest: result.manifest,
    blobs: Object.fromEntries([...result.blobs].map(([digest, bytes]) => [digest, bytes.toString('utf8')])),
    render,
  };
  const goldenBytes = await readFile(new URL('golden-program.json', fixtureUrl), 'utf8');
  assert.equal(goldenBytes, `${canonicalize(wrapper)}\n`, 'the test only compares; it never rewrites a golden');
  assert.deepEqual(JSON.parse(goldenBytes), wrapper);

  for (const [digest, bytes] of result.blobs) {
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(sha256(bytes), digest);
    assert.deepEqual(Buffer.from(wrapper.blobs[digest], 'utf8'), bytes, 'golden stores the original UTF-8 bytes');
  }
  const unsigned = { ...result.manifest, integrity: { algorithm: 'sha256', root: '' } };
  assert.equal(result.manifest.integrity.root, sha256(Buffer.from(canonicalize(unsigned), 'utf8')));
  assert.equal(result.manifest.compiler.commit, 'fixture-isolated-view-v1');
  assert.equal(result.manifest.modules.some(module => module.id.endsWith('.wxs')), false);
  assert.equal(result.manifest.assets.some(asset => asset.path.endsWith('.wxs')), false);
  assert.equal(Object.keys(result.manifest.capabilities).some(name => /wxs/i.test(name)), false);
  assert.deepEqual(result.manifest.modules.map(module => module.id), [
    'module:app.js', 'module:app.json', 'module:pages/index/index.js', 'module:pages/index/index.json',
  ]);

  const documents = new Map(result.manifest.templates.map(template => [template.id, template]));
  assert.deepEqual(documents.get('template:pages/index/index.wxml').wxsModules, {
    inlineTools: 'wxs:pages/index/index.wxml#inlineTools', tools: 'wxs:view/page.wxs',
  });
  assert.deepEqual(documents.get('template:templates/card.wxml').wxsModules, {
    tools: 'wxs:templates/card.wxml#tools',
  });
  assert.deepEqual(documents.get('template:fragments/section.wxml').wxsModules, {
    tools: 'wxs:view/include.wxs',
  });
  assert.deepEqual(documents.get('template:fragments/leaf.wxml').wxsModules, {
    tools: 'wxs:fragments/leaf.wxml#tools',
  });
  const modules = new Map(result.manifest.viewScripts.map(module => [module.id, module]));
  assert.deepEqual(modules.get('wxs:view/page.wxs').dependencies, ['wxs:view/dep.wxs']);
  assert.deepEqual(modules.get('wxs:view/include.wxs').dependencies, ['wxs:view/dep.wxs']);
  for (const module of modules.values()) {
    assert.equal(sha256(result.blobs.get(module.sha256)), module.sha256);
    for (const dependency of module.dependencies) assert.equal(modules.has(dependency), true);
  }
  const inline = modules.get('wxs:pages/index/index.wxml#inlineTools');
  assert.equal(wrapper.blobs[inline.sha256], 'module.exports.literal = 1 < 2 ? "{{notData}}" : "<tag>";');

  const page = documents.get(`template:${render.documentId}`);
  assert.ok(page, 'render entry must be an actual packed WXML document');
  const ast = JSON.parse(wrapper.blobs[page.wxmlAst.slice('sha256:'.length)]);
  const view = ast.nodes.find(node => node.kind === 'element' && node.tag === 'view');
  const repeat = view.children.find(node => node.directives?.forExpr);
  // Raw && is intentional. The parser currently preserves &amp; literally;
  // entity decoding still needs its own parser contract and official oracle.
  assert.deepEqual(repeat.directives, {
    ifExpr: 'row.visible && (true || tools.fail())', forExpr: 'rows',
    forItem: 'row', forIndex: 'position', forKey: 'id',
  });
  assert.deepEqual(render.data.rows.map(row => row.id), ['a', 'b', 'c']);
  assert.match(render.expectedText, /0=A:1;2=C:2;/);
  assert.match(render.expectedText, /\|safe\|isolated$/);
});
