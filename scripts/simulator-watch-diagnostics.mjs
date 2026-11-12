/** Optional, non-authoritative observations of the existing compiler context. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, lstat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'

const hash = value => createHash('sha256').update(value).digest('hex')
const within = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}
const fieldsOf = value => {
  try {
    if (!value || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return Object.values(descriptors).every(item => Object.hasOwn(item, 'value')) ? descriptors : null
  } catch { return null }
}
const data = (value, name) => fieldsOf(value)?.[name]?.value
const decimal = value => typeof value === 'bigint' && value >= 0n ? String(value)
  : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value)
    : typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value) ? value : undefined
const safeCode = value => ['EACCES', 'ENOENT', 'ENOSPC', 'EMFILE', 'ENFILE', 'EIO', 'EPERM'].includes(data(value, 'code'))
  ? data(value, 'code') : 'ERR_DIAGNOSTICS_IO'
const extensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.wxml', '.wxss', '.wxs', '.css', '.scss', '.sass', '.less', '.vue', '.html', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff', '.woff2', '.ttf', '.otf', '.map', '.mp4'])
const fileEvents = new Set(['add', 'addDir', 'change', 'unlink', 'unlinkDir', 'create', 'update', 'delete'])
const buildEvents = new Set(['buildStart', 'buildEnd', 'closeBundle', 'resetInitial', 'initialReady', 'watcherEvent', 'publication'])
const hashValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const exactKeys = (value, allowed) => fieldsOf(value) && Object.keys(value).every(key => allowed.includes(key))
const counters = value => exactKeys(value, ['output', 'outside', 'ignored', 'invalid'])
  && Object.keys(value).length === 4 && Object.values(value).every(value => decimal(value) !== undefined)
const watcherOptions = value => exactKeys(value, ['usePolling', 'useFsEvents', 'ignoreInitial', 'persistent', 'followSymlinks', 'atomic', 'disableGlobbing', 'interval', 'binaryInterval', 'depth'])
  && Object.entries(value).every(([key, value]) => ['interval', 'binaryInterval', 'depth'].includes(key)
    ? Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000 : typeof value === 'boolean')
function validFields(kind, value) {
  if (!fieldsOf(value)) return false
  if (kind === 'trace.start') return exactKeys(value, ['authority', 'causalJoin', 'heartbeatMs']) && value.authority === 'diagnostic-only' && value.causalJoin === 'none' && value.heartbeatMs === 1000
  if (['source.all', 'source.watchChange', 'source.hotUpdate.pre', 'source.hotUpdate.post'].includes(kind)) return exactKeys(value, ['event', 'pathSha256', 'extension']) && fileEvents.has(value.event) && hashValue(value.pathSha256) && (extensions.has(value.extension) || ['none', 'other'].includes(value.extension))
  if (kind === 'source.error') return exactKeys(value, ['code']) && value.code === 'ERR_WATCHER_EVENT'
  if (kind === 'watcher.configure') return exactKeys(value, ['resolvedOptions', 'configuredOptions']) && watcherOptions(value.resolvedOptions) && watcherOptions(value.configuredOptions)
  if (kind === 'eventLoop.heartbeat') return exactKeys(value, ['lagNs', 'filtered']) && decimal(value.lagNs) !== undefined && counters(value.filtered)
  if (kind.startsWith('build.') && buildEvents.has(kind.slice(6))) return exactKeys(value, ['activeBuildCount', 'receiptSequence', 'watcherActive', 'failed', 'error', 'code', 'published', 'snapshotIdSha256'])
    && Object.entries(value).every(([key, field]) => ['activeBuildCount', 'receiptSequence'].includes(key) ? decimal(field) !== undefined
      : key === 'code' ? ['START', 'END', 'ERROR', 'OTHER'].includes(field)
        : key === 'snapshotIdSha256' ? hashValue(field) : typeof field === 'boolean')
  return false
}

async function fileSink(directory, name) {
  // Reject existing symlink ancestors before mkdir: a lexical path must not
  // create even one diagnostic entry through an alias into a credit root.
  for (let cursor = resolve(directory); ; cursor = dirname(cursor)) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('ERR_DIAGNOSTICS_SYMLINK') }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
    if (dirname(cursor) === cursor) break
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('ERR_DIAGNOSTICS_DIRECTORY')
  // A fresh exclusive file belongs only to this context. Never append to a
  // pre-existing trace or open a symlink supplied by another producer.
  const handle = await open(resolve(directory, `${name}.jsonl`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  return {
    append: line => handle.writeFile(line),
    close: () => handle.close(),
    status: line => writeFile(resolve(directory, `${name}.status.json`), line, { flag: 'wx', mode: 0o600 }),
  }
}

/** Enqueue is synchronous and bounded; exactly one asynchronous writer drains it. */
export class BoundedDiagnosticWriter {
  constructor({ directory, identity, sinkFactory = fileSink, onFailure = () => {}, maxQueue = 128,
    maxQueueBytes = 256 * 1024, maxBytes = 4 * 1024 * 1024, maxEntries = 20_000,
    maxRecordBytes = 2048, mono = () => process.hrtime.bigint(), wall = () => new Date().toISOString() }) {
    if (![maxQueue, maxQueueBytes, maxBytes, maxEntries, maxRecordBytes].every(Number.isSafeInteger)
      || maxQueue < 1 || maxEntries < 2 || maxRecordBytes < 1024 || maxBytes < maxRecordBytes * 2 || maxQueueBytes < maxRecordBytes) throw new Error('ERR_DIAGNOSTICS_LIMITS')
    this.identity = identity
    if (!exactKeys(identity, ['session', 'compilerSession', 'contextAttempt']) || !hashValue(identity.session)
      || !hashValue(identity.compilerSession) || decimal(identity.contextAttempt) === undefined) throw new Error('ERR_DIAGNOSTICS_IDENTITY')
    this.sinkFactory = () => sinkFactory(directory, `watch-ingress-${randomUUID()}`)
    this.onFailure = onFailure
    Object.assign(this, { maxQueue, maxQueueBytes, maxBytes, maxEntries, maxRecordBytes, mono, wall })
    this.queue = []
    this.queueBytes = 0
    this.bytes = 0
    this.entries = 0
    this.scheduledBytes = 0
    this.scheduledEntries = 0
    this.sequence = 0n
    this.dropped = { queue: 0n, file: 0n, invalid: 0n, io: 0n }
    this.pending = undefined
    this.sink = undefined
    this.failure = undefined
    this.closing = false
    this.closed = false
    this.closePromise = undefined
  }

  state() {
    return Object.freeze({ phase: this.closed ? 'closed' : this.closing ? 'closing' : 'open',
      complete: this.failure === undefined && Object.values(this.dropped).every(value => value === 0n),
      writeFailure: this.failure ?? null, bytes: String(this.bytes), entries: String(this.entries),
      dropped: Object.freeze(Object.fromEntries(Object.entries(this.dropped).map(([key, value]) => [key, String(value)]))) })
  }

  envelope(kind, fields) {
    return { schemaVersion: 1, producerNamespace: 'container.watch-ingress', ...this.identity,
      pid: process.pid, sequence: String(++this.sequence), monotonicNs: String(this.mono()), wallUtc: this.wall(),
      kind, ...fields }
  }

  reject() { if (!this.closed) this.dropped.invalid += 1n; return false }

  enqueue(kind, fields) {
    if (this.closing || this.closed) return false
    try {
      if (typeof kind !== 'string' || !validFields(kind, fields)) return this.reject()
      const line = `${JSON.stringify(this.envelope(kind, fields))}\n`
      const bytes = Buffer.byteLength(line)
      if (bytes > this.maxRecordBytes) return this.reject()
      if (this.failure) { this.dropped.io += 1n; return false }
      if (this.queue.length >= this.maxQueue || this.queueBytes + bytes > this.maxQueueBytes) { this.dropped.queue += 1n; return false }
      // Reserve one bounded terminal entry even when the ordinary trace is full.
      if (this.scheduledEntries >= this.maxEntries - 1 || this.scheduledBytes + bytes > this.maxBytes - this.maxRecordBytes) { this.dropped.file += 1n; return false }
      this.queue.push({ line, bytes })
      this.queueBytes += bytes
      this.scheduledBytes += bytes
      this.scheduledEntries += 1
      this.kick()
      return true
    } catch { return this.reject() }
  }

  fail(error) {
    this.failure ??= safeCode(error)
    this.dropped.io += BigInt(this.queue.length)
    this.queue.length = 0
    this.queueBytes = 0
    try { this.onFailure(this.state()) } catch { /* A diagnostic callback has no authority over the compiler. */ }
  }

  kick() {
    if (this.pending || this.failure) return
    // Creating/opening/writing the file never runs inside a compiler hook.
    this.pending = Promise.resolve().then(async () => {
      this.sink ??= await this.sinkFactory()
      while (this.queue.length && !this.failure) {
        const item = this.queue.shift()
        this.queueBytes -= item.bytes
        try { await this.sink.append(item.line) }
        catch (error) { this.dropped.io += 1n; throw error }
        this.bytes += item.bytes
        this.entries += 1
      }
    }).catch(error => this.fail(error)).finally(() => {
      this.pending = undefined
      if (this.queue.length && !this.failure) this.kick()
    })
  }

  close(extra = {}) {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = (async () => {
      while (this.pending) await this.pending
      try {
        if (!this.failure) {
          this.sink ??= await this.sinkFactory()
          if (!exactKeys(extra, ['filtered', 'listenerRemovalFailures', 'causalJoin'])
            || (extra.filtered !== undefined && !counters(extra.filtered))
            || (extra.listenerRemovalFailures !== undefined && decimal(extra.listenerRemovalFailures) === undefined)
            || (extra.causalJoin !== undefined && extra.causalJoin !== 'none')) { this.reject(); extra = {} }
          const line = `${JSON.stringify(this.envelope('trace.stop', { ...extra, traceState: this.state() }))}\n`
          if (Buffer.byteLength(line) > this.maxRecordBytes) this.reject()
          else {
            await this.sink.append(line)
            this.bytes += Buffer.byteLength(line)
            this.entries += 1
          }
        }
      } catch (error) { this.fail(error) }
      finally {
        try { await this.sink?.close() } catch (error) { this.fail(error) }
        this.closed = true
        // Out-of-band bounded status remains explicit if a partial JSONL write
        // made the stream unusable. Neither record is an authoritative receipt.
        try { await this.sink?.status?.(`${JSON.stringify({ schemaVersion: 1, producerNamespace: 'container.watch-ingress', ...this.identity, state: this.state() })}\n`) }
        catch (error) { this.fail(error) }
      }
      return this.state()
    })()
    return this.closePromise
  }
}

export function createWatchIngressDiagnostics({ directory, project, outputRoot, receiptRoot, sessionId, contextAttempt, signal,
  sinkFactory, onFailure = () => { try { process.stderr.write('[weapp-simulator-watch diagnostics] ERR_DIAGNOSTICS_INCOMPLETE\n') } catch { /* No raw error output. */ } },
  mono = () => process.hrtime.bigint(), wall, setTimer = setInterval, clearTimer = clearInterval, writerLimits = {} }) {
  if (directory === undefined) return undefined
  let writer
  let disposed = false
  let disposePromise
  let timer
  const listeners = []
  const filtered = { output: 0n, outside: 0n, ignored: 0n, invalid: 0n }
  try {
    if (typeof directory !== 'string' || !isAbsolute(directory) || !decimal(contextAttempt)
      || typeof sessionId !== 'string' || sessionId.length > 4096) throw new Error('ERR_DIAGNOSTICS_CONFIG')
    const root = resolve(project), target = resolve(directory)
    const forbidden = [outputRoot, receiptRoot].filter(value => typeof value === 'string').map(value => resolve(value))
    if ([root, ...forbidden].some(value => within(value, target) || within(target, value))) throw new Error('ERR_DIAGNOSTICS_ROOT_OVERLAP')
    const identity = Object.freeze({ session: hash(sessionId), compilerSession: hash(`${sessionId}:${contextAttempt}`), contextAttempt: decimal(contextAttempt) })
    writer = new BoundedDiagnosticWriter({ directory: target, identity, sinkFactory, onFailure, mono, wall, ...writerLimits })
    const snapshotFiltered = () => Object.fromEntries(Object.entries(filtered).map(([key, value]) => [key, String(value)]))
    const emit = (kind, fields = {}) => !disposed && writer.enqueue(kind, fields)
    const source = (kind, file, event) => {
      if (disposed) return false
      if (typeof file !== 'string' || file.length > 4096 || /[\u0000-\u001f\u007f]/.test(file)
        || file.includes('://') || (sep !== '\\' && file.includes('\\')) || !fileEvents.has(event)) { filtered.invalid += 1n; return false }
      const full = resolve(root, file)
      if (!within(root, full) || full === root) { filtered.outside += 1n; return false }
      if (forbidden.some(value => within(value, full)) || within(target, full)) { filtered.output += 1n; return false }
      const path = relative(root, full).split(sep).join('/')
      if (path.split('/').some(part => ['node_modules', '.git', '.weapp-container', '.weapp-vite'].includes(part))
        || /(?:^|\/)(?:\.pending-|\.tmp-|\.#|#)/.test(path) || /(?:\.tmp-|\.pending-|\.tmp$|\.swp$|~$)/.test(path)) { filtered.ignored += 1n; return false }
      const extension = extname(path).toLowerCase()
      return emit(kind, { event, pathSha256: hash(path), extension: extensions.has(extension) ? extension : extension === '' ? 'none' : 'other' })
    }
    const options = value => {
      if (!fieldsOf(value)) return {}
      const out = {}
      for (const key of ['usePolling', 'useFsEvents', 'ignoreInitial', 'persistent', 'followSymlinks', 'atomic', 'disableGlobbing']) {
        if (typeof data(value, key) === 'boolean') out[key] = data(value, key)
      }
      for (const key of ['interval', 'binaryInterval', 'depth']) {
        const field = data(value, key)
        if (Number.isSafeInteger(field) && field >= 0 && field <= 86_400_000) out[key] = field
      }
      return out
    }
    const attach = server => {
      if (disposed) return
      try {
        const watcher = server?.watcher
        if (!watcher || typeof watcher.on !== 'function' || typeof watcher.off !== 'function' || listeners.some(row => row.watcher === watcher)) { writer.reject(); return }
        const all = (event, file) => source('source.all', file, event)
        const error = () => emit('source.error', { code: 'ERR_WATCHER_EVENT' })
        // Keep exact references before attachment, so a partially throwing emitter
        // is still removable by dispose. Never close or add roots to this watcher.
        listeners.push({ watcher, all, error })
        watcher.on('all', all)
        watcher.on('error', error)
        emit('watcher.configure', { resolvedOptions: options(watcher.options), configuredOptions: options(server.config?.server?.watch) })
      } catch { writer.reject() }
    }
    const hot = kind => value => {
      if (!fieldsOf(value)) { writer.reject(); return }
      source(kind, data(value, 'file'), data(value, 'type') ?? 'update')
      // Receipt-only: never call read(), mutate/return modules, or trigger work.
    }
    const pre = { name: 'container-simulator:source-ingress-pre', apply: 'serve', enforce: 'pre',
      configureServer: attach,
      watchChange(file, change) { source('source.watchChange', file, data(change, 'event') ?? 'update') },
      hotUpdate: hot('source.hotUpdate.pre') }
    const post = { name: 'container-simulator:source-ingress-post', apply: 'serve', enforce: 'post', hotUpdate: hot('source.hotUpdate.post') }
    emit('trace.start', { authority: 'diagnostic-only', causalJoin: 'none', heartbeatMs: 1000 })
    let expected = mono() + 1_000_000_000n
    timer = setTimer(() => {
      if (disposed) return
      const now = mono()
      const lag = now > expected ? now - expected : 0n
      emit('eventLoop.heartbeat', { lagNs: String(lag), filtered: snapshotFiltered() })
      expected = now + 1_000_000_000n
    }, 1000)
    timer?.unref?.()
    let abortHandler
    const observer = Object.freeze({ pre, post,
      build(kind, value = {}) {
        if (disposed) return false
        const descriptors = fieldsOf(value)
        const allowed = new Set(['activeBuildCount', 'watcherActive', 'failed', 'error', 'code', 'published', 'receiptSequence', 'snapshot'])
        if (!buildEvents.has(kind) || !descriptors || Object.keys(descriptors).some(key => !allowed.has(key))) return writer.reject()
        const fields = {}
        for (const key of ['watcherActive', 'failed', 'error', 'published']) {
          if (data(value, key) !== undefined && typeof data(value, key) !== 'boolean') return writer.reject()
          if (typeof data(value, key) === 'boolean') fields[key] = data(value, key)
        }
        for (const key of ['activeBuildCount', 'receiptSequence']) {
          const v = decimal(data(value, key))
          if (data(value, key) !== undefined && v === undefined) return writer.reject()
          if (v !== undefined) fields[key] = v
        }
        if (data(value, 'code') !== undefined) {
          if (typeof data(value, 'code') !== 'string' || !/^[A-Z_]{1,32}$/.test(data(value, 'code'))) return writer.reject()
          fields.code = ['START', 'END', 'ERROR'].includes(data(value, 'code')) ? data(value, 'code') : 'OTHER'
        }
        const snapshot = data(value, 'snapshot')
        if (snapshot !== undefined) {
          if (typeof snapshot !== 'string' || snapshot.length > 256 || !/^snapshots\/[0-9a-f-]+$/.test(snapshot)) return writer.reject()
          fields.snapshotIdSha256 = hash(snapshot)
        }
        return emit(`build.${kind}`, fields)
      },
      state: () => writer.state(),
      dispose() {
        if (disposePromise) return disposePromise
        disposed = true
        signal?.removeEventListener('abort', abortHandler)
        clearTimer(timer)
        let removalFailures = 0
        for (const { watcher, all, error } of listeners.splice(0)) {
          for (const [event, fn] of [['all', all], ['error', error]]) {
            try { watcher.off(event, fn) } catch { removalFailures += 1 }
          }
        }
        if (removalFailures) writer.reject()
        disposePromise = writer.close({ filtered: snapshotFiltered(), listenerRemovalFailures: String(removalFailures), causalJoin: 'none' })
        return disposePromise
      },
    })
    abortHandler = () => { void observer.dispose() }
    signal?.addEventListener('abort', abortHandler, { once: true })
    if (signal?.aborted) abortHandler()
    return observer
  } catch {
    try { clearTimer(timer) } catch { /* Nothing outside the diagnostic owner is touched. */ }
    void writer?.close()
    try { onFailure(Object.freeze({ phase: 'disabled', complete: false, writeFailure: 'ERR_DIAGNOSTICS_CONFIG' })) } catch { /* Compiler behavior is independent. */ }
    return undefined
  }
}
