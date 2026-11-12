import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  ReceiptPublisher, createBuildReceiptController, discoverWeappVite,
  freezeSnapshot, installWatchEnvironment, parseOptions, resolveCompilerCommit,
  resolveWatchBackend, runCompilerWatch, runCustomBuilder,
  sourceFingerprint, waitForSourceChange,
} from './simulator-watch.mjs'

const tick = () => new Promise(resolveTick => setImmediate(resolveTick))

test('watch backend defaults to polling on macOS and native elsewhere, with explicit overrides', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const automatic = resolveWatchBackend('auto', platform)
    assert.equal(automatic.selected, platform === 'darwin' ? 'polling' : 'native')
    assert.deepEqual(automatic.options, { usePolling: platform === 'darwin', interval: 150, binaryInterval: 300 })
    assert.equal(resolveWatchBackend('native', platform).options.usePolling, false)
    assert.equal(resolveWatchBackend('polling', platform).options.usePolling, true)
  }
  for (const invalid of ['', 'POLLING', false, null, {}, 'polling\n']) {
    assert.throws(() => resolveWatchBackend(invalid), /ERR_WATCH_BACKEND/)
  }
})

test('owned watch environment overrides conflicting Chokidar values and restores exact prior presence', () => {
  for (const backend of ['native', 'polling']) {
    const env = { CHOKIDAR_USEPOLLING: backend === 'polling' ? 'false' : 'true', CHOKIDAR_INTERVAL: '9000', OTHER: 'untouched' }
    const original = { ...env }
    const restore = installWatchEnvironment(backend, env)
    assert.deepEqual(env, {
      ...original, CHOKIDAR_USEPOLLING: String(backend === 'polling'),
      CHOKIDAR_INTERVAL: '150', CHOKIDAR_BINARY_INTERVAL: '300',
    })
    restore()
    assert.deepEqual(env, original)
    assert.equal(Object.hasOwn(env, 'CHOKIDAR_BINARY_INTERVAL'), false)
  }
})

function fixture(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'weapp-watch-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = resolve(root, 'project')
  const outputRoot = resolve(project, 'dist')
  mkdirSync(outputRoot, { recursive: true })
  const receiptRoot = resolve(root, 'receipt-session')
  const publisher = new ReceiptPublisher(receiptRoot, 'test-session')
  const write = (name, contents) => {
    const path = resolve(outputRoot, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  const receipts = () => readdirSync(publisher.receipts).filter(name => name.endsWith('.json')).sort().map(name => ({
    filename: name,
    ...JSON.parse(readFileSync(resolve(publisher.receipts, name), 'utf8')),
  }))
  const snapshot = receipt => resolve(receiptRoot, receipt.snapshot)
  const watcher = new EventEmitter()
  const controller = createBuildReceiptController(publisher, outputRoot)
  watcher.on('event', controller.event)
  return { root, project, outputRoot, receiptRoot, publisher, write, receipts, snapshot, controller, watcher }
}

test('only END freezes a complete generation synchronously and publishes once', t => {
  const f = fixture(t)
  f.watcher.emit('event', { code: 'START' })
  f.controller.plugin.buildStart()
  f.write('app.json', '{"generation":1}')
  f.write('pages/index.js', 'first module')
  assert.deepEqual(f.receipts().map(row => row.kind), ['building'])
  f.controller.plugin.buildEnd()
  f.controller.plugin.closeBundle()
  // A half-written later file and a long quiet pause never certify completion.
  f.write('pages/index.js', 'second module')
  assert.equal(f.receipts().filter(row => row.kind === 'success').length, 0)
  f.watcher.emit('event', { code: 'END' })
  f.write('app.json', '{"generation":2}')
  f.watcher.emit('event', { code: 'END' })
  const rows = f.receipts()
  assert.deepEqual(rows.map(row => row.kind), ['building', 'success'])
  assert.equal(rows[1].protocolVersion, '1.0')
  assert.equal(rows[1].sessionId, 'test-session')
  assert.equal(rows[1].sequence, 2)
  assert.equal(Object.hasOwn(rows[1], 'compilerCommit'), false, 'legacy receipts keep optional compiler identity absent')
  assert.equal(rows[1].filename, '00000000000000000002.json')
  assert.match(rows[1].snapshot, /^snapshots\/[^/]+$/)
  assert.equal(readFileSync(resolve(f.snapshot(rows[1]), 'app.json'), 'utf8'), '{"generation":1}')
  assert.equal(readFileSync(resolve(f.snapshot(rows[1]), 'pages/index.js'), 'utf8'), 'second module')
  assert.equal(readdirSync(f.publisher.snapshots).some(name => name.startsWith('.pending-')), false)
})

test('a paused mixed output without END does not publish a success', async t => {
  const f = fixture(t)
  f.write('app.json', '{"generation":1}')
  f.write('app.js', 'old')
  f.watcher.emit('event', { code: 'START' })
  f.write('app.js', 'new')
  await tick()
  await tick()
  assert.deepEqual(f.receipts().map(row => row.kind), ['building'])
  assert.deepEqual(readdirSync(f.publisher.snapshots), [])
})

test('ERROR keeps the last snapshot and recovery publishes a new independent generation', t => {
  const f = fixture(t)
  f.write('app.json', 'old')
  f.watcher.emit('event', { code: 'START' })
  f.watcher.emit('event', { code: 'END' })
  const first = f.receipts().at(-1)
  f.watcher.emit('event', { code: 'START' })
  f.write('app.json', 'partial')
  f.controller.plugin.buildEnd(new Error('syntax error'))
  f.watcher.emit('event', { code: 'ERROR', error: new Error('syntax error') })
  f.watcher.emit('event', { code: 'END' })
  assert.deepEqual(f.receipts().map(row => row.kind), ['building', 'success', 'building', 'error'])
  assert.equal(readFileSync(resolve(f.snapshot(first), 'app.json'), 'utf8'), 'old')
  f.watcher.emit('event', { code: 'START' })
  f.write('app.json', 'recovered')
  f.watcher.emit('event', { code: 'END' })
  const latest = f.receipts().at(-1)
  assert.equal(readFileSync(resolve(f.snapshot(latest), 'app.json'), 'utf8'), 'recovered')
  assert.notEqual(first.snapshot, latest.snapshot)
  assert.equal(readFileSync(resolve(f.snapshot(first), 'app.json'), 'utf8'), 'old')
})

test('symlink output cannot produce a success or leave a partial snapshot', t => {
  const f = fixture(t)
  f.write('app.json', 'valid')
  symlinkSync(resolve(f.outputRoot, 'app.json'), resolve(f.outputRoot, 'linked.json'))
  f.watcher.emit('event', { code: 'START' })
  f.watcher.emit('event', { code: 'END' })
  assert.deepEqual(f.receipts().map(row => row.kind), ['building', 'error'])
  assert.match(f.receipts().at(-1).message, /symlink/)
  assert.deepEqual(readdirSync(f.publisher.snapshots), [])
  assert.throws(() => freezeSnapshot(f.outputRoot, resolve(f.outputRoot, 'snapshots')), /separate/)
})

test('initial completion is gated against active or failed later builds', t => {
  const f = fixture(t)
  f.write('app.json', 'first')
  f.controller.plugin.buildStart()
  f.controller.plugin.buildEnd()
  f.controller.plugin.closeBundle()
  f.controller.plugin.buildStart()
  f.write('app.json', 'partial second')
  f.controller.initialReady()
  assert.equal(f.receipts().some(row => row.kind === 'success'), false)
  f.controller.plugin.buildEnd(new Error('second build failed'))
  f.controller.plugin.closeBundle()
  f.controller.initialReady()
  f.watcher.emit('event', { code: 'END' })
  assert.equal(f.receipts().some(row => row.kind === 'success'), false)
  f.watcher.emit('event', { code: 'START' })
  f.controller.plugin.buildStart()
  f.write('app.json', 'complete third')
  f.controller.plugin.buildEnd()
  f.controller.plugin.closeBundle()
  f.watcher.emit('event', { code: 'END' })
  f.controller.initialReady()
  assert.equal(f.receipts().filter(row => row.kind === 'success').length, 1)
})

test('a nested child close cannot certify its still-active parent build', t => {
  const f = fixture(t)
  f.write('app.json', 'partial')
  f.controller.plugin.buildStart()
  f.controller.plugin.buildStart()
  f.controller.plugin.buildEnd()
  f.controller.plugin.closeBundle()
  f.controller.initialReady()
  f.watcher.emit('event', { code: 'END' })
  assert.equal(f.receipts().some(row => row.kind === 'success'), false)
  f.write('app.json', 'parent complete')
  f.controller.plugin.buildEnd()
  f.controller.plugin.closeBundle()
  f.watcher.emit('event', { code: 'END' })
  assert.equal(f.receipts().filter(row => row.kind === 'success').length, 1)
})

test('a long-lived serve provider cannot block a completed app generation', t => {
  const f = fixture(t)
  const plugins = [f.controller.plugin]
  // Vite filters apply before invoking hooks. The compiler's dependency-graph
  // server stays alive, so any serve buildStart here would have no closeBundle.
  for (const plugin of plugins.filter(plugin => !plugin.apply || plugin.apply === 'serve')) {
    plugin.buildStart()
  }
  for (const plugin of plugins.filter(plugin => !plugin.apply || plugin.apply === 'build')) {
    plugin.buildStart()
    f.write('app.json', 'complete app')
    plugin.buildEnd()
    plugin.closeBundle()
  }
  f.controller.initialReady()
  assert.equal(f.receipts().filter(row => row.kind === 'success').length, 1)
})

test('public compiler setup prebuilds npm, recovers consumed initial END, and closes resources', async t => {
  const f = fixture(t)
  f.watcher.off('event', f.controller.event)
  const abort = new AbortController()
  const calls = []
  let plugin
  let closed = 0
  const running = runCompilerWatch({
    ...f, signal: abort.signal,
    async createCompilerContext(options) {
      calls.push('context')
      assert.equal(options.cwd, f.project)
      assert.equal(options.isDev, true)
      assert.equal(options.cliPlatform, 'weapp')
      assert.equal(options.outputRoot, f.outputRoot)
      assert.equal(options.inlineConfig.weapp.hmr.runtime, 'classic')
      assert.equal(options.inlineConfig.build.outDir, f.outputRoot)
      assert.deepEqual(options.inlineConfig.server.watch, resolveWatchBackend().options)
      assert.deepEqual(options.inlineConfig.build.watch.chokidar, options.inlineConfig.server.watch)
      plugin = options.inlineConfig.plugins[0]
      return {
        npmService: { async build() { calls.push('npm'); f.write('app.json', 'npm-only') } },
        buildService: {
          async build(options) {
            calls.push('build')
            assert.deepEqual(options, { skipNpm: true })
            plugin.buildStart()
            f.write('app.json', 'app-complete')
            plugin.buildEnd()
            plugin.closeBundle()
            return f.watcher
          },
        },
        watcherService: { async closeAll() { closed += 1 } },
      }
    },
  })
  t.after(() => abort.abort())
  await tick()
  assert.deepEqual(calls, ['context', 'npm', 'build'])
  const success = f.receipts().find(row => row.kind === 'success')
  assert.ok(success)
  assert.equal(readFileSync(resolve(f.snapshot(success), 'app.json'), 'utf8'), 'app-complete')
  abort.abort()
  await running
  assert.equal(closed, 1)
  assert.equal(f.watcher.listenerCount('event'), 0)
  const count = f.receipts().length
  f.watcher.emit('event', { code: 'END' })
  assert.equal(f.receipts().length, count, 'no post-cleanup adapter receipts')
})

for (const backend of ['native', 'polling']) {
  test(`explicit ${backend} watch options reach the same public context without an extra builder`, async t => {
    const f = fixture(t)
    f.watcher.off('event', f.controller.event)
    const abort = new AbortController()
    let contexts = 0
    let closed = 0
    const running = runCompilerWatch({
      ...f, signal: abort.signal, watchBackend: backend,
      async createCompilerContext(options) {
        contexts += 1
        const expected = resolveWatchBackend(backend).options
        assert.deepEqual(options.inlineConfig.server.watch, expected)
        assert.deepEqual(options.inlineConfig.build.watch.chokidar, expected)
        assert.notEqual(options.inlineConfig.server.watch, options.inlineConfig.build.watch.chokidar)
        const plugin = options.inlineConfig.plugins[0]
        return {
          npmService: { async build() {} },
          buildService: { async build() {
            plugin.buildStart()
            f.write('app.json', '{}')
            plugin.buildEnd()
            plugin.closeBundle()
            return f.watcher
          } },
          watcherService: { async closeAll() { closed += 1 } },
        }
      },
    })
    t.after(() => abort.abort())
    await tick()
    assert.equal(contexts, 1)
    const initial = f.receipts().find(row => row.kind === 'success')
    assert.ok(initial)
    f.watcher.emit('event', { code: 'START' })
    f.write('app.json', '{"updated":true}')
    f.watcher.emit('event', { code: 'END' })
    assert.equal(f.receipts().filter(row => row.kind === 'success').length, 2)
    assert.equal(readFileSync(resolve(f.snapshot(initial), 'app.json'), 'utf8'), '{}')
    assert.equal(contexts, 1, 'a source event never creates a second compiler context')
    abort.abort()
    await running
    assert.equal(closed, 1)
    assert.equal(f.watcher.listenerCount('event'), 0)
  })
}

test('failed initialization closes its context and retries only after a source change', async t => {
  const f = fixture(t)
  const abort = new AbortController()
  let attempts = 0
  let closed = 0
  let releaseChange
  const change = new Promise(resolveChange => { releaseChange = resolveChange })
  const running = runCompilerWatch({
    ...f, signal: abort.signal,
    async waitForChange(project, ignored, signal) {
      assert.equal(project, f.project)
      assert.ok(ignored.includes(f.outputRoot))
      assert.equal(signal, abort.signal)
      await change
    },
    async createCompilerContext(options) {
      const attempt = ++attempts
      const plugin = options.inlineConfig.plugins[0]
      return {
        npmService: { async build() {} },
        buildService: {
          async build() {
            plugin.buildStart()
            if (attempt === 1) {
              const error = new Error('broken source')
              plugin.buildEnd(error)
              plugin.closeBundle()
              throw error
            }
            f.write('app.json', 'fixed')
            plugin.buildEnd()
            plugin.closeBundle()
            return f.watcher
          },
        },
        watcherService: { async closeAll() { closed += 1 } },
      }
    },
  })
  t.after(() => { abort.abort(); releaseChange() })
  await tick()
  assert.equal(attempts, 1)
  assert.equal(closed, 1)
  assert.deepEqual(f.receipts().map(row => row.kind), ['building', 'error'])
  releaseChange()
  await tick()
  assert.equal(attempts, 2)
  assert.equal(f.receipts().at(-1).kind, 'success')
  abort.abort()
  await running
  assert.equal(closed, 2)
})

test('cancellation during npm drains resources registered after the first close', async t => {
  const f = fixture(t)
  const abort = new AbortController()
  let releaseNpm
  let closed = 0
  let lateResource = false
  const npmFinished = new Promise(resolveNpm => { releaseNpm = resolveNpm })
  const running = runCompilerWatch({
    ...f, signal: abort.signal,
    async createCompilerContext() {
      return {
        npmService: { async build() { await npmFinished; lateResource = true } },
        buildService: { build() { assert.fail('app build must not start after cancellation') } },
        watcherService: { async closeAll() { closed += 1; lateResource = false } },
      }
    },
  })
  t.after(() => { abort.abort(); releaseNpm() })
  await tick()
  abort.abort()
  await tick()
  assert.equal(closed, 1)
  releaseNpm()
  await running
  assert.equal(closed, 2)
  assert.equal(lateResource, false)
  assert.deepEqual(f.receipts().map(row => row.kind), ['building'])
})

test('source-change retry ignores receipt/output churn and aborts its polling timer', async t => {
  const f = fixture(t)
  const source = resolve(f.project, 'source.js')
  writeFileSync(source, 'before')
  const initial = sourceFingerprint(f.project, [f.outputRoot, f.receiptRoot])
  f.write('app.json', 'output')
  f.publisher.emit('building')
  assert.equal(sourceFingerprint(f.project, [f.outputRoot, f.receiptRoot]), initial)
  const abort = new AbortController()
  const waiting = waitForSourceChange(f.project, [f.outputRoot, f.receiptRoot], abort.signal, 5)
  writeFileSync(source, 'changed source')
  await waiting
  assert.notEqual(sourceFingerprint(f.project, [f.outputRoot, f.receiptRoot]), initial)
  const cancelled = waitForSourceChange(f.project, [], abort.signal, 60_000)
  abort.abort()
  await cancelled
})

function fakePackage(f, root = resolve(f.root, 'compiler')) {
  mkdirSync(resolve(root, 'bin'), { recursive: true })
  mkdirSync(resolve(root, 'dist'), { recursive: true })
  writeFileSync(resolve(root, 'package.json'), JSON.stringify({
    name: 'weapp-vite', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.mjs' } },
  }))
  writeFileSync(resolve(root, 'dist/index.mjs'), 'export const createCompilerContext = () => {}')
  writeFileSync(resolve(root, 'bin/wv.js'), '#!/usr/bin/env node\n')
  return root
}

function commitFiles(root, files) {
  const git = args => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  git(['init', '--quiet'])
  git(['add', '--', ...files])
  git(['-c', 'user.name=Weapp Container fixture', '-c', 'user.email=weapp-fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${resolve(root, '.git/no-fixture-hooks')}`,
    'commit', '--quiet', '--message', 'compiler provenance fixture'])
  return git(['rev-parse', 'HEAD'])
}

test('compiler provenance uses the effective tracked installation instead of an unrelated parent checkout', t => {
  const f = fixture(t)
  writeFileSync(resolve(f.root, 'unrelated.txt'), 'unrelated checkout B')
  const unrelated = commitFiles(f.root, ['unrelated.txt'])
  const packageRoot = fakePackage(f)
  assert.equal(resolveCompilerCommit(packageRoot), undefined, 'untracked package cannot inherit checkout B')
  const effective = commitFiles(packageRoot, ['package.json'])
  assert.notEqual(effective, unrelated)
  const api = discoverWeappVite(resolve(packageRoot, 'bin/wv.js'))
  assert.equal(resolveCompilerCommit(api.packageRoot), effective)
  writeFileSync(resolve(packageRoot, 'package.json'), JSON.stringify({ name: 'weapp-vite', dirty: true }))
  assert.equal(resolveCompilerCommit(packageRoot), effective, 'Git baseline makes no clean-byte claim')
})

test('npm and non-Git installations omit unknown compiler provenance', t => {
  const f = fixture(t)
  const standalone = fakePackage(f)
  assert.equal(resolveCompilerCommit(standalone), undefined)
  writeFileSync(resolve(f.root, 'unrelated.txt'), 'application checkout')
  commitFiles(f.root, ['unrelated.txt'])
  const npmPackage = fakePackage(f, resolve(f.root, 'node_modules/weapp-vite'))
  assert.equal(resolveCompilerCommit(discoverWeappVite(resolve(npmPackage, 'bin/wv.js')).packageRoot), undefined)
  execFileSync('git', ['add', '--', 'node_modules/weapp-vite/package.json'], { cwd: f.root, timeout: 2_000 })
  assert.equal(resolveCompilerCommit(npmPackage), undefined, 'staged package absent from HEAD has no baseline')
})

test('only successful receipts carry a validated optional compiler commit', t => {
  const f = fixture(t)
  f.write('app.json', '{}')
  for (const length of [40, 64]) {
    const compilerCommit = 'a'.repeat(length)
    const publisher = new ReceiptPublisher(resolve(f.root, `provenance-${length}`), 'identity', compilerCommit)
    assert.equal(Object.hasOwn(publisher.emit('building'), 'compilerCommit'), false)
    assert.equal(publisher.success(f.outputRoot).compilerCommit, compilerCommit)
    assert.equal(Object.hasOwn(publisher.emit('error', { message: 'failed' }), 'compilerCommit'), false)
  }
  for (const invalid of ['', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(64), null, { toString: () => 'a'.repeat(40) }]) {
    assert.throws(() => new ReceiptPublisher(resolve(f.root, 'invalid-identity'), 'identity', invalid), /lowercase hexadecimal/)
  }
})

test('public API discovery supports bin symlinks and pnpm wrapper targets', t => {
  const f = fixture(t)
  const root = fakePackage(f)
  const bin = resolve(f.root, 'node_modules/.bin')
  mkdirSync(bin, { recursive: true })
  const link = resolve(bin, 'wv')
  symlinkSync(resolve(root, 'bin/wv.js'), link)
  assert.equal(discoverWeappVite(link).entry, resolve(root, 'dist/index.mjs'))
  rmSync(link)
  writeFileSync(link, '#!/bin/sh\nexec node "$basedir/../../compiler/bin/wv.js" "$@"\n# cmd-shim-target=../../compiler/bin/wv.js\n')
  assert.equal(discoverWeappVite(link).entry, resolve(root, 'dist/index.mjs'))
  writeFileSync(link, '#!/bin/sh\nexec node "$basedir_abs/../../compiler/bin/weapp-vite.js" "$@"\n')
  writeFileSync(resolve(root, 'bin/weapp-vite.js'), '#!/usr/bin/env node\n')
  assert.equal(discoverWeappVite(link).entry, resolve(root, 'dist/index.mjs'))
  symlinkSync(root, resolve(f.root, 'node_modules/weapp-vite'), 'junction')
  const cmd = resolve(bin, 'wv.cmd')
  writeFileSync(cmd, '@ECHO off\nnode weapp-vite-package-wrapper %*\n')
  assert.equal(discoverWeappVite(cmd).entry, resolve(root, 'dist/index.mjs'))
  const custom = resolve(f.root, 'fake-wv.mjs')
  writeFileSync(custom, 'console.log("custom")')
  assert.equal(discoverWeappVite(custom), null)
})

test('symlinked native entry publishes before import, overrides production mode, and cleans up on SIGTERM', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const root = fakePackage(f)
  const marker = resolve(f.root, 'native-import.json')
  const closedMarker = resolve(f.root, 'native-closed')
  writeFileSync(resolve(root, 'dist/index.mjs'), `
    import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
    import { EventEmitter } from 'node:events';
    const directory = process.env.WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR + '/receipts';
    const first = JSON.parse(readFileSync(directory + '/' + readdirSync(directory).sort()[0], 'utf8'));
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ kind: first.kind, mode: process.env.NODE_ENV,
      usePolling: process.env.CHOKIDAR_USEPOLLING, interval: process.env.CHOKIDAR_INTERVAL,
      binaryInterval: process.env.CHOKIDAR_BINARY_INTERVAL }));
    let keepAlive;
    export async function createCompilerContext(options) {
      const plugin = options.inlineConfig.plugins[0];
      return {
        npmService: { async build() {} },
        buildService: { async build() {
          plugin.buildStart();
          writeFileSync(options.inlineConfig.build.outDir + '/app.json', '{}');
          plugin.buildEnd();
          plugin.closeBundle();
          keepAlive = setInterval(() => {}, 1000);
          return new EventEmitter();
        } },
        watcherService: { async closeAll() {
          clearInterval(keepAlive);
          writeFileSync(${JSON.stringify(closedMarker)}, 'closed');
        } },
      };
    }
  `)
  writeFileSync(resolve(f.root, 'unrelated.txt'), 'unrelated checkout B')
  const unrelated = commitFiles(f.root, ['unrelated.txt'])
  const effective = commitFiles(root, ['package.json'])
  assert.notEqual(effective, unrelated)
  const adapter = resolve(f.root, 'adapter.mjs')
  symlinkSync(fileURLToPath(new URL('./simulator-watch.mjs', import.meta.url)), adapter)
  const child = spawn(process.execPath, [
    adapter,
    '--project', f.project, '--output-root', f.outputRoot, '--wv-bin', resolve(root, 'bin/wv.js'),
  ], {
    env: { ...process.env, NODE_ENV: 'production', WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR: f.receiptRoot,
      WEAPP_CONTAINER_SIMULATOR_SESSION_ID: 'native-child', WEAPP_CONTAINER_SIMULATOR_WATCH_BACKEND: 'polling',
      CHOKIDAR_USEPOLLING: 'false', CHOKIDAR_INTERVAL: '9000', CHOKIDAR_BINARY_INTERVAL: '10000' },
    stdio: 'ignore',
  })
  const done = new Promise((resolveDone, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolveDone({ code, signal }))
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await done
  })
  for (let attempt = 0; attempt < 100 && !f.receipts().some(row => row.kind === 'success'); attempt += 1) {
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { kind: 'building', mode: 'development',
    usePolling: 'true', interval: '150', binaryInterval: '300' })
  assert.equal(f.receipts().filter(row => row.kind === 'success').length, 1)
  assert.equal(f.receipts().find(row => row.kind === 'success').compilerCommit, effective)
  assert.equal(f.receipts().filter(row => row.kind !== 'success').some(row => Object.hasOwn(row, 'compilerCommit')), false)
  child.kill('SIGTERM')
  assert.deepEqual(await done, { code: 0, signal: null })
  assert.equal(readFileSync(closedMarker, 'utf8'), 'closed')
})

test('custom builder owns receipts, receives documented args/env, and exits on cancellation', async t => {
  const f = fixture(t)
  const binary = resolve(f.root, 'custom.mjs')
  const marker = resolve(f.root, 'custom-args.json')
  writeFileSync(binary, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.TEST_MARKER, JSON.stringify({ args: process.argv.slice(2), session: process.env.WEAPP_CONTAINER_SIMULATOR_SESSION_ID }));
    writeFileSync(process.env.WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR + '/receipts/00000000000000000001.json', JSON.stringify({ protocolVersion: '1.0', sessionId: process.env.WEAPP_CONTAINER_SIMULATOR_SESSION_ID, sequence: 1, kind: 'building' }));
    setInterval(() => {}, 1000);
  `)
  const abort = new AbortController()
  const running = runCustomBuilder({
    binary, project: f.project, signal: abort.signal, stdio: 'ignore',
    env: { ...process.env, TEST_MARKER: marker, WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR: f.receiptRoot, WEAPP_CONTAINER_SIMULATOR_SESSION_ID: 'owned-custom' },
  })
  t.after(() => abort.abort())
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { JSON.parse(readFileSync(marker, 'utf8')); break } catch { await new Promise(resolveWait => setTimeout(resolveWait, 10)) }
  }
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), {
    args: [f.project, '--platform', 'weapp'], session: 'owned-custom',
  })
  assert.deepEqual(f.receipts().map(row => row.kind), ['building'])
  abort.abort()
  const result = await running
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(f.receipts().some(row => row.kind === 'success'), false)
})

test('adapter option parsing keeps custom binary and requires explicit absolute roots', () => {
  assert.throws(() => parseOptions(['--project', 'relative', '--output-root', '/tmp/out']), /absolute/)
  const parsed = parseOptions(['--project', '/tmp/project', '--output-root', '/tmp/out', '--wv-bin', '/tmp/fake.mjs'], {
    WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR: '/tmp/receipt', WEAPP_CONTAINER_SIMULATOR_SESSION_ID: 'session',
  })
  assert.equal(parsed.binary, '/tmp/fake.mjs')
  assert.equal(parsed.receiptRoot, '/tmp/receipt')
  assert.equal(parsed.sessionId, 'session')
  assert.equal(parsed.watchBackend, 'auto')
  assert.equal(parseOptions(['--project', '/tmp/project', '--output-root', '/tmp/out'], {
    WEAPP_CONTAINER_SIMULATOR_WATCH_BACKEND: 'native',
  }).watchBackend, 'native')
  assert.throws(() => parseOptions(['--project', '/tmp/project', '--output-root', '/tmp/out'], {
    WEAPP_CONTAINER_SIMULATOR_WATCH_BACKEND: 'invalid',
  }), /ERR_WATCH_BACKEND/)
})
