import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { GENERATED_MODULE_PARSER_PIN, GENERATED_MODULE_LIMITS, generatedModuleReferences,
  loadPinnedGeneratedModuleParser, verifyGeneratedModuleClosure, verifyRetainedGeneratedModuleParser } from './generated-package-closure.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(files = {}) {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'generated-pkg-closure-')))
  const root = resolve(directory, 'source'), outDir = resolve(directory, 'output')
  try {
    for (const file of GENERATED_MODULE_PARSER_PIN.files) {
      const path = resolve(root, 'tools/container-manifest/node_modules/acorn', file.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, await readFile(resolve(ROOT, 'tools/container-manifest/node_modules/acorn', file.path)))
    }
    const inventory = { files: [] }
    for (const [path, source] of Object.entries({
      'pkg/container_host_web.js': "import { a } from './snippets/a.js'; export { a }; export const wasm = new URL('container_host_web_bg.wasm', import.meta.url);\n",
      'pkg/snippets/a.js': "export { b as a } from './b.mjs';\n",
      'pkg/snippets/b.mjs': 'export const b = 42;\n',
      'pkg/container_host_web_bg.wasm': Buffer.from('0061736d01000000', 'hex'),
      'pkg/container_host_web.d.ts': 'export declare class WebWasmHost {}\n',
      'pkg/container_host_web_bg.wasm.d.ts': 'export const memory: WebAssembly.Memory;\n',
      ...files,
    })) {
      const bytes = Buffer.from(source)
      await mkdir(dirname(resolve(outDir, path)), { recursive: true })
      await writeFile(resolve(outDir, path), bytes)
      inventory.files.push({ path, size: bytes.length, sha256: hash(bytes) })
    }
    return { root, outDir, directory, inventory,
      parser: () => loadPinnedGeneratedModuleParser({ root, destination: resolve(directory, 'parser-evidence') }),
      cleanup: () => rm(directory, { recursive: true, force: true }) }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
}

test('real pinned parser closes transitive imports, reexports and module-relative WASM without executing glue', async () => {
  const f = await fixture({ 'pkg/snippets/b.mjs': "throw new Error('must not execute'); export const b = 42;\n" })
  try {
    const parser = await f.parser()
    const result = await verifyGeneratedModuleClosure(f.outDir, f.inventory, parser)
    assert.equal(result.status, 'passed')
    assert.deepEqual(result.reachable, ['pkg/container_host_web.js', 'pkg/snippets/a.js', 'pkg/snippets/b.mjs'])
    assert.deepEqual(result.modules[0].references.map(item => item.path).sort(), ['pkg/container_host_web_bg.wasm', 'pkg/snippets/a.js'])
    assert.equal(result.parser.sha256, GENERATED_MODULE_PARSER_PIN.files[1].sha256)
    await verifyRetainedGeneratedModuleParser(parser.provenance)
    assert.equal(parser.provenance.retainedStatus, 'passed')
  } finally { await f.cleanup() }
})

for (const [name, source, expected] of [
  ['network', "import 'https://example.invalid/x.js';", /ordinary relative path/],
  ['bare', "import 'some-package';", /ordinary relative path/],
  ['Node builtin', "import 'node:fs';", /ordinary relative path/],
  ['escape', "export * from '../worker-app.mjs';", /escapes pkg/],
  ['encoded escape', "import './%2e%2e/x.mjs';", /ordinary relative path/],
  ['query alias', "import './snippets/a.js?v=1';", /ordinary relative path/],
  ['missing', "import('./not-retained.mjs');", /unretained file/],
  ['computed', 'export const load = name => import(name);', /must be static/],
  ['computed URL', 'export const url = name => new URL(name, import.meta.url);', /must be static/],
  ['escaping URL', "export const url = new URL('../secret.wasm', import.meta.url);", /escapes pkg/],
]) test(`generated dependency rejects ${name} before any interface evaluation`, async () => {
  const f = await fixture({ 'pkg/container_host_web.js': source })
  try { await assert.rejects(verifyGeneratedModuleClosure(f.outDir, f.inventory, await f.parser()), expected) }
  finally { await f.cleanup() }
})

test('syntax parsing handles static dynamic imports, comments, strings and legal cyclic modules', async () => {
  const f = await fixture({
    'pkg/snippets/a.js': "// import '../not-a-reference.js';\nexport { b as a } from './b.mjs'; export const text = \"import('network')\"; export const load = () => import(`./b.mjs`);\n",
    'pkg/snippets/b.mjs': "export * from './a.js'; export const b = 42;\n",
  })
  try {
    const parser = await f.parser(), result = await verifyGeneratedModuleClosure(f.outDir, f.inventory, parser)
    assert.equal(result.status, 'passed')
    assert.equal(result.reachable.length, 3)
    assert.deepEqual(generatedModuleReferences("const text = `import('no')`; // import './no.js';\n", 'pkg/test.mjs', parser.parse), [])
  } finally { await f.cleanup() }
})

test('unreachable generated JavaScript is parsed and cannot hide external imports', async () => {
  const f = await fixture({ 'pkg/unused.mjs': "export * from 'https://example.invalid/escape.mjs';\n" })
  try { await assert.rejects(verifyGeneratedModuleClosure(f.outDir, f.inventory, await f.parser()), /ordinary relative path/) }
  finally { await f.cleanup() }
})

test('declaration companions remain retained nonexecutables and cannot be imported as JavaScript', async () => {
  const f = await fixture({ 'pkg/container_host_web.js': "export * from './container_host_web.d.ts';\n" })
  try { await assert.rejects(verifyGeneratedModuleClosure(f.outDir, f.inventory, await f.parser()), /resolve to JavaScript/) }
  finally { await f.cleanup() }
})

test('runtime TypeScript is still rejected even when unreachable', async () => {
  const f = await fixture({ 'pkg/runtime.ts': 'export const value: number = 1;\n' })
  try { await assert.rejects(verifyGeneratedModuleClosure(f.outDir, f.inventory, await f.parser()), /unsupported script type/) }
  finally { await f.cleanup() }
})

test('changed generated bytes, script budgets and nonregular modules reject', async t => {
  for (const kind of ['changed', 'large', 'symlink']) await t.test(kind, async () => {
    const f = await fixture()
    try {
      const parser = await f.parser(), path = resolve(f.outDir, 'pkg/snippets/a.js')
      if (kind === 'changed') await writeFile(path, 'export const a = 99;\n')
      if (kind === 'large') await writeFile(path, Buffer.alloc(GENERATED_MODULE_LIMITS.fileBytes + 1, 32))
      if (kind === 'symlink') { await rm(path); await symlink(resolve(f.outDir, 'pkg/snippets/b.mjs'), path) }
      await assert.rejects(verifyGeneratedModuleClosure(f.outDir, f.inventory, parser), /changed|nonregular|byte budget/)
    } finally { await f.cleanup() }
  })
})

test('same-version parser-byte tampering rejects before parser evaluation', async () => {
  const f = await fixture()
  try {
    const path = resolve(f.root, 'tools/container-manifest/node_modules/acorn/dist/acorn.mjs')
    const bytes = await readFile(path); bytes[0] ^= 1; await writeFile(path, bytes)
    await assert.rejects(f.parser(), /Pinned parser SHA-256 mismatch/)
  } finally { await f.cleanup() }
})

test('retained parser evidence tampering cannot remain passed', async () => {
  const f = await fixture()
  try {
    const parser = await f.parser(), path = resolve(parser.provenance.evidenceDirectory, 'LICENSE')
    const bytes = await readFile(path); bytes[0] ^= 1; await writeFile(path, bytes)
    await assert.rejects(verifyRetainedGeneratedModuleParser(parser.provenance), /Retained parser changed/)
    assert.equal(parser.provenance.retainedStatus, 'failed')
  } finally { await f.cleanup() }
})
