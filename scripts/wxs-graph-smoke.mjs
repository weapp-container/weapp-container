#!/usr/bin/env node
/** Raw pack -> declared WXS graph -> actual native View result, on both engines. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOwnedCommandRunner, matchedResponse, sha256, sourceHashes } from './simulator-cli-harness.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE = resolve(ROOT, 'conformance/fixtures/wxs-graph')

function options(argv) {
  const result = { out: resolve(ROOT, 'artifacts/wxs-graph.json'), timeoutMs: 120_000 }
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

export async function main(argv = process.argv.slice(2)) {
  const config = options(argv)
  if (config.help) {
    process.stdout.write('Usage: node scripts/wxs-graph-smoke.mjs [--simulator-bin <path>] [--out <json>] [--timeout <ms>]\n')
    return
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-wxs-graph-'))
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: config.timeoutMs })
  const report = {
    schemaVersion: 1, scope: 'wxs-graph-native', status: 'failed', startedAt: new Date().toISOString(),
    fixture: { path: relative(ROOT, FIXTURE), kind: 'raw-weapp' }, engines: [], cleanup: {},
    evidenceBoundary: 'Auxiliary pack and native QuickJS/V8 View conformance. Not official DevTools, weapp-vite build, host/GPU/device or performance acceptance.',
  }
  try {
    report.sourceCommit = (await runner.command('git', ['rev-parse', 'HEAD'])).stdout.trim()
    report.workingTreeDirty = Boolean((await runner.command('git', ['status', '--short'])).stdout.trim())
    report.fixture.sha256 = await sourceHashes(FIXTURE)
    const compilerCommit = (await runner.command('git', ['-C', 'vendor/weapp-vite', 'rev-parse', 'HEAD'])).stdout.trim()
    const pack = resolve(temporary, 'pack')
    await runner.command(process.execPath, ['tools/container-manifest/bin/container-pack.mjs', FIXTURE, '--out', pack, '--compiler-commit', compilerCommit])
    const manifestBytes = await readFile(resolve(pack, 'manifest.json'))
    const manifest = JSON.parse(manifestBytes)
    assert.deepEqual(manifest.viewScripts.map(module => [module.id, module.dependencies]), [
      ['wxs:view/dep.wxs', []], ['wxs:view/main.wxs', ['wxs:view/dep.wxs']],
    ], 'only executable require calls declare an edge; regex/string decoys do not')
    for (const module of manifest.viewScripts) {
      const blob = await readFile(resolve(pack, 'blobs/sha256', module.sha256))
      assert.equal(sha256(blob), module.sha256, 'verified content-addressed WXS bytes')
      assert.deepEqual(blob, await readFile(resolve(FIXTURE, module.id.slice(4))), 'original WXS source bytes are not rewritten')
    }
    report.pack = { manifestSha256: sha256(manifestBytes), integrityRoot: manifest.integrity.root, compilerCommit,
      viewScripts: manifest.viewScripts }
    assert.deepEqual(await sourceHashes(FIXTURE), report.fixture.sha256, 'packing preserves all original input bytes')
    report.simulator = config.simulatorBin
      ? { path: config.simulatorBin, sha256: sha256(await readFile(config.simulatorBin)) }
      : { buildFeatures: ['quickjs-native', 'v8-native'], defaultFeatures: false }
    for (const engine of ['quickjs', 'v8']) {
      const observed = { engine, status: 'failed' }
      report.engines.push(observed)
      try {
        const prefix = resolve(temporary, engine)
        const request = { protocolVersion: '1.0', sessionId: 'simulator-1', requestId: 'wxs-graph-result', kind: 'request',
          op: 'api.call', payload: { name: 'wx.createSelectorQuery', selector: '#probe', all: false, operation: 'fields', fields: { dataset: true } } }
        await writeFile(`${prefix}.jsonl`, `${JSON.stringify(request)}\n`)
        const args = ['run', '--pack', pack, '--engine', engine, '--viewport', '200x100',
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
        for (const record of trace.records ?? trace.events ?? []) {
          for (const message of record.response?.messages ?? []) {
            assert.notEqual(message.op, 'error', JSON.stringify(message.payload))
            assert.notEqual(message.payload?.ok, false, JSON.stringify(message.payload))
          }
        }
        observed.trace = trace
        observed.dataset = matchedResponse(trace, 'wxs-graph-result', 'api.call').result?.dataset
        assert.deepEqual(observed.dataset, { result: '8|true|true|dep' }, 'dataset comes from actual WXS module execution and WXML binding')
        observed.status = 'passed'
      } catch (error) {
        observed.error = error.stack ?? String(error)
        if (error.result) observed.process = error.result
        if (runner.interrupted) throw error
      }
    }
    if (report.engines.every(engine => engine.status === 'passed')) {
      assert.deepEqual(report.engines[0].dataset, report.engines[1].dataset, 'both native engines agree')
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
  process.stdout.write(`${JSON.stringify({ status: report.status, report: config.out, engines: report.engines.map(({ engine, status }) => ({ engine, status })), cleanup: report.cleanup })}\n`)
  if (runner.interrupted) process.exitCode = runner.interrupted === 'SIGINT' ? 130 : 143
  else if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
