/** Synthetic CJS witness for strict offline-reader contract tests only.
 * Native pins, compilation events and physical observations are fabricated
 * claims here; this fixture never runs a compiler, addon or official runtime. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { pins, digest, hash } from './conformance-compiler-macro-runtime.mjs'
import { CJS_MACRO_VALIDATION_PROFILE, CJS_RUNTIME_MACRO_VALIDATION_PROFILE } from '../conformance-compiler-macro-validator.mjs'

const runtimeId = '\0rolldown/runtime.js'
const runtimeText = readFileSync(new URL('./conformance-compiler-macro-cjs-runtime.txt', import.meta.url), 'utf8')

export function cjsFixture({ invocations = 1, runtimeInput = false } = {}) {
  const checkout = join(tmpdir(), '__synthetic_cjs_macro_checkout__'), projectPath = join(checkout, 'project')
  const filename = join(projectPath, 'src/app.vue'), setup = '\ndefineAppJson({pages:["pages/index/index"]})\n'
  const source = `<script setup lang="ts">${setup}</script>\n`, packageSource = '{"name":"synthetic-cjs-project"}\n'
  const block = { content: setup, lang: 'ts', loc: { start: { offset: source.indexOf(setup) }, end: { offset: source.indexOf(setup) + setup.length } } }
  const events = [], loads = [], resolves = [], spans = [], objects = new Map()
  const fixedOptions = { isESM: false, format: 'cjs', tsconfig: false }
  let eventSeq = 0, sequence = 0, spanId = 0
  const envelope = () => ({ runId: 'explicit-synthetic-cjs-run', pid: 424243, threadId: 0, eventSeq: ++eventSeq })
  const artifact = code => { objects.set(hash(code), Buffer.from(code)); return { ...digest(code), path: `synthetic-unread-artifact:${hash(code)}` } }
  const physical = (file, text) => ({ path: file, absent: false, regular: true, ...digest(text), artifact: artifact(text) })
  const start = (kind, input) => { const span = { id: ++spanId, parentId: spans.at(-1)?.id ?? null, kind }; spans.push(span)
    events.push({ ...envelope(), sequence: ++sequence, kind: 'span-start', span, data: { kind, input } }); return span }
  const record = (kind, data, extra = {}) => events.push({ ...envelope(), sequence: ++sequence, kind, span: spans.at(-1), data, ...extra })
  const end = () => { record('span-end', { kind: spans.at(-1).kind, outcome: 'returned' }); spans.pop() }
  const members = new Map(pins.map(pin => [pin.path, { path: pin.path, kind: 'file', origin: 'dependency', sha256: pin.sha256, bytes: pin.bytes }]))
  for (const pin of pins.filter(pin => pin.role !== 'package')) loads.push({ ...envelope(), kind: 'load', file: join(checkout, pin.path), path: pin.path,
    classification: 'bound', sha256: pin.sha256, bytes: pin.bytes, format: pin.role === 'addon' ? 'addon' : pin.role === 'wrapper' ? 'module' : 'json',
    loadedSourceSha256: pin.role === 'addon' ? null : pin.sha256,
    ...(pin.role === 'addon' ? { boundary: 'process.dlopen', nativeFileStable: true, witnessToken: 1 } : {}) })
  for (let index = 0; index < invocations; index++) {
    const tempDir = join(projectPath, 'generated', String(index)), tempFile = join(tempDir, 'entry.ts')
    const evalSource = 'const values:unknown[]=[];\n' + setup + '\nmodule.exports=values;\n', code = 'module.exports=[{pages:["pages/index/index"]}];\n'
    start('compileVueLikeFile', { filename, source }); start('parseVueFile', { filename, source })
    record('scriptSetup', { filename, source, normalizedSource: source, scriptSetup: block })
    start('evaluateScriptSetupJsonMacro', { filename, originalContent: setup, lang: 'ts', macroName: 'defineAppJson' })
    record('evalSource', { filename, originalContent: setup, combinedContent: setup, lang: 'ts', macroName: 'defineAppJson', evalSource, tempDir })
    record('after:writeFile(tempFile', { filename, tempFile, evalSource }, { fileObservation: physical(tempFile, evalSource) })
    start('bundleRequire', { options: { filepath: tempFile, cwd: dirname(filename), tsconfig: false } })
    start('detectModuleType', { resolvedPath: tempFile })
    let directory = dirname(tempFile)
    while (directory !== projectPath) { const pkgPath = join(directory, 'package.json'); record('module-type-stat', { pkgPath }, { fileObservation: { path: pkgPath, absent: true } }); directory = dirname(directory) }
    const pkgPath = join(directory, 'package.json')
    record('module-type-stat', { pkgPath, regular: true }, { fileObservation: physical(pkgPath, packageSource) })
    record('module-type-package', { pkgPath, data: JSON.parse(packageSource) }, { fileObservation: physical(pkgPath, packageSource) })
    record('module-type-result', { resolvedPath: tempFile, isESM: false, deno: false }); end()
    record('internalOptions', { resolvedPath: tempFile, internalOptions: fixedOptions }); record('cacheConfig', { cacheConfig: { enabled: false } })
    start('bundleFile', { fileName: tempFile, options: fixedOptions })
    if (runtimeInput) {
      record('actual-bundler-input', { id: runtimeId, code: runtimeText })
      record('file-scope-result', { id: runtimeId, map: null,
        code: `const __vite_injected_original_dirname = ${JSON.stringify(dirname(runtimeId))};const __vite_injected_original_filename = ${JSON.stringify(runtimeId)};const __vite_injected_original_import_meta_url = ${JSON.stringify(pathToFileURL(join(checkout, runtimeId)).href)};` + runtimeText })
    }
    record('actual-bundler-input', { id: tempFile, code: evalSource })
    record('file-scope-result', { id: tempFile, map: null,
      code: `const __vite_injected_original_dirname = ${JSON.stringify(dirname(tempFile))};const __vite_injected_original_filename = ${JSON.stringify(tempFile)};const __vite_injected_original_import_meta_url = ${JSON.stringify(pathToFileURL(tempFile).href)};` + evalSource })
    record('entryChunk', { fileName: tempFile, output: [{ type: 'chunk', isEntry: true, fileName: 'entry.cjs', code, moduleIds: [tempFile], imports: [], dynamicImports: [] }] }); end()
    start('loadFromBundledFile', { fileName: tempFile, bundledCode: code, options: fixedOptions, dependencies: [] })
    record('cacheConfig', { cacheConfig: { enabled: false } })
    const fileFields = { fileName: tempFile, realFileName: tempFile, extension: '.ts' }
    record('cjs-extension-before', { ...fileFields, originalLoaderType: 'undefined', fallbackLoaderType: 'function' })
    record('cjs-extension-installed', { ...fileFields, installed: true })
    const resolve = () => resolves.push({ ...envelope(), kind: 'resolve', specifier: tempFile, url: pathToFileURL(tempFile).href,
      parentURL: pathToFileURL(join(checkout, 'packages/rolldown-require/dist/index.mjs')).href })
    resolve(); record('cjs-cache-cleared', { fileName: tempFile, realFileName: tempFile, cacheAbsent: true })
    record('cjs-require-before', { ...fileFields, defaultRequire: true, bundledCode: code, dependencies: [] }); resolve()
    const compile = start('cjs-compile-loader', { ...fileFields, filename: tempFile, bundledCode: code, selected: true })
    loads.push({ ...envelope(), kind: 'load', boundary: 'Module.prototype._compile', format: 'commonjs', classification: 'unbound', file: tempFile,
      ...digest(evalSource), sourceArtifact: artifact(evalSource), loadedSourceSha256: hash(code), loadedSourceArtifact: artifact(code), macroContext: { ...compile },
      terminalResult: true, executionReturned: true, filename: tempFile, receiver: 'Module', argumentCount: 2, witnessToken: 1 })
    end(); record('cjs-require-after', fileFields); record('cjs-extension-restored', { ...fileFields, restored: true })
    end(); end(); end(); end(); end()
  }
  return { events, objects, options: { checkout, cliCwd: checkout, projectPath, sourceSnapshots: new Map([
    [filename, { ...digest(source), source }], [join(projectPath, 'package.json'), { ...digest(packageSource), source: packageSource }]]), members, loads, resolves,
    hookChainClosed: true, validatedTransforms: true, macroProfile: runtimeInput ? CJS_RUNTIME_MACRO_VALIDATION_PROFILE : CJS_MACRO_VALIDATION_PROFILE } }
}
