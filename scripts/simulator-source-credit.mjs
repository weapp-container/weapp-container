/** Credit-backed synchronous source snapshots for the managed compiler watcher. */
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync,
  readSync, renameSync, writeFileSync, writeSync,
} from 'node:fs'
import { Buffer } from 'node:buffer'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const VERSION = '2.0'
const MAX_CONTROL_BYTES = 16 * 1024
const MAX_SCAN_ENTRIES = 10 // Eight source slots plus the fixed status/temp files.
const MAX_U64 = (1n << 64n) - 1n
const utf8 = value => Buffer.byteLength(value, 'utf8')
const regularDirectory = path => {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('credit root is not a regular directory')
}
const decimal = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value)
  && BigInt(value) <= MAX_U64
const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...names].sort().join('\0')
const inside = (parent, child) => {
  const name = relative(parent, child)
  return name === '' || (!isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`))
}
const boundedMessage = error => {
  const message = error instanceof Error ? error.message : String(error)
  return Buffer.from(message).subarray(0, 2048).toString('utf8')
}

// A failed close may still own the actual handle, or may already have released
// it for reuse. Never retry it. Keep close ambiguity distinct from ordinary
// copy/read failures, including when an outer directory close also fails.
class SourceCloseError extends AggregateError {}

function withSourceHandleClose(operation, close, role) {
  let result, operationError, operationFailed = false
  try { result = operation() }
  catch (error) { operationFailed = true; operationError = error }
  try { close() }
  catch (closeError) {
    const errors = operationFailed ? [operationError, closeError] : [closeError]
    const error = new SourceCloseError(errors,
      `${operationFailed ? `${boundedMessage(operationError)}; ` : ''}${role} close: ${boundedMessage(closeError)}`,
      { cause: operationFailed ? operationError : closeError })
    error.code = 'ERR_SOURCE_HANDLE_CLOSE'
    error.closeFailures = Object.freeze([
      ...(operationError instanceof SourceCloseError ? operationError.closeFailures : []),
      Object.freeze({ role, error: closeError }),
    ])
    throw error
  }
  if (operationFailed) throw operationError
  return result
}

function closeFailurePhase(error) {
  // An outer directory close must not hide a still-writable payload handle.
  if (error.closeFailures.some(failure => failure.role === 'writer')) return 'snapshot-writer-close'
  if (error.closeFailures.some(failure => failure.role === 'reader')) return 'snapshot-reader-close'
  return {
    'source-control-reader': 'source-control-reader-close',
    'credit-enumerator': 'source-credit-enumerator-close',
    'snapshot-directory': 'snapshot-directory-close',
  }[error.closeFailures[0].role]
}

function regularBytes(path, maximum) {
  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximum)) {
    throw new Error('credit metadata is not a bounded regular file')
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  return withSourceHandleClose(() => {
    const actual = fstatSync(fd, { bigint: true })
    if (actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size) {
      throw new Error('credit metadata changed while opening')
    }
    const bytes = Buffer.alloc(Number(actual.size)), probe = Buffer.alloc(1)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (count === 0) throw new Error('short credit metadata')
      offset += count
    }
    const after = fstatSync(fd, { bigint: true })
    if (readSync(fd, probe, 0, 1, null) !== 0 || after.size !== actual.size
      || after.mtimeNs !== actual.mtimeNs || after.ctimeNs !== actual.ctimeNs) {
      throw new Error('credit metadata changed while reading')
    }
    return bytes
  }, () => closeSync(fd), 'source-control-reader')
}

function writeAtomic(root, leaf, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  if (bytes.length > MAX_CONTROL_BYTES) throw new Error('credit control message exceeds allowance')
  // One synchronous publisher owns these fixed temp files. A failed write is
  // retained for parent-owned cleanup; this helper does not sweep directories.
  const temporary = join(root, `.${leaf}.next`)
  writeFileSync(temporary, bytes, { flag: 'w' })
  renameSync(temporary, join(root, leaf))
}

function readGrant(root, name, runId) {
  if (!/^source-[0-9]+-[0-9]+$/.test(name)) throw new Error('unexpected source namespace name')
  const directory = join(root, name)
  regularDirectory(directory)
  let bytes
  try { bytes = regularBytes(join(directory, 'grant.json'), MAX_CONTROL_BYTES) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const grant = JSON.parse(bytes.toString('utf8'))
  if (!exactKeys(grant, ['protocolVersion', 'runId', 'creditId', 'limits'])
    || grant.protocolVersion !== VERSION || grant.runId !== runId || grant.creditId !== name
    || !exactKeys(grant.limits, ['bytes', 'files', 'directories', 'depth', 'pathBytes', 'fileBytes'])
    || !decimal(grant.limits.bytes) || !decimal(grant.limits.fileBytes)) {
    throw new Error('invalid parent source credit')
  }
  const limits = grant.limits
  if (BigInt(limits.bytes) === 0n || BigInt(limits.bytes) > 256n * 1024n * 1024n
    || BigInt(limits.fileBytes) === 0n || BigInt(limits.fileBytes) > 64n * 1024n * 1024n
    || !Number.isSafeInteger(limits.files) || limits.files < 1 || limits.files > 8192
    || !Number.isSafeInteger(limits.directories) || limits.directories < 1 || limits.directories > 1024
    || !Number.isSafeInteger(limits.depth) || limits.depth < 1 || limits.depth > 32
    || !Number.isSafeInteger(limits.pathBytes) || limits.pathBytes < 1 || limits.pathBytes > 2048) {
    throw new Error('source credit limits are outside the fixed copy recipe')
  }
  return { directory, grant }
}

function availableCredit(root, runId, claim) {
  const iterator = opendirSync(root)
  const credits = []
  let count = 0
  withSourceHandleClose(() => {
    for (let entry = iterator.readSync(); entry !== null; entry = iterator.readSync()) {
      if (++count > MAX_SCAN_ENTRIES) throw new Error('source namespace scan exceeds reserved slots')
      if (!entry.isDirectory()) {
        if (!['status.json', '.status.json.next'].includes(entry.name)) throw new Error('unexpected source control file')
        continue
      }
      const credit = readGrant(root, entry.name, runId)
      if (!credit) continue
      credits.push(credit)
      if (!claim) break
    }
  }, () => iterator.closeSync(), 'credit-enumerator')
  // Closing the enumerator must complete before any claim mutates a grant.
  // A close failure therefore cannot strand an unacknowledged claim whose
  // identity was hidden by the failed return. The scan is bounded above.
  for (const credit of credits) {
    if (!claim) return credit
    try {
      // Competes atomically with parent revocation; a lost race tries the next
      // already-issued candidate without reopening an enumerator after claim.
      renameSync(join(credit.directory, 'grant.json'), join(credit.directory, 'claimed.json'))
      return credit
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return null
}

function snapshotFileCloseFailure(copyFailed, copyError, writerFailed, writerError, readerFailed, readerError) {
  const failures = [], errors = [], messages = []
  // Construct diagnostics only AFTER both real close attempts. Each detail is
  // bounded separately so a long primary message cannot hide the secondary.
  const detail = error => {
    const bytes = Buffer.from(boundedMessage(error))
    let end = Math.min(bytes.length, 512)
    // Keep the byte bound exact without splitting a UTF-8 scalar.
    while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1
    return bytes.subarray(0, end).toString('utf8')
  }
  if (copyFailed) { errors.push(copyError); messages.push(`copy: ${detail(copyError)}`) }
  if (writerFailed) {
    failures.push(Object.freeze({ role: 'writer', error: writerError }))
    errors.push(writerError)
    messages.push(`writer close: ${detail(writerError)}`)
  }
  if (readerFailed) {
    failures.push(Object.freeze({ role: 'reader', error: readerError }))
    errors.push(readerError)
    messages.push(`reader close: ${detail(readerError)}`)
  }
  const error = new SourceCloseError(errors, `snapshot file failure; ${messages.join('; ')}`, {
    cause: copyFailed ? copyError : errors[0],
  })
  error.code = 'ERR_SOURCE_SNAPSHOT_FILE'
  error.closeFailures = Object.freeze(failures)
  return error
}

/** No cpSync: every write is under a credit, with bounded entries and scratch. */
function copyCreditedSnapshot(outputRoot, credit) {
  const source = resolve(outputRoot), destination = join(credit.directory, '.staging')
  if (inside(source, credit.directory) || inside(credit.directory, source)) {
    throw new Error('compiler output and source credit namespace overlap')
  }
  const limits = credit.grant.limits
  let bytes = 0n, files = 0, directories = 0
  const scratch = Buffer.alloc(64 * 1024), probe = Buffer.alloc(1)
  const visit = (input, output, relative, depth) => {
    if (depth > limits.depth || utf8(relative) > limits.pathBytes) throw new Error('snapshot path/depth limit')
    regularDirectory(input)
    const directoryBefore = lstatSync(input, { bigint: true })
    if (++directories > limits.directories) throw new Error('snapshot directory limit')
    mkdirSync(output) // Exclusive create. Parent retains all partial files.
    const iterator = opendirSync(input)
    withSourceHandleClose(() => {
      for (let entry = iterator.readSync(); entry !== null; entry = iterator.readSync()) {
        const child = relative ? `${relative}/${entry.name}` : entry.name
        if (utf8(child) > limits.pathBytes) throw new Error('snapshot relative path limit')
        const from = join(input, entry.name), to = join(output, entry.name)
        const before = lstatSync(from, { bigint: true })
        if (before.isSymbolicLink()) throw new Error('snapshot source contains a symlink')
        if (before.isDirectory()) { visit(from, to, child, depth + 1); continue }
        if (!before.isFile() || ++files > limits.files || before.size > BigInt(limits.fileBytes)
          || bytes + before.size > BigInt(limits.bytes)) throw new Error('snapshot file/byte limit')
        const reader = openSync(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        let writer, copyError, writerError, readerError
        let copyFailed = false, writerFailed = false, readerFailed = false
        try {
          const actual = fstatSync(reader, { bigint: true })
          if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino
            || actual.size !== before.size) throw new Error('snapshot source changed while opening')
          writer = openSync(to, 'wx')
          let remaining = actual.size
          while (remaining !== 0n) {
            const count = readSync(reader, scratch, 0, Number(remaining < BigInt(scratch.length) ? remaining : BigInt(scratch.length)), null)
            if (count === 0) throw new Error('snapshot source shrank')
            let written = 0
            while (written < count) {
              const size = writeSync(writer, scratch, written, count - written)
              if (size === 0) throw new Error('snapshot destination made no progress')
              written += size
            }
            remaining -= BigInt(count)
          }
          const after = fstatSync(reader, { bigint: true })
          if (readSync(reader, probe, 0, 1, null) !== 0 || after.size !== actual.size
            || after.mtimeNs !== actual.mtimeNs || after.ctimeNs !== actual.ctimeNs) {
            throw new Error('snapshot source changed during copy')
          }
          bytes += actual.size
        } catch (error) {
          copyFailed = true
          copyError = error
        }
        // No close depends on another close succeeding, and neither is retried:
        // an error may have already closed/recycled an fd on some platforms.
        if (writer !== undefined) {
          try { closeSync(writer) }
          catch (error) { writerFailed = true; writerError = error }
        }
        try { closeSync(reader) }
        catch (error) { readerFailed = true; readerError = error }
        if (writerFailed || readerFailed) {
          throw snapshotFileCloseFailure(copyFailed, copyError, writerFailed, writerError, readerFailed, readerError)
        }
        if (copyFailed) throw copyError
      }
    }, () => iterator.closeSync(), 'snapshot-directory')
    const directoryAfter = lstatSync(input, { bigint: true })
    if (directoryAfter.dev !== directoryBefore.dev || directoryAfter.ino !== directoryBefore.ino
      || directoryAfter.mtimeNs !== directoryBefore.mtimeNs || directoryAfter.ctimeNs !== directoryBefore.ctimeNs) {
      throw new Error('snapshot directory membership changed during copy')
    }
  }
  // The controller must invoke this synchronously at END/initialReady. Keeping
  // the function synchronous prevents a later START on the same event loop.
  visit(source, destination, '', 0)
  renameSync(destination, join(credit.directory, 'pack'))
  return { bytes: String(bytes), files, directories }
}

/** One terminal attempt also seals an ambiguous/failed rename. Never retry it. */
class ClaimedCredit {
  #sealed = false
  constructor(credit) { this.credit = credit }
  seal(result) {
    if (this.#sealed) throw new Error('source credit terminal result is already sealed')
    // Seal BEFORE writeAtomic: a failed/ambiguous terminal write does not grant
    // permission to publish another result. Only the actual watcher barrier can
    // release an unacknowledged claim on the parent side.
    this.#sealed = true
    writeAtomic(this.credit.directory, 'result.json', result)
  }
}

export class SourceCreditFatalError extends Error {
  constructor(phase, cause, terminal) {
    super(`source-credit ${phase} failed: ${boundedMessage(cause)}`, { cause })
    this.code = 'ERR_SOURCE_CREDIT_CONTROL'
    this.phase = phase
    if (terminal) this.terminal = Object.freeze({ ...terminal })
  }
}

export class CreditReceiptPublisher {
  #sequence = 0n
  #blocked = false
  #fatalError
  #wakeFatal
  constructor(root, runId, compilerCommit) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('absolute source credit root required')
    this.root = resolve(root)
    this.sessionId = runId
    this.compilerCommit = compilerCommit
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(compilerCommit ?? '')) {
      throw new Error('credit mode needs an exact run and compiler identity')
    }
    regularDirectory(this.root)
  }
  #next() {
    if (this.#sequence === MAX_U64) throw new Error('source receipt sequence exhausted')
    this.#sequence += 1n
    return String(this.#sequence)
  }
  get fatalError() { return this.#fatalError }
  #fatal(phase, cause, terminal) {
    // Preserve the first control failure, including its original cause. Do not
    // try to report it through the status path that has just failed.
    this.#fatalError ??= new SourceCreditFatalError(phase, cause, terminal)
    this.#blocked = true
    this.#wakeFatal?.(this.#fatalError)
    return { published: false, fatal: this.#fatalError }
  }
  #sequenceOrFatal() {
    try { return this.#next() }
    catch (error) { this.#fatal('sequence', error); return undefined }
  }
  #status(sequence, kind, fields = {}) {
    if (this.#fatalError) return { published: false, fatal: this.#fatalError }
    const value = { protocolVersion: VERSION, runId: this.sessionId, sequence, kind, ...fields }
    try { writeAtomic(this.root, 'status.json', value); return value }
    catch (error) {
      const terminal = kind === 'success' ? { creditId: fields.creditId, kind: 'success', writerDone: true } : undefined
      return this.#fatal('root-status', error, terminal)
    }
  }
  emit(kind, fields = {}) {
    if (!['building', 'error'].includes(kind)) throw new Error('only END may issue credited success')
    if (this.#fatalError) return { published: false, fatal: this.#fatalError }
    const sequence = this.#sequenceOrFatal()
    if (sequence === undefined) return { published: false, fatal: this.#fatalError }
    return this.#status(sequence, kind,
      kind === 'error' ? { message: boundedMessage(fields.message ?? 'build failed') } : {})
  }
  success(outputRoot) {
    if (this.#fatalError) return { published: false, fatal: this.#fatalError }
    // Exhaustion must fail before claiming a namespace that needs an ack.
    const sequence = this.#sequenceOrFatal()
    if (sequence === undefined) return { published: false, fatal: this.#fatalError }
    let credit
    try { credit = availableCredit(this.root, this.sessionId, true) }
    catch (error) {
      if (error instanceof SourceCloseError) return this.#fatal(closeFailurePhase(error), error)
      throw error
    }
    if (!credit) {
      this.#blocked = true
      this.#status(sequence, 'blocked', { message: 'source snapshot capacity is occupied' })
      if (this.#fatalError) return { published: false, fatal: this.#fatalError }
      return { published: false }
    }
    const claim = new ClaimedCredit(credit)
    let inventory
    try {
      inventory = copyCreditedSnapshot(outputRoot, credit)
    } catch (error) {
      if (error instanceof SourceCloseError) {
        // A failed close may retain a writable or input descriptor, or may have
        // already closed/recycled it. Never retry its number, certify writerDone
        // or keep a long-lived watcher running while that descriptor may leak.
        // Only the parent's actual watcher/process-tree barrier retires this
        // unacknowledged claim and its still-owned process/file resources.
        return this.#fatal(closeFailurePhase(error), error,
          { creditId: credit.grant.creditId, kind: 'error', publication: 'unconfirmed' })
      }
      // This catch is ONLY for copying, never terminal/status publication.
      // Parent may remove the actual namespace as soon as seal() publishes.
      try {
        claim.seal({ protocolVersion: VERSION, runId: this.sessionId,
          creditId: credit.grant.creditId, sequence, kind: 'error',
          writerDone: true, message: boundedMessage(error) })
      } catch (terminalError) {
        return this.#fatal('credit-result', terminalError,
          { creditId: credit.grant.creditId, kind: 'error', publication: 'unconfirmed' })
      }
      this.#blocked = true
      throw error
    }
    try {
      claim.seal({ protocolVersion: VERSION, runId: this.sessionId,
        creditId: credit.grant.creditId, sequence, kind: 'success', writerDone: true,
        compilerCommit: this.compilerCommit, inventory })
    } catch (error) {
      return this.#fatal('credit-result', error,
        { creditId: credit.grant.creditId, kind: 'success', publication: 'unconfirmed' })
    }
    // There is no credit write (including a fallback error receipt) below this
    // boundary. A global failure does not revoke or replace a terminal ack.
    const status = this.#status(sequence, 'success', {
      creditId: credit.grant.creditId, compilerCommit: this.compilerCommit,
    })
    if (this.#fatalError) return status
    this.#blocked = false
    return { published: true }
  }
  fatalWait() {
    if (this.#wakeFatal) throw new Error('source-credit fatal waiter already active')
    let done = false, finish
    const promise = new Promise(resolveWait => {
      finish = value => {
        if (done) return
        done = true
        this.#wakeFatal = undefined
        resolveWait(value)
      }
      this.#wakeFatal = finish
      if (this.#fatalError) finish(this.#fatalError)
    })
    // Resolution schedules watcher cleanup; it never throws in the emitter's
    // synchronous event callback. Exactly one waiter is owned by each attempt.
    return { promise, cancel: () => finish(undefined) }
  }
  recoveryWait(signal) {
    let timer, done = false, finish
    const promise = new Promise(resolveWait => {
      finish = value => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolveWait(value)
      }
      const onAbort = () => finish(false)
      const check = () => {
        if (signal.aborted || this.#fatalError) { finish(false); return }
        try {
          if (this.#blocked && availableCredit(this.root, this.sessionId, false)) {
            this.#blocked = false
            finish(true) // Retry publication through the SAME controller's END/build guards.
            return
          }
        } catch (error) {
          if (error instanceof SourceCloseError) {
            this.#fatal(closeFailurePhase(error), error)
            finish(false)
            return
          }
          this.emit('error', { message: boundedMessage(error) })
          if (this.#fatalError) { finish(false); return }
        }
        timer = setTimeout(check, 100)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      check()
    })
    return { promise, cancel: () => finish(false) }
  }
}

export const SOURCE_CREDIT_VERSION = VERSION
