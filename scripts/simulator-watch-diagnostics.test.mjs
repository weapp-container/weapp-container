import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { BoundedDiagnosticWriter, createWatchIngressDiagnostics } from './simulator-watch-diagnostics.mjs'
import { CreditReceiptPublisher } from './simulator-source-credit.mjs'
import { ReceiptPublisher, parseOptions, resolveWatchBackend, runCompilerWatch } from './simulator-watch.mjs'

const tick = () => new Promise(resolveTick => setImmediate(resolveTick))
const identity = { session: 'a'.repeat(64), compilerSession: 'b'.repeat(64), contextAttempt: '1' }
const hash = value => createHash('sha256').update(value).digest('hex')
const source = { event: 'change', pathSha256: 'c'.repeat(64), extension: '.js' }

function memorySink() {
  const value = { lines: [], statuses: [], closes: 0, opens: 0 }
  value.factory = async () => {
    value.opens += 1
    return { append: async line => { value.lines.push(line) }, close: async () => { value.closes += 1 }, status: async line => { value.statuses.push(line) } }
  }
  value.records = () => value.lines.map(line => JSON.parse(line))
  return value
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'watch-diagnostics-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = resolve(root, 'project'), outputRoot = resolve(project, 'dist')
  const receiptRoot = resolve(root, 'receipts'), directory = resolve(root, 'diagnostics')
  mkdirSync(outputRoot, { recursive: true })
  return { root, project, outputRoot, receiptRoot, directory, sessionId: 'fixture-session', contextAttempt: 1 }
}

test('strict diagnostic records reject raw payloads, unsafe identities and getters', async () => {
  const sink = memorySink(), writer = new BoundedDiagnosticWriter({ directory: '/unused', identity, sinkFactory: sink.factory })
  const marker = 'weapp-container://connect?token=RAW_PRIVATE_VALUE'
  let getters = 0
  const getter = { get raw() { getters += 1; return marker } }
  assert.equal(writer.enqueue('uncontrolled-event', { raw: marker }), false)
  assert.equal(writer.enqueue('source.all', { ...source, raw: marker }), false)
  assert.equal(writer.enqueue('source.all', getter), false)
  assert.equal(writer.enqueue('source.all', { ...source, pathSha256: marker }), false)
  assert.equal(writer.enqueue('source.error', { code: marker }), false)
  assert.equal(writer.enqueue('source.all', new Proxy({}, { ownKeys() { throw new Error(marker) } })), false)
  assert.equal(getters, 0)
  assert.throws(() => new BoundedDiagnosticWriter({ directory: '/unused', identity: { ...identity, session: marker } }), /IDENTITY/)
  const state = await writer.close({ raw: marker })
  assert.equal(state.complete, false)
  assert.equal(JSON.stringify(sink).includes(marker), false)
  assert.equal(sink.records().at(-1).kind, 'trace.stop')
  assert.equal(state.dropped.invalid, '7')
})

test('queue budget is bounded before any async sink opens and terminal loss is explicit', async () => {
  const sink = memorySink()
  const writer = new BoundedDiagnosticWriter({ directory: '/unused', identity, sinkFactory: sink.factory, maxQueue: 1 })
  assert.equal(writer.enqueue('source.all', source), true)
  assert.equal(sink.opens, 0, 'no I/O inside enqueue')
  assert.equal(writer.enqueue('source.all', source), false)
  const firstClose = writer.close(), secondClose = writer.close()
  assert.equal(firstClose, secondClose)
  const state = await firstClose
  assert.equal(state.dropped.queue, '1')
  assert.equal(state.complete, false)
  assert.equal(sink.closes, 1)
  assert.equal(sink.records().at(-1).traceState.dropped.queue, '1')
  assert.equal(JSON.parse(sink.statuses[0]).state.complete, false)
})

test('file entry and byte budgets include in-flight writes and reserve terminal space', async () => {
  for (const limits of [{ maxEntries: 3 }, { maxBytes: 2048, maxRecordBytes: 1024 }]) {
    const sink = memorySink()
    let release
    const hold = new Promise(resolveHold => { release = resolveHold })
    const factory = async () => {
      const real = await sink.factory()
      return { ...real, append: async line => { await hold; await real.append(line) } }
    }
    const writer = new BoundedDiagnosticWriter({ directory: '/unused', identity, sinkFactory: factory, ...limits })
    writer.enqueue('source.all', source)
    await tick()
    for (let i = 0; i < 20; i += 1) writer.enqueue('source.all', source)
    release()
    const state = await writer.close()
    assert.ok(BigInt(state.dropped.file) > 0n)
    assert.equal(sink.records().at(-1).kind, 'trace.stop')
    assert.ok(Buffer.byteLength(sink.lines.join('')) <= (limits.maxBytes ?? 4 * 1024 * 1024))
    assert.ok(sink.lines.length <= (limits.maxEntries ?? 20_000))
  }
})

test('throwing open, append, close, status and failure callbacks never escape diagnostics', async () => {
  for (const failure of ['open', 'append', 'close', 'status']) {
    const stateEvents = [], sink = memorySink()
    const factory = async () => {
      if (failure === 'open') { sink.opens += 1; throw new Error('PRIVATE_RAW_ERROR /secret/file weapp-container://token') }
      const actual = await sink.factory()
      return Object.fromEntries(Object.entries(actual).map(([key, fn]) => [key, async (...args) => {
        if (key === failure) throw new Error('PRIVATE_RAW_ERROR /secret/file weapp-container://token')
        return fn(...args)
      }]))
    }
    const writer = new BoundedDiagnosticWriter({ directory: '/unused', identity, sinkFactory: factory,
      onFailure(state) { stateEvents.push(state); throw new Error('throwing diagnostic callback') } })
    writer.enqueue('source.all', source)
    const state = await writer.close()
    assert.equal(state.phase, 'closed')
    assert.equal(state.complete, false)
    assert.equal(state.writeFailure, 'ERR_DIAGNOSTICS_IO')
    assert.equal(sink.opens, 1, 'never reopen/retry an uncertain sink')
    assert.ok(stateEvents.length >= 1)
    assert.equal(JSON.stringify({ state, lines: sink.lines, stateEvents }).includes('PRIVATE_RAW_ERROR'), false)
  }
})

test('serve hooks reuse existing watcher, preserve modules/read, filter paths and sanitize errors/options', async t => {
  const f = fixture(t), sink = memorySink(), watcher = new EventEmitter()
  const other = () => {}
  watcher.on('all', other)
  watcher.on('error', other)
  watcher.options = { usePolling: false, interval: 100, binaryInterval: 300, ignored: ['/secret/output'], privateToken: 'PRIVATE_RAW' }
  watcher.add = () => assert.fail('must never add watcher roots')
  watcher.close = () => assert.fail('must never close shared watcher')
  const diagnostic = createWatchIngressDiagnostics({ ...f, sinkFactory: sink.factory })
  assert.equal(diagnostic.pre.apply, 'serve'); assert.equal(diagnostic.pre.enforce, 'pre')
  assert.equal(diagnostic.post.apply, 'serve'); assert.equal(diagnostic.post.enforce, 'post')
  assert.equal(diagnostic.pre.configureServer({ watcher, config: { server: { watch: { usePolling: false, ignored: 'PRIVATE_RAW' } } } }), undefined)
  const file = resolve(f.project, 'private-name.js')
  watcher.emit('all', 'change', file)
  diagnostic.pre.watchChange(file, { event: 'update' })
  let reads = 0
  const modules = [{ id: 'PRIVATE_RAW_MODULE' }]
  const update = { file, type: 'update', modules, async read() { reads += 1; assert.fail('must not read source') } }
  assert.equal(diagnostic.pre.hotUpdate(update), undefined)
  assert.equal(diagnostic.post.hotUpdate(update), undefined)
  assert.equal(update.modules, modules); assert.equal(reads, 0)
  watcher.emit('all', 'change', resolve(f.outputRoot, 'chunk.js'))
  watcher.emit('all', 'change', resolve(f.project, 'node_modules/package/index.js'))
  watcher.emit('all', 'change', resolve(f.project, '.tmp-app.js'))
  watcher.emit('all', 'change', resolve(f.project, 'app.js.tmp-operation'))
  watcher.emit('all', 'change', resolve(f.root, 'outside.js'))
  watcher.emit('all', 'change', 'weapp-container://connect?token=PRIVATE_RAW')
  watcher.emit('error', new Error('PRIVATE_RAW /secret/error weapp-container://connect?token=raw'))
  assert.equal(diagnostic.build('buildEnd', { error: new Error('PRIVATE_RAW') }), false)
  assert.equal(diagnostic.build('buildEnd', { raw: 'PRIVATE_RAW' }), false)
  const state = await diagnostic.dispose()
  assert.equal(watcher.listenerCount('all'), 1); assert.equal(watcher.listenerCount('error'), 1)
  assert.equal(watcher.listeners('all')[0], other)
  const records = sink.records(), all = records.find(row => row.kind === 'source.all')
  assert.equal(all.pathSha256, hash('private-name.js')); assert.equal(all.extension, '.js')
  assert.deepEqual(records.filter(row => row.kind.startsWith('source.')).map(row => row.kind), ['source.all', 'source.watchChange', 'source.hotUpdate.pre', 'source.hotUpdate.post', 'source.error'])
  assert.deepEqual(records.find(row => row.kind === 'watcher.configure').resolvedOptions, { usePolling: false, interval: 100, binaryInterval: 300 })
  assert.deepEqual(records.at(-1).filtered, { output: '1', outside: '1', ignored: '3', invalid: '1' })
  assert.equal(state.complete, false, 'rejected raw payload is explicit loss')
  const raw = sink.lines.join('')
  for (const marker of [f.project, 'private-name.js', 'PRIVATE_RAW', 'weapp-container://', '/secret/', 'ignored']) {
    if (marker !== 'ignored') assert.equal(raw.includes(marker), false)
  }
  assert.equal(records[0].session, hash(f.sessionId))
  assert.equal(records[0].contextAttempt, '1')
  assert.ok(records.every(row => typeof row.sequence === 'string' && /^\d+$/.test(row.sequence) && /^\d+$/.test(row.monotonicNs)))
})

test('one-second heartbeat uses local monotonic lag and clears only its own timer', async t => {
  const f = fixture(t), sink = memorySink()
  let now = 0n, callback, cleared = 0
  const timer = { unref() {} }
  const diagnostic = createWatchIngressDiagnostics({ ...f, sinkFactory: sink.factory, mono: () => now,
    setTimer(fn, interval) { assert.equal(interval, 1000); callback = fn; return timer },
    clearTimer(value) { assert.equal(value, timer); cleared += 1 } })
  now = 1_050_000_000n; callback()
  await diagnostic.dispose()
  callback()
  assert.equal(cleared, 1)
  const rows = sink.records().filter(row => row.kind === 'eventLoop.heartbeat')
  assert.equal(rows.length, 1); assert.equal(rows[0].lagNs, '50000000')
  assert.equal(sink.records().at(-1).causalJoin, 'none')
})

test('diagnostics are opt-in, reject credit/output/project overlap and unsafe symlink writes', async t => {
  const f = fixture(t), failures = []
  assert.equal(createWatchIngressDiagnostics({ ...f, directory: undefined }), undefined)
  for (const directory of [f.project, resolve(f.project, 'diagnostics'), f.outputRoot, f.receiptRoot, resolve(f.receiptRoot, 'diagnostics')]) {
    assert.equal(createWatchIngressDiagnostics({ ...f, directory, onFailure: state => failures.push(state) }), undefined)
  }
  assert.equal(failures.length, 5)
  assert.equal(failures.every(row => row.writeFailure === 'ERR_DIAGNOSTICS_CONFIG'), true)
  mkdirSync(f.receiptRoot)
  const alias = resolve(f.root, 'alias')
  symlinkSync(f.receiptRoot, alias)
  const diagnostic = createWatchIngressDiagnostics({ ...f, directory: resolve(alias, 'diagnostics'), onFailure: state => failures.push(state) })
  await diagnostic.dispose()
  assert.equal(diagnostic.state().complete, false)
  assert.deepEqual(readdirSync(f.receiptRoot), [], 'symlink ancestor refused before mkdir adds a credit-root entry')
  const parsed = parseOptions(['--project', f.project, '--output-root', f.outputRoot], { WEAPP_CONTAINER_SIMULATOR_WATCH_DIAGNOSTICS: f.directory })
  assert.equal(parsed.diagnosticsRoot, f.directory)
})

test('only existing build controller completion publishes; source receipts have no authority', async t => {
  const f = fixture(t), publisher = new ReceiptPublisher(f.receiptRoot, f.sessionId)
  const abort = new AbortController(), graph = new EventEmitter(), builds = new EventEmitter()
  graph.options = { usePolling: false }
  let pre, post, controller, contexts = 0, closes = 0
  const running = runCompilerWatch({ ...f, diagnosticsRoot: f.directory, publisher, signal: abort.signal,
    async createCompilerContext(options) {
      contexts += 1
      ;[pre, post, controller] = options.inlineConfig.plugins
      assert.deepEqual(options.inlineConfig.server.watch, resolveWatchBackend().options)
      assert.deepEqual(options.inlineConfig.build.watch.chokidar, options.inlineConfig.server.watch)
      pre.configureServer({ watcher: graph, config: {} })
      return { npmService: { async build() {} }, buildService: { async build() {
        controller.buildStart(); writeFileSync(resolve(f.outputRoot, 'app.js'), 'App({})'); return builds
      } }, watcherService: { async closeAll() { closes += 1 } } }
    } })
  const settled = running.then(() => undefined, error => error)
  t.after(async () => { abort.abort(); await settled })
  await tick()
  const receipts = () => readdirSync(publisher.receipts).map(name => JSON.parse(readFileSync(resolve(publisher.receipts, name), 'utf8')))
  const path = resolve(f.project, 'app.js')
  graph.emit('all', 'change', path); pre.watchChange(path, { event: 'update' })
  const update = { file: path, type: 'update', modules: [], read() { assert.fail('read called') } }
  pre.hotUpdate(update); post.hotUpdate(update)
  await tick()
  assert.equal(receipts().some(row => row.kind === 'success'), false)
  controller.buildEnd(); controller.closeBundle()
  assert.equal(receipts().some(row => row.kind === 'success'), false)
  builds.emit('event', { code: 'END' })
  assert.equal(receipts().filter(row => row.kind === 'success').length, 1)
  abort.abort(); assert.equal(await settled, undefined)
  assert.equal(contexts, 1); assert.equal(closes, 1)
  assert.equal(graph.listenerCount('all'), 0); assert.equal(graph.listenerCount('error'), 0); assert.equal(builds.listenerCount('event'), 0)
  const trace = readdirSync(f.directory).find(name => name.endsWith('.jsonl'))
  const rows = readFileSync(resolve(f.directory, trace), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(rows.some(row => row.kind === 'build.publication' && row.published && row.receiptSequence === '2'), true)
  assert.equal(rows.some(row => row.kind === 'build.watcherEvent' && row.code === 'END'), true)
  assert.equal(rows.at(-1).kind, 'trace.stop')
})

test('abort during context creation disposes observers before late configureServer and context completion', async t => {
  const f = fixture(t), publisher = new ReceiptPublisher(f.receiptRoot, f.sessionId)
  const abort = new AbortController(), graph = new EventEmitter()
  let pre, release, closes = 0, contexts = 0
  const blocked = new Promise(resolveBlocked => { release = resolveBlocked })
  const running = runCompilerWatch({ ...f, diagnosticsRoot: f.directory, publisher, signal: abort.signal,
    async createCompilerContext(options) {
      contexts += 1; pre = options.inlineConfig.plugins[0]
      await blocked
      return { npmService: { build() { assert.fail('npm after abort') } }, watcherService: { async closeAll() { closes += 1 } } }
    } })
  const settled = running.then(() => undefined, error => error)
  t.after(async () => { abort.abort(); release(); await settled })
  await tick(); abort.abort(); await tick()
  pre.configureServer({ watcher: graph })
  assert.equal(graph.listenerCount('all'), 0); assert.equal(graph.listenerCount('error'), 0)
  release(); assert.equal(await settled, undefined)
  assert.equal(contexts, 1); assert.equal(closes, 1)
  const count = readdirSync(f.directory).length
  pre.configureServer({ watcher: graph }); await tick()
  assert.equal(readdirSync(f.directory).length, count)
})

test('enabled managed diagnostics add no credit-root entry and retain one compiler through ordinary ERROR', async t => {
  const f = fixture(t), abort = new AbortController(), graph = new EventEmitter(), watcher = new EventEmitter()
  mkdirSync(f.receiptRoot)
  const slot = resolve(f.receiptRoot, 'source-1-1')
  mkdirSync(slot)
  writeFileSync(resolve(slot, 'grant.json'), JSON.stringify({ protocolVersion: '2.0', runId: f.sessionId, creditId: 'source-1-1',
    limits: { bytes: '1048576', files: 16, directories: 4, depth: 4, pathBytes: 256, fileBytes: '1048576' } }))
  const publisher = new CreditReceiptPublisher(f.receiptRoot, f.sessionId, '0'.repeat(40))
  let contexts = 0, retries = 0, closes = 0
  const run = runCompilerWatch({ ...f, diagnosticsRoot: f.directory, publisher, signal: abort.signal,
    async waitForChange() { retries += 1; assert.fail('diagnostics cannot retry managed context') },
    async createCompilerContext(options) {
      contexts += 1
      const [pre, , plugin] = options.inlineConfig.plugins
      pre.configureServer({ watcher: graph })
      return { npmService: { async build() {} }, buildService: { async build() {
        plugin.buildStart(); writeFileSync(resolve(f.outputRoot, 'app.js'), 'App({})'); plugin.closeBundle(); return watcher
      } }, watcherService: { async closeAll() { closes += 1 } } }
    } })
  const settled = run.then(() => null, error => error)
  t.after(async () => { abort.abort(); await settled })
  await tick()
  assert.equal(JSON.parse(readFileSync(resolve(f.receiptRoot, 'status.json'), 'utf8')).kind, 'success')
  const creditEntries = readdirSync(f.receiptRoot).sort()
  assert.deepEqual(creditEntries, ['source-1-1', 'status.json'])
  graph.emit('all', 'change', resolve(f.project, 'app.js'))
  watcher.emit('event', { code: 'ERROR', error: new Error('ordinary existing compiler failure') })
  await tick()
  assert.equal(contexts, 1); assert.equal(closes, 0); assert.equal(retries, 0)
  assert.deepEqual(readdirSync(f.receiptRoot).sort(), creditEntries)
  abort.abort(); assert.equal(await settled, null)
  assert.equal(closes, 1)
  assert.equal(graph.listenerCount('all'), 0); assert.equal(graph.listenerCount('error'), 0)
  assert.equal(watcher.listenerCount('event'), 0)
  assert.deepEqual(readdirSync(f.receiptRoot).sort(), creditEntries)
})

test('failed initialization, fatal receipt and listener-removal faults clean owned diagnostics', async t => {
  for (const mode of ['initial', 'fatal']) {
    const f = fixture(t), abort = new AbortController(), graph = new EventEmitter()
    mkdirSync(f.receiptRoot)
    const publisher = new CreditReceiptPublisher(f.receiptRoot, f.sessionId, '0'.repeat(40))
    let contexts = 0, pre
    const failed = new Error('authoritative original failure')
    const run = runCompilerWatch({ ...f, diagnosticsRoot: f.directory, publisher, signal: abort.signal,
      async createCompilerContext(options) {
        contexts += 1; pre = options.inlineConfig.plugins[0]; pre.configureServer({ watcher: graph })
        if (mode === 'initial') throw failed
        // Fault the real existing publisher's owned fixture status path. No
        // override of fatalError, diagnostic receipt or changed failure policy.
        rmSync(resolve(f.receiptRoot, 'status.json'))
        mkdirSync(resolve(f.receiptRoot, 'status.json'))
        publisher.emit('building')
        return { npmService: { build() { assert.fail('npm after real fatal receipt') } }, watcherService: { async closeAll() {} } }
      } })
    const result = await run.then(() => null, error => error)
    assert.equal(result, mode === 'initial' ? failed : publisher.fatalError)
    if (mode === 'fatal') assert.equal(result.code, 'ERR_SOURCE_CREDIT_CONTROL')
    assert.equal(contexts, 1)
    assert.equal(graph.listenerCount('all'), 0); assert.equal(graph.listenerCount('error'), 0)
    pre.configureServer({ watcher: graph }); assert.equal(graph.listenerCount('all'), 0)
    assert.ok(readdirSync(f.receiptRoot).every(name => !name.startsWith('watch-ingress-')))
    abort.abort()
  }
  const f = fixture(t), sink = memorySink(), graph = new EventEmitter(), diagnostic = createWatchIngressDiagnostics({ ...f, sinkFactory: sink.factory })
  diagnostic.pre.configureServer({ watcher: graph })
  const originalOff = graph.off
  graph.off = () => { throw new Error('PRIVATE_RAW_REMOVAL_ERROR') }
  const state = await diagnostic.dispose()
  assert.equal(state.complete, false)
  assert.equal(sink.records().at(-1).listenerRemovalFailures, '2')
  graph.off = originalOff
  // Exact functions recorded by this fixture, never broad cleanup of another owner.
  for (const event of ['all', 'error']) for (const listener of graph.listeners(event)) graph.off(event, listener)
})

test('failed lifetime bookkeeping creates no diagnostics resource before its finally scope exists', async t => {
  const f = fixture(t), abort = new AbortController(), failure = new Error('original fatal waiter rejection')
  const publisher = { root: f.receiptRoot, sessionId: f.sessionId, fatalWait() { throw failure } }
  await assert.rejects(runCompilerWatch({ ...f, diagnosticsRoot: f.directory, publisher, signal: abort.signal,
    createCompilerContext() { assert.fail('context must not start') } }), error => error === failure)
  assert.equal(readdirSync(f.root).includes('diagnostics'), false)
})
