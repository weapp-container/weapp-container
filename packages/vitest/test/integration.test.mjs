import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createContainer } from '@weapp-container/node';
import { buildWeappViteArtifact, watchWeappViteArtifact, disposeArtifact } from '@weapp-container/node/artifact';
import { weappContainerTest, ARTIFACT_KEY } from '../src/config.mjs';

async function project(t) {
  const root = await mkdtemp(fileURLToPath(new URL('./.tmp-', import.meta.url)));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL('../../node/test/fixture/', import.meta.url)), join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'project.config.json'), JSON.stringify({ appid: 'touristappid', compileType: 'miniprogram', miniprogramRoot: 'dist/' }));
  await writeFile(join(root, 'vite.config.mjs'), 'export default {weapp:{srcRoot:"src"},logLevel:"error"}');
  return root;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function deadline(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 30000); })]); }
  finally { clearTimeout(timer); }
}

test('actual weapp-vite compilation and watch publish immutable generations', { timeout: 90000 }, async t => {
  const root = await project(t);
  const generations = new Set();
  let updated = deferred();
  const failures = [];
  const watcher = await watchWeappViteArtifact({ cwd: root, skipNpm: true,
    onRebuilt(artifact) { generations.add(artifact); updated.resolve(artifact); },
    onError(error) { failures.push(error); updated.resolve({ error }); },
  });
  generations.add(watcher.artifact);
  const old = await createContainer({ pack: watcher.artifact.packPath });
  let next;
  try {
    const page = await old.renderPage('/pages/counter/index');
    const source = join(root, 'src/pages/counter/index.js');
    const original = await readFile(source, 'utf8');
    await writeFile(source, original.replace('count:0', 'count:8'));
    const artifact = await deadline(updated.promise, 'compiler did not rebuild');
    assert.equal(artifact.error, undefined);
    next = await createContainer({ pack: artifact.packPath });
    assert.equal(await (await next.renderPage('/pages/counter/index')).data('count'), 8);
    assert.equal(await page.data('count'), 0);
    updated = deferred();
    await writeFile(source, 'Page({ broken syntax');
    assert.ok((await deadline(updated.promise, 'compiler did not report invalid source')).error);
    assert.equal(await page.data('count'), 0);
    assert.equal(failures.length, 1);
  } finally {
    await Promise.all([old.dispose(), next?.dispose()]);
    await watcher.close();
    for (const artifact of watcher.generations) generations.add(artifact);
    for (const artifact of generations) await disposeArtifact(artifact);
  }
});

test('Vitest runs parallel isolated fixtures and releases the compiled generation', { timeout: 90000 }, async t => {
  const root = await project(t);
  await writeFile(join(root, 'vitest.config.mjs'), `
    import {weappContainerTest} from '@weapp-container/vitest/config';
    export default {plugins:[weappContainerTest({build:{cwd:${JSON.stringify(root)},skipNpm:true}})],
      test:{include:['runtime.spec.mjs'],environment:'node',testTimeout:15000}};
  `);
  await writeFile(join(root, 'runtime.spec.mjs'), `
    import {test,expect} from '@weapp-container/vitest';
    test.concurrent.for([1,2,3])('isolated process %s',async (index,{container})=>{
      const page=await container.renderPage('/pages/counter/index');
      expect(await page.data('count')).toBe(0);
      await (await page.query('#increment')).tap();
      expect(await page.data('count')).toBe(1);
    });
  `);
  const cli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, 'run', '--config', join(root, 'vitest.config.mjs'), '--root', root], { timeout: 60000, maxBuffer: 1024 * 1024 });
  assert.match(stdout + stderr, /3 passed/);
});

test('plugin publishes failures, scopes reruns, and waits for active reruns before cleanup', async t => {
  const root = await project(t);
  const first = await buildWeappViteArtifact({ cwd: root, skipNpm: true });
  const second = await buildWeappViteArtifact({ cwd: root, skipNpm: true });
  let callbacks, close, provided, builds = 0, watcherClosed = false;
  const running = deferred();
  const started = deferred();
  const projectObject = { provide(key, value) { assert.equal(key, ARTIFACT_KEY); provided = value; } };
  const spec = { project: projectObject };
  const errors = [];
  const plugin = weappContainerTest({ artifact: {
    build() { throw new Error('watch should share its initial build'); },
    watch(value) { callbacks = value; builds++; return { artifact: first, close() { watcherClosed = true; } }; },
  } });
  await plugin.configureVitest({ project: projectObject, vitest: {
    config: { watch: true }, onClose(fn) { close = fn; }, state: { catchError(error) { errors.push(error); } }, logger: { printError() {} },
    async globTestSpecifications() { return [spec, { project: {} }]; },
    async rerunTestSpecifications(specs) { assert.deepEqual(specs, [spec]); started.resolve(); await running.promise; },
  } });
  assert.equal(builds, 1);
  assert.equal(provided.artifact, first);
  callbacks.onError(new Error('compile failed'));
  assert.match(provided.error, /compile failed/);
  assert.equal(errors.length, 1);
  const update = callbacks.onRebuilt(second);
  await started.promise;
  assert.equal(provided.artifact, second);
  let finished = false;
  const closing = close().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  running.resolve();
  await update; await closing;
  assert.equal(watcherClosed, true);
  await assert.rejects(readFile(join(first.packPath, 'manifest.json')), { code: 'ENOENT' });
});


test('separate Vitest projects receive distinct artifacts and runtime options', { timeout: 90000 }, async t => {
  const root = await project(t);
  await writeFile(join(root, 'vitest.config.mjs'), `
    import {weappContainerTest} from '@weapp-container/vitest/config';
    export default {test:{projects:[1000,2000].map(now=>({
      plugins:[weappContainerTest({build:{cwd:${JSON.stringify(root)},skipNpm:true},container:{nowMs:now}})],
      test:{name:String(now),root:${JSON.stringify(root)},include:['project.spec.mjs'],environment:'node',provide:{expectedNow:now}}
    }))}};
  `);
  await writeFile(join(root, 'project.spec.mjs'), `
    import {test,expect} from '@weapp-container/vitest';
    import {inject} from 'vitest';
    test('project options stay local',async({container})=>{
      const page=await container.renderPage('/pages/counter/index');
      expect((await page.callMethod('readClock')).now).toBe(inject('expectedNow'));
    });
  `);
  const cli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, 'run', '--config', join(root, 'vitest.config.mjs'), '--root', root], { timeout: 60000, maxBuffer: 1024 * 1024 });
  assert.match(stdout + stderr, /2 passed/);
});

test('Vitest watch actually reruns against the newly compiled generation', { timeout: 90000 }, async t => {
  const root = await project(t);
  await writeFile(join(root, 'vitest.config.mjs'), `
    import {weappContainerTest} from '@weapp-container/vitest/config';
    export default {plugins:[weappContainerTest({build:{cwd:${JSON.stringify(root)},skipNpm:true}})],
      test:{include:['watch.spec.mjs'],environment:'node'}};
  `);
  await writeFile(join(root, 'watch.spec.mjs'), `
    import {writeFile} from 'node:fs/promises';
    import {test,expect} from '@weapp-container/vitest';
    test('observes current generation',async({container})=>{
      const page=await container.renderPage('/pages/counter/index');
      const count=await page.data('count');
      expect(typeof count).toBe('number');
      await writeFile(${JSON.stringify(join(root, 'observed.json'))},JSON.stringify(count));
    });
  `);
  await writeFile(join(root, 'driver.mjs'), `
    import assert from 'node:assert/strict';
    import {readFile,writeFile} from 'node:fs/promises';
    import {createVitest} from 'vitest/node';
    let notify;
    const reporter={onTestRunEnd(modules,errors){assert.equal(errors.length,0);notify?.();}};
    const runner=await createVitest({root:${JSON.stringify(root)},config:${JSON.stringify(join(root, 'vitest.config.mjs'))},watch:true,reporters:[reporter]});
    try {
      await runner.start();
      assert.equal(JSON.parse(await readFile(${JSON.stringify(join(root, 'observed.json'))},'utf8')),0);
      let timer;
      const rerun=new Promise((resolve,reject)=>{notify=resolve;timer=setTimeout(()=>reject(new Error('No watch rerun')),20000)});
      const source=${JSON.stringify(join(root, 'src/pages/counter/index.js'))};
      await writeFile(source,(await readFile(source,'utf8')).replace('count:0','count:6'));
      try{await rerun;}finally{clearTimeout(timer);}
      assert.equal(JSON.parse(await readFile(${JSON.stringify(join(root, 'observed.json'))},'utf8')),6);
    } finally {await runner.close();}
    console.log('Watch generation rerun passed');
  `);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(root, 'driver.mjs')], { timeout: 60000, maxBuffer: 1024 * 1024 });
  assert.match(stdout + stderr, /Watch generation rerun passed/);
});
