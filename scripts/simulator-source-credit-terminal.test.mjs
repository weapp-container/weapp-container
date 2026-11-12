/** Terminal protocol and compiler-context failure regressions. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { CreditReceiptPublisher, SourceCreditFatalError } from './simulator-source-credit.mjs'
import { runCompilerWatch } from './simulator-watch.mjs'

const RUN = 'terminal-regression'
const COMMIT = '0123456789abcdef0123456789abcdef01234567'

async function fixture(operation) {
  const parent = fs.mkdtempSync(join(tmpdir(), 'source-credit-terminal-'))
  const root = join(parent, 'credits'), output = join(parent, 'dist')
  const creditId = 'source-1-1', directory = join(root, creditId)
  fs.mkdirSync(directory, { recursive: true })
  fs.mkdirSync(output)
  fs.writeFileSync(join(output, 'app.js'), 'App({})\n')
  fs.writeFileSync(join(directory, 'grant.json'), JSON.stringify({
    protocolVersion: '2.0', runId: RUN, creditId,
    limits: { bytes: '1048576', files: 16, directories: 4, depth: 4, pathBytes: 256, fileBytes: '1048576' },
  }))
  const value = { parent, root, output, directory, creditId,
    publisher: new CreditReceiptPublisher(root, RUN, COMMIT) }
  try { return await operation(value) }
  finally { fs.rmSync(parent, { recursive: true, force: true }) }
}

// No production filesystem hooks are added. These tests run serially and
// temporarily replace Node's builtin bindings only during this scoped await.
// The parent cleanup hook reads an actual published result and deletes the
// actual namespace synchronously before the helper's next root-status write.
let hooksActive = false
async function filesystemFaults(value, options, operation) {
  assert.equal(hooksActive, false, 'filesystem fault scope must be exclusive')
  hooksActive = true
  const original = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync,
    mkdirSync: fs.mkdirSync, openSync: fs.openSync, closeSync: fs.closeSync, opendirSync: fs.opendirSync }
  const retainedControlFds = new Set(), retainedDirectories = []
  const evidence = { terminals: [], writesAfterTerminal: [], resultAttempts: 0,
    rootAttempts: 0, terminal: false, controlCloseAttempts: 0, enumeratorCloseAttempts: 0,
    retainedControlFds, retainedDirectories }
  const underCredit = path => typeof path === 'string'
    && (resolve(path) === value.directory || resolve(path).startsWith(`${value.directory}${sep}`))
  const record = (op, path) => {
    if (evidence.terminal && underCredit(path)) evidence.writesAfterTerminal.push({ op, path })
  }
  fs.writeFileSync = (path, bytes, ...rest) => {
    record('writeFileSync', path)
    if (path === join(value.directory, '.result.json.next')) {
      evidence.resultAttempts += 1
      if (options.beforeTerminalError) throw options.beforeTerminalError
    }
    if (path === join(value.root, '.status.json.next')) {
      evidence.rootAttempts += 1
      const status = JSON.parse(Buffer.from(bytes).toString('utf8'))
      if (options.rootError && (options.rootKinds ?? ['success']).includes(status.kind)) throw options.rootError
    }
    return original.writeFileSync(path, bytes, ...rest)
  }
  fs.renameSync = (from, to) => {
    record('renameSync', from)
    record('renameSync', to)
    const result = original.renameSync(from, to)
    if (to === join(value.directory, 'result.json')) {
      evidence.terminals.push(JSON.parse(fs.readFileSync(to, 'utf8')))
      evidence.terminal = true
      if (options.parentCleanup) fs.rmSync(value.directory, { recursive: true })
      // Models an ambiguous terminal-publication failure: the parent may have
      // observed the ack even if the writer receives an error at this boundary.
      if (options.afterTerminalError) throw options.afterTerminalError
    }
    return result
  }
  fs.mkdirSync = (path, ...rest) => { record('mkdirSync', path); return original.mkdirSync(path, ...rest) }
  fs.openSync = (path, flags, ...rest) => {
    if (typeof flags === 'string' && /[wa+]/.test(flags)) record('openSync', path)
    const fd = original.openSync(path, flags, ...rest)
    if (options.controlCloseError && path === join(value.directory, 'grant.json')) retainedControlFds.add(fd)
    return fd
  }
  fs.closeSync = fd => {
    if (retainedControlFds.has(fd)) {
      evidence.controlCloseAttempts += 1
      throw options.controlCloseError // Known open: injected BEFORE OS close.
    }
    return original.closeSync(fd)
  }
  fs.opendirSync = (path, ...rest) => {
    const directory = original.opendirSync(path, ...rest)
    if (options.enumeratorCloseError && path === value.root) {
      retainedDirectories.push({ directory, close: directory.closeSync.bind(directory) })
      directory.closeSync = () => {
        evidence.enumeratorCloseAttempts += 1
        throw options.enumeratorCloseError // Known open: fixture retains it.
      }
    }
    return directory
  }
  syncBuiltinESMExports()
  try { return await operation(evidence) }
  finally {
    Object.assign(fs, original)
    syncBuiltinESMExports()
    hooksActive = false
    const cleanupErrors = []
    for (const fd of retainedControlFds) {
      try { original.closeSync(fd) }
      catch (error) { cleanupErrors.push(error) }
    }
    for (const handle of retainedDirectories) {
      try { handle.close() }
      catch (error) { cleanupErrors.push(error) }
    }
    if (cleanupErrors.length !== 0) throw new AggregateError(cleanupErrors, 'terminal handle fixture cleanup failed')
  }
}

const fault = message => Object.assign(new Error(message), { code: 'EIO' })

test('success ack stays terminal when parent deletes namespace before root status fails', { concurrency: false }, async () => {
  await fixture(value => filesystemFaults(value, {
    parentCleanup: true, rootError: fault('root status device failure'),
  }, async evidence => {
    const waiter = value.publisher.fatalWait()
    const result = value.publisher.success(value.output)
    assert.equal(result.published, false)
    assert.ok(result.fatal instanceof SourceCreditFatalError)
    assert.equal(result.fatal.phase, 'root-status')
    assert.equal(result.fatal.cause.message, 'root status device failure')
    assert.deepEqual(result.fatal.terminal, { creditId: value.creditId, kind: 'success', writerDone: true })
    assert.equal(await waiter.promise, result.fatal)
    assert.equal(evidence.terminals.length, 1)
    assert.equal(evidence.terminals[0].kind, 'success')
    assert.equal(evidence.terminals[0].writerDone, true)
    assert.equal(fs.existsSync(value.directory), false)
    const rootAttempts = evidence.rootAttempts
    assert.equal(value.publisher.emit('error', { message: 'secondary build failure' }).fatal, result.fatal)
    assert.equal(value.publisher.success(value.output).fatal, result.fatal)
    assert.equal(evidence.resultAttempts, 1)
    assert.equal(evidence.rootAttempts, rootAttempts)
    assert.deepEqual(evidence.writesAfterTerminal, [])
  }))
})

test('copy error ack is terminal and later root diagnostic failure never rewrites it', { concurrency: false }, async () => {
  const rootError = fault('root error status failed')
  await fixture(value => filesystemFaults(value, {
    parentCleanup: true, rootError, rootKinds: ['error'],
  }, evidence => {
    let copyError
    try { value.publisher.success(join(value.parent, 'missing-output')) }
    catch (error) { copyError = error }
    assert.equal(copyError?.code, 'ENOENT')
    assert.equal(evidence.terminals.length, 1)
    assert.equal(evidence.terminals[0].kind, 'error')
    assert.equal(evidence.terminals[0].writerDone, true)
    const result = value.publisher.emit('error', { message: copyError.message })
    assert.equal(result.fatal.phase, 'root-status')
    assert.equal(result.fatal.cause, rootError)
    assert.equal(value.publisher.success(value.output).fatal, result.fatal)
    assert.equal(fs.existsSync(value.directory), false)
    assert.equal(evidence.resultAttempts, 1)
    assert.deepEqual(evidence.writesAfterTerminal, [])
  }))
})

test('ambiguous result rename failure seals the claim even if parent already observed it', { concurrency: false }, async () => {
  const terminalError = fault('terminal rename outcome uncertain')
  await fixture(value => filesystemFaults(value, {
    parentCleanup: true, afterTerminalError: terminalError,
  }, evidence => {
    const result = value.publisher.success(value.output)
    assert.equal(result.fatal.phase, 'credit-result')
    assert.equal(result.fatal.cause, terminalError)
    assert.equal(result.fatal.terminal.publication, 'unconfirmed')
    assert.equal(evidence.terminals.length, 1)
    assert.equal(evidence.terminals[0].kind, 'success')
    assert.equal(value.publisher.emit('error', { message: 'retry forbidden' }).fatal, result.fatal)
    assert.equal(evidence.resultAttempts, 1)
    assert.equal(evidence.rootAttempts, 0)
    assert.deepEqual(evidence.writesAfterTerminal, [])
    assert.equal(fs.existsSync(value.directory), false)
  }))
})

test('failed terminal write retains claimed namespace without a synthetic error ack', { concurrency: false }, async () => {
  const terminalError = fault('terminal disk full')
  await fixture(value => filesystemFaults(value, { beforeTerminalError: terminalError }, evidence => {
    const result = value.publisher.success(value.output)
    assert.equal(result.fatal.phase, 'credit-result')
    assert.equal(result.fatal.cause, terminalError)
    assert.equal(fs.existsSync(join(value.directory, 'claimed.json')), true)
    assert.equal(fs.existsSync(join(value.directory, 'pack', 'app.js')), true)
    assert.equal(fs.existsSync(join(value.directory, 'result.json')), false)
    assert.equal(value.publisher.success(value.output).fatal, result.fatal)
    assert.equal(value.publisher.emit('error', { message: 'must not retry' }).fatal, result.fatal)
    assert.equal(evidence.resultAttempts, 1)
    assert.equal(evidence.rootAttempts, 0)
  }))
})

test('ordinary success publishes one result and one matching status', { concurrency: false }, async () => {
  await fixture(value => filesystemFaults(value, {}, evidence => {
    assert.deepEqual(value.publisher.success(value.output), { published: true })
    const status = JSON.parse(fs.readFileSync(join(value.root, 'status.json'), 'utf8'))
    assert.equal(status.kind, 'success')
    assert.equal(status.sequence, evidence.terminals[0].sequence)
    assert.equal(status.creditId, value.creditId)
    assert.equal(evidence.resultAttempts, 1)
    assert.equal(evidence.rootAttempts, 1)
    assert.deepEqual(evidence.writesAfterTerminal, [])
  }))
})

test('source-credit status uses versioned bounded shapes and decimal sequences for every kind', { concurrency: false }, async () => {
  await fixture(value => {
    const readStatus = () => JSON.parse(fs.readFileSync(join(value.root, 'status.json'), 'utf8'))
    value.publisher.emit('building')
    assert.deepEqual(readStatus(), { protocolVersion: '2.0', runId: RUN, sequence: '1', kind: 'building' })
    assert.deepEqual(value.publisher.success(value.output), { published: true })
    assert.deepEqual(readStatus(), { protocolVersion: '2.0', runId: RUN, sequence: '2', kind: 'success',
      creditId: value.creditId, compilerCommit: COMMIT })
    const ack = JSON.parse(fs.readFileSync(join(value.directory, 'result.json'), 'utf8'))
    assert.equal(ack.protocolVersion, '2.0')
    assert.equal(ack.runId, RUN)
    assert.equal(ack.sequence, '2')
    assert.equal(ack.writerDone, true)
    value.publisher.emit('error', { message: 'ordinary compiler error' })
    assert.deepEqual(readStatus(), { protocolVersion: '2.0', runId: RUN, sequence: '3', kind: 'error',
      message: 'ordinary compiler error' })
    assert.deepEqual(value.publisher.success(value.output), { published: false })
    assert.deepEqual(readStatus(), { protocolVersion: '2.0', runId: RUN, sequence: '4', kind: 'blocked',
      message: 'source snapshot capacity is occupied' })
    assert.deepEqual(JSON.parse(fs.readFileSync(join(value.directory, 'result.json'), 'utf8')), ack)
  })
})

test('copy failure followed by terminal failure does not attempt another terminal result', { concurrency: false }, async () => {
  const terminalError = fault('error ack write failed')
  await fixture(value => filesystemFaults(value, { beforeTerminalError: terminalError }, evidence => {
    const result = value.publisher.success(join(value.parent, 'missing-output'))
    assert.equal(result.fatal.phase, 'credit-result')
    assert.equal(result.fatal.cause, terminalError)
    assert.equal(result.fatal.terminal.kind, 'error')
    assert.equal(result.fatal.terminal.publication, 'unconfirmed')
    assert.equal(fs.existsSync(join(value.directory, 'claimed.json')), true)
    assert.equal(fs.existsSync(join(value.directory, 'result.json')), false)
    assert.equal(value.publisher.emit('error', { message: 'do not hide terminal failure' }).fatal, result.fatal)
    assert.equal(evidence.resultAttempts, 1)
    assert.equal(evidence.rootAttempts, 0)
  }))
})

test('fatal publication resolves one waiter without throwing from watcher event and closes context', { concurrency: false }, async () => {
  const rootError = fault('event root status failure')
  await fixture(value => filesystemFaults(value, { parentCleanup: true, rootError }, async evidence => {
    const abort = new AbortController()
    let plugin, emitterError, eventReturned = false, closed = 0, attemptedRetry = false
    class Watcher extends EventEmitter {
      on(name, listener) {
        super.on(name, listener)
        if (name === 'event') queueMicrotask(() => {
          try {
            this.emit('event', { code: 'START' })
            plugin.buildStart()
            plugin.closeBundle()
            this.emit('event', { code: 'END' })
            eventReturned = true
          } catch (error) { emitterError = error; abort.abort() }
        })
        return this
      }
    }
    const watcher = new Watcher()
    await assert.rejects(runCompilerWatch({
      project: value.parent, outputRoot: value.output, publisher: value.publisher, signal: abort.signal,
      waitForChange: async () => { attemptedRetry = true; abort.abort() },
      createCompilerContext: async options => {
        plugin = options.inlineConfig.plugins[0]
        return { npmService: { build: async () => {} }, buildService: { build: async () => watcher },
          watcherService: { closeAll: async () => { closed += 1 } } }
      },
    }), error => error === value.publisher.fatalError && error.cause === rootError)
    assert.equal(eventReturned, true)
    assert.equal(emitterError, undefined)
    assert.equal(attemptedRetry, false)
    assert.ok(closed >= 1)
    assert.equal(watcher.listenerCount('event'), 0)
    assert.equal(evidence.resultAttempts, 1)
    assert.deepEqual(evidence.writesAfterTerminal, [])
    const waiter = value.publisher.fatalWait()
    assert.equal(await waiter.promise, value.publisher.fatalError)
  }))
})

test('cleanup failure remains secondary to the original root status failure', { concurrency: false }, async () => {
  const rootError = fault('primary root control failure')
  await fixture(value => filesystemFaults(value, { parentCleanup: true, rootError }, async () => {
    const abort = new AbortController()
    await assert.rejects(runCompilerWatch({
      project: value.parent, outputRoot: value.output, publisher: value.publisher, signal: abort.signal,
      createCompilerContext: async options => {
        const plugin = options.inlineConfig.plugins[0]
        return { npmService: { build: async () => {} },
          buildService: { build: async () => { plugin.buildStart(); plugin.closeBundle(); return new EventEmitter() } },
          watcherService: { closeAll: async () => { throw new Error('context close failed') } } }
      },
    }), error => error === value.publisher.fatalError && error.cause === rootError
      && error.cleanupFailures?.[0] === 'context close failed')
  }))
})

for (const [option, phase] of [
  ['controlCloseError', 'source-control-reader-close'],
  ['enumeratorCloseError', 'source-credit-enumerator-close'],
]) {
  test(`${phase} closes compiler context without throwing from END or retrying`, { concurrency: false }, async () => {
    const closeError = fault(`still-owned ${phase}`)
    await fixture(value => filesystemFaults(value, { [option]: closeError }, async evidence => {
      const abort = new AbortController()
      let plugin, emitterError, eventReturned = false, closed = 0, attemptedRetry = false
      class Watcher extends EventEmitter {
        on(name, listener) {
          super.on(name, listener)
          if (name === 'event') queueMicrotask(() => {
            try {
              this.emit('event', { code: 'START' })
              plugin.buildStart()
              plugin.closeBundle()
              this.emit('event', { code: 'END' })
              eventReturned = true
            } catch (error) { emitterError = error; abort.abort() }
          })
          return this
        }
      }
      const watcher = new Watcher()
      const timeout = setTimeout(() => abort.abort(), 5_000)
      try {
        await assert.rejects(runCompilerWatch({
          project: value.parent, outputRoot: value.output, publisher: value.publisher, signal: abort.signal,
          waitForChange: async () => { attemptedRetry = true; abort.abort() },
          createCompilerContext: async options => {
            plugin = options.inlineConfig.plugins[0]
            return { npmService: { build: async () => {} }, buildService: { build: async () => watcher },
              watcherService: { closeAll: async () => { closed += 1 } } }
          },
        }), error => error === value.publisher.fatalError && error.phase === phase
          && error.cause.cause === closeError)
      } finally { clearTimeout(timeout); abort.abort() }
      assert.equal(eventReturned, true)
      assert.equal(emitterError, undefined)
      assert.equal(attemptedRetry, false)
      assert.ok(closed >= 1)
      assert.equal(watcher.listenerCount('event'), 0)
      assert.equal(evidence.resultAttempts, 0)
      assert.deepEqual(evidence.terminals, [])
      assert.equal(fs.existsSync(join(value.directory, 'grant.json')), true)
      assert.equal(fs.existsSync(join(value.directory, 'claimed.json')), false)
      assert.equal(fs.existsSync(join(value.directory, 'result.json')), false)
      assert.equal(JSON.parse(fs.readFileSync(join(value.root, 'status.json'), 'utf8')).kind, 'building')
      assert.equal(value.publisher.success(value.output).fatal, value.publisher.fatalError)
      if (option === 'controlCloseError') {
        assert.equal(evidence.controlCloseAttempts, 1)
        assert.equal(evidence.retainedControlFds.size, 1)
        for (const fd of evidence.retainedControlFds) assert.doesNotThrow(() => fs.fstatSync(fd))
      } else {
        assert.equal(evidence.enumeratorCloseAttempts, 1)
        assert.equal(evidence.retainedDirectories.length, 1)
        assert.doesNotThrow(() => evidence.retainedDirectories[0].directory.readSync())
      }
    }))
  })
}
