import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import test from 'node:test'
import { createObserver, installObserverSink, observer } from './conformance-compiler-macro-observer.mjs'
import { validateMacroEvents, CORE_TRANSFORM_MACRO_VALIDATION_PROFILE } from './conformance-compiler-macro-validator.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = source => ({ sha256: hash(source), bytes: Buffer.byteLength(source) })
const copy = value => JSON.parse(JSON.stringify(value))

async function fixture(t, { branch = 'config', nestedConfig = false, inject = false, loadInject = false, macros = 1 } = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'macro-observer-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'checkout'), projectPath = join(checkout, '.tmp/e2e-projects/project')
  await mkdir(join(projectPath, 'src'), { recursive: true })
  const fullRoutes = { pages: ['pages/index/index'], entries: [], subPackages: [] }
  const routes = nestedConfig ? { pages: [], entries: [], subPackages: [] } : fullRoutes
  const setup = branch === 'config' ? "\nimport { pages } from 'weapp-vite/auto-routes'\ndefineAppJson({ pages })\n" : '\ndefineAppJson({ pages: ["pages/index/index"] })\n'
  const effective = branch === 'config' ? setup.replace("import { pages } from 'weapp-vite/auto-routes'", `const { pages } = ${JSON.stringify(routes)};`) : setup
  const installer = 'import { installWebRuntimeGlobals as __weappViteInstallRequestGlobals } from \"weapp-vite/web-apis\"\n__weappViteInstallRequestGlobals({ targets: [\"fetch\"] })\n'
  const prefix = `<script lang=\"ts\">\n${installer}</script>\n`
  const contextOwner = {}
  const original = `<script setup lang="ts">${setup}</script>\n`, filename = join(projectPath, 'src/app.vue')
  await writeFile(filename, original)
  const block = { content: setup, lang: 'ts', loc: { start: { offset: original.indexOf(setup) }, end: { offset: original.indexOf(setup) + setup.length } } }
  const sourceSnapshots = new Map([[filename, { ...digest(original), source: original }]])
  const events = [], loads = [], resolves = [], targets = new Set(), failures = []
  let eventSeq = 0, invocation = 0
  const envelope = () => ({ runId: 'synthetic-run', pid: process.pid, threadId: 0, eventSeq: ++eventSeq })
  const archive = bytes => {
    const result = digest(bytes), file = join(root, 'objects', result.sha256)
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes)
    return { ...result, path: file }
  }
  const current = createObserver({
    onEvent(event) {
      const value = { ...envelope(), ...copy(event) }
      if (event.kind === 'before:fsp.writeFile(target' || event.kind === 'after:fsp.writeFile(target') {
        const file = event.data.target
        value.fileObservation = { path: file, absent: !existsSync(file) }
        if (existsSync(file)) {
          value.fileObservation.regular = lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()
          const artifact = archive(readFileSync(file))
          Object.assign(value.fileObservation, { sha256: artifact.sha256, bytes: artifact.bytes, artifact })
        }
      }
      events.push(value)
    },
    onFailure(error) { failures.push(error.message) },
  })
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context)
      if (targets.has(result.url)) resolves.push({ ...envelope(), kind: 'resolve', specifier, parentURL: context.parentURL, url: result.url })
      return result
    },
    load(url, context, next) {
      if (!targets.has(url)) return next(url, context)
      const file = fileURLToPath(url), bytes = readFileSync(file), sourceArtifact = archive(bytes)
      const result = next(url, context), source = Buffer.from(result.source)
      loads.push({ ...envelope(), kind: 'load', file, macroContext: copy(current.context()), ...digest(bytes), format: result.format,
        loadedSourceSha256: hash(source), sourceArtifact, loadedSourceArtifact: archive(source) })
      return result
    },
  })
  t.after(() => hook.deregister())
  const importFile = join(checkout, 'packages/rolldown-require/dist/index.mjs')
  await mkdir(dirname(importFile), { recursive: true })
  await writeFile(importFile, 'export const load = url => import(url);\n')
  const importer = await import(pathToFileURL(importFile))
  const run = async () => {
    const transformed = branch === 'transform' && (inject || loadInject) ? prefix + original : original
    const transformBlock = { ...block, loc: { start: { offset: transformed.indexOf(setup) }, end: { offset: transformed.indexOf(setup) + setup.length } } }
    const preamble = branch === 'transform' && (inject || loadInject) ? `\n${installer}` : undefined
    if(loadInject) await current.span('core-source-load',{id:filename,compilerContext:current.identity(contextOwner)},async()=>{
      const result=await current.span('load-profiled-entry',{sourceId:filename,type:'page',compilerContext:current.identity(contextOwner)},async()=>current.value('load-profiled-entry-result',{code:original,map:null}))
      const loaded=current.spanSync('load-request-globals-profiled',{result,sourceId:filename,targets:['fetch'],options:{localBindings:true},sourceMap:false,compilerContext:current.identity(contextOwner)},()=>{
        const options={localBindings:true,sourceMap:false}
        return current.value('load-request-globals-profiled-result',current.spanSync('load-request-globals',{result,sourceId:filename,targets:['fetch'],options},()=>{
          const resolution=current.spanSync('request-globals-sfc-resolution',{source:original,targets:['fetch'],options},()=>{
            current.record('request-globals-sfc-descriptor',{source:original,errors:0,scriptSetup:block})
            for(let i=0;i<2;i++)current.spanSync('request-installer-code',{targets:['fetch'],options:{...options,localBindings:false}},()=>current.value('request-installer-code-result',installer))
            return current.value('request-globals-sfc-resolution-result',{index:0,code:prefix})
          })
          return current.value('load-request-globals-result',current.spanSync('code-transform-edit',{result,sourceId:filename,options:{sourceMap:false}},()=>{
            current.record('load-sfc-append-left',{sourceId:filename,index:resolution.index,code:resolution.code})
            const code=original.slice(0,resolution.index)+resolution.code+original.slice(resolution.index)
            current.record('code-transform-edit-code',{sourceId:filename,code})
            return current.value('code-transform-edit-result',{...result,code})
          }))
        }))
      })
      return current.value('core-source-load-result',loaded)
    })
    const coreInput=loadInject?transformed:original
    if (branch === 'transform') await current.span('core-source-transform', { id: filename, code: coreInput, compilerContext: current.identity(contextOwner), platformEnabled: false }, async () => {
      current.record('core-import-meta', { id: filename, code: coreInput })
      const changed = current.spanSync('request-globals-transform', { id: filename, code: coreInput }, () => {
        if (!inject) return current.value('request-globals-transform-result', null)
        return current.value('request-globals-transform-result', current.spanSync('request-globals-sfc-inject', { source: original, targets: ['fetch'], options: {} }, () => {
          const resolution = current.spanSync('request-globals-sfc-resolution', { source: original, targets: ['fetch'], options: {} }, () => {
            current.record('request-globals-sfc-descriptor', { source: original, errors: 0, scriptSetup: block })
            for (let i=0;i<2;i++) current.spanSync('request-installer-code', { targets: ['fetch'], options: {localBindings:false} }, () => current.value('request-installer-code-result', installer))
            return current.value('request-globals-sfc-resolution-result', {index:0,code:prefix})
          })
          return current.value('request-globals-sfc-inject-result', original.slice(0,resolution.index)+resolution.code+original.slice(resolution.index))
        }))
      })
      current.record('core-request-globals', { id: filename, code: changed ?? coreInput })
      return current.value('core-source-transform-result', inject ? {code:transformed,map:null} : null)
    })
    const ownerKind = branch === 'config' ? 'extractConfigFromVue' : branch === 'transform' ? 'transformVueLikeFile' : 'compileVueLikeFile'
    const ownerInput = branch === 'config' ? { vueFilePath: filename } : branch === 'transform' ? { id: filename, code: transformed, compilerContext: current.identity(contextOwner) } : { filename, source: original }
    const extract = () => current.span(ownerKind, ownerInput, async () => {
      if (branch === 'config') {
        current.record('content', { filename, source: original })
        current.record('setupContent', { filename, source: original, scriptSetup: block })
        await current.span('resolveAutoRoutesInlineSnapshot', {}, async () => current.value('inline-routes-snapshot', routes, ['pages', 'entries', 'subPackages']))
        current.spanSync('inlineAutoRoutesImports', { source: setup, inlineRoutes: routes }, () => current.value('inline-routes-result', effective))
        current.record('macroEvalPreamble', { filename, setupContent: setup, autoRoutesInline: routes })
      }
      if (branch === 'transform') current.record('source', {filename,source:transformed})
      const macro = async () => current.span('evaluateScriptSetupJsonMacro', { originalContent: effective, ...(preamble ? {preambleContent:preamble}:{}), filename, lang: 'ts', macroName: 'defineAppJson' }, async () => {
        const token = ++invocation
        const tempDir = join(projectPath, `.weapp-vite/wevu-config/${token}`), tempFile = join(tempDir, 'arbitrary-source.ts')
        const header = 'const __weapp_json_macro_values=[];\nconst __weapp_defineAppJson=c=>(__weapp_json_macro_values.push(c),c);\n'
        const evalSource = header + effective.replace('defineAppJson(', '__weapp_defineAppJson(') + '\nexport default __weapp_json_macro_values;\n'
        current.record('evalSource', { filename, lang: 'ts', macroName: 'defineAppJson', originalContent: effective, ...(preamble ? {preambleContent:preamble}:{}), combinedContent: preamble ? `${preamble}\n${effective}` : effective, evalSource, tempDir })
        await mkdir(tempDir, { recursive: true }); await writeFile(tempFile, evalSource)
        current.record('after:writeFile(tempFile', { filename, tempFile, evalSource })
        const fixedOptions = { isESM: true, format: 'esm', tsconfig: false }
        return current.span('bundleRequire', { options: { filepath: tempFile, cwd: dirname(filename), tsconfig: false } }, async () => {
          current.record('internalOptions', { resolvedPath: tempFile, internalOptions: fixedOptions })
          current.record('cacheConfig', { cacheConfig: { enabled: false } })
          const code = await current.span('bundleFile', { fileName: tempFile, options: fixedOptions }, async () => {
            const captured = current.context()
            // The callback intentionally enters a foreign ALS context; the
            // fixed factory token retains its actual native operation owner.
            await current.span('synthetic-native-callback', {}, async () => {
              current.recordAt(captured, 'actual-bundler-input', { id: tempFile, code: evalSource })
              const inject = `const __vite_injected_original_dirname = ${JSON.stringify(dirname(tempFile))};const __vite_injected_original_filename = ${JSON.stringify(tempFile)};const __vite_injected_original_import_meta_url = ${JSON.stringify(pathToFileURL(tempFile).href)};`
              current.valueAt(captured, 'file-scope-result', { code: inject + evalSource, map: null }, ['code', 'map'], { id: tempFile })
            })
            current.record('entryChunk', { fileName: tempFile, output: [{ type: 'chunk', fileName: 'entry.mjs', isEntry: true, code: evalSource, moduleIds: [tempFile], imports: [], dynamicImports: [] }] })
            return evalSource
          })
          return current.span('loadFromBundledFile', { fileName: tempFile, bundledCode: code, options: fixedOptions, dependencies: [] }, async () => {
            current.record('cacheConfig', { fileName: tempFile, cacheConfig: { enabled: false } })
            const outputFile = await current.span('resolveTempOutputFile', { sourceFile: tempFile, code, options: fixedOptions }, async () => {
              const target = join(projectPath, `.arbitrary-generated-place/${token}.mjs`)
              await mkdir(dirname(target), { recursive: true })
              current.record('before:fsp.writeFile(target', { sourceFile: tempFile, target, code })
              await writeFile(target, code)
              current.record('after:fsp.writeFile(target', { sourceFile: tempFile, target, code })
              return target
            })
            const outfile = pathToFileURL(outputFile).href
            targets.add(outfile)
            current.record('req', { fileName: tempFile, outfile, format: 'esm', defaultRequire: true, bundledCode: code, dependencies: [] })
            const result = await importer.load(outfile)
            current.record('after:mod = await req(outfile', { fileName: tempFile, outfile, format: 'esm' })
            await unlink(outputFile)
            current.record('after:fsp.unlink(target', { sourceFile: tempFile, target: outputFile })
            assert.deepEqual(result.default[0].pages, routes.pages)
            return result
          })
        })
      })
      if (branch === 'config') return macro()
      return current.span('parseVueFile', { source: transformed, filename }, async () => {
        current.record('scriptSetup', { filename, source: transformed, normalizedSource: transformed, parserSource: transformed, scriptSetup: transformBlock, ...(preamble ? {script:{content:preamble,loc:{start:{offset:transformed.indexOf(preamble)},end:{offset:transformed.indexOf(preamble)+preamble.length}}}}:{}) })
        let result; for(let i=0;i<macros;i++) result=await macro(); return result
      })
    })
    if (!nestedConfig) return extract()
    assert.equal(branch, 'config')
    return current.span('extractConfigFromVue', { vueFilePath: filename }, async () => {
      current.record('content', { filename, source: original })
      current.record('setupContent', { filename, source: original, scriptSetup: block })
      const result = await current.span('resolveAutoRoutesInlineSnapshot', {}, async () => {
        const result = await extract()
        current.value('inline-routes-snapshot', fullRoutes, ['pages', 'entries', 'subPackages'])
        return result
      })
      const fullEffective = setup.replace("import { pages } from 'weapp-vite/auto-routes'", `const { pages } = ${JSON.stringify(fullRoutes)};`)
      current.spanSync('inlineAutoRoutesImports', { source: setup, inlineRoutes: fullRoutes }, () => current.value('inline-routes-result', fullEffective))
      current.record('macroEvalPreamble', { filename, setupContent: setup, autoRoutesInline: fullRoutes })
      return result
    })
  }
  const options = { checkout, projectPath, sourceSnapshots, loads, resolves, ...(branch === 'transform' ? {macroProfile:CORE_TRANSFORM_MACRO_VALIDATION_PROFILE}:{}), hookChainClosed: true, validatedTransforms: true }
  return { run, events, options, loads, failures, root }
}

test('actual Node loads bind both Vue extraction branches and archive bytes before original cleanup', async t => {
  for (const branch of ['config', 'direct']) {
    const f = await fixture(t, { branch }); await f.run()
    const result = validateMacroEvents(f.events, f.options)
    assert.deepEqual(result.errors, [])
    assert.equal(result.admittedLoads[0], f.loads[0])
    assert.equal(existsSync(f.loads[0].file), false)
    assert.equal(hash(readFileSync(f.loads[0].sourceArtifact.path)), f.loads[0].sha256)
    assert.deepEqual(f.failures, [])
  }
})

test('concurrent identical macro code retains distinct invocation/load objects and explicit native ownership', async t => {
  const f = await fixture(t); await Promise.all([f.run(), f.run()])
  const result = validateMacroEvents(f.events, f.options)
  assert.deepEqual(result.errors, [])
  assert.equal(result.admittedLoads.length, 2)
  assert.equal(new Set(result.invocations.map(item => item.requireSpanId)).size, 2)
  assert.equal(new Set(result.invocations.map(item => item.outputFile)).size, 2)
  assert.equal(result.invocations[0].sha256, result.invocations[1].sha256)
  const loads = copy(f.loads)
  loads[0].macroContext = loads[1].macroContext
  assert.notDeepEqual(validateMacroEvents(f.events, { ...f.options, loads }).errors, [])
})

const configFlow = events => {
  const owners = events.filter(event => event.kind === 'span-start' && event.span.kind === 'extractConfigFromVue')
  assert.equal(owners.length, 2)
  const [outer, inner] = owners
  const direct = (owner, kind) => events.find(event => event.span.id === owner.span.id && event.kind === kind)
  const child = (owner, kind) => events.find(event => event.kind === 'span-start' && event.span.parentId === owner.span.id && event.span.kind === kind)
  const snapshot = owner => direct(child(owner, 'resolveAutoRoutesInlineSnapshot'), 'inline-routes-snapshot')
  const inline = owner => child(owner, 'inlineAutoRoutesImports')
  return { outer, inner, direct, child, snapshot, inline }
}

test('nested extraction of the same source binds the nearest actual empty snapshot and Node load', async t => {
  const f = await fixture(t, { nestedConfig: true }); await f.run()
  const flow = configFlow(f.events)
  assert.equal(flow.outer.data.input.vueFilePath, flow.inner.data.input.vueFilePath)
  assert.deepEqual(flow.direct(flow.outer, 'content').data, flow.direct(flow.inner, 'content').data)
  assert.deepEqual(flow.snapshot(flow.outer).data.pages, ['pages/index/index'])
  assert.deepEqual(flow.snapshot(flow.inner).data.pages, [])
  const result = validateMacroEvents(f.events, f.options)
  assert.deepEqual(result.errors, [])
  assert.equal(result.admittedLoads.length, 1)
  assert.equal(result.admittedLoads[0], f.loads[0])
  assert.equal(result.invocations.length, 1)
  const generated = f.events.find(event => event.kind === 'evalSource').data.evalSource
  assert.match(generated, /"pages":\[\]/)
  assert.equal(result.invocations[0].inputSha256, hash(generated))
  assert.equal(existsSync(f.loads[0].file), false)
  assert.deepEqual(f.failures, [])
})

test('a foreign or changed nearest owner cannot be skipped for a fully matching farther extraction', async t => {
  const f = await fixture(t, { nestedConfig: true }); await f.run()
  const matching = copy(f.events), flow = configFlow(matching)
  // Make the farther owner a complete valid match too. A filename/source
  // filter that searches past the nearest owner would now admit these attacks.
  flow.direct(flow.outer, 'macroEvalPreamble').data = copy(flow.direct(flow.inner, 'macroEvalPreamble').data)
  flow.snapshot(flow.outer).data = copy(flow.snapshot(flow.inner).data)
  flow.inline(flow.outer).data.input = copy(flow.inline(flow.inner).data.input)
  flow.direct(flow.inline(flow.outer), 'inline-routes-result').data = flow.direct(flow.inline(flow.inner), 'inline-routes-result').data
  assert.deepEqual(validateMacroEvents(matching, f.options).errors, [])
  for (const [name, mutate, error] of [
    ['foreign owner filename', flow => { flow.inner.data.input.vueFilePath = join(f.options.projectPath, 'src/foreign.vue') }, /Vue config source ownership differs/],
    ['foreign content filename', flow => { flow.direct(flow.inner, 'content').data.filename = join(f.options.projectPath, 'src/foreign.vue') }, /Vue config source ownership differs/],
    ['changed source closure', flow => { flow.direct(flow.inner, 'content').data.source += 'changed'; flow.direct(flow.inner, 'setupContent').data.source += 'changed' }, /original source differs/],
    ['detached parsed block', flow => { flow.direct(flow.inner, 'setupContent').data.scriptSetup.loc.start.offset += 1 }, /SFC block differs/],
  ]) {
    await t.test(name, () => {
      const events = copy(matching); mutate(configFlow(events))
      const result = validateMacroEvents(events, f.options)
      assert.match(result.errors.join('\n'), error)
      assert.deepEqual(result.admittedLoads, []); assert.deepEqual(result.invocations, [])
    })
  }
})

test('nested extraction retains strict nearest snapshot, inline input, output and effective setup binding', async t => {
  const f = await fixture(t, { nestedConfig: true }); await f.run()
  for (const [name, mutate, error] of [
    ['foreign inline routes', flow => { flow.inline(flow.inner).data.input.inlineRoutes = copy(flow.snapshot(flow.outer).data) }, /Inline routes differ/],
    ['borrowed outer service snapshot', flow => { flow.snapshot(flow.inner).data = copy(flow.snapshot(flow.outer).data) }, /no actual service snapshot/],
    ['borrowed outer inline output', flow => { flow.direct(flow.inline(flow.inner), 'inline-routes-result').data = flow.direct(flow.inline(flow.outer), 'inline-routes-result').data }, /effective setup\/preamble differs/],
    ['changed effective setup', flow => { flow.direct(flow.inner, 'macroEvalPreamble').data.setupContent += 'changed' }, /script\/preamble extraction differs/],
    ['changed effective preamble', flow => { flow.direct(flow.inner, 'macroEvalPreamble').data.macroEvalPreamble = 'foreign preamble' }, /effective setup\/preamble differs/],
  ]) {
    await t.test(name, () => {
      const events = copy(f.events); mutate(configFlow(events))
      const result = validateMacroEvents(events, f.options)
      assert.match(result.errors.join('\n'), error)
      assert.deepEqual(result.admittedLoads, []); assert.deepEqual(result.invocations, [])
    })
  }
})

test('nested extraction and both snapshot/inline paths must still return successfully', async t => {
  const f = await fixture(t, { nestedConfig: true }); await f.run()
  for (const [name, select] of [
    ['nearest extraction', flow => flow.inner],
    ['farther extraction', flow => flow.outer],
    ['nearest snapshot', flow => flow.child(flow.inner, 'resolveAutoRoutesInlineSnapshot')],
    ['farther snapshot ancestor', flow => flow.child(flow.outer, 'resolveAutoRoutesInlineSnapshot')],
    ['nearest inline', flow => flow.inline(flow.inner)],
  ]) {
    await t.test(name, () => {
      const events = copy(f.events), selected = select(configFlow(events))
      events.find(event => event.kind === 'span-end' && event.span.id === selected.span.id).data.outcome = 'threw'
      const result = validateMacroEvents(events, f.options)
      assert.match(result.errors.join('\n'), /did not return successfully/)
      assert.deepEqual(result.admittedLoads, []); assert.deepEqual(result.invocations, [])
    })
  }
})

test('input, options, native dependencies, writer, hook and final execution mismatches fail closed', async t => {
  const f = await fixture(t); await f.run()
  const mutations = [
    events => { events.find(e => e.kind === 'content').data.source += 'changed' },
    events => { events.find(e => e.kind === 'inline-routes-result').data += 'changed' },
    events => { events.find(e => e.kind === 'evalSource').data.originalContent += 'changed' },
    events => { events.find(e => e.kind === 'span-start' && e.span.kind === 'bundleRequire').data.input.options.source = 'override' },
    events => { events.find(e => e.kind === 'internalOptions').data.internalOptions.isESM = false },
    events => { events.find(e => e.kind === 'cacheConfig').data.cacheConfig.enabled = true },
    events => { events.find(e => e.kind === 'actual-bundler-input').span = null },
    events => { events.find(e => e.kind === 'actual-bundler-input').data.code += 'changed' },
    events => { events.find(e => e.kind === 'entryChunk').data.output[0].moduleIds.push('/unobserved/native.json') },
    events => { events.find(e => e.kind === 'entryChunk').data.output[0].imports.push('node:fs') },
    events => { events.find(e => e.kind === 'span-start' && e.span.kind === 'loadFromBundledFile').data.input.dependencies.push('/unobserved.ts') },
    events => { events.find(e => e.kind === 'before:fsp.writeFile(target').fileObservation.absent = false },
    events => { events.find(e => e.kind === 'after:fsp.writeFile(target').fileObservation.regular = false },
    events => { events.find(e => e.kind === 'req').data.defaultRequire = false },
    events => { events.find(e => e.kind === 'span-end' && e.span.kind === 'bundleFile').data.outcome = 'threw' },
    events => { events.find(e => e.kind === 'span-end' && e.span.kind === 'extractConfigFromVue').data.outcome = 'threw' },
    events => { events.find(e => e.kind === 'span-end' && e.span.kind === 'resolveAutoRoutesInlineSnapshot').data.outcome = 'threw' },
  ]
  for (const mutate of mutations) {
    const events = copy(f.events); mutate(events)
    assert.notDeepEqual(validateMacroEvents(events, f.options).errors, [])
    assert.deepEqual(validateMacroEvents(events, f.options).admittedLoads, [])
  }
  for (const mutate of [
    options => { options.hookChainClosed = false },
    options => { options.validatedTransforms = false },
    options => { options.loads[0].loadedSourceSha256 = 'f'.repeat(64) },
    options => { options.loads[0].macroContext.id += 1 },
    options => { options.resolves[0].parentURL = 'file:///foreign-parent.mjs' },
    options => { options.sourceSnapshots = new Map() },
  ]) {
    const options = { ...f.options, loads: copy(f.options.loads), resolves: copy(f.options.resolves) }; mutate(options)
    assert.notDeepEqual(validateMacroEvents(f.events, options).errors, [])
  }
})

test('observation failures preserve sync/async returns and exact throws while reporting irreversible failure', async () => {
  const failures = [], observed = createObserver({ onEvent() { throw new Error('sink failed') }, onFailure(error) { failures.push(error.message) } })
  const object = {}, error = new Error('original throw')
  assert.equal(observed.spanSync('sync', {}, () => object), object)
  assert.equal(await observed.span('async', {}, async () => object), object)
  assert.throws(() => observed.spanSync('sync-throw', {}, () => { throw error }), thrown => thrown === error)
  await assert.rejects(observed.span('async-throw', {}, async () => { throw error }), thrown => thrown === error)
  assert.ok(failures.length >= 8)
  const expired = observed.context()
  observed.recordAt(expired, 'invalid-context', {})
  assert.ok(failures.some(message => message.includes('active captured span')))
})

test('sync and async observation never read thrown constructor or message getters and preserve the thrown object itself', async () => {
  const events = [], failures = []
  const observed = createObserver({ onEvent(event) { events.push(copy(event)) }, onFailure() { throw new Error('failure sink also failed') } })
  let propertyReads = 0
  const thrown = Object.create(null, {
    constructor: { get() { propertyReads += 1; throw new Error('constructor must not be read') } },
    message: { get() { propertyReads += 1; throw new Error('message must not be read') } },
  })
  assert.throws(() => observed.spanSync('sync-custom-throw', {}, () => { throw thrown }), value => value === thrown)
  await assert.rejects(observed.span('async-custom-throw', {}, async () => { throw thrown }), value => value === thrown)
  assert.equal(propertyReads, 0)
  assert.equal(events.filter(event => event.kind === 'span-end' && event.data.outcome === 'threw' && event.data.errorType === 'object').length, 2)
  const broken = createObserver({ onEvent() { throw new Error('event sink failed') }, onFailure() { throw new Error('failure sink failed') } })
  const returned = {}
  assert.equal(broken.spanSync('sync-return', {}, () => returned), returned)
  assert.equal(await broken.span('async-return', {}, async () => returned), returned)
  assert.throws(() => broken.spanSync('sync-throw', {}, () => { throw thrown }), value => value === thrown)
  await assert.rejects(broken.span('async-throw', {}, async () => { throw thrown }), value => value === thrown)
  assert.equal(propertyReads, 0)
  assert.deepEqual(failures, [])
})

test('the singleton requires exactly one synchronous initialized failure sink', async () => {
  assert.throws(() => observer.record('uninitialized', {}), /not installed/)
  const events = [], failures = []
  let broken = false
  installObserverSink(event => { if (broken) throw new Error('singleton event sink failed'); events.push(event) }, error => {
    failures.push(error.message)
    if (broken) throw new Error('singleton failure sink failed')
  })
  assert.throws(() => installObserverSink(() => {}, () => {}), /already installed/)
  await observer.span('installed', {}, async () => observer.record('recorded', {}))
  assert.equal(events.filter(event => event.kind === 'recorded').length, 1)
  assert.deepEqual(failures, [])
  broken = true
  const returned = {}, thrown = Object.create(null, {
    constructor: { get() { throw new Error('original constructor must not be read') } },
    message: { get() { throw new Error('original message must not be read') } },
  })
  assert.equal(observer.spanSync('singleton-sync-return', {}, () => returned), returned)
  assert.equal(await observer.span('singleton-async-return', {}, async () => returned), returned)
  assert.throws(() => observer.spanSync('singleton-sync-throw', {}, () => { throw thrown }), value => value === thrown)
  await assert.rejects(observer.span('singleton-async-throw', {}, async () => { throw thrown }), value => value === thrown)
  assert.ok(failures.length >= 8)
})


test('compiler context identity uses actual objects without inspecting their fields', () => {
  const failures=[], current=createObserver({onEvent(){},onFailure:e=>failures.push(e.message)})
  let reads=0
  const owner=new Proxy({}, {get(){reads++;throw new Error('identity must not read fields')},ownKeys(){reads++;throw new Error('identity must not enumerate')}})
  assert.equal(current.identity(owner),current.identity(owner))
  assert.notEqual(current.identity(owner),current.identity({}))
  const fn=()=>{}; assert.equal(current.identity(fn),current.identity(fn))
  for (const value of [null,undefined,1,'same/path',true]) assert.equal(current.identity(value),null)
  assert.equal(failures.length,5); assert.equal(reads,0)
})

test('actual Node macro loads bind core predecessor and Vue input with and without SFC injection', async t => {
  for(const inject of [false,true]) {
    const f=await fixture(t,{branch:'transform',inject,macros:2});await f.run()
    const result=validateMacroEvents(f.events,f.options)
    assert.deepEqual(result.errors,[]);assert.equal(result.admittedLoads.length,2);assert.equal(result.invocations.length,2)
    assert.deepEqual(f.failures,[])
    const old=validateMacroEvents(f.events,{...f.options,macroProfile:'pinned-json-macro-esm-cjs-v5-npm-support'})
    if(inject){assert.match(old.errors.join('\n'),/original source differs/);assert.deepEqual(old.admittedLoads,[])}
    else assert.deepEqual(old.errors,[])
  }
})

const startKind=(events,kind)=>events.find(event=>event.kind==='span-start'&&event.span.kind===kind)
const dataKind=(events,kind)=>events.find(event=>event.kind===kind)
const coreTree=events=>{
 const ids=new Set([startKind(events,'core-source-transform').span.id]);let changed
 do{changed=false;for(const event of events)if(ids.has(event.span.parentId)&&!ids.has(event.span.id)){ids.add(event.span.id);changed=true}}while(changed)
 return events.filter(event=>ids.has(event.span.id))
}
const resequence=events=>events.map((event,index)=>({...event,eventSeq:index+1,sequence:index+1}))

test('core source binding rejects absent foreign ambiguous reused or altered predecessor evidence', async t => {
 const f=await fixture(t,{branch:'transform',inject:true});await f.run()
 assert.deepEqual(validateMacroEvents(f.events,f.options).errors,[])
 const mutations=[
  ['missing predecessor',events=>events.filter(event=>!coreTree(events).includes(event)),/preceding core transform/],
  ['foreign actual context',events=>{startKind(events,'core-source-transform').data.input.compilerContext++;return events},/preceding core transform/],
  ['missing actual context',events=>{delete startKind(events,'transformVueLikeFile').data.input.compilerContext;return events},/compiler-context identity/],
  ['foreign ID',events=>{startKind(events,'core-source-transform').data.input.id+='?foreign';return events},/preceding core transform/],
  ['changed original closure',events=>{startKind(events,'core-source-transform').data.input.code+='changed';return events},/preceding load/],
  ['changed actual return',events=>{dataKind(events,'core-source-transform-result').data.code+='changed';return events},/actual return differs/],
  ['changed downstream hook input',events=>{startKind(events,'transformVueLikeFile').data.input.code+='changed';return events},/hook input/],
  ['missing actual result',events=>events.filter(event=>event.kind!=='core-source-transform-result'),/core-source-transform-result/],
  ['duplicate actual result',events=>{const i=events.findIndex(event=>event.kind==='core-source-transform-result');events.splice(i,0,copy(events[i]));return resequence(events)},/core-source-transform-result/],
  ['failed predecessor',events=>{events.find(event=>event.kind==='span-end'&&event.span.kind==='core-source-transform').data.outcome='threw';return events},/did not return/],
  ['ambiguous prior owner',events=>{const duplicate=copy(coreTree(events));for(const event of duplicate){event.span.id+=100000;if(event.span.parentId!==null)event.span.parentId+=100000}return resequence([...duplicate,...events])},/preceding core transform/],
  ['predecessor after consumer',events=>resequence([...events.filter(event=>!coreTree(events).includes(event)),...coreTree(events)]),/preceding core transform/],
  ['unobserved platform result',events=>{startKind(events,'core-source-transform').data.input.platformEnabled=true;return events},/platform transform result/],
 ]
 for(const [name,mutate,pattern]of mutations)await t.test(name,()=>{const result=validateMacroEvents(mutate(copy(f.events)),f.options);assert.match(result.errors.join('\n'),pattern);assert.deepEqual(result.admittedLoads,[])})
 const g=await fixture(t,{branch:'transform',inject:true});await g.run();await g.run()
 const second=startKind(g.events.filter(event=>event.eventSeq>g.events.find(event=>event.kind==='span-end'&&event.span.kind==='transformVueLikeFile').eventSeq),'core-source-transform')
 const ids=new Set([second.span.id]);for(const event of g.events)if(ids.has(event.span.parentId))ids.add(event.span.id)
 const reused=validateMacroEvents(g.events.filter(event=>!ids.has(event.span.id)),g.options)
 assert.match(reused.errors.join('\n'),/preceding core transform/);assert.deepEqual(reused.admittedLoads,[])
})

test('SFC predecessor requires exact parsed insertion bytes options and operation counts', async t => {
 const f=await fixture(t,{branch:'transform',inject:true});await f.run()
 const mutations=[
  ['changed insertion offset',events=>{dataKind(events,'request-globals-sfc-resolution-result').data.index=1},/position\/code/],
  ['changed generated insertion',events=>{dataKind(events,'request-globals-sfc-resolution-result').data.code+='changed'},/position\/code/],
  ['changed installer result',events=>{dataKind(events,'request-installer-code-result').data+='changed'},/installer bytes\/options/],
  ['changed installer targets',events=>{startKind(events,'request-installer-code').data.input.targets=['Response']},/installer bytes\/options/],
  ['foreign installer option',events=>{startKind(events,'request-installer-code').data.input.options.foreign=true},/installer bytes\/options/],
  ['passive installer unsupported',events=>{startKind(events,'request-globals-sfc-inject').data.input.options.passiveLocalBindings=true;startKind(events,'request-globals-sfc-resolution').data.input.options.passiveLocalBindings=true},/active installer contract/],
  ['changed parsed block offset',events=>{dataKind(events,'request-globals-sfc-descriptor').data.scriptSetup.loc.start.offset++},/SFC block differs/],
  ['original parse failed',events=>{dataKind(events,'request-globals-sfc-descriptor').data.errors=1},/successful original parse/],
  ['missing generator',events=>{const id=startKind(events,'request-installer-code').span.id;return events.filter(event=>event.span.id!==id)},/generation is missing/],
  ['changed source splice',events=>{dataKind(events,'request-globals-sfc-inject-result').data+='changed'},/source splice/],
  ['foreign request input',events=>{startKind(events,'request-globals-transform').data.input.code+='changed'},/input or operation order/],
 ]
 for(const[name,mutate,pattern]of mutations)await t.test(name,()=>{let events=copy(f.events);events=mutate(events)??events;const result=validateMacroEvents(events,f.options);assert.match(result.errors.join('\n'),pattern);assert.deepEqual(result.admittedLoads,[])})
})


test('load to core to Vue source authority requires actual raw entry, exact MagicString splice and completed return chain',async t=>{
 const f=await fixture(t,{branch:'transform',loadInject:true,macros:2});await f.run()
 const positive=validateMacroEvents(f.events,f.options);assert.deepEqual(positive.errors,[]);assert.equal(positive.admittedLoads.length,2)
 assert.match(validateMacroEvents(f.events,{...f.options,macroProfile:'pinned-json-macro-esm-cjs-v5-npm-support'}).errors.join('\n'),/original source differs/)
 const tree=(events,kind)=>{const ids=new Set([startKind(events,kind).span.id]);let change;do{change=false;for(const e of events)if(ids.has(e.span.parentId)&&!ids.has(e.span.id)){ids.add(e.span.id);change=true}}while(change);return events.filter(e=>ids.has(e.span.id))}
 const moveBefore=(events,kind,before)=>{const event=dataKind(events,kind);events.splice(events.indexOf(event),1);events.splice(events.indexOf(startKind(events,before)),0,event);return resequence(events)}
 const mutations=[
  ['missing load',events=>events.filter(e=>!tree(events,'core-source-load').includes(e)),/preceding load/],
  ['foreign load context',events=>{startKind(events,'core-source-load').data.input.compilerContext++;return events},/preceding load/],
  ['foreign load id',events=>{startKind(events,'core-source-load').data.input.id+='?foreign';return events},/preceding load/],
  ['foreign raw entry context',events=>{startKind(events,'load-profiled-entry').data.input.compilerContext++;return events},/Entry load/],
  ['changed raw entry closure',events=>{dataKind(events,'load-profiled-entry-result').data.code+='changed';return events},/original source differs/],
  ['detached profiled input',events=>{startKind(events,'load-request-globals-profiled').data.input.result.code+='changed';return events},/Profiled globals input/],
  ['detached injection options',events=>{startKind(events,'load-request-globals').data.input.options.sourceMap=true;return events},/input\/options\/source identity/],
  ['detached edit input',events=>{startKind(events,'code-transform-edit').data.input.result.code+='changed';return events},/MagicString edit input/],
  ['wrong appendLeft index',events=>{dataKind(events,'load-sfc-append-left').data.index++;return events},/MagicString actual appendLeft/],
  ['wrong appendLeft bytes',events=>{dataKind(events,'load-sfc-append-left').data.code+='changed';return events},/MagicString actual appendLeft/],
  ['wrong actual edit bytes',events=>{dataKind(events,'code-transform-edit-code').data.code+='changed';return events},/MagicString actual appendLeft/],
  ['wrong actual edit return',events=>{dataKind(events,'code-transform-edit-result').data.code+='changed';return events},/MagicString actual appendLeft/],
  ['wrong actual load return',events=>{dataKind(events,'core-source-load-result').data.code+='changed';return events},/Actual load return/],
  ['missing append witness',events=>events.filter(e=>e.kind!=='load-sfc-append-left'),/load-sfc-append-left/],
  ['duplicated append witness',events=>{const i=events.indexOf(dataKind(events,'load-sfc-append-left'));events.splice(i,0,copy(events[i]));return resequence(events)},/load-sfc-append-left/],
  ['return before injection',events=>moveBefore(events,'core-source-load-result','load-request-globals-profiled'),/Actual load return/],
  ['splice before resolution',events=>moveBefore(events,'code-transform-edit-result','request-installer-code'),/Macro event context is unknown|MagicString actual|Macro span closed before/],
  ['ambiguous load',events=>{const dup=copy(tree(events,'core-source-load'));for(const e of dup){e.span.id+=100000;if(e.span.parentId!==null)e.span.parentId+=100000}return resequence([...dup,...events])},/preceding load/],
  ['load after core',events=>resequence([...events.filter(e=>!tree(events,'core-source-load').includes(e)),...tree(events,'core-source-load')]),/preceding load/],
 ]
 for(const[name,mutate,pattern]of mutations)await t.test(name,()=>{const result=validateMacroEvents(mutate(copy(f.events)),f.options);assert.match(result.errors.join('\n'),pattern);assert.deepEqual(result.admittedLoads,[])})
})
