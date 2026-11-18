import { loadIssue1011Inputs } from './issue1011-static.mjs'
import { loadIssue941Inputs } from './issue941-static.mjs'
import { loadIssue1009Inputs } from './issue1009-static.mjs'
import {loadIssue826Inputs} from './issue826-static.mjs'
import { loadIssue1008Inputs } from './issue1008-static.mjs'
import { loadImportMetaInputs } from './import-meta-static.mjs'
import { loadIssue1182Inputs } from './issue1182-static.mjs'
import { loadIssue297302Inputs } from './issue297-302-static.mjs'
import { loadTemplateInputs as loadTemplateSfcInputs } from './template-multi-platform-sfc-static.mjs'
import { loadTemplateInputs } from './template-multi-platform-static.mjs'
/** Reviewed native host/engine driver. The native child owns the real window,
 * renderer and input adapter; case replay consumes actual native observations. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { fileReference, verifyBuild, verifyReference } from './build.mjs'
import { caseDefinition, collectorInputs, replayCase } from './replay.mjs'
import { assertCleanup, assertStartup, buildEnvironmentKey, hostProfile, nativeArguments, profileForRuntime } from './host-profile.mjs'
import { loadWxmlInputs } from './wxml-static.mjs'
import { loadSubpackageInputs } from './subpackage-static.mjs'
import { loadIssue547Inputs } from './issue547-static.mjs'
import { loadIssue289Inputs } from './issue289-static.mjs'
import { loadWebRuntimeInputs } from './web-runtime-static.mjs'
import { loadIssue1013Inputs } from './issue1013-static.mjs'
export { assertCheckpoint } from './replay.mjs'

const require = (condition, message) => { if (!condition) throw new Error(message) }
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const owned = new Map()
class NativeChild {
  constructor(executable, args, { signal }) {
    this.lines = []; this.outbound = []; this.stderr = ''; this.requests = new Map(); this.next = 1; this.closed = false
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    this.child = spawn(executable, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.exit = new Promise(resolve => this.child.once('close', (exitCode, exitSignal) => {
      this.closed = true; this.outcome = { exitCode, signal: exitSignal }; resolve(this.outcome)
      const error = new Error(`Owned native host exited: ${exitSignal ?? exitCode}`)
      this.rejectReady(error)
      for (const request of this.requests.values()) request.reject(error)
      this.requests.clear()
    }))
    this.child.once('error', error => this.rejectReady(error))
    this.child.stdin.on('error', error => {
      for (const request of this.requests.values()) request.reject(error)
      this.requests.clear()
    })
    this.reader = createInterface({ input: this.child.stdout })
    this.reader.on('line', line => {
      try {
        require(Buffer.byteLength(line) <= 32 * 1024 ** 2, 'Native IPC line exceeded 32 MiB')
        const value = JSON.parse(line)
        this.lines.push(value)
        if (value.kind === 'ready') { this.startup = value.startup; this.resolveReady(value.startup) }
        if (value.kind === 'cleanup') this.cleanup = value.cleanup
        if (value.id !== undefined) {
          const request = this.requests.get(value.id)
          require(request, 'Native IPC replied with an unknown or duplicate request id')
          this.requests.delete(value.id)
          value.ok === true ? request.resolve(value.result) : request.reject(new Error(value.error ?? 'Native IPC operation failed'))
        }
      } catch (error) {
        this.protocolError ??= error
        this.rejectReady(error)
        for (const request of this.requests.values()) request.reject(error)
        this.requests.clear()
        this.stop('SIGTERM')
      }
    })
    this.child.stderr.setEncoding('utf8').on('data', data => {
      this.stderr += data
      if (Buffer.byteLength(this.stderr) > 16 * 1024 ** 2) { this.protocolError ??= new Error('Native stderr exceeded 16 MiB'); this.stop('SIGTERM') }
    })
    this.abort = () => this.stop('SIGTERM')
    this.signal = signal
    signal?.addEventListener('abort', this.abort, { once: true })
    if (signal?.aborted) this.abort()
  }
  stop(signal) {
    if (!this.closed && this.child.pid) {
      try { process.kill(-this.child.pid, signal) }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  request(op, payload = {}) {
    if (this.closed || this.protocolError) return Promise.reject(this.protocolError ?? new Error('Native host is closed'))
    const id = this.next++
    this.outbound.push(structuredClone({ id, op, ...payload }))
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject })
      this.child.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n', error => {
        if (error) { this.requests.delete(id); reject(error) }
      })
    })
  }
  async dispose() {
    if (this.disposed) return this.disposed
    this.disposed = (async () => {
      let timer, forced
      try {
        if (!this.closed) {
          // Timers only signal this child's new process group. The OS window
          // owner must still report detach/unload before cleanup is accepted.
          timer = setTimeout(() => this.stop('SIGTERM'), 3000)
          forced = setTimeout(() => this.stop('SIGKILL'), 6000)
          await this.request('close').catch(error => { this.closeError = error.message })
          this.child.stdin.end()
          await this.exit
        }
      } finally {
        clearTimeout(timer); clearTimeout(forced)
        this.reader.close()
        this.signal?.removeEventListener('abort', this.abort)
      }
      return this.cleanup ?? { ownedResourcesReleased: false, borrowedResourcesPreserved: true }
    })()
    return this.disposed
  }
}

async function execute(context, { diagnostic = false, host = 'macos', presenter } = {}) {
  const { root, outputDirectory, job, recipe, signal, admittedOracle } = context
  const definition = caseDefinition(job.caseId), CASE = job.caseId, SOURCE = definition.sourceSha256
  require(job.sourceSha256 === SOURCE && recipe.caseId === CASE && recipe.sourceSha256 === SOURCE,
    'Native replay requires its reviewed pinned case source')
  // The projection loader supplements full admission; it must receive the
  // same exact refs admitted by the common matrix. Direct diagnostic runs
  // keep their existing diagnostic-only identity when no admission is supplied.
  if (admittedOracle !== undefined || !diagnostic) require(admittedOracle
    && admittedOracle.caseId === CASE && admittedOracle.sourceSha256 === SOURCE
    && isDeepStrictEqual(admittedOracle.oracle, recipe.oracle), 'Native replay oracle differs from its admitted source/trace/execution identity')
  const profile = profileForRuntime({ host, presenter })
  require(job.host === profile.host, 'Native driver cannot substitute the requested host')
  require(recipe.collector.sha256 === definition.collectorSha256, 'Native and official passive collectors differ')
  for (const input of collectorInputs()) {
    const file = fileURLToPath(new URL(input.path, import.meta.url))
    require((await fileReference(root, file)).sha256 === input.sha256, 'Native replay collector closure differs from reviewed bytes')
  }
  const collectorPath = fileURLToPath(new URL(definition.collectorPath, import.meta.url))
  require((await fileReference(root, collectorPath)).sha256 === recipe.collector.sha256, 'Snapshotted driver collector bytes differ from recipe')
  await verifyReference(root, recipe.collector)
  const loadObservedInputs = definition.oracleInputs === 'wxml' ? loadWxmlInputs
    : definition.oracleInputs === 'subpackage' ? loadSubpackageInputs : definition.oracleInputs === 'webRuntime' ? loadWebRuntimeInputs : definition.oracleInputs === 'issue547' ? loadIssue547Inputs : definition.oracleInputs === 'issue289' ? loadIssue289Inputs : definition.oracleInputs === 'sourcePlan826' ? loadIssue826Inputs : definition.oracleInputs === 'sourcePlan1182' ? loadIssue1182Inputs : definition.oracleInputs === 'sourcePlan1011' ? loadIssue1011Inputs : definition.oracleInputs === 'sourcePlan941' ? loadIssue941Inputs : definition.oracleInputs === 'sourcePlan1009' ? loadIssue1009Inputs : definition.oracleInputs === 'sourcePlan1008' ? loadIssue1008Inputs : definition.oracleInputs === 'sourcePlanImportMeta' ? loadImportMetaInputs : definition.oracleInputs === 'sourcePlan297302' ? loadIssue297302Inputs : definition.oracleInputs === 'sourcePlan1013' ? loadIssue1013Inputs : definition.oracleInputs === 'template' ? loadTemplateInputs : definition.oracleInputs === 'templateSfc' ? loadTemplateSfcInputs : undefined
  require(!definition.requiresOracleTrace || loadObservedInputs, 'Native replay requires its reviewed actual oracle input profile')
  const oracleInputsKey = definition.oracleInputs + 'OracleInputs'
  const observedInputs = definition.requiresOracleTrace ? await loadObservedInputs({ recipe,
    loadArtifact: async reference => readFile(await verifyReference(root, reference)) }) : undefined
  const buildPath = process.env[buildEnvironmentKey(profile, job.engine)]
  require(buildPath, `Exact ${job.engine} native build receipt environment variable is required`)
  const buildReference = await fileReference(root, resolve(root, buildPath))
  const build = JSON.parse(await readFile(resolve(root, buildReference.path), 'utf8'))
  const originalExecutable = await verifyBuild(root, build, job.engine, { diagnostic, host, presenter, target: profile.target })
  require((definition.requiredNativeFeatures ?? []).every(feature => build.features?.includes(feature)),
    'Native build lacks a required source observation feature')
  const executable = resolve(outputDirectory, 'weapp-conformance-desktop')
  await copyFile(originalExecutable, executable, constants.COPYFILE_EXCL)
  const artifact = await fileReference(root, executable)
  require(artifact.sha256 === build.artifactSha256, 'Native executable changed while freezing job artifact')
  const baselinePath = resolve(root, 'docs/conformance/baseline-v1.json')
  const baselineReference = await fileReference(root, baselinePath)
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
  const fixture = recipe.fixtureValue
  require(fixture?.manifest?.compiler?.commit === baseline.compiler.commit, 'Native pack compiler differs from official baseline')
  const pack = resolve(outputDirectory, 'native-pack')
  await mkdir(pack)
  await mkdir(resolve(pack, 'blobs/sha256'), { recursive: true })
  await json(resolve(pack, 'manifest.json'), fixture.manifest)
  for (const [sha256, reference] of Object.entries(recipe.resources)) {
    require(sha256 === reference.sha256, 'Native pack resource key differs from digest')
    await copyFile(await verifyReference(root, reference), resolve(pack, 'blobs/sha256', sha256), constants.COPYFILE_EXCL)
  }
  const sessionId = `conformance-${job.engine}-${randomUUID()}`
  const startedAt = new Date().toISOString()
  const native = new NativeChild(executable, nativeArguments(profile, { pack, engine: job.engine, sessionId }), { signal })
  owned.set(outputDirectory, native)
  let startup, inspected, cleanup, events, assertions, replayProvenance
  try {
    startup = await native.ready
    assertStartup(profile, startup, { host: job.host, engine: job.engine, sessionId,
      manifestIntegrity: fixture.manifest.integrity.root, pid: native.child.pid })
    const replay = await replayCase({ caseId: CASE, request: (op, payload) => native.request(op, payload), signal,
      oracleTrace: observedInputs?.trace, staticInputs: observedInputs?.staticInputs, startup })
    replayProvenance = replay.completionFacts ? { completionFacts: replay.completionFacts, staticCoverage: replay.staticCoverage,
      ...(replay.planObservations ? { planObservations: replay.planObservations } : {}),
      ...(replay.methodFacts ? { methodFacts: replay.methodFacts } : {}),
      ...(replay.sourcePollJournal ? { sourcePollJournal: replay.sourcePollJournal } : {}),
      ...(replay.tapHelperJournal ? {tapHelperJournal:replay.tapHelperJournal,nodeInputFacts:replay.nodeInputFacts}:{}),
      ...(replay.exceptionFacts ? { exceptionFacts: replay.exceptionFacts } : {}) } : undefined
    events = replay.events
    assertions = replay.assertions
    inspected = await native.request('inspect')
  } finally {
    cleanup = await native.dispose()
    await json(resolve(outputDirectory, 'native-session.json'), { schemaVersion: 1, diagnosticOnly: diagnostic,
      startup, inspected, ipc: native.lines, outboundIpc: native.outbound, replayProvenance, admittedOracle, stderr: native.stderr, cleanup, process: native.outcome, closeError: native.closeError })
  }
  assertCleanup(profile, cleanup, { outcome: native.outcome, protocolError: native.protocolError })
  await verifyBuild(root, build, job.engine, { diagnostic, host, presenter, target: profile.target })
  await verifyReference(root, buildReference)
  await verifyReference(root, baselineReference)
  for (const reference of Object.values(recipe.resources)) await verifyReference(root, reference)
  for (const reference of observedInputs?.references ?? []) await verifyReference(root, reference)
  const nativeReference = await fileReference(root, resolve(outputDirectory, 'native-session.json'))
  const trace = { schemaVersion: 1, caseId: CASE, oracle: 'container', run: {
    status: 'passed', host: job.host, engine: job.engine, protocolVersion: baseline.protocolVersion, manifestVersion: baseline.manifestVersion,
    startedAt, endedAt: new Date().toISOString(), commit: build.sourceCommit,
    environment: { baselineId: baseline.id, compilerCommit: baseline.compiler.commit, caseSourceSha256: SOURCE,
      manifestIntegrity: fixture.manifest.integrity.root, sessionId, artifactSha256: artifact.sha256,
      diagnosticOnly: diagnostic, nativeExecution: nativeReference, nativeBuild: buildReference,
      ...(observedInputs ? { [oracleInputsKey]: observedInputs.references } : {}) },
  }, events, assertions }
  await json(resolve(outputDirectory, 'trace.json'), trace)
  const traceReference = await fileReference(root, resolve(outputDirectory, 'trace.json'))
  return { trace: traceReference, artifact, execution: { ...startup, status: diagnostic ? 'unknown' : startup.status,
    diagnosticOnly: diagnostic, sourceCommit: build.sourceCommit, artifactSha256: artifact.sha256, build, fixtureId: fixture.id,
    conformance: { caseId: CASE, sourceSha256: SOURCE, traceSha256: traceReference.sha256, baselineId: baseline.id },
    provenance: { build: buildReference, nativeExecution: nativeReference, baseline: baselineReference,
      ...(observedInputs ? { [oracleInputsKey]: observedInputs.references } : {}) } } }
}

export function createDriver({ host = 'macos', presenter } = {}) {
  hostProfile({ host, presenter })
  return Object.freeze({
    run: context => execute(context, { host, presenter }),
    runDiagnostic: context => execute(context, { host, presenter, diagnostic: true }),
    dispose,
  })
}
const defaultDriver = createDriver()
export async function run(context) { return defaultDriver.run(context) }
export async function runDiagnostic(context) { return defaultDriver.runDiagnostic(context) }
export async function dispose({ outputDirectory }) {
  const native = owned.get(outputDirectory)
  if (!native) return { ownedResourcesReleased: true, borrowedResourcesPreserved: true }
  return native.dispose()
}
