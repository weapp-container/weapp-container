/** Portable synthetic contract fixtures. No compiler/addon is imported or run.
 * File observations, member pins and dlopen events below are synthetic claims
 * used to test the validator; they do not establish real execution or CAS proof.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MACRO_VALIDATION_PROFILE } from '../conformance-compiler-macro-validator.mjs'

export const runtimeId = '\0rolldown/runtime.js'
export const runtimeText = readFileSync(new URL('./conformance-compiler-macro-runtime.txt', import.meta.url), 'utf8')
export const hash = value => createHash('sha256').update(value).digest('hex')
export const digest = value => ({ sha256: hash(value), bytes: Buffer.byteLength(value) })
const rolldownRoot = 'node_modules/.pnpm/rolldown@1.2.14_patch_hash=61de75b4db18dfb15bfc1a547cbf43938d0602149f61d9a2e81e14b117aeb6a0/node_modules/rolldown'
const nativeRoot = 'node_modules/.pnpm/@rolldown+binding-darwin-arm64@1.2.14/node_modules/@rolldown/binding-darwin-arm64'
export const pins = [
  { role: 'package', path: `${rolldownRoot}/package.json`, sha256: 'f46fa23bccbb2a1ee76a763b02a55853cdfea4aaf8b0f3b82e8d16bad8778020', bytes: 6101 },
  { role: 'wrapper', path: `${rolldownRoot}/dist/shared/binding-CUpfdq6A.mjs`, sha256: 'c0bca197e7c7819c84f6b0f1ab5e3923895c5aa140e5243df72ab375554f19a1', bytes: 35052 },
  { role: 'nativePackage', path: `${nativeRoot}/package.json`, sha256: 'b453dd4db5ea29e4a14fdfeada50b19aff59e64286dbc8b28fd219bf9be63d27', bytes: 855 },
  { role: 'addon', path: `${nativeRoot}/rolldown-binding.darwin-arm64.node`, sha256: '4e4ecbcd8bbdf4b189127493f79fef124c5c3dee1a68c02b2953bf29e9aebf1f', bytes: 17084304 },
]

export function fixture({ runtime = true, invocations = 1 } = {}) {
  const checkout = join(tmpdir(), '__synthetic_macro_validator_checkout__')
  const projectPath = join(checkout, 'synthetic-project'), filename = join(projectPath, 'src/app.vue')
  const setup = '\ndefineAppJson({ pages: ["pages/index/index"] })\n'
  const source = `<script setup lang="ts">${setup}</script>\n`
  const block = { content: setup, lang: 'ts', loc: { start: { offset: source.indexOf(setup) }, end: { offset: source.indexOf(setup) + setup.length } } }
  const fixedOptions = { isESM: true, format: 'esm', tsconfig: false }
  const events = [], loads = [], resolves = [], spans = []
  let eventSeq = 0, sequence = 0, spanId = 0
  const envelope = () => ({ runId: 'explicit-synthetic-portable-run', pid: 424242, threadId: 0, eventSeq: ++eventSeq })
  const start = (kind, input) => {
    const span = { id: ++spanId, parentId: spans.at(-1)?.id ?? null, kind }
    spans.push(span); events.push({ ...envelope(), sequence: ++sequence, kind: 'span-start', span, data: { kind, input } })
    return span
  }
  const record = (kind, data, extra = {}) => events.push({ ...envelope(), sequence: ++sequence, kind, span: spans.at(-1), data, ...extra })
  const end = () => {
    const span = spans.at(-1)
    record('span-end', { kind: span.kind, outcome: 'returned' }); spans.pop()
  }
  const artifact = code => ({ ...digest(code), path: `synthetic-unread-artifact:${hash(code)}` })
  const scopeResult = (id, code) => ({ id, map: null,
    code: `const __vite_injected_original_dirname = ${JSON.stringify(dirname(id))};const __vite_injected_original_filename = ${JSON.stringify(id)};const __vite_injected_original_import_meta_url = ${JSON.stringify(pathToFileURL(id === runtimeId ? join(checkout, id) : id).href)};` + code })
  const members = new Map(pins.map(pin => [pin.path, { path: pin.path, kind: 'file', origin: 'dependency', sha256: pin.sha256, bytes: pin.bytes }]))
  if (runtime) for (const pin of pins.filter(pin => pin.role !== 'package')) {
    loads.push({ ...envelope(), kind: 'load', file: join(checkout, pin.path), path: pin.path, sha256: pin.sha256,
      bytes: pin.bytes, classification: 'bound', format: pin.role === 'addon' ? 'addon' : pin.role === 'wrapper' ? 'module' : 'json',
      loadedSourceSha256: pin.role === 'addon' ? null : pin.sha256,
      ...(pin.role === 'addon' ? { boundary: 'process.dlopen', nativeFileStable: true, witnessToken: 1 } : {}) })
  }
  for (let index = 0; index < invocations; index++) {
    const tempDir = join(checkout, 'synthetic-input', String(index)), tempFile = join(tempDir, 'entry.ts')
    const target = join(checkout, 'synthetic-output', `${index}.mjs`), outfile = pathToFileURL(target).href
    const evalSource = 'const __weapp_json_macro_values=[];\nconst __weapp_defineAppJson=c=>(__weapp_json_macro_values.push(c),c);\n'
      + setup.replace('defineAppJson(', '__weapp_defineAppJson(') + '\nexport default __weapp_json_macro_values;\n'
    const code = (runtime ? 'import "node:module";\n' : '') + 'export default [{pages:["pages/index/index"]}];\n'
    const dependencies = runtime ? [runtimeId] : []
    start('compileVueLikeFile', { filename, source })
    start('parseVueFile', { filename, source })
    record('scriptSetup', { filename, source, normalizedSource: source, scriptSetup: block })
    start('evaluateScriptSetupJsonMacro', { filename, originalContent: setup, lang: 'ts', macroName: 'defineAppJson' })
    record('evalSource', { filename, originalContent: setup, combinedContent: setup, lang: 'ts', macroName: 'defineAppJson', evalSource, tempDir })
    record('after:writeFile(tempFile', { filename, tempFile, evalSource })
    start('bundleRequire', { options: { filepath: tempFile, cwd: dirname(filename), tsconfig: false } })
    record('internalOptions', { resolvedPath: tempFile, internalOptions: fixedOptions })
    record('cacheConfig', { cacheConfig: { enabled: false } })
    start('bundleFile', { fileName: tempFile, options: fixedOptions })
    if (runtime) {
      record('actual-bundler-input', { id: runtimeId, code: runtimeText })
      record('file-scope-result', scopeResult(runtimeId, runtimeText))
    }
    record('actual-bundler-input', { id: tempFile, code: evalSource })
    record('file-scope-result', scopeResult(tempFile, evalSource))
    record('entryChunk', { fileName: tempFile, output: [{ type: 'chunk', isEntry: true, fileName: 'entry.mjs', code,
      moduleIds: runtime ? [runtimeId, tempFile] : [tempFile], imports: runtime ? ['node:module'] : [], dynamicImports: [] }] })
    end()
    const loader = start('loadFromBundledFile', { fileName: tempFile, bundledCode: code, options: fixedOptions, dependencies })
    record('cacheConfig', { cacheConfig: { enabled: false } })
    start('resolveTempOutputFile', { sourceFile: tempFile, code, options: fixedOptions })
    record('before:fsp.writeFile(target', { sourceFile: tempFile, code, target }, { fileObservation: { path: target, absent: true } })
    record('after:fsp.writeFile(target', { sourceFile: tempFile, code, target }, { fileObservation: { path: target, regular: true, ...digest(code), artifact: artifact(code) } })
    end()
    record('req', { fileName: tempFile, outfile, format: 'esm', defaultRequire: true, bundledCode: code, dependencies })
    resolves.push({ ...envelope(), kind: 'resolve', specifier: outfile, url: outfile,
      parentURL: pathToFileURL(join(checkout, 'packages/rolldown-require/dist/index.mjs')).href })
    loads.push({ ...envelope(), kind: 'load', file: target, format: 'module', classification: 'unbound', ...digest(code),
      macroContext: { ...loader }, sourceArtifact: artifact(code), loadedSourceSha256: hash(code), loadedSourceArtifact: artifact(code) })
    if (runtime) resolves.push({ ...envelope(), kind: 'resolve', specifier: 'node:module', url: 'node:module', parentURL: outfile })
    record('after:mod = await req(outfile', { fileName: tempFile, outfile, format: 'esm' })
    end(); end(); end(); end(); end()
  }
  return { events, options: { checkout, cliCwd: checkout, projectPath, sourceSnapshots: new Map([[filename, { ...digest(source), source }]]),
    members, loads, resolves, hookChainClosed: true, validatedTransforms: true, macroProfile: MACRO_VALIDATION_PROFILE } }
}
