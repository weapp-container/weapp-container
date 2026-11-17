#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, posix, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { WEB_SAMPLE_FILES } from './build-web-wasm.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HEX = /^[0-9a-f]{64}$/
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw new Error(message) }
// Staging and execution consumers share the complete source inventory. Exact
// retained hashes and import-closure verification remain independent checks.
const FILES = WEB_SAMPLE_FILES
export { FILES as WORKER_PRODUCT_FILES }
// Matches the separately source-bound generated-package-closure build gate.
// This independent consumer checks retained parser bytes before evaluating them.
export const PARSER_FILES = Object.freeze([
  { path: 'package.json', size: 1061, sha256: '9e422c8225c9cc4c774e9a9392d0ecac7f766b46122ef2db99db0fc4bbedc247' },
  { path: 'dist/acorn.mjs', size: 229792, sha256: 'b4c8c70200e72bae33cf1085e0ecb1e792c1b6924ed50cab817caf14f51bb249' },
  { path: 'LICENSE', size: 1099, sha256: '76a876cf886ff9be2a8b5e2e86514fed06223c8c9f0c1e9ee9606e93841e00b7' },
])
const LIMITS = Object.freeze({ file: 96 * 1024 * 1024, retained: 384 * 1024 * 1024, index: 2 * 1024 * 1024 })
const FIXTURE = Object.freeze({ id: 'worker-product-counter-v1', route: 'pages/home/index',
  button: { x: 96, y: 64 }, feedback: { x: 100, y: 144 }, before: [31, 75, 153, 255], after: [30, 132, 73, 255] })

export function parseArgs(args) {
  const options = {}, names = new Map([['--dom-site-dir', 'domSiteDir'], ['--dom-index-sha256', 'domIndexSha256'],
    ['--canvas-site-dir', 'canvasSiteDir'], ['--canvas-index-sha256', 'canvasIndexSha256'], ['--out-dir', 'outDir']])
  for (let i = 0; i < args.length; i++) {
    const key = names.get(args[i])
    assert.ok(key && args[i + 1] && !args[i + 1].startsWith('--'), `Unknown argument or missing value: ${args[i]}`)
    assert.equal(options[key], undefined, `Duplicate argument: ${args[i]}`)
    options[key] = args[++i]
  }
  for (const key of names.values()) assert.ok(options[key], `Missing required ${key}`)
  for (const key of ['domIndexSha256', 'canvasIndexSha256']) assert.match(options[key], HEX, 'An independently supplied exact index pin is required')
  assert.notEqual(options.domIndexSha256, options.canvasIndexSha256, 'The two renderer packs must have different exact pins')
  for (const key of ['domSiteDir', 'canvasSiteDir', 'outDir']) options[key] = resolve(options[key])
  const paths = [options.domSiteDir, options.canvasSiteDir, options.outDir]
  for (let i = 0; i < paths.length; i++) for (let j = 0; j < i; j++) {
    assert.ok(paths[i] !== paths[j] && !paths[i].startsWith(paths[j] + sep) && !paths[j].startsWith(paths[i] + sep),
      'Both sites and evidence must be separate, nonoverlapping directories')
  }
  return options
}

export function localPath(root, path) {
  assert.ok(typeof path === 'string' && path.length && !path.startsWith('/') && !/[\\?#\x00-\x1f%]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..'), `Invalid retained path: ${path}`)
  const result = resolve(root, path)
  assert.ok(result.startsWith(root + sep), 'Retained file escaped its root')
  return result
}
export async function regularBytes(root, path, limit = LIMITS.file) {
  const target = localPath(root, path), stat = await lstat(target)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && await realpath(target) === target, `Nonregular or symlinked retained file: ${path}`)
  assert.ok(stat.size >= 0 && stat.size <= limit, `Retained file exceeds its finite budget: ${path}`)
  const bytes = await readFile(target)
  assert.equal(bytes.length, stat.size, `Retained file changed while reading: ${path}`)
  return bytes
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (record(value)) return '{' + Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
export function productConfigBytes(value) {
  return Buffer.from(`const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }\nexport const WORKER_PRODUCT_CONFIG = freeze(JSON.parse(${JSON.stringify(JSON.stringify(value))}))\n`)
}

/** Parse source only. The sole nonliteral import is the source-bound admission
 * loader's verified CanvasKit Blob. Application modules are never imported here. */
export function inspectImportGraph(files, entry, parseModule) {
  const pending = [entry], visited = new Set(), blobImports = [], resources = new Set(), byFile = {}
  while (pending.length) {
    const file = pending.pop()
    if (visited.has(file)) continue
    const bytes = files.get(file)
    assert.ok(bytes, `Missing retained import dependency: ${file}`)
    visited.add(file)
    const ast = parseModule(bytes.toString('utf8'), { sourceType: 'module', ecmaVersion: 'latest' })
    const references = []
    const walk = node => {
      if (!node || typeof node !== 'object') return
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) references.push({ kind: 'module', specifier: node.source.value })
      if (node.type === 'ImportExpression') {
        const literal = node.source?.type === 'Literal' ? node.source.value
          : node.source?.type === 'TemplateLiteral' && node.source.expressions.length === 0 ? node.source.quasis[0].value.cooked : undefined
        if (typeof literal === 'string') references.push({ kind: 'module', specifier: literal })
        else {
          assert.ok(file === 'worker-admission-loader.mjs' && node.source?.type === 'Identifier' && node.source.name === 'url',
            `Unclassified nonliteral import: ${file}`)
          blobImports.push({ file, contract: 'full-six-pinned-CanvasKit-resources-before-Blob-import' })
        }
      }
      const base = node.arguments?.[1]
      if (node.type === 'NewExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'URL'
        && base?.type === 'MemberExpression' && !base.computed && base.property?.name === 'url'
        && base.object?.type === 'MetaProperty' && base.object.meta?.name === 'import' && base.object.property?.name === 'meta') {
        const source = node.arguments[0], literal = source?.type === 'Literal' ? source.value
          : source?.type === 'TemplateLiteral' && source.expressions.length === 0 ? source.quasis[0].value.cooked : undefined
        assert.equal(typeof literal, 'string', `Unclassified import.meta.url resource: ${file}`)
        references.push({ kind: 'resource', specifier: literal })
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk)
        else if (value && typeof value === 'object') walk(value)
      }
    }
    walk(ast)
    byFile[file] = []
    for (const reference of references) {
      const specifier = reference.specifier
      assert.ok(typeof specifier === 'string' && specifier.length && !/[\\%?#\x00-\x20\x7f:]/.test(specifier) && !specifier.startsWith('/'),
        `Invalid module/resource reference: ${file}`)
      assert.ok(reference.kind === 'resource' || specifier.startsWith('./') || specifier.startsWith('../'), `External module reference: ${file} -> ${specifier}`)
      const target = posix.normalize(posix.join(posix.dirname(file), specifier))
      localPath('/retained', target)
      assert.ok(files.has(target), `Unretained import/resource: ${file} -> ${target}`)
      if (file.startsWith('pkg/')) assert.ok(target.startsWith('pkg/'), `Generated dependency escaped pkg: ${file} -> ${target}`)
      byFile[file].push({ ...reference, path: target })
      if (reference.kind === 'module') {
        assert.ok(/\.(?:m?js)$/.test(target), `Module import is not JavaScript: ${target}`)
        pending.push(target)
      } else resources.add(target)
    }
  }
  return { files: [...visited].sort(), blobImports, resources: [...resources].sort(), references: byFile }
}

/** Keep a byte-frozen serve map, independent of later checkout/site mutations. */
export async function inspectProductSite(siteDir, { expectedIndexSha256, profile, parseModule }) {
  assert.match(expectedIndexSha256, HEX)
  assert.ok(['webview', 'skia'].includes(profile))
  const root = await realpath(siteDir)
  assert.equal(root, resolve(siteDir), 'Use a regular, non-symlinked retained site root')
  const reportBytes = await regularBytes(root, 'build-report.json'), build = JSON.parse(reportBytes)
  assert.equal(build.status, 'passed'); assert.equal(build.ready, true); assert.equal(build.buildStatus, 'passed')
  assert.equal(build.source?.status, 'passed'); assert.equal(build.source?.workingTreeDirty, false); assert.equal(build.source?.sourceStable, true)
  assert.match(build.source?.sourceCommit, /^[0-9a-f]{40}$/)
  assert.equal(build.source.sourceSha256, digest(JSON.stringify(build.source.sourceFiles)), 'Invalid source inventory hash')
  assert.equal(build.plan?.execution, 'worker'); assert.equal(build.plan?.entry, 'index.html'); assert.equal(build.plan?.entryModule, 'worker-app.mjs')
  // The report remains historical static evidence. This runner never upgrades it.
  const files = new Map(), inventory = {}, sourceRoot = await realpath(resolve(root, 'source'))
  assert.equal(sourceRoot, resolve(root, 'source'))
  assert.ok(record(build.source.sourceFiles) && Object.keys(build.source.sourceFiles).length <= 10_000, 'Source inventory exceeds its finite file budget')
  let sourceBytes = 0
  for (const [path, hash] of Object.entries(build.source.sourceFiles)) {
    assert.match(hash, HEX)
    const bytes = await regularBytes(sourceRoot, path, Math.min(LIMITS.file, LIMITS.retained - sourceBytes))
    sourceBytes += bytes.length
    assert.equal(digest(bytes), hash, `Frozen source changed: ${path}`)
  }
  assert.match(build.source.sourceFiles['scripts/generated-package-closure.mjs'] ?? '', HEX, 'Fresh source-bound generated closure gate is required')
  const parser = build.generatedModuleParser
  assert.equal(parser?.status, 'passed'); assert.equal(parser?.retainedStatus, 'passed')
  assert.equal(parser.name, 'acorn'); assert.equal(parser.version, '8.15.0'); assert.equal(parser.license, 'MIT')
  assert.equal(parser.npmIntegrity, 'sha512-NZyJarBfL7nWwIq+FDL6Zp/yHEhePMNnnJ0y3qfieCrmNvYct8uvtiV41UvlSe6apAfk0fY1FbWx+NwfmpvtTg==')
  assert.equal(parser.archiveVerifiedAtBuild, false, 'Package-file verification must not claim archive verification')
  assert.deepEqual(parser.files, PARSER_FILES)
  assert.equal(parser.evidenceDirectory, resolve(root, 'validation/generated-module-parser'))
  let parserModuleBytes
  for (const file of PARSER_FILES) {
    const bytes = await regularBytes(root, `validation/generated-module-parser/${file.path}`, 256 * 1024)
    assert.equal(bytes.length, file.size); assert.equal(digest(bytes), file.sha256, `Retained parser changed: ${file.path}`)
    if (file.path === 'dist/acorn.mjs') parserModuleBytes = bytes
  }
  if (!parseModule) {
    const module = await import(`data:text/javascript;base64,${parserModuleBytes.toString('base64')}`)
    assert.equal(module.version, '8.15.0'); assert.equal(typeof module.parse, 'function'); parseModule = module.parse
  }
  let total = 0
  const retain = async (path, descriptor, purpose) => {
    assert.ok(!files.has(path), `Duplicate static inventory path: ${path}`)
    assert.ok(HEX.test(descriptor?.sha256) && Number.isSafeInteger(descriptor?.size) && descriptor.size >= 0, `Invalid descriptor: ${path}`)
    assert.ok(descriptor.size <= LIMITS.retained - total, 'Static retained bytes exceed the remaining run budget')
    const bytes = await regularBytes(root, path, Math.min(LIMITS.file, LIMITS.retained - total))
    assert.equal(bytes.length, descriptor.size, `Retained size mismatch: ${path}`)
    assert.equal(digest(bytes), descriptor.sha256, `Retained hash mismatch: ${path}`)
    total += bytes.length; assert.ok(total <= LIMITS.retained, 'Static retained bytes exceed the run budget')
    files.set(path, bytes); inventory[path] = { sha256: descriptor.sha256, size: bytes.length, purpose }
    return bytes
  }
  const assets = build.browserAssets
  assert.equal(assets?.status, 'passed'); assert.equal(assets?.retainedStatus, 'passed')
  assert.equal(assets.execution, 'worker'); assert.equal(assets.entry, 'index.html'); assert.equal(assets.entryModule, 'worker-app.mjs')
  assert.deepEqual(assets.files.map(file => file.path), FILES)
  for (const file of assets.files) {
    assert.equal(file.sourcePath, `examples/hosts/web-wasm/${file.path}`)
    assert.equal(file.sha256, build.source.sourceFiles[file.sourcePath])
    await retain(file.path, file, 'frozen-browser-source')
  }
  const stagedAssets = JSON.parse(await regularBytes(root, assets.inventory.path))
  assert.deepEqual(stagedAssets.files, assets.files); assert.deepEqual(stagedAssets.generatedFiles, assets.generatedFiles)
  await retain(assets.inventory.path, assets.inventory, 'browser-inventory')
  const indexDescriptor = build.packIndex
  assert.equal(indexDescriptor?.path, 'pack-index.json'); assert.equal(indexDescriptor.sha256, expectedIndexSha256)
  assert.ok(indexDescriptor.size <= LIMITS.index)
  const indexBytes = await retain('pack-index.json', indexDescriptor, 'independently-pinned-original-index')
  const index = JSON.parse(indexBytes)
  assert.deepEqual(index, build.pack); assert.equal(index.schemaVersion, 1)
  assert.equal(index.manifest, 'portable-pack/manifest.json')
  // The current builder omits manifestSize. Its index still pins exact SHA-256;
  // bound the regular input independently and retain that actual byte length.
  const manifestSize = (await regularBytes(root, index.manifest, LIMITS.index)).length
  if (index.manifestSize !== undefined) assert.equal(index.manifestSize, manifestSize)
  const manifestBytes = await retain(index.manifest, { sha256: index.manifestSha256, size: manifestSize }, 'original-portable-manifest')
  const manifest = JSON.parse(manifestBytes)
  assert.equal(manifest.schemaVersion, 3, 'Renderer profiles require manifest schema 3')
  assert.equal(manifest.integrity?.algorithm, 'sha256'); assert.equal(manifest.integrity.root, index.integrityRoot)
  assert.equal(digest(canonical({ ...manifest, integrity: { ...manifest.integrity, root: '' } })), index.integrityRoot)
  assert.equal(manifest.rendering?.version, '1.0')
  assert.equal(manifest.routes.length, 1); assert.equal(manifest.routes[0].path, FIXTURE.route)
  assert.equal(manifest.rendering.pages[FIXTURE.route] ?? manifest.rendering.default, profile)
  const blobs = new Map()
  for (const blob of index.blobs) {
    assert.ok(HEX.test(blob.sha256) && !blobs.has(blob.sha256), 'Invalid or duplicate content-addressed blob')
    const path = blob.url.replace(/^\.\//, '')
    blobs.set(blob.sha256, await retain(path, blob, 'original-content-addressed-blob'))
  }
  for (const module of manifest.modules) assert.ok(blobs.has(module.sha256), `Missing module blob: ${module.id}`)
  // app.entryModule is an emitted path; module inventory ids use the module:
  // namespace. Resolve the same key used by the real AppService loader.
  const entryId = `module:${manifest.app.entryModule.replace(/^module:/, '')}`
  const entry = manifest.modules.find(module => module.id === entryId)
  assert.ok(entry && entry.format === 'commonjs', 'Fixture requires its real CommonJS App module')
  assert.ok(blobs.get(entry.sha256).includes(Buffer.from('productSmokeState')), 'The dedicated product smoke App export is absent')
  const generated = build.generatedPackage
  assert.equal(generated?.status, 'passed'); assert.equal(generated?.retainedStatus, 'passed')
  const actualPackagePaths = []
  const visit = async path => {
    const directory = localPath(root, path)
    assert.ok((await lstat(directory)).isDirectory() && await realpath(directory) === directory, `Nonregular pkg directory: ${path}`)
    for (const item of await readdir(directory, { withFileTypes: true })) {
      assert.ok(item.isDirectory() || item.isFile(), `Nonregular pkg member: ${path}/${item.name}`)
      if (item.isDirectory()) await visit(`${path}/${item.name}`)
      else actualPackagePaths.push(`${path}/${item.name}`)
    }
  }
  await visit('pkg')
  assert.deepEqual(actualPackagePaths.sort(), generated.files.map(file => file.path).sort(), 'Generated pkg closure differs from its inventory')
  for (const file of generated.files) { assert.ok(file.path.startsWith('pkg/')); await retain(file.path, file, 'passed-generated-pkg') }
  const generatedClosure = build.generatedModuleClosure
  assert.equal(generatedClosure?.schemaVersion, 1); assert.equal(generatedClosure?.status, 'passed')
  assert.equal(generatedClosure.entry, 'pkg/container_host_web.js')
  assert.deepEqual(generatedClosure.parser, { name: 'acorn', version: '8.15.0', sha256: PARSER_FILES[1].sha256 })
  const allGeneratedJs = generated.files.filter(file => /\.(?:m?js)$/.test(file.path))
  assert.deepEqual(generatedClosure.modules.map(module => module.path).sort(), allGeneratedJs.map(file => file.path).sort())
  for (const module of generatedClosure.modules) {
    const descriptor = generated.files.find(file => file.path === module.path)
    assert.equal(module.sha256, descriptor.sha256); assert.equal(module.size, descriptor.size)
    const graph = inspectImportGraph(files, module.path, parseModule)
    const ordered = value => [...value].sort((a, b) => canonical(a).localeCompare(canonical(b)))
    assert.deepEqual(ordered(module.references), ordered(graph.references[module.path]), `Generated closure references differ from retained syntax: ${module.path}`)
  }
  assert.equal(generatedClosure.totalJavaScriptBytes, allGeneratedJs.reduce((total, file) => total + file.size, 0))
  for (const kind of ['glue', 'wasm']) {
    const artifact = build.artifacts?.[kind]
    assert.equal(inventory[artifact?.path]?.sha256, artifact?.sha256, `Unbound generated ${kind}`)
  }
  assert.equal(build.artifacts.glue.path, 'pkg/container_host_web.js'); assert.equal(build.artifacts.wasm.path, 'pkg/container_host_web_bg.wasm')
  const dependencies = build.rendererDependencies
  assert.equal(dependencies?.status, 'passed'); assert.equal(dependencies?.retainedStatus, 'passed')
  const runtime = dependencies.runtimeConfig
  assert.ok(runtime?.bytes > 0)
  const runtimeBytes = await retain(runtime.path, { sha256: runtime.sha256, size: runtime.bytes }, 'renderer-runtime-config')
  assert.deepEqual(JSON.parse(runtimeBytes), runtime.value); assert.equal(runtime.value.fallback, 'error')
  const pinsPath = 'examples/hosts/web-wasm/renderer-dependency-pins.json'
  const pinsBytes = await regularBytes(sourceRoot, pinsPath)
  assert.equal(digest(pinsBytes), build.source.sourceFiles[pinsPath])
  const pins = JSON.parse(pinsBytes)
  if (profile === 'skia') {
    assert.equal(runtime.value.renderer, 'canvaskit')
    assert.deepEqual(dependencies.files.map(file => file.id).sort(), ['font', 'fontLicense', 'javascript', 'license', 'package', 'wasm'])
    for (const file of dependencies.files) {
      assert.equal(file.verified, true); assert.equal(file.sha256, pins[file.id]?.sha256); assert.equal(file.size, pins[file.id]?.size)
      assert.equal(file.url, pins[file.id]?.url)
      await retain(file.url, file, 'committed-six-pinned-drawing-assets')
    }
    const configDescriptors = { javascript: runtime.value.canvaskit?.javascript, wasm: runtime.value.canvaskit?.wasm,
      license: runtime.value.canvaskit?.license, package: runtime.value.canvaskit?.package,
      font: runtime.value.font?.binary, fontLicense: runtime.value.font?.license }
    for (const [id, descriptor] of Object.entries(configDescriptors)) assert.deepEqual(descriptor,
      { url: pins[id].url, sha256: pins[id].sha256, size: pins[id].size }, `Unpinned drawing descriptor: ${id}`)
  } else {
    assert.equal(runtime.value.renderer, 'software'); assert.deepEqual(dependencies.files, [])
    // This packaging label does not enable a software presenter: manifest=webview.
  }
  const config = build.workerProductConfig
  const startup = config.startupJson
  assert.equal(startup?.path, 'worker-product-config.json')
  assert.ok(Number.isSafeInteger(startup.size) && startup.size > 0 && startup.size <= 64 * 1024)
  assert.deepEqual(assets.generatedFiles, [{ path: config.path, sha256: config.sha256, size: config.size,
    provenance: config.provenance }, startup])
  assert.equal(config.path, 'worker-product-config.mjs')
  assert.deepEqual(config.value, { schemaVersion: 1, execution: 'worker', engine: 'quickjs',
    index: { url: './pack-index.json', sha256: expectedIndexSha256, size: indexBytes.length }, rendererPolicy: { mode: 'manifest' },
    viewport: { width: 375, height: 667 }, rendererAssets: profile === 'skia' ? runtime.value : null })
  assert.deepEqual(await retain(config.path, config, 'generated-exact-product-config'), productConfigBytes(config.value), 'Generated config contains unexpected code')
  const startupBytes = await retain(startup.path, startup, 'generated-exact-startup-json')
  assert.deepEqual(startupBytes, Buffer.from(JSON.stringify(config.value, null, 2) + '\n'), 'Generated startup JSON differs from the product configuration')
  const html = files.get('index.html').toString('utf8'), scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  assert.equal(scripts.length, 1); assert.match(scripts[0][1], /\btype=["']module["']/); assert.match(scripts[0][1], /\bsrc=["']\.\/worker-app\.mjs["']/)
  assert.equal(scripts[0][2].trim(), ''); assert.match(html, /data-worker-product-entry/)
  const mainGraph = inspectImportGraph(files, 'worker-app.mjs', parseModule)
  const workerGraph = inspectImportGraph(files, 'runtime-worker.mjs', parseModule)
  assert.deepEqual(generatedClosure.reachable, inspectImportGraph(files, 'pkg/container_host_web.js', parseModule).files)
  assert.ok(!mainGraph.files.some(path => path === 'app.mjs' || path === 'runtime-worker.mjs' || path.startsWith('pkg/')), 'Application host is reachable from the Window graph')
  assert.ok(workerGraph.files.includes('pkg/container_host_web.js'), 'The real Worker graph must load the application glue')
  assert.ok(!workerGraph.files.includes('app.mjs'), 'Legacy application glue entered the Worker product graph')
  const runtimeEntry = files.get('runtime-worker.mjs').toString('utf8')
  assert.ok(runtimeEntry.indexOf('DedicatedWorkerGlobalScope') >= 0
    && runtimeEntry.indexOf('DedicatedWorkerGlobalScope') < runtimeEntry.indexOf("import('./pkg/container_host_web.js')"), 'Application WASM must remain behind the Dedicated Worker guard')
  const allowed = new Set([...mainGraph.files, ...workerGraph.files, ...mainGraph.resources, ...workerGraph.resources, 'index.html', 'pack-index.json', index.manifest, runtime.path,
    ...index.blobs.map(blob => blob.url.replace(/^\.\//, '')), ...dependencies.files.map(file => file.url)])
  allowed.delete('app.mjs'); allowed.delete('legacy.html')
  return { files, allowed, inventory, manifest, config: config.value, moduleId: entry.id, profile,
    provenance: { buildReportSha256: digest(reportBytes), source: build.source, indexSha256: expectedIndexSha256,
      indexSize: indexBytes.length, manifestSha256: index.manifestSha256, integrityRoot: index.integrityRoot,
      graphs: { main: mainGraph, worker: workerGraph }, generatedModuleClosure: generatedClosure,
      generatedModuleParser: parser, rendererDependencies: dependencies, totalRetainedBytes: total } }
}

export function classifyRequest(urlText, { origin, allowed, profile, method = 'GET' }) {
  let url
  try { url = new URL(urlText) } catch { return { allowed: false, reason: 'invalid-url' } }
  if (url.protocol === 'blob:') {
    try { return { allowed: profile === 'skia' && new URL(url.pathname).origin === origin && method === 'GET', reason: 'source-bound-verified-drawing-Blob' } }
    catch { return { allowed: false, reason: 'invalid-Blob-origin' } }
  }
  if (url.origin !== origin) return { allowed: false, reason: 'off-origin' }
  let path
  try { path = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html' } catch { return { allowed: false, reason: 'invalid-encoding' } }
  if (path === 'api' || path.startsWith('api/')) return { allowed: false, reason: 'http-business-api' }
  if (path === 'app.mjs' || path === 'legacy.html') return { allowed: false, reason: 'legacy-entry' }
  if (path === 'favicon.ico' && method === 'GET' && !url.search && !url.hash) return { allowed: true, path, reason: 'browser-generated-favicon-no-content' }
  if (method !== 'GET' || url.search || url.hash || !allowed.has(path)) return { allowed: false, reason: 'outside-static-inventory', path }
  return { allowed: true, path, reason: 'verified-static-file' }
}

/** This audit executes before page modules. It permits drawing WASM while
 * refusing every application-host export, including wasm-bindgen suffixes. */
export function installWindowWasmAudit(target = globalThis) {
  if (!target.document || target.top !== target) return
  const audit = { installed: false, calls: [], violations: [] }
  Object.defineProperty(target, '__workerProductWasmAudit', { value: audit, configurable: false, writable: false })
  const wasm = target.WebAssembly, keys = Object.keys, construct = Reflect.construct
  const inspect = (instance, via) => {
    const exports = keys(instance.exports), application = exports.filter(name => /^webwasmhost_/i.test(name))
    audit.calls.push({ via, exportCount: exports.length, applicationHostExports: application })
    if (application.length) {
      audit.violations.push({ via, exports: application })
      throw Object.assign(new Error('Application WASM host attempted to instantiate on Window'), { code: 'ERR_ENGINE' })
    }
    return instance
  }
  const originalInstance = wasm.Instance
  const guardedInstance = new Proxy(originalInstance, { construct(original, args, next) {
    return inspect(construct(original, args, next === guardedInstance ? original : next), 'Instance')
  } })
  wasm.Instance = guardedInstance
  for (const name of ['instantiate', 'instantiateStreaming']) {
    const original = wasm[name]
    if (typeof original !== 'function') continue
    wasm[name] = function (...args) {
      return Reflect.apply(original, wasm, args).then(result => { inspect(result.instance ?? result, name); return result })
    }
  }
  audit.installed = true
}

/** Decode only the trusted Chromium screenshot profile; this is not an image
 * parser for arbitrary application assets. Retain exact PNG and raw RGBA hashes. */
export function screenshotPixels(png) {
  assert.ok(Buffer.isBuffer(png) && png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
  let offset = 8, header, ended = false
  const chunks = []
  while (offset + 12 <= png.length) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8)
    assert.ok(size <= 64 * 1024 * 1024 && offset + 12 + size <= png.length)
    const bytes = png.subarray(offset + 8, offset + 8 + size)
    if (type === 'IHDR') { assert.equal(header, undefined); header = Buffer.from(bytes) }
    if (type === 'IDAT') chunks.push(bytes)
    if (type === 'IEND') { ended = true; break }
    offset += 12 + size
  }
  assert.ok(ended && header?.length === 13 && chunks.length)
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), channels = header[9] === 6 ? 4 : header[9] === 2 ? 3 : 0
  assert.ok(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 4 * 1024 * 1024)
  assert.equal(header[8], 8); assert.ok(channels); assert.equal(header[10], 0); assert.equal(header[11], 0); assert.equal(header[12], 0)
  const stride = width * channels, raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height })
  assert.equal(raw.length, (stride + 1) * height)
  const decoded = Buffer.alloc(stride * height), rgba = Buffer.alloc(width * height * 4)
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4)
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, left = x >= channels ? decoded[at - channels] : 0, up = y ? decoded[at - stride] : 0
      const diagonal = y && x >= channels ? decoded[at - stride - channels] : 0
      const prediction = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, diagonal)][filter]
      decoded[at] = (raw[y * (stride + 1) + 1 + x] + prediction) & 255
    }
  }
  for (let i = 0; i < width * height; i++) { rgba[i * 4] = decoded[i * channels]; rgba[i * 4 + 1] = decoded[i * channels + 1]; rgba[i * 4 + 2] = decoded[i * channels + 2]; rgba[i * 4 + 3] = channels === 4 ? decoded[i * channels + 3] : 255 }
  return { width, height, rgba, sha256: digest(rgba) }
}

function assertAccepted(status, stage) {
  const accepted = status.presentation?.accepted, proof = accepted?.proof, observation = status.observation?.state
  assert.equal(status.phase, 'ready', stage); assert.equal(status.runtimeReady, true); assert.equal(status.inputEnabled, true)
  assert.equal(accepted?.inputEnabled, true); assert.equal(proof?.version, '1.0'); assert.deepEqual(proof.owner, status.owner)
  assert.equal(proof.consumedInput?.pageId, observation?.currentPage?.pageId)
  assert.equal(proof.consumedInput?.routePath, FIXTURE.route)
  assert.equal(proof.consumedInput?.templateRevision, observation.templateRevision)
  assert.deepEqual(proof.consumedInput.viewport, observation.viewport)
  assert.equal(proof.surfaceGeneration, observation.surfaceGeneration)
  assert.equal(proof.publication.kind, status.owner.transportBackend)
  return accepted
}

/** A hung page Promise must not prevent finally from reclaiming this exact
 * page/context/Worker. Do not race browser.launch, whose returned handle is owned. */
export async function withPageDeadline(page, action, { timeoutMs = 30_000, label = 'browser operation' } = {}) {
  let timer
  const pending = Promise.resolve().then(action)
  void pending.catch(() => {})
  try {
    return await Promise.race([pending, new Promise((_done, reject) => {
      timer = setTimeout(() => {
        const cleanup = { resource: 'this-run-owned-page', status: 'pending' }
        const error = Object.assign(new Error(`ERR_TIMEOUT: ${label} did not settle within ${timeoutMs} ms`), { timeoutCleanup: cleanup })
        // Page teardown is the scoped cancellation mechanism for pending JS.
        // Retain failures on the thrown error; callers include them in cleanup
        // evidence and still attempt their exact context/browser cleanup.
        void Promise.resolve().then(() => page.close({ runBeforeUnload: false })).then(() => {
          cleanup.status = 'closed'
        }, failure => { cleanup.status = 'failed'; cleanup.error = failure.stack || String(failure) })
        reject(error)
      }, timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

export async function runProductBrowserSmoke(options, { chromium, parseModule, signal = options.signal } = {}) {
  // Revalidate public options even for programmatic calls; no implicit index pins.
  options = parseArgs(['--dom-site-dir', options.domSiteDir, '--dom-index-sha256', options.domIndexSha256,
    '--canvas-site-dir', options.canvasSiteDir, '--canvas-index-sha256', options.canvasIndexSha256, '--out-dir', options.outDir])
  const out = options.outDir
  await mkdir(out, { recursive: false })
  const report = { schemaVersion: 1, status: 'running', scope: 'actual-default-Worker-static-product-two-renderer-smoke',
    headless: true, startedAt: new Date().toISOString(), scenarios: [], requests: [], forbiddenRequests: [], cleanup: {},
    acceptance: { applicationExecution: 'not-run', defaultEntry: 'not-run', presentation: 'not-run', gpu: 'unknown', physicalDevice: 'not-run', performance: 'not-run' },
    limitations: ['Dedicated fixtures, QuickJS and one installed Chromium only; no DevTools parity or other-host result.',
      'Accepted presenter proof and visible screenshot establish this browser transaction; not hardware GPU completion, performance or physical GPU attribution.',
      'Window WASM audit covers standard instantiate/instantiateStreaming/Instance entries and is paired with source graph and actual Worker evidence.'] }
  const save = (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2) + '\n')
  let browser, context, page, server, cancellationPageClose, cleanupFailed = false, active = null, origin = null
  const pageErrors = [], consoleMessages = []
  const cleanup = async (name, action) => {
    try { report.cleanup[name] = await action() } catch (error) {
      cleanupFailed = true; report.cleanup[name + 'Error'] = error.stack || String(error)
      if (error.timeoutCleanup) { report.cleanup.timeoutPageAttempts ??= []; report.cleanup.timeoutPageAttempts.push(error.timeoutCleanup) }
    }
  }
  const onAbort = () => {
    report.cancellation ??= { reason: String(signal.reason?.message ?? signal.reason ?? 'aborted'), receivedAt: new Date().toISOString() }
    if (page && !page.isClosed() && !cancellationPageClose) cancellationPageClose = Promise.resolve().then(() => page.close({ runBeforeUnload: false }))
      .then(() => { report.cleanup.cancellationPageClosed = page.isClosed(); assert.ok(page.isClosed()) })
      .catch(error => { cleanupFailed = true; report.cleanup.cancellationPageCloseError = error.stack || String(error) })
  }
  const checkCancelled = () => { if (signal?.aborted) { onAbort(); fail(`ERR_CANCELLED: ${report.cancellation.reason}`) } }
  signal?.addEventListener('abort', onAbort)
  try {
    checkCancelled()
    const dom = await inspectProductSite(options.domSiteDir, { expectedIndexSha256: options.domIndexSha256, profile: 'webview', parseModule })
    checkCancelled()
    const canvas = await inspectProductSite(options.canvasSiteDir, { expectedIndexSha256: options.canvasIndexSha256, profile: 'skia', parseModule })
    assert.equal(dom.provenance.source.sourceCommit, canvas.provenance.source.sourceCommit, 'Both product sites must share one clean source commit')
    assert.equal(dom.provenance.source.sourceSha256, canvas.provenance.source.sourceSha256, 'Both products must use the same frozen host implementation')
    for (const [name, site] of [['dom', dom], ['canvaskit', canvas]]) {
      await save(`${name}-site-provenance.json`, site.provenance); await save(`${name}-site-inventory.json`, site.inventory)
    }
    if (!chromium) {
      const modulePath = process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE || resolve(ROOT, 'vendor/weapp-vite/node_modules/playwright/index.mjs')
      try { ({ chromium } = await import(pathToFileURL(resolve(modulePath)).href)) }
      catch (error) { fail(`ERR_TEST_INFRASTRUCTURE: installed Playwright unavailable: ${error.message}`) }
    }
    checkCancelled()
    server = createServer((request, response) => {
      const decision = classifyRequest(new URL(request.url, origin).href, { origin, allowed: active?.site.allowed ?? new Set(), profile: active?.site.profile, method: request.method })
      const fact = { scenario: active?.name, method: request.method, url: request.url, ...decision }
      report.requests.push(fact)
      if (!decision.allowed || !decision.path) { report.forbiddenRequests.push({ ...fact, layer: 'server' }); response.writeHead(403).end(); return }
      if (decision.path === 'favicon.ico') { response.writeHead(204, { 'Cache-Control': 'no-store' }).end(); return }
      const bytes = active.site.files.get(decision.path)
      const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.ttf': 'font/ttf' }[extname(decision.path)] || 'application/octet-stream'
      response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Length': bytes.length }).end(bytes)
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    origin = `http://127.0.0.1:${server.address().port}`
    report.url = origin + '/'
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    checkCancelled(); report.browserVersion = browser.version()
    context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' })
    checkCancelled()
    await context.addInitScript(installWindowWasmAudit)
    await context.route('**/*', async route => {
      const request = route.request(), decision = classifyRequest(request.url(), { origin, allowed: active?.site.allowed ?? new Set(), profile: active?.site.profile, method: request.method() })
      if (!decision.allowed) { report.forbiddenRequests.push({ scenario: active?.name, url: request.url(), method: request.method(), layer: 'browser', ...decision }); await route.abort('blockedbyclient'); return }
      await route.continue()
    })
    assert.equal(typeof context.routeWebSocket, 'function', 'ERR_TEST_INFRASTRUCTURE: this browser gate requires scoped WebSocket interception')
    await context.routeWebSocket('**/*', async socket => {
      report.forbiddenRequests.push({ scenario: active?.name, url: socket.url(), layer: 'websocket', reason: 'static-product-prohibits-sockets' })
      await socket.close({ code: 1008, reason: 'Static product permits no business sockets' })
    })
    page = await context.newPage(); page.setDefaultTimeout(30_000)
    const evaluate = (fn, arg) => withPageDeadline(page, () => page.evaluate(fn, arg), { label: 'page evaluation' })
    page.on('pageerror', error => pageErrors.push({ scenario: active?.name, error: error.stack || String(error) }))
    page.on('console', message => { consoleMessages.push({ scenario: active?.name, type: message.type(), text: message.text() }); if (consoleMessages.length > 100) consoleMessages.shift() })
    page.on('worker', worker => {
      const scenario = active
      if (!scenario) { report.forbiddenRequests.push({ reason: 'unowned-worker', url: worker.url() }); return }
      const fact = { url: worker.url(), createdAt: new Date().toISOString(), closed: false }
      scenario.workers.push(fact); scenario.workerHandles.push(worker)
      worker.on('close', () => { fact.closed = true; fact.closedAt = new Date().toISOString() })
    })
    for (const [name, site] of [['dom', dom], ['canvaskit', canvas]]) {
      checkCancelled()
      const scenario = { name, site, workerHandles: [], workers: [] }, facts = { name, profile: site.profile, status: 'running', workers: scenario.workers, checks: {} }
      scenario.facts = facts; active = scenario; report.scenarios.push(facts)
      await page.goto(origin + '/', { waitUntil: 'load', timeout: 30_000 })
      await page.waitForFunction(() => window.weappReady && window.weappPresented)
      const ready = await evaluate(() => window.weappReady)
      const first = await evaluate(() => window.weappPresented)
      const status = await evaluate(() => window.weapp.status)
      assert.equal(ready.runtimeReady, true); assert.equal(ready.loadResult.capabilities.quickjs, true)
      assert.deepEqual(ready.owner, status.owner); assert.deepEqual(first.owner, status.owner)
      assert.equal(status.owner.packSha256, site.provenance.indexSha256)
      assert.equal(status.owner.transportBackend, name === 'dom' ? 'browser-view' : 'external-frame')
      assertAccepted(status, 'initial accepted input-enabled presentation')
      assert.equal(scenario.workerHandles.length, 1, 'The default bootstrap must own exactly one real Worker')
      assert.equal(scenario.workers[0].url, origin + '/runtime-worker.mjs')
      facts.checks.workerRealm = await withPageDeadline(page, () => scenario.workerHandles[0].evaluate(() => ({ constructor: self.constructor.name,
        dedicated: typeof DedicatedWorkerGlobalScope === 'function' && self instanceof DedicatedWorkerGlobalScope,
        hasDocument: typeof document !== 'undefined', name: self.name })), { label: 'actual Worker realm observation' })
      assert.equal(facts.checks.workerRealm.dedicated, true); assert.equal(facts.checks.workerRealm.hasDocument, false)
      assert.equal(facts.checks.workerRealm.name, `container-${status.owner.workerEpoch}`)
      const trace = await evaluate(() => window.weappTrace)
      const messages = trace.filter(item => item.kind === 'batch').flatMap(item => item.value.messages ?? [])
      let position = -1
      for (const op of ['app.init', 'app.lifecycle', 'page.push']) {
        const next = messages.findIndex((message, index) => index > position && message.op === op && message.kind === 'response' && message.payload?.ok === true)
        assert.ok(next > position, `Missing ordered real startup ${op}`); position = next
      }
      assert.equal(messages.find(message => message.op === 'app.init' && message.kind === 'response').payload.engineProviderAvailable, true)
      if (name === 'canvaskit') assert.ok(messages.some(message => message.op === 'render.commit' && message.kind === 'response' && message.payload?.ok === true))
      const readState = () => evaluate(async moduleId => {
        const value = await window.weapp.request('module.call', { moduleId, export: 'productSmokeState', args: [] })
        if (value?.ok !== true || value.result?.length !== 1) throw new Error('Real AppService module.call failed')
        return value.result[0]
      }, site.moduleId)
      const before = await readState()
      assert.equal(before.fixture, FIXTURE.id); assert.equal(before.count, 0); assert.equal(before.launches, 1)
      facts.checks.startup = { ready, first, status, appState: before }
      await save(`${name}-trace-before.json`, trace)
      const surface = name === 'dom' ? page.locator('iframe[title="Weapp Container DOM surface"]') : page.locator('#surface-root [data-worker-web-session] canvas')
      assert.equal(await surface.count(), 1); await surface.waitFor({ state: 'visible' })
      const beforePng = await surface.screenshot({ path: resolve(out, `${name}-surface-before.png`) })
      const beforePixels = screenshotPixels(beforePng)
      if (name === 'dom') {
        const frame = page.frameLocator('iframe[title="Weapp Container DOM surface"]')
        assert.equal(await frame.locator('#count').textContent(), 'Count: 0')
        const box = await frame.locator('#increment').boundingBox()
        assert.ok(box?.width > 0 && box.height > 0, 'Actual DOM control has no layout')
        facts.checks.domLayout = { button: box, text: await frame.locator('#count').textContent() }
        await frame.locator('#increment').click()
      } else {
        facts.checks.webgl = await surface.evaluate(canvas => {
          const gl = canvas.getContext('webgl2')
          if (!gl || gl.isContextLost()) throw new Error('Actual CanvasKit surface has no live WebGL2 context')
          const extension = gl.getExtension('WEBGL_debug_renderer_info')
          return { webgl2: true, width: canvas.width, height: canvas.height, vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
            unmaskedVendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null,
            unmaskedRenderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null,
            physicalHardware: 'unknown', gpuCompletion: 'unknown' }
        })
        const sample = (pixels, point) => {
          const x = Math.floor(point.x * pixels.width / 375), y = Math.floor(point.y * pixels.height / 667)
          return Array.from(pixels.rgba.subarray((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 4))
        }
        assert.deepEqual(sample(beforePixels, FIXTURE.feedback), FIXTURE.before, 'Actual visible CanvasKit feedback pixels are incorrect')
        const box = await surface.boundingBox(); assert.ok(box?.width > 0 && box.height > 0)
        const x = box.x + FIXTURE.button.x * box.width / 375, y = box.y + FIXTURE.button.y * box.height / 667
        facts.checks.pointer = { logical: FIXTURE.button, browser: { x, y }, box }
        await page.mouse.click(x, y)
      }
      await page.waitForFunction(async moduleId => {
        const value = await window.weapp.request('module.call', { moduleId, export: 'productSmokeState', args: [] })
        return value.result?.[0]?.count === 1
      }, site.moduleId, { polling: 50, timeout: 10_000 })
      await page.waitForFunction(previous => {
        const state = window.weapp.status, accepted = state.presentation?.accepted
        return state.inputEnabled && accepted?.inputEnabled && accepted.proof.attemptId !== previous
          && accepted.proof.consumedInput?.templateRevision === state.observation?.state.templateRevision
      }, status.presentation.accepted.proof.attemptId)
      const after = await readState(), afterStatus = await evaluate(() => window.weapp.status)
      assert.equal(after.count, 1); assert.equal(after.taps, 1); assert.equal(after.launches, 1)
      assertAccepted(afterStatus, 'real pointer-driven updated presentation')
      assert.ok(BigInt(afterStatus.observation.state.templateRevision) > BigInt(status.observation.state.templateRevision))
      const afterPng = await surface.screenshot({ path: resolve(out, `${name}-surface-after.png`) }), afterPixels = screenshotPixels(afterPng)
      assert.notEqual(afterPixels.sha256, beforePixels.sha256, 'Actual surface pixels did not change after input')
      if (name === 'dom') assert.equal(await page.frameLocator('iframe[title="Weapp Container DOM surface"]').locator('#count').textContent(), 'Count: 1')
      else {
        const x = Math.floor(FIXTURE.feedback.x * afterPixels.width / 375), y = Math.floor(FIXTURE.feedback.y * afterPixels.height / 667)
        assert.deepEqual(Array.from(afterPixels.rgba.subarray((y * afterPixels.width + x) * 4, (y * afterPixels.width + x) * 4 + 4)), FIXTURE.after)
      }
      facts.checks.inputAndPixels = { before: beforePixels.sha256, after: afterPixels.sha256, appState: after, status: afterStatus }
      await evaluate(async () => { await window.weapp.setLogicalViewport({ width: 400, height: 700 }) })
      await page.waitForFunction(() => {
        const status = window.weapp.status, consumed = status.presentation?.accepted?.proof.consumedInput
        return status.inputEnabled && consumed?.viewport.width === 400 && consumed.viewport.height === 700
      })
      const resized = await evaluate(() => window.weapp.status); assertAccepted(resized, 'logical resize')
      facts.checks.resize = resized
      if (name === 'dom') {
        const rejected = await evaluate(async () => { try { await window.weapp.setRenderScale(2); return { accepted: true } } catch (error) { return { code: error.code, message: error.message } } })
        assert.equal(rejected.code, 'ERR_UNSUPPORTED_CAPABILITY'); facts.checks.density = rejected
      } else {
        const logicalBox = await surface.boundingBox()
        assert.equal(logicalBox.width, 400); assert.equal(logicalBox.height, 700)
        await evaluate(async () => { await window.weapp.setRenderScale(2) })
        await page.waitForFunction(attempt => {
          const status = window.weapp.status, accepted = status.presentation?.accepted, canvas = document.querySelector('#surface-root canvas')
          return status.inputEnabled && accepted?.proof.attemptId !== attempt && canvas?.width === 800 && canvas.height === 1400
        }, resized.presentation.accepted.proof.attemptId)
        const scaled = await evaluate(() => window.weapp.status); assertAccepted(scaled, 'density repaint')
        assert.equal(scaled.observation.state.templateRevision, resized.observation.state.templateRevision, 'Density must not publish a new template revision')
        const scaledBox = await surface.boundingBox()
        assert.equal(scaledBox.width, logicalBox.width); assert.equal(scaledBox.height, logicalBox.height)
        await page.mouse.click(scaledBox.x + FIXTURE.button.x, scaledBox.y + FIXTURE.button.y)
        await page.waitForFunction(revision => {
          const status = window.weapp.status
          return status.inputEnabled && BigInt(status.presentation.accepted.proof.consumedInput.templateRevision) > BigInt(revision)
        }, scaled.presentation.accepted.proof.consumedInput.templateRevision)
        const afterDensityInput = await readState()
        assert.equal(afterDensityInput.count, 2); assert.equal(afterDensityInput.taps, 2)
        facts.checks.density = { status: scaled, logicalBox, scaledBox, afterDensityInput,
          templateRevisionPreserved: true, expressionReplayIndependentlyMeasured: false }
      }
      await evaluate(async () => { await window.weapp.setVisible(false) })
      const hidden = await evaluate(() => window.weapp.status)
      assert.equal(hidden.inputEnabled, false); assert.equal(hidden.visible, false); assert.equal(hidden.observation.state.lifecycle, 'Background')
      await evaluate(async () => { await window.weapp.setVisible(true) })
      await page.waitForFunction(() => window.weapp.status.inputEnabled && window.weapp.status.observation?.state.lifecycle === 'Active')
      const shown = await evaluate(() => window.weapp.status); assertAccepted(shown, 'hide/show reaccepted presentation')
      facts.checks.visibility = { hidden, shown }
      facts.checks.windowWasm = await evaluate(() => window.__workerProductWasmAudit)
      assert.equal(facts.checks.windowWasm.installed, true); assert.deepEqual(facts.checks.windowWasm.violations, [])
      if (name === 'canvaskit') assert.ok(facts.checks.windowWasm.calls.some(call => call.exportCount > 0), 'Drawing WASM initialization was not observed')
      assert.equal(await page.locator('#error').isVisible(), false)
      await save(`${name}-trace-after.json`, await evaluate(() => window.weappTrace))
      await page.screenshot({ path: resolve(out, `${name}-page.png`), fullPage: true })
      facts.checks.close = await evaluate(async () => {
        const first = window.weapp.close(), second = window.weapp.close(), stable = first === second
        const result = await first, entryFirst = window.weappClose(), entrySecond = window.weappClose()
        await entryFirst
        return { stable, entryStable: entryFirst === entrySecond, result, status: window.weapp.status,
          ownedMounts: document.querySelectorAll('#surface-root [data-worker-web-session]').length,
          ownedSurfaces: document.querySelectorAll('#surface-root canvas, #surface-root iframe').length }
      })
      assert.equal(facts.checks.close.stable, true); assert.equal(facts.checks.close.entryStable, true)
      assert.equal(facts.checks.close.result.closed, true); assert.equal(facts.checks.close.result.workerClosed, true); assert.equal(facts.checks.close.result.ownedMountRemoved, true)
      assert.equal(facts.checks.close.status.phase, 'closed'); assert.equal(facts.checks.close.status.inputEnabled, false)
      assert.equal(facts.checks.close.ownedMounts, 0); assert.equal(facts.checks.close.ownedSurfaces, 0)
      assert.equal(facts.checks.close.status.presentation?.inFlight ?? false, false); assert.equal(facts.checks.close.status.presentation?.hasRaf ?? false, false)
      // Registering close listeners at creation avoids missing termination.
      const deadline = Date.now() + 5_000
      while (scenario.workers.some(worker => !worker.closed) && Date.now() < deadline) { checkCancelled(); await new Promise(done => setTimeout(done, 20)) }
      assert.ok(scenario.workers.every(worker => worker.closed), 'Actual owned Worker close was not observed')
      assert.deepEqual(pageErrors.filter(item => item.scenario === name), [])
      facts.status = 'passed'
    }
    assert.deepEqual(report.forbiddenRequests, [], 'The product attempted forbidden API/off-origin/legacy resources')
    assert.deepEqual(pageErrors, [])
    checkCancelled()
    report.acceptance.applicationExecution = 'passed'; report.acceptance.defaultEntry = 'passed'; report.acceptance.presentation = 'passed'
    report.status = 'passed'
  } catch (error) {
    report.status = signal?.aborted ? 'cancelled' : /ERR_TEST_INFRASTRUCTURE/.test(error.message) ? 'blocked' : 'failed'
    report.error = error.stack || String(error)
    if (error.timeoutCleanup) { report.cleanup.timeoutPageAttempts ??= []; report.cleanup.timeoutPageAttempts.push(error.timeoutCleanup) }
    if (active?.facts.status === 'running') active.facts.status = report.status
    if (!signal?.aborted && page && !page.isClosed()) {
      try {
        report.failureState = await withPageDeadline(page, () => page.evaluate(() => ({ state: window.weapp?.status, error: document.querySelector('#error')?.textContent,
          trace: window.weappTrace, windowWasm: window.__workerProductWasmAudit })), { timeoutMs: 5_000, label: 'failure state capture' })
        await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true, timeout: 5_000 })
      } catch (failure) { report.failureCaptureError = failure.stack || String(failure) }
    }
  } finally {
    if (signal?.aborted) onAbort()
    if (cancellationPageClose) await cancellationPageClose
    if (page && !page.isClosed() && !signal?.aborted) await cleanup('runtime', async () => {
      // A finite owner close attempt; page teardown below still owns Worker cleanup.
      const result = await withPageDeadline(page, () => page.evaluate(async () => window.weappClose ? window.weappClose() : window.weapp?.close()),
        { timeoutMs: 10_000, label: 'owned runtime final cleanup' })
      return result ?? { runtimeAbsent: true }
    })
    if (page && !page.isClosed()) await cleanup('pageClosed', async () => { await page.close({ runBeforeUnload: false }); return page.isClosed() })
    if (context) await cleanup('contextClosed', async () => { await context.close(); return true })
    if (browser) await cleanup('browserClosed', async () => { await browser.close(); return !browser.isConnected() })
    if (server?.listening) await cleanup('serverClosed', async () => {
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); return !server.listening
    })
    signal?.removeEventListener('abort', onAbort)
    if (report.cleanup.timeoutPageAttempts?.some(attempt => attempt.status !== 'closed')) cleanupFailed = true
    if (cleanupFailed) report.status = 'failed'
    else if (signal?.aborted) report.status = 'cancelled'
    report.pageErrors = pageErrors; report.consoleMessages = consoleMessages; report.finishedAt = new Date().toISOString()
    await save('execution.json', report)
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), interrupt = name => () => {
    if (!controller.signal.aborted) controller.abort(Object.assign(new Error(`Received ${name}`), { signalName: name }))
  }
  const onInterrupt = interrupt('SIGINT'), onTerminate = interrupt('SIGTERM')
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate)
  try {
    const report = await runProductBrowserSmoke(parseArgs(process.argv.slice(2)), { signal: controller.signal })
    console.log(JSON.stringify({ status: report.status, acceptance: report.acceptance, error: report.error, cleanup: report.cleanup }))
    if (report.status !== 'passed') process.exitCode = report.status === 'cancelled' ? controller.signal.reason?.signalName === 'SIGTERM' ? 143 : 130 : 1
  } catch (error) { console.error(error.stack || String(error)); process.exitCode = 1 }
  finally { process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate) }
}
