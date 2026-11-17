/** Owned process, HTTP and SSE boundaries shared by simulator smoke tools. */
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const sleep = ms => new Promise(done => setTimeout(done, ms))

/** Validate the active child's explicit ownership record before reading raw bytes. */
export function readDevSessionPaths(staging, ownerPid, project) {
  const publication = realpathSync(staging)
  const runs = resolve(publication, 'runs')
  if (!lstatSync(runs).isDirectory() || lstatSync(runs).isSymbolicLink()) throw new Error('owned run root must be a regular directory')
  const directories = readdirSync(runs, { withFileTypes: true }).filter(entry => entry.isDirectory())
  if (directories.length !== 1) throw new Error('a fresh owned smoke staging directory must have exactly one run')
  const runRoot = resolve(runs, directories[0].name)
  const record = resolve(runRoot, 'dev-session.json')
  const stat = lstatSync(record)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('invalid development session ownership record')
  const paths = JSON.parse(readFileSync(record, 'utf8'))
  if (paths.schemaVersion !== 1 || paths.ownerPid !== ownerPid || !Number.isSafeInteger(ownerPid)
      || ownerPid <= 0 || paths.sessionId !== basename(runRoot) || paths.publicationRoot !== realpathSync(runRoot)) {
    throw new Error('development session does not belong to this child and publication run')
  }
  for (const path of [paths.preparationRoot, paths.compilerOutput]) {
    if (typeof path !== 'string' || !isAbsolute(path) || !lstatSync(path).isDirectory()
        || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error('invalid owned compiler preparation path')
  }
  const preparation = paths.preparationRoot
  const contains = (parent, child) => {
    const path = relative(parent, child)
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }
  if (dirname(preparation) !== realpathSync(tmpdir())
      || !basename(preparation).startsWith(`weapp-simulator-preparation-${ownerPid}-`)
      || contains(realpathSync(project), preparation) || contains(publication, preparation)
      || paths.compilerOutput !== resolve(preparation, '.build-output')) {
    throw new Error('compiler preparation must be owned by this child outside the watched project')
  }
  return { ...paths, runRoot }
}

/** A received HTTP failure is distinct from a request that never completed. */
export class SimulatorHttpError extends Error {
  constructor(path, status, method = 'GET') {
    super(`${path} HTTP ${status}`)
    this.name = 'SimulatorHttpError'
    this.code = 'ERR_SIMULATOR_HTTP'
    this.path = path
    this.status = status
    this.method = method
  }
}

/** Turn terminal signals into cancellation so callers can finish their finally. */
export function installSmokeSignals() {
  const controller = new AbortController()
  const listeners = new Map(['SIGINT', 'SIGTERM'].map(name => [name, () => {
    if (controller.signal.aborted) return
    const error = new Error(`simulator smoke interrupted by ${name}`)
    error.name = 'AbortError'
    error.code = 'ERR_SMOKE_INTERRUPTED'
    error.signal = name
    process.exitCode = name === 'SIGINT' ? 130 : 143
    controller.abort(error)
  }]))
  for (const [name, listener] of listeners) process.on(name, listener)
  let disposed = false
  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return
      disposed = true
      for (const [name, listener] of listeners) process.removeListener(name, listener)
    },
  }
}

function cancellableSleep(ms, signal) {
  signal.throwIfAborted()
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); done() }, ms)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Wait for this child's listener announcement before making any HTTP request.
 * Port zero lets the OS allocate the listener without a probe/rebind race.
 * A caller-specified occupied port fails at startup; it never tests its owner.
 */
export async function startDevSimulator({
  root, project, port = 0, timeoutMs = 120_000, engine = 'quickjs', wvBin, viewport, rendererAssets, renderer, onOutput = () => {},
  launcher = { command: process.env.CARGO || 'cargo', prefixArgs: [] }, stagingRoot,
  signal,
}) {
  signal?.throwIfAborted()
  if (!['quickjs', 'v8'].includes(engine)) throw new Error(`invalid engine: ${engine}`)
  if (renderer !== undefined && !['auto', 'skia', 'webview'].includes(renderer)) throw new Error(`invalid renderer: ${renderer}`)
  const launcherMode = launcher.mode || 'cargo'
  if (!['cargo', 'simulator'].includes(launcherMode)) throw new Error(`invalid launcher mode: ${launcherMode}`)
  const stopped = new AbortController()
  const sessionSignal = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal
  // Keep ordinary smoke publications in an owned temporary namespace. Tests
  // can explicitly choose project-local output to verify that supported path.
  const containerRoot = resolve(stagingRoot ?? resolve(tmpdir(), 'weapp-simulator-smokes'))
  const containerRootExisted = existsSync(containerRoot)
  mkdirSync(containerRoot, { recursive: true })
  const staging = mkdtempSync(resolve(containerRoot, 'simulator-smoke-'))
  const args = [
    ...(launcher.prefixArgs || []),
    ...(launcherMode === 'cargo' ? ['run', '-p', 'container-simulator', '--locked', '--features',
      engine === 'v8' ? 'quickjs-native,v8-native' : 'quickjs-native', '--'] : []),
    'dev', '--project', project, '--surface', 'web', '--engine', engine,
    '--port', String(port), '--node-bin', process.execPath, '--out-dir', staging,
    ...(wvBin ? ['--wv-bin', resolve(wvBin)] : []),
    ...(viewport ? ['--viewport', viewport] : []),
    // Existing smoke tools explicitly exercise CPU RGBA. CanvasKit callers
    // supply pinned assets and must wait for a real browser presentation.
    ...(renderer ? ['--renderer', renderer] : []),
    ...(rendererAssets ? ['--renderer-assets', resolve(rendererAssets)] : renderer === 'webview' ? [] : ['--software']),
  ]
  const child = spawn(launcher.command, args, {
    cwd: root,
    env: { ...process.env, CARGO_TERM_COLOR: 'never' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let stderrLine = ''
  let url = null
  let spawnError = null
  let stopPromise = null
  let exited = false
  child.once('error', error => { spawnError = error; exited = true })
  child.once('exit', () => { exited = true })
  const capture = (chunk, stderr = false) => {
    const text = chunk.toString()
    output = (output + text).slice(-256 * 1024)
    onOutput(text, stderr)
    if (!stderr) return
    stderrLine += text
    let newline
    while ((newline = stderrLine.indexOf('\n')) >= 0) {
      const line = stderrLine.slice(0, newline).replace(/\r$/, '')
      stderrLine = stderrLine.slice(newline + 1)
      const match = line.match(/^weapp-simulator: web surface (http:\/\/127\.0\.0\.1:\d+\/)$/)
      if (match) {
        const announced = new URL(match[1])
        if (port !== 0 && Number(announced.port) !== port) {
          spawnError = new Error(`child announced unexpected port: ${announced.port}`)
        } else url = announced.href
      }
    }
    stderrLine = stderrLine.slice(-8192)
  }
  child.stdout.on('data', chunk => capture(chunk))
  child.stderr.on('data', chunk => capture(chunk, true))

  const assertRunning = () => {
    if (spawnError) throw spawnError
    if (exited || child.exitCode != null || child.signalCode != null) {
      throw new Error(`simulator exited (${child.exitCode ?? child.signalCode})\n${output.slice(-4000)}`)
    }
    sessionSignal.throwIfAborted()
  }
  const json = async (path, options = {}) => {
    assertRunning()
    if (!url) throw new Error('simulator has not announced its listener')
    const { timeout = 5000, signal: requestSignal, ...request } = options
    const timeoutSignal = AbortSignal.timeout(timeout)
    const signals = [sessionSignal, timeoutSignal]
    if (requestSignal) signals.push(requestSignal)
    try {
      const response = await fetch(new URL(path, url), {
        ...request, signal: AbortSignal.any(signals),
      })
      if (!response.ok) {
        // Preserve the observed status even if cancelling an unused body
        // races the remaining request deadline.
        const error = new SimulatorHttpError(path, response.status, request.method)
        try { await response.body?.cancel() } catch (cancelError) { error.bodyCancelError = cancelError }
        throw error
      }
      return await response.json()
    } catch (error) {
      sessionSignal.throwIfAborted()
      requestSignal?.throwIfAborted()
      if (error instanceof SimulatorHttpError) throw error
      if (timeoutSignal.aborted) {
        const timedOut = new Error(`${path} request timed out after ${timeout} ms`, { cause: error })
        timedOut.name = 'TimeoutError'
        timedOut.code = 'ERR_SIMULATOR_REQUEST_TIMEOUT'
        timedOut.path = path
        timedOut.timeoutMs = timeout
        throw timedOut
      }
      throw error
    }
  }
  const waitForState = async (predicate, label, waitMs = timeoutMs) => {
    const deadline = Date.now() + waitMs
    let lastError
    let lastHttpError
    while (Date.now() < deadline) {
      assertRunning()
      try {
        const state = await json('/api/state', { timeout: Math.max(1, Math.min(5000, deadline - Date.now())) })
        // A valid state supersedes failures from older polls even when the
        // caller's readiness predicate is not satisfied yet.
        lastError = undefined
        lastHttpError = undefined
        if (predicate(state)) return state
      } catch (error) {
        sessionSignal.throwIfAborted()
        lastError = error
        if (error instanceof SimulatorHttpError) lastHttpError = error
      }
      await cancellableSleep(Math.min(100, Math.max(0, deadline - Date.now())), sessionSignal)
    }
    const details = []
    if (lastHttpError) details.push(`last HTTP failure: ${lastHttpError.message}`)
    if (lastError && lastError !== lastHttpError) details.push(`last request: ${lastError.message}`)
    const error = new Error(`timed out waiting for ${label}${details.length ? ` (${details.join('; ')})` : ''}`, { cause: lastError })
    error.name = 'SimulatorStateTimeoutError'
    error.code = 'ERR_SIMULATOR_STATE_TIMEOUT'
    error.waitMs = waitMs
    error.lastHttpError = lastHttpError
    error.lastRequestError = lastError
    throw error
  }
  const stop = ({ keep = false } = {}) => {
    if (stopPromise) return stopPromise
    stopped.abort(new Error('simulator stopped'))
    stopPromise = (async () => {
      const cleanupErrors = []
      if (!exited && child.exitCode == null && child.signalCode == null) child.kill('SIGTERM')
      let deadline = Date.now() + 10_000
      while (!exited && Date.now() < deadline) await sleep(25)
      if (!exited) {
        cleanupErrors.push(`simulator PID ${child.pid} ignored cooperative shutdown; SIGKILL required`)
        child.kill('SIGKILL')
        deadline = Date.now() + 2000
        while (!exited && Date.now() < deadline) await sleep(25)
      }
      if (!exited) cleanupErrors.push(`simulator PID ${child.pid} did not exit`)
      child.stdout.destroy()
      child.stderr.destroy()
      // Check the announced listener only; never probe/close a foreign port.
      if (url) {
        try {
          const response = await fetch(new URL('/api/state', url), { signal: AbortSignal.timeout(1000) })
          await response.body?.cancel()
          cleanupErrors.push(`listener remains reachable after simulator shutdown: ${url}`)
        } catch (error) {
          if (error.name === 'TimeoutError') cleanupErrors.push(`listener shutdown could not be verified: ${url}`)
        }
      }
      if (!keep && exited) {
        rmSync(staging, { recursive: true, force: true })
        if (!containerRootExisted) {
          try { rmdirSync(containerRoot) } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) cleanupErrors.push(`staging parent: ${error.message}`)
          }
        }
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors.map(message => new Error(message)), cleanupErrors.join('; '))
      return { processExited: true, listenerClosed: url != null, stagingRemoved: !keep }
    })()
    return stopPromise
  }
  try {
    const deadline = Date.now() + timeoutMs
    while (!url && Date.now() < deadline) {
      assertRunning()
      await cancellableSleep(25, sessionSignal)
    }
    assertRunning()
    if (!url) throw new Error('timed out waiting for owned simulator listener announcement')
    return { url, staging, child, json, waitForState, stop,
      compilerOutput: () => readDevSessionPaths(staging, child.pid, project).compilerOutput,
      outputTail: () => output.slice(-4000) }
  } catch (error) {
    try { await stop() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${error.message}; cleanup: ${cleanupError.message}`)
    }
    throw error
  }
}

/** Bounded SSE reads, including a silent connected server with no event. */
export async function connectDevEvents(url, timeoutMs, { signal } = {}) {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(new Error('timed out waiting for SSE event')), timeoutMs)
  let reader
  try {
    const response = await fetch(new URL('/api/events', url), {
      signal: requestSignal, headers: { accept: 'text/event-stream' },
    })
    if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`)
    reader = response.body.getReader()
  } catch (error) {
    clearTimeout(timer)
    controller.abort()
    throw error
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let closed = false
  return {
    async nextEvent(wantedType, predicate = () => true) {
      while (true) {
        requestSignal.throwIfAborted()
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary).replace(/\r/g, '')
          buffer = buffer.slice(boundary + 2)
          const type = block.match(/^event:\s*(.+)$/m)?.[1]?.trim()
          const data = block.match(/^data:\s*(.+)$/m)?.[1]
          if (type === wantedType && data != null) {
            const payload = JSON.parse(data)
            if (predicate(payload)) return payload
          }
        }
        const { done, value } = await reader.read()
        if (done) throw new Error(`SSE stream closed before ${wantedType}`)
        buffer += decoder.decode(value, { stream: true })
        buffer = buffer.replace(/\r\n/g, '\n')
        if (buffer.length > 2 * 1024 * 1024) throw new Error('SSE event exceeded smoke buffer budget')
      }
    },
    async close() {
      if (closed) return
      closed = true
      clearTimeout(timer)
      const aborted = requestSignal.aborted
      try { await reader.cancel() } catch (error) {
        if (error.name !== 'AbortError' && !aborted) throw error
      } finally { controller.abort() }
    },
  }
}
