import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildSimulatorBinary } from './perf-matrix.mjs'

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'weapp-perf-cache-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pack = path.join(root, 'portable-pack')
  mkdirSync(pack)
  const outDir = path.join(root, 'artifacts', 'matrix')
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, ...options })
    const engine = args[args.indexOf('--features') + 1].split('-')[0]
    const files = [
      { name: 'weapp-simulator', kind: 'bin', relative: 'debug/weapp-simulator' },
      { name: 'web-host-perf', kind: 'example', relative: 'debug/examples/web-host-perf' },
    ]
    const artifacts = files.map(({ name, kind, relative }) => {
      const executable = path.join(options.env.CARGO_TARGET_DIR, relative)
      mkdirSync(path.dirname(executable), { recursive: true })
      writeFileSync(executable, `${engine}:${name}`)
      chmodSync(executable, 0o755)
      return { reason: 'compiler-artifact', target: { name, kind: [kind] }, executable }
    })
    return { status: 0, stdout: artifacts.map(value => JSON.stringify(value)).join('\n'), stderr: '' }
  }
  return { root, pack, outDir, calls, spawn, environment: {}, platform: 'linux' }
}

test('matrix engines use stable isolated cache lanes and retain independent executable bytes', t => {
  const f = fixture(t)
  const quickjs = buildSimulatorBinary('quickjs', f)
  const v8 = buildSimulatorBinary('v8', f)
  assert.equal(quickjs.reason, null)
  assert.equal(v8.reason, null)
  assert.equal(f.calls.length, 2)
  for (const [i, call] of f.calls.entries()) {
    assert.equal(call.env.CARGO_TARGET_DIR, path.join(f.root, 'target/performance-matrix', ['quickjs', 'v8'][i]))
    assert.ok(call.args.includes('--message-format=json-render-diagnostics'))
  }
  assert.equal(existsSync(path.join(f.root, 'target/debug/weapp-simulator')), false)
  // A later rebuild may replace its fixed lane's executable. Reports continue
  // to use the exact copy retained by this run.
  writeFileSync(path.join(f.root, 'target/performance-matrix/quickjs/debug/weapp-simulator'), 'later quickjs build')
  assert.equal(readFileSync(quickjs.path, 'utf8'), 'quickjs:weapp-simulator')
  assert.equal(readFileSync(quickjs.webHostProbePath, 'utf8'), 'quickjs:web-host-perf')
  assert.equal(readFileSync(v8.path, 'utf8'), 'v8:weapp-simulator')
  assert.equal(readFileSync(v8.webHostProbePath, 'utf8'), 'v8:web-host-perf')
  assert.notEqual(path.dirname(quickjs.path), path.dirname(v8.path))
  assert.equal(statSync(quickjs.path).mode & 0o777, 0o755)
})

test('matrix honors a relative explicit Cargo cache and gives repeated runs fresh retained destinations', t => {
  const f = fixture(t)
  f.environment = { CARGO_TARGET_DIR: 'shared-cache', CARGO: 'recording-cargo' }
  const first = buildSimulatorBinary('quickjs', f)
  const second = buildSimulatorBinary('quickjs', f)
  assert.equal(f.calls[0].command, 'recording-cargo')
  assert.equal(f.calls[0].env.CARGO_TARGET_DIR, path.join(f.root, 'shared-cache/performance-matrix/quickjs'))
  assert.notEqual(first.path, second.path)
  assert.equal(readFileSync(first.path, 'utf8'), 'quickjs:weapp-simulator')
})

test('missing probe does not reuse stale cache bytes or discard an available simulator', t => {
  const f = fixture(t)
  const originalSpawn = f.spawn
  f.spawn = (...args) => {
    const result = originalSpawn(...args)
    result.stdout = result.stdout.split('\n').slice(0, 1).join('\n')
    return result
  }
  const binary = buildSimulatorBinary('quickjs', f)
  assert.ok(binary.path)
  assert.equal(binary.webHostProbePath, null)
  assert.match(binary.reason, /omitted the WebSurface host probe/)
})

test('Cargo failure cannot return an executable left by an earlier successful engine build', t => {
  const f = fixture(t)
  const previous = buildSimulatorBinary('quickjs', f)
  f.spawn = () => ({ status: 1, stdout: '', stderr: 'native engine failed' })
  const failed = buildSimulatorBinary('v8', f)
  assert.equal(failed.path, null)
  assert.match(failed.reason, /native engine failed/)
  assert.equal(readFileSync(previous.path, 'utf8'), 'quickjs:weapp-simulator')
})

test('unreported or out-of-cache artifacts cannot be accepted as this build result', t => {
  const f = fixture(t)
  const outside = path.join(f.root, 'unrelated-executable')
  writeFileSync(outside, 'unrelated')
  for (const executable of [null, outside]) {
    f.spawn = () => ({ status: 0, stdout: executable ? JSON.stringify({ reason: 'compiler-artifact',
      target: { name: 'weapp-simulator', kind: ['bin'] }, executable }) : '', stderr: '' })
    const failed = buildSimulatorBinary('quickjs', f)
    assert.equal(failed.path, null)
    assert.match(failed.reason, /retention failed/)
  }
  assert.equal(readFileSync(outside, 'utf8'), 'unrelated')
})

test('protected or overlapping output locations fail before invoking Cargo or overwriting source', t => {
  const f = fixture(t)
  const source = path.join(f.root, 'scripts')
  mkdirSync(source)
  writeFileSync(path.join(source, 'index.json'), 'source fixture')
  for (const outDir of [f.root, source, path.join(f.root, 'target'), path.join(f.pack, 'reports')]) {
    assert.throws(() => buildSimulatorBinary('quickjs', { ...f, outDir }), /outside source|separate directories/)
  }
  assert.equal(f.calls.length, 0)
  assert.equal(readFileSync(path.join(source, 'index.json'), 'utf8'), 'source fixture')
})

test('symlinked output into source is rejected before compilation', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t)
  const source = path.join(f.root, 'crates')
  mkdirSync(source)
  const output = path.join(f.root, 'output-link')
  symlinkSync(source, output)
  assert.throws(() => buildSimulatorBinary('quickjs', { ...f, outDir: output }), /outside source/)
  assert.equal(f.calls.length, 0)
})

test('protocol-only or missing-pack mode does not create Cargo cache or retained executables', t => {
  const f = fixture(t)
  for (const pack of [null, path.join(f.root, 'missing-pack')]) {
    const result = buildSimulatorBinary('quickjs', { ...f, pack })
    assert.equal(result.path, null)
    assert.match(result.reason, /protocol-only|does not exist/)
  }
  assert.equal(f.calls.length, 0)
  assert.equal(existsSync(path.join(f.root, 'target')), false)
  assert.equal(existsSync(f.outDir), false)
})
