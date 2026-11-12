/** Scoped source-handle close faults; actual test handles stay fixture-owned. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CreditReceiptPublisher } from './simulator-source-credit.mjs'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const fault = message => Object.assign(new Error(message), { code: 'EIO' })

async function fixture(operation) {
  const parent = fs.mkdtempSync(join(tmpdir(), 'source-credit-close-'))
  const root = join(parent, 'credits'), output = join(parent, 'dist')
  const directory = join(root, 'source-1-1')
  fs.mkdirSync(directory, { recursive: true })
  fs.mkdirSync(output)
  fs.writeFileSync(join(output, 'app.js'), 'App({})\n')
  fs.writeFileSync(join(directory, 'grant.json'), JSON.stringify({
    protocolVersion: '2.0', runId: 'fd-close-regression', creditId: 'source-1-1',
    limits: { bytes: '1048576', files: 16, directories: 4, depth: 4, pathBytes: 256, fileBytes: '1048576' },
  }))
  const value = { parent, root, output, directory,
    publisher: new CreditReceiptPublisher(root, 'fd-close-regression', COMMIT) }
  try { return await operation(value) }
  finally { fs.rmSync(parent, { recursive: true, force: true }) }
}

let hooksActive = false
async function closeFaults(value, faults, operation) {
  assert.equal(hooksActive, false, 'builtin fd fault scope must be serial')
  hooksActive = true
  const original = { openSync: fs.openSync, closeSync: fs.closeSync, writeSync: fs.writeSync }
  const evidence = { attempts: [], actualClosed: new Set(), fds: {},
    writeThroughOwnedWriter(bytes) { return original.writeSync(this.fds.writer, bytes) },
    assertActuallyClosed(role) {
      assert.equal(this.actualClosed.has(role), true)
      assert.throws(() => fs.fstatSync(this.fds[role]), error => error.code === 'EBADF')
    } }
  let observing = true
  const roleOf = fd => Object.entries(evidence.fds).find(([, actual]) => actual === fd)?.[0]
  fs.openSync = (path, flags, ...args) => {
    const fd = original.openSync(path, flags, ...args)
    if (path === join(value.output, 'app.js')) evidence.fds.reader = fd
    if (path === join(value.directory, '.staging', 'app.js') && flags === 'wx') evidence.fds.writer = fd
    return fd
  }
  fs.writeSync = (fd, ...args) => {
    if (fd === evidence.fds.writer && faults.copyError) throw faults.copyError
    return original.writeSync(fd, ...args)
  }
  fs.closeSync = fd => {
    const role = observing ? roleOf(fd) : undefined
    if (!role) return original.closeSync(fd)
    evidence.attempts.push(role)
    // Model an error BEFORE actual writer close, leaving its descriptor open.
    // The test fixture later releases only this known still-owned descriptor.
    if (role === 'writer' && faults.writerError) throw faults.writerError
    if (role === 'reader' && faults.readerBeforeClose) throw faults.readerError
    const result = original.closeSync(fd)
    evidence.actualClosed.add(role)
    if (role === 'reader') observing = false
    // A reader error may be reported even though the OS already closed it.
    // Production must not retry either fd, since its number could be recycled.
    if (role === 'reader' && faults.readerError) throw faults.readerError
    return result
  }
  syncBuiltinESMExports()
  try { return await operation(evidence) }
  finally {
    Object.assign(fs, original)
    syncBuiltinESMExports()
    hooksActive = false
    const cleanupErrors = []
    for (const [role, fd] of Object.entries(evidence.fds)) {
      if (evidence.actualClosed.has(role)) continue
      try { original.closeSync(fd) }
      catch (error) { cleanupErrors.push(error) }
    }
    if (cleanupErrors.length !== 0) throw new AggregateError(cleanupErrors, 'fd test fixture cleanup failed')
  }
}

function rejectedCopy(value) {
  let error
  try { value.publisher.success(value.output) }
  catch (failure) { error = failure }
  assert.ok(error, 'copy must report its failure')
  const ack = JSON.parse(fs.readFileSync(join(value.directory, 'result.json'), 'utf8'))
  assert.equal(ack.kind, 'error')
  assert.equal(ack.writerDone, true)
  assert.equal(value.publisher.fatalError, undefined)
  return { error, ack }
}

function fatalCopy(value, phase = 'snapshot-writer-close') {
  let result, thrown
  try { result = value.publisher.success(value.output) }
  catch (error) { thrown = error }
  assert.equal(fs.existsSync(join(value.directory, 'result.json')), false,
    'an ambiguous writable fd must not publish any writerDone acknowledgement')
  assert.equal(thrown, undefined)
  assert.equal(result.published, false)
  assert.equal(result.fatal, value.publisher.fatalError)
  assert.equal(result.fatal.phase, phase)
  assert.equal(result.fatal.terminal.writerDone, undefined)
  assert.equal(result.fatal.terminal.publication, 'unconfirmed')
  assert.equal(fs.existsSync(join(value.directory, 'claimed.json')), true)
  assert.equal(value.publisher.emit('error', { message: 'must not retry terminal' }).fatal, result.fatal)
  assert.equal(value.publisher.success(value.output).fatal, result.fatal)
  return { error: result.fatal.cause, fatal: result.fatal }
}

test('ambiguous writer close is fatal without ack while reader actually closes', { concurrency: false }, async () => {
  const writerError = fault('writer close failed')
  await fixture(value => closeFaults(value, { writerError }, evidence => {
    const { error, fatal } = fatalCopy(value)
    assert.ok(error instanceof AggregateError)
    assert.equal(error.code, 'ERR_SOURCE_SNAPSHOT_FILE')
    assert.equal(error.cause, writerError)
    assert.deepEqual(error.errors, [writerError])
    assert.deepEqual(error.closeFailures, [{ role: 'writer', error: writerError }])
    assert.deepEqual(evidence.attempts, ['writer', 'reader'])
    evidence.assertActuallyClosed('reader')
    assert.equal(evidence.actualClosed.has('writer'), false)
    assert.match(fatal.message, /writer close: writer close failed/)
  }))
})

test('both close errors survive and writer close remains primary without a copy error', { concurrency: false }, async () => {
  const writerError = fault('first writer fault'), readerError = fault('second reader fault')
  await fixture(value => closeFaults(value, { writerError, readerError }, evidence => {
    const { error, fatal } = fatalCopy(value)
    assert.equal(error.cause, writerError)
    assert.deepEqual(error.errors, [writerError, readerError])
    assert.deepEqual(error.closeFailures, [
      { role: 'writer', error: writerError }, { role: 'reader', error: readerError },
    ])
    assert.deepEqual(evidence.attempts, ['writer', 'reader'])
    evidence.assertActuallyClosed('reader')
    assert.match(fatal.message, /writer close: first writer fault/)
    assert.match(fatal.message, /reader close: second reader fault/)
  }))
})

test('original copy cause remains primary while both close failures remain diagnostic', { concurrency: false }, async () => {
  const copyError = fault('original write fault'), writerError = fault('writer close fault'), readerError = fault('reader close fault')
  await fixture(value => closeFaults(value, { copyError, writerError, readerError }, evidence => {
    const { error, fatal } = fatalCopy(value)
    assert.equal(error.cause, copyError)
    assert.deepEqual(error.errors, [copyError, writerError, readerError])
    assert.deepEqual(error.closeFailures.map(failure => failure.role), ['writer', 'reader'])
    assert.deepEqual(evidence.attempts, ['writer', 'reader'])
    evidence.assertActuallyClosed('reader')
    assert.match(fatal.message, /copy: original write fault/)
    assert.match(fatal.message, /writer close: writer close fault/)
    assert.match(fatal.message, /reader close: reader close fault/)
  }))
})

test('copy failure is rethrown unchanged when both closes succeed', { concurrency: false }, async () => {
  const copyError = fault('copy only')
  await fixture(value => closeFaults(value, { copyError }, evidence => {
    const { error } = rejectedCopy(value)
    assert.equal(error, copyError)
    assert.deepEqual(evidence.attempts, ['writer', 'reader'])
    evidence.assertActuallyClosed('writer')
    evidence.assertActuallyClosed('reader')
  }))
})

test('reader-only close failure has its original cause and writer actually closes', { concurrency: false }, async () => {
  const readerError = fault('reader only')
  await fixture(value => closeFaults(value, { readerError }, evidence => {
    const { error } = fatalCopy(value, 'snapshot-reader-close')
    assert.equal(error.cause, readerError)
    assert.deepEqual(error.errors, [readerError])
    assert.deepEqual(error.closeFailures, [{ role: 'reader', error: readerError }])
    assert.deepEqual(evidence.attempts, ['writer', 'reader'])
    evidence.assertActuallyClosed('writer')
    evidence.assertActuallyClosed('reader')
  }))
})

test('reader close before actual close is fatal and its still-open fd stays owned by fixture', { concurrency: false }, async () => {
  const readerError = fault('reader remains open')
  await fixture(value => closeFaults(value, { readerError, readerBeforeClose: true }, evidence => {
    let returned, thrown
    try { returned = value.publisher.success(value.output) }
    catch (error) { thrown = error }
    const probe = Buffer.alloc(1)
    assert.equal(fs.readSync(evidence.fds.reader, probe, 0, 1, 0), 1)
    assert.equal(probe.toString(), 'A')
    assert.equal(evidence.actualClosed.has('reader'), false)
    evidence.assertActuallyClosed('writer')
    assert.equal(fs.existsSync(join(value.directory, 'result.json')), false,
      'an unconfirmed reader close must stop the long-lived watcher instead of leaking descriptors')
    assert.equal(thrown, undefined)
    assert.equal(returned.fatal.phase, 'snapshot-reader-close')
    assert.equal(returned.fatal.cause.cause, readerError)
    assert.equal(fs.existsSync(join(value.directory, 'claimed.json')), true)
    assert.deepEqual(evidence.attempts, ['writer', 'reader'])
  }))
})

test('bounded fatal diagnostic keeps secondary close messages after a long primary', { concurrency: false }, async () => {
  const copyError = fault('p'.repeat(8192)), writerError = fault('WRITER_SECONDARY'), readerError = fault('READER_SECONDARY')
  await fixture(value => closeFaults(value, { copyError, writerError, readerError }, evidence => {
    const { error, fatal } = fatalCopy(value)
    assert.equal(error.cause, copyError)
    assert.deepEqual(error.errors, [copyError, writerError, readerError])
    assert.ok(Buffer.byteLength(fatal.message, 'utf8') <= 2048)
    assert.match(fatal.message, /writer close: WRITER_SECONDARY/)
    assert.match(fatal.message, /reader close: READER_SECONDARY/)
    assert.deepEqual(evidence.attempts, ['writer', 'reader'])
    evidence.assertActuallyClosed('reader')
  }))
})

test('still-writable fd proves the claim must remain unacknowledged until its real owner stops', { concurrency: false }, async () => {
  await fixture(value => closeFaults(value, { writerError: fault('writer remains open') }, evidence => {
    let returned, thrown
    try { returned = value.publisher.success(value.output) }
    catch (error) { thrown = error }
    const lateBytes = Buffer.from('/* writer authority is still live */')
    assert.equal(evidence.writeThroughOwnedWriter(lateBytes), lateBytes.length)
    assert.match(fs.readFileSync(join(value.directory, '.staging', 'app.js'), 'utf8'), /writer authority is still live/)
    assert.equal(evidence.actualClosed.has('writer'), false)
    assert.equal(fs.existsSync(join(value.directory, 'result.json')), false,
      'parent cannot retire the namespace from a false writerDone acknowledgement')
    assert.equal(thrown, undefined)
    assert.equal(returned.fatal.phase, 'snapshot-writer-close')
    assert.equal(fs.existsSync(join(value.directory, 'claimed.json')), true)
    assert.deepEqual(evidence.attempts, ['writer', 'reader'])
    evidence.assertActuallyClosed('reader')
    // Only this fixture owns/reliably knows the actual still-open descriptor.
    // Its finally closes it before deleting the namespace. This is not a
    // production watcher/process-tree barrier or an authority to retry fds.
  }))
})

test('enumerator close failure after actual close is fatal before grant claim', { concurrency: false }, async () => {
  await fixture(value => {
    assert.equal(hooksActive, false)
    hooksActive = true
    const original = fs.opendirSync
    const closeError = fault('source-root enumerator close failed')
    let closeAttempts = 0
    fs.opendirSync = (path, ...args) => {
      const iterator = original(path, ...args)
      if (path === value.root) {
        const close = iterator.closeSync.bind(iterator)
        iterator.closeSync = () => {
          closeAttempts += 1
          close()
          throw closeError
        }
      }
      return iterator
    }
    syncBuiltinESMExports()
    try {
      const result = value.publisher.success(value.output)
      assert.equal(result.fatal, value.publisher.fatalError)
      assert.equal(result.fatal.phase, 'source-credit-enumerator-close')
      assert.equal(result.fatal.cause.cause, closeError)
      assert.equal(result.fatal.terminal, undefined)
      assert.equal(closeAttempts, 1)
      assert.equal(fs.existsSync(join(value.directory, 'grant.json')), true,
        'an enumeration-close fault must not strand a claimed namespace')
      assert.equal(fs.existsSync(join(value.directory, 'claimed.json')), false)
      assert.equal(fs.existsSync(join(value.directory, '.staging')), false)
      assert.equal(fs.existsSync(join(value.directory, 'result.json')), false)
      assert.equal(value.publisher.success(value.output).fatal, result.fatal)
      assert.equal(closeAttempts, 1, 'an ambiguous directory handle must never be retried')
    } finally {
      fs.opendirSync = original
      syncBuiltinESMExports()
      hooksActive = false
    }
  })
})

// These faults retain actual, known-open test handles before throwing. Only the
// fixture may close them afterward; production cannot infer whether an OS close
// happened from an exception or retry a potentially recycled descriptor.
async function sourceHandleFaults(value, faults, operation) {
  assert.equal(hooksActive, false, 'source-handle fault scope must be serial')
  hooksActive = true
  const original = { openSync: fs.openSync, closeSync: fs.closeSync, opendirSync: fs.opendirSync }
  const handles = [], evidence = {
    handles,
    attempts: [],
    handle(role) { return handles.find(handle => handle.role === role) },
    assertOpen(role) {
      const handle = this.handle(role)
      assert.ok(handle, `${role} must have a real handle`)
      assert.equal(handle.closed, false)
      if (handle.kind === 'file') assert.doesNotThrow(() => fs.fstatSync(handle.fd))
      else assert.doesNotThrow(() => handle.directory.readSync())
    },
  }
  const close = handle => {
    evidence.attempts.push(handle.role)
    handle.attempts += 1
    const fault = faults[handle.role]
    if (fault?.before) throw fault.error
    const result = handle.close()
    handle.closed = true
    if (fault) throw fault.error
    return result
  }
  fs.openSync = (path, flags, ...args) => {
    const fd = original.openSync(path, flags, ...args)
    const role = path === join(value.directory, 'grant.json') ? 'source-control-reader'
      : path === join(value.directory, '.staging', 'app.js') && flags === 'wx' ? 'writer'
        : path === join(value.output, 'app.js') ? 'reader' : undefined
    if (role) handles.push({ kind: 'file', role, fd, closed: false, attempts: 0,
      close: () => original.closeSync(fd) })
    return fd
  }
  fs.closeSync = fd => {
    const handle = handles.find(handle => handle.kind === 'file' && handle.fd === fd && !handle.closed)
    return handle ? close(handle) : original.closeSync(fd)
  }
  fs.opendirSync = (path, ...args) => {
    const directory = original.opendirSync(path, ...args)
    const role = path === value.root ? 'credit-enumerator'
      : path === value.output ? 'snapshot-directory' : undefined
    if (role) {
      const handle = { kind: 'directory', role, directory, closed: false, attempts: 0,
        close: directory.closeSync.bind(directory) }
      handles.push(handle)
      directory.closeSync = () => close(handle)
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
    for (const handle of handles) {
      if (handle.closed) continue
      try { handle.close(); handle.closed = true }
      catch (error) { cleanupErrors.push(error) }
    }
    if (cleanupErrors.length !== 0) throw new AggregateError(cleanupErrors, 'source-handle fixture cleanup failed')
  }
}

function fatalBeforeClaim(value, phase) {
  const result = value.publisher.success(value.output)
  assert.equal(result.published, false)
  assert.equal(result.fatal, value.publisher.fatalError)
  assert.equal(result.fatal.phase, phase)
  assert.equal(result.fatal.terminal, undefined)
  assert.equal(fs.existsSync(join(value.directory, 'grant.json')), true)
  assert.equal(fs.existsSync(join(value.directory, 'claimed.json')), false)
  assert.equal(fs.existsSync(join(value.directory, '.staging')), false)
  assert.equal(fs.existsSync(join(value.directory, 'result.json')), false)
  assert.equal(fs.existsSync(join(value.root, 'status.json')), false)
  assert.equal(value.publisher.success(value.output).fatal, result.fatal)
  assert.equal(value.publisher.emit('error', { message: 'no recovery retry' }).fatal, result.fatal)
  return result.fatal
}

test('grant reader close before actual close is fatal without claim or repeated reads', { concurrency: false }, async () => {
  const closeError = fault('grant reader remains open')
  await fixture(value => sourceHandleFaults(value, {
    'source-control-reader': { error: closeError, before: true },
  }, evidence => {
    const fatal = fatalBeforeClaim(value, 'source-control-reader-close')
    assert.equal(fatal.cause.cause, closeError)
    evidence.assertOpen('source-control-reader')
    const bytes = Buffer.alloc(1)
    assert.equal(fs.readSync(evidence.handle('source-control-reader').fd, bytes, 0, 1, 0), 1)
    assert.equal(bytes.toString(), '{')
    assert.deepEqual(evidence.attempts, ['source-control-reader', 'credit-enumerator'])
  }))
})

test('grant reader close after actual close is fatal without retrying the numeric fd', { concurrency: false }, async () => {
  const closeError = fault('grant close outcome unknown')
  await fixture(value => sourceHandleFaults(value, {
    'source-control-reader': { error: closeError },
  }, evidence => {
    const fatal = fatalBeforeClaim(value, 'source-control-reader-close')
    assert.equal(fatal.cause.cause, closeError)
    const handle = evidence.handle('source-control-reader')
    assert.equal(handle.closed, true)
    assert.equal(handle.attempts, 1)
    assert.throws(() => fs.fstatSync(handle.fd), error => error.code === 'EBADF')
  }))
})

test('credit enumerator close before actual close stops the watcher before claiming a grant', { concurrency: false }, async () => {
  const closeError = fault('credit directory remains open')
  await fixture(value => sourceHandleFaults(value, {
    'credit-enumerator': { error: closeError, before: true },
  }, evidence => {
    const fatal = fatalBeforeClaim(value, 'source-credit-enumerator-close')
    assert.equal(fatal.cause.cause, closeError)
    evidence.assertOpen('credit-enumerator')
    assert.equal(evidence.handle('credit-enumerator').attempts, 1)
  }))
})

test('grant reader and outer enumerator close failures both survive before claim', { concurrency: false }, async () => {
  const readerError = fault('grant reader remains open'), directoryError = fault('credit directory remains open')
  await fixture(value => sourceHandleFaults(value, {
    'source-control-reader': { error: readerError, before: true },
    'credit-enumerator': { error: directoryError, before: true },
  }, evidence => {
    const fatal = fatalBeforeClaim(value, 'source-control-reader-close')
    assert.equal(fatal.cause.cause.cause, readerError)
    assert.deepEqual(fatal.cause.closeFailures, [
      { role: 'source-control-reader', error: readerError },
      { role: 'credit-enumerator', error: directoryError },
    ])
    evidence.assertOpen('source-control-reader')
    evidence.assertOpen('credit-enumerator')
    assert.deepEqual(evidence.attempts, ['source-control-reader', 'credit-enumerator'])
  }))
})

for (const before of [true, false]) {
  test(`snapshot directory close ${before ? 'before' : 'after'} actual close is fatal without writerDone`, { concurrency: false }, async () => {
    const closeError = fault('snapshot directory close failed')
    await fixture(value => sourceHandleFaults(value, {
      'snapshot-directory': { error: closeError, before },
    }, evidence => {
      const { fatal } = fatalCopy(value, 'snapshot-directory-close')
      assert.equal(fatal.cause.cause, closeError)
      assert.equal(evidence.handle('snapshot-directory').attempts, 1)
      if (before) evidence.assertOpen('snapshot-directory')
      else assert.equal(evidence.handle('snapshot-directory').closed, true)
      assert.equal(evidence.handle('writer').closed, true)
      assert.equal(evidence.handle('reader').closed, true)
    }))
  })
}

test('outer directory close cannot hide a still-writable payload close failure', { concurrency: false }, async () => {
  const writerError = fault('payload writer remains open'), directoryError = fault('snapshot directory remains open')
  await fixture(value => sourceHandleFaults(value, {
    writer: { error: writerError, before: true },
    'snapshot-directory': { error: directoryError, before: true },
  }, evidence => {
    const { fatal } = fatalCopy(value)
    assert.equal(fatal.cause.cause.cause, writerError)
    assert.deepEqual(fatal.cause.closeFailures, [
      { role: 'writer', error: writerError },
      { role: 'snapshot-directory', error: directoryError },
    ])
    evidence.assertOpen('writer')
    evidence.assertOpen('snapshot-directory')
    const late = Buffer.from('/* writer remains live */')
    assert.equal(fs.writeSync(evidence.handle('writer').fd, late), late.length)
    assert.match(fs.readFileSync(join(value.directory, '.staging', 'app.js'), 'utf8'), /writer remains live/)
    assert.equal(evidence.handle('reader').closed, true)
    assert.equal(evidence.handle('writer').attempts, 1)
    assert.equal(evidence.handle('snapshot-directory').attempts, 1)
  }))
})

for (const [role, phase] of [
  ['source-control-reader', 'source-control-reader-close'],
  ['credit-enumerator', 'source-credit-enumerator-close'],
]) {
  test(`recovery scan ${role} close failure is fatal and never schedules another scan`, { concurrency: false }, async () => {
    await fixture(async value => {
      const withheld = join(value.parent, 'withheld-grant.json')
      fs.renameSync(join(value.directory, 'grant.json'), withheld)
      assert.deepEqual(value.publisher.success(value.output), { published: false })
      const blocked = fs.readFileSync(join(value.root, 'status.json'), 'utf8')
      fs.renameSync(withheld, join(value.directory, 'grant.json'))
      await sourceHandleFaults(value, { [role]: { error: fault('recovery handle remains open'), before: true } }, async evidence => {
        const abort = new AbortController(), waiter = value.publisher.fatalWait()
        const recovery = value.publisher.recoveryWait(abort.signal)
        try {
          assert.equal(await recovery.promise, false)
          assert.equal((await waiter.promise).phase, phase)
          evidence.assertOpen(role)
          assert.equal(evidence.handle(role).attempts, 1)
          assert.equal(value.publisher.success(value.output).fatal, value.publisher.fatalError)
          assert.equal(evidence.handle(role).attempts, 1)
          assert.equal(fs.readFileSync(join(value.root, 'status.json'), 'utf8'), blocked)
          assert.equal(fs.existsSync(join(value.directory, 'claimed.json')), false)
          assert.equal(fs.existsSync(join(value.directory, 'result.json')), false)
        } finally { abort.abort(); recovery.cancel(); waiter.cancel() }
      })
    })
  })
}
