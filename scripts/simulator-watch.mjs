#!/usr/bin/env node
/** Frozen, compiler-owned generations for the development simulator. */
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import { CreditReceiptPublisher } from './simulator-source-credit.mjs'
import { createWatchIngressDiagnostics } from './simulator-watch-diagnostics.mjs'

const protocolVersion = '1.0'
const inside = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}
const messageOf = error => error instanceof Error ? error.message : String(error)

/** Select the one compiler context's source ingress, not another rebuild loop. */
export function resolveWatchBackend(backend = 'auto', platform = process.platform) {
  if (!['auto', 'native', 'polling'].includes(backend)) {
    throw new Error('ERR_WATCH_BACKEND: expected auto, native, or polling')
  }
  const selected = backend === 'auto' ? (platform === 'darwin' ? 'polling' : 'native') : backend
  return Object.freeze({
    requested: backend,
    selected,
    options: Object.freeze({ usePolling: selected === 'polling', interval: 150, binaryInterval: 300 }),
  })
}

/**
 * Vite's embedded Chokidar can override inline options from these variables.
 * Normalize only this adapter process, before importing the public compiler;
 * the parent and its other services retain their environment. The pinned
 * classic host server also drops inline watch fields other than ignored, so
 * setting both public options and this owned environment is necessary.
 */
export function installWatchEnvironment(backend, env = process.env) {
  const { options } = resolveWatchBackend(backend)
  const values = {
    CHOKIDAR_USEPOLLING: String(options.usePolling),
    CHOKIDAR_INTERVAL: String(options.interval),
    CHOKIDAR_BINARY_INTERVAL: String(options.binaryInterval),
  }
  const before = Object.fromEntries(Object.keys(values).map(key => [key,
    { present: Object.hasOwn(env, key), value: env[key] }]))
  for (const [key, value] of Object.entries(values)) env[key] = value
  return () => {
    for (const [key, { present, value }] of Object.entries(before)) {
      if (present) env[key] = value
      else delete env[key]
    }
  }
}

function regularTree(directory) {
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`not a regular directory: ${directory}`)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`snapshot cannot contain a symlink: ${path}`)
    if (entry.isDirectory()) regularTree(path)
    else if (!entry.isFile()) throw new Error(`snapshot cannot contain a special file: ${path}`)
  }
}

/** Copy synchronously: a following compiler START cannot interleave on this event loop. */
export function freezeSnapshot(outputRoot, snapshotRoot, name = randomUUID()) {
  const source = resolve(outputRoot)
  const root = resolve(snapshotRoot)
  if (inside(source, root) || inside(root, source)) throw new Error('snapshot and compiler output roots must be separate')
  regularTree(source)
  mkdirSync(root, { recursive: true })
  const temporary = resolve(root, `.pending-${randomUUID()}`)
  const destination = resolve(root, name)
  if (dirname(destination) !== root || existsSync(destination)) throw new Error('snapshot name must be unique and local')
  try {
    cpSync(source, temporary, {
      recursive: true,
      dereference: false,
      filter(path) {
        const stat = lstatSync(path)
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
          throw new Error(`snapshot source is not a regular file or directory: ${path}`)
        }
        return true
      },
    })
    regularTree(temporary)
    renameSync(temporary, destination)
    return destination
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

export class ReceiptPublisher {
  constructor(root, sessionId, compilerCommit) {
    if (typeof root !== 'string' || !isAbsolute(root) || !sessionId) throw new Error('absolute receipt root and session ID are required')
    if (compilerCommit !== undefined && (typeof compilerCommit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(compilerCommit))) {
      throw new Error('compiler commit must be 40 or 64 lowercase hexadecimal characters')
    }
    this.root = resolve(root)
    this.sessionId = sessionId
    this.compilerCommit = compilerCommit
    this.sequence = 0
    this.receipts = resolve(this.root, 'receipts')
    this.snapshots = resolve(this.root, 'snapshots')
    for (const directory of [this.root, this.receipts, this.snapshots]) {
      mkdirSync(directory, { recursive: true })
      const stat = lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`receipt directory must not be a symlink: ${directory}`)
    }
  }

  emit(kind, fields = {}) {
    if (!['building', 'success', 'error'].includes(kind)) throw new Error(`invalid receipt kind: ${kind}`)
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('receipt sequence exhausted')
    const sequence = this.sequence + 1
    const value = { protocolVersion, sessionId: this.sessionId, sequence, kind, ...fields }
    const filename = `${String(sequence).padStart(20, '0')}.json`
    const temporary = resolve(this.receipts, `.${filename}-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' })
      renameSync(temporary, resolve(this.receipts, filename))
      this.sequence = sequence
      return value
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  success(outputRoot) {
    const name = `${String(this.sequence + 1).padStart(20, '0')}-${randomUUID()}`
    const snapshot = freezeSnapshot(outputRoot, this.snapshots, name)
    try {
      return this.emit('success', {
        snapshot: `snapshots/${name}`,
        ...(this.compilerCommit === undefined ? {} : { compilerCommit: this.compilerCommit }),
      })
    } catch (error) {
      rmSync(snapshot, { recursive: true, force: true })
      throw error
    }
  }
}

/** Only END or a gated, already-completed initial build may publish a generation. */
export function createBuildReceiptController(publisher, outputRoot, diagnostics) {
  let dirty = true
  let activeBuildCount = 0
  let pluginComplete = false
  let watcherActive = false
  let failed = false
  let announced = false
  let lastError
  let closed = false
  const observe = (kind, fields = {}) => diagnostics?.build(kind, { activeBuildCount, watcherActive, failed, ...fields })
  const building = () => {
    if (closed) return
    dirty = true
    if (activeBuildCount === 0) {
      failed = false
      lastError = undefined
    }
    if (!announced && !failed) {
      publisher.emit('building')
      announced = true
    }
  }
  const failure = error => {
    if (closed) return
    const message = messageOf(error)
    if (!failed || message !== lastError) publisher.emit('error', { message })
    failed = true
    lastError = message
    announced = false
    pluginComplete = false
  }
  const publish = () => {
    if (closed || !dirty || failed || activeBuildCount !== 0 || watcherActive) return
    try {
      const result = publisher.success(outputRoot)
      observe('publication', { published: result?.published !== false,
        ...(result?.sequence === undefined ? {} : { receiptSequence: result.sequence }),
        ...(result?.snapshot === undefined ? {} : { snapshot: result.snapshot }) })
      if (result?.published === false) {
        dirty = true
        announced = false
        return
      }
      dirty = false
      announced = false
    } catch (error) {
      failure(error)
    }
  }
  return {
    building,
    failure,
    plugin: {
      name: 'weapp-simulator:build-receipts',
      // weapp-vite also forwards user plugins to its long-lived dependency
      // graph dev server. Its serve buildStart has no per-generation close.
      apply: 'build',
      enforce: 'post',
      buildStart() {
        building()
        activeBuildCount += 1
        pluginComplete = false
        observe('buildStart')
      },
      buildEnd(error) {
        observe('buildEnd', { error: Boolean(error) })
        if (error) {
          failure(error)
        }
      },
      closeBundle() {
        activeBuildCount = Math.max(0, activeBuildCount - 1)
        pluginComplete = !failed && activeBuildCount === 0
        observe('closeBundle')
      },
    },
    // npm may also run the inline plugin; it cannot certify the app build.
    resetInitial() {
      dirty = true
      activeBuildCount = 0
      pluginComplete = false
      watcherActive = false
      failed = false
      lastError = undefined
      observe('resetInitial')
    },
    event(event) {
      if (closed) return
      observe('watcherEvent', { code: event.code })
      if (event.code === 'START') {
        building()
        watcherActive = true
      } else if (event.code === 'ERROR') {
        watcherActive = false
        failure(event.error ?? 'weapp-vite build failed')
      } else if (event.code === 'END') {
        watcherActive = false
        publish()
      }
    },
    initialReady() {
      observe('initialReady')
      // The compiler's internal subscriber may have consumed the first END.
      // A new buildStart or buildEnd(error) makes this fallback ineligible.
      if (pluginComplete) publish()
    },
    // A capacity-blocked END remains dirty. Recheck the same controller's
    // build/ERROR guards before copying its output; never restart a compiler
    // context merely because an immutable-snapshot grant became available.
    retryPublish: publish,
    close() { closed = true },
  }
}

function publicEntry(root) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    if (pkg.name !== 'weapp-vite') return null
    const select = value => {
      if (typeof value === 'string') return value
      if (Array.isArray(value)) return value.map(select).find(Boolean)
      if (value && typeof value === 'object') {
        for (const condition of ['import', 'node', 'default']) {
          const selected = select(value[condition])
          if (selected) return selected
        }
      }
      return null
    }
    const exported = pkg.exports === undefined ? (pkg.module ?? pkg.main) : select(pkg.exports['.'] ?? pkg.exports)
    if (typeof exported !== 'string' || !exported.startsWith('./')) return null
    const entry = resolve(root, exported)
    return inside(root, entry) && existsSync(entry) ? { packageRoot: root, entry } : null
  } catch {
    return null
  }
}

export function resolveExecutable(binary, env = process.env) {
  if (isAbsolute(binary) || binary.includes('/') || binary.includes('\\')) return resolve(binary)
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory || '.', binary)
    if (existsSync(candidate)) return candidate
  }
  return resolve(binary)
}

/** Resolve the public package root from a real bin, symlink, or pnpm shim. */
export function discoverWeappVite(binary) {
  const executable = resolveExecutable(binary)
  if (!existsSync(executable)) return null
  const candidates = new Set([executable, realpathSync(executable)])
  const packageRoots = new Set()
  for (const candidate of [...candidates]) {
    if (!lstatSync(candidate).isFile()) continue
    const stat = lstatSync(candidate)
    if (stat.size > 128 * 1024) continue
    const source = readFileSync(candidate, 'utf8')
    // Windows .cmd and package-manager wrappers are often regular files.
    if (source.includes('weapp-vite')) {
      // A package may expose its public compiler entry without exporting
      // package.json. Locate the nearest installation through Node's lookup
      // directories, then let publicEntry validate its name and public export.
      for (const directory of createRequire(pathToFileURL(candidate)).resolve.paths('weapp-vite') ?? []) {
        const root = resolve(directory, 'weapp-vite')
        if (existsSync(root)) {
          packageRoots.add(root)
          break
        }
      }
    }
    const shim = source.match(/^# cmd-shim-target=(.+)$/m)
    if (shim) candidates.add(resolve(dirname(candidate), shim[1].trim()))
    const paths = source.matchAll(/\$(?:\{basedir(?:_abs|_win)?\}|basedir(?:_abs|_win)?)([\/\\][^"'\r\n]*weapp-vite[^"'\r\n]*)/g)
    for (const match of paths) candidates.add(resolve(dirname(candidate), match[1].slice(1).replaceAll('\\', '/')))
    for (const match of source.matchAll(/%~dp0([\s\S]*?weapp-vite[^"'\r\n]*)/g)) {
      candidates.add(resolve(dirname(candidate), match[1].replaceAll('\\', '/')))
    }
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    let directory = dirname(realpathSync(candidate))
    while (true) {
      const found = publicEntry(directory)
      if (found) return { ...found, executable }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  for (const root of packageRoots) {
    const found = publicEntry(realpathSync(root))
    if (found) return { ...found, executable }
  }
  return null
}

/** A tracked package's Git baseline is provenance, not proof of clean source or dist bytes. */
export function resolveCompilerCommit(packageRoot) {
  try {
    const options = {
      cwd: packageRoot, encoding: 'utf8', timeout: 2_000, maxBuffer: 8_192,
      stdio: ['ignore', 'pipe', 'ignore'],
    }
    const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], options).trim()
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return undefined
    // An npm install may live inside an unrelated application's Git checkout.
    // Only a package.json tracked at this baseline identifies this package.
    const tracked = execFileSync('git', ['ls-tree', '--name-only', commit, '--', 'package.json'], options).trim()
    return tracked === 'package.json' ? commit : undefined
  } catch {
    return undefined
  }
}

export function sourceFingerprint(project, ignoredRoots = []) {
  const hash = createHash('sha256')
  const ignoredNames = new Set(['.git', '.weapp-container', '.weapp-vite', 'node_modules'])
  const ignored = ignoredRoots.map(path => resolve(path))
  const visit = directory => {
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name)
      if (ignored.some(root => inside(root, path)) || (entry.isDirectory() && ignoredNames.has(entry.name))) continue
      let stat
      try { stat = lstatSync(path, { bigint: true }) } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      hash.update(`${relative(project, path)}:${stat.mode}:${stat.size}:${stat.mtimeNs}\n`)
      if (entry.isDirectory()) visit(path)
    }
  }
  visit(project)
  return hash.digest('hex')
}

export async function waitForSourceChange(project, ignoredRoots, signal, intervalMs = 300) {
  const before = sourceFingerprint(project, ignoredRoots)
  while (!signal.aborted) {
    await new Promise(resolveWait => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolveWait()
      }
      const timer = setTimeout(finish, intervalMs)
      signal.addEventListener('abort', finish, { once: true })
    })
    if (signal.aborted || sourceFingerprint(project, ignoredRoots) !== before) return
  }
}

/** Public API only; no CompilerSession or source-tree imports. */
export async function runCompilerWatch({ createCompilerContext, project, outputRoot, publisher, signal, waitForChange = waitForSourceChange, diagnosticsRoot, watchBackend = 'auto' }) {
  const watchOptions = resolveWatchBackend(watchBackend).options
  const managedCredit = publisher instanceof CreditReceiptPublisher
  let attempt = 0
  while (!signal.aborted) {
    let ctx
    let watcher
    let recovery
    let closePromise
    let workInFlight = true
    let abortedDuringWork = false
    const closeContext = () => closePromise ??= Promise.resolve().then(() => ctx?.watcherService.closeAll())
    const stopAttempt = () => {
      controller.close()
      void diagnostics?.dispose()
      abortedDuringWork ||= workInFlight
      void closeContext().catch(() => {})
    }
    const onAbort = stopAttempt
    const fatalWaiter = publisher.fatalWait?.()
    const fatalPromise = fatalWaiter?.promise.then(error => {
      if (error) stopAttempt()
      return error
    })
    let removeLifetimeAbort
    const lifetime = new Promise(resolveWait => {
      const finish = () => resolveWait()
      signal.addEventListener('abort', finish, { once: true })
      removeLifetimeAbort = () => signal.removeEventListener('abort', finish)
      if (signal.aborted) finish()
    })
    const ensureRunning = () => {
      if (publisher.fatalError) throw publisher.fatalError
      return !signal.aborted
    }
    const diagnostics = createWatchIngressDiagnostics({ directory: diagnosticsRoot, project, outputRoot,
      receiptRoot: publisher.root, sessionId: publisher.sessionId, contextAttempt: attempt + 1, signal })
    const controller = createBuildReceiptController(publisher, outputRoot, diagnostics)
    const onEvent = event => controller.event(event)
    let retry = false
    try {
      controller.building()
      if (!ensureRunning()) continue
      ctx = await createCompilerContext({
        key: `weapp-simulator:${publisher.sessionId}:${++attempt}`,
        cwd: project,
        isDev: true,
        mode: 'development',
        cliPlatform: 'weapp',
        // This public option also redirects weapp-vite's static/config output
        // owner (mpDistRoot); build.outDir alone only redirects script chunks.
        outputRoot,
        inlineConfig: {
          weapp: { hmr: { runtime: 'classic' } },
          server: { watch: { ...watchOptions } },
          build: { outDir: outputRoot, watch: { chokidar: { ...watchOptions } } },
          plugins: [...(diagnostics ? [diagnostics.pre, diagnostics.post] : []), controller.plugin],
        },
      })
      workInFlight = false
      if (!ensureRunning()) continue
      signal.addEventListener('abort', onAbort, { once: true })
      workInFlight = true
      await ctx.npmService.build()
      workInFlight = false
      if (!ensureRunning()) continue
      controller.resetInitial()
      workInFlight = true
      watcher = await ctx.buildService.build({ skipNpm: true })
      workInFlight = false
      if (!ensureRunning()) continue
      if (!watcher || typeof watcher.on !== 'function') throw new Error('weapp-vite development build did not return a watcher')
      watcher.on('event', onEvent)
      controller.initialReady()
      if (!ensureRunning()) continue
      if (managedCredit) {
        // The pinned public closeAll() can swallow a watcher's close failure.
        // It is best-effort cleanup, never authority to create a second writer
        // for outputRoot. Keep one context through watch ERROR/capacity recovery;
        // the Rust owner's actual process-tree barrier is the final authority.
        while (ensureRunning()) {
          recovery = publisher.recoveryWait(signal)
          await Promise.race([recovery.promise, fatalPromise])
          if (!ensureRunning()) break
          controller.retryPublish()
        }
      } else {
        await Promise.race([lifetime, ...(fatalPromise ? [fatalPromise] : [])])
        ensureRunning()
      }
    } catch (error) {
      if (publisher.fatalError) throw publisher.fatalError
      if (!signal.aborted) {
        controller.failure(error)
        if (publisher.fatalError) throw publisher.fatalError
        // A failed initial context/npm/build await can retain unknown compiler
        // resources. Managed mode ends this attempt/process instead of creating
        // another context after an unprovable closeAll() result.
        if (managedCredit) throw error
        retry = true
      }
    } finally {
      fatalWaiter?.cancel()
      recovery?.cancel()
      removeLifetimeAbort?.()
      controller.close()
      watcher?.off?.('event', onEvent)
      signal.removeEventListener('abort', onAbort)
      await diagnostics?.dispose()
      const cleanupFailures = []
      try { await closeContext() }
      catch (error) { cleanupFailures.push(messageOf(error).slice(0, 2048)) }
      // A build interrupted during an await can register late resources after
      // the first close. Drain those once the in-flight operation has settled.
      if (abortedDuringWork) {
        try { await ctx?.watcherService.closeAll() }
        catch (error) { cleanupFailures.push(messageOf(error).slice(0, 2048)) }
      }
      if (cleanupFailures.length !== 0) {
        if (publisher.fatalError) {
          // Root control failure remains primary; cleanup failures are explicit
          // bounded context, never a new status write or a refund/barrier.
          publisher.fatalError.cleanupFailures = Object.freeze(cleanupFailures)
        } else throw new Error(`compiler context cleanup failed: ${cleanupFailures.join('; ')}`)
      }
    }
    if (retry && !signal.aborted) await waitForChange(project, [outputRoot, publisher.root], signal)
  }
}

/** Custom builders own the receipt protocol and stay in their parent's process group. */
export async function runCustomBuilder({ binary, project, signal, env = process.env, stdio = 'inherit' }) {
  const nodeScript = /\.(?:mjs|cjs|js)$/i.test(binary)
  const child = spawn(nodeScript ? process.execPath : binary, [
    ...(nodeScript ? [binary] : []), project, '--platform', 'weapp',
  ], { cwd: project, env, stdio, detached: false })
  let timer
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    timer ??= setTimeout(() => child.kill('SIGKILL'), 2_000)
    timer.unref()
  }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    return await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', (code, childSignal) => resolveExit({ code, signal: childSignal }))
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}

export function parseOptions(args, env = process.env) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    if (!['--project', '--wv-bin', '--output-root'].includes(key) || !args[index + 1]) throw new Error(`invalid watch adapter argument: ${key}`)
    options[key.slice(2)] = args[index + 1]
  }
  if (!isAbsolute(options.project ?? '') || !isAbsolute(options['output-root'] ?? '')) throw new Error('--project and --output-root must be absolute')
  const watchBackend = env.WEAPP_CONTAINER_SIMULATOR_WATCH_BACKEND ?? 'auto'
  resolveWatchBackend(watchBackend)
  return {
    project: resolve(options.project),
    outputRoot: resolve(options['output-root']),
    binary: resolveExecutable(options['wv-bin'] ?? fileURLToPath(new URL('../vendor/weapp-vite/packages/weapp-vite/bin/weapp-vite.js', import.meta.url)), env),
    receiptRoot: env.WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR,
    sessionId: env.WEAPP_CONTAINER_SIMULATOR_SESSION_ID,
    sourceCreditRoot: env.WEAPP_CONTAINER_SIMULATOR_SOURCE_CREDIT_DIR,
    diagnosticsRoot: env.WEAPP_CONTAINER_SIMULATOR_WATCH_DIAGNOSTICS,
    watchBackend,
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseOptions(args, env)
  const api = discoverWeappVite(options.binary)
  if (options.sourceCreditRoot !== undefined && !api) {
    throw new Error('source-credit mode requires the pinned public weapp-vite compiler API; custom builders are unsupported')
  }
  const compilerCommit = api ? resolveCompilerCommit(api.packageRoot) : undefined
  const publisher = options.sourceCreditRoot === undefined
    ? new ReceiptPublisher(options.receiptRoot, options.sessionId, compilerCommit)
    : new CreditReceiptPublisher(options.sourceCreditRoot, options.sessionId, compilerCommit)
  const abort = new AbortController()
  const stop = () => abort.abort()
  let restoreWatchEnvironment
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    if (!api) {
      const result = await runCustomBuilder({ ...options, signal: abort.signal, env })
      return abort.signal.aborted ? 0 : (result.code ?? 1)
    }
    restoreWatchEnvironment = installWatchEnvironment(options.watchBackend)
    process.env.NODE_ENV = 'development'
    // Emit before import/config/npm awaits so a long first build is observable.
    publisher.emit('building')
    if (publisher.fatalError) throw publisher.fatalError
    const { createCompilerContext } = await import(pathToFileURL(api.entry).href)
    if (typeof createCompilerContext !== 'function') throw new Error(`weapp-vite public root does not export createCompilerContext: ${api.entry}`)
    await runCompilerWatch({ ...options, createCompilerContext, publisher, signal: abort.signal })
    return 0
  } catch (error) {
    if (publisher.fatalError) throw publisher.fatalError
    publisher.emit('error', { message: messageOf(error) })
    if (publisher.fatalError) throw publisher.fatalError
    throw error
  } finally {
    restoreWatchEnvironment?.()
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

function invokedAsMain() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedAsMain()) {
  main().then(code => { process.exitCode = code }).catch(error => {
    const code = error instanceof Error && error.code === 'ERR_SOURCE_CREDIT_CONTROL'
      ? ` ${error.code}` : ''
    const messages = [`[weapp-simulator-watch${code}] ${messageOf(error)}`,
      ...(error?.cleanupFailures ?? []).slice(0, 2).map(message => `[weapp-simulator-watch cleanup] ${message}`)]
    if (process.env.WEAPP_CONTAINER_SIMULATOR_SOURCE_CREDIT_DIR !== undefined) {
      // A failed compiler close may leave active handles. exitCode alone would
      // strand this leader indefinitely. This exits only our managed wrapper;
      // the parent still owns and verifies the actual remaining process tree.
      // Write the bounded terminal diagnostic synchronously before exiting.
      for (const message of messages) {
        try { writeSync(2, `${message}\n`) }
        catch { /* A broken diagnostic pipe cannot retain the failed process. */ }
      }
      process.exit(1)
    }
    for (const message of messages) console.error(message)
    process.exitCode = 1
  })
}
