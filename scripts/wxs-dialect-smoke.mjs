#!/usr/bin/env node
/** Raw source + versioned executable IR -> actual native View, on both engines. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalize } from '../tools/container-manifest/src/index.mjs'
import { compileWxsModule, compileWxmlExpression, WXS_COMPILER_NAME, WXS_COMPILER_VERSION, WXS_HELPER_ABI_VERSION } from '../tools/container-manifest/src/wxs-compiler.mjs'
import { createOwnedCommandRunner, matchedResponse, sha256, sourceHashes } from './simulator-cli-harness.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE = resolve(ROOT, 'conformance/fixtures/wxs-dialect')
const DOCUMENT = 'pages/index/index.wxml'
const EXPECTED = Object.freeze({
  constructors: 'Number,String,Boolean,Object,Function,Array,Date,RegExp',
  arrays: '2,4,6|2,3|2,3|1,2,3,4|2|1,8,3',
  computed: 'Array|Object',
  own: 'Own',
  forin: 'second',
  global: 'Array|String|Number|Boolean|Object',
  inline: 'Array|Inline',
})

function options(argv) {
  const result = { out: resolve(ROOT, 'artifacts/wxs-dialect.json'), timeoutMs: 120_000 }
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (key === '--') continue
    if (key === '--help' || key === '-h') return { help: true }
    if (!['--out', '--simulator-bin', '--timeout'].includes(key)) throw new Error(`Unknown option: ${key}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`)
    if (key === '--out') result.out = resolve(value)
    if (key === '--simulator-bin') result.simulatorBin = resolve(value)
    if (key === '--timeout') result.timeoutMs = Number(value)
  }
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1_000) throw new Error('--timeout must be >= 1000 milliseconds')
  return result
}

async function verifyCompilation(pack, manifest) {
  const compilation = manifest.viewCompilation
  assert.ok(compilation, 'pack declares the actual compiler ABI instead of executing original ECMAScript')
  assert.deepEqual([compilation.compiler, compilation.version, compilation.abi],
    [WXS_COMPILER_NAME, WXS_COMPILER_VERSION, WXS_HELPER_ABI_VERSION])
  const input = { ...manifest, integrity: { algorithm: 'sha256', root: '' } }
  assert.equal(manifest.integrity.root, sha256(Buffer.from(canonicalize(input))), 'compiled identity belongs to manifest integrity root')
  const documentSource = await readFile(resolve(FIXTURE, DOCUMENT), 'utf8')
  const inline = /<wxs module="inline">([\s\S]*?)<\/wxs>/.exec(documentSource)
  assert.ok(inline, 'fixture contains an independently observable inline module')
  assert.equal(manifest.viewScripts.length, 2, 'external and inline module are both declared')
  assert.equal(compilation.modules.length, 2, 'every WXS module has one executable')
  const records = []
  for (const module of manifest.viewScripts) {
    const executable = compilation.modules.filter(entry => entry.id === module.id)
    assert.equal(executable.length, 1, 'exactly one compiled module identity')
    const compiled = executable[0]
    assert.equal(compiled.sourceSha256, module.sha256)
    assert.match(compiled.helper, /^__wc[A-Za-z0-9_$]*$/)
    const sourceBytes = await readFile(resolve(pack, 'blobs/sha256', module.sha256))
    assert.equal(sha256(sourceBytes), module.sha256)
    const originalBytes = module.id === `wxs:${DOCUMENT}#inline`
      ? Buffer.from(inline[1]) : await readFile(resolve(FIXTURE, module.id.slice(4)))
    assert.deepEqual(sourceBytes, originalBytes, 'raw WXS bytes remain original, including inline whitespace')
    const executableBytes = await readFile(resolve(pack, 'blobs/sha256', compiled.executableSha256))
    assert.equal(sha256(executableBytes), compiled.executableSha256)
    const rebuilt = compileWxsModule(sourceBytes.toString('utf8'))
    assert.equal(compiled.helper, rebuilt.helper)
    assert.deepEqual(executableBytes, Buffer.from(rebuilt.code), 'module execution bytes match the versioned compiler')
    assert.notEqual(compiled.sourceSha256, compiled.executableSha256, 'source and lowered execution bytes have separate identities')
    records.push({ ...compiled, sourceSize: sourceBytes.length, executableSize: executableBytes.length })
  }
  assert.equal(compilation.documents.length, 1)
  const document = compilation.documents[0]
  assert.equal(document.documentId, DOCUMENT)
  assert.equal(document.wxmlAst, manifest.templates.find(entry => entry.id === `template:${DOCUMENT}`).wxmlAst)
  assert.equal(document.expressions.length, 7, 'all seven WXML dataset expressions have executable records')
  for (const expression of document.expressions) {
    assert.equal(expression.shorthand, false)
    assert.match(expression.helper, /^__wc[A-Za-z0-9_$]*$/)
    const bytes = await readFile(resolve(pack, 'blobs/sha256', expression.executableSha256))
    assert.equal(sha256(bytes), expression.executableSha256)
    const rebuilt = compileWxmlExpression(expression.source, { shorthand: expression.shorthand })
    assert.equal(expression.helper, rebuilt.helper)
    assert.deepEqual(bytes, Buffer.from(rebuilt.code), 'WXML execution bytes match the versioned compiler')
  }
  return { compiler: compilation.compiler, version: compilation.version, abi: compilation.abi,
    modules: records, documents: compilation.documents }
}

export async function main(argv = process.argv.slice(2)) {
  const config = options(argv)
  if (config.help) {
    process.stdout.write('Usage: node scripts/wxs-dialect-smoke.mjs [--simulator-bin <fresh-dual-engine-bin>] [--out <json>] [--timeout <ms>]\n')
    return
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-wxs-dialect-'))
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: config.timeoutMs })
  const report = {
    schemaVersion: 1, scope: 'wxs-dialect-native', status: 'failed', startedAt: new Date().toISOString(),
    fixture: { path: relative(ROOT, FIXTURE), kind: 'raw-weapp' }, expected: EXPECTED, engines: [], cleanup: {},
    evidenceBoundary: 'Auxiliary raw pack and native QuickJS/V8 View observations of constructor reads and native Array operations. Not official DevTools, complete WXS semantics, weapp-vite build, host/GPU/device, browser or performance acceptance.',
  }
  try {
    report.sourceCommit = (await runner.command('git', ['rev-parse', 'HEAD'])).stdout.trim()
    report.workingTreeDirty = Boolean((await runner.command('git', ['status', '--short'])).stdout.trim())
    report.fixture.sha256 = await sourceHashes(FIXTURE)
    report.packerSourceSha256 = await sourceHashes(resolve(ROOT, 'tools/container-manifest/src'))
    const compilerCommit = (await runner.command('git', ['-C', 'vendor/weapp-vite', 'rev-parse', 'HEAD'])).stdout.trim()
    const pack = resolve(temporary, 'pack')
    await runner.command(process.execPath, ['tools/container-manifest/bin/container-pack.mjs', FIXTURE, '--out', pack, '--compiler-commit', compilerCommit])
    const manifestBytes = await readFile(resolve(pack, 'manifest.json'))
    const manifest = JSON.parse(manifestBytes)
    report.pack = { manifestSha256: sha256(manifestBytes), integrityRoot: manifest.integrity.root, compilerCommit,
      compilation: await verifyCompilation(pack, manifest) }
    assert.deepEqual(await sourceHashes(FIXTURE), report.fixture.sha256, 'packing preserves every original fixture byte')
    report.simulator = config.simulatorBin
      ? { path: config.simulatorBin, sha256: sha256(await readFile(config.simulatorBin)) }
      : { buildFeatures: ['quickjs-native', 'v8-native'], defaultFeatures: false }
    for (const engine of ['quickjs', 'v8']) {
      const observed = { engine, status: 'failed' }
      report.engines.push(observed)
      try {
        const prefix = resolve(temporary, engine)
        const request = { protocolVersion: '1.0', sessionId: 'simulator-1', requestId: 'wxs-dialect-result', kind: 'request',
          op: 'api.call', payload: { name: 'wx.createSelectorQuery', selector: '#probe', all: false, operation: 'fields', fields: { dataset: true } } }
        await writeFile(`${prefix}.jsonl`, `${JSON.stringify(request)}\n`)
        const args = ['run', '--pack', pack, '--engine', engine, '--viewport', '320x200',
          '--script', `${prefix}.jsonl`, '--trace', `${prefix}.trace.json`, '--report', `${prefix}.report.json`]
        const result = config.simulatorBin ? await runner.command(config.simulatorBin, args)
          : await runner.command(process.env.CARGO || 'cargo', ['run', '-p', 'container-simulator', '--no-default-features', '--features', 'quickjs-native,v8-native', '--locked', '--', ...args])
        observed.process = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'stdout'))
        observed.simulator = JSON.parse(await readFile(`${prefix}.report.json`, 'utf8'))
        assert.equal(observed.simulator.status, 'passed')
        assert.equal(observed.simulator.engine, engine, 'requested engine without fallback')
        assert.equal(observed.simulator.route, 'pages/index/index')
        assert.equal(observed.simulator.lifecycleState, 'Active')
        const trace = JSON.parse(await readFile(`${prefix}.trace.json`, 'utf8'))
        observed.trace = trace
        for (const record of trace.records ?? trace.events ?? []) {
          for (const message of record.response?.messages ?? []) {
            assert.notEqual(message.op, 'error', JSON.stringify(message.payload))
            assert.notEqual(message.payload?.ok, false, JSON.stringify(message.payload))
          }
        }
        observed.dataset = matchedResponse(trace, 'wxs-dialect-result', 'api.call').result?.dataset
        assert.deepEqual(observed.dataset, EXPECTED, 'dataset originates from actual compiled WXS + WXML execution')
        observed.status = 'passed'
      } catch (error) {
        observed.error = error.stack ?? String(error)
        if (error.result) observed.process = error.result
        if (runner.interrupted) throw error
      }
    }
    if (report.engines.every(engine => engine.status === 'passed')) {
      assert.deepEqual(report.engines[0].dataset, report.engines[1].dataset, 'same fixture agrees across the two native engines')
      report.status = 'passed'
    }
  } catch (error) {
    report.error = error.stack ?? String(error)
    if (error.result) report.failedProcess = error.result
  } finally {
    report.cleanup.childProcessClosed = runner.active === null
    try { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporaryRemoved = true }
    catch (error) { report.cleanup.error = String(error); report.status = 'failed' }
    report.cleanup.noListenerOrBrowserCreated = true
    report.finishedAt = new Date().toISOString()
    if (runner.interrupted) { report.interrupted = runner.interrupted; report.status = 'failed' }
    runner.dispose()
    await mkdir(dirname(config.out), { recursive: true })
    await writeFile(config.out, `${JSON.stringify(report, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, report: config.out,
    engines: report.engines.map(({engine,status}) => ({engine,status})), cleanup: report.cleanup })}\n`)
  if (runner.interrupted) process.exitCode = runner.interrupted === 'SIGINT' ? 130 : 143
  else if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
