#!/usr/bin/env node
// Install only tarballs outside the source tree; npm scripts are disabled, and
// the consumer never calls cargo. This catches missing payloads and exports.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packArtifact, disposeArtifact } from '@weapp-container/node/artifact';
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'weapp-container-install-'));
const artifact = await packArtifact({ projectPath: resolve(root, 'packages/node/test/fixture') });
function run(command, args, cwd) { return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }); }
try {
  const tarballs = [];
  const packages = ['tools/container-manifest', `packages/runtime/${process.platform}-${process.arch}`, 'packages/node', 'packages/vitest', 'tools/host-services-reference'];
  for (const path of packages) {
    const output = run('pnpm', ['pack', '--pack-destination', temp], resolve(root, path));
    const name = output.trim().split('\n').findLast(line => line.endsWith('.tgz'));
    assert.ok(name, output);
    const tarball = resolve(root, path, name);
    const entries = run('tar', ['-tzf', tarball], root).trim().split('\n');
    assert.ok(entries.includes(path.startsWith('packages/runtime/') ? 'package/RUNTIME-LICENSE' : 'package/LICENSE'), `${path}: missing license`);
    if (!path.startsWith('packages/runtime/')) {
      assert.ok(entries.some(entry => entry.startsWith('package/dist/') && entry.endsWith('.d.mts')), `${path}: missing generated declarations`);
      assert.ok(!entries.some(entry => /^package\/(?:src|test|test-d)\//.test(entry)), `${path}: published source or tests`);
    }
    tarballs.push(tarball);
  }
  const consumer = join(temp, 'consumer');
  await mkdir(consumer);
  const manifests = await Promise.all(packages.map(async path => JSON.parse(await readFile(resolve(root, path, 'package.json'), 'utf8'))));
  const vitest = JSON.parse(await readFile(resolve(root, 'packages/vitest/node_modules/vitest/package.json'), 'utf8'));
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
    ...Object.fromEntries(manifests.map((pkg, i) => [pkg.name, `file:${tarballs[i]}`])), vitest: vitest.version,
  } }));
  run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], consumer);
  await cp(artifact.packPath, join(consumer, 'pack'), { recursive: true });
  await cp(artifact.sourceRoot, join(consumer, 'source'), { recursive: true });
  // Resolve both CLI bins from the external installation, with no source adapter.
  console.log(run(join(consumer, 'node_modules/.bin/container-pack'), ['source', '--out', 'cli-pack'], consumer).trim());
  await readFile(join(consumer, 'cli-pack/manifest.json'));
  await writeFile(join(consumer, 'host-config.mjs'), 'export default {port:0,host:"127.0.0.1",identitySecret:"i".repeat(32),issuerSecret:"s".repeat(32),applications:[]};\n');
  await writeFile(join(consumer, 'cli-test.mjs'), `
    import assert from 'node:assert/strict';
    import {spawn} from 'node:child_process';
    import {once} from 'node:events';
    const child=spawn('./node_modules/.bin/weapp-host-services',[],{env:{...process.env,HOST_SERVICES_CONFIG:'host-config.mjs'},stdio:['ignore','pipe','pipe']});
    let output='';let errors='';
    child.stdout.on('data',chunk=>{output+=chunk});child.stderr.on('data',chunk=>{errors+=chunk});
    const exit=once(child,'exit');
    const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
    try {
      await new Promise((resolve,reject)=>{
        child.stdout.on('data',()=>{if(output.includes('listening on'))resolve()});
        child.once('exit',()=>reject(new Error(errors||'CLI exited before listening')));
        child.once('error',reject);
      });
      const address=output.match(/listening on ([^\\s]+)/)[1];
      const response=await fetch('http://'+address+'/missing');
      assert.equal(response.status,404);
      child.kill('SIGTERM');
      const [code,signal]=await exit;assert.equal(code,0);assert.equal(signal,null);
      console.log('Installed host-services CLI started and shut down');
    } finally {clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit}}
  `);
  await writeFile(join(consumer, 'test.mjs'), `
    import assert from 'node:assert/strict';
    import {createContainer,resolveTestBinary} from '@weapp-container/node';
    assert.ok(resolveTestBinary().includes('node_modules/@weapp-container/runtime-'));
    const c=await createContainer({pack:new URL('./pack',import.meta.url).pathname});
    try {const p=await c.renderPage('/pages/counter/index'); await(await p.query('#increment')).tap(); assert.equal(await p.data('count'),1);}
    finally {await c.dispose();}
    console.log('Installed tarball executed real QuickJS without Rust');
  `);
  const env = { ...process.env };
  delete env.WEAPP_CONTAINER_TEST_BINARY;
  console.log(execFileSync(process.execPath, ['test.mjs'], { cwd: consumer, env, encoding: 'utf8' }).trim());
  await writeFile(join(consumer, 'test.cjs'), `
    const assert=require('node:assert/strict');
    const {createContainer,resolveTestBinary}=require('@weapp-container/node');
    const {packArtifact,disposeArtifact}=require('@weapp-container/node/artifact');
    assert.ok(resolveTestBinary().includes('node_modules/@weapp-container/runtime-'));
    (async()=>{
      const artifact=await packArtifact({projectPath:require('node:path').resolve('source'),miniprogramRootPath:require('node:path').resolve('source')});
      const c=await createContainer({pack:artifact.packPath});
      try {const p=await c.renderPage('/pages/counter/index');await(await p.query('#increment')).tap();assert.equal(await p.data('count'),1);}
      finally {await c.dispose();await disposeArtifact(artifact);}
      console.log('Installed CJS SDK and artifact exports executed real QuickJS');
    })().catch(error=>{console.error(error);process.exitCode=1});
  `);
  console.log(execFileSync(process.execPath, ['test.cjs'], { cwd: consumer, env, encoding: 'utf8' }).trim());
  console.log(execFileSync(process.execPath, ['cli-test.mjs'], { cwd: consumer, env, encoding: 'utf8' }).trim());
  await writeFile(join(consumer, 'vitest.config.mjs'), `
    import {defineConfig} from 'vitest/config';
    import {weappContainerTest} from '@weapp-container/vitest/config';
    export default defineConfig({
      plugins:[weappContainerTest({artifact:{build:()=>({
        packPath:new URL('./pack',import.meta.url).pathname,
        sourceRoot:new URL('./source',import.meta.url).pathname,
      })}})],
      test:{environment:'node',include:['sample.test.mjs']},
    });
  `);
  await writeFile(join(consumer, 'sample.test.mjs'), `
    import {test,expect} from '@weapp-container/vitest';
    test('installed fixture drives the packaged runtime',async({container})=>{
      const page=await container.renderPage('/pages/counter/index');
      await(await page.query('#increment')).tap();
      expect(await page.data('count')).toBe(1);
    });
  `);
  await writeFile(join(consumer, 'run-vitest.mjs'), `
    import assert from 'node:assert/strict';
    import {startVitest} from 'vitest/node';
    const runner=await startVitest('test',[],{config:'vitest.config.mjs',run:true});
    assert.ok(runner);
    try {assert.equal(runner.state.getTestModules().length,1);assert.equal(runner.state.getCountOfFailedTests(),0);assert.equal(runner.state.getUnhandledErrors().length,0);}
    finally {await runner.close();}
  `);
  console.log(execFileSync(process.execPath, ['run-vitest.mjs'], { cwd: consumer, env, encoding: 'utf8' }).trim());
} finally {
  await disposeArtifact(artifact);
  await rm(temp, { recursive: true, force: true });
}
