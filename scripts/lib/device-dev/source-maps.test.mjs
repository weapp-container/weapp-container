import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceMapIndex, SOURCE_MAP_LIMITS } from './source-maps.mjs';

const hash = 'a'.repeat(64), unit = `modern:${'b'.repeat(64)}`, url = `weapp-view:///${unit}.js`;
const wire = values => Buffer.from(JSON.stringify({ version: 3, names: [], sources: ['../../src/home.ts'], mappings: 'AAAA,KACE;A', ...values }));
async function ordinary(values = {}, options = {}) {
  const bytes = wire(values), reads = [];
  const manifest = { modules: [{ id: 'module:pages/home/index.js' }], assets: [{ path: 'pages/home/index.js.map', sha256: hash }] };
  const index = await createSourceMapIndex(manifest, async (requested, limit) => {
    reads.push({ requested, limit });
    if (options.error) throw Object.assign(Error(), { reason: options.error });
    return bytes;
  });
  return { index, reads };
}

test('ordinary exact aliases resolve positions and retain generated and raw stack', async () => {
  const { index, reads } = await ordinary();
  const stack = 'Error: example\n at call (pages/home/index.js:1:7)\n at require (module:pages/home/index.js:1)';
  const details = { error: { code: 'ERR_ENGINE', stack } }, result = index.resolve(details);
  assert.equal(result.status, 'mapped'); assert.equal(details.error.stack, stack);
  assert.equal(result.frames[0].original.file, 'src/home.ts');
  assert.deepEqual(result.frames[0].original, { file: 'src/home.ts', line: 2, column: 3 });
  assert.match(result.mappedStack, /src\/home\.ts:2:3 \[generated pages\/home\/index\.js:1:7\]/);
  assert.deepEqual(result.frames[1].original, { file: 'src/home.ts', line: 1, column: 1 });
  assert.deepEqual(reads, [{ requested: hash, limit: SOURCE_MAP_LIMITS.mapBytes }]);
  assert.equal(index.resolve({ stack: 'at x (pages/home/index.js:2:1)' }).frames[0].reason, 'unmapped-segment');
});

test('modern maps use exact manifest source identities and the runtime wrapper offset', async () => {
  const manifest = { modernView: { units: [{ id: unit, sourceMapSha256: hash, sources: [{ path: 'view/main.view.ts' }] }] } };
  const index = await createSourceMapIndex(manifest, async () => wire({ sources: ['view/main.view.ts'] }));
  const result = index.resolve({ stack: `at read (${url}:4:7)` });
  assert.equal(result.status, 'mapped');
  assert.equal(result.mappedStack, `at read (view/main.view.ts:2:3 [generated ${url}:4:7])`);
  assert.equal(index.resolve({ stack: `at read (${url}:3:7)` }).status, 'unmapped');
  const already = `at read (view/main.view.ts:2:3 [generated ${url}:4:7])`;
  const repeated = index.resolve({ stack: already });
  assert.equal(repeated.mappedStack, already);
  assert.equal(repeated.frames.find(value => value.alreadyMapped)?.status, 'mapped');
});

test('structured exact locations map without inventing a stack or using basenames', async () => {
  const { index } = await ordinary();
  const result = index.resolve({ error: { file: 'pages/home/index.js', line: 1, column: 1 } });
  assert.equal(result.status, 'mapped'); assert.equal(result.mappedStack, undefined);
  for (const file of ['index.js', '/private/core/index.js', 'https://user:secret@host/index.js']) {
    assert.equal(index.resolve({ error: { file, line: 1 } }).frames[0].reason, 'unindexed-location');
  }
  assert.equal(index.resolve({ stack: 'at <input>:3' }).reason, 'no-location');
});

test('absolute URLs, traversal, sourceRoot and nonallowlisted modern labels fail closed', async () => {
  for (const sources of [['/private/core.rs'], ['https://host/private.js'], ['file:///core.rs'], ['../../../../core.rs'], ['../secret?token=x'], ['']]) {
    const { index } = await ordinary({ sources });
    const result = index.resolve({ stack: 'pages/home/index.js:1:1' });
    assert.equal(result.status, 'unmapped', JSON.stringify(sources));
    assert.equal(result.frames[0].reason, 'unsafe-source');
    assert.ok(!JSON.stringify(result).includes('core.rs'));
  }
  const { index } = await ordinary({ sourceRoot: '/Users/secret' });
  assert.equal(index.resolve({ stack: 'pages/home/index.js:1:1' }).frames[0].reason, 'unsupported-map');
  const modern = await createSourceMapIndex({ modernView: { units: [{ id: unit, sourceMapSha256: hash, sources: [{ path: 'view/safe.ts' }] }] } }, async () => wire({ sources: ['view/private.ts'] }));
  assert.equal(modern.resolve({ stack: `${url}:4:1` }).frames[0].reason, 'unsafe-source');
});

test('invalid source maps, missing or changed bytes never pretend to map', async () => {
  for (const mappings of ['?', 'g', 'AAAAAA', 'ADAA', 'DAAA', 'ggggggggggggggA', ',']) {
    const { index } = await ordinary({ mappings });
    assert.equal(index.resolve({ stack: 'pages/home/index.js:1:1' }).status, 'unmapped', mappings);
  }
  for (const value of [{ version: 2 }, { sections: [] }, { sources: [23] }, { mappings: 3 }, { names: null }]) {
    const { index } = await ordinary(value);
    assert.equal(index.resolve({ stack: 'pages/home/index.js:1:1' }).status, 'unmapped');
  }
  const { index } = await ordinary({}, { error: 'unavailable-map' });
  assert.equal(index.resolve({ stack: 'pages/home/index.js:1:1' }).frames[0].reason, 'unavailable-map');
  const missing = await createSourceMapIndex({}, async () => { throw Error('must not read'); });
  assert.equal(missing.resolve({ stack: 'pages/home/index.js:1:1' }).status, 'unmapped');
});

test('map, stack, frame, source and segment budgets are explicit', async () => {
  const oversized = await createSourceMapIndex({ modules: [{ id: 'module:x.js' }], assets: [{ path: 'x.js.map', sha256: hash }] }, async () => Buffer.alloc(SOURCE_MAP_LIMITS.mapBytes + 1));
  assert.equal(oversized.resolve({ stack: 'x.js:1:1' }).frames[0].reason, 'map-budget');
  const { index } = await ordinary();
  assert.equal(index.resolve({ stack: 'x'.repeat(SOURCE_MAP_LIMITS.stackBytes + 1) }).reason, 'stack-budget');
  assert.equal(index.resolve({ stack: 'pages/home/index.js:1:1\n'.repeat(SOURCE_MAP_LIMITS.frames + 1) }).reason, 'frame-budget');
  for (const value of [{ mappings: ';'.repeat(SOURCE_MAP_LIMITS.lines) }, { mappings: Array(SOURCE_MAP_LIMITS.segments + 1).fill('AAAA').join(',') }, { sources: Array(SOURCE_MAP_LIMITS.sources + 1).fill('x') }]) {
    const { index: bounded } = await ordinary(value);
    assert.equal(bounded.resolve({ stack: 'pages/home/index.js:1:1' }).status, 'unmapped');
  }
});

test('names, source text and map file fields are not exposed or trusted as aliases', async () => {
  const { index } = await ordinary({ names: ['secret-name'], sourcesContent: ['PRIVATE SOURCE TOKEN'], file: 'arbitrary.js', mappings: 'AAAAA' });
  const result = index.resolve({ stack: 'pages/home/index.js:1:1' });
  assert.equal(result.status, 'mapped');
  assert.ok(!JSON.stringify(result).includes('secret-name')); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(index.resolve({ stack: 'arbitrary.js:1:1' }).frames[0].reason, 'unindexed-location');
});

test('ambiguous aliases and too many maps do not select arbitrary mappings', async () => {
  const modules = Array(SOURCE_MAP_LIMITS.maps + 1).fill(null).map((_, i) => ({ id: `module:${i}.js` }));
  const assets = modules.map((_, i) => ({ path: `${i}.js.map`, sha256: hash })); let reads = 0;
  const index = await createSourceMapIndex({ modules, assets }, async () => { reads++; return wire({ sources: ['src.ts'], mappings: 'AAAA' }); });
  assert.equal(reads, SOURCE_MAP_LIMITS.maps);
  assert.equal(index.resolve({ stack: `${SOURCE_MAP_LIMITS.maps}.js:1:1` }).frames[0].reason, 'map-budget');
  const duplicate = await createSourceMapIndex({ modules: [modules[0], modules[0]], assets }, async () => wire({ sources: ['src.ts'], mappings: 'AAAA' }));
  assert.equal(duplicate.resolve({ stack: '0.js:1:1' }).frames[0].reason, 'ambiguous-map');
});
