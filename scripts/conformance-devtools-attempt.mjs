import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { acceptsOfficialVersionPolicy, CONFORMANCE_BASELINE as baseline, schemaErrors } from './conformance-evidence.mjs'

const ATTEMPT_SCHEMA = JSON.parse(await readFile(new URL('../schemas/conformance-attempt-v1.schema.json', import.meta.url), 'utf8'))
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const failure = (code, message, stage, details = {}) => Object.assign(new Error(message), { code, stage, details })
const infrastructure = /(?:Failed connecting to ws:\/\/127\.0\.0\.1:|ECONNREFUSED|automator.*(?:connect|connection).*(?:timeout|timed out)|Cannot claim WeChat DevTools host|Runtime busy:)/i
const simulator = /(?:AppService|appservice|simulator|模拟器).*(?:boot|start|启动|crash|崩溃|failed|失败)|WAService.*(?:not defined|初始化失败)/i

/** A selected project libVersion is an input. Both Tool metadata and the wx
 * result are observations, and must agree before any case assertion runs. */
export async function observeOfficialRuntime(miniProgram, context = {}) {
  const tool = await miniProgram.toolInfo()
  const system = await miniProgram.evaluate(() => {
    const value = wx.getSystemInfoSync()
    return { SDKVersion: value.SDKVersion, platform: value.platform }
  })
  const observation = {
    recordedAt: new Date().toISOString(),
    ...(context.projectPath ? { projectPath: context.projectPath } : {}),
    ...(context.installationId ? { installationId: context.installationId } : {}),
    tool: { version: tool?.version ?? null, SDKVersion: tool?.SDKVersion ?? null },
    system: { SDKVersion: system?.SDKVersion ?? null, platform: system?.platform ?? null },
  }
  const checks = [
    ['tool.version', observation.tool.version, baseline.devtoolsVersion],
    ['tool.SDKVersion', observation.tool.SDKVersion, baseline.baseLibraryVersion],
    ['wx.getSystemInfoSync().SDKVersion', observation.system.SDKVersion, baseline.baseLibraryVersion],
  ]
  const mismatches = checks.filter(([, actual, expected]) => actual !== expected)
  if (mismatches.length) throw failure('CONFORMANCE_RUNTIME_BASELINE_MISMATCH',
    `Official runtime baseline differs: ${mismatches.map(([field, actual, expected]) => `${field}=${actual ?? '<missing>'}, expected ${expected}`).join('; ')}`,
    'baseline', { observation })
  return observation
}

export function assertOfficialSelection(selection) {
  const checks = [
    ['selectedVersion', selection?.selectedVersion, baseline.devtoolsVersion],
    ['acceptedVersion', selection?.acceptedVersion, baseline.devtoolsVersion],
    ['packageVersion', selection?.packageVersion, baseline.devtoolsVersion],
    ['baseLibraryVersion', selection?.baseLibraryVersion, baseline.baseLibraryVersion],
    ['compilerCommit', selection?.compilerCommit, baseline.compiler.commit],
  ]
  const mismatches = checks.filter(([, actual, expected]) => actual !== expected)
  if (mismatches.length) throw failure('CONFORMANCE_SELECTION_BASELINE_MISMATCH',
    `Official selection baseline differs: ${mismatches.map(([field, actual, expected]) => `${field}=${actual ?? '<missing>'}, expected ${expected}`).join('; ')}`,
    'selection')
  if (!acceptsOfficialVersionPolicy(selection) || !/^[0-9a-f]{64}$/.test(selection?.installationId ?? '') || !Number.isFinite(Date.parse(selection?.queriedAt))
    || !/^https:\/\/(?:developers\.weixin\.qq\.com|devtools\.wxqcloud\.qq\.com\.cn)\//.test(selection?.source ?? '')) {
    throw failure('CONFORMANCE_SELECTION_PROVENANCE_MISSING', 'Official selection is missing installation identity or query provenance.', 'selection')
  }
  return selection
}

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, file)
}

/** Run persistence inside onSessionMetadata, before bridge connect/warmup can
 * fail. Keeping this hook outside a test's successful return path means a
 * failed launch still has an addressable, owned Automator session to clean. */
export function createOfficialSessionRecorder({ directory, cliPath, installationId, persistOpenedAutomatorSession, timeout = 30_000 }) {
  if (!isAbsolute(directory) || !nonempty(cliPath) || typeof persistOpenedAutomatorSession !== 'function') {
    throw failure('CONFORMANCE_SESSION_RECORDER_INVALID', 'Session recorder requires an absolute evidence directory, explicit CLI and persistence callback.', 'runner')
  }
  let sequence = 0
  let pending = Promise.resolve()
  const enqueue = run => {
    const result = pending.then(run)
    pending = result.catch(() => {})
    return result
  }
  return {
    onSessionMetadata: metadata => enqueue(async () => {
      await mkdir(directory, { recursive: true })
      const id = sequence++
      const file = join(directory, `session-${String(id).padStart(4, '0')}.json`)
      let endpoint
      try { endpoint = new URL(metadata?.wsEndpoint) } catch {}
      if (!isAbsolute(metadata?.projectPath ?? '') || endpoint?.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1'
        || !Number.isSafeInteger(metadata?.port) || metadata.port <= 0 || metadata.port !== Number(endpoint.port)) {
        throw failure('CONFORMANCE_SESSION_METADATA_INVALID', 'Automator metadata must identify an absolute owned project and matching loopback websocket port.', 'session')
      }
      const record = { schemaVersion: 1, kind: 'wechat-devtools-automator-session', sequence: id, recordedAt: new Date().toISOString(),
        installationId, projectPath: metadata.projectPath, wsEndpoint: metadata.wsEndpoint, port: metadata.port,
        ...(metadata.managedProject ? { managedProject: metadata.managedProject } : {}), persisted: false }
      await atomicJson(file, record)
      try {
        await persistOpenedAutomatorSession({ projectPath: metadata.projectPath, wsEndpoint: metadata.wsEndpoint,
          port: metadata.port, cliPath, runtimeProvider: 'devtools', timeout })
        record.persisted = true
        await atomicJson(file, record)
        return record
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error)
        await atomicJson(file, record)
        throw failure('CONFORMANCE_SESSION_PERSIST_FAILED', `Could not persist opened Automator session: ${record.error}`, 'session', { record })
      }
    }),
    observeRuntime: (miniProgram, context) => enqueue(async () => {
      await mkdir(directory, { recursive: true })
      const file = join(directory, `runtime-${String(sequence++).padStart(4, '0')}.json`)
      try {
        const observation = await observeOfficialRuntime(miniProgram, { installationId, ...context })
        await atomicJson(file, { schemaVersion: 1, kind: 'wechat-devtools-runtime-baseline', status: 'passed', ...observation })
        return observation
      } catch (error) {
        await atomicJson(file, { schemaVersion: 1, kind: 'wechat-devtools-runtime-baseline', status: 'blocked',
          ...(error?.details?.observation ?? {}), error: { code: error?.code ?? 'CONFORMANCE_RUNTIME_OBSERVATION_FAILED', message: error?.message ?? String(error) } })
        throw error
      }
    }),
    flush: () => pending,
  }
}

/** Failure domain comes from the execution stage, never a blanket Vitest
 * exit code. An official assertion cannot be attributed to the container. */
export function classifyConformanceFailure(error, { stage = error?.stage ?? 'runner', provider = 'wechat-devtools', comparedToOfficial = false } = {}) {
  const code = error?.code ?? null
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown execution failure')
  if (stage === 'cleanup') return { status: 'blocked', domain: 'runner', code: code ?? 'CONFORMANCE_CLEANUP_FAILED', stage, message }
  if (stage === 'baseline' || stage === 'selection' || stage === 'source') return { status: 'blocked', domain: 'runner', code: code ?? 'CONFORMANCE_PREFLIGHT_FAILED', stage, message }
  if (provider === 'wechat-devtools' && (stage === 'simulator' || error?.name === 'WechatIdeSimulatorBootLogError'
    || /WeChat DevTools simulator boot error detected in IDE log/.test(message))) {
    return { status: 'blocked', domain: 'official-runtime', code: code ?? 'CONFORMANCE_OFFICIAL_SIMULATOR_BLOCKED', stage, message }
  }
  if (['lease', 'session', 'connection', 'runner', 'build'].includes(stage) || infrastructure.test(message)) {
    return { status: 'blocked', domain: 'runner', code: code ?? 'CONFORMANCE_RUNNER_BLOCKED', stage, message }
  }
  if (provider === 'container' && stage === 'comparison' && comparedToOfficial) {
    return { status: 'failed', domain: 'container-runtime', code: code ?? 'CONFORMANCE_DIFFERENTIAL_MISMATCH', stage, message }
  }
  if (provider === 'wechat-devtools' && simulator.test(message)) {
    return { status: 'blocked', domain: 'official-runtime', code: code ?? 'CONFORMANCE_OFFICIAL_SIMULATOR_BLOCKED', stage, message }
  }
  if (provider === 'wechat-devtools' && stage === 'assertion') {
    return { status: 'failed', domain: 'official-runtime', code: code ?? 'CONFORMANCE_OFFICIAL_ASSERTION_FAILED', stage, message }
  }
  return { status: 'blocked', domain: 'runner', code: code ?? 'CONFORMANCE_UNCLASSIFIED_FAILURE', stage, message }
}

/** An attempt is diagnostic, including successful attempts. It is deliberately
 * a different kind from a passed oracle execution receipt and cannot satisfy
 * the differential gate in place of that receipt. */
export function inspectConformanceAttempt(attempt) {
  const errors = schemaErrors(attempt, ATTEMPT_SCHEMA)
  if (!errors.length) {
    if (attempt.baselineId !== baseline.id || attempt.compilerCommit !== baseline.compiler.commit) errors.push('attempt fixed baseline/compiler differs')
    if (Date.parse(attempt.run.endedAt) < Date.parse(attempt.run.startedAt)) errors.push('attempt timestamps are reversed')
    if (attempt.source.before !== attempt.source.sha256 || attempt.source.after !== attempt.source.sha256) errors.push('attempt source differs from pinned input')
    if (attempt.status === 'passed') {
      if (attempt.run.exitCode !== 0 || attempt.failures.length) errors.push('passed attempt has a failed command or failure record')
      if (attempt.run.signal || attempt.run.timedOut || attempt.run.assertionsExecuted === false) errors.push('passed attempt was interrupted or did not execute assertions')
      if (!attempt.runtimeObservations.length || attempt.runtimeObservations.some(value => value.tool.version !== baseline.devtoolsVersion
        || value.tool.SDKVersion !== baseline.baseLibraryVersion || value.system.SDKVersion !== baseline.baseLibraryVersion)) errors.push('passed attempt has no matching actual Tool/wx runtime baseline')
      if (!attempt.resources.machineLeaseAcquired || !attempt.resources.hostLeaseAcquired || !attempt.resources.machineLeaseReleased || !attempt.resources.hostLeaseReleased || !attempt.resources.ownedResourcesReleased
        || !attempt.resources.borrowedResourcesPreserved) errors.push('passed attempt cleanup is incomplete')
    } else if (!attempt.failures.length) errors.push('non-passed attempt has no classified failure')
    if (attempt.failures.some(value => value.domain === 'container-runtime')) errors.push('official attempt cannot attribute a failure to container semantics')
  }
  return { status: errors.length ? 'incomplete' : 'passed', errors, diagnosticOnly: true }
}
