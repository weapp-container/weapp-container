/** Managed watcher recovery and terminal process-lifetime regressions. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { CreditReceiptPublisher } from './simulator-source-credit.mjs'
import { runCompilerWatch } from './simulator-watch.mjs'

const RUN = 'managed-watch-regression'
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const WATCH = fileURLToPath(new URL('./simulator-watch.mjs', import.meta.url))

async function fixture(operation) {
  const parent = fs.mkdtempSync(join(tmpdir(), 'source-credit-watch-'))
  const root = join(parent, 'credits'), output = join(parent, 'dist')
  fs.mkdirSync(root)
  fs.mkdirSync(output)
  fs.writeFileSync(join(output, 'app.js'), 'App({})\n')
  const grant = (creditId = 'source-1-1') => {
    const directory = join(root, creditId)
    fs.mkdirSync(directory)
    fs.writeFileSync(join(directory, 'grant.json'), JSON.stringify({
      protocolVersion: '2.0', runId: RUN, creditId,
      limits: { bytes: '1048576', files: 16, directories: 4, depth: 4, pathBytes: 256, fileBytes: '1048576' },
    }))
    return directory
  }
  const value = { parent, root, output, grant,
    publisher: new CreditReceiptPublisher(root, RUN, COMMIT) }
  try { return await operation(value) }
  finally { fs.rmSync(parent, { recursive: true, force: true }) }
}

async function until(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('managed watcher fixture condition timed out')
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
}

function status(value) {
  const path = join(value.root, 'status.json')
  return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : undefined
}

test('capacity recovery and watch ERROR keep one actual controller despite swallowed close failures', { concurrency: false }, async () => {
  await fixture(async value => {
    const abort = new AbortController(), watcher = new EventEmitter()
    let plugin, contexts = 0, closes = 0, retries = 0
    // Model the actual pinned API's allSettled behavior: it resolves even when
    // a watcher close rejects. This interval remains owned by this fixture.
    const retainedTimer = setInterval(() => {}, 1_000)
    const run = runCompilerWatch({
      project: value.parent, outputRoot: value.output, publisher: value.publisher, signal: abort.signal,
      waitForChange: async () => { retries += 1 },
      createCompilerContext: async options => {
        contexts += 1
        plugin = options.inlineConfig.plugins[0]
        return { npmService: { build: async () => {} },
          buildService: { build: async () => { plugin.buildStart(); plugin.closeBundle(); return watcher } },
          watcherService: { closeAll: async () => {
            closes += 1
            await Promise.allSettled([Promise.reject(new Error('actual watcher close failed'))])
          } } }
      },
    })
    // Always observe rejection immediately, even if a preceding assertion fails.
    const settled = run.then(() => ({ ok: true }), error => ({ ok: false, error }))
    try {
      await until(() => status(value)?.kind === 'blocked')
      assert.equal(contexts, 1)
      assert.equal(closes, 0)
      const first = value.grant()
      await until(() => status(value)?.kind === 'success')
      assert.equal(fs.existsSync(join(first, 'result.json')), true)
      assert.equal(contexts, 1)
      assert.equal(closes, 0, 'a capacity grant must not close/recreate the compiler')

      watcher.emit('event', { code: 'ERROR', error: new Error('ordinary watch compilation error') })
      assert.equal(status(value).kind, 'error')
      // A source repair is built by that same watcher, then again waits for a
      // new immutable-output grant. A stale result.json is never reused.
      watcher.emit('event', { code: 'START' })
      plugin.buildStart()
      fs.writeFileSync(join(value.output, 'app.js'), 'App({version:2})\n')
      plugin.closeBundle()
      watcher.emit('event', { code: 'END' })
      assert.equal(status(value).kind, 'blocked')
      const second = value.grant('source-1-2')
      await until(() => status(value)?.kind === 'success')
      assert.match(fs.readFileSync(join(second, 'pack', 'app.js'), 'utf8'), /version:2/)
      assert.equal(contexts, 1)
      assert.equal(closes, 0)
      assert.equal(retries, 0)
      assert.equal(watcher.listenerCount('event'), 1)
      abort.abort()
      const result = await settled
      assert.deepEqual(result, { ok: true })
      assert.equal(contexts, 1)
      assert.equal(closes, 1, 'cleanup is best-effort only on final shutdown')
      assert.equal(watcher.listenerCount('event'), 0)
    } finally {
      abort.abort()
      clearInterval(retainedTimer)
      const result = await settled
      if (!result.ok) throw result.error
    }
  })
})

for (const phase of ['context', 'npm', 'build']) {
  test(`managed initial ${phase} rejection is terminal without a second context or source-change retry`, { concurrency: false }, async () => {
    await fixture(async value => {
      const abort = new AbortController(), failure = new Error(`initial ${phase} failed`)
      let contexts = 0, closes = 0, retries = 0
      try {
        await assert.rejects(runCompilerWatch({
          project: value.parent, outputRoot: value.output, publisher: value.publisher, signal: abort.signal,
          waitForChange: async () => { retries += 1; abort.abort() },
          createCompilerContext: async () => {
            contexts += 1
            if (phase === 'context') throw failure
            return { npmService: { build: async () => { if (phase === 'npm') throw failure } },
              buildService: { build: async () => { throw failure } },
              watcherService: { closeAll: async () => {
                closes += 1
                await Promise.allSettled([Promise.reject(new Error('upstream swallowed close'))])
              } } }
          },
        }), error => error === failure)
        assert.equal(contexts, 1)
        assert.equal(retries, 0)
        assert.equal(closes, phase === 'context' ? 0 : 1)
        assert.equal(status(value).kind, 'error')
        assert.equal(status(value).message, failure.message)
      } finally { abort.abort() }
    })
  })
}

function fakePublicCompiler(value, mode) {
  const directory = join(value.parent, 'fake-weapp-vite'), hooks = join(value.parent, 'empty-hooks')
  fs.mkdirSync(directory)
  fs.mkdirSync(hooks)
  fs.mkdirSync(join(directory, 'bin'))
  fs.writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: 'weapp-vite', type: 'module', exports: { '.': { import: './index.mjs' } },
  }))
  fs.writeFileSync(join(directory, 'bin', 'wv.mjs'), '// Discovery only; the adapter uses the public API.\n')
  fs.writeFileSync(join(directory, 'index.mjs'), `
import { EventEmitter } from 'node:events'
export async function createCompilerContext(options) {
  setInterval(() => {}, 1000) // Deliberately retained by the fake failed-close API.
  const plugin = options.inlineConfig.plugins[0]
  return {
    npmService: { build: async () => { ${mode === 'initial-npm' ? "throw new Error('injected initial npm failure')" : ''} } },
    buildService: { build: async () => {
      plugin.buildStart()
      plugin.closeBundle()
      return new EventEmitter()
    } },
    watcherService: { closeAll: async () => {
      await Promise.allSettled([Promise.reject(new Error('fake actual watcher still live'))])
    } },
  }
}
`)
  // This temporary repository makes public package provenance discovery real;
  // it is an isolated fake compiler, not a pinned upstream/compiler conformance
  // claim. No hooks or global Git settings are used.
  const git = args => execFileSync('git', args, { cwd: directory, timeout: 3_000, maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '--quiet'])
  git(['add', 'package.json', 'index.mjs', 'bin/wv.mjs'])
  git(['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Simulator Fixture', '-c', 'user.email=simulator@example.invalid',
    'commit', '--quiet', '-m', 'isolated public compiler fixture'])
  return join(directory, 'bin', 'wv.mjs')
}

async function managedCli(value, binary, operation) {
  const child = spawn(process.execPath, [WATCH, '--project', value.parent, '--wv-bin', binary,
    '--output-root', value.output], { cwd: value.parent, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WEAPP_CONTAINER_SIMULATOR_SOURCE_CREDIT_DIR: value.root,
      WEAPP_CONTAINER_SIMULATOR_SESSION_ID: RUN } })
  let closed = false, stderr = '', overflow = false
  child.stdout.resume()
  child.stderr.on('data', bytes => {
    if (Buffer.byteLength(stderr) + bytes.length > 64 * 1024) overflow = true
    else stderr += bytes.toString('utf8')
  })
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { closed = true; resolveExit({ code, signal }) })
  })
  // Register an observer before any timeout/operation can throw.
  const settled = exit.then(result => ({ result }), error => ({ error }))
  const boundedExit = async milliseconds => {
    let timer
    try {
      const outcome = await Promise.race([settled,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('managed CLI exit timed out')), milliseconds) })])
      if (outcome.error) throw outcome.error
      return outcome.result
    } finally { clearTimeout(timer) }
  }
  try {
    const result = await boundedExit(5_000)
    assert.equal(overflow, false, 'terminal diagnostics must stay bounded')
    return await operation({ ...result, stderr })
  } finally {
    // This fixture API never spawns descendants. Kill and reap only the exact
    // child created above when its deliberate keepalive defeats exitCode-only
    // implementations; never signal unrelated processes or use kill-all.
    if (!closed && child.pid !== undefined) {
      child.kill('SIGKILL')
      await boundedExit(3_000)
    }
  }
}

for (const mode of ['terminal-publication', 'initial-npm']) {
  test(`managed CLI ${mode} exits its real leader despite swallowed close and a live timer`, { concurrency: false }, async () => {
    await fixture(async value => {
      const directory = value.grant(), binary = fakePublicCompiler(value, mode)
      if (mode === 'terminal-publication') fs.mkdirSync(join(directory, '.result.json.next'))
      await managedCli(value, binary, result => {
        assert.equal(result.code, 1)
        assert.equal(result.signal, null, 'the wrapper must exit without fixture termination')
        assert.equal(fs.existsSync(join(directory, 'result.json')), false)
        if (mode === 'terminal-publication') {
          assert.match(result.stderr, /ERR_SOURCE_CREDIT_CONTROL/)
          assert.match(result.stderr, /credit-result/)
          assert.equal(fs.existsSync(join(directory, 'claimed.json')), true)
        } else {
          assert.match(result.stderr, /injected initial npm failure/)
          assert.equal(fs.existsSync(join(directory, 'grant.json')), true)
          assert.equal(fs.existsSync(join(directory, 'claimed.json')), false)
          assert.equal(status(value).kind, 'error')
        }
      })
    })
  })
}
