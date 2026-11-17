/** Owned native simulator CLI commands shared by conformance smokes. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const SESSION = 'simulator-1'
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export function matchedResponse(trace, requestId, op) {
  assert.equal(trace.schemaVersion, 1, 'trace must use schema v1')
  const records = trace.records ?? trace.events
  assert.ok(Array.isArray(records), 'trace must contain records')
  const matching = records.filter(record => record.request?.requestId === requestId)
  assert.equal(matching.length, 1, `exactly one request record for ${requestId}`)
  const record = matching[0]
  assert.equal(record.request.sessionId, SESSION, `${requestId} request session`)
  assert.equal(record.request.op, op, `${requestId} request op`)
  const messages = record.response?.messages?.filter(message => message.kind === 'response'
    && message.requestId === requestId && message.sessionId === SESSION && message.op === op)
  assert.equal(messages?.length, 1, `exactly one correlated runtime response for ${requestId}/${op}`)
  assert.equal(messages[0].payload?.ok, true, `${requestId} runtime must succeed`)
  return messages[0].payload
}

export async function sourceHashes(directory, prefix = '') {
  const result = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`
    if (entry.isDirectory()) Object.assign(result, await sourceHashes(resolve(directory, entry.name), `${name}/`))
    else result[name] = sha256(await readFile(resolve(directory, entry.name)))
  }
  return result
}

export function createOwnedCommandRunner({ cwd, timeoutMs = 120_000 }) {
  let interrupted = null
  let active = null
  let stopActive = () => {}
  const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
    interrupted = signal
    stopActive()
  }]))
  for (const [signal, handler] of signalHandlers) process.on(signal, handler)

  async function command(executable, args, commandTimeoutMs = timeoutMs) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`)
    if (active) throw new Error('owned CLI commands must run sequentially')
    const startedAt = Date.now()
    return await new Promise((resolveCommand, rejectCommand) => {
      const child = spawn(executable, args, { cwd, shell: false, detached: process.platform !== 'win32',
        env: { ...process.env, CARGO_TERM_COLOR: 'never' }, stdio: ['ignore', 'pipe', 'pipe'] })
      active = child
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let spawnError
      let killTimer
      const stop = () => {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
        const kill = signal => {
          try {
            if (process.platform === 'win32') {
              // Target only the child PID and descendants created by this command.
              const cleanup = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false })
              cleanup.on('error', error => { stderr += `\ncleanup: ${error.message}` })
            } else process.kill(-child.pid, signal)
          } catch (error) { if (error.code !== 'ESRCH') stderr += `\ncleanup: ${error.message}` }
        }
        kill('SIGTERM')
        killTimer ??= setTimeout(() => kill('SIGKILL'), 2_000)
      }
      stopActive = stop
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 32 * 1024 * 1024) stop() })
      child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 32 * 1024 * 1024) stop() })
      const timer = setTimeout(() => { timedOut = true; stop() }, commandTimeoutMs)
      // A failed spawn also emits close. Wait for that cleanup boundary before
      // allowing another command to replace this task's active child handle.
      child.on('error', error => { spawnError = error })
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer); clearTimeout(killTimer); active = null; stopActive = () => {}
        const result = { command: [executable, ...args], exitCode, signal, timedOut,
          elapsedMs: Date.now() - startedAt, stdoutTail: stdout.slice(-6_000), stderrTail: stderr.slice(-6_000) }
        if (spawnError || exitCode !== 0 || timedOut || interrupted) rejectCommand(Object.assign(spawnError ?? new Error(`Command failed (${timedOut ? 'timeout' : interrupted ?? signal ?? exitCode}): ${executable}`), { result }))
        else resolveCommand({ ...result, stdout })
      })
    })
  }

  return {
    command,
    get interrupted() { return interrupted },
    get active() { return active },
    stop() { stopActive() },
    dispose() { for (const [signal, handler] of signalHandlers) process.off(signal, handler) },
  }
}
