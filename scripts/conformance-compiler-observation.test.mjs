import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { inspectCompilerMacroLoads } from './conformance-compiler-observation.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const observerSource = new URL('./conformance-compiler-macro-observer.mjs', import.meta.url)
const preloadSource = new URL('./conformance-compiler-use-preload.cjs', import.meta.url)

async function fixture(t, source, { bare = false, files = {}, outputLoadPolicy, expectedExit = 0 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'macro-consumer-witness-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'checkout'), directory = join(root, 'case'), logDirectory = join(directory, 'loader-logs')
  const projectPath = join(checkout, '.tmp/e2e-projects/project'), cli = join(checkout, 'packages/weapp-vite/bin/weapp-vite.js')
  await Promise.all([mkdir(logDirectory, { recursive: true }), mkdir(projectPath, { recursive: true }), mkdir(join(checkout, 'packages/weapp-vite/bin'), { recursive: true })])
  const put = async bytes => {
    bytes = Buffer.from(bytes)
    const path = join(directory, 'objects/sha256', hash(bytes)); await mkdir(join(directory, 'objects/sha256'), { recursive: true })
    await writeFile(path, bytes)
    return { path: relative(root, path), sha256: hash(bytes), bytes: bytes.length }
  }
  await writeFile(join(checkout, 'package.json'), '{"type":"module"}')
  await writeFile(cli, source)
  const preload = join(directory, 'compiler-use-preload.cjs'), observerPath = join(directory, 'compiler-macro-observer.mjs')
  await Promise.all([cp(preloadSource, preload), cp(observerSource, observerPath)])
  const observer = await put(await readFile(observerPath))
  const members = [{ path: 'packages/weapp-vite/bin/weapp-vite.js', kind: 'file', sha256: hash(source), bytes: Buffer.byteLength(source) }]
  for (const [path, { source, origin }] of Object.entries(files)) {
    await mkdir(join(checkout, path, '..'), { recursive: true }); await writeFile(join(checkout, path), source)
    members.push({ path, kind: 'file', origin, sha256: hash(source), bytes: Buffer.byteLength(source) })
  }
  const membersReference = await put(JSON.stringify({ members }))
  const closure = await put(JSON.stringify({ projectPath, sourceBefore: [] }))
  const config = { runId: 'synthetic-loader-probe', caseId: 'synthetic-only', sourceSha256: 'a'.repeat(64), caseSourcePath: 'synthetic.mjs',
    checkout, logDirectory, evidenceRoot: root, membersReference, allowedModuleRoots: [], runnerFiles: [],
    macroObservation: { profile: 'pinned-json-macro-esm-v2-rolldown-runtime', observerPath, observer },
    ...(outputLoadPolicy === undefined ? {} : { outputLoadPolicy }) }
  const configPath = join(directory, 'compiler-use-config.json'); await writeFile(configPath, JSON.stringify(config))
  const child = spawn(process.execPath, [cli, 'build', projectPath], { cwd: checkout, env: { ...process.env,
    NODE_OPTIONS: bare ? '' : `--require=${JSON.stringify(preload)}`, WEAPP_CONTAINER_COMPILER_USE_CONFIG: configPath,
    WEAPP_CONTAINER_COMPILER_FIXTURE_INPUTS: JSON.stringify(closure) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(exitCode, expectedExit, stderr)
  if (exitCode !== 0) return { root, checkout, stdout, stderr, exitCode }
  if (bare) return { stdout, stderr }
  const events = (await readFile(join(logDirectory, `${child.pid}-0.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse)
  const load = reference => {
    const bytes = readFileSync(join(root, reference.path))
    assert.equal(hash(bytes), reference.sha256); assert.equal(bytes.length, reference.bytes)
    return bytes
  }
  return { root, checkout, projectPath, events, stdout, load, observation: { profile: 'pinned-json-macro-esm-v2-rolldown-runtime', transforms: [] } }
}

test('actual transient ESM bytes survive cleanup and unrelated caller code gains no macro admission', async t => {
  const f = await fixture(t, `import{writeFile,unlink}from'node:fs/promises';import{join}from'node:path';import{pathToFileURL}from'node:url';
    const file=join(process.argv[3],'transient.mjs');await writeFile(file,'export default "actual-sentinel"');
    try{console.log((await import(pathToFileURL(file))).default)}finally{await unlink(file)}`)
  assert.equal(f.stdout.trim(), 'actual-sentinel')
  const event = f.events.find(event => event.classification === 'unbound')
  assert.ok(event)
  assert.equal(f.load(event.sourceArtifact).toString(), 'export default "actual-sentinel"')
  assert.deepEqual(f.load(event.loadedSourceArtifact), f.load(event.sourceArtifact))
  assert.equal(event.format, 'module')
  assert.equal(f.events.at(-1).kind, 'end')
  assert.equal(f.events.at(-1).observerFailed, false)
  assert.deepEqual(f.events.map(event => event.eventSeq), f.events.map((_, index) => index + 1))
  assert.equal(inspectCompilerMacroLoads({ ...f, members: new Map() }).size, 0)
})

test('rearming observes the final source returned by later hooks and preserves their effect', async t => {
  const f = await fixture(t, `import{registerHooks}from'node:module';import{writeFile,unlink}from'node:fs/promises';import{join}from'node:path';import{pathToFileURL}from'node:url';
    const file=join(process.argv[3],'changed.mjs');await writeFile(file,'export default "original"');
    const hook=registerHooks({load(url,ctx,next){const result=next(url,ctx);return url===pathToFileURL(file).href?{...result,source:'export default "replacement"'}:result}});
    try{console.log((await import(pathToFileURL(file))).default)}finally{hook.deregister();await unlink(file)}`)
  assert.equal(f.stdout.trim(), 'replacement')
  assert.equal(f.events.filter(event => event.kind === 'hook-registration' && event.api === 'registerHooks').length, 1)
  const load = f.events.find(event => event.classification === 'unbound')
  assert.equal(f.load(load.sourceArtifact).toString(), 'export default "original"')
  assert.equal(f.load(load.loadedSourceArtifact).toString(), 'export default "replacement"')
  assert.equal(load.terminalResult, true)
  assert.equal(load.witnessToken, 2)
  assert.equal(inspectCompilerMacroLoads({ ...f, members: new Map() }).size, 0)
  const events = structuredClone(f.events); events.find(event => event.kind === 'hook-rearmed').witnessToken = 9
  assert.throws(() => inspectCompilerMacroLoads({ ...f, events, members: new Map() }), /open hook chain/)

})

// Actual Node loader contracts with explicitly synthetic member identities.
// These probes do not finalize compiler-use or official execution receipts.
const sealedFiles = {
  'built/value.mjs': { source: 'export default "OUTPUT-ORIGINAL";', origin: 'output' },
  'built/observed.mjs': { source: 'export default "OBSERVED-ORIGINAL";', origin: 'observed-output' },
  'node_modules/example/value.mjs': { source: 'export default "DEPENDENCY-ORIGINAL";', origin: 'dependency' },
  'e2e/helper.mjs': { source: 'export default "HELPER-ORIGINAL";', origin: 'source' },
}
const transformingLoader = `import{registerHooks}from'node:module';import{pathToFileURL}from'node:url';import{join}from'node:path';
  const hook=registerHooks({load(url,context,next){const result=next(url,context);return url.endsWith('/value.mjs')||url.endsWith('/observed.mjs')||url.endsWith('/helper.mjs')||url.endsWith('/value.mjs?alias')
    ?{...result,source:Buffer.from(result.source).toString().replaceAll('ORIGINAL','TRANSFORMED')}:result}});`

test('sealed ESM keeps actual output bytes while later loaders still transform sources and dependencies', async t => {
  const paths = Object.keys(sealedFiles)
  const f = await fixture(t, transformingLoader + `try{const values=[];for(const path of ${JSON.stringify(paths)})values.push((await import(pathToFileURL(join(process.cwd(),path)))).default);console.log(JSON.stringify(values))}finally{hook.deregister()}`,
    { files: sealedFiles, outputLoadPolicy: 'sealed-esm-v1' })
  assert.deepEqual(JSON.parse(f.stdout), ['OUTPUT-ORIGINAL', 'OBSERVED-ORIGINAL', 'DEPENDENCY-TRANSFORMED', 'HELPER-TRANSFORMED'])
  assert.equal(f.events[0].outputLoadPolicy, 'sealed-esm-v1')
  for (const path of paths) {
    const load = f.events.find(event => event.kind === 'load' && event.path === path)
    assert.equal(load.terminalResult, true)
    if (path.startsWith('built/')) {
      assert.equal(load.outputLoadPolicy, 'sealed-esm-v1')
      assert.equal(load.loadedSourceSha256, load.sha256)
      assert.equal(load.contextFormat, 'module')
      assert.deepEqual(load.importAttributes, {})
    } else {
      assert.equal(load.outputLoadPolicy, undefined)
      assert.notEqual(load.loadedSourceSha256, load.sha256)
    }
  }
  assert.equal(f.events.at(-1).observerFailed, false)
})

test('absent sealed ESM policy preserves the loader result and archives mismatched actual output bytes', async t => {
  const f = await fixture(t, transformingLoader + `try{console.log((await import(pathToFileURL(join(process.cwd(),'built/value.mjs')))).default)}finally{hook.deregister()}`,
    { files: sealedFiles })
  assert.equal(f.stdout.trim(), 'OUTPUT-TRANSFORMED')
  const load = f.events.find(event => event.path === 'built/value.mjs')
  assert.equal(load.outputLoadPolicy, undefined)
  assert.equal(f.load(load.loadedSourceArtifact).toString(), 'export default "OUTPUT-TRANSFORMED";')
  assert.notEqual(load.loadedSourceSha256, load.sha256)
})

test('query aliases and import attributes cannot acquire a canonical raw ESM policy witness', async t => {
  const f = await fixture(t, transformingLoader + `try{console.log((await import(pathToFileURL(join(process.cwd(),'built/value.mjs')).href+'?alias')).default);
    try{await import(pathToFileURL(join(process.cwd(),'built/observed.mjs')),{with:{type:'json'}});throw new Error('invalid import unexpectedly accepted')}catch(error){console.log(error.code)}}finally{hook.deregister()}`,
    { files: sealedFiles, outputLoadPolicy: 'sealed-esm-v1' })
  assert.match(f.stdout, /^OUTPUT-TRANSFORMED\nERR_IMPORT_ATTRIBUTE_/)
  const load = f.events.find(event => event.path === 'built/value.mjs')
  assert.equal(load.outputLoadPolicy, undefined)
  assert.notEqual(load.loadedSourceSha256, load.sha256)
  assert.ok(!f.events.some(event => event.path === 'built/observed.mjs' && event.outputLoadPolicy))
})

test('a changed sealed output fails before load and cannot fall back to raw policy success', async t => {
  const f = await fixture(t, `import{writeFile}from'node:fs/promises';import{join}from'node:path';import{pathToFileURL}from'node:url';
    const file=join(process.cwd(),'built/value.mjs');await writeFile(file,'export default "TAMPERED";');
    try{await import(pathToFileURL(file));throw new Error('changed output unexpectedly accepted')}catch(error){console.log(error.message)}`,
    { files: sealedFiles, outputLoadPolicy: 'sealed-esm-v1' })
  assert.match(f.stdout, /Compiler consumer member changed: built\/value.mjs/)
  assert.ok(f.events.some(event => event.kind === 'violation' && event.path === 'built/value.mjs'))
  assert.ok(!f.events.some(event => event.kind === 'load' && event.path === 'built/value.mjs'))
})

test('an unknown sealed ESM policy is rejected by the actual child before loading outputs', async t => {
  const f = await fixture(t, 'console.log("must not execute")', { files: sealedFiles, outputLoadPolicy: 'unreviewed', expectedExit: 1 })
  assert.equal(f.stdout, '')
  assert.match(f.stderr, /Unsupported sealed compiler output load policy/)
})

test('truncation, removed events and a failed terminal witness stay rejected', async t => {
  const f = await fixture(t, `console.log('no-dynamic-module')`)
  assert.equal(inspectCompilerMacroLoads({ ...f, members: new Map() }).size, 0)
  assert.throws(() => inspectCompilerMacroLoads({ ...f, events: f.events.slice(0, -1), members: new Map() }), /terminal witness/)
  assert.throws(() => inspectCompilerMacroLoads({ ...f, events: f.events.filter((_, index) => index !== 1), members: new Map() }), /incomplete or out of order/)
  const events = structuredClone(f.events); events.at(-1).observerFailed = true
  assert.throws(() => inspectCompilerMacroLoads({ ...f, events, members: new Map() }), /terminal witness/)
})

test('observer sink I/O failure preserves the original hook return and effect', async t => {
  const f = await fixture(t, `import{registerHooks}from'node:module';import{renameSync,mkdirSync,rmSync}from'node:fs';import{dirname,join}from'node:path';
    const cfg=JSON.parse(process.env.WEAPP_CONTAINER_COMPILER_USE_CONFIG?await (await import('node:fs/promises')).readFile(process.env.WEAPP_CONTAINER_COMPILER_USE_CONFIG,'utf8'):'{}');
    const log=join(cfg.logDirectory,process.pid+'-0.jsonl'),backup=log+'.saved';renameSync(log,backup);mkdirSync(log);
    let hook;try{hook=registerHooks({resolve(specifier,context,next){return next(specifier,context)}});console.log(typeof hook.deregister)}finally{rmSync(log,{recursive:true});renameSync(backup,log);hook?.deregister()}`)
  assert.equal(f.stdout.trim(), 'function')
  assert.equal(f.events.at(-1).observerFailed, true)
  assert.throws(() => inspectCompilerMacroLoads({ ...f, members: new Map() }), /incomplete or out of order|terminal witness/)
})


test('registration inside an active hook preserves execution and invalidates that terminal observation', async t => {
  const f = await fixture(t, `import{registerHooks}from'node:module';import{writeFile,unlink}from'node:fs/promises';import{join}from'node:path';import{pathToFileURL}from'node:url';
    const file=join(process.argv[3],'reentrant.mjs');await writeFile(file,'export default "actual"');let nested;
    const hook=registerHooks({load(url,context,next){const result=next(url,context);if(url===pathToFileURL(file).href)nested=registerHooks({});return result}});
    try{console.log((await import(pathToFileURL(file))).default)}finally{hook.deregister();nested?.deregister();await unlink(file)}`)
  assert.equal(f.stdout.trim(), 'actual')
  assert.ok(f.events.some(event => event.kind === 'hook-registration' && event.reentrant))
  assert.equal(f.events.at(-1).observerFailed, true)
  assert.throws(() => inspectCompilerMacroLoads({ ...f, members: new Map() }), /terminal witness/)
})

test('accessor source stays outside the supported profile and cannot provide final execution bytes', async t => {
  const source = `import{registerHooks}from'node:module';import{writeFile,unlink}from'node:fs/promises';import{join}from'node:path';import{pathToFileURL}from'node:url';
    const file=join(process.argv[3],'accessor.mjs');await writeFile(file,'export default "disk"');let reads=0;
    const hook=registerHooks({load(url,context,next){const result=next(url,context);return url===pathToFileURL(file).href?{...result,get source(){reads++;return 'export default "accessor"'}}:result}});
    try{console.log((await import(pathToFileURL(file))).default,reads)}finally{hook.deregister();await unlink(file)}`
  const raw = await fixture(t, source, { bare: true }), observed = await fixture(t, source)
  assert.match(raw.stdout, /^accessor [1-9]/)
  assert.match(observed.stdout, /^accessor [1-9]/)
  // Node validates source once per hook layer. Accessors are unsupported:
  // rearming may change their read counts, and neither value is admitted.
  assert.ok(observed.events.some(event => event.kind === 'load' && event.terminalResult === false))
  assert.equal(observed.events.at(-1).observerFailed, true)
  assert.throws(() => inspectCompilerMacroLoads({ ...observed, members: new Map() }), /terminal witness/)
})

test('an unrelated accessor alongside valid string source cannot mask an otherwise successful load', async t => {
  const source = `import{registerHooks}from'node:module';import{writeFile,unlink}from'node:fs/promises';import{join}from'node:path';import{pathToFileURL}from'node:url';
    const file=join(process.argv[3],'extra.mjs');await writeFile(file,'export default "extra-ok"');let reads=0;
    const hook=registerHooks({load(url,context,next){const result=next(url,context);return url===pathToFileURL(file).href?{...result,source:'export default "extra-ok"',get extra(){reads++;return 'unused-data'}}:result}});
    try{console.log((await import(pathToFileURL(file))).default,reads)}finally{hook.deregister();await unlink(file)}`
  const raw = await fixture(t, source, { bare: true }), observed = await fixture(t, source)
  assert.equal(observed.stdout, raw.stdout)
  assert.equal(observed.stdout.trim(), 'extra-ok 1')
  assert.equal(observed.events.at(-1).observerFailed, true)
})

test('a later builtin remap remains visible at the generated module resolver boundary', async t => {
  const f = await fixture(t, `import{registerHooks}from'node:module';import{writeFile,unlink}from'node:fs/promises';import{join}from'node:path';import{pathToFileURL}from'node:url';
    const file=join(process.argv[3],'builtin.mjs');await writeFile(file,'import * as dependency from "node:module";export default typeof dependency.basename');
    const hook=registerHooks({resolve(specifier,context,next){return next(specifier==='node:module'&&context.parentURL===pathToFileURL(file).href?'node:path':specifier,context)}});
    try{console.log((await import(pathToFileURL(file))).default)}finally{hook.deregister();await unlink(file)}`)
  assert.equal(f.stdout.trim(), 'function')
  const resolution = f.events.find(event => event.kind === 'resolve' && event.specifier === 'node:module' && event.parentURL?.endsWith('/builtin.mjs'))
  assert.equal(resolution.url, 'node:path')
  assert.equal(resolution.witnessToken, 2)
  assert.equal(inspectCompilerMacroLoads({ ...f, members: new Map() }).size, 0)
})

test('an actual failed dlopen preserves its native error and produces no successful addon witness', async t => {
  const source = `import{writeFile,unlink}from'node:fs/promises';import{join}from'node:path';
    const file=join(process.argv[3],'invalid.node');await writeFile(file,'not a native addon');
    try{process.dlopen({exports:{}},file)}catch(error){console.log(error.code)}finally{await unlink(file)}`
  const raw = await fixture(t, source, { bare: true }), observed = await fixture(t, source)
  assert.equal(observed.stdout, raw.stdout)
  assert.equal(observed.stdout.trim(), 'ERR_DLOPEN_FAILED')
  assert.equal(observed.events.filter(event => event.kind === 'native-load-failed').length, 1)
  assert.equal(observed.events.filter(event => event.boundary === 'process.dlopen').length, 0)
})

test('nested CommonJS keeps Node own-data undefined format without guessing or admitting a macro ESM', async t => {
  const f = await fixture(t, `import{writeFile,mkdir}from'node:fs/promises';import{join}from'node:path';import{createRequire}from'node:module';
    const dir=join(process.argv[3],'dependency');await mkdir(dir);
    await writeFile(join(dir,'package.json'),'{}');
    await writeFile(join(dir,'index.js'),'module.exports=require("./nested")');
    await writeFile(join(dir,'nested.js'),'module.exports="nested-actual"');
    console.log(createRequire(import.meta.url)(join(dir,'index.js')))`)
  assert.equal(f.stdout.trim(), 'nested-actual')
  const nested = f.events.find(event => event.kind === 'load' && event.file.endsWith('/nested.js'))
  assert.equal(nested.format, null)
  assert.equal(nested.terminalResult, true)
  assert.equal(f.load(nested.loadedSourceArtifact).toString(), 'module.exports="nested-actual"')
  assert.equal(f.events.at(-1).observerFailed, false)
  assert.throws(() => inspectCompilerMacroLoads({ ...f, members: new Map() }))
})
