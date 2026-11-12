import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { cjsFixture } from './fixtures/conformance-compiler-macro-cjs.mjs'
import { CJS_MACRO_VALIDATION_PROFILE, CJS_RUNTIME_MACRO_VALIDATION_PROFILE, MACRO_VALIDATION_PROFILE, validateMacroEvents } from './conformance-compiler-macro-validator.mjs'
import { inspectCompilerMacroLoads } from './conformance-compiler-observation.mjs'

let probeCounter = 0
const copy = value => structuredClone(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const loaderSource = readFileSync(new URL('./fixtures/conformance-compiler-macro-cjs-loader.txt', import.meta.url), 'utf8')
const event = (f, kind) => f.events.find(value => value.kind === kind)
const compile = f => f.options.loads.find(value => value.classification === 'unbound')

test('synthetic CJS profile binds distinct physical TS and compiled CJS bytes for every invocation', () => {
  const f = cjsFixture({ invocations: 4 }), result = validateMacroEvents(f.events, f.options)
  assert.deepEqual(result.errors, [])
  assert.equal(result.admittedLoads.length, 4)
  assert.ok(result.admittedLoads.every((load, index) => load === f.options.loads[index + 3]))
  assert.ok(result.admittedLoads.every(load => load.sha256 !== load.loadedSourceSha256))
  assert.ok(result.invocations.every(item => item.profile === CJS_MACRO_VALIDATION_PROFILE))
  assert.equal(new Set(result.invocations.map(item => item.requireSpanId)).size, 4)
  assert.equal(new Set(result.invocations.map(item => item.outputFile)).size, 4)
  assert.notDeepEqual(validateMacroEvents(f.events, { ...f.options, macroProfile: MACRO_VALIDATION_PROFILE }).errors, [])
})

test('CJS effective selection requires the exact actual package search and original fixture JSON', () => {
  for (const mutate of [
    f => { event(f, 'internalOptions').data.internalOptions.isESM = true },
    f => { event(f, 'internalOptions').data.internalOptions.require = { unsupportedFunction: true } },
    f => { event(f, 'module-type-result').data.isESM = true },
    f => { event(f, 'module-type-result').data.deno = true },
    f => { event(f, 'module-type-result').data.resolvedPath = 'file:///foreign.ts' },
    f => { event(f, 'module-type-stat').fileObservation.absent = false },
    f => { event(f, 'module-type-stat').data.pkgPath = join(f.options.projectPath, 'package.json') },
    f => { f.events.splice(f.events.indexOf(event(f, 'module-type-stat')), 1) },
    f => { event(f, 'module-type-package').data.data.type = 'module' },
    f => { event(f, 'module-type-package').fileObservation.regular = false },
    f => { delete event(f, 'module-type-package').fileObservation.artifact },
    f => { event(f, 'module-type-package').fileObservation.artifact.sha256 = 'f'.repeat(64) },
    f => { f.options.sourceSnapshots.delete(join(f.options.projectPath, 'package.json')) },
    f => { f.options.sourceSnapshots.get(join(f.options.projectPath, 'package.json')).source += 'changed' },
  ]) {
    const f = cjsFixture(); mutate(f)
    const result = validateMacroEvents(f.events, f.options)
    assert.notDeepEqual(result.errors, []); assert.deepEqual(result.admittedLoads, [])
  }
})

test('CJS requires a fresh physical source write and the prior complete native bundler closure', () => {
  for (const mutate of [
    f => { delete event(f, 'after:writeFile(tempFile').fileObservation },
    f => { delete event(f, 'after:writeFile(tempFile').fileObservation.artifact },
    f => { event(f, 'after:writeFile(tempFile').fileObservation.sha256 = '0'.repeat(64) },
    f => { event(f, 'actual-bundler-input').data.code += 'detached' },
    f => { event(f, 'entryChunk').data.output[0].imports.push('node:module') },
    f => { event(f, 'entryChunk').data.output[0].moduleIds.unshift('\0rolldown/runtime.js') },
    f => { f.options.loads.splice(0, 1) },
    f => { f.options.loads.find(value => value.format === 'addon').nativeFileStable = false },
    f => { f.options.loads.find(value => value.format === 'addon').eventSeq = compile(f).eventSeq + 1 },
    f => { f.options.members.clear() },
    f => { f.options.cliCwd = dirname(f.options.checkout) },
  ]) {
    const f = cjsFixture(); mutate(f)
    const result = validateMacroEvents(f.events, f.options)
    assert.notDeepEqual(result.errors, []); assert.deepEqual(result.admittedLoads, [])
  }
})

test('CJS default require, extensions, cache, canonical file and actual compile evidence cannot be substituted', () => {
  for (const mutate of [
    f => { event(f, 'cjs-extension-before').data.originalLoaderType = 'object' },
    f => { event(f, 'cjs-extension-before').data.fallbackLoaderType = 'undefined' },
    f => { event(f, 'cjs-extension-installed').data.installed = false },
    f => { event(f, 'cjs-cache-cleared').data.cacheAbsent = false },
    f => { event(f, 'cjs-require-before').data.defaultRequire = false },
    f => { event(f, 'cjs-require-before').data.fileName = pathToFileURL(event(f, 'cjs-require-before').data.fileName).href },
    f => { event(f, 'cjs-require-before').data.bundledCode += 'altered' },
    f => { event(f, 'cjs-extension-restored').data.restored = false },
    f => { f.events.find(value => value.kind === 'span-start' && value.span.kind === 'cjs-compile-loader').data.input.selected = false },
    f => { compile(f).boundary = 'registerHooks.load' },
    f => { compile(f).format = 'module' },
    f => { compile(f).filename += '?alias' },
    f => { compile(f).receiver = 'Object' },
    f => { compile(f).argumentCount = 3 },
    f => { compile(f).terminalResult = false },
    f => { compile(f).executionReturned = false },
    f => { compile(f).sha256 = compile(f).loadedSourceSha256 },
    f => { compile(f).loadedSourceSha256 = compile(f).sha256 },
    f => { compile(f).loadedSourceArtifact.bytes += 1 },
    f => { compile(f).sourceArtifact.bytes += 1 },
    f => { compile(f).macroContext.id += 100 },
    f => { compile(f).eventSeq = event(f, 'cjs-require-after').eventSeq + 1 },
    f => { f.options.loads.splice(f.options.loads.indexOf(compile(f)), 1) },
    f => { f.options.loads.push(copy(compile(f))) },
    f => { f.options.resolves[0].specifier = pathToFileURL(f.options.resolves[0].specifier).href },
    f => { f.options.resolves[1].parentURL = 'file:///foreign-parent.mjs' },
    f => { f.options.resolves.splice(0, 1) },
    f => { f.options.resolves.push(copy(f.options.resolves[0])) },
    f => { f.options.resolves[1].eventSeq = event(f, 'cjs-require-after').eventSeq + 1 },
  ]) {
    const f = cjsFixture(); mutate(f)
    const result = validateMacroEvents(f.events, f.options)
    assert.notDeepEqual(result.errors, []); assert.deepEqual(result.admittedLoads, [])
  }
})

function syntheticReaderFixture(options) {
  const f = cjsFixture(options), objects = f.objects
  const put = bytes => { bytes = Buffer.from(bytes); const sha256 = hash(bytes); objects.set(sha256, bytes); return { path: `synthetic-unread-artifact:${sha256}`, sha256, bytes: bytes.length } }
  const sourceBefore = [...f.options.sourceSnapshots].map(([path, snapshot]) => ({ path: relative(f.options.projectPath, path), kind: 'file', artifact: put(snapshot.source) }))
  const fixtureInputClosure = put(JSON.stringify({ projectPath: f.options.projectPath, sourceBefore }))
  const base = { runId: 'explicit-synthetic-cjs-run', pid: 424243, threadId: 0 }
  const events = [{ ...base, eventSeq: 1, kind: 'start', cwd: f.options.checkout, isMainThread: true, execArgv: [],
    argv: ['/SYNTHETIC-NODE-NOT-EXECUTED', join(f.options.checkout, 'packages/weapp-vite/bin/weapp-vite.js'), 'build', f.options.projectPath],
    hookWitness: 'terminal-rearm-registerHooks-v1', cjsCompileWitness: 'captured-node-cjs-compile-v1', fixtureInputClosure },
  { ...base, eventSeq: 2, kind: 'hook-ready', witnessToken: 1 }]
  const body = [...f.events.map(item => ({ ...base, kind: 'macro', eventSeq: item.eventSeq + 2, payload: put(JSON.stringify(item)) })),
    ...f.options.loads.map(item => ({ ...item, eventSeq: item.eventSeq + 2, terminalResult: true, witnessToken: 1 })),
    ...f.options.resolves.map(item => ({ ...item, eventSeq: item.eventSeq + 2, witnessToken: 1 }))].sort((a, b) => a.eventSeq - b.eventSeq)
  events.push(...body, { ...base, eventSeq: body.at(-1).eventSeq + 1, kind: 'end', observerFailed: false, exitCode: 0, witnessToken: 1 })
  const load = reference => { const bytes = objects.get(reference.sha256); assert.ok(bytes, reference.path); assert.equal(hash(bytes), reference.sha256); assert.equal(bytes.length, reference.bytes); return bytes }
  return { events, observation: { profile: f.options.macroProfile, transforms: [] }, checkout: f.options.checkout, members: f.options.members, load }
}

test('production macro reader hydrates all synthetic CJS CAS and refuses missing startup, altered CAS or unbound extras', () => {
  const f = syntheticReaderFixture()
  assert.equal(inspectCompilerMacroLoads(f).size, 1)
  const missing = copy(f.events); delete missing[0].cjsCompileWitness
  assert.throws(() => inspectCompilerMacroLoads({ ...f, events: missing }), /open hook chain/)
  const extra = copy(f.events), last = extra.pop()
  extra.push({ ...extra.find(value => value.kind === 'load' && value.classification === 'unbound'), eventSeq: last.eventSeq }, { ...last, eventSeq: last.eventSeq + 1 })
  assert.throws(() => inspectCompilerMacroLoads({ ...f, events: extra }), /one actual captured Node CJS compilation/)
  const altered = reference => { const bytes = f.load(reference); return bytes.length === 48 ? Buffer.from('altered CAS') : bytes }
  assert.throws(() => inspectCompilerMacroLoads({ ...f, load: altered }), /actual original and loaded bytes/)
})

// This probe executes the exact reviewed loader function with a forced
// cache-disabled helper and synthetic input/code. It never imports Rolldown,
// a compiler, a native addon, DevTools, or a container runtime.
async function nodeProbe(t, { mode = 'normal', profile = CJS_MACRO_VALIDATION_PROFILE, packageType } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'macro-cjs-boundary-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'checkout'), directory = join(root, 'case'), logDirectory = join(directory, 'loader-logs')
  const projectPath = join(checkout, 'project'), cli = join(checkout, 'packages/weapp-vite/bin/weapp-vite.js')
  const loader = join(checkout, 'packages/rolldown-require/dist/index.mjs'), physical = 'const physicalTypeScript: unknown[]=[];\nmodule.exports=physicalTypeScript;\n'
  const bundled = mode === 'throw' ? 'throw globalThis.actualError;' : 'module.exports={actual:"compiled-code"};\n'
  const secondBundled = 'module.exports={actual:"compiled-code-next"};\n'
  const helper = `import {createRequire} from 'node:module';import fs from 'node:fs';import {promisify} from 'node:util';import path from 'node:path';import {observer as __weappConformanceObserver} from 'weapp-container:conformance-observer-v1';const _require=createRequire(import.meta.url),promisifiedRealpath=promisify(fs.realpath);const resolveCacheOptions=()=>({enabled:false});const isWindows=typeof process!=='undefined'&&process.platform==='win32',slash=p=>p.replace(/\\\\/g,'/'),MJS_MTS_EXT_RE=/\\.m[jt]s$/,CJS_CTS_EXT_RE=/\\.c[jt]s$/;\n${loaderSource}\nexport {loadFromBundledFile,detectModuleType};`
  const source = `import {writeFile,readFile} from 'node:fs/promises';import Module,{createRequire} from 'node:module';import {join} from 'node:path';import {loadFromBundledFile,detectModuleType} from '../../rolldown-require/dist/index.mjs';
    const file=join(process.argv[3],'entry.ts');await writeFile(file,${JSON.stringify(physical)});const req=createRequire(import.meta.url),previous=req.extensions['.ts'];
    globalThis.actualError={originalSyntheticThrow:true};
    ${mode === 'bypass' ? "Module.prototype._compile=function(){this.exports={actual:'bypass'};}" : mode === 'transform' ? "const original=Module.prototype._compile;Module.prototype._compile=function(code,file){return original.call(this,code.replace('compiled-code','changed-code'),file)}" : ''}
    const isESM=detectModuleType(file);if(${JSON.stringify(packageType)}==='module'){console.log(JSON.stringify({isESM}));}else {
    try { ${mode === 'warm-cache' ? `
      const firstValue=await loadFromBundledFile(file,${JSON.stringify(bundled)},{isESM,format:'cjs',tsconfig:false},[]);
      const firstCache=req.cache[file],firstRestored=req.extensions['.ts']===previous;
      const value=await loadFromBundledFile(file,${JSON.stringify(secondBundled)},{isESM,format:'cjs',tsconfig:false},[]);
      const secondCache=req.cache[file];
      console.log(JSON.stringify({firstValue,value,firstCached:!!firstCache&&firstCache.loaded&&firstCache.exports===firstValue,secondCached:!!secondCache&&secondCache.loaded&&secondCache.exports===value,cacheReplaced:!!firstCache&&!!secondCache&&firstCache!==secondCache,firstRestored,restored:req.extensions['.ts']===previous,physicalUnchanged:(await readFile(file,'utf8'))===${JSON.stringify(physical)}}));
      ` : `const value=await loadFromBundledFile(file,${JSON.stringify(bundled)},{isESM,format:'cjs',tsconfig:false},[]);console.log(JSON.stringify({value,restored:req.extensions['.ts']===previous}));`} }
    catch(error){console.log(JSON.stringify({sameThrow:error===globalThis.actualError,restored:req.extensions['.ts']===previous}));}}`
  await Promise.all([mkdir(logDirectory, { recursive: true }), mkdir(projectPath, { recursive: true }), mkdir(dirname(cli), { recursive: true }), mkdir(dirname(loader), { recursive: true })])
  await writeFile(join(checkout, 'package.json'), '{"type":"module"}'); await writeFile(join(projectPath, 'package.json'), JSON.stringify(packageType ? {type:packageType} : {}))
  await writeFile(cli, source); await writeFile(loader, helper)
  const preload = join(directory, 'compiler-use-preload.cjs'), observerPath = join(directory, 'compiler-macro-observer.mjs')
  await cp(new URL('./conformance-compiler-use-preload.cjs', import.meta.url), preload); await cp(new URL('./conformance-compiler-macro-observer.mjs', import.meta.url), observerPath)
  const put = async bytes => { bytes = Buffer.from(bytes); const file = join(directory, 'objects/sha256', hash(bytes)); await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes); return { path: relative(root, file), sha256: hash(bytes), bytes: bytes.length } }
  const observer = await put(await readFile(observerPath)), members = []
  for (const [file, text] of [[cli, source], [loader, helper]]) members.push({ path: relative(checkout, file), kind: 'file', sha256: hash(text), bytes: Buffer.byteLength(text), origin: 'source' })
  const membersReference = await put(JSON.stringify({ members })), configPath = join(directory, 'config.json')
  await writeFile(configPath, JSON.stringify({ runId: 'synthetic-cjs-node-probe', caseId: 'synthetic-only', sourceSha256: 'b'.repeat(64), caseSourcePath: 'synthetic.ts',
    checkout, logDirectory, evidenceRoot: root, membersReference, allowedModuleRoots: [], runnerFiles: [], macroObservation: { profile, observerPath, observer } }))
  const child = spawn(process.execPath, [cli, 'build', projectPath], { cwd: checkout, env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, WEAPP_CONTAINER_COMPILER_USE_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }); assert.equal(exitCode, 0, stderr)
  const events = (await readFile(join(logDirectory, `${child.pid}-0.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse)
  const load = reference => { const bytes = readFileSync(join(root, reference.path)); assert.equal(hash(bytes), reference.sha256); assert.equal(bytes.length, reference.bytes); return bytes }
  const macro = events.filter(value => value.kind === 'macro').map(value => ({ ...JSON.parse(load(value.payload)), eventSeq: value.eventSeq }))
  if (process.env.WEAPP_CONTAINER_CJS_PROBE_ARCHIVE) {
    const output = join(process.env.WEAPP_CONTAINER_CJS_PROBE_ARCHIVE, `probe-${++probeCounter}-${mode}`)
    await cp(root, output, { recursive: true })
    await writeFile(join(output, 'probe-summary.json'), JSON.stringify({ schemaVersion: 1, kind: 'actual-node-synthetic-cjs-probe',
      boundary: 'Actual Node compiler API and reviewed source slices with synthetic transport code; no compiler/native addon/SDK/DevTools execution.',
      mode, profile, originalRoot: root, childPid: child.pid, childExitCode: exitCode, stdout, stderr,
      originalPhysicalSource: physical, suppliedBundledSource: bundled, ...(mode === 'warm-cache' ? {secondSuppliedBundledSource:secondBundled} : {}), events: events.length, macroEvents: macro.length,
      capturedCompilations: events.filter(value => value.boundary === 'Module.prototype._compile') }, null, 2) + '\n')
  }
  return { stdout: JSON.parse(stdout.trim()), events, macro, load, physical, bundled, secondBundled, projectPath, checkout }
}

test('actual captured Node CJS compilation consumes the bundled argument and preserves the physical TS file and extension restoration', async t => {
  const f = await nodeProbe(t), actual = f.events.filter(value => value.boundary === 'Module.prototype._compile')
  assert.deepEqual(f.stdout, { value: { actual: 'compiled-code' }, restored: true })
  assert.equal(actual.length, 1); assert.equal(actual[0].format, 'commonjs'); assert.equal(actual[0].terminalResult, true)
  assert.equal(f.load(actual[0].sourceArtifact).toString(), f.physical)
  assert.equal(f.load(actual[0].loadedSourceArtifact).toString(), f.bundled)
  assert.notEqual(actual[0].sha256, actual[0].loadedSourceSha256)
  const before = f.macro.find(value => value.kind === 'cjs-require-before'), after = f.macro.find(value => value.kind === 'cjs-require-after')
  const resolutions = f.events.filter(value => value.kind === 'resolve' && value.specifier === join(f.projectPath, 'entry.ts'))
  assert.equal(resolutions.length, 2)
  assert.ok(resolutions[0].eventSeq < before.eventSeq && resolutions[1].eventSeq > before.eventSeq && resolutions[1].eventSeq < actual[0].eventSeq)
  assert.ok(actual[0].eventSeq < after.eventSeq)
  assert.equal(f.events.at(-1).observerFailed, false)
})

test('actual Node CJS warm cache reloads different compiled bytes at the identical physical TS path and restores both extensions', async t => {
  const f = await nodeProbe(t, { mode: 'warm-cache' })
  assert.deepEqual(f.stdout, {
    firstValue: {actual:'compiled-code'}, value: {actual:'compiled-code-next'},
    firstCached: true, secondCached: true, cacheReplaced: true,
    firstRestored: true, restored: true, physicalUnchanged: true,
  })
  const actual = f.events.filter(value => value.boundary === 'Module.prototype._compile')
  assert.equal(actual.length, 2)
  assert.equal(new Set(actual.map(value => value.filename)).size, 1)
  assert.equal(actual[0].filename, join(f.projectPath, 'entry.ts'))
  assert.deepEqual(actual.map(value => f.load(value.loadedSourceArtifact).toString()), [f.bundled, f.secondBundled])
  assert.ok(actual.every(value => value.terminalResult && value.executionReturned && f.load(value.sourceArtifact).toString() === f.physical))
  assert.notEqual(actual[0].loadedSourceSha256, actual[1].loadedSourceSha256)
  assert.equal(actual[0].sha256, actual[1].sha256)
  const before = f.macro.filter(value => value.kind === 'cjs-require-before')
  const after = f.macro.filter(value => value.kind === 'cjs-require-after')
  const clear = f.macro.filter(value => value.kind === 'cjs-cache-cleared')
  const restored = f.macro.filter(value => value.kind === 'cjs-extension-restored')
  const resolutions = f.events.filter(value => value.kind === 'resolve' && value.specifier === join(f.projectPath, 'entry.ts'))
  assert.equal(before.length, 2); assert.equal(after.length, 2)
  assert.equal(clear.length, 2); assert.ok(clear.every(value => value.data.cacheAbsent === true))
  assert.equal(restored.length, 2); assert.ok(restored.every(value => value.data.restored === true))
  assert.equal(resolutions.length, 4)
  for (let index = 0; index < 2; index += 1) {
    assert.ok(resolutions[index * 2].eventSeq < clear[index].eventSeq)
    assert.ok(clear[index].eventSeq < before[index].eventSeq)
    assert.ok(before[index].eventSeq < resolutions[index * 2 + 1].eventSeq)
    assert.ok(resolutions[index * 2 + 1].eventSeq < actual[index].eventSeq)
    assert.ok(actual[index].eventSeq < after[index].eventSeq && after[index].eventSeq < restored[index].eventSeq)
  }
  assert.ok(restored[0].eventSeq < clear[1].eventSeq)
  assert.equal(f.events.at(-1).observerFailed, false)
})

test('later transformations remain visible at the captured Node compile boundary while bypasses gain no witness', async t => {
  const transformed = await nodeProbe(t, { mode: 'transform' }), actual = transformed.events.find(value => value.boundary === 'Module.prototype._compile')
  assert.deepEqual(transformed.stdout.value, { actual: 'changed-code' })
  assert.equal(transformed.load(actual.loadedSourceArtifact).toString(), transformed.bundled.replace('compiled-code', 'changed-code'))
  assert.notEqual(actual.loadedSourceSha256, hash(transformed.bundled))
  const bypassed = await nodeProbe(t, { mode: 'bypass' })
  assert.deepEqual(bypassed.stdout.value, { actual: 'bypass' })
  assert.equal(bypassed.events.some(value => value.boundary === 'Module.prototype._compile'), false)
})

test('captured Node compile preserves the exact original thrown object and CJS restoration; legacy v2 receives no new CJS admission', async t => {
  const thrown = await nodeProbe(t, { mode: 'throw' })
  assert.deepEqual(thrown.stdout, { sameThrow: true, restored: true })
  assert.equal(thrown.events.some(value => value.boundary === 'Module.prototype._compile'), false)
  assert.equal(thrown.events.at(-1).observerFailed, true)
  const legacy = await nodeProbe(t, { profile: MACRO_VALIDATION_PROFILE })
  assert.deepEqual(legacy.stdout, { value: { actual: 'compiled-code' }, restored: true })
  assert.equal(legacy.events.some(value => value.boundary === 'Module.prototype._compile'), false)
})


test('the actual fixed module-type function follows nearest package JSON for the same absolute .ts path', async t => {
  const commonjs = await nodeProbe(t)
  const result = commonjs.macro.find(value => value.kind === 'module-type-result')
  assert.equal(result.data.isESM, false); assert.equal(result.data.deno, false)
  const pkg = commonjs.macro.find(value => value.kind === 'module-type-package')
  assert.equal(pkg.data.pkgPath, join(commonjs.projectPath, 'package.json'))
  assert.deepEqual(pkg.data.data, {})
  assert.equal(commonjs.load(pkg.fileObservation.artifact).toString(), '{}')
  const esm = await nodeProbe(t, { packageType: 'module' })
  assert.deepEqual(esm.stdout, {isESM:true})
  assert.equal(esm.events.some(value => value.boundary === 'Module.prototype._compile'), false)
  assert.equal(esm.macro.find(value => value.kind === 'module-type-result').data.isESM, true)
})


test('CJS v4 binds all runtime inputs while requiring a completely tree-shaken runtime output', () => {
  const f = cjsFixture({ invocations: 4, runtimeInput: true })
  const result = validateMacroEvents(f.events, f.options)
  assert.deepEqual(result.errors, [])
  assert.equal(result.admittedLoads.length, 4)
  assert.ok(result.invocations.every(item => item.profile === CJS_RUNTIME_MACRO_VALIDATION_PROFILE))
  for (const profile of [CJS_MACRO_VALIDATION_PROFILE, MACRO_VALIDATION_PROFILE]) {
    const legacy = validateMacroEvents(f.events, { ...f.options, macroProfile: profile })
    assert.notDeepEqual(legacy.errors, []); assert.deepEqual(legacy.admittedLoads, [])
  }
  const noRuntime = cjsFixture()
  assert.deepEqual(validateMacroEvents(noRuntime.events, { ...noRuntime.options, macroProfile: CJS_RUNTIME_MACRO_VALIDATION_PROFILE }).errors, [])
})

test('CJS v4 rejects altered runtime, emitted helpers, externals and detached or incomplete native input closure', () => {
  const runtime = f => f.events.find(item => item.kind === 'actual-bundler-input' && item.data.id === '\0rolldown/runtime.js')
  const runtimeResult = f => f.events.find(item => item.kind === 'file-scope-result' && item.data.id === '\0rolldown/runtime.js')
  for (const mutate of [
    f => { runtime(f).data.code += '\n'; runtimeResult(f).data.code += '\n' },
    f => { runtime(f).data.code = runtime(f).data.code.replace('typeof require', 'typeof changed'); runtimeResult(f).data.code = runtimeResult(f).data.code.replace('typeof require', 'typeof changed') },
    f => { runtime(f).data.id += '?alias'; runtimeResult(f).data.id += '?alias' },
    f => { f.events.splice(f.events.indexOf(runtimeResult(f)), 1) },
    f => { runtimeResult(f).data.map = {} },
    f => { runtimeResult(f).data.code += '// altered transform' },
    f => { event(f, 'entryChunk').data.output[0].moduleIds.unshift('\0rolldown/runtime.js') },
    f => { event(f, 'entryChunk').data.output[0].imports = ['node:module'] },
    f => { event(f, 'entryChunk').data.output[0].dynamicImports = ['node:module'] },
    f => { event(f, 'entryChunk').data.output[0].moduleIds = ['\0rolldown/runtime.js'] },
    f => { event(f, 'entryChunk').data.output[0].moduleIds.push('/foreign.ts') },
    f => { f.events.find(value => value.kind === 'span-start' && value.span.kind === 'loadFromBundledFile').data.input.dependencies = ['\0rolldown/runtime.js'] },
    f => { f.options.members.clear() },
    f => { f.options.loads.find(value => value.format === 'addon').nativeFileStable = false },
    f => { const c = compile(f); f.options.resolves.push({ ...f.options.resolves[0], eventSeq: c.eventSeq, specifier: 'node:fs', url: 'node:fs', parentURL: pathToFileURL(c.file).href }) },
  ]) {
    const f = cjsFixture({ runtimeInput: true }); mutate(f)
    const result = validateMacroEvents(f.events, f.options)
    assert.notDeepEqual(result.errors, []); assert.deepEqual(result.admittedLoads, [])
  }
})

test('production reader hydrates CJS v4 runtime CAS and requires the captured compile startup witness', () => {
  const f = syntheticReaderFixture({ runtimeInput: true })
  assert.equal(inspectCompilerMacroLoads(f).size, 1)
  const missing = copy(f.events); delete missing[0].cjsCompileWitness
  assert.throws(() => inspectCompilerMacroLoads({ ...f, events: missing }), /open hook chain/)
  const corrupt = reference => { const b = f.load(reference); return b.includes(Buffer.from('actual-bundler-input')) ? Buffer.from('corrupt') : b }
  assert.throws(() => inspectCompilerMacroLoads({ ...f, load: corrupt }))
})

test('actual Node CJS v4 captures the bundled argument with the same original physical TS boundary', async t => {
  const f = await nodeProbe(t, { profile: CJS_RUNTIME_MACRO_VALIDATION_PROFILE })
  assert.deepEqual(f.stdout, { value: { actual: 'compiled-code' }, restored: true })
  const actual = f.events.filter(value => value.boundary === 'Module.prototype._compile')
  assert.equal(actual.length, 1)
  assert.equal(f.events[0].cjsCompileWitness, 'captured-node-cjs-compile-v1')
  assert.equal(f.load(actual[0].sourceArtifact).toString(), f.physical)
  assert.equal(f.load(actual[0].loadedSourceArtifact).toString(), f.bundled)
  assert.equal(f.events.at(-1).observerFailed, false)
})


test('CJS v4 accepts the bound GitHub project cwd and rejects unrelated directories without relaxing legacy v3', () => {
  const f = cjsFixture({ runtimeInput: true })
  const transformed = f.events.find(item => item.kind === 'file-scope-result' && item.data.id === '\0rolldown/runtime.js')
  transformed.data.code = transformed.data.code.replace(pathToFileURL(join(f.options.checkout, '\0rolldown/runtime.js')).href, pathToFileURL(join(f.options.projectPath, '\0rolldown/runtime.js')).href)
  assert.deepEqual(validateMacroEvents(f.events, { ...f.options, cliCwd: f.options.projectPath }).errors, [])
  assert.notDeepEqual(validateMacroEvents(f.events, f.options).errors, [])
  assert.notDeepEqual(validateMacroEvents(f.events, { ...f.options, cliCwd: join(f.options.checkout, 'foreign-project') }).errors, [])
  const legacy = cjsFixture()
  assert.notDeepEqual(validateMacroEvents(legacy.events, { ...legacy.options, cliCwd: legacy.options.projectPath }).errors, [])
})
