import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { conformanceArtifactReference } from './conformance-recipes.mjs'
import { executeMatrixDriver } from './conformance-matrix-runner.mjs'

const entry = fileURLToPath(new URL('./conformance-matrix-driver.mjs', import.meta.url))

async function fixture(t, source, inputs = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'matrix-disposal-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const module = resolve(directory, 'driver.mjs')
  await writeFile(module, source)
  for (const [name, text] of Object.entries(inputs)) await writeFile(resolve(directory, name), text)
  return { directory, module }
}

async function runChild(t, setup, allowed = [], onStarted) {
  const request = resolve(setup.directory, 'request.json')
  const result = resolve(setup.directory, 'result.json')
  await writeFile(request, JSON.stringify({ driverModule: setup.module,
    driverModules: [setup.module, ...allowed.map(path => resolve(setup.directory, path))],
    driverInputs: await Promise.all([setup.module, ...allowed.map(path => resolve(setup.directory, path))].map(async file => { const bytes = await readFile(file); return {file,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length} })),
    context: { outputDirectory: setup.directory, job: { caseId: 'ide-driver-test', host: 'web', engine: 'quickjs' } } }))
  const child = spawn(process.execPath, [entry, request, result], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', bytes => { output += bytes })
  child.stderr.on('data', bytes => { output += bytes })
  const closed = new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => accept({ code, signal }))
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
  t.after(async () => {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  if (onStarted) await onStarted(child, setup.directory)
  const exit = await closed
  clearTimeout(timeout)
  assert.equal(exit.signal, null, output)
  return { ...exit, value: JSON.parse(await readFile(result, 'utf8')), output }
}

async function interruptWhenReady(child, directory) {
  const deadline = Date.now() + 5000
  while (true) {
    try { await access(resolve(directory, 'ready')); break }
    catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error }
    await new Promise(accept => setTimeout(accept, 10))
  }
  child.kill('SIGTERM')
}

test('driver closure admits declared transitive module bytes and rejects undeclared imports before run', async t => {
  const setup = await fixture(t, `import { candidate } from './helper.mjs';
export const run=async()=>candidate;
export const dispose=async()=>({ownedResourcesReleased:true,borrowedResourcesPreserved:true});`, {
    'helper.mjs': `export const candidate={sentinel:'declared helper'};`,
  })
  const admitted = await runChild(t, setup, ['helper.mjs'])
  assert.equal(admitted.code, 0)
  assert.equal(admitted.value.candidate.sentinel, 'declared helper')
  // Fresh request/result identities: each child owns a separate output folder.
  const rejectedSetup = await fixture(t, `import './helper.mjs';
import {writeFile} from 'node:fs/promises';
export async function run({outputDirectory}){await writeFile(outputDirectory+'/ran','unexpected')}
export const dispose=async()=>({ownedResourcesReleased:true,borrowedResourcesPreserved:true});`, {
    'helper.mjs': `export const ignored=true;`,
  })
  const rejected = await runChild(t, rejectedSetup)
  assert.equal(rejected.code, 1)
  assert.match(rejected.value.error, /outside its snapshot closure/)
  assert.equal(rejected.value.candidate, undefined)
  assert.deepEqual(rejected.value.cleanup, { ownedResourcesReleased: false, borrowedResourcesPreserved: false })
  await assert.rejects(access(resolve(rejectedSetup.directory, 'ran')), { code: 'ENOENT' })
})

test('a completed candidate stays failed when disposal throws, retaining the cleanup failure', async t => {
  const setup = await fixture(t, `export const run=async()=>({unadmitted:'candidate'});
export async function dispose(){throw new Error('owned device release failed')}`)
  const result = await runChild(t, setup)
  assert.equal(result.code, 1)
  assert.equal(result.value.candidate.unadmitted, 'candidate')
  assert.match(result.value.error, /Driver cleanup failed:.*owned device release failed/s)
  assert.equal(result.value.cleanup.ownedResourcesReleased, false)
})

test('negative cleanup attestation fails even when run and dispose both resolve', async t => {
  const setup = await fixture(t, `export const run=async()=>({unadmitted:'candidate'});
export const dispose=async()=>({ownedResourcesReleased:true,borrowedResourcesPreserved:false});`)
  const result = await runChild(t, setup)
  assert.equal(result.code, 1)
  assert.deepEqual(result.value.cleanup, { ownedResourcesReleased: true, borrowedResourcesPreserved: false })
})

test('a run failure and a disposal failure are both retained', async t => {
  const setup = await fixture(t, `export async function run(){throw new Error('host observation failed')}
export async function dispose(){throw new Error('host cleanup failed')}`)
  const result = await runChild(t, setup)
  assert.equal(result.code, 1)
  assert.match(result.value.error, /host observation failed/)
  assert.match(result.value.error, /host cleanup failed/)
  assert.equal(result.value.candidate, undefined)
})

test('SIGTERM cancels the run and awaits scoped asynchronous disposal before recording its result', async t => {
  const setup = await fixture(t, `import {writeFile} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
export async function run({signal,outputDirectory}) {
  const keepAlive=globalThis.setInterval(()=>{},1000);
  const cancelled=new Promise(resolve=>{
    if(signal.aborted)resolve();
    else signal.addEventListener('abort',resolve,{once:true});
  });
  await writeFile(outputDirectory+'/ready','ready');
  await cancelled;
  globalThis.clearInterval(keepAlive);
  return {cancelled:true};
}
export async function dispose({signal,outputDirectory}) {
  await setTimeout(20);
  await writeFile(outputDirectory+'/disposed',String(signal.aborted));
  return {ownedResourcesReleased:true,borrowedResourcesPreserved:true};
}`)
  const result = await runChild(t, setup, [], interruptWhenReady)
  assert.equal(result.code, 1)
  assert.match(result.value.error, /Matrix driver interrupted/)
  assert.equal(result.value.cleanup.ownedResourcesReleased, true)
  assert.equal(await readFile(resolve(setup.directory, 'disposed'), 'utf8'), 'true')
})

test('SIGTERM during driver import prevents run and still awaits scoped asynchronous disposal', async t => {
  const setup = await fixture(t, `import {writeFile} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
const keepAlive=globalThis.setInterval(()=>{},1000);
const interrupted=new Promise(resolve=>process.once('SIGTERM',resolve));
await writeFile(new URL('./ready',import.meta.url),'ready');
await interrupted;
globalThis.clearInterval(keepAlive);
export async function run({outputDirectory}) {
  await writeFile(outputDirectory+'/ran','unexpected resource acquisition');
  return {unexpected:true};
}
export async function dispose({signal,outputDirectory}) {
  await setTimeout(20);
  await writeFile(outputDirectory+'/disposed',String(signal.aborted));
  return {ownedResourcesReleased:true,borrowedResourcesPreserved:true};
}`)
  const result = await runChild(t, setup, [], interruptWhenReady)
  assert.equal(result.code, 1)
  assert.match(result.value.error, /Matrix driver interrupted/)
  assert.equal(result.value.candidate, undefined)
  assert.deepEqual(result.value.cleanup, { ownedResourcesReleased: true, borrowedResourcesPreserved: true })
  await assert.rejects(access(resolve(setup.directory, 'ran')), { code: 'ENOENT' })
  assert.equal(await readFile(resolve(setup.directory, 'disposed'), 'utf8'), 'true')
})

// These are process/provenance fixtures, deliberately not portable packs or
// host receipts. The helper executes a driver; admission is tested elsewhere.
async function matrixFixture(t, source) {
  const setup = await fixture(t, source)
  const root = await realpath(setup.directory)
  await mkdir(resolve(root, 'scripts'))
  await writeFile(resolve(root, 'scripts/conformance-matrix-driver.mjs'), await readFile(entry))
  const outputDirectory = resolve(root, 'output')
  await mkdir(outputDirectory)
  const manifest = { integrity: { root: 'a'.repeat(64) } }
  await writeFile(resolve(root, 'fixture.json'), JSON.stringify({ manifest }))
  await writeFile(resolve(root, 'collector.mjs'), 'export const createCollector=()=>({attach(){}});\n')
  const ref = path => conformanceArtifactReference(root, resolve(root, path))
  return {
    root, outputDirectory,
    job: { caseId: 'ide-provenance-test', host: 'web', engine: 'quickjs' },
    driver: { module: await ref('driver.mjs'), inputs: [], timeoutMs: 1000 },
    recipe: { caseId: 'ide-provenance-test', sourceSha256: 'b'.repeat(64),
      fixture: await ref('fixture.json'), fixtureValue: { manifest }, resources: {},
      collector: await ref('collector.mjs'), collectorInputs: [] },
  }
}

test('mutating consumed collector or runtime recipe snapshots fails while retaining successful cleanup evidence', async t => {
  for (const [name, target] of [
    ['collector', 'recipe.collectorSnapshotPaths[0]'],
    ['runtime recipe', 'recipe.runtimeRecipePath'],
  ]) await t.test(name, async t => {
    const setup = await matrixFixture(t, `import {writeFile} from 'node:fs/promises';
export async function run({recipe}){await writeFile(${target},'changed consumed input');return {testOnly:true}}
export const dispose=async()=>({ownedResourcesReleased:true,borrowedResourcesPreserved:true});`)
    const executed = await executeMatrixDriver(setup)
    assert.equal(executed.process.exitCode, 0)
    assert.equal(executed.status, 'failed')
    assert.match(executed.errors.join('\n'), /artifact hash\/size differs/)
    assert.deepEqual(executed.cleanup, { ownedResourcesReleased: true, borrowedResourcesPreserved: true })
    assert.ok(executed.result?.sha256)
    assert.ok(executed.log?.sha256)
    assert.ok(executed.inputs.some(ref => ref.path.endsWith('/collector.mjs')))
    assert.ok(executed.inputs.some(ref => ref.path.endsWith('/runtime-recipe.json')))
  })
})

test('timeout without a child result records cleanup as unconfirmed and keeps process/log/input evidence', async t => {
  const setup = await matrixFixture(t, `export async function run(){
process.removeAllListeners('SIGTERM');
await new Promise(()=>{setInterval(()=>{},1000)});
}
export const dispose=async()=>({ownedResourcesReleased:true,borrowedResourcesPreserved:true});`)
  const executed = await executeMatrixDriver(setup)
  assert.equal(executed.status, 'failed')
  assert.equal(executed.process.timedOut, true)
  assert.equal(executed.result, null)
  assert.deepEqual(executed.cleanup, { ownedResourcesReleased: false, borrowedResourcesPreserved: false })
  assert.match(executed.errors.join('\n'), /timeout/)
  assert.match(executed.errors.join('\n'), /cleanup is incomplete/)
  assert.ok(executed.log.sha256)
  assert.ok(executed.inputs.some(ref => ref.path.endsWith('/driver-entry.mjs')))
})
